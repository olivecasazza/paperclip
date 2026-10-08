/**
 * Per-tenant CPU attribution for the shared control-plane pod.
 *
 * The pod's cgroup quota is a cross-tenant budget: every company's agent workers
 * draw on the same `cpu.max`. Until CPU is attributed per tenant, an aggregate
 * CPU reading cannot be traced to a tenant. These types describe the rollup that
 * buckets live run CPU by `company_id`, alongside the per-company token/cost
 * rollups in `cost_events`.
 *
 * Observability only: nothing here gates, throttles, or rejects work.
 */

/** The cgroup quota this pod draws on, for context on a CPU share. */
export interface TenantCpuQuota {
  /** `cpu.max` quota in cores; null when the cgroup is unlimited. */
  quotaCores: number | null;
  /** `cpu.max` period in ms. */
  periodMs: number | null;
}

/** Cumulative cgroup throttling counters. */
export interface TenantCpuThrottling {
  usageUsec: number | null;
  nrPeriods: number | null;
  nrThrottled: number | null;
  throttledUsec: number | null;
}

/** One tenant's row of the per-tenant CPU rollup. */
export interface TenantCpuRollup {
  companyId: string;
  companyName: string | null;
  /** Unfinished runs in this pod carrying a `process_pid`. */
  trackedRunCount: number;
  /** Tracked runs whose pid yielded no CPU reading, so they were skipped. */
  missingPidCount: number;
  /** Cumulative CPU seconds across this tenant's tracked pids. */
  cpuSeconds: number;
  /** `cpuSeconds` as a percentage of the rollup total; 0 when the total is 0. */
  sharePercent: number;
  /** Largest single-process CPU seconds in this tenant. */
  maxRunCpuSeconds: number;
  /** Tracked runs in a non-terminal status. */
  liveRunCount: number;
  /** pids whose recorded start time did not match the live process, so skipped. */
  recycledPidCount: number;
  /** When this rollup was computed. */
  sampledAt: string;
}

/**
 * The per-tenant CPU rollup.
 *
 * `scopeCompanyId` is the company boundary it was computed under: a company id
 * for a company-scoped read (one row, its own), null for the operator-only
 * cross-tenant read (every row). `procUnavailable` means nothing could be read
 * from `/proc`, so the empty numbers are missing rather than zero.
 */
export interface TenantCpuReport {
  scopeCompanyId: string | null;
  generatedAt: string;
  tenants: TenantCpuRollup[];
  /** Sum across `tenants`; equals the caller's own CPU for a scoped read. */
  totalCpuSeconds: number;
  /** Tracked pids whose CPU read failed and were skipped rather than thrown. */
  skippedProcessCount: number;
  procUnavailable: boolean;
  cgroupCpuMax: TenantCpuQuota | null;
  cgroupThrottling: TenantCpuThrottling | null;
}

/** One tenant's row of the `/proc`-scoped census (see `pod-tenant-cpu-census.sh`). */
export interface TenantCpuCensusRow {
  companyId: string;
  processes: number;
  cpuSeconds: number;
  sharePercent: number;
}

/** The `/proc` census, for agreement checks against the census script. */
export interface TenantCpuCensus {
  scopeCompanyId: string | null;
  generatedAt: string;
  tenants: TenantCpuCensusRow[];
  totalCpuSeconds: number;
}