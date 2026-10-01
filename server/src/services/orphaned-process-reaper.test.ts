import { describe, expect, it } from "vitest";
import {
  createOrphanedProcessReaper,
  isTerminalRunStatus,
  TERMINAL_RUN_STATUSES,
  type RunBoundProcess,
  type RunTerminalInfo,
} from "./orphaned-process-reaper.js";

function makeDeps(overrides: {
  processes: RunBoundProcess[];
  runs: Record<string, RunTerminalInfo>;
  graceMs?: number;
  protectedPids?: Set<number>;
  now?: number;
}) {
  const terminated: { pid: number; signal: NodeJS.Signals }[] = [];
  const logged: Record<string, unknown>[] = [];
  const reaper = createOrphanedProcessReaper({
    listRunBoundProcesses: async () => overrides.processes,
    getRunTerminalInfo: async (runIds) => {
      const map = new Map<string, RunTerminalInfo>();
      for (const id of runIds) {
        const info = overrides.runs[id];
        if (info) map.set(id, info);
      }
      return map;
    },
    terminate: (pid, signal) => {
      terminated.push({ pid, signal });
    },
    protectedPids: () => overrides.protectedPids ?? new Set([1, process.pid]),
    graceMs: overrides.graceMs,
    now: () => overrides.now ?? 0,
    log: (_line, fields) => logged.push(fields ?? {}),
  });
  return { reaper, terminated, logged };
}

// Far enough in the past to clear the default 5-minute grace window.
const finishedLongAgo = new Date(-1_000_000_000);

describe("isTerminalRunStatus", () => {
  it("treats the five terminal statuses as terminal", () => {
    for (const status of TERMINAL_RUN_STATUSES) {
      expect(isTerminalRunStatus(status)).toBe(true);
    }
  });

  it("treats live statuses as not terminal", () => {
    for (const status of ["queued", "scheduled_retry", "running"]) {
      expect(isTerminalRunStatus(status)).toBe(false);
    }
  });
});

