import fs from "node:fs";
import { describe, it } from "vitest";
import {
  getEmbeddedPostgresTestSupport,
  isEmbeddedPostgresCiHost,
  resolveEmbeddedPostgresGate,
  resolveEmbeddedPostgresUnavailablePolicy,
  type EmbeddedPostgresTestSupport,
} from "@paperclipai/db";

export {
  getEmbeddedPostgresTestSupport,
  isEmbeddedPostgresCiHost,
  resolveEmbeddedPostgresGate,
  resolveEmbeddedPostgresUnavailablePolicy,
  startEmbeddedPostgresTestDatabase,
  type EmbeddedPostgresTestDatabase,
  type EmbeddedPostgresTestSupport,
} from "@paperclipai/db";

export type EmbeddedPostgresUnavailablePolicy = "fail" | "skip";

export type EmbeddedPostgresGate = ReturnType<typeof resolveEmbeddedPostgresGate>;

/** Stable phrase so CI logs and alerts can match this condition by name. */
export const EMBEDDED_POSTGRES_UNSUPPORTED_TITLE = "embedded Postgres suites did not run";

const reportedUnsupported = new Set<string>();

function reportUnsupportedHost(
  gate: EmbeddedPostgresGate,
  sourceFile: string,
  env: NodeJS.ProcessEnv,
): void {
  const key = `${gate.policy}:${sourceFile}`;
  if (reportedUnsupported.has(key)) return;
  reportedUnsupported.add(key);

  const detail = `${gate.message} (gate declared in ${sourceFile})`;
  if (gate.policy === "skip") {
    console.warn(`[${EMBEDDED_POSTGRES_UNSUPPORTED_TITLE}] ${detail}`);
    return;
  }

  // A step-summary note keeps the cause visible in the CI job summary even when
  // the failure text is filtered out of the raw log. Best-effort by design: a
  // failed summary write must never mask the hard failure registered below.
  const stepSummaryPath = env.GITHUB_STEP_SUMMARY;
  if (stepSummaryPath) {
    try {
      fs.appendFileSync(stepSummaryPath, `::warning::${EMBEDDED_POSTGRES_UNSUPPORTED_TITLE}: ${detail}\n`);
    } catch {
      // Ignore — the failing test below is the authoritative signal.
    }
  }

  // `it` at file scope is collected as a failing test in this file, so the
  // reason appears verbatim in the run summary and the exit code is non-zero.
  it(`${EMBEDDED_POSTGRES_UNSUPPORTED_TITLE} (${sourceFile})`, () => {
    throw new Error(detail);
  });
}

/**
 * Resolves the `describe` an embedded-Postgres suite must use on this host.
 *
 * Supported host -> `describe`. Unsupported host on CI -> `describe`, plus a
 * file-scope failing test, so a CI runner that lost embedded Postgres is a hard
 * named failure instead of a silently-skipped suite. Unsupported host on a
 * local developer machine -> `describe.skip` plus a visible warning.
 */
export function resolveEmbeddedPostgresDescribe(
  support: EmbeddedPostgresTestSupport,
  options: { sourceFile?: string; env?: NodeJS.ProcessEnv } = {},
): typeof describe.skip {
  const env = options.env ?? process.env;
  const sourceFile = options.sourceFile ?? "unknown test file";
  const gate = resolveEmbeddedPostgresGate(support, env);

  if (gate.runnable) return describe;

  reportUnsupportedHost(gate, sourceFile, env);
  return gate.policy === "fail" ? describe : describe.skip;
}