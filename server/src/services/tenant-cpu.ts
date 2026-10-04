import { readFile, readdir, stat } from "node:fs/promises";
import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companies, heartbeatRuns } from "@paperclipai/db";
import { TERMINAL_RUN_STATUSES } from "./orphaned-process-reaper.js";

// Per-tenant CPU attribution for the shared control-plane pod.
//
// The pod is multi-tenant: one cgroup quota (`cpu.max`) backs every company's
// agent workers, so it is a cross-tenant budget that no single company controls.
// Until CPU is attributed per tenant, a passing aggregate reading cannot be
// traced to a tenant and cannot prove whose demand caused throttling.
//
// No new schema is required. `heartbeat_runs` already persists the spawned
// worker's `process_pid` plus the `company_id` it belongs to, so per-tenant CPU
// is a join of those rows against `/proc/<pid>/stat` fields 14/15 (`utime` +
// `stime`), bucketed by `company_id`.
//
// Guarantees:
//   - Observability only. Nothing here gates, throttles, or rejects a run.
//   - Degrades safely. A pid that exits between the query and the read, an
//     unreadable `/proc`, or a non-Linux host yields a skip, never a throw.
//   - No backfill. CPU is read live from `/proc`, so a company's `cpuSeconds` is
//     the CPU its tracked pids have burned so far in this pod's lifetime — not a
//     historical total, and not a share of anything a backfill would invent.
//
// Privacy: the company boundary is applied to the rows that are read, not as a
// filter after the fact. A company-scoped read touches only that company's run
// rows and returns only that company. The cross-tenant rollup is only reachable
// from a board-only route.

/** USER_HZ on Linux: `/proc/<pid>/stat` reports utime/stime in clock ticks. */
export const DEFAULT_TICKS_PER_SECOND = 100;

/** Ceiling on how many unfinished runs one sample will join against `/proc`. */
export const DEFAULT_MAX_SAMPLED_RUNS = 500;

const TERMINAL_RUN_STATUS_SET = new Set<string>(TERMINAL_RUN_STATUSES);

/**
 * Reads a pid's cumulative CPU in seconds from `/proc/<pid>/stat`.
 *
 * Returns null for every failure mode: the process exited between the query and
 * the read, `/proc` is unreadable or masked, or the line cannot be parsed. A
 * miss is a skip, never an exception — this is observability, and a vanished pid
 * must not fail the rollup.
 */
export async function readProcessCpuSeconds(
  pid: number,
  options: { procRoot?: string; ticksPerSecond?: number } = {},
): Promise<number | null> {
  const procRoot = options.procRoot ?? "/proc";
  const ticksPerSecond = options.ticksPerSecond ?? DEFAULT_TICKS_PER_SECOND;
  if (!Number.isInteger(pid) || pid <= 0) return null;

  let statText: string;
  try {
    statText = await readFile(`${procRoot}/${pid}/stat`, "utf8");
  } catch {
    return null;
  }

  // Field 2 is `comm`, which may contain spaces and parentheses, so the numeric
  // fields are parsed after the final ")". From there fields[0] is state (field
  // 3), so utime (field 14) is fields[11] and stime (field 15) is fields[12].
  const close = statText.lastIndexOf(")");
  if (close === -1) return null;
  const fields = statText.slice(close + 1).trim().split(/\s+/);
  const utime = Number(fields[11]);
  const stime = Number(fields[12]);
  if (!Number.isFinite(utime) || !Number.isFinite(stime)) return null;

  return (utime + stime) / ticksPerSecond;
}

/**
 * Reads a pid's OS start time, used to reject a recycled pid.
 *
 * A numeric pid is not an identity across containers. Without this check, a
 * long-dead run whose pid was reused by an unrelated process would bill that
 * stranger's CPU to the dead run's company.
 */
export async function readProcessStartMs(
  pid: number,
  options: { procRoot?: string } = {},
): Promise<number | null> {
  const procRoot = options.procRoot ?? "/proc";
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    // /proc/<pid> is a directory; its ctime is the process start time on Linux.
    const entry = await stat(`${procRoot}/${pid}`);
    return entry.ctimeMs;
  } catch {
    return null;
  }
}

