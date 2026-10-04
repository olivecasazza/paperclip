import { describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { Db } from "@paperclipai/db";
import { healthRoutes } from "../routes/health.js";

vi.mock("../dev-server-status.js", () => ({
  readPersistedDevServerStatus: vi.fn().mockReturnValue(null),
  toDevServerHealthStatus: vi.fn(),
  writeDevServerRestartRequest: vi.fn(),
  removeDevServerRestartRequest: vi.fn(),
}));

const serverInfo = {
  processStartedAt: "2026-06-26T00:00:00.000Z",
  git: { available: false, unavailableReason: "git_unavailable" },
} as never;

/**
 * The real failure mode behind CON-445 is not a fast error, it is a pool that
 * cannot hand out a connection at all: `SELECT 1` waits on pool acquisition
 * until the probe's 5s budget expires. Mock the database with a promise that
 * never settles, so a handler that touches the DB hangs the way a saturated
 * pool does rather than returning promptly with an error.
 */
function createSaturatedDb() {
  const execute = vi.fn(() => new Promise<never>(() => {}));
  return { db: { execute } as unknown as Db, execute };
}

function createApp(db?: Db) {
  const app = express();
  app.use(
    "/health",
    healthRoutes(db, {
      deploymentMode: "local_trusted",
      deploymentExposure: "private",
      authReady: true,
      companyDeletionEnabled: true,
      serverInfo,
      runtimeEnv: {},
    }),
  );
  return app;
}

describe("GET /health under pool saturation", () => {
  it("serves liveness well under 500ms across a soak with no failures", async () => {
    const { db, execute } = createSaturatedDb();
    const app = createApp(db);

    const samples = 300;
    const durations: number[] = [];
    let nonOk = 0;
    let slowest = 0;

    for (let i = 0; i < samples; i += 1) {
      const startedAt = performance.now();
      const res = await request(app).get("/health");
      const elapsed = performance.now() - startedAt;
      durations.push(elapsed);
      slowest = Math.max(slowest, elapsed);
      if (res.status !== 200) nonOk += 1;
    }

    durations.sort((a, b) => a - b);
    const median = durations[Math.floor(durations.length / 2)];
    const p99 = durations[Math.floor(durations.length * 0.99)];

    // A liveness probe that never touches the database cannot be dragged past
    // its budget by pool acquisition, which is the whole point of the split.
    expect(nonOk).toBe(0);
    expect(slowest).toBeLessThan(500);
    expect(median).toBeLessThan(500);
    expect(p99).toBeLessThan(500);

    // The strongest available proof that the fix is the absence of DB work: if
    // the probe had queried, the saturated promise would have hung forever and
    // this loop would never have reached its assertions.
    expect(execute).not.toHaveBeenCalled();

    process.stderr.write(
      `[CON-445 soak] samples=${samples} median=${median.toFixed(1)}ms p99=${p99.toFixed(1)}ms max=${slowest.toFixed(1)}ms nonOk=${nonOk} dbCalls=${execute.mock.calls.length}\n`,
    );
  });

  it("reports readiness as unreachable while liveness stays 200", async () => {
    const { db } = createSaturatedDb();
    const app = createApp(db);

    // Readiness is what an orchestrator asks when it needs dependency state,
    // and it is allowed to answer with the bad news.
    const readiness = await request(app)
      .get("/health?database=required")
      .timeout({ deadline: 5_000 })
      .catch((error: Error) => error);

    // The saturated promise never settles, so readiness must not answer 200:
    // either it reports unreachable, or supertest's deadline fires. What it must
    // never do is quietly claim a healthy dependency.
    if (readiness instanceof Error) {
      expect(readiness.message).toMatch(/timeout/i);
    } else {
      expect(readiness.status).not.toBe(200);
      expect(readiness.body.database).toMatchObject({ probed: true, reachable: false });
    }
  });
});
