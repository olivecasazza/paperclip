// @vitest-environment node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Regression for the CON-431 pool starvation. The agent overview/dashboard
// run list rendered every run for the agent with the full transcript
// projection selected, because it called heartbeatsApi.list() with no limit:
// 5,482 rows and ~15s on a drizzle pool connection (measured 2026-10-03
// against production). This pins the cap on both AgentDetail variants.
//
// It reads the source rather than rendering the page because the call sits
// inside a large component whose render tree is expensive to mount, and the
// defect is specifically "this call site omits its limit" - a fact about the
// source, not about rendered output.
const SOURCES = [
  fileURLToPath(new URL("./AgentDetail.tsx", import.meta.url)),
  fileURLToPath(new URL("./AgentDetail.production.tsx", import.meta.url)),
] as const;

const LIST_CALL = /heartbeatsApi\.list\(([^)]*)\)/;

describe("AgentDetail run list is bounded", () => {
  it.each(SOURCES)("%s passes an explicit row limit", (path) => {
    const source = readFileSync(path, "utf8");
    const calls = [...source.matchAll(new RegExp(LIST_CALL, "g"))];
    expect(calls.length).toBeGreaterThan(0);

    for (const call of calls) {
      const args = call[1] ?? "";
      expect(args, "run list call must pass a limit").toMatch(
        /AGENT_RUN_LIST_LIMIT|,\s*\d+\s*\)/,
      );
    }
  });

  it.each(SOURCES)("%s defines AGENT_RUN_LIST_LIMIT", (path) => {
    const source = readFileSync(path, "utf8");
    expect(source).toMatch(/const AGENT_RUN_LIST_LIMIT = \d+;/);
  });
});