/**
 * Reads every process in this pod carrying a `PAPERCLIP_COMPANY_ID`.
 *
 * This is the cross-tenant census `scripts/pod-tenant-cpu-census.sh` performs: it
 * attributes CPU per tenant for *every* process, including load this control
 * plane has no run row for. Returns an empty list when `/proc` cannot be read,
 * so it degrades instead of failing.
 */
export async function listPodTenantCensus(
  options: { procRoot?: string; platform?: NodeJS.Platform; ticksPerSecond?: number } = {},
): Promise<
  { pid: number; companyId: string; agentId: string | null; cpuSeconds: number | null }[]
> {
  const platform = options.platform ?? process.platform;
  if (platform !== "linux") return [];
  const procRoot = options.procRoot ?? "/proc";

  let entries: string[];
  try {
    entries = await readdir(procRoot);
  } catch {
    return [];
  }

  const found: {
    pid: number;
    companyId: string;
    agentId: string | null;
    cpuSeconds: number | null;
  }[] = [];
  await Promise.all(
    entries
      .filter((name) => /^\d+$/.test(name))
      .map(async (name) => {
        const pid = Number(name);
        const env = await readProcessEnviron(procRoot, pid);
        const companyId = env?.get("PAPERCLIP_COMPANY_ID");
        if (!companyId) return;
        found.push({
          pid,
          companyId,
          agentId: env?.get("PAPERCLIP_AGENT_ID") ?? null,
          cpuSeconds: await readProcessCpuSeconds(pid, {
            procRoot,
            ticksPerSecond: options.ticksPerSecond,
          }),
        });
      }),
  );

  return found;
}

async function readProcessEnviron(
  procRoot: string,
  pid: number,
): Promise<Map<string, string> | null> {
  try {
    const raw = await readFile(`${procRoot}/${pid}/environ`, "utf8");
    const env = new Map<string, string>();
    for (const pair of raw.split("\0")) {
      if (!pair) continue;
      const eq = pair.indexOf("=");
      if (eq <= 0) continue;
      env.set(pair.slice(0, eq), pair.slice(eq + 1));
    }
    return env;
  } catch {
    // Unreadable pids (exited, or outside this user's visibility) are skipped
    // rather than reported as errors.
    return null;
  }
}

/** Reads the pod's cgroup CPU quota, for context on the per-tenant share. */
export async function readCgroupCpuMax(
  cgroupRoot = "/sys/fs/cgroup",
): Promise<{ quotaCores: number | null; periodMs: number | null } | null> {
  try {
    const raw = await readFile(`${cgroupRoot}/cpu.max`, "utf8");
    const [quota, period] = raw.trim().split(/\s+/);
    if (!quota || !period) return null;
    const periodMs = Number(period);
    if (!Number.isFinite(periodMs) || periodMs <= 0) return null;
    if (quota === "max") return { quotaCores: null, periodMs };
    const quotaCores = Number(quota) / periodMs;
    if (!Number.isFinite(quotaCores)) return null;
    return { quotaCores, periodMs };
  } catch {
    return null;
  }
}

export interface CgroupThrottlingCounters {
  usageUsec: number | null;
  nrPeriods: number | null;
  nrThrottled: number | null;
  throttledUsec: number | null;
}

/** Reads the cgroup's cumulative throttling counters. */
export async function readCgroupThrottling(
  cgroupRoot = "/sys/fs/cgroup",
): Promise<CgroupThrottlingCounters | null> {
  try {
    const raw = await readFile(`${cgroupRoot}/cpu.stat`, "utf8");
    const counters = new Map<string, number>();
    for (const line of raw.split("\n")) {
      const [key, value] = line.trim().split(/\s+/);
      if (!key || value === undefined) continue;
      const parsed = Number(value);
      if (Number.isFinite(parsed)) counters.set(key, parsed);
    }
    return {
      usageUsec: counters.get("usage_usec") ?? null,
      nrPeriods: counters.get("nr_periods") ?? null,
      nrThrottled: counters.get("nr_throttled") ?? null,
      throttledUsec: counters.get("throttled_usec") ?? null,
    };
  } catch {
    return null;
  }
}

