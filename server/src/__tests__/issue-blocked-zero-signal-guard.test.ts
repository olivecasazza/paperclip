import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import {
  createDb,
  agents,
  companies,
  goals,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const ZERO_SIGNAL_MESSAGE =
  "Entering blocked requires unresolved blockers, a pending interaction/approval, or unblockDescriptor";

describeEmbeddedPostgres("issueService blocked zero-signal guard", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed(issueStatus: "in_progress" | "blocked") {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-blocked-guard-");
    const db = createDb(tempDb.connectionString);
    const companyId = randomUUID();
    const agentId = randomUUID();
    const goalId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "GUARD",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(goals).values({
      id: goalId,
      companyId,
      title: "Guard goal",
      status: "active",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "GuardAgent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      goalId,
      title: "Guard subject",
      status: issueStatus,
      priority: "high",
      assigneeAgentId: agentId,
    });
    return { db, issueId };
  }

  it("rejects a bare service-layer transition to blocked with no blockers and no descriptor", async () => {
    const { db, issueId } = await seed("in_progress");
    const svc = issueService(db);

    // This is the exact shape `escalateDispositionRepair` used to persist.
    await expect(
      svc.update(issueId, { status: "blocked" }),
    ).rejects.toThrow(ZERO_SIGNAL_MESSAGE);

    const rows = await db
      .select({ status: issues.status })
      .from(issues)
      .then((all) => all.filter((row) => row.status === "blocked"));
    expect(rows).toHaveLength(0);
  });

  it("accepts a transition to blocked when an unblockDescriptor accompanies it", async () => {
    const { db, issueId } = await seed("in_progress");
    const svc = issueService(db);

    const updated = await svc.update(issueId, {
      status: "blocked",
      unblockDescriptor: {
        owner: "board",
        action: "Inspect the disposition-repair evidence and decide.",
      },
    });

    expect(updated?.status).toBe("blocked");
    expect(updated?.unblockDescriptor?.action).toContain("disposition-repair");
  });

  it("does not re-validate an already-blocked issue on an unrelated update", async () => {
    const { db, issueId } = await seed("blocked");
    const svc = issueService(db);

    const updated = await svc.update(issueId, { priority: "critical" });

    expect(updated?.priority).toBe("critical");
    expect(updated?.status).toBe("blocked");
  });
});