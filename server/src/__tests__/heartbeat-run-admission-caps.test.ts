import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, heartbeatRuns } from "@paperclipai/db";
import {
  HEARTBEAT_COMPANY_MAX_CONCURRENT_RUNS_DEFAULT,
  HEARTBEAT_GLOBAL_MAX_CONCURRENT_RUNS_DEFAULT,
} from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Run-admission cap test run.",
    provider: "test",
    model: "test-model",
  })),
);

const mockLoggerInfo = vi.hoisted(() => vi.fn());

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>(
    "../adapters/index.ts",
  );
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: mockAdapterExecute,
    })),
  };
});

vi.mock("../middleware/logger.js", async () => {
  const actual = await vi.importActual<
    typeof import("../middleware/logger.js")
  >("../middleware/logger.js");
  return {
    ...actual,
    logger: {
      ...actual.logger,
      info: mockLoggerInfo,
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
  };
});

const { heartbeatService, evaluateRunAdmissionCaps } = await import(
  "../services/heartbeat.ts"
);

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe
  : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat run-admission cap tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

// ---------------------------------------------------------------------------
// Pure admission-gate logic
// ---------------------------------------------------------------------------

describe("evaluateRunAdmissionCaps", () => {
  const base = {
    globalCap: HEARTBEAT_GLOBAL_MAX_CONCURRENT_RUNS_DEFAULT,
    companyCap: HEARTBEAT_COMPANY_MAX_CONCURRENT_RUNS_DEFAULT,
    agentCap: 1,
    runningGlobal: 0,
    runningCompany: 0,
    runningAgent: 0,
    activeCompanyCount: 1,
  };

  it("refuses when the process-scoped aggregate ceiling is full and the company holds its fair share", () => {
    const decision = evaluateRunAdmissionCaps({
      ...base,
      globalCap: 3,
      companyCap: 10,
      agentCap: 10,
      runningGlobal: 3,
      runningCompany: 3,
      activeCompanyCount: 1,
    });

    expect(decision).toMatchObject({
      allowed: false,
      cap: "global_run_cap",
      availableSlots: 0,
    });
    expect(decision.reason).toContain("global run cap reached (3/3)");
    expect(decision.reason).toContain("fair share of 3");
  });

  it("refuses when the company-scoped ceiling is full even though the aggregate has room", () => {
    const decision = evaluateRunAdmissionCaps({
      ...base,
      globalCap: 10,
      companyCap: 2,
      agentCap: 10,
      runningGlobal: 2,
      runningCompany: 2,
      activeCompanyCount: 3,
    });

    expect(decision).toMatchObject({
      allowed: false,
      cap: "company_run_cap",
      availableSlots: 0,
    });
    expect(decision.reason).toBe("company run cap reached (2/2)");
  });

  it("lets an under-represented tenant promote through a full aggregate (fair share)", () => {
    const decision = evaluateRunAdmissionCaps({
      ...base,
      globalCap: 3,
      companyCap: 2,
      agentCap: 5,
      runningGlobal: 3,
      runningCompany: 0,
      activeCompanyCount: 3,
    });

    expect(decision).toMatchObject({
      allowed: true,
      cap: null,
      reason: null,
      // The aggregate is full, so the fair-share rule hands over exactly one
      // reachable slot rather than letting this tenant run away with it.
      availableSlots: 1,
    });
  });

  it("refuses on the per-agent ceiling when the company and aggregate ceilings have room", () => {
    const decision = evaluateRunAdmissionCaps({
      ...base,
      globalCap: 10,
      companyCap: 4,
      agentCap: 1,
      runningGlobal: 1,
      runningCompany: 1,
      runningAgent: 1,
      activeCompanyCount: 2,
    });

    expect(decision).toMatchObject({
      allowed: false,
      cap: "agent_run_cap",
      availableSlots: 0,
    });
    expect(decision.reason).toBe("agent max concurrent runs reached (1/1)");
  });

  it("never grants a company more than the aggregate has left", () => {
    const decision = evaluateRunAdmissionCaps({
      ...base,
      globalCap: 5,
      companyCap: 4,
      agentCap: 4,
      runningGlobal: 4,
      runningCompany: 0,
      activeCompanyCount: 2,
    });

    expect(decision.allowed).toBe(true);
    expect(decision.availableSlots).toBe(1);
  });

  it("bounds one promotion batch by the smallest remaining ceiling", () => {
    // The batch size a promotion may claim is the smallest remaining allowance
    // across all three ceilings: the agent has room, but the company only has
    // one slot left, so exactly one promotion is allowed.
    const decision = evaluateRunAdmissionCaps({
      globalCap: 10,
      companyCap: 3,
      agentCap: 20,
      runningGlobal: 4,
      runningCompany: 2,
      runningAgent: 1,
      activeCompanyCount: 2,
    });

    expect(decision.allowed).toBe(true);
    expect(decision.availableSlots).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Admission gate wiring against the real schema
// ---------------------------------------------------------------------------

async function cleanupAdmissionFixture(db: ReturnType<typeof createDb>) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await db.execute(sql.raw(`
        TRUNCATE TABLE
          "issue_relations",
          "issues",
          "heartbeat_run_events",
          "cost_events",
          "activity_log",
          "heartbeat_runs",
          "agent_wakeup_requests",
          "agent_runtime_state",
          "agents",
          "companies"
        RESTART IDENTITY CASCADE
      `));
      return;
    } catch {
      if (attempt === 9) throw new Error("could not clean up run-admission fixture");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

describeEmbeddedPostgres("heartbeat company- and process-scoped run-admission caps", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null =
    null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase(
      "paperclip-heartbeat-admission-caps-",
    );
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db, {
      runtimeEnv: { ...process.env, PAPERCLIP_IN_WORKTREE: "false" },
    });
  }, 30_000);

  afterEach(async () => {
    mockAdapterExecute.mockReset();
    mockAdapterExecute.mockImplementation(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      errorMessage: null,
      summary: "Run-admission cap test run.",
      provider: "test",
      model: "test-model",
    }));
    mockLoggerInfo.mockReset();
    await cleanupAdmissionFixture(db);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany(label: string) {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: label,
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      defaultResponsibleUserId: "responsible-user",
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedAgent(
    companyId: string,
    heartbeat: Record<string, unknown>,
    agentName: string,
  ) {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: agentName,
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, ...heartbeat } },
      permissions: {},
    });
    return agentId;
  }

  async function seedRunningRun(companyId: string, agentId: string) {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "on_demand",
      triggerDetail: "manual",
      status: "running",
      createdAt: new Date(),
      startedAt: new Date(),
      contextSnapshot: {},
    });
    return runId;
  }

  function refusalReasons() {
    return mockLoggerInfo.mock.calls
      .filter(([, message]) =>
        String(message).includes("run-admission cap"),
      )
      .map(([payload]) => (payload as { reason?: string })?.reason ?? "");
  }

  it("refuses a promotion when the process-scoped aggregate ceiling is full", async () => {
    const companyId = await seedCompany("Aggregate-full tenant");
    const agentId = await seedAgent(
      companyId,
      {
        maxConcurrentRuns: 10,
        companyMaxConcurrentRuns: 10,
        globalMaxConcurrentRuns: 2,
      },
      "AggregateCoder",
    );
    // One company holding every aggregate slot: fair share is
    // ceil(2 / 1 active company) = 2, which the company already holds.
    await seedRunningRun(companyId, agentId);
    await seedRunningRun(companyId, agentId);

    const run = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
    });

    expect(run).not.toBeNull();
    expect((await heartbeat.getRun(run!.id))?.status).toBe("queued");
    expect(mockAdapterExecute).not.toHaveBeenCalled();
    expect(refusalReasons()).toEqual([
      expect.stringContaining("global run cap reached (2/2)"),
    ]);
  });

  it("refuses a promotion when the company-scoped ceiling is full", async () => {
    const companyId = await seedCompany("Company-full tenant");
    const agentId = await seedAgent(
      companyId,
      {
        maxConcurrentRuns: 10,
        companyMaxConcurrentRuns: 1,
        globalMaxConcurrentRuns: 10,
      },
      "CompanyFullCoder",
    );
    await seedRunningRun(companyId, agentId);

    const run = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
    });

    expect(run).not.toBeNull();
    expect((await heartbeat.getRun(run!.id))?.status).toBe("queued");
    expect(mockAdapterExecute).not.toHaveBeenCalled();
    expect(refusalReasons()).toEqual([
      "company run cap reached (1/1)",
    ]);
  });

  it("promotes an under-represented tenant while the aggregate reads full (fair share)", async () => {
    const greedyCompanyId = await seedCompany("Greedy tenant");
    const greedyAgentId = await seedAgent(
      greedyCompanyId,
      {
        maxConcurrentRuns: 10,
        companyMaxConcurrentRuns: 10,
        globalMaxConcurrentRuns: 2,
      },
      "GreedyCoder",
    );
    await seedRunningRun(greedyCompanyId, greedyAgentId);
    await seedRunningRun(greedyCompanyId, greedyAgentId);

    const tenantCompanyId = await seedCompany("Under-represented tenant");
    const tenantAgentId = await seedAgent(
      tenantCompanyId,
      {
        maxConcurrentRuns: 10,
        companyMaxConcurrentRuns: 10,
        globalMaxConcurrentRuns: 2,
      },
      "QuietTenantCoder",
    );

    const run = await heartbeat.wakeup(tenantAgentId, {
      source: "on_demand",
      triggerDetail: "manual",
    });

    expect(run).not.toBeNull();
    expect(refusalReasons()).toEqual([]);
    await vi.waitFor(() => {
      expect(mockAdapterExecute).toHaveBeenCalled();
    });
    await heartbeat.drainActiveRunExecutions();
    expect((await heartbeat.getRun(run!.id))?.status).toBe("succeeded");
  });

  it("still refuses on the per-agent maxConcurrentRuns ceiling when the wider caps have room", async () => {
    const companyId = await seedCompany("Agent-capped tenant");
    const agentId = await seedAgent(
      companyId,
      {
        maxConcurrentRuns: 1,
        companyMaxConcurrentRuns: 10,
        globalMaxConcurrentRuns: 10,
      },
      "AgentCappedCoder",
    );
    await seedRunningRun(companyId, agentId);

    const run = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
    });

    expect(run).not.toBeNull();
    expect((await heartbeat.getRun(run!.id))?.status).toBe("queued");
    expect(mockAdapterExecute).not.toHaveBeenCalled();
    expect(refusalReasons()).toEqual([
      "agent max concurrent runs reached (1/1)",
    ]);
  });

  it("defaults the company ceiling to 2 when unset", async () => {
    const companyId = await seedCompany("Default-company-ceiling tenant");
    // No companyMaxConcurrentRuns and no globalMaxConcurrentRuns: the agent's
    // own maxConcurrentRuns of 10 must not widen either aggregate ceiling.
    const agentId = await seedAgent(
      companyId,
      { maxConcurrentRuns: 10 },
      "DefaultCeilingCoder",
    );
    await seedRunningRun(companyId, agentId);
    await seedRunningRun(companyId, agentId);

    const run = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
    });

    expect(run).not.toBeNull();
    expect((await heartbeat.getRun(run!.id))?.status).toBe("queued");
    expect(mockAdapterExecute).not.toHaveBeenCalled();
    expect(refusalReasons()).toEqual([
      `company run cap reached (2/${HEARTBEAT_COMPANY_MAX_CONCURRENT_RUNS_DEFAULT})`,
    ]);
  });

  it("defaults the aggregate ceiling to 5 when unset", async () => {
    const companyId = await seedCompany("Default-aggregate-ceiling tenant");
    const agentId = await seedAgent(
      companyId,
      // companyMaxConcurrentRuns is explicit so only the aggregate ceiling can
      // refuse; globalMaxConcurrentRuns is left unset to exercise the default.
      { maxConcurrentRuns: 10, companyMaxConcurrentRuns: 10 },
      "DefaultAggregateCoder",
    );
    await seedRunningRun(companyId, agentId);
    await seedRunningRun(companyId, agentId);

    // Two more tenants bring the process to the default aggregate ceiling of 5
    // with 3 companies active. Fair share is ceil(5 / 3) = 2, which this
    // company already holds, so the aggregate ceiling refuses a 6th slot.
    const secondCompanyId = await seedCompany("Second tenant");
    const secondAgentId = await seedAgent(
      secondCompanyId,
      { maxConcurrentRuns: 10, companyMaxConcurrentRuns: 10 },
      "SecondCoder",
    );
    await seedRunningRun(secondCompanyId, secondAgentId);
    await seedRunningRun(secondCompanyId, secondAgentId);

    const thirdCompanyId = await seedCompany("Third tenant");
    const thirdAgentId = await seedAgent(
      thirdCompanyId,
      { maxConcurrentRuns: 10, companyMaxConcurrentRuns: 10 },
      "ThirdCoder",
    );
    await seedRunningRun(thirdCompanyId, thirdAgentId);

    const aggregateRun = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
    });
    expect(aggregateRun).not.toBeNull();
    expect((await heartbeat.getRun(aggregateRun!.id))?.status).toBe("queued");
    expect(mockAdapterExecute).not.toHaveBeenCalled();
    // The aggregate refusal names the fair-share context after the cap text, so
    // match the prefix rather than the whole reason string.
    expect(refusalReasons()).toContainEqual(
      expect.stringContaining(
        `global run cap reached (5/${HEARTBEAT_GLOBAL_MAX_CONCURRENT_RUNS_DEFAULT})`,
      ),
    );
  });



});
