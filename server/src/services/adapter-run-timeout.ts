import type { Db } from "@paperclipai/db";
import {
  ADAPTER_RUN_TIMEOUT_SEC_ENV_KEY,
  resolveAdapterRunTimeoutPolicy,
  type AdapterExecutionTargetTimeoutPolicy,
} from "@paperclipai/adapter-utils";
import { logger } from "../middleware/logger.js";
import { instanceSettingsService } from "./instance-settings.js";

/**
 * Resolve the deployment-wide adapter run-timeout policy that the server hands
 * to every adapter invocation. This is what makes the run wall clock a single
 * company/instance value instead of N per-agent `adapterConfig.timeoutSec`
 * rows: agents that never configured a timeout inherit this one, and agents
 * that did keep winning because the per-agent value is the first rung of the
 * resolver's precedence chain.
 *
 * Layer precedence (highest first): per-agent config (resolved inside the
 * adapter), then the `adapterRunTimeoutSec` instance setting, then
 * `PAPERCLIP_ADAPTER_RUN_TIMEOUT_SEC`, then no policy at all — which keeps the
 * historical unlimited behavior for local/SSH runs instead of silently
 * time-limiting every never-configured agent.
 *
 * Fails open: a settings read error leaves the policy unset rather than
 * blocking a run, and the env layer is still honored.
 */
export async function readAdapterRunTimeoutPolicy(
  db: Db,
  env: Record<string, string | undefined> = process.env,
): Promise<AdapterExecutionTargetTimeoutPolicy | null> {
  let instanceSec: number | null = null;
  try {
    instanceSec = (await instanceSettingsService(db).getGeneral()).adapterRunTimeoutSec ?? null;
  } catch (error) {
    // Deliberately not fatal: the run still has the per-agent timeout and the
    // env-var layer, and a settings outage must not take out every run.
    logger.warn(
      { err: error },
      `failed to read the instance adapterRunTimeoutSec setting; falling back to ${ADAPTER_RUN_TIMEOUT_SEC_ENV_KEY} and per-agent config`,
    );
  }
  return resolveAdapterRunTimeoutPolicy({
    instanceSec,
    envSec: env[ADAPTER_RUN_TIMEOUT_SEC_ENV_KEY] ?? null,
  });
}
