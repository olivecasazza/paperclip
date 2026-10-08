-- CON-390: listAttentionExhaustedRuns filtered heartbeat_run_events with
-- `message LIKE 'Bounded retry exhausted%'` and nothing indexed that predicate,
-- so every board attention load bitmap-scanned the company's events and
-- text-filtered each one. At 87,996 rows / 221 MB the plan read 10,074 rows to
-- keep 92, taking 2926ms. Ten concurrent board loads pinned all 10 connections
-- in the default-size pool, which starved /api/health — the k8s liveness probe —
-- into probe timeouts and SIGKILL restarts, killing every in-flight agent run.
--
-- Replace the pattern match on a human-readable string with a dedicated
-- boolean. The predicate becomes indexable, and it no longer breaks when the
-- message is redacted or reworded.
--
-- The column is NOT NULL with a constant default, so this is a metadata-only
-- catalog change: Postgres 11+ does not rewrite the table for an ADD COLUMN
-- with a constant default, so no full-table rewrite lock is taken here.
ALTER TABLE "heartbeat_run_events"
  ADD COLUMN IF NOT EXISTS "retry_exhausted" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Backfill the rows the old LIKE predicate already matched. This must run before
-- any server build starts filtering on the column, or previously-exhausted runs
-- would silently drop off the attention feed and the board would stop surfacing
-- them.
--
-- The predicate deliberately stays message-based here: this is a one-time copy
-- of the pre-existing truth, so rows whose message was redacted at write time by
-- the old path are preserved. New writes derive the flag from the structured
-- receipt and no longer depend on message text.
--
-- The same partial index created below serves this backfill, so it is a
-- sequential scan over the partial index rather than the whole table.
UPDATE "heartbeat_run_events"
SET "retry_exhausted" = true
WHERE "retry_exhausted" IS NOT TRUE
  AND "event_type" = 'lifecycle'
  AND "message" LIKE 'Bounded retry exhausted%';--> statement-breakpoint
-- The dedicated index the attention feed, the activity feed, and the retry
-- dedup receipt lookup all share. Leading column is company_id so the index is
-- used directly by the company-scoped exhaustion feed; run_id supports the
-- per-run lookups, and id DESC supports the "latest exhaustion per run"
-- DISTINCT ON. Without it the same 2926ms full scan returns.
--
-- paperclip:migration-safety-ignore large-create-index-not-concurrently: Drizzle
-- applies migrations inside a transaction, and CREATE INDEX CONCURRENTLY cannot
-- run inside a transaction block, so the transactional path is the only option
-- available in the migrator. The index covers a partial predicate selecting a
-- small fraction of an append-only event table, and the build takes a SHARE lock
-- that still permits concurrent INSERT/UPDATE/DELETE — it does not block the run
-- event write path that must stay available while this lands.
CREATE INDEX IF NOT EXISTS "heartbeat_run_events_company_retry_exhausted_idx"
  ON "heartbeat_run_events" USING btree ("company_id", "run_id", "id" DESC)
  WHERE "retry_exhausted";