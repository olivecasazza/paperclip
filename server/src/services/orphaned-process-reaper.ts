import { readFile, readdir } from "node:fs/promises";
import type { Db } from "@paperclipai/db";
import { heartbeatRuns } from "@paperclipai/db";
import { inArray } from "drizzle-orm";

// The durable backstop for run-spawned processes that outlive their run.
//
// A run's process is launched detached so its process group can be killed as a
// unit on failure. That group kill is not sufficient: a grandchild that calls
// `setsid` (or is reparented after its parent exits) leaves the recorded group,
// is adopted by pid 1, and keeps drawing on the pod's shared `cpu.max` budget
// forever. The run row is already terminal, so nothing in the normal lifecycle
// will ever look at that pid again.
//
// This reaper does not depend on the group kill being correct. It reconciles
// the other way round: it reads every process in the pod that still carries a
// `PAPERCLIP_RUN_ID`, and terminates the ones whose run row is already terminal.
//
// Safety rules, in order:
//   1. A process is reaped only when its run row is *confirmed* terminal. An
//      unknown run id, a missing row, or a live status leaves it alone. This is
//      what keeps a live long-running agent from being killed mid-work.
//   2. pid 1 and the current server process are never reaped.
//   3. A run that finished inside the grace window is left alone, so a process
//      that is still winding down after its row was marked terminal is not
//      killed out from under its own cleanup.
//
// It is tenant-agnostic by construction: it keys only on the run row, and it
// never needs to know which company a process belongs to. Every reap is logged
// with pid, run id, company id, and cumulative CPU so the decision is auditable.

/** A process in this pod that still carries a `PAPERCLIP_RUN_ID`. */
export interface RunBoundProcess {
  pid: number;
  runId: string;
  /** Cumulative CPU time in milliseconds, when the platform exposes it. */
  cpuMs?: number | null;
  command?: string | null;
}

/** The run-row facts the reaper needs to decide. */
export interface RunTerminalInfo {
  status: string;
  finishedAt: Date | null;
  companyId: string | null;
}

/** Run statuses that mean the run is over and its processes must not survive. */
export const TERMINAL_RUN_STATUSES = [
  "succeeded",
  "interrupted",
  "failed",
  "cancelled",
  "timed_out",
] as const;

const TERMINAL_RUN_STATUS_SET = new Set<string>(TERMINAL_RUN_STATUSES);

export function isTerminalRunStatus(status: string): boolean {
  return TERMINAL_RUN_STATUS_SET.has(status);
}

// A run that finished this recently may still be tearing down its own children.
// The reaper is a backstop, not a race, so it waits before acting.
export const DEFAULT_REAP_GRACE_MS = 5 * 60 * 1000;

export interface OrphanedProcessReaperDeps {
  listRunBoundProcesses: () => Promise<RunBoundProcess[]> | RunBoundProcess[];
  getRunTerminalInfo: (
    runIds: string[],
  ) => Promise<Map<string, RunTerminalInfo>> | Map<string, RunTerminalInfo>;
  terminate: (pid: number, signal: NodeJS.Signals) => void;
  /** pids that must never be signalled. Defaults to pid 1 and the server pid. */
  protectedPids?: () => Set<number>;
  graceMs?: number;
  now?: () => number;
  log?: (line: string, fields?: Record<string, unknown>) => void;
}

export interface OrphanedProcessReapResult {
  /** Processes carrying a run id that the reaper considered this sweep. */
  scanned: number;
  /** Processes terminated because their run row was confirmed terminal. */
  reaped: number;
  /** Processes left alone because their run row is not confirmed terminal. */
  skippedLive: number;
  /** Processes left alone because they are inside the grace window. */
  skippedGrace: number;
  /** Processes left alone because they are protected pids. */
  skippedProtected: number;
  /** Processes the terminate call could not signal (already gone, EPERM). */
  failed: number;
}

/**
 * Builds the reaper. One sweep reconciles every run-bound process in the pod
 * against the run rows and terminates the confirmed-orphaned ones.
 */
export function createOrphanedProcessReaper(deps: OrphanedProcessReaperDeps) {
  const now = deps.now ?? Date.now;
  const graceMs = deps.graceMs ?? DEFAULT_REAP_GRACE_MS;
  const protectedPids =
    deps.protectedPids ?? (() => new Set<number>([1, process.pid]));

  async function sweep(): Promise<OrphanedProcessReapResult> {
    const result: OrphanedProcessReapResult = {
      scanned: 0,
      reaped: 0,
      skippedLive: 0,
      skippedGrace: 0,
      skippedProtected: 0,
      failed: 0,
    };

    const processes = await deps.listRunBoundProcesses();
    if (processes.length === 0) return result;

    const runIds = [...new Set(processes.map((entry) => entry.runId))];
    const runInfo = await deps.getRunTerminalInfo(runIds);
    const protectedSet = protectedPids();
    const cutoff = now() - graceMs;

    for (const entry of processes) {
      result.scanned += 1;

      if (protectedSet.has(entry.pid)) {
        result.skippedProtected += 1;
        continue;
      }

      const info = runInfo.get(entry.runId);
      if (!info || !isTerminalRunStatus(info.status)) {
        // The run row is authoritative. Unknown or live means leave it alone.
        result.skippedLive += 1;
        continue;
      }

      const finishedAt = info.finishedAt ? info.finishedAt.getTime() : null;
      if (finishedAt === null || finishedAt > cutoff) {
        result.skippedGrace += 1;
        continue;
      }

      try {
        deps.terminate(entry.pid, "SIGKILL");
        result.reaped += 1;
        deps.log?.("reaped orphaned run process", {
          pid: entry.pid,
          runId: entry.runId,
          companyId: info.companyId,
          runStatus: info.status,
          finishedAt: info.finishedAt?.toISOString() ?? null,
          cpuMs: entry.cpuMs ?? null,
        });
      } catch {
        // ESRCH (already gone) and EPERM (not ours) both mean "no action
        // taken"; the next sweep re-checks. Never let one pid abort the sweep.
        result.failed += 1;
      }
    }

    return result;
  }

  return { sweep };
}

