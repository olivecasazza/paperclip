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
 *
 * Note that this is a *logical* payload window, not a disk window: trimming
 * frees detoast work, not OS bytes. See the `pruneHeartbeatRunPayloads` doc
 * comment and CON-468 for the measurement that corrected the earlier claim.
 */
const DEFAULT_RETENTION_DAYS = 30;

/** Maximum rows touched per batch, to keep each statement's footprint bounded. */
export const TRIM_BATCH_SIZE = 500;

/**
 * Maximum batches per sweep so a backlog cannot monopolise the connection.
 *
 * At `TRIM_BATCH_SIZE` this caps a single sweep at 10,000 rows. A larger backlog
 * is not an error: the next sweep continues where this one stopped — but the
 * sweep must *say* so with the real remainder, not just "some runs may remain".
 * See `pruneHeartbeatRunPayloads`, which counts the leftovers on the cap path.
 */
export const MAX_ITERATIONS = 20;

/** How often the sweep runs (default: 6 hours). */
const DEFAULT_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1_000;

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
 * How many rows still match `trimCandidates` at `cutoff`.
 *
 * Only ever called on the per-sweep cap path, so it is one cheap `count(*)`
 * over an already-selective predicate and not something the hot loop pays for.
 */
async function countTrimCandidates(db: Db, cutoff: Date): Promise<number> {
  return db
    .select({ count: sql<number>`count(*)::int` })
    .from(heartbeatRuns)
    .where(trimCandidates(cutoff))
    .then((rows) => rows[0]?.count ?? 0);
}

/**
 * Trim the stored payload on terminal runs older than the retention window.
 *
 * Unlike a delete, this keeps the row: id, status, timings, exit metadata and
 * every `context_snapshot` routing key survive, so history, filters and joins
 * are unaffected. What goes away is `result_json`, `usage_json`, the stdout and
 * stderr excerpts, and the non-routing half of `context_snapshot`.
 *
 * ## This does not return disk space to the OS
 *
 * An earlier revision of this comment claimed that "because the heavy columns
 * live in TOAST, nulling them lets the space be returned to the OS instead of
 * only shrinking future inserts". That was false, and CON-468 measured it false
 * on the live database: trimming the aged backlog left `heartbeat_runs` at
 * 1041 MB total / 930 MB TOAST, and a real `VACUUM` afterwards left it at
 * 1041 MB / 930 MB — unchanged.
 *
 * The mechanism is ordinary MVCC. An `UPDATE` writes a *new* tuple version; the
 * superseded tuple's TOAST chunks are not reused and are not released by
 * `VACUUM`, which only marks dead tuples reusable for future inserts. Returning
 * them to the OS needs `VACUUM FULL` (rewrites the table under an
 * `ACCESS EXCLUSIVE` lock) or `pg_repack` (needs the extension, which this
 * deployment does not have, plus its own lock window). Neither is something
 * this sweep can do on a live, saturated pool.
 *
 * So the honest description of what this sweep does:
 *
 * - **It does:** shrink what each future read of an aged row has to detoast, and
 *   shrink the size of the tuple a future rewrite of that row writes. The
 *   logical payload of an aged run genuinely goes to near zero.
 * - **It does not:** reduce `pg_total_relation_size('heartbeat_runs')`. It leaves
 *   the freed bytes as dead tuples for `VACUUM` to recycle.
 *
 * Reclaiming the space is a separate, deliberate operation owned by ops, not by
 * this scheduled job. See CON-436 item 1 for row deletion and CON-446 for why
 * deletion is gated behind the FK graph.
 *
 * ## This does not mitigate pool starvation
 *
 * The run-list query (`heartbeat.list`, and the 26 call sites that order by
 * `heartbeat_runs.created_at DESC`) reads the *newest* rows first. This sweep
 * trims the *oldest* rows first. Those two sets barely overlap, so on this
 * deployment the sweep is structurally incapable of helping the query that is
 * actually saturating the pool (CON-431, CON-433).
 *
 * Measured live on 2026-10-04, by varying only which columns the list
 * projection extracts (newest 200 rows, same connection, median of 7):
 *
 * | projection | wall time |
 * | --- | --- |
 * | `result_json` + `context_snapshot` extracts (as shipped) | 831 ms |
 * | `context_snapshot` extracts only | 38 ms |
 * | `result_json` extracts only | 1282 ms |
 * | neither — the floor, and what a fully-trimmed table would give | 13 ms |
 *
 * So the cost the hot path pays is almost entirely `result_json` detoast, and
 * trimming `result_json` on rows the list query *does* read is worth roughly
 * two orders of magnitude. The 30-day window simply never reaches them: on the
 * measured table, 9,469 rows / 359 MB of `result_json` sit inside the window
 * against 19,010 rows / 128 MB outside it, and the oldest row in the table is
 * 2026-05-11, so nothing ages into the trim range quickly.
 *
 * Shortening the window far enough to overlap the hot cohort would fix the
 * starvation, and would also mean discarding the full `result_json` of runs
 * that are only days old — which is what the single-run `getRun` read (and
 * therefore run debugging) still depends on. That is a retention-policy
 * tradeoff, not a code default, so it is deliberately not changed here. It is
 * tracked as a decision on CON-468 and cross-linked from CON-446, which already
 * holds the board gate on run retention policy.
 *
 * Read this module as what it is: a housekeeping job that keeps aged rows from
 * growing without bound. It is not, on its own, a mitigation for pool
 * starvation. It was previously described as one, and it is not.
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
  let hitIterationCap = false;

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
    if (batchIds.length < TRIM_BATCH_SIZE) {
      hitIterationCap = false;
      break;
    }
    hitIterationCap = true;
  }

  if (hitIterationCap) {
    // CON-468 defect 3: the live backlog (18,385 candidates) exceeds one
    // sweep's 10,000-row ceiling every single time, so this is the *normal*
    // path, not an exceptional one. Logging "some runs may remain untrimmed"
    // here hid that. Count the actual remainder instead, so the log answers
    // "how many sweeps will it take" instead of leaving it to be guessed.
    const remainingCandidates = await countTrimCandidates(db, cutoff);
    const sweepsToDrain = Math.ceil(remainingCandidates / (MAX_ITERATIONS * TRIM_BATCH_SIZE));
    logger.warn(
      {
        totalTrimmed,
        iterations,
        cutoffDate: cutoff,
        remainingCandidates,
        maxRowsPerSweep: MAX_ITERATIONS * TRIM_BATCH_SIZE,
        sweepsToDrain,
      },
      "Heartbeat run payload retention hit the per-sweep row cap; backlog remains",
    );
  }

  if (totalTrimmed > 0) {
    logger.info(
      { totalTrimmed, retentionDays, spaceReturnedToOs: false },
      "Trimmed payload on aged terminal heartbeat runs (logical payload only; freed TOAST stays on disk until VACUUM FULL/pg_repack)",
    );
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
