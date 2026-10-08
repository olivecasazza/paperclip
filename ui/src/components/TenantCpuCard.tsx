import type { TenantCpuReport, TenantCpuRollup } from "@paperclipai/shared";
import { Cpu } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * Per-tenant CPU attribution beside the per-company spend rollups.
 *
 * The control-plane pod's `cpu.max` is a cross-tenant budget, so this company's
 * CPU share is only interpretable next to the quota it draws on and the tenants
 * it shares that quota with. Observability only: nothing here gates work, and the
 * numbers are a live sample, not a historical total.
 */

function formatCpuSeconds(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0s";
  if (seconds < 90) return `${Math.round(seconds)}s`;
  if (seconds < 5400) return `${Math.round(seconds / 60)}m`;
  return `${(seconds / 3600).toFixed(1)}h`;
}

function quotaLabel(report: TenantCpuReport): string | null {
  const max = report.cgroupCpuMax;
  if (!max) return null;
  if (max.quotaCores == null) return "Unlimited quota";
  return `${max.quotaCores.toFixed(2)} core quota shared by every tenant`;
}

function throttlingLabel(report: TenantCpuReport): string | null {
  const stats = report.cgroupThrottling;
  if (!stats || stats.nrThrottled == null || stats.nrPeriods == null || stats.nrPeriods === 0) {
    return null;
  }
  const percent = ((stats.nrThrottled / stats.nrPeriods) * 100).toFixed(1);
  return `${stats.nrThrottled.toLocaleString()} of ${stats.nrPeriods.toLocaleString()} periods throttled (${percent}%)`;
}

export function TenantCpuCard({
  report,
  isLoading = false,
  error = null,
}: {
  report?: TenantCpuReport;
  isLoading?: boolean;
  error?: unknown;
}) {
  // A failed /proc read is a missing reading, not zero CPU. Saying "0s" here would
  // claim the tenant used no CPU when the truth is the sample could not be taken.
  if (error) {
    return (
      <Card>
        <CardHeader className="px-5 pt-5 pb-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <Cpu className="size-4" aria-hidden />
            Per-tenant CPU
          </CardTitle>
          <CardDescription>CPU attribution for this company</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-destructive">{(error as Error).message}</p>
        </CardContent>
      </Card>
    );
  }

  const own: TenantCpuRollup | undefined = report?.tenants.find(
    (tenant: TenantCpuRollup) => tenant.companyId === report?.scopeCompanyId,
  );
  const quota = report ? quotaLabel(report) : null;
  const throttling = report ? throttlingLabel(report) : null;

  return (
    <Card>
      <CardHeader className="px-5 pt-5 pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <Cpu className="size-4" aria-hidden />
          Per-tenant CPU
        </CardTitle>
        <CardDescription>
          {quota ? `${quota} · observability only, gates nothing` : "CPU attribution for this company · observability only, gates nothing"}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Sampling run processes…</p>
        ) : !report || !own || own.trackedRunCount === 0 ? (
          <p className="text-sm text-muted-foreground">
            No unfinished runs with a live process in this pod right now.
          </p>
        ) : (
          <>
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className="text-2xl font-semibold text-foreground">
                {formatCpuSeconds(own.cpuSeconds)}
              </span>
              <span className="text-sm text-muted-foreground">
                across {own.trackedRunCount} run{own.trackedRunCount === 1 ? "" : "s"}
                {own.liveRunCount > 0 ? ` · ${own.liveRunCount} still running` : ""}
              </span>
            </div>
            {report.tenants.length > 1 ? (
              <p className="text-sm text-muted-foreground">
                {own.sharePercent.toFixed(1)}% of tracked pod CPU across{" "}
                {report.tenants.length} tenants
              </p>
            ) : null}
            {own.missingPidCount > 0 ? (
              <p className="text-sm text-muted-foreground">
                {own.missingPidCount} run{own.missingPidCount === 1 ? "" : "s"} skipped: process
                already exited
              </p>
            ) : null}
            {own.recycledPidCount > 0 ? (
              <p className="text-sm text-muted-foreground">
                {own.recycledPidCount} skipped: recorded pid now belongs to a different process
              </p>
            ) : null}
            {report.procUnavailable ? (
              <p className="text-sm text-muted-foreground">
                Process stats unavailable on this host, so no CPU could be sampled.
              </p>
            ) : null}
            {throttling ? (
              <p className="text-sm text-muted-foreground">
                Pod cgroup: {throttling}. Attribution shows whose demand, not who caused it.
              </p>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}