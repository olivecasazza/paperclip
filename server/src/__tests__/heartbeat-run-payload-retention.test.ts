import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, heartbeatRuns } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

vi.mock("../middleware/logger.js", () => ({
  logger: {
    child: vi.fn(function child() {
      return this;
    }),
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  },
  httpLogger: vi.fn(),
}));

import {
  MAX_ITERATIONS,
  pruneHeartbeatRunPayloads,
  TRIM_BATCH_SIZE,
} from "../services/heartbeat-run-payload-retention.ts";
import { logger } from "../middleware/logger.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping heartbeat run payload retention tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

const DAY_MS = 86_400_000;

beforeEach(() => {
  vi.mocked(logger.warn).mockClear();
  vi.mocked(logger.info).mockClear();
});

describeEmbeddedPostgres("pruneHeartbeatRunPayloads", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;
  let agentId!: string;

  const daysAgo = (days: number) => new Date(Date.now() - days * DAY_MS);

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-run-payload-retention");
    db = createDb(tempDb.connectionString);
    const company = await db
      .insert(companies)
      .values({ name: `retention-co-${randomUUID()}` })
      .returning({ id: companies.id });
    companyId = company[0]!.id;
    const agent = await db
      .insert(agents)
      .values({ companyId, name: `retention-agent-${randomUUID()}`, adapterType: "opencode_local" })
      .returning({ id: agents.id });
    agentId = agent[0]!.id;
  }, 120_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function insertRun(overrides: {
    status: string;
    createdAt: Date;
    contextSnapshot?: Record<string, unknown>;
    resultJson?: Record<string, unknown>;
    stdoutExcerpt?: string;
  }) {
    const [row] = await db
      .insert(heartbeatRuns)
      .values({
        companyId,
        agentId,
        status: overrides.status,
        createdAt: overrides.createdAt,
        finishedAt: overrides.createdAt,
        contextSnapshot: overrides.contextSnapshot ?? {},
        resultJson: overrides.resultJson ?? null,
        usageJson: overrides.resultJson ? { totalTokens: 10 } : null,
        stdoutExcerpt: overrides.stdoutExcerpt ?? null,
        stderrExcerpt: overrides.stdoutExcerpt ? "stderr" : null,
      })
      .returning({ id: heartbeatRuns.id });
    return row!.id;
  }

  async function readRun(id: string) {
    const [row] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, id));
    return row!;
  }

  it("trims payloads and heavy context keys on aged terminal runs", async () => {
    const id = await insertRun({
      status: "succeeded",
      createdAt: daysAgo(45),
      resultJson: { output: "x".repeat(2000) },
      stdoutExcerpt: "log line".repeat(500),
      contextSnapshot: {
        issueId: randomUUID(),
        taskKey: "CON-1",
        wakeReason: "heartbeat_timer",
        paperclipTaskMarkdown: "y".repeat(4000),
        paperclipIssue: { description: "z".repeat(4000) },
        paperclipEnvironment: { name: "env" },
        paperclipWake: { connectorSkillInstructions: "w".repeat(4000) },
      },
    });

    const before = await readRun(id);
    expect(before.resultJson).not.toBeNull();
    expect(before.stdoutExcerpt).not.toBeNull();

    const trimmed = await pruneHeartbeatRunPayloads(db, 30);
    expect(trimmed).toBeGreaterThan(0);

    const after = await readRun(id);
    // Heavy payloads are gone...
    expect(after.resultJson).toBeNull();
    expect(after.usageJson).toBeNull();
    expect(after.stdoutExcerpt).toBeNull();
    expect(after.stderrExcerpt).toBeNull();
    expect(after.contextSnapshot).not.toHaveProperty("paperclipTaskMarkdown");
    expect(after.contextSnapshot).not.toHaveProperty("paperclipIssue");
    expect(after.contextSnapshot).not.toHaveProperty("paperclipEnvironment");
    expect(after.contextSnapshot).not.toHaveProperty("paperclipWake");

    // ...but the row, its status and every routing key survive.
    expect(after.id).toBe(id);
    expect(after.status).toBe("succeeded");
    expect(after.contextSnapshot).toMatchObject({
      issueId: before.contextSnapshot!.issueId,
      taskKey: "CON-1",
      wakeReason: "heartbeat_timer",
    });
  });

  it("leaves non-terminal runs untouched", async () => {
    const id = await insertRun({
      status: "running",
      createdAt: daysAgo(45),
      resultJson: { output: "still running" },
      stdoutExcerpt: "live",
      contextSnapshot: { issueId: randomUUID(), paperclipWake: { a: 1 } },
    });

    await pruneHeartbeatRunPayloads(db, 30);

    const after = await readRun(id);
    expect(after.resultJson).not.toBeNull();
    expect(after.stdoutExcerpt).toBe("live");
    expect(after.contextSnapshot).toHaveProperty("paperclipWake");
  });

  it("leaves terminal runs inside the retention window untouched", async () => {
    const id = await insertRun({
      status: "failed",
      createdAt: daysAgo(2),
      resultJson: { error: "recent" },
      contextSnapshot: { issueId: randomUUID(), paperclipIssue: { title: "fresh" } },
    });

    await pruneHeartbeatRunPayloads(db, 30);

    const after = await readRun(id);
    expect(after.resultJson).not.toBeNull();
    expect(after.contextSnapshot).toHaveProperty("paperclipIssue");
  });

  it("preserves the keys the run-list projection and joins read", async () => {
    const issueId = randomUUID();
    const taskId = randomUUID();
    const wakeCommentId = randomUUID();
    const id = await insertRun({
      status: "cancelled",
      createdAt: daysAgo(60),
      resultJson: { output: "y".repeat(1000) },
      contextSnapshot: {
        issueId,
        taskId,
        taskKey: "CON-77",
        wakeCommentId,
        commentId: randomUUID(),
        wakeSource: "issue.comment",
        wakeTriggerDetail: "manual",
        source: "issue.comment",
        resumeIntent: true,
        paperclipWake: { big: "q".repeat(2000) },
        paperclipWorkspace: { id: randomUUID() },
        executionContinuation: { nested: true },
      },
    });

    await pruneHeartbeatRunPayloads(db, 30);

    const after = await readRun(id);
    // Every key that services/issues.ts, routines.ts, slack-conversation-state.ts
    // and chat-channels.ts extract in SQL must still resolve.
    expect(after.contextSnapshot).toMatchObject({
      issueId,
      taskId,
      taskKey: "CON-77",
      wakeCommentId,
      wakeSource: "issue.comment",
      wakeTriggerDetail: "manual",
      source: "issue.comment",
      resumeIntent: true,
      executionContinuation: { nested: true },
    });
    expect(after.contextSnapshot).not.toHaveProperty("paperclipWake");
    expect(after.contextSnapshot).not.toHaveProperty("paperclipWorkspace");
  });

  it("is a no-op on a second sweep", async () => {
    const id = await insertRun({
      status: "timed_out",
      createdAt: daysAgo(90),
      resultJson: { output: "z".repeat(1000) },
      contextSnapshot: { issueId: randomUUID(), paperclipIssue: { a: 1 } },
    });

    await pruneHeartbeatRunPayloads(db, 30);
    const second = await pruneHeartbeatRunPayloads(db, 30);

    // The row was already trimmed, so the repeat sweep must not count it again.
    expect(second).toBe(0);
    const after = await readRun(id);
    expect(after.resultJson).toBeNull();
  });

  it("keeps context_snapshot a jsonb object even when nothing is preserved", async () => {
    const id = await insertRun({
      status: "interrupted",
      createdAt: daysAgo(50),
      resultJson: { output: "q".repeat(500) },
      contextSnapshot: { paperclipIssue: { a: 1 }, paperclipWake: { b: 2 } },
    });

    await pruneHeartbeatRunPayloads(db, 30);

    const after = await readRun(id);
    expect(after.contextSnapshot).toEqual({});
  });

  it("bounds one sweep to a fixed number of rows so it cannot hold a single unbounded lock", async () => {
    // The first cut updated every candidate row in one statement and used
    // TRIM_BATCH_SIZE only as a post-hoc break test, so a single sweep rewrote
    // the whole aged backlog at once. These rows must survive one call.
    const backlog = MAX_ITERATIONS * TRIM_BATCH_SIZE + 25;
    const base = daysAgo(200);
    const chunkSize = 500;
    for (let start = 0; start < backlog; start += chunkSize) {
      const size = Math.min(chunkSize, backlog - start);
      await db.insert(heartbeatRuns).values(
        Array.from({ length: size }, (_, offset) => {
          const index = start + offset;
          return {
            companyId,
            agentId,
            status: "succeeded",
            createdAt: new Date(base.getTime() - index * 1000),
            finishedAt: new Date(base.getTime() - index * 1000),
            contextSnapshot: { issueId: randomUUID(), paperclipIssue: { a: 1 } },
            resultJson: { output: "x".repeat(64) },
            usageJson: { totalTokens: 1 },
          };
        }),
      );
    }

    const trimmed = await pruneHeartbeatRunPayloads(db, 30);
    const ceiling = MAX_ITERATIONS * TRIM_BATCH_SIZE;

    expect(trimmed).toBe(ceiling);

    // Work remains, and it is picked up by the next sweep rather than forced
    // into this one.
    const second = await pruneHeartbeatRunPayloads(db, 30);
    expect(second).toBe(25);
    expect(await pruneHeartbeatRunPayloads(db, 30)).toBe(0);
  }, 120_000);

  it("reports the real backlog remainder when it stops on the per-sweep row cap", async () => {
    // CON-468 defect 3: the live backlog (18,385 candidates) is larger than one
    // sweep's 10,000-row ceiling on every single run, so the cap is the normal
    // path. The old code logged "some runs may remain untrimmed" with no
    // number, which hid that. Pin the count and the derived drain estimate.
    const backlog = MAX_ITERATIONS * TRIM_BATCH_SIZE + 40;
    const base = daysAgo(300);
    const chunkSize = 500;
    for (let start = 0; start < backlog; start += chunkSize) {
      const size = Math.min(chunkSize, backlog - start);
      await db.insert(heartbeatRuns).values(
        Array.from({ length: size }, (_, offset) => {
          const index = start + offset;
          return {
            companyId,
            agentId,
            status: "failed",
            createdAt: new Date(base.getTime() - index * 1000),
            finishedAt: new Date(base.getTime() - index * 1000),
            contextSnapshot: { issueId: randomUUID(), paperclipIssue: { a: 1 } },
            resultJson: { output: "x".repeat(64) },
          };
        }),
      );
    }

    await pruneHeartbeatRunPayloads(db, 30);

    const capped = logger.warn.mock.calls.filter((call) =>
      String(call[1] ?? "").includes("per-sweep row cap"),
    );
    expect(capped.length).toBeGreaterThanOrEqual(1);

    const payload = capped.at(-1)![0] as Record<string, unknown>;
    expect(payload.totalTrimmed).toBe(MAX_ITERATIONS * TRIM_BATCH_SIZE);
    expect(payload.maxRowsPerSweep).toBe(MAX_ITERATIONS * TRIM_BATCH_SIZE);
    expect(payload.sweepsToDrain).toBe(1);
  }, 120_000);

  it("does not claim to return disk space in the success log", async () => {
    // CON-468 defect 1: the sweep cannot return freed TOAST to the OS, so the
    // log line has to say so rather than let an operator infer it did.
    const id = await insertRun({
      status: "succeeded",
      createdAt: daysAgo(70),
      resultJson: { output: "x".repeat(1000) },
      contextSnapshot: { issueId: randomUUID(), paperclipIssue: { a: 1 } },
    });
    expect(id).toBeTruthy();

    await pruneHeartbeatRunPayloads(db, 30);

    const info = logger.info.mock.calls.filter((call) =>
      String(call[1] ?? "").includes("Trimmed payload on aged terminal heartbeat runs"),
    );
    expect(info.length).toBeGreaterThanOrEqual(1);
    const payload = info.at(-1)![0] as Record<string, unknown>;
    expect(payload.spaceReturnedToOs).toBe(false);
    expect(payload.totalTrimmed).toBeGreaterThan(0);
  });
});