/** One company row of the per-tenant CPU rollup. */
export interface TenantCpuRollup {
  companyId: string;
  companyName: string | null;
  /** Unfinished runs in this pod carrying a `process_pid`. */
  trackedRunCount: number;
  /** Tracked runs whose pid yielded no CPU reading (exited, or unreadable). */
  missingPidCount: number;
  /** Cumulative CPU seconds summed across this company's tracked pids. */
  cpuSeconds: number;
  /** `cpuSeconds` / the rollup total; 0 when the total is 0. */
  sharePercent: number;
  /** Largest single-process CPU seconds in this company. */
  maxRunCpuSeconds: number;
  /** Tracked runs in a non-terminal status. */
  liveRunCount: number;
  /** pids whose recorded start time did not match the live process, so skipped. */
  recycledPidCount: number;
  /** When this rollup was computed. */
  sampledAt: string;
}

export interface TenantCpuRollupResult {
  /**
   * The company boundary this rollup was computed under: a company id for a
   * scoped read, or null for the operator-only cross-tenant read.
   */
  scopeCompanyId: string | null;
  generatedAt: string;
  /** Per-company rows, ordered by CPU descending. */
  tenants: TenantCpuRollup[];
  /** Sum across `tenents`. Equals the caller's own CPU for a scoped read. */
  totalCpuSeconds: number;
  /** Tracked pids whose CPU read failed and were skipped rather than thrown. */
  skippedProcessCount: number;
  /** True when nothing could be read, so the numbers are empty rather than wrong. */
  procUnavailable: boolean;
  /**
   * The cgroup quota this pod draws on. A share is only meaningful against the
   * budget it is a share of.
   */
  cgroupCpuMax: { quotaCores: number | null; periodMs: number | null } | null;
  /** Cumulative cgroup throttling counters. */
  cgroupThrottling: CgroupThrottlingCounters | null;
}

/** The run-row facts the rollup needs. */
export interface TenantCpuRunRow {
  id: string;
  companyId: string;
  agentId: string;
  processPid: number | null;
  processGroupId: number | null;
  processStartedAt: Date | null;
  status: string;
  livenessState: string | null;
}

export interface TenantCpuSampleOptions {
  /** Ceiling on how many unfinished runs are joined against `/proc`. */
  limit?: number;
  procRoot?: string;
  ticksPerSecond?: number;
  platform?: NodeJS.Platform;
  /** Injected for tests; defaults to a real `/proc` read. */
  readCpuSeconds?: (pid: number) => Promise<number | null>;
  /** Injected for tests; defaults to a real `/proc/<pid>` start-time read. */
  readStartMs?: (pid: number) => Promise<number | null>;
  now?: () => Date;
}

function roundCpu(seconds: number): number {
  return Math.round(seconds * 1000) / 1000;
}

/**
 * Buckets sampled CPU per company.
 *
 * Split out from the database read so the attribution rules are testable without
 * Postgres: which rows are counted, which are skipped, and how a share is
 * computed. Every read failure is a skip, never a throw.
 */
