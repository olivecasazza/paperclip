import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { healthRoutes } from "../routes/health.js";
import * as devServerStatus from "../dev-server-status.js";
import { resolveHotRestartIntentPath } from "../services/hot-restart.js";

const tempDirs: string[] = [];

function createDevServerStatusFile(payload: unknown) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "paperclip-health-dev-server-"));
  tempDirs.push(dir);
  const filePath = path.join(dir, "dev-server-status.json");
  writeFileSync(filePath, `${JSON.stringify(payload)}\n`, "utf8");
  return filePath;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const DEV_SERVER_TOKEN_HEADER = "X-Paperclip-Dev-Server-Status-Token";

/**
 * The persisted supervisor status a deny-direction assertion must still be
 * unable to leak. Every field here is operator/dev-runner metadata, so a
 * `devServer` block appearing on an unauthorized response is the regression
 * these cases exist to catch.
 */
const PERSISTED_DEV_SERVER_STATUS = {
  dirty: true,
  lastChangedAt: "2026-03-20T12:00:00.000Z",
  changedPathCount: 1,
  changedPathsSample: ["server/src/routes/health.ts"],
  pendingMigrations: [],
  lastRestartAt: "2026-03-20T11:30:00.000Z",
};

/**
 * Database double for the authenticated `GET /health` route. `select` is
 * call-ordered (role count, then instance settings, then active-run count)
 * because the real route composes those three queries before it decides
 * whether to project the dev-server block.
 */
function createAuthenticatedHealthDb() {
  let selectCall = 0;
  return {
    execute: vi.fn().mockResolvedValue([{ "?column?": 1 }]),
    select: vi.fn(() => {
      selectCall += 1;
      if (selectCall === 1) {
        return {
          from: vi.fn(() => ({
            where: vi.fn().mockResolvedValue([{ count: 1 }]),
          })),
        };
      }
      if (selectCall === 2) {
        return {
          from: vi.fn(() => ({
            where: vi.fn().mockResolvedValue([
              {
                id: "settings-1",
                general: {},
                experimental: { autoRestartDevServerWhenIdle: true },
                createdAt: new Date("2026-03-20T11:00:00.000Z"),
                updatedAt: new Date("2026-03-20T11:00:00.000Z"),
              },
            ]),
          })),
        };
      }
      return {
        from: vi.fn(() => ({
          where: vi.fn().mockResolvedValue([{ count: 0 }]),
        })),
      };
    }),
  } as unknown as Db;
}

function createAuthenticatedHealthApp(db: Db) {
  const app = express();
  app.use((req, _res, next) => {
    (req as any).actor = { type: "none", source: "none" };
    next();
  });
  app.use(
    "/health",
    healthRoutes(db, {
      deploymentMode: "authenticated",
      deploymentExposure: "private",
      authReady: true,
      companyDeletionEnabled: true,
      // Pin server info so the commit field is deterministic (null)
      // instead of picking up the checkout's real git metadata.
      serverInfo: {
        processStartedAt: "2026-03-20T11:00:00.000Z",
        git: { available: false, unavailableReason: "git_unavailable" },
      },
    }),
  );
  return app;
}

/**
 * Restores the two env vars the token gate reads, so each case in this file is
 * independent of the order vitest happens to run them in.
 */
function withDevServerEnv<T>(
  env: { file?: string; token?: string },
  run: () => Promise<T>,
): Promise<T> {
  const previousFile = process.env.PAPERCLIP_DEV_SERVER_STATUS_FILE;
  const previousToken = process.env.PAPERCLIP_DEV_SERVER_STATUS_TOKEN;
  if (env.file === undefined) delete process.env.PAPERCLIP_DEV_SERVER_STATUS_FILE;
  else process.env.PAPERCLIP_DEV_SERVER_STATUS_FILE = env.file;
  if (env.token === undefined) delete process.env.PAPERCLIP_DEV_SERVER_STATUS_TOKEN;
  else process.env.PAPERCLIP_DEV_SERVER_STATUS_TOKEN = env.token;

  return run().finally(() => {
    if (previousFile === undefined) {
      delete process.env.PAPERCLIP_DEV_SERVER_STATUS_FILE;
    } else {
      process.env.PAPERCLIP_DEV_SERVER_STATUS_FILE = previousFile;
    }
    if (previousToken === undefined) {
      delete process.env.PAPERCLIP_DEV_SERVER_STATUS_TOKEN;
    } else {
      process.env.PAPERCLIP_DEV_SERVER_STATUS_TOKEN = previousToken;
    }
  });
}

