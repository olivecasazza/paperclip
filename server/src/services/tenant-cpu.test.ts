import { describe, expect, it } from "vitest";
import {
  attributeCpuRuns,
  readCgroupCpuMax,
  readCgroupThrottling,
  readProcessCpuSeconds,
  readProcessStartMs,
  type TenantCpuRunRow,
} from "./tenant-cpu.js";

// The attribution rules are the product contract here:
//   1. A company sees only its own CPU, and only its own pids are even read.
//   2. A pid that exits between the query and the read is a skip, not a throw.
//   3. A recycled pid is not the run's process, so it is not that company's CPU.
//   4. `sharePercent` is relative to the population the caller may see, so the
//      boundary is applied before the arithmetic, never as a filter afterwards.

const COMPANY_A = "2ef76513-726c-474b-a3ca-a25a77f34d8f";
const COMPANY_B = "f955b1b1-0000-4000-8000-000000000001";

function row(overrides: Partial<TenantCpuRunRow> & { id: string }): TenantCpuRunRow {
  return {
    companyId: COMPANY_A,
    agentId: "9e545e2a-ac77-40de-bb6b-9c4b5696be83",
    processPid: 100,
    processGroupId: 100,
    processStartedAt: null,
    status: "running",
    livenessState: "live",
    ...overrides,
  };
}

describe("readProcessCpuSeconds", () => {
  // utime is field 14 and stime field 15. Field 2 (comm) is parenthesised and
  // may contain spaces and parentheses, so a positional parse from the start of
  // the line silently reads the wrong numbers — the regression this pins.
  //
  // After the closing ")": fields[0] is state (field 3), so fields[11] is utime
  // and fields[12] is stime.
  function statLine(utime: number, stime: number, comm = "worker") {
    // Fields 3..13, i.e. 11 values before utime: state ppid pgrp session tty_nr
    // tpgid flags minflt cminflt majflt cmajflt. Field 2 (comm) is always
    // parenthesised in the real format.
    const before = [1234, "S", 1, 1234, 1234, 0, -1, 4194304, 0, 0, 0];
    return `1234 (${comm}) ${before.join(" ")} ${utime} ${stime} 0 0 20 0 1 0 0`;
  }

  it("sums utime and stime and converts ticks to seconds", async () => {
    const procRoot = await makeFakeProc({ "100/stat": statLine(250, 150) });
    // 400 ticks at 100Hz = 4 seconds.
    await expect(
      readProcessCpuSeconds(100, { procRoot: procRoot.path, ticksPerSecond: 100 }),
    ).resolves.toBe(4);
    await procRoot.cleanup();
  });

  it("parses correctly when comm contains spaces and parentheses", async () => {
    const procRoot = await makeFakeProc({
      "100/stat": statLine(900, 450, "my worker (nested) x"),
    });
    // utime 900 + stime 450 = 1350 ticks = 13.5 seconds.
    await expect(
      readProcessCpuSeconds(100, { procRoot: procRoot.path, ticksPerSecond: 100 }),
    ).resolves.toBe(13.5);
    await procRoot.cleanup();
  });

  it("returns null, not a throw, when the pid is gone between query and read", async () => {
    const procRoot = await makeFakeProc({});
    await expect(
      readProcessCpuSeconds(999, { procRoot: procRoot.path, ticksPerSecond: 100 }),
    ).resolves.toBeNull();
    await procRoot.cleanup();
  });

  it("returns null for a malformed or non-numeric stat line", async () => {
    const procRoot = await makeFakeProc({ "100/stat": "not a stat line" });
    await expect(
      readProcessCpuSeconds(100, { procRoot: procRoot.path, ticksPerSecond: 100 }),
    ).resolves.toBeNull();
    await procRoot.cleanup();
  });

  it("rejects a non-integer or non-positive pid without reading anything", async () => {
    await expect(readProcessCpuSeconds(0)).resolves.toBeNull();
    await expect(readProcessCpuSeconds(-1)).resolves.toBeNull();
    await expect(readProcessCpuSeconds(1.5)).resolves.toBeNull();
  });
});

describe("readProcessStartMs", () => {
  it("returns null when the pid is unreadable instead of throwing", async () => {
    const procRoot = await makeFakeProc({});
    await expect(readProcessStartMs(4242, { procRoot: procRoot.path })).resolves.toBeNull();
    await procRoot.cleanup();
  });
});