export async function attributeCpuRuns(
  rows: TenantCpuRunRow[],
  options: {
    scopeCompanyId?: string | null;
    companyNames?: Map<string, string>;
    readCpuSeconds?: (pid: number) => Promise<number | null>;
    readStartMs?: (pid: number) => Promise<number | null>;
    skipIdentityCheck?: boolean;
    now?: () => Date;
    cgroupCpuMax?: TenantCpuRollupResult["cgroupCpuMax"];
    cgroupThrottling?: TenantCpuRollupResult["cgroupThrottling"];
  } = {},
): Promise<TenantCpuRollupResult> {
  const now = options.now ?? (() => new Date());
  const sampledAt = now().toISOString();
  const readCpu =
    options.readCpuSeconds ?? ((pid: number) => readProcessCpuSeconds(pid));
  const readStartMs =
    options.readStartMs ?? ((pid: number) => readProcessStartMs(pid));

  // The boundary is applied before any read, so a scoped caller never reads
  // another company's pids.
  const inBoundary = options.scopeCompanyId
    ? rows.filter((row) => row.companyId === options.scopeCompanyId)
    : rows;

  const byCompany = new Map<string, TenantCpuRollup>();
  const ensure = (companyId: string) => {
    let bucket = byCompany.get(companyId);
    if (!bucket) {
      bucket = {
        companyId,
        companyName: options.companyNames?.get(companyId) ?? null,
        trackedRunCount: 0,
        missingPidCount: 0,
        cpuSeconds: 0,
        sharePercent: 0,
        maxRunCpuSeconds: 0,
        liveRunCount: 0,
        recycledPidCount: 0,
        sampledAt,
      };
      byCompany.set(companyId, bucket);
    }
    return bucket;
  };

  const companyIds = new Set(inBoundary.map((row) => row.companyId));
  for (const companyId of companyIds) ensure(companyId);

  let skippedProcessCount = 0;

  await Promise.all(
    inBoundary.map(async (row) => {
      const bucket = ensure(row.companyId);
      if (row.processPid == null) return;
      bucket.trackedRunCount += 1;
      if (!TERMINAL_RUN_STATUS_SET.has(row.status)) bucket.liveRunCount += 1;

      let cpuSeconds: number | null = null;
      try {
        cpuSeconds = await readCpu(row.processPid);
      } catch {
        cpuSeconds = null;
      }
      if (cpuSeconds == null) {
        bucket.missingPidCount += 1;
        skippedProcessCount += 1;
        return;
      }

      // A recycled pid is not the run's process, so its CPU is not this run's
      // CPU. An unreadable identity stays conservative and keeps the sample.
      if (row.processStartedAt && !options.skipIdentityCheck) {
        const observedStartMs = await readStartMs(row.processPid).catch(() => null);
        if (observedStartMs !== null) {
          const recordedMs = new Date(row.processStartedAt).getTime();
          if (Number.isFinite(recordedMs) && Math.abs(observedStartMs - recordedMs) > 1000) {
            bucket.recycledPidCount += 1;
            skippedProcessCount += 1;
            return;
          }
        }
      }

      bucket.cpuSeconds += cpuSeconds;
      bucket.maxRunCpuSeconds = Math.max(bucket.maxRunCpuSeconds, cpuSeconds);
    }),
  );

  const totalCpuSeconds = [...byCompany.values()].reduce(
    (sum, entry) => sum + entry.cpuSeconds,
    0,
  );
  for (const bucket of byCompany.values()) {
    bucket.cpuSeconds = roundCpu(bucket.cpuSeconds);
    bucket.maxRunCpuSeconds = roundCpu(bucket.maxRunCpuSeconds);
    bucket.sharePercent =
      totalCpuSeconds > 0
        ? Math.round((bucket.cpuSeconds / totalCpuSeconds) * 10_000) / 100
        : 0;
  }

  const tenants = [...byCompany.values()].sort(
    (left, right) =>
      right.cpuSeconds - left.cpuSeconds
      || right.trackedRunCount - left.trackedRunCount
      || left.companyId.localeCompare(right.companyId),
  );

  return {
    scopeCompanyId: options.scopeCompanyId ?? null,
    generatedAt: sampledAt,
    tenants,
    totalCpuSeconds: roundCpu(totalCpuSeconds),
    skippedProcessCount,
    procUnavailable: skippedProcessCount > 0 && tenants.every((t) => t.cpuSeconds === 0),
    cgroupCpuMax: options.cgroupCpuMax ?? null,
    cgroupThrottling: options.cgroupThrottling ?? null,
  };
}