describe("GET /health dev-server supervisor access", () => {
  it("exposes dev-server metadata to the supervising dev runner in authenticated mode", async () => {
    await withDevServerEnv(
      {
        file: createDevServerStatusFile(PERSISTED_DEV_SERVER_STATUS),
        token: "dev-runner-token",
      },
      async () => {
        const app = createAuthenticatedHealthApp(createAuthenticatedHealthDb());

        const res = await request(app)
          .get("/health")
          .set(DEV_SERVER_TOKEN_HEADER, "dev-runner-token");

        expect(res.status).toBe(200);
        expect(res.body).toEqual({
          status: "ok",
          deploymentMode: "authenticated",
          deploymentExposure: "private",
          localAiLoginSupported: true,
          commit: null,
          bootstrapStatus: "ready",
          bootstrapInviteActive: false,
          devServer: {
            enabled: true,
            restartRequired: true,
            reason: "backend_changes",
            lastChangedAt: "2026-03-20T12:00:00.000Z",
            changedPathCount: 1,
            changedPathsSample: ["server/src/routes/health.ts"],
            pendingMigrations: [],
            autoRestartEnabled: true,
            activeRunCount: 0,
            waitingForIdle: false,
            lastRestartAt: "2026-03-20T11:30:00.000Z",
          },
        });
      },
    );
  });

  // The deny direction of `exposeDevServerDetails` (server/src/routes/health.ts).
  // `health.test.ts` cannot cover this: it mocks ../dev-server-status.js so that
  // `readPersistedDevServerStatus` returns undefined, which means the dev-server
  // key is absent no matter what the gate does. Deleting `hasDevServerStatusToken(...)`
  // from the gate would leave the existing suite fully green while exposing
  // changedPathsSample, changedPathCount, pendingMigrations, and restart timing
  // to any anonymous caller on an authenticated deployment. These cases run
  // against the real ../dev-server-status.js module with a populated status file,
  // so the block would actually project if the gate regressed.
  const DENY_DIRECTION_CASES = [
    {
      name: "omits dev-server metadata when the caller sends no status token",
      // (a) no header at all.
      sendToken: false,
      token: "dev-runner-token",
    },
    {
      name: "omits dev-server metadata when the caller sends a wrong token of the same length",
      // (b) same byte length as the expected token, so this exercises
      // timingSafeEqual itself rather than only the length pre-check.
      sendToken: true,
      token: "dev-runner-tokeN",
      envToken: "dev-runner-token",
    },
    {
      name: "omits dev-server metadata for a near-miss token of a different length",
      // (c) longer than the expected token, exercising the length pre-check
      // at routes/health.ts that keeps timingSafeEqual from throwing.
      sendToken: true,
      token: "dev-runner-token-extra",
      envToken: "dev-runner-token",
    },
    {
      name: "omits dev-server metadata when no status token is configured",
      // The supervisor is not wired up at all: the gate must not become a
      // pass-through just because the expected value is empty.
      sendToken: true,
      token: "dev-runner-token",
      envToken: undefined,
    },
    {
      name: "omits dev-server metadata for a whitespace-only status token",
      // matchesSharedToken trims both sides and rejects an empty result, so a
      // header of pure whitespace must not authorize the request.
      sendToken: true,
      token: "   ",
      envToken: "dev-runner-token",
    },
  ] as const;

  for (const testCase of DENY_DIRECTION_CASES) {
    it(testCase.name, async () => {
      const envToken =
        "envToken" in testCase ? testCase.envToken : "dev-runner-token";
      const db = createAuthenticatedHealthDb();

      await withDevServerEnv(
        {
          file: createDevServerStatusFile(PERSISTED_DEV_SERVER_STATUS),
          token: envToken,
        },
        async () => {
          const app = createAuthenticatedHealthApp(db);
          const pending = request(app).get("/health");
          if (testCase.sendToken) pending.set(DEV_SERVER_TOKEN_HEADER, testCase.token);

          const res = await pending;

          expect(res.status).toBe(200);
          // The redaction contract: no dev-server block, and none of the
          // individual fields smuggled in some other shape.
          expect(res.body).not.toHaveProperty("devServer");
          expect(res.body).toEqual({
            status: "ok",
            deploymentMode: "authenticated",
            deploymentExposure: "private",
            localAiLoginSupported: true,
            commit: null,
            bootstrapStatus: "ready",
            bootstrapInviteActive: false,
          });
          // An unauthorized caller must also not pay for the dev-server
          // queries: the gate short-circuits before the instance-settings read
          // and the active-run count, so the only select left is the
          // bootstrap role count.
          expect(db.select).toHaveBeenCalledTimes(1);
        },
      );
    });
  }

  it("omits dev-server metadata when the database is unavailable", async () => {
    // The no-db branch builds its response without reaching the dev-server
    // projection, so the gate has nothing to leak here — pinned so the
    // redacted shape stays minimal for anonymous authenticated callers.
    await withDevServerEnv(
      {
        file: createDevServerStatusFile(PERSISTED_DEV_SERVER_STATUS),
        token: "dev-runner-token",
      },
      async () => {
        const app = createAuthenticatedHealthApp(undefined as unknown as Db);

        const res = await request(app).get("/health");

        expect(res.status).toBe(200);
        expect(res.body).not.toHaveProperty("devServer");
        expect(res.body).not.toHaveProperty("serverInfo");
      },
    );
  });
});

