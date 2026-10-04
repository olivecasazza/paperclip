import type { ServerInfoSnapshot } from "@paperclipai/shared";
import { tenantSessionRecovery } from "@/lib/tenant-session-recovery";

export type DevServerHealthStatus = {
  enabled: true;
  restartRequired: boolean;
  reason: "backend_changes" | "pending_migrations" | "backend_changes_and_pending_migrations" | null;
  lastChangedAt: string | null;
  changedPathCount: number;
  changedPathsSample: string[];
  pendingMigrations: string[];
  autoRestartEnabled: boolean;
  activeRunCount: number;
  waitingForIdle: boolean;
  lastRestartAt: string | null;
};

export type CloudInstanceHealthStatus = {
  managed: true;
  managedBy: "paperclip-cloud";
  stackSlug: string | null;
  stackDisplayName?: string;
  cloudBaseUrl: string | null;
};

export type HealthStatus = {
  status: "ok";
  version?: string;
  deploymentMode?: "local_trusted" | "authenticated";
  deploymentExposure?: "private" | "public";
  localAiLoginSupported?: boolean;
  authReady?: boolean;
  bootstrapStatus?: "ready" | "bootstrap_pending";
  bootstrapInviteActive?: boolean;
  /**
   * Which contract answered. `probed: false` means the default liveness probe
   * ran and issued no database query, so a saturated pool cannot make this
   * process look dead. Absent only on a server that predates the split.
   */
  database?: {
    probed: boolean;
    reachable: boolean | null;
  };
  features?: {
    companyDeletionEnabled?: boolean;
  };
  serverInfo?: ServerInfoSnapshot;
  devServer?: DevServerHealthStatus;
  cloud?: CloudInstanceHealthStatus;
  /**
   * Settings surfaces hidden by the hosting operator (keys from the shared
   * settings-visibility registry). Absent when nothing is hidden.
   */
  hiddenSettings?: string[];
};

export const healthApi = {
  /**
   * Readiness fetch.
   *
   * The browser reads `bootstrapStatus` and `devServer`, both of which are
   * database-backed, so it opts into the readiness contract explicitly. The
   * server's default path is liveness and answers without those fields.
   */
  get: async (): Promise<HealthStatus> => {
    const res = await fetch("/api/health?database=required", {
      credentials: "include",
      headers: { Accept: "application/json" },
    });
    if (!res.ok) {
      const payload = await res.json().catch(() => null) as { error?: string } | null;
      const recovery = tenantSessionRecovery.recoverIfNeeded(res.status, payload);
      if (recovery) return recovery;
      throw new Error(payload?.error ?? `Failed to load health (${res.status})`);
    }
    return res.json();
  },
  requestDevServerRestart: async (): Promise<void> => {
    const res = await fetch("/api/health/dev-server/restart", {
      method: "POST",
      credentials: "include",
      headers: { Accept: "application/json" },
    });
    if (!res.ok) {
      const payload = await res.json().catch(() => null) as { error?: string } | null;
      const recovery = tenantSessionRecovery.recoverIfNeeded(res.status, payload);
      if (recovery) return recovery;
      throw new Error(payload?.error ?? `Failed to request restart (${res.status})`);
    }
  },
};
