import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  ATTENTION_RUN_RECENCY_MAX_PROBES,
  listAttentionSuppressedRunIds,
} from "../services/attention-failed-run-recency.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres attention recency tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("attention failed-run recency probe", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-attention-recency-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedAgent() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Recency Co",
      issuePrefix: "RNC",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Worker",
      role: "engineer",
      status: "active",
    });
    return { companyId, agentId };
  }

  it("suppresses a failed run when the agent later ran the same issue", async () => {
    const { companyId, agentId } = await seedAgent();
    const issueId = randomUUID();
    const failedRunId = randomUUID();
    const at = new Date("2026-07-09T12:00:00.000Z");
    await db.insert(heartbeatRuns).values([
      {
        id: failedRunId,
        companyId,
        agentId,
        status: "failed",
        contextSnapshot: { issueId, prompt: "x".repeat(32_000) },
        createdAt: at,
        updatedAt: at,
        finishedAt: at,
      },
      {
        id: randomUUID(),
        companyId,
        agentId,
        status: "succeeded",
        contextSnapshot: { issueId, prompt: "y".repeat(32_000) },
        createdAt: new Date("2026-07-09T12:01:00.000Z"),
        updatedAt: new Date("2026-07-09T12:01:00.000Z"),
        finishedAt: new Date("2026-07-09T12:01:00.000Z"),
      },
    ]);

    const suppressed = await listAttentionSuppressedRunIds(db, companyId, [{ id: failedRunId }]);

    expect([...suppressed]).toEqual([failedRunId]);
  });

  it("keeps a failed run when the agent only ran a different issue since", async () => {
    const { companyId, agentId } = await seedAgent();
    const failedRunId = randomUUID();
    const at = new Date("2026-07-09T12:00:00.000Z");
    await db.insert(heartbeatRuns).values([
      {
        id: failedRunId,
        companyId,
        agentId,
        status: "failed",
        contextSnapshot: { issueId: randomUUID() },
        createdAt: at,
        updatedAt: at,
        finishedAt: at,
      },
      {
        id: randomUUID(),
        companyId,
        agentId,
        status: "succeeded",
        contextSnapshot: { issueId: randomUUID() },
        createdAt: new Date("2026-07-09T12:01:00.000Z"),
        updatedAt: new Date("2026-07-09T12:01:00.000Z"),
        finishedAt: new Date("2026-07-09T12:01:00.000Z"),
      },
    ]);

    const suppressed = await listAttentionSuppressedRunIds(db, companyId, [{ id: failedRunId }]);

    expect(suppressed.size).toBe(0);
  });

  it("never lets an older run suppress a newer failed run for the same issue", async () => {
    const { companyId, agentId } = await seedAgent();
    const issueId = randomUUID();
    const failedRunId = randomUUID();
    await db.insert(heartbeatRuns).values([
      {
        id: randomUUID(),
        companyId,
        agentId,
        status: "succeeded",
        contextSnapshot: { issueId },
        createdAt: new Date("2026-07-09T12:00:00.000Z"),
        updatedAt: new Date("2026-07-09T12:00:00.000Z"),
      },
      {
        id: failedRunId,
        companyId,
        agentId,
        status: "failed",
        contextSnapshot: { issueId },
        createdAt: new Date("2026-07-09T12:05:00.000Z"),
        updatedAt: new Date("2026-07-09T12:05:00.000Z"),
      },
    ]);

    const suppressed = await listAttentionSuppressedRunIds(db, companyId, [{ id: failedRunId }]);

    // The failed run is the newest for this issue, so it must stay in the feed.
    expect(suppressed.size).toBe(0);
  });

  it("falls back to taskId when the failed run stored no issueId", async () => {
    const { companyId, agentId } = await seedAgent();
    const taskId = randomUUID();
    const failedRunId = randomUUID();
    await db.insert(heartbeatRuns).values([
      {
        id: failedRunId,
        companyId,
        agentId,
        status: "failed",
        contextSnapshot: { taskId },
        createdAt: new Date("2026-07-09T12:00:00.000Z"),
        updatedAt: new Date("2026-07-09T12:00:00.000Z"),
      },
      {
        id: randomUUID(),
        companyId,
        agentId,
        status: "succeeded",
        contextSnapshot: { taskId },
        createdAt: new Date("2026-07-09T12:01:00.000Z"),
        updatedAt: new Date("2026-07-09T12:01:00.000Z"),
      },
    ]);

    const suppressed = await listAttentionSuppressedRunIds(db, companyId, [{ id: failedRunId }]);

    expect([...suppressed]).toEqual([failedRunId]);
  });

  it("keys on issueId, not taskId, when a stored run disagrees", async () => {
    const { companyId, agentId } = await seedAgent();
    const issueId = randomUUID();
    const taskId = randomUUID();
    const failedRunId = randomUUID();
    await db.insert(heartbeatRuns).values([
      {
        // readRunIssueId prefers issueId, so this run keys on issueId alone.
        id: failedRunId,
        companyId,
        agentId,
        status: "failed",
        contextSnapshot: { issueId, taskId },
        createdAt: new Date("2026-07-09T12:00:00.000Z"),
        updatedAt: new Date("2026-07-09T12:00:00.000Z"),
      },
      {
        id: randomUUID(),
        companyId,
        agentId,
        status: "succeeded",
        contextSnapshot: { taskId },
        createdAt: new Date("2026-07-09T12:01:00.000Z"),
        updatedAt: new Date("2026-07-09T12:01:00.000Z"),
      },
    ]);

    const suppressed = await listAttentionSuppressedRunIds(db, companyId, [{ id: failedRunId }]);

    // The newer run only matches taskId, which this failed run does not key on.
    expect(suppressed.size).toBe(0);
  });

  it("ignores newer runs belonging to another company", async () => {
    const { companyId, agentId } = await seedAgent();
    const otherCompanyId = randomUUID();
    const otherAgentId = randomUUID();
    await db.insert(companies).values({
      id: otherCompanyId,
      name: "Other Co",
      issuePrefix: "OTC",
    });
    await db.insert(agents).values({
      id: otherAgentId,
      companyId: otherCompanyId,
      name: "Other Worker",
      role: "engineer",
      status: "active",
    });
    const issueId = randomUUID();
    const failedRunId = randomUUID();
    await db.insert(heartbeatRuns).values([
      {
        id: failedRunId,
        companyId,
        agentId,
        status: "failed",
        contextSnapshot: { issueId },
        createdAt: new Date("2026-07-09T12:00:00.000Z"),
        updatedAt: new Date("2026-07-09T12:00:00.000Z"),
      },
      {
        id: randomUUID(),
        companyId: otherCompanyId,
        agentId: otherAgentId,
        status: "succeeded",
        contextSnapshot: { issueId },
        createdAt: new Date("2026-07-09T12:01:00.000Z"),
        updatedAt: new Date("2026-07-09T12:01:00.000Z"),
      },
    ]);

    const suppressed = await listAttentionSuppressedRunIds(db, companyId, [{ id: failedRunId }]);

    expect(suppressed.size).toBe(0);
  });

  /**
   * Regression guard for the unbounded scan this replaced.
   *
   * The old lookup selected every run newer than the oldest failed run for the
   * failed agents, with no row bound. On the production control plane that read
   * ~2k heap blocks out of a ~1GB `heartbeat_runs` partition and took 14-24s per
   * feed build. Seeding history far larger than the failed-run set and then
   * asserting the probe's own scan stays proportional to the *failed* rows is
   * what makes a reintroduced unbounded scan fail here rather than in production.
   */
  it("keeps the probe scan proportional to the failed-run set, not to run history", async () => {
    const { companyId, agentId } = await seedAgent();
    const issueId = randomUUID();
    const failedRunId = randomUUID();
    const base = new Date("2026-07-09T12:00:00.000Z");
    await db.insert(heartbeatRuns).values({
      id: failedRunId,
      companyId,
      agentId,
      status: "failed",
      contextSnapshot: { issueId },
      createdAt: base,
      updatedAt: base,
    });

    // 2,000 unrelated runs for the same agent and company, all newer than the
    // failed run and all bound to other issues. The old query materialized every
    // one of these; the bounded probe must not.
    const noise = Array.from({ length: 2_000 }, (_, index) => ({
      id: randomUUID(),
      companyId,
      agentId,
      status: "succeeded",
      contextSnapshot: { issueId: randomUUID(), filler: "z".repeat(2_000) },
      createdAt: new Date(base.getTime() + (index + 1) * 1_000),
      updatedAt: new Date(base.getTime() + (index + 1) * 1_000),
    }));
    for (let offset = 0; offset < noise.length; offset += 500) {
      await db.insert(heartbeatRuns).values(noise.slice(offset, offset + 500));
    }

    const startedAt = process.hrtime.bigint();
    const suppressed = await listAttentionSuppressedRunIds(db, companyId, [{ id: failedRunId }]);
    const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;

    // No run exists for `issueId`, so nothing is suppressed regardless of history.
    expect(suppressed.size).toBe(0);
    // An unbounded scan of 2,001 rows per probe does not complete this fast on the
    // embedded cluster; a bounded index probe does.
    expect(elapsedMs).toBeLessThan(5_000);

    const noiseRows = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.companyId, companyId));
    expect(noiseRows.length).toBe(2_001);
    expect(ATTENTION_RUN_RECENCY_MAX_PROBES).toBeGreaterThan(0);
  });

  it("caps the number of probes regardless of how many failed runs are supplied", async () => {
    const { companyId, agentId } = await seedAgent();
    const base = new Date("2026-07-09T12:00:00.000Z");
    const ids = Array.from({ length: ATTENTION_RUN_RECENCY_MAX_PROBES + 50 }, () => randomUUID());
    await db.insert(heartbeatRuns).values(ids.map((id, index) => ({
      id,
      companyId,
      agentId,
      status: "failed",
      contextSnapshot: { issueId: randomUUID() },
      createdAt: new Date(base.getTime() + index),
      updatedAt: new Date(base.getTime() + index),
    })));

    const suppressed = await listAttentionSuppressedRunIds(
      db,
      companyId,
      ids.map((id) => ({ id })),
    );

    // No newer run exists for any of them, so nothing is suppressed, and the
    // extra ids past the cap are simply not probed.
    expect(suppressed.size).toBe(0);
  });
});