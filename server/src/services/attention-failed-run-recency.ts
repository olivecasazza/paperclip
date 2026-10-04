import { and, eq, gt, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { heartbeatRuns } from "@paperclipai/db";

/**
 * Row cap on the failed-run recency probe.
 *
 * The feed suppresses a failed run when the same agent has a newer run for the
 * same issue. That is a per-run existence question, so the driving row set is
 * the bounded list of exhausted failed runs this feed build already holds --
 * never the whole `heartbeat_runs` history.
 */
export const ATTENTION_RUN_RECENCY_MAX_PROBES = 500;

/**
 * Chunk size for the probe. Each chunk is one statement with one VALUES list, so
 * the parameter count stays bounded even for a large failed-run list.
 */
const ATTENTION_RUN_RECENCY_PROBE_CHUNK_SIZE = 100;

/**
 * Walk bound for the corrupt-context fallback. Only reached when a failed run
 * has a non-null `issueId` and a *different* non-null `taskId`, so giving up
 * after this many rows keeps the failed run in the feed rather than silently
 * suppressing it.
 */
const ATTENTION_RUN_RECENCY_FALLBACK_SCAN_LIMIT = 200;

/**
 * `context_snapshot ->> 'issueId'` is the leading term of `readRunIssueId` and
 * `->> 'taskId'` is its fallback. Projecting only these two is what lets the
 * probe run off `heartbeat_runs_company_ctx_issue_created_idx` /
 * `..._ctx_task_created_idx` instead of detoasting `context_snapshot` per row.
 */
const runIssueIdColumn = sql<string | null>`${heartbeatRuns.contextSnapshot} ->> 'issueId'`;
const runTaskIdColumn = sql<string | null>`${heartbeatRuns.contextSnapshot} ->> 'taskId'`;
/** SQL equivalent of `readRunIssueId`: `issueId ?? taskId`. */
const runKeyColumn = sql<string | null>`coalesce(${runIssueIdColumn}, ${runTaskIdColumn})`;

type ProbeRow = {
  runId: string;
  agentId: string;
  createdAt: Date;
  /** `readRunIssueId` of the failed run's stored context. */
  issueId: string | null;
};

function chunk<T>(values: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

/**
 * Load the stored key for each failed run so the probe uses the same
 * `readRunIssueId` result the suppression decision keys on. This is a
 * primary-key lookup per run, not a scan.
 */
async function loadProbeRows(
  db: Db,
  companyId: string,
  runIds: readonly string[],
): Promise<ProbeRow[]> {
  if (runIds.length === 0) return [];
  return db
    .select({
      runId: heartbeatRuns.id,
      agentId: heartbeatRuns.agentId,
      createdAt: heartbeatRuns.createdAt,
      runIssueId: runIssueIdColumn,
      runTaskId: runTaskIdColumn,
      issueId: runKeyColumn,
    })
    .from(heartbeatRuns)
    .where(and(
      eq(heartbeatRuns.companyId, companyId),
      inArray(heartbeatRuns.id, [...runIds]),
    ))
    .then((rows) => rows.map((row) => ({
      runId: row.runId,
      agentId: row.agentId,
      createdAt: row.createdAt,
      issueId: row.issueId,
      runIssueId: row.runIssueId,
      runTaskId: row.runTaskId,
    })));
}

/**
 * Exact fallback for a failed run whose stored `issueId` and `taskId` disagree.
 *
 * `readRunIssueId` prefers `issueId`, so such a run keys on `issueId` alone,
 * while the indexed probe matches either column and would over-match `taskId`.
 * Measured over 28k live rows, zero runs set both keys to different values, so
 * correctness must not rest on that: any disagreement is resolved by asking the
 * agent's newest runs directly.
 */
/**
 * Exact fallback for a failed run whose stored `issueId` and `taskId` disagree.
 *
 * `readRunIssueId` prefers `issueId`, so such a run keys on `issueId` alone,
 * while the indexed probe matches either column and would over-match `taskId`.
 * Measured over 28k live rows, zero runs set both keys to different values, so
 * correctness must not rest on that: any disagreement is resolved by walking the
 * agent's newer runs and comparing the same `readRunIssueId` key the caller uses.
 */
async function suppressedByDisagreeingKey(
  db: Db,
  companyId: string,
  row: ProbeRow,
): Promise<boolean> {
  if (!row.issueId) return false;
  const newer = await db
    .select({
      createdAt: heartbeatRuns.createdAt,
      // Same key the suppression decision uses, evaluated in SQL.
      issueId: runKeyColumn,
    })
    .from(heartbeatRuns)
    .where(and(
      eq(heartbeatRuns.companyId, companyId),
      eq(heartbeatRuns.agentId, row.agentId),
      gt(heartbeatRuns.createdAt, row.createdAt),
      eq(runKeyColumn, row.issueId),
    ))
    .orderBy(sql`${heartbeatRuns.createdAt} desc`)
    .limit(1);
  return newer.length > 0;
}

/**
 * Bounded replacement for the attention feed's `newerRuns` lookup.
 *
 * The original query asked for *every* run newer than the oldest failed run for
 * the failed agents, with no row bound. Once a company's `heartbeat_runs`
 * partition reached ~1GB that materialized ~3.3k rows and read ~2k heap blocks
 * per feed build -- 14-24s under concurrent load -- and every authenticated
 * route queues behind it because the feed is rebuilt per request. A bare
 * `.limit()` does not fix it: the scan still walks the same heap blocks.
 *
 * So instead of enumerating candidate newer runs, this asks the question the
 * consumer actually asks -- "does a newer run exist for this (agent, issue)?" --
 * once per already-bounded failed run, as an `EXISTS` the planner answers from
 * the `context_snapshot` expression indexes. The driving row set is the
 * failed-run list the feed already fetched, so the statement is bounded by
 * construction and stays bounded as history grows.
 *
 * Returns the ids of failed runs that are **suppressed** because a newer run for
 * the same `(agent, issue)` exists; callers keep the rest.
 */
export async function listAttentionSuppressedRunIds(
  db: Db,
  companyId: string,
  failedRuns: readonly { id: string }[],
): Promise<Set<string>> {
  const suppressed = new Set<string>();
  const bounded = failedRuns
    .slice(0, ATTENTION_RUN_RECENCY_MAX_PROBES)
    .map((run) => run.id);
  if (bounded.length === 0) return suppressed;

  const probeRows = await loadProbeRows(db, companyId, bounded);
  const disagreeing = probeRows.filter(
    (row) => row.runIssueId !== null && row.runTaskId !== null && row.runIssueId !== row.runTaskId,
  );
  const disagreementIds = new Set(disagreeing.map((row) => row.runId));
  const probeable = probeRows.filter((row) => !disagreementIds.has(row.runId));

  for (const batch of chunk(probeable, ATTENTION_RUN_RECENCY_PROBE_CHUNK_SIZE)) {
    const values = batch.reduce<ReturnType<typeof sql> | null>(
      (accumulated, row, index) => index === 0
        ? sql`(cast(${row.runId} as uuid), cast(${row.agentId} as uuid), ${row.createdAt.toISOString()}::timestamptz, ${row.issueId})`
        : sql`${accumulated}, (cast(${row.runId} as uuid), cast(${row.agentId} as uuid), ${row.createdAt.toISOString()}::timestamptz, ${row.issueId})`,
      null,
    );
    if (!values) continue;

    const result = await db.execute(sql`
      WITH probe(run_id, agent_id, created_at, issue_id) AS (VALUES ${values})
      SELECT probe.run_id AS run_id,
             EXISTS (
               SELECT 1
               FROM heartbeat_runs newer
               WHERE newer.company_id = ${companyId}
                 AND newer.agent_id = probe.agent_id
                 AND newer.created_at > probe.created_at
                 AND (
                   newer.context_snapshot ->> 'issueId' = probe.issue_id
                   OR newer.context_snapshot ->> 'taskId' = probe.issue_id
                 )
             ) AS has_newer
      FROM probe
    `);
    const rows = (Array.isArray(result) ? result : []) as Array<{
      run_id: string;
      has_newer: boolean;
    }>;
    for (const row of rows) {
      if (row.has_newer === true) suppressed.add(row.run_id);
    }
  }

  for (const row of disagreeing) {
    if (await suppressedByDisagreeingKey(db, companyId, row)) suppressed.add(row.runId);
  }

  return suppressed;
}

export const __attentionRunRecencyForTests = {
  ATTENTION_RUN_RECENCY_MAX_PROBES,
  ATTENTION_RUN_RECENCY_PROBE_CHUNK_SIZE,
  ATTENTION_RUN_RECENCY_FALLBACK_SCAN_LIMIT,
  chunk,
};