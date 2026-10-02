import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it, afterEach } from "vitest";
import postgres from "postgres";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const cleanups: Array<() => Promise<void>> = [];
const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

const COMPANY_ID = "00000000-0000-4000-8000-000000000390";
const OTHER_COMPANY_ID = "00000000-0000-4000-8000-000000000391";
const AGENT_ID = "00000000-0000-4000-8000-000000000392";

async function seedCompaniesAndAgent(sql: postgres.Sql): Promise<void> {
  await sql`INSERT INTO companies (id, name, issue_prefix) VALUES
    (${COMPANY_ID}, 'C390', 'C39'), (${OTHER_COMPANY_ID}, 'C391', 'C38')
    ON CONFLICT DO NOTHING`;
  await sql`INSERT INTO agents (id, company_id, name)
    VALUES (${AGENT_ID}, ${COMPANY_ID}, 'C390 agent')
    ON CONFLICT DO NOTHING`;
}
const MIGRATION = "./migrations/0285_heartbeat_run_events_retry_exhausted.sql";

d("heartbeat_run_events retry_exhausted column migration", () => {
  it("indexes the exhaustion predicate and stops depending on the message text", async () => {
    const dbh = await startEmbeddedPostgresTestDatabase("con390-retry-exhausted-");
    cleanups.push(() => dbh.cleanup());
    const sql = postgres(dbh.connectionString, { max: 1 });
    cleanups.push(async () => { await sql.end(); });

    const idx = await sql`SELECT indexname FROM pg_indexes WHERE tablename = 'heartbeat_run_events'`;
    expect(idx.map((r) => r.indexname)).toContain("heartbeat_run_events_company_retry_exhausted_idx");

    const col = await sql<{ is_nullable: string; column_default: string }[]>`
      SELECT is_nullable, column_default
      FROM information_schema.columns
      WHERE table_name = 'heartbeat_run_events' AND column_name = 'retry_exhausted'
    `;
    expect(col).toHaveLength(1);
    expect(col[0]!.is_nullable).toBe("NO");

    await seedCompaniesAndAgent(sql);
    const runIds = Array.from({ length: 6 }, () => crypto.randomUUID());
    const [exhaustedId, textOnlyId, otherCompanyId, redactedId, ...restRunIds] = runIds;
    for (const id of [exhaustedId!, textOnlyId!, otherCompanyId!, redactedId!, ...restRunIds]) {
      await sql`
        INSERT INTO heartbeat_runs (id, company_id, agent_id, status)
        VALUES (${id}, ${id === otherCompanyId ? OTHER_COMPANY_ID : COMPANY_ID}, ${AGENT_ID}, 'failed')
      `;
    }

    // Exhaustion receipts are marked structurally, independent of the message.
    await sql`
      INSERT INTO heartbeat_run_events (company_id, run_id, agent_id, seq, event_type, message, retry_exhausted)
      SELECT company_id, id, agent_id, 1, 'lifecycle',
             'Bounded retry exhausted after 4 scheduled attempts',
             true
      FROM heartbeat_runs WHERE id IN (${exhaustedId}, ${redactedId})
    `;
    // A redacted message must not stop the row from being an exhaustion receipt.
    await sql`
      UPDATE heartbeat_run_events SET message = '[redacted]'
      WHERE run_id = ${redactedId} AND retry_exhausted
    `;
    // A row whose text still matches but which was never marked is NOT a receipt.
    // This is the class of row the old LIKE predicate over-selected.
    await sql`
      INSERT INTO heartbeat_run_events (company_id, run_id, agent_id, seq, event_type, message, retry_exhausted)
      SELECT company_id, id, agent_id, 1, 'lifecycle',
             'Bounded retry exhausted (reworded by an older build)', false
      FROM heartbeat_runs WHERE id = ${textOnlyId}
    `;
    await sql`
      INSERT INTO heartbeat_run_events (company_id, run_id, agent_id, seq, event_type, message, retry_exhausted)
      SELECT company_id, id, agent_id, 1, 'lifecycle',
             'Bounded retry exhausted after 4 scheduled attempts', true
      FROM heartbeat_runs WHERE id = ${otherCompanyId}
    `;

    const feed = await sql<{ run_id: string }[]>`
      SELECT run_id FROM heartbeat_run_events
      WHERE company_id = ${COMPANY_ID} AND event_type = 'lifecycle' AND retry_exhausted
      ORDER BY run_id
    `;
    expect(feed.map((r) => r.run_id).sort()).toEqual([exhaustedId, redactedId].sort());

    // The planner must use the partial index for the company-scoped exhaustion
    // feed rather than scanning and filtering the company's events by text.
    await sql`SET enable_seqscan = off`;
    const plan = await sql.unsafe(
      "EXPLAIN SELECT DISTINCT ON (run_id) run_id, id FROM heartbeat_run_events " +
      `WHERE company_id = '${COMPANY_ID}' AND event_type = 'lifecycle' ` +
      // This is the exact shape drizzle emits for eq(heartbeatRunEvents.retryExhausted, true).
      // Postgres only matches a partial index when the WHERE clause implies the
      // index predicate by implication, and `= true` implies it while `IS TRUE`
      // does not — so the service query must keep using eq(), not isTrue().
      `AND retry_exhausted = true ` +
      "ORDER BY run_id, id DESC",
    );
    const planText = plan.map((r) => Object.values(r)[0]).join("\n");
    expect(planText).toContain("heartbeat_run_events_company_retry_exhausted_idx");
    expect(planText).not.toMatch(/Rows Removed by Filter/);

    // Idempotency: re-running the migration against an already migrated database
    // must not error and must not clear any flag it already set. It does
    // promote the legacy text-only receipt, which is deliberate — that is the
    // same repair a pre-migration pod's events get, so re-applying is safe.
    const migrationSql = await readFile(fileURLToPath(new URL(MIGRATION, import.meta.url)), "utf8");
    const statements = migrationSql
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    expect(statements.length).toBeGreaterThan(0);
    for (const statement of statements) {
      await sql.unsafe(statement);
    }
    const after = await sql<{ run_id: string; retry_exhausted: boolean }[]>`
      SELECT run_id, retry_exhausted FROM heartbeat_run_events WHERE retry_exhausted ORDER BY run_id
    `;
    expect(after.map((r) => r.run_id).sort()).toEqual(
      [exhaustedId, redactedId, textOnlyId, otherCompanyId].sort(),
    );
  }, 240_000);

  it("backfills receipts written before the column existed", async () => {
    const dbh = await startEmbeddedPostgresTestDatabase("con390-retry-backfill-");
    cleanups.push(() => dbh.cleanup());
    const sql = postgres(dbh.connectionString, { max: 1 });
    cleanups.push(async () => { await sql.end(); });

    // Reconstruct the pre-migration table: no column, no index, and exhaustion
    // receipts identified only by the old message pattern.
    await sql`ALTER TABLE heartbeat_run_events DROP COLUMN retry_exhausted`;
    await sql`DROP INDEX IF EXISTS heartbeat_run_events_company_retry_exhausted_idx`;

    await seedCompaniesAndAgent(sql);
    const receiptId = crypto.randomUUID();
    const otherId = crypto.randomUUID();
    for (const id of [receiptId, otherId]) {
      await sql`
        INSERT INTO heartbeat_runs (id, company_id, agent_id, status)
        VALUES (${id}, ${COMPANY_ID}, ${AGENT_ID}, 'failed')
      `;
    }
    await sql`
      INSERT INTO heartbeat_run_events (company_id, run_id, agent_id, seq, event_type, message)
      SELECT company_id, ${receiptId}::uuid, agent_id, 1, 'lifecycle',
             'Bounded retry exhausted after 4 scheduled attempts'
      FROM heartbeat_runs WHERE id = ${receiptId}
    `;
    await sql`
      INSERT INTO heartbeat_run_events (company_id, run_id, agent_id, seq, event_type, message)
      SELECT company_id, ${otherId}::uuid, agent_id, 1, 'lifecycle',
             'Ordinary lifecycle event'
      FROM heartbeat_runs WHERE id = ${otherId}
    `;

    const migrationSql = await readFile(fileURLToPath(new URL(MIGRATION, import.meta.url)), "utf8");
    for (const statement of migrationSql
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter((s) => s.length > 0)) {
      await sql.unsafe(statement);
    }

    const rows = await sql<{ run_id: string; retry_exhausted: boolean }[]>`
      SELECT run_id, retry_exhausted FROM heartbeat_run_events ORDER BY run_id
    `;
    const byRun = new Map(rows.map((r) => [r.run_id, r.retry_exhausted]));
    expect(byRun.get(receiptId)).toBe(true);
    expect(byRun.get(otherId)).toBe(false);
  }, 240_000);
});