export type OrphanedProcessReaper = ReturnType<typeof createOrphanedProcessReaper>;

// ---------------------------------------------------------------------------
// Linux /proc discovery.
// ---------------------------------------------------------------------------

/**
 * Reads every process in this pod whose environment still carries a
 * `PAPERCLIP_RUN_ID`. Returns an empty list on platforms without /proc, so the
 * reaper is a no-op rather than an error off Linux.
 */
export async function listRunBoundProcessesFromProc(
  procRoot = "/proc",
): Promise<RunBoundProcess[]> {
  if (process.platform !== "linux") return [];

  let entries: string[];
  try {
    entries = await readdir(procRoot);
  } catch {
    return [];
  }

  const found: RunBoundProcess[] = [];
  await Promise.all(
    entries
      .filter((name) => /^\d+$/.test(name))
      .map(async (name) => {
        const pid = Number(name);
        const runId = await readRunIdFromEnviron(procRoot, pid);
        if (!runId) return;
        found.push({
          pid,
          runId,
          cpuMs: await readCumulativeCpuMs(procRoot, pid),
          command: await readCommand(procRoot, pid),
        });
      }),
  );

  return found;
}

async function readRunIdFromEnviron(
  procRoot: string,
  pid: number,
): Promise<string | null> {
  try {
    const raw = await readFile(`${procRoot}/${pid}/environ`, "utf8");
    for (const pair of raw.split("\0")) {
      if (pair.startsWith("PAPERCLIP_RUN_ID=")) {
        const value = pair.slice("PAPERCLIP_RUN_ID=".length).trim();
        return value.length > 0 ? value : null;
      }
    }
  } catch {
    // The process exited between readdir and read, or is not readable. Both
    // mean "no run id to act on".
  }
  return null;
}

async function readCumulativeCpuMs(
  procRoot: string,
  pid: number,
): Promise<number | null> {
  try {
    const stat = await readFile(`${procRoot}/${pid}/stat`, "utf8");
    // Field 14 is utime, 15 is stime, in clock ticks. The comm field (2) may
    // contain spaces and parentheses, so parse from the last ")".
    const close = stat.lastIndexOf(")");
    if (close === -1) return null;
    const fields = stat.slice(close + 2).trim().split(/\s+/);
    const utime = Number(fields[11]);
    const stime = Number(fields[12]);
    if (!Number.isFinite(utime) || !Number.isFinite(stime)) return null;
    const ticksPerSecond = 100; // USER_HZ on Linux for this workload.
    return ((utime + stime) / ticksPerSecond) * 1000;
  } catch {
    return null;
  }
}

async function readCommand(
  procRoot: string,
  pid: number,
): Promise<string | null> {
  try {
    const raw = await readFile(`${procRoot}/${pid}/cmdline`, "utf8");
    const command = raw.split("\0").join(" ").trim();
    return command.length > 0 ? command.slice(0, 200) : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// The production runtime binding.
// ---------------------------------------------------------------------------

export interface ProductionOrphanedProcessReaperDeps {
  db: Db;
  log?: (line: string, fields?: Record<string, unknown>) => void;
  graceMs?: number;
}

/**
 * Builds the production reaper. It discovers run-bound processes from /proc and
 * reads terminal facts from `heartbeat_runs`, so it never depends on the
 * process-group kill having been correct.
 */
export function createProductionOrphanedProcessReaper(
  deps: ProductionOrphanedProcessReaperDeps,
): OrphanedProcessReaper {
  return createOrphanedProcessReaper({
    listRunBoundProcesses: () => listRunBoundProcessesFromProc(),
    getRunTerminalInfo: async (runIds) => {
      const map = new Map<string, RunTerminalInfo>();
      if (runIds.length === 0) return map;
      const rows = await (deps.db as any)
        .select({
          id: heartbeatRuns.id,
          status: heartbeatRuns.status,
          finishedAt: heartbeatRuns.finishedAt,
          companyId: heartbeatRuns.companyId,
        })
        .from(heartbeatRuns)
        .where(inArray(heartbeatRuns.id, runIds));
      for (const row of rows) {
        map.set(row.id, {
          status: row.status,
          finishedAt: row.finishedAt ? new Date(row.finishedAt) : null,
          companyId: row.companyId ?? null,
        });
      }
      return map;
    },
    terminate: (pid, signal) => {
      process.kill(pid, signal);
    },
    graceMs: deps.graceMs,
    log: deps.log,
  });
}