describe("createOrphanedProcessReaper.sweep", () => {
  it("reaps a process whose run row is confirmed terminal", async () => {
    const { reaper, terminated } = makeDeps({
      processes: [{ pid: 4242, runId: "run-1" }],
      runs: {
        "run-1": {
          status: "timed_out",
          finishedAt: finishedLongAgo,
          companyId: "company-a",
        },
      },
    });

    const result = await reaper.sweep();

    expect(result.reaped).toBe(1);
    expect(terminated).toEqual([{ pid: 4242, signal: "SIGKILL" }]);
  });

  it("leaves a process alone when its run is still live", async () => {
    const { reaper, terminated } = makeDeps({
      processes: [{ pid: 4242, runId: "run-live" }],
      runs: {
        "run-live": {
          status: "running",
          finishedAt: null,
          companyId: "company-a",
        },
      },
    });

    const result = await reaper.sweep();

    expect(result.reaped).toBe(0);
    expect(result.skippedLive).toBe(1);
    expect(terminated).toEqual([]);
  });

  it("leaves a process alone when the run row is unknown", async () => {
    const { reaper, terminated } = makeDeps({
      processes: [{ pid: 4242, runId: "run-unknown" }],
      runs: {},
    });

    const result = await reaper.sweep();

    expect(result.reaped).toBe(0);
    expect(result.skippedLive).toBe(1);
    expect(terminated).toEqual([]);
  });

  it("never reaps pid 1 or the server process", async () => {
    const { reaper, terminated } = makeDeps({
      processes: [
        { pid: 1, runId: "run-1" },
        { pid: process.pid, runId: "run-1" },
      ],
      runs: {
        "run-1": {
          status: "failed",
          finishedAt: finishedLongAgo,
          companyId: "company-a",
        },
      },
    });

    const result = await reaper.sweep();

    expect(result.reaped).toBe(0);
    expect(result.skippedProtected).toBe(2);
    expect(terminated).toEqual([]);
  });

  it("leaves a process alone inside the grace window", async () => {
    const now = 1_000_000;
    const { reaper, terminated } = makeDeps({
      processes: [{ pid: 4242, runId: "run-1" }],
      runs: {
        "run-1": {
          status: "failed",
          finishedAt: new Date(now - 1000),
          companyId: "company-a",
        },
      },
      graceMs: 60_000,
      now,
    });

    const result = await reaper.sweep();

    expect(result.reaped).toBe(0);
    expect(result.skippedGrace).toBe(1);
    expect(terminated).toEqual([]);
  });

  it("reaps a process once the grace window has elapsed", async () => {
    const now = 1_000_000;
    const { reaper, terminated } = makeDeps({
      processes: [{ pid: 4242, runId: "run-1" }],
      runs: {
        "run-1": {
          status: "failed",
          finishedAt: new Date(now - 120_000),
          companyId: "company-a",
        },
      },
      graceMs: 60_000,
      now,
    });

    const result = await reaper.sweep();

    expect(result.reaped).toBe(1);
    expect(terminated).toEqual([{ pid: 4242, signal: "SIGKILL" }]);
  });

  it("treats a terminal run with no finishedAt as inside the grace window", async () => {
    const { reaper, terminated } = makeDeps({
      processes: [{ pid: 4242, runId: "run-1" }],
      runs: {
        "run-1": { status: "failed", finishedAt: null, companyId: "company-a" },
      },
    });

    const result = await reaper.sweep();

    expect(result.reaped).toBe(0);
    expect(result.skippedGrace).toBe(1);
    expect(terminated).toEqual([]);
  });

  it("continues the sweep when one pid cannot be signalled", async () => {
    const reaper = createOrphanedProcessReaper({
      listRunBoundProcesses: async () => [
        { pid: 111, runId: "run-1" },
        { pid: 222, runId: "run-2" },
      ],
      getRunTerminalInfo: async () =>
        new Map([
          [
            "run-1",
            {
              status: "failed",
              finishedAt: finishedLongAgo,
              companyId: "company-a",
            },
          ],
          [
            "run-2",
            {
              status: "failed",
              finishedAt: finishedLongAgo,
              companyId: "company-a",
            },
          ],
        ]),
      terminate: (pid) => {
        if (pid === 111) throw new Error("ESRCH");
      },
      graceMs: 0,
    });

    const result = await reaper.sweep();

    expect(result.reaped).toBe(1);
    expect(result.failed).toBe(1);
  });

  it("logs each reap with pid, run id, company and cpu", async () => {
    const { reaper, logged } = makeDeps({
      processes: [{ pid: 4242, runId: "run-1", cpuMs: 1234 }],
      runs: {
        "run-1": {
          status: "timed_out",
          finishedAt: finishedLongAgo,
          companyId: "company-a",
        },
      },
    });

    await reaper.sweep();

    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({
      pid: 4242,
      runId: "run-1",
      companyId: "company-a",
      runStatus: "timed_out",
      cpuMs: 1234,
    });
  });

  it("is tenant-agnostic: reaps across companies in one sweep", async () => {
    const { reaper, terminated } = makeDeps({
      processes: [
        { pid: 100, runId: "run-a" },
        { pid: 200, runId: "run-b" },
      ],
      runs: {
        "run-a": {
          status: "failed",
          finishedAt: finishedLongAgo,
          companyId: "company-a",
        },
        "run-b": {
          status: "cancelled",
          finishedAt: finishedLongAgo,
          companyId: "company-b",
        },
      },
    });

    const result = await reaper.sweep();

    expect(result.reaped).toBe(2);
    expect(terminated.map((entry) => entry.pid).sort()).toEqual([100, 200]);
  });

  it("reports an empty sweep when no process carries a run id", async () => {
    const { reaper } = makeDeps({ processes: [], runs: {} });

    const result = await reaper.sweep();

    expect(result).toEqual({
      scanned: 0,
      reaped: 0,
      skippedLive: 0,
      skippedGrace: 0,
      skippedProtected: 0,
      failed: 0,
    });
  });
});
