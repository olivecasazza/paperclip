import { and, asc, eq, inArray, lt, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { heartbeatRuns } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";

/**
 * Default age at which a terminal run's stored payload is trimmed.
 *
 * Deliberately conservative: the rows themselves are never deleted here, only
 * the bulky per-run blobs. A run's identity, status, timings, usage counters
 * and routing keys all survive, so every list/filter/join keeps working and the
 * change is reversible by re-running against a shorter window.
 */
const DEFAULT_RETENTION_DAYS = 30;

/** Maximum rows touched per batch, to keep each statement's footprint bounded. */
export const TRIM_BATCH_SIZE = 500;

/**
 * Maximum batches per sweep so a backlog cannot monopolise the connection.
 *
 * At `TRIM_BATCH_SIZE` this caps a single sweep at 10,000 rows. A larger backlog
 * is not an error: the next sweep continues where this one stopped.
 */
export const MAX_ITERATIONS = 20;

/** How often the sweep runs (default: 6 hours). */
const DEFAULT_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1_000;

/**
 * Escape hatch: `HEARTBEAT_RUN_PAYLOAD_RETENTION=0` disables the sweep entirely.
 *
 * The sweep is opt-out rather than opt-in because the default is the historical
 * behaviour, but it runs an unbounded-write `UPDATE` against `heartbeat_runs` on
 * startup. On a deployment whose pool is already saturated that is the worst
 * possible first query, and until the reclaim semantics are settled (see the
 * docstring on `pruneHeartbeatRunPayloads`) there is a real argument for running
 * it nowhere at all. Operators need a way to say that without a redeploy.
 */
function isRetentionSweepEnabled(): boolean {
  return process.env.HEARTBEAT_RUN_PAYLOAD_RETENTION !== "0";
}

/**
 * Statuses that can never transition again. A run in any of these has settled,
 * so nothing will read its payload back on behalf of a live execution.
 */
export const TERMINAL_RUN_STATUSES = [
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
  "interrupted",
] as const;

/**
 * `context_snapshot` keys that every read path depends on.
 *
 * `heartbeat_runs` rows are joined and filtered on these scalars: the issue
 * attention feed, routine digests, Slack conversation state and chat-channel
 * lookups all extract `issueId`/`taskId`/`wakeCommentId` in SQL. They are cheap
 * (tens of bytes) and are therefore preserved verbatim.
 */
const PRESERVED_CONTEXT_KEYS = [
  "issueId",
  "taskId",
  "taskKey",
  "commentId",
  "wakeCommentId",
  "wakeCommentIds",
  "wakeReason",
  "wakeSource",
  "wakeTriggerDetail",
  "source",
  "projectId",
  "conversationMode",
  "resumeIntent",
  "executionIdentityRunId",
  "executionIdentityCause",
  "executionContinuation",
  "continuationSummary",
  "paperclipContinuationSummary",
  "retryOfRunId",
  "retryReason",
  "strandedRunId",
  "sourceRunId",
  "sourceIssueId",
  "modelProfile",
  "githubAuthenticationMode",
  "timerClaimWasFirstHeartbeat",
  "externalChatQuestionResponse",
  "paperclipExternalChatQuestionResponse",
  "executionPolicy",
  "chatFailedRunRetry",
] as const;

/**
 * The scalar keys are re-attached from the row's own typed columns and the
 * preserved set; everything else in `context_snapshot` is a denormalised copy
 * of data that already lives in its own table (issue body, task markdown,
 * workspace/environment description, wake payload) and is read nowhere after
 * the run settles.
 */
function buildTrimmedContextSql() {
  // The key list is a compile-time constant, so emitting it literally keeps the
  // statement readable; no caller-supplied value reaches this string.
  const pairs = PRESERVED_CONTEXT_KEYS
    .map((key) => `'${key}', "heartbeat_runs"."context_snapshot" -> '${key}'`)
    .join(", ");

  // `jsonb_strip_nulls` drops the preserved keys that were absent to begin with,
  // so a row that never carried them is not padded with nulls.
  return sql`jsonb_strip_nulls(jsonb_build_object(${sql.raw(pairs)}))`;
}

/**
 * Rows that are still worth trimming: terminal, past the window, and not
 * already trimmed.
 *
 * Kept as a shared predicate so the id-select and the id-scoped update can
 * never drift apart — if they did, the update could touch rows the select did
 * not admit, which is exactly the unbounded statement this batching exists to
 * prevent.
 */
function trimCandidates(cutoff: Date) {
  return and(
    inArray(heartbeatRuns.status, [...TERMINAL_RUN_STATUSES]),
    lt(heartbeatRuns.createdAt, cutoff),
    // Skip rows already trimmed so repeat sweeps are a cheap no-op
    // rather than rewriting every aged row on every tick.
    or(
      sql`${heartbeatRuns.resultJson} is not null`,
      sql`${heartbeatRuns.usageJson} is not null`,
      sql`${heartbeatRuns.stdoutExcerpt} is not null`,
      sql`${heartbeatRuns.stderrExcerpt} is not null`,
      sql`coalesce(pg_column_size(${heartbeatRuns.contextSnapshot}), 0) > 512`,
    ),
  );
}

/**
 * Trim the stored payload on terminal runs older than the retention window.
 *
 * Unlike a delete, this keeps the row: id, status, timings, exit metadata and
 * every `context_snapshot` routing key survive, so history, filters and joins
 * are unaffected. What goes away is `result_json`, `usage_json`, the stdout and
 * stderr excerpts, and the non-routing half of `context_snapshot` — together
 * roughly 90% of the bytes on an aged run.
 *
 * Row removal itself is deliberately out of scope: see CON-436 item 1. This
 * clears the heavy values without foreclosing that decision, and because the
 * heavy columns live in TOAST, nulling them keeps future inserts and index
 * scans from carrying those chunks.
 *
 * **This does not return the space to the OS.** An earlier version of this
 * comment claimed it did; that was wrong, and measured on the production
 * relation it is wrong by a wide margin. `UPDATE` writes new tuple versions, so
 * the superseded TOAST chunks stay on disk as dead space. `VACUUM` records them
 * as reusable but does not release them; releasing them needs `VACUUM FULL`
 * (an `ACCESS EXCLUSIVE` rewrite, not viable on a live pool) or `pg_repack`.
 *
 * Measured on production before and after sweeping the whole candidate set:
 * the relation stayed at 1041 MB total / 930 MB TOAST, unchanged, including
 * across a real `VACUUM`. What this sweep genuinely buys is smaller rows for
 * every future read of them — not reclaimed disk. Treat it as write-amplification
 * for a modest read win, and weigh that against the sweep's own I/O before
 * enabling it on a saturated pool.
 *
 * It also does not address pool starvation directly. The list query that
 * saturates the pool is `created_at DESC` — newest first — so it reads the
 * cohort *inside* the window. On production the two cohorts are roughly
 * inverted with respect to this sweep's target: ~369 MB of `result_json` sits
 * inside the 30-day window that the hot query reads on every call, while the
 * ~191 MB beyond it is what this predicate would rewrite. The starvation fix
 * belongs in the list query and the pool sizing, not here.
 *
 * Batching matters here and is not an optimisation. These columns live in
 * TOAST, so one statement over an unbounded candidate set rewrites hundreds of
 * megabytes while holding a row lock per touched row for its whole duration —
 * long enough to collide with a concurrent run write on the same table. Each
 * batch therefore claims at most `TRIM_BATCH_SIZE` ids, updates only those, and
 * yields between batches, so the sweep cannot monopolise the connection.
 *
 * @returns The number of rows trimmed.
 */
export async function pruneHeartbeatRunPayloads(
  db: Db,
  retentionDays: number = DEFAULT_RETENTION_DAYS,
): Promise<number> {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - retentionDays);

  let totalTrimmed = 0;
  let iterations = 0;

  while (iterations < MAX_ITERATIONS) {
    // Oldest first, so a backlog drains in age order rather than in whatever
    // order the heap happens to return.
    const batchIds = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(trimCandidates(cutoff))
      .orderBy(asc(heartbeatRuns.createdAt), asc(heartbeatRuns.id))
      .limit(TRIM_BATCH_SIZE)
      .then((rows) => rows.map((row) => row.id));

    if (batchIds.length === 0) break;

    const trimmed = await db
      .update(heartbeatRuns)
      .set({
        resultJson: null,
        usageJson: null,
        stdoutExcerpt: null,
        stderrExcerpt: null,
        contextSnapshot: buildTrimmedContextSql(),
      })
      .where(and(trimCandidates(cutoff), inArray(heartbeatRuns.id, batchIds)))
      .returning({ id: heartbeatRuns.id })
      .then((rows) => rows.length);

    totalTrimmed += trimmed;
    iterations++;

    // The batch was fully claimed, so a full batch means there is more to do.
    if (batchIds.length < TRIM_BATCH_SIZE) break;
  }

  if (iterations >= MAX_ITERATIONS) {
    logger.warn(
      { totalTrimmed, iterations, cutoffDate: cutoff },
      "Heartbeat run payload retention hit iteration limit; some runs may remain untrimmed",
    );
  }

  if (totalTrimmed > 0) {
    logger.info({ totalTrimmed, retentionDays }, "Trimmed payload on aged terminal heartbeat runs");
  }

  return totalTrimmed;
}

/**
 * Start the periodic payload-trimming sweep.
 *
 * @returns A cleanup function that stops the interval.
 */
export function startHeartbeatRunPayloadRetention(
  db: Db,
  intervalMs: number = DEFAULT_SWEEP_INTERVAL_MS,
  retentionDays: number = DEFAULT_RETENTION_DAYS,
): () => void {
  if (!isRetentionSweepEnabled()) {
    logger.warn(
      { retentionDays },
      "Heartbeat run payload retention sweep disabled by HEARTBEAT_RUN_PAYLOAD_RETENTION=0",
    );
    return () => {};
  }

  const timer = setInterval(() => {
    pruneHeartbeatRunPayloads(db, retentionDays).catch((err) => {
      logger.warn({ err }, "Heartbeat run payload retention sweep failed");
    });
  }, intervalMs);

  // Run once on startup so an instance that was down over the window recovers
  // without waiting a full interval.
  pruneHeartbeatRunPayloads(db, retentionDays).catch((err) => {
    logger.warn({ err }, "Initial heartbeat run payload retention sweep failed");
  });

  return () => clearInterval(timer);
}
