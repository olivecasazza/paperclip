import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockProjectService = vi.hoisted(() => ({
  list: vi.fn(),
  getById: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  createWorkspace: vi.fn(),
  listWorkspaces: vi.fn(),
  updateWorkspace: vi.fn(),
  removeWorkspace: vi.fn(),
  remove: vi.fn(),
  resolveByReference: vi.fn(),
}));
const mockSecretService = vi.hoisted(() => ({
  normalizeEnvBindingsForPersistence: vi.fn(),
  syncEnvBindingsForTarget: vi.fn(),
}));
const mockEnvironmentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));
const mockWorkspaceOperationService = vi.hoisted(() => ({}));
const mockLogActivity = vi.hoisted(() => vi.fn());
const mockGetTelemetryClient = vi.hoisted(() => vi.fn());
const mockAccessService = vi.hoisted(() => ({
  decide: vi.fn(),
}));

vi.mock("../telemetry.js", () => ({
  getTelemetryClient: mockGetTelemetryClient,
}));

vi.mock("../services/index.js", () => ({
  accessService: () => mockAccessService,
  environmentService: () => mockEnvironmentService,
  logActivity: mockLogActivity,
  projectService: () => mockProjectService,
  secretService: () => mockSecretService,
  workspaceOperationService: () => mockWorkspaceOperationService,
}));

vi.mock("../services/environments.js", () => ({
  environmentService: () => mockEnvironmentService,
}));

vi.mock("../services/secrets.js", () => ({
  secretService: () => mockSecretService,
}));

vi.mock("../services/workspace-runtime.js", () => ({
  startRuntimeServicesForWorkspaceControl: vi.fn(),
  stopRuntimeServicesForProjectWorkspace: vi.fn(),
}));

function registerModuleMocks() {
  vi.doMock("../services/activity-log.js", async () => ({
    ...await vi.importActual<typeof import("../services/activity-log.js")>("../services/activity-log.js"),
    persistActivity: async (db: unknown, input: unknown) => { await mockLogActivity(db, input); return { activity: { id: "activity" }, publication: null }; },
    publishActivity: vi.fn(),
  }));
  vi.doMock("../telemetry.js", () => ({
    getTelemetryClient: mockGetTelemetryClient,
  }));

  vi.doMock("../services/index.js", () => ({
    accessService: () => mockAccessService,
    environmentService: () => mockEnvironmentService,
    logActivity: mockLogActivity,
    projectService: () => mockProjectService,
    secretService: () => mockSecretService,
    workspaceOperationService: () => mockWorkspaceOperationService,
  }));

  vi.doMock("../services/environments.js", () => ({
    environmentService: () => mockEnvironmentService,
  }));

  vi.doMock("../services/secrets.js", () => ({
    secretService: () => mockSecretService,
  }));

  vi.doMock("../services/workspace-runtime.js", () => ({
    startRuntimeServicesForWorkspaceControl: vi.fn(),
    stopRuntimeServicesForProjectWorkspace: vi.fn(),
  }));
}

