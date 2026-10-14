import { describe, expect, it, vi } from "vitest";
import { getTableName } from "drizzle-orm";
import { collectDispositionRepairSourceState } from "./disposition-repair.js";

const companyId = "11111111-1111-4111-8111-111111111111";
const issueId = "22222222-2222-4222-8222-222222222222";
const agentId = "33333333-3333-4333-8333-333333333333";

/**
 * Every relation in `collectDispositionRepairSourceState` resolves to an empty set unless a
 * test opts in, so the assertions isolate the precedence chain itself.
 */
function stubDb(overrides: {
  blockers?: Array<{ id: string; status: string; assigneeAgentId: string | null }>;
  interactions?: Array<{ status: string; updatedAt?: Date }>;
  approvals?: Array<{ status: string; decidedAt?: Date | null }>;
} = {}) {
  const tableRows = (tableName: string) => {
    if (tableName === "issues") return [];
    if (tableName === "issue_relations") return overrides.blockers ?? [];
    if (tableName === "issue_thread_interactions") return overrides.interactions ?? [];
    // The approval query selects from issue_approvals and joins approvals for status.
    if (tableName === "issue_approvals") return overrides.approvals ?? [];
    if (tableName === "issue_work_products") return [];
    if (tableName === "heartbeat_runs") return [];
    if (tableName === "agent_wakeup_requests") return [];
    return [];
  };
  // Each `db.select(...)` starts a fresh query whose base table arrives via `from`. An
  // `innerJoin` adds a relation, but the rows belong to the base table the caller selected.
  const query = {
    from: vi.fn((table: unknown) => buildChain(table)),
    innerJoin: vi.fn(() => buildChain(null)),
    where: vi.fn(() => buildChain(null)),
    orderBy: vi.fn(() => buildChain(null)),
    limit: vi.fn(async () => []),
    for: vi.fn(() => buildChain(null)),
    then: (resolve: (value: unknown[]) => unknown) => resolve([]),
  };
  const db = {
    select: vi.fn(() => {
      let base: unknown = null;
      return {
        from: vi.fn((table: unknown) => {
          base = table;
          return buildChain(table);
        }),
        innerJoin: vi.fn(() => buildChain(base)),
        where: vi.fn(() => buildChain(base)),
        orderBy: vi.fn(() => buildChain(base)),
        limit: vi.fn(async () => (base ? tableRows(nameOf(base)) : [])),
        for: vi.fn(() => buildChain(base)),
        then: (resolve: (value: unknown[]) => unknown) =>
          resolve(base ? tableRows(nameOf(base)) : []),
      };
    }),
  };
  return db;

  function buildChain(base: unknown) {
    const rows = base ? tableRows(nameOf(base)) : [];
    const chain = {
      innerJoin: vi.fn(() => chain),
      from: vi.fn((next: unknown) => buildChain(next)),
      where: vi.fn(() => chain),
      orderBy: vi.fn(() => chain),
      limit: vi.fn(async () => rows),
      for: vi.fn(() => chain),
      then: (resolve: (value: unknown[]) => unknown) => resolve(rows),
    };
    return chain;
  }
}

function nameOf(table: unknown): string {
  try {
    return getTableName(table as never);
  } catch {
    return "";
  }
}

function makeIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: issueId,
    companyId,
    status: "blocked",
    assigneeAgentId: agentId,
    assigneeUserId: null,
    executionPolicy: null,
    executionState: null,
    monitorNextCheckAt: null,
    unblockDescriptor: null,
    ...overrides,
  };
}

const collect = (issue: Record<string, unknown>, overrides: Parameters<typeof stubDb>[0] = {}) =>
  collectDispositionRepairSourceState(stubDb(overrides) as never, { issue: makeIssue(issue) as never });

describe("disposition repair durable path precedence", () => {
  it("does not treat a self-owned unblockDescriptor on a blocked issue as a durable path", async () => {
    const state = await collect({
      unblockDescriptor: { owner: { agentId }, action: "olive installs the GitHub grant" },
    });

    expect(state.durablePathReason).toBeNull();
    expect(state.hasDurableWaitingPath).toBe(false);
  });

  it("does not let blockers short-circuit a self-owned unblockDescriptor to a durable path", async () => {
    const state = await collect(
      { unblockDescriptor: { owner: { agentId }, action: "olive installs the GitHub grant" } },
      { blockers: [{ id: "44444444-4444-4444-8444-444444444444", status: "blocked", assigneeAgentId: null }] },
    );

    expect(state.durablePathReason).toBeNull();
  });

  it("treats a human-owned unblockDescriptor with a pending interaction as durable", async () => {
    const state = await collect(
      { unblockDescriptor: { owner: "board", action: "olive approves the connection card" } },
      { interactions: [{ status: "pending", updatedAt: new Date("2026-09-28T00:00:00Z") }] },
    );

    expect(state.durablePathReason).toBe("interaction");
    expect(state.hasDurableWaitingPath).toBe(true);
  });

  it("treats a user-owned unblockDescriptor with a pending approval as durable", async () => {
    const state = await collect(
      { unblockDescriptor: { owner: { userId: "board-user" }, action: "olive approves" } },
      { approvals: [{ status: "pending", decidedAt: null }] },
    );

    expect(state.durablePathReason).toBe("approval");
  });

  it("still treats a user assignee as a durable path on a self-owned blocked issue", async () => {
    const state = await collect({
      assigneeUserId: "board-user",
      unblockDescriptor: { owner: { agentId }, action: "olive acts" },
    });

    expect(state.durablePathReason).toBe("user_owner");
  });
});