export function tenantCpuService(db: Db) {
  /**
   * The runs whose pids may still draw on the shared quota: unfinished runs
   * carrying a `process_pid`. Bounded and newest-first so the `/proc` join stays
   * cheap on a busy pod.
   */
  async function listAttributableRuns(options: TenantCpuSampleOptions): Promise<TenantCpuRunRow[]> {
    const limit = Math.min(options.limit ?? DEFAULT_MAX_SAMPLED_RUNS, DEFAULT_MAX_SAMPLED_RUNS);
    return db
      .select({
        id: heartbeatRuns.id,
        companyId: heartbeatRuns.companyId,
        agentId: heartbeatRuns.agentId,
        processPid: heartbeatRuns.processPid,
        processGroupId: heartbeatRuns.processGroupId,
        processStartedAt: heartbeatRuns.processStartedAt,
        status: heartbeatRuns.status,
        livenessState: heartbeatRuns.livenessState,
      })
      .from(heartbeatRuns)
      .where(
        and(
          isNotNull(heartbeatRuns.processPid),
          sql`${heartbeatRuns.status} not in ${sql.join(
            TERMINAL_RUN_STATUSES.map((value) => sql`${value}`),
            sql`, `,
          )}`,
        ),
      )
      .orderBy(desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id))
      .limit(limit) as Promise<TenantCpuRunRow[]>;
  }

  async function resolveCompanyNames(companyIds: string[]): Promise<Map<string, string>> {
    const names = new Map<string, string>();
    const unique = [...new Set(companyIds)].filter(Boolean);
    if (unique.length === 0) return names;
    const rows = await db
      .select({ id: companies.id, name: companies.name })
      .from(companies)
      .where(inArray(companies.id, unique));
    for (const row of rows) names.set(row.id, row.name);
    return names;
  }

  async function readCgroupContext() {
    const [cgroupCpuMax, cgroupThrottling] = await Promise.all([
      readCgroupCpuMax().catch(() => null),
      readCgroupThrottling().catch(() => null),
    ]);
    return { cgroupCpuMax, cgroupThrottling };
  }

  function cpuReader(options: TenantCpuSampleOptions) {
    if (options.readCpuSeconds) return options.readCpuSeconds;
    return (pid: number) =>
      readProcessCpuSeconds(pid, {
        procRoot: options.procRoot,
        ticksPerSecond: options.ticksPerSecond,
      });
  }

  function startReader(options: TenantCpuSampleOptions) {
    if (options.readStartMs) return options.readStartMs;
    return (pid: number) => readProcessStartMs(pid, { procRoot: options.procRoot });
  }

  return {
    listAttributableRuns,

    /**
     * Per-company CPU attribution for one tenant, with the same access rule as
     * the per-company cost rollup: a company reads only its own row.
     */
    tenantCpu: async (companyId: string, options: TenantCpuSampleOptions = {}) => {
      const rows = await listAttributableRuns(options);
      const names = await resolveCompanyNames([companyId]);
      const context = await readCgroupContext();
      return attributeCpuRuns(rows, {
        scopeCompanyId: companyId,
        companyNames: names,
        readCpuSeconds: cpuReader(options),
        readStartMs: startReader(options),
        now: options.now,
        ...context,
      });
    },

    /**
     * Cross-tenant CPU attribution. Only a board-only route calls this: it
     * returns every company, so a company actor must never reach it.
     */
    tenantCpuAcrossCompanies: async (options: TenantCpuSampleOptions = {}) => {
      const rows = await listAttributableRuns(options);
      const names = await resolveCompanyNames(rows.map((row) => row.companyId));
      const context = await readCgroupContext();
      return attributeCpuRuns(rows, {
        companyNames: names,
        readCpuSeconds: cpuReader(options),
        readStartMs: startReader(options),
        now: options.now,
        ...context,
      });
    },

    /**
     * `/proc`-scoped census of every process carrying a company id, for
     * agreement checks against `scripts/pod-tenant-cpu-census.sh`. This is the
     * broader population the `heartbeat_runs` join only covers a subset of.
     */
    podCensus: async (
      options: { scopeCompanyId?: string | null; procRoot?: string; platform?: NodeJS.Platform; ticksPerSecond?: number } = {},
    ) => {
      const census = await listPodTenantCensus(options);
      const inBoundary = options.scopeCompanyId
        ? census.filter((entry) => entry.companyId === options.scopeCompanyId)
        : census;
      const buckets = new Map<string, { cpuSeconds: number; processes: number }>();
      for (const entry of inBoundary) {
        const bucket = buckets.get(entry.companyId) ?? { cpuSeconds: 0, processes: 0 };
        bucket.processes += 1;
        bucket.cpuSeconds += entry.cpuSeconds ?? 0;
        buckets.set(entry.companyId, bucket);
      }
      const totalCpuSeconds = [...buckets.values()].reduce((sum, b) => sum + b.cpuSeconds, 0);
      return {
        generatedAt: new Date().toISOString(),
        scopeCompanyId: options.scopeCompanyId ?? null,
        tenants: [...buckets.entries()]
          .map(([companyId, bucket]) => ({
            companyId,
            processes: bucket.processes,
            cpuSeconds: roundCpu(bucket.cpuSeconds),
            sharePercent:
              totalCpuSeconds > 0
                ? Math.round((bucket.cpuSeconds / totalCpuSeconds) * 10_000) / 100
                : 0,
          }))
          .sort((left, right) => right.cpuSeconds - left.cpuSeconds),
        totalCpuSeconds: roundCpu(totalCpuSeconds),
      };
    },
  };
}

export type TenantCpuService = ReturnType<typeof tenantCpuService>;