async function createApp() {
  const [{ projectRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/projects.js")>("../routes/projects.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "board-user",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", projectRoutes(transactionStub));
  app.use((err: any, _req: any, res: any, next: any) => {
    capturedCrashes.push(err);
    return errorHandler(err, _req, res, next);
  });
  return app;
}

/**
 * The route hands `db` to every service. `normalizeEnvBindingsForPersistence`
 * is the load-bearing security check on this route, so the "real secret
 * service" cases below need a double that answers the `companySecrets` lookup
 * with the rows a real query would return, rather than stubbing the security
 * decision out of existence.
 *
 * A `select().from().where()` chain that ignores its predicate is the failure
 * mode this double exists to avoid: `assertSecretInCompany` filters on
 * `companyId` in SQL *and* again in JS, so a predicate-blind double silently
 * hands every company its neighbour's secrets and the cross-tenant test
 * cannot fail.
 */
type SqlPredicate = { constructor?: { name?: string }; queryChunks: unknown[] };

function isSql(value: unknown): value is SqlPredicate {
  const node = value as SqlPredicate | null;
  return node?.constructor?.name === "SQL" && Array.isArray(node.queryChunks);
}

function sqlText(predicate: SqlPredicate): string {
  return predicate.queryChunks
    .map((chunk) => {
      if (isSql(chunk)) return sqlText(chunk);
      const value = (chunk as { value?: unknown }).value;
      return Array.isArray(value) ? value.join("") : typeof value === "string" ? value : "";
    })
    .join("");
}

function matchesComparison(where: SqlPredicate, row: Record<string, unknown>): boolean {
  const column = where.queryChunks.find(
    (chunk) => (chunk as { constructor?: { name?: string } }).constructor?.name !== "StringChunk"
      && (chunk as { constructor?: { name?: string } }).constructor?.name !== "Param",
  ) as { name?: unknown } | undefined;
  const param = where.queryChunks.find(
    (chunk) => (chunk as { constructor?: { name?: string } }).constructor?.name === "Param",
  ) as { value: unknown } | undefined;
  if (!param || typeof column?.name !== "string") {
    throw new Error(`unsupported comparison predicate: ${sqlText(where)}`);
  }
  const key = column.name.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase());
  return row[key] === param.value;
}

function rowMatches(where: unknown, row: Record<string, unknown>): boolean {
  if (where === undefined) return true;
  if (!isSql(where)) throw new Error("unsupported where predicate");
  const text = sqlText(where).trim();
  const operands = where.queryChunks.filter(isSql);
  const conjunction = operands.find((operand) => /\band\b/i.test(sqlText(operand)));
  if (conjunction) {
    return conjunction.queryChunks.filter(isSql).every((operand) => rowMatches(operand, row));
  }
  const disjunction = operands.find((operand) => /\bor\b/i.test(sqlText(operand)));
  if (disjunction) {
    return disjunction.queryChunks.filter(isSql).some((operand) => rowMatches(operand, row));
  }
  if (operands.length === 0 && text.includes("=")) return matchesComparison(where, row);
  throw new Error(`unsupported where predicate: ${text}`);
}

const transactionStub = {
  transaction: async (effect: (tx: unknown) => unknown) => effect({}),
  // Real `secretService` also syncs persisted bindings back to the
  // `companySecretBindings` table after normalization. That write is a
  // follow-up effect, not the assertion target, so this double reports "the
  // secret rows were already seeded" and leaves the binding table empty.
  insert: () => ({
    values: () => ({
      onConflictDoNothing: () => Promise.resolve(undefined),
      onConflictDoUpdate: () => Promise.resolve(undefined),
      then: (onFulfilled?: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) =>
        Promise.resolve(undefined).then(onFulfilled, onRejected),
    }),
  }),
  select: (..._args: unknown[]) => {
    const query: { __where?: unknown } & Record<string, unknown> = {
      __where: undefined,
      from() { return query; },
      where(condition: unknown) { query.__where = condition; return query; },
      then(
        onFulfilled?: (value: unknown[]) => unknown,
        onRejected?: (reason: unknown) => unknown,
      ) {
        return Promise.resolve(seededSecretRows.filter((row) => rowMatches(query.__where, row)))
          .then(onFulfilled, onRejected);
      },
    };
    return query;
  },
} as any;

const OWN_COMPANY_SECRET_ID = "11111111-1111-4111-8111-111111111111";
const FOREIGN_COMPANY_SECRET_ID = "22222222-2222-4222-8222-222222222222";

function buildSecretRow(overrides: Record<string, unknown> = {}) {
  return {
    id: OWN_COMPANY_SECRET_ID,
    companyId: "company-1",
    scope: "company",
    status: "active",
    name: "Project env secret",
    key: "project-env-secret",
    provider: "local_encrypted",
    providerConfigId: null,
    managedMode: "paperclip_managed",
    description: null,
    externalRef: null,
    providerMetadata: null,
    providerVersionRef: null,
    latestVersion: 1,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

let seededSecretRows: ReturnType<typeof buildSecretRow>[] = [];

/**
 * Express reports a crashed handler as a bare `{"error":"Internal server
 * error"}`, which hides the cause. Capture it so a status assertion can print
 * the real failure instead of sending the next reader to the route source.
 */
const capturedCrashes: unknown[] = [];

function responseDiagnostic(res: request.Response) {
  return JSON.stringify({
    body: res.body,
    crashes: capturedCrashes.map((error) => {
      const err = error as { message?: string; stack?: string };
      return `${err?.message}\n${err?.stack}`;
    }),
  });
}

function buildProject(overrides: Record<string, unknown> = {}) {
  return {
    id: "project-1",
    companyId: "company-1",
    urlKey: "project-1",
    goalId: null,
    goalIds: [],
    goals: [],
    name: "Project",
    description: null,
    status: "backlog",
    leadAgentId: null,
    targetDate: null,
    color: null,
    env: null,
    pauseReason: null,
    pausedAt: null,
    executionWorkspacePolicy: null,
    codebase: {
      workspaceId: null,
      repoUrl: null,
      repoRef: null,
      defaultRef: null,
      repoName: null,
      localFolder: null,
      managedFolder: "/tmp/project",
      effectiveLocalFolder: "/tmp/project",
      origin: "managed_checkout",
    },
    workspaces: [],
    primaryWorkspace: null,
    archivedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe("project env routes", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../routes/projects.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    vi.doUnmock("../services/environments.js");
    vi.doUnmock("../services/secrets.js");
    registerModuleMocks();
    vi.clearAllMocks();
    mockAccessService.decide.mockResolvedValue({
      allowed: true,
      action: "project:read",
      reason: "allow_test",
      explanation: "Allowed by test mock.",
    });
    mockGetTelemetryClient.mockReturnValue({ track: vi.fn() });
    mockProjectService.resolveByReference.mockResolvedValue({ ambiguous: false, project: null });
    mockProjectService.createWorkspace.mockResolvedValue(null);
    mockProjectService.listWorkspaces.mockResolvedValue([]);
    mockEnvironmentService.getById.mockReset();
    mockSecretService.normalizeEnvBindingsForPersistence.mockImplementation(async (_companyId, env) => env);
    mockSecretService.syncEnvBindingsForTarget.mockResolvedValue(undefined);
    seededSecretRows = [buildSecretRow()];
    capturedCrashes.length = 0;
  });

  it("normalizes env bindings on create and logs only env keys", async () => {
    const normalizedEnv = {
      API_KEY: {
        type: "secret_ref",
        secretId: "11111111-1111-4111-8111-111111111111",
        version: "latest",
      },
    };
    mockSecretService.normalizeEnvBindingsForPersistence.mockResolvedValue(normalizedEnv);
    mockProjectService.create.mockResolvedValue(buildProject({ env: normalizedEnv }));

    const app = await createApp();
    const res = await request(app)
      .post("/api/companies/company-1/projects")
      .send({
        name: "Project",
        env: normalizedEnv,
      });

    expect([200, 201], responseDiagnostic(res)).toContain(res.status);
    expect(mockSecretService.normalizeEnvBindingsForPersistence).toHaveBeenCalledWith(
      "company-1",
      normalizedEnv,
      expect.objectContaining({ fieldPath: "env" }),
    );
    expect(mockProjectService.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({ env: normalizedEnv }),
    );

    // `expect.objectContaining` here would be a presence check: a route that
    // started writing the whole env object next to `envKeys` would still pass.
    // Pin the absence of every binding value, so a plaintext `value` landing in
    // the activity log fails here.
    expect(mockLogActivity).toHaveBeenCalledTimes(1);
    const loggedDetails = mockLogActivity.mock.calls[0]?.[1]?.details;
    expect(loggedDetails).toMatchObject({ envKeys: ["API_KEY"] });
    for (const [key, binding] of Object.entries(normalizedEnv)) {
      expect(loggedDetails, `${key} binding leaked into activity details`).not.toHaveProperty(key);
      const value = (binding as { value?: string; secretId?: string }).value
        ?? (binding as { secretId?: string }).secretId;
      expect(JSON.stringify(loggedDetails)).not.toContain(String(value));
    }
  });

  it("normalizes env bindings on update and avoids logging raw values", async () => {
    const normalizedEnv = {
      PLAIN_KEY: { type: "plain", value: "top-secret" },
    };
    mockSecretService.normalizeEnvBindingsForPersistence.mockResolvedValue(normalizedEnv);
    mockProjectService.getById.mockResolvedValue(buildProject());
    mockProjectService.update.mockResolvedValue(buildProject({ env: normalizedEnv }));

    const app = await createApp();
    const res = await request(app)
      .patch("/api/projects/project-1")
      .send({
        env: normalizedEnv,
      });

    expect(res.status, responseDiagnostic(res)).toBe(200);
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        details: {
          changedKeys: ["env"],
          envKeys: ["PLAIN_KEY"],
        },
      }),
    );
  });
});

