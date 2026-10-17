import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { companies, createDb, issueWorkProducts, issues, projects } from "@paperclipai/db";
import {
  enrichWorkProductMetadataWithDiff,
  refreshPullRequestWorkProductMetadata,
  workProductDiffSummaryFromEventPayload,
  workProductService,
} from "../services/work-products.ts";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.ts";

const postgresSupport = await getEmbeddedPostgresTestSupport();
const describeDatabase = postgresSupport.supported ? describe : describe.skip;

function createWorkProductRow(overrides: Partial<Record<string, unknown>> = {}) {
  const now = new Date("2026-03-17T00:00:00.000Z");
  return {
    id: "work-product-1",
    companyId: "company-1",
    projectId: "project-1",
    issueId: "issue-1",
    executionWorkspaceId: null,
    runtimeServiceId: null,
    type: "pull_request",
    provider: "github",
    externalId: null,
    title: "PR 1",
    url: "https://example.com/pr/1",
    status: "open",
    reviewState: "draft",
    isPrimary: true,
    healthStatus: "unknown",
    summary: null,
    metadata: null,
    createdByRunId: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("workProductService", () => {
  it("extracts runner totals and enriches work-product metadata", () => {
    const summary = workProductDiffSummaryFromEventPayload({
      schema: "paperclip.workspace.diff.v1",
      totals: { files: 3, additions: 17, deletions: 5 },
    });

    expect(summary).toEqual({ changedFiles: 3, additions: 17, deletions: 5 });
    expect(enrichWorkProductMetadataWithDiff({ repo: "paperclipai/paperclip" }, summary)).toEqual({
      repo: "paperclipai/paperclip",
      changedFiles: 3,
      additions: 17,
      deletions: 5,
    });

    const prpEvent = {
      schema: "paperclip.prp.event.v1",
      payload: { totals: { files: 2, additions: 9, deletions: 4 } },
    };
    expect(workProductDiffSummaryFromEventPayload({ prpEvent })).toEqual({
      changedFiles: 2,
      additions: 9,
      deletions: 4,
    });
    expect(workProductDiffSummaryFromEventPayload(prpEvent)).toEqual({
      changedFiles: 2,
      additions: 9,
      deletions: 4,
    });
  });

  it("refreshes pull-request state without mutating the stored work product", async () => {
    const product = createWorkProductRow({
      companyId: "company-1",
      url: "https://github.com/paperclipai/paperclip/pull/42",
      metadata: {
        repo: "paperclipai/paperclip",
        number: 42,
        additions: 17,
        deletions: 5,
        changedFiles: 3,
        state: "open",
        draft: false,
      },
    }) as any;
    const resolve = vi.fn(async () => ({
      state: "open" as const,
      workProductState: "merged" as const,
      draft: false,
      headRef: "feature/rich-cards",
      headSha: "abc123",
      baseRef: "master",
      additions: 20,
      deletions: 7,
      changedFiles: 4,
    }));

    const [refreshed] = await refreshPullRequestWorkProductMetadata([product], resolve);

    expect(resolve).toHaveBeenCalledWith("company-1", {
      host: "github.com",
      owner: "paperclipai",
      repo: "paperclip",
      number: 42,
    });
    expect(refreshed?.metadata).toMatchObject({
      state: "merged",
      draft: false,
      baseRef: "master",
      headRef: "feature/rich-cards",
      additions: 20,
      deletions: 7,
      changedFiles: 4,
    });
    expect(product.metadata.state).toBe("open");
  });

  it("resolves GitHub commit stats when runner diff events are unavailable", async () => {
    const resolveCommitDetails = vi.fn(async () => ({ additions: 13, deletions: 2, changedFiles: 3 }));
    const svc = workProductService({} as any, { resolveCommitDetails });

    await expect(svc.resolveCommitDiffSummary("company-1", {
      provider: "github",
      url: "https://github.com/paperclipai/paperclip/commit/9c12ae7b41e5",
      metadata: null,
    })).resolves.toEqual({ additions: 13, deletions: 2, changedFiles: 3 });
    expect(resolveCommitDetails).toHaveBeenCalledWith("company-1", {
      host: "github.com",
      owner: "paperclipai",
      repo: "paperclip",
      sha: "9c12ae7b41e5",
    });
  });
});

describeDatabase("workProductService primary invariant", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-work-product-primary-");
    db = createDb(database.connectionString);
  }, 30_000);

  afterAll(async () => { await database?.cleanup(); });

  async function fixture() {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Test company", issuePrefix: companyId });
    await db.insert(projects).values({ id: projectId, companyId, name: "Test project" });
    await db.insert(issues).values({ id: issueId, companyId, projectId, title: "Test issue" });
    return { companyId, projectId, issueId };
  }

  const input = { type: "pull_request", provider: "github", title: "PR", status: "open" };

  async function primaryRows(f: { companyId: string; issueId: string }, type = "pull_request") {
    return db
      .select()
      .from(issueWorkProducts)
      .where(
        and(
          eq(issueWorkProducts.companyId, f.companyId),
          eq(issueWorkProducts.issueId, f.issueId),
          eq(issueWorkProducts.type, type),
        ),
      );
  }

  async function primaryIds(f: { companyId: string; issueId: string }, type = "pull_request") {
    const rows = await primaryRows(f, type);
    return rows.filter((row) => row.isPrimary).map((row) => row.id).sort();
  }

  it("leaves exactly one primary in the issue/type group when a new primary is created", async () => {
    const f = await fixture();
    const svc = workProductService(db);

    const first = await svc.createForIssue(f.issueId, f.companyId, { ...input, title: "first", isPrimary: true });
    const second = await svc.createForIssue(f.issueId, f.companyId, { ...input, title: "second", isPrimary: true });

    expect(await primaryIds(f)).toEqual([second!.id]);
    expect(await svc.getById(first!.id)).toMatchObject({ isPrimary: false });
  });

  it("leaves exactly one primary in the company when an existing product is promoted", async () => {
    const f = await fixture();
    const svc = workProductService(db);

    const incumbent = await svc.createForIssue(f.issueId, f.companyId, { ...input, title: "incumbent", isPrimary: true });
    const challenger = await svc.createForIssue(f.issueId, f.companyId, { ...input, title: "challenger", isPrimary: false });

    const promoted = await svc.update(challenger!.id, { isPrimary: true, reviewState: "ready_for_review" });

    expect(promoted).toMatchObject({ id: challenger!.id, isPrimary: true, reviewState: "ready_for_review" });
    expect(await primaryIds(f)).toEqual([challenger!.id]);
    expect(await svc.getById(incumbent!.id)).toMatchObject({ isPrimary: false });
  });

  it("keeps a different issue/type group primary when promoting, so the demote is scoped", async () => {
    const f = await fixture();
    const otherIssueId = randomUUID();
    await db.insert(issues).values({ id: otherIssueId, companyId: f.companyId, projectId: f.projectId, title: "Other issue" });
    const svc = workProductService(db);

    const otherType = await svc.createForIssue(f.issueId, f.companyId, { ...input, type: "commit", title: "commit", isPrimary: true });
    const otherIssue = await svc.createForIssue(otherIssueId, f.companyId, { ...input, title: "other issue", isPrimary: true });
    const challenger = await svc.createForIssue(f.issueId, f.companyId, { ...input, title: "challenger", isPrimary: false });

    await svc.update(challenger!.id, { isPrimary: true });

    expect(await primaryIds(f)).toEqual([challenger!.id]);
    expect(await primaryIds(f, "commit")).toEqual([otherType!.id]);
    expect(await primaryIds({ companyId: f.companyId, issueId: otherIssueId })).toEqual([otherIssue!.id]);
  });

  // A regression that hoists the demote out of db.transaction still produces one
  // primary on success, so the count assertions above stay green. Aborting the
  // transaction is what distinguishes the two implementations.
  function abortingDatabase() {
    return new Proxy(db, {
      get(target, property, receiver) {
        if (property !== "transaction") return Reflect.get(target, property, receiver);
        return (callback: Parameters<typeof db.transaction>[0]) => target.transaction(async (tx) => {
          await callback(tx);
          throw new Error("forced transaction abort");
        });
      },
    });
  }

  it("rolls the demotion back with the insert when creating a primary aborts", async () => {
    const f = await fixture();
    const svc = workProductService(db);

    const incumbent = await svc.createForIssue(f.issueId, f.companyId, { ...input, title: "incumbent", isPrimary: true });

    await expect(
      workProductService(abortingDatabase() as typeof db).createForIssue(f.issueId, f.companyId, {
        ...input,
        title: "challenger",
        isPrimary: true,
      }),
    ).rejects.toThrow("forced transaction abort");

    expect(await primaryIds(f)).toEqual([incumbent!.id]);
  });

  it("rolls the demotion back with the promotion when a promotion aborts", async () => {
    const f = await fixture();
    const svc = workProductService(db);

    const incumbent = await svc.createForIssue(f.issueId, f.companyId, { ...input, title: "incumbent", isPrimary: true });
    const challenger = await svc.createForIssue(f.issueId, f.companyId, { ...input, title: "challenger", isPrimary: false });

    await expect(
      workProductService(abortingDatabase() as typeof db).update(challenger!.id, { isPrimary: true }),
    ).rejects.toThrow("forced transaction abort");

    expect(await primaryIds(f)).toEqual([incumbent!.id]);
    expect(await svc.getById(challenger!.id)).toMatchObject({ isPrimary: false });
  });
});
