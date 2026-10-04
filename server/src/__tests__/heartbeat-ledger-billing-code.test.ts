import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { companies, issues, projects, type heartbeatRuns } from "@paperclipai/db";
import { resolveLedgerScopeForRun } from "../services/heartbeat.ts";
import {
  describeEmbeddedPostgres,
  useEmbeddedPostgres,
} from "./helpers/route-test-harness.ts";

type Run = typeof heartbeatRuns.$inferSelect;

/**
 * The ledger scope is the only place a run's cost is attributed to a billing
 * code, and the attribution is tenant-scoped. These cases run against real
 * Postgres with two companies seeded so that dropping the `companyId` clause
 * from the production query leaks another tenant's `billingCode` and fails the
 * suite. A mock that ignores its predicate cannot express that regression.
 */
describeEmbeddedPostgres("resolveLedgerScopeForRun billing code propagation", () => {
  const pg = useEmbeddedPostgres("paperclip-ledger-billing-code-");

  async function seedIssue(input: {
    companyId: string;
    billingCode: string | null;
    projectId?: string | null;
  }) {
    const id = randomUUID();
    await pg.db.insert(issues).values({
      id,
      companyId: input.companyId,
      title: `ledger scope fixture ${id}`,
      billingCode: input.billingCode,
      projectId: input.projectId ?? null,
    });
    return id;
  }

  async function seedCompany(name: string) {
    const id = randomUUID();
    await pg.db.insert(companies).values({
      id,
      name: `${name} ${id}`,
      issuePrefix: `T${id.replaceAll("-", "").slice(0, 6).toUpperCase()}`,
    });
    return id;
  }

  function makeRun(contextSnapshot: Record<string, unknown>): Run {
    return { id: "run-1", contextSnapshot } as unknown as Run;
  }

  async function seedProject(companyId: string) {
    const id = randomUUID();
    await pg.db.insert(projects).values({
      id,
      companyId,
      name: `ledger scope project ${id}`,
    });
    return id;
  }

  it("carries the issue's billing code onto the ledger scope", async () => {
    const companyId = await seedCompany("owner");
    const projectId = await seedProject(companyId);
    const issueId = await seedIssue({
      companyId,
      billingCode: "ACME-42",
      projectId,
    });

    const scope = await resolveLedgerScopeForRun(
      pg.db,
      companyId,
      makeRun({ issueId, projectId: "context-project" }),
    );

    expect(scope).toEqual({
      issueId,
      projectId,
      billingCode: "ACME-42",
    });
  });

  it("resolves a null billing code when the issue has none set", async () => {
    const companyId = await seedCompany("no-code");
    const issueId = await seedIssue({ companyId, billingCode: null });

    const scope = await resolveLedgerScopeForRun(
      pg.db,
      companyId,
      makeRun({ issueId, projectId: "context-project" }),
    );

    expect(scope.billingCode).toBeNull();
    expect(scope.issueId).toBe(issueId);
  });

  it("resolves a null billing code without querying when the run has no issue in context", async () => {
    const companyId = await seedCompany("no-issue");

    const scope = await resolveLedgerScopeForRun(
      pg.db,
      companyId,
      makeRun({ projectId: "context-project" }),
    );

    expect(scope).toEqual({
      issueId: null,
      projectId: "context-project",
      billingCode: null,
    });
  });

  it("resolves a null billing code when the issue is not visible to the company", async () => {
    const otherCompanyId = await seedCompany("other");
    const requestingCompanyId = await seedCompany("requesting");
    // A real issue row owned by another tenant, with a billing code that must
    // never appear on this run's ledger scope.
    const otherCompanyIssueId = await seedIssue({
      companyId: otherCompanyId,
      billingCode: "OTHER-TENANT-99",
    });

    const scope = await resolveLedgerScopeForRun(
      pg.db,
      requestingCompanyId,
      makeRun({ issueId: otherCompanyIssueId, projectId: "context-project" }),
    );

    expect(scope).toEqual({
      issueId: null,
      projectId: "context-project",
      billingCode: null,
    });
    expect(scope.billingCode).not.toBe("OTHER-TENANT-99");
  });
});