/**
 * `normalizeEnvBindingsForPersistence` is the load-bearing security decision on
 * both the create and update paths. Everything above stubs it to an identity
 * function, which is exactly the gap these cases close: they drive the real
 * `secretService` through the real routes so a plaintext client binding is
 * proven to be rejected or canonicalised before persistence.
 */
describe("project env routes — real secretService normalization", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../routes/projects.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    vi.doUnmock("../services/environments.js");
    vi.doUnmock("../services/workspace-runtime.js");
    // The one mock that must NOT survive: the real normalization is the point.
    vi.doMock("../services/secrets.js", async () => await vi.importActual<
      typeof import("../services/secrets.js")
    >("../services/secrets.js"));
    vi.doMock("../services/index.js", () => ({
      accessService: () => mockAccessService,
      environmentService: () => mockEnvironmentService,
      logActivity: mockLogActivity,
      projectService: () => mockProjectService,
      workspaceOperationService: () => mockWorkspaceOperationService,
    }));
    vi.doMock("../services/activity-log.js", async () => ({
      ...await vi.importActual<typeof import("../services/activity-log.js")>("../services/activity-log.js"),
      persistActivity: async (db: unknown, input: unknown) => {
        await mockLogActivity(db, input);
        return { activity: { id: "activity" }, publication: null };
      },
      publishActivity: vi.fn(),
    }));
    vi.doMock("../telemetry.js", () => ({ getTelemetryClient: mockGetTelemetryClient }));
    vi.clearAllMocks();
    mockAccessService.decide.mockResolvedValue({
      allowed: true,
      action: "project:read",
      reason: "allow_test",
      explanation: "Allowed by test mock.",
    });
    mockGetTelemetryClient.mockReturnValue({ track: vi.fn() });
    mockProjectService.resolveByReference.mockResolvedValue({ ambiguous: false, project: null });
    mockProjectService.createWorkspace.mockResolvedValue(null);
    mockProjectService.listWorkspaces.mockResolvedValue([]);
    mockEnvironmentService.getById.mockReset();
    seededSecretRows = [
      buildSecretRow({ id: OWN_COMPANY_SECRET_ID }),
      // Deliberately seeded in a row whose companyId does not match: the query
      // double filters on companyId, so the service must never see this one.
      buildSecretRow({ id: FOREIGN_COMPANY_SECRET_ID, companyId: "company-2" }),
    ];
  });

  it("persists a client plaintext binding on a non-sensitive key and logs only its key", async () => {
    const plaintextEnv = { BUILD_FLAG: { type: "plain", value: "release-candidate" } };
    mockProjectService.create.mockImplementation(async (_companyId: string, data: { env?: unknown }) =>
      buildProject({ env: data.env }));

    const app = await createApp();
    const res = await request(app)
      .post("/api/companies/company-1/projects")
      .send({ name: "Project", env: plaintextEnv });

    expect([200, 201], responseDiagnostic(res)).toContain(res.status);
    // The real service canonicalised and persisted the binding — not the stub.
    expect(mockProjectService.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        env: { BUILD_FLAG: { type: "plain", value: "release-candidate" } },
      }),
    );
    const loggedDetails = mockLogActivity.mock.calls[0]?.[1]?.details;
    expect(loggedDetails).toMatchObject({ envKeys: ["BUILD_FLAG"] });
    expect(JSON.stringify(loggedDetails)).not.toContain("release-candidate");
  });

  it("rejects a cross-company secret_ref instead of persisting it", async () => {
    mockProjectService.create.mockResolvedValue(buildProject());

    const app = await createApp();
    const res = await request(app)
      .post("/api/companies/company-1/projects")
      .send({
        name: "Project",
        env: { API_KEY: { type: "secret_ref", secretId: FOREIGN_COMPANY_SECRET_ID } },
      });

    expect(res.status, responseDiagnostic(res)).toBe(422);
    expect(res.body?.error).toMatch(/same company/i);
    expect(mockProjectService.create).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("rejects a redacted placeholder on update so a masked value cannot be persisted", async () => {
    mockProjectService.getById.mockResolvedValue(buildProject());

    const app = await createApp();
    const res = await request(app)
      .patch("/api/projects/project-1")
      .send({ env: { API_KEY: { type: "plain", value: "***REDACTED***" } } });

    expect(res.status, responseDiagnostic(res)).toBe(422);
    expect(res.body?.error).toMatch(/redacted placeholder/i);
    expect(mockProjectService.update).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("rejects a client plaintext value for a sensitive key in strict secrets mode", async () => {
    const previousStrictMode = process.env.PAPERCLIP_SECRETS_STRICT_MODE;
    process.env.PAPERCLIP_SECRETS_STRICT_MODE = "true";
    mockProjectService.getById.mockResolvedValue(buildProject());
    try {
      const app = await createApp();
      const res = await request(app)
        .patch("/api/projects/project-1")
        .send({ env: { API_KEY: { type: "plain", value: "sk-live-plaintext" } } });

      expect(res.status, responseDiagnostic(res)).toBe(422);
      expect(res.body?.error).toMatch(/strict secret mode/i);
      expect(mockProjectService.update).not.toHaveBeenCalled();
      expect(mockLogActivity).not.toHaveBeenCalled();
    } finally {
      if (previousStrictMode === undefined) delete process.env.PAPERCLIP_SECRETS_STRICT_MODE;
      else process.env.PAPERCLIP_SECRETS_STRICT_MODE = previousStrictMode;
    }
  });

  it("accepts a same-company secret_ref and logs only the env key", async () => {
    mockProjectService.create.mockImplementation(async (_companyId: string, data: { env?: unknown }) =>
      buildProject({ env: data.env }));

    const app = await createApp();
    const res = await request(app)
      .post("/api/companies/company-1/projects")
      .send({
        name: "Project",
        env: { API_KEY: { type: "secret_ref", secretId: OWN_COMPANY_SECRET_ID } },
      });

    expect([200, 201], responseDiagnostic(res)).toContain(res.status);
    expect(mockProjectService.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        env: expect.objectContaining({
          API_KEY: expect.objectContaining({ type: "secret_ref", secretId: OWN_COMPANY_SECRET_ID }),
        }),
      }),
    );
    const loggedDetails = mockLogActivity.mock.calls[0]?.[1]?.details;
    expect(loggedDetails).toMatchObject({ envKeys: ["API_KEY"] });
    expect(JSON.stringify(loggedDetails)).not.toContain(OWN_COMPANY_SECRET_ID);
  });
});