describe("attributeCpuRuns", () => {
  it("buckets CPU per company and computes shares over the visible population", async () => {
    const result = await attributeCpuRuns(
      [
        row({ id: "r1", companyId: COMPANY_A, processPid: 101 }),
        row({ id: "r2", companyId: COMPANY_A, processPid: 102 }),
        row({ id: "r3", companyId: COMPANY_B, processPid: 103 }),
      ],
      {
        readCpuSeconds: async (pid) => (pid === 101 ? 60 : pid === 102 ? 40 : 200),
      },
    );

    expect(result.scopeCompanyId).toBeNull();
    expect(result.tenants).toHaveLength(2);
    expect(result.tenants[0]).toMatchObject({
      companyId: COMPANY_B,
      cpuSeconds: 200,
      sharePercent: 66.67,
    });
    expect(result.tenants[1]).toMatchObject({
      companyId: COMPANY_A,
      cpuSeconds: 100,
      sharePercent: 33.33,
    });
    expect(result.totalCpuSeconds).toBe(300);
  });

  it("returns only the caller's company and never reads another tenant's pids", async () => {
    const readPids: number[] = [];
    const result = await attributeCpuRuns(
      [
        row({ id: "r1", companyId: COMPANY_A, processPid: 101 }),
        row({ id: "r2", companyId: COMPANY_B, processPid: 102 }),
      ],
      {
        scopeCompanyId: COMPANY_A,
        readCpuSeconds: async (pid) => {
          readPids.push(pid);
          return pid === 101 ? 30 : 999;
        },
      },
    );

    // The boundary is applied to the rows before any read, so B's pid is never
    // touched — a scoped read cannot even measure another tenant.
    expect(readPids).toEqual([101]);
    expect(result.scopeCompanyId).toBe(COMPANY_A);
    expect(result.tenants.map((tenant) => tenant.companyId)).toEqual([COMPANY_A]);
    expect(result.tenants[0]).toMatchObject({ cpuSeconds: 30, sharePercent: 100 });
  });

  it("skips a pid whose process exited rather than failing the rollup", async () => {
    const result = await attributeCpuRuns(
      [
        row({ id: "r1", processPid: 101 }),
        row({ id: "r2", processPid: 102 }),
      ],
      {
        readCpuSeconds: async (pid) => {
          if (pid === 101) return null;
          throw new Error("ESRCH");
        },
      },
    );

    expect(result.totalCpuSeconds).toBe(0);
    expect(result.skippedProcessCount).toBe(2);
    expect(result.procUnavailable).toBe(true);
    expect(result.tenants[0]).toMatchObject({
      trackedRunCount: 2,
      missingPidCount: 2,
      cpuSeconds: 0,
    });
  });

  it("skips a recycled pid so another process's CPU is not billed to this run", async () => {
    const recordedStart = new Date("2026-10-01T10:00:00.000Z");
    const result = await attributeCpuRuns(
      [row({ id: "r1", processPid: 101, processStartedAt: recordedStart })],
      {
        readCpuSeconds: async () => 999,
        // The pid was recycled: the live process started two hours later.
        readStartMs: async () => recordedStart.getTime() + 7_200_000,
      },
    );

    expect(result.totalCpuSeconds).toBe(0);
    expect(result.tenants[0]).toMatchObject({
      recycledPidCount: 1,
      missingPidCount: 0,
    });
  });

  it("keeps the sample when the recorded start time is unreadable", async () => {
    const result = await attributeCpuRuns(
      [
        row({
          id: "r1",
          processPid: 101,
          processStartedAt: new Date("2026-10-01T10:00:00.000Z"),
        }),
      ],
      {
        readCpuSeconds: async () => 12,
        readStartMs: async () => null,
      },
    );

    // An unverifiable identity is not proof of a mismatch, so the sample stands.
    expect(result.totalCpuSeconds).toBe(12);
    expect(result.tenants[0].recycledPidCount).toBe(0);
  });

  it("tracks live runs and max single-process CPU", async () => {
    const result = await attributeCpuRuns(
      [
        row({ id: "r1", processPid: 101, status: "running" }),
        row({ id: "r2", processPid: 102, status: "queued" }),
      ],
      {
        readCpuSeconds: async (pid) => (pid === 101 ? 70 : 5),
      },
    );

    expect(result.tenants[0]).toMatchObject({
      trackedRunCount: 2,
      liveRunCount: 2,
      maxRunCpuSeconds: 70,
    });
  });

  it("reports an empty rollup rather than a wrong one when no company is visible", async () => {
    const result = await attributeCpuRuns([], {});
    expect(result.tenants).toEqual([]);
    expect(result.totalCpuSeconds).toBe(0);
    expect(result.procUnavailable).toBe(false);
  });
});

describe("readCgroupCpuMax", () => {
  it("parses a cores/period quota", async () => {
    const procRoot = await makeFakeProc({ "cpu.max": "400000 100000\n" });
    await expect(readCgroupCpuMax(procRoot.path)).resolves.toEqual({
      quotaCores: 4,
      periodMs: 100_000,
    });
    await procRoot.cleanup();
  });

  it("reports an unlimited quota as null cores rather than infinity", async () => {
    const procRoot = await makeFakeProc({ "cpu.max": "max 100000\n" });
    await expect(readCgroupCpuMax(procRoot.path)).resolves.toEqual({
      quotaCores: null,
      periodMs: 100_000,
    });
    await procRoot.cleanup();
  });

  it("returns null when the cgroup files are unreadable", async () => {
    const procRoot = await makeFakeProc({});
    await expect(readCgroupCpuMax(procRoot.path)).resolves.toBeNull();
    await expect(readCgroupThrottling(procRoot.path)).resolves.toBeNull();
    await procRoot.cleanup();
  });
});

describe("readCgroupThrottling", () => {
  it("parses the cumulative throttling counters", async () => {
    const procRoot = await makeFakeProc({
      "cpu.stat": "usage_usec 1234567\nuser_usec 1000000\nnr_periods 74690\nnr_throttled 20435\nthrottled_usec 999\n",
    });
    await expect(readCgroupThrottling(procRoot.path)).resolves.toEqual({
      usageUsec: 1_234_567,
      nrPeriods: 74_690,
      nrThrottled: 20_435,
      throttledUsec: 999,
    });
    await procRoot.cleanup();
  });
});

async function makeFakeProc(files: Record<string, string>) {
  const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const root = await mkdtemp(path.join(tmpdir(), "tenant-cpu-test-"));
  for (const [name, contents] of Object.entries(files)) {
    const target = path.join(root, name);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, contents, "utf8");
  }
  return {
    // Both readers append their own filename (`/<pid>/stat`, `/cpu.max`), so the
    // fake root is returned as-is rather than a `cgroup` subdirectory.
    path: root,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}