describe("POST /health/dev-server/restart", () => {
  it("records a manual restart request for the dev runner", async () => {
    const previousFile = process.env.PAPERCLIP_DEV_SERVER_STATUS_FILE;
    const previousHome = process.env.PAPERCLIP_HOME;
    process.env.PAPERCLIP_DEV_SERVER_STATUS_FILE = createDevServerStatusFile({
      dirty: true,
      lastChangedAt: "2026-03-20T12:00:00.000Z",
      changedPathCount: 1,
      changedPathsSample: ["server/src/routes/health.ts"],
      pendingMigrations: [],
      lastRestartAt: "2026-03-20T11:30:00.000Z",
    });
    process.env.PAPERCLIP_HOME = path.dirname(
      process.env.PAPERCLIP_DEV_SERVER_STATUS_FILE,
    );

    try {
      const app = express();
      const db = {
        select: vi.fn(() => ({
          from: vi.fn(() => ({
            where: vi.fn().mockResolvedValue([]),
          })),
        })),
      } as unknown as Db;
      app.use("/health", healthRoutes(db));

      const res = await request(app).post("/health/dev-server/restart");

      expect(res.status).toBe(202);
      expect(res.body).toMatchObject({
        status: "restart_requested",
        mode: "hot",
        requestId: expect.any(String),
      });

      const requestPath = path.join(
        path.dirname(process.env.PAPERCLIP_DEV_SERVER_STATUS_FILE),
        "dev-server-restart-request.json",
      );
      expect(existsSync(requestPath)).toBe(true);
      expect(JSON.parse(readFileSync(requestPath, "utf8"))).toMatchObject({
        reason: "manual_restart_now",
        mode: "hot",
        requestId: res.body.requestId,
      });
    } finally {
      if (previousFile === undefined) {
        delete process.env.PAPERCLIP_DEV_SERVER_STATUS_FILE;
      } else {
        process.env.PAPERCLIP_DEV_SERVER_STATUS_FILE = previousFile;
      }
      if (previousHome === undefined) delete process.env.PAPERCLIP_HOME;
      else process.env.PAPERCLIP_HOME = previousHome;
    }
  });

  it("rolls back the hot intent when the supervisor request cannot be written", async () => {
    const previousFile = process.env.PAPERCLIP_DEV_SERVER_STATUS_FILE;
    const previousHome = process.env.PAPERCLIP_HOME;
    process.env.PAPERCLIP_DEV_SERVER_STATUS_FILE = createDevServerStatusFile({
      dirty: true,
      changedPathCount: 1,
      changedPathsSample: ["server/src/routes/health.ts"],
      pendingMigrations: [],
    });
    const home = mkdtempSync(path.join(os.tmpdir(), "paperclip-health-restart-home-"));
    tempDirs.push(home);
    process.env.PAPERCLIP_HOME = home;
    vi.spyOn(devServerStatus, "writeDevServerRestartRequest").mockReturnValue(false);

    try {
      const app = express();
      const db = {
        select: vi.fn(() => ({
          from: vi.fn(() => ({ where: vi.fn().mockResolvedValue([]) })),
        })),
      } as unknown as Db;
      app.use("/health", healthRoutes(db));

      const res = await request(app).post("/health/dev-server/restart");

      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: "dev_server_supervisor_unavailable" });
      expect(existsSync(resolveHotRestartIntentPath(home))).toBe(false);
    } finally {
      if (previousFile === undefined) {
        delete process.env.PAPERCLIP_DEV_SERVER_STATUS_FILE;
      } else {
        process.env.PAPERCLIP_DEV_SERVER_STATUS_FILE = previousFile;
      }
      if (previousHome === undefined) delete process.env.PAPERCLIP_HOME;
      else process.env.PAPERCLIP_HOME = previousHome;
    }
  });

  it("rejects a restart the supervisor has no reason to perform", async () => {
    // 409 restart_not_required: the persisted status is clean, so there is
    // nothing to restart and the route must refuse before touching the hot
    // intent or the supervisor request file.
    const previousFile = process.env.PAPERCLIP_DEV_SERVER_STATUS_FILE;
    const previousHome = process.env.PAPERCLIP_HOME;
    const home = mkdtempSync(path.join(os.tmpdir(), "paperclip-health-restart-clean-"));
    tempDirs.push(home);
    process.env.PAPERCLIP_DEV_SERVER_STATUS_FILE = createDevServerStatusFile({
      dirty: false,
      changedPathCount: 0,
      changedPathsSample: [],
      pendingMigrations: [],
    });
    process.env.PAPERCLIP_HOME = home;

    try {
      const app = express();
      const db = {
        select: vi.fn(() => ({
          from: vi.fn(() => ({ where: vi.fn().mockResolvedValue([]) })),
        })),
      } as unknown as Db;
      app.use("/health", healthRoutes(db));

      const res = await request(app).post("/health/dev-server/restart");

      expect(res.status).toBe(409);
      expect(res.body).toEqual({ error: "restart_not_required" });
      // Refused early: no hot intent and no supervisor request were written.
      expect(existsSync(resolveHotRestartIntentPath(home))).toBe(false);
      expect(
        existsSync(path.join(home, "dev-server-restart-request.json")),
      ).toBe(false);
      expect(db.select).not.toHaveBeenCalled();
    } finally {
      if (previousFile === undefined) {
        delete process.env.PAPERCLIP_DEV_SERVER_STATUS_FILE;
      } else {
        process.env.PAPERCLIP_DEV_SERVER_STATUS_FILE = previousFile;
      }
      if (previousHome === undefined) delete process.env.PAPERCLIP_HOME;
      else process.env.PAPERCLIP_HOME = previousHome;
    }
  });

  it("returns database_unavailable when a restart is required but there is no database", async () => {
    // 503 database_unavailable: the preflight reads in-flight runs before
    // coordinating the restart, so a missing db is a hard refusal rather than
    // a restart that would strand those runs.
    const previousFile = process.env.PAPERCLIP_DEV_SERVER_STATUS_FILE;
    const previousHome = process.env.PAPERCLIP_HOME;
    const home = mkdtempSync(path.join(os.tmpdir(), "paperclip-health-restart-nodb-"));
    tempDirs.push(home);
    process.env.PAPERCLIP_DEV_SERVER_STATUS_FILE = createDevServerStatusFile({
      dirty: true,
      changedPathCount: 1,
      changedPathsSample: ["server/src/routes/health.ts"],
      pendingMigrations: [],
    });
    process.env.PAPERCLIP_HOME = home;

    try {
      const app = express();
      app.use("/health", healthRoutes(undefined));

      const res = await request(app).post("/health/dev-server/restart");

      expect(res.status).toBe(503);
      expect(res.body).toEqual({ error: "database_unavailable" });
      expect(existsSync(resolveHotRestartIntentPath(home))).toBe(false);
      expect(
        existsSync(path.join(home, "dev-server-restart-request.json")),
      ).toBe(false);
    } finally {
      if (previousFile === undefined) {
        delete process.env.PAPERCLIP_DEV_SERVER_STATUS_FILE;
      } else {
        process.env.PAPERCLIP_DEV_SERVER_STATUS_FILE = previousFile;
      }
      if (previousHome === undefined) delete process.env.PAPERCLIP_HOME;
      else process.env.PAPERCLIP_HOME = previousHome;
    }
  });

  it("rejects unauthenticated manual restarts in authenticated mode", async () => {
    const previousFile = process.env.PAPERCLIP_DEV_SERVER_STATUS_FILE;
    process.env.PAPERCLIP_DEV_SERVER_STATUS_FILE = createDevServerStatusFile({
      dirty: true,
      changedPathCount: 1,
      changedPathsSample: ["server/src/routes/health.ts"],
      pendingMigrations: [],
    });

    try {
      const app = express();
      app.use((req, _res, next) => {
        (req as any).actor = { type: "none", source: "none" };
        next();
      });
      app.use(
        "/health",
        healthRoutes(undefined, {
          deploymentMode: "authenticated",
          deploymentExposure: "private",
          authReady: true,
          companyDeletionEnabled: true,
        }),
      );

      const res = await request(app).post("/health/dev-server/restart");

      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: "board_access_required" });
    } finally {
      if (previousFile === undefined) {
        delete process.env.PAPERCLIP_DEV_SERVER_STATUS_FILE;
      } else {
        process.env.PAPERCLIP_DEV_SERVER_STATUS_FILE = previousFile;
      }
    }
  });
});
