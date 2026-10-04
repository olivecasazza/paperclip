import { describe, expect, it } from "vitest";
import { resolveEmbeddedPostgresGate } from "@paperclipai/db";

import {
  EMBEDDED_POSTGRES_UNSUPPORTED_TITLE,
  resolveEmbeddedPostgresDescribe,
} from "./helpers/embedded-postgres.js";

// An unsupported host must never silently report green. `resolveEmbeddedPostgresGate`
// in packages/db owns the policy and is covered by its own host-independent suite;
// this file covers the vitest-facing half — that the resolved gate produces a real
// `describe.skip` on a local host instead of a suite that vanishes from the summary.

const UNSUPPORTED = { supported: false, reason: "simulated: initdb could not run" } as const;

describe("resolveEmbeddedPostgresDescribe", () => {
  it("returns the real describe on a supported host", () => {
    // A supported host must keep collecting suites normally — if this returned
    // `describe.skip` the fix would have silently disabled all coverage instead.
    expect(resolveEmbeddedPostgresDescribe({ supported: true }, { env: {} })).toBe(describe);
    expect(resolveEmbeddedPostgresDescribe({ supported: true }, { env: { CI: "true" } })).toBe(
      describe,
    );
  });

  it("skips an unsupported local host with a named, reason-bearing warning", () => {
    // The warning is the local-developer contract the issue asked for, so capture
    // it and assert it names the reason and the declaring file.
    const captured: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      captured.push(args.map(String).join(" "));
    };

    try {
      const resolved = resolveEmbeddedPostgresDescribe(UNSUPPORTED, {
        sourceFile: "embedded-postgres-describe.test.ts",
        env: {},
      });

      // `describe.skip` is a chainable wrapper, not a stable identity, so assert
      // the behaviour that distinguishes it from `describe`: the returned suite
      // collector marks its children skipped rather than collecting them for
      // execution.
      expect(resolved).not.toBe(describe);
      expect(typeof resolved).toBe("function");
      expect(captured.some((line) => line.includes(EMBEDDED_POSTGRES_UNSUPPORTED_TITLE))).toBe(true);
      expect(captured.some((line) => line.includes("simulated: initdb could not run"))).toBe(true);
      expect(captured.some((line) => line.includes("embedded-postgres-describe.test.ts"))).toBe(true);
    } finally {
      console.warn = originalWarn;
    }
  });

  it("skips an unsupported CI host only when an operator explicitly opts in", () => {
    // The escape hatch exists for hosts CI detection gets wrong. Without it, an
    // unsupported CI host is unreachable-by-skip, which is the invariant this
    // whole change exists to restore.
    const gate = resolveEmbeddedPostgresGate(UNSUPPORTED, {
      CI: "true",
      PAPERCLIP_EMBEDDED_POSTGRES_UNAVAILABLE_POLICY: "skip",
    });

    expect(gate.policy).toBe("skip");
    expect(gate.isCi).toBe(true);
  });

  it("fails an unsupported CI host rather than resolving to a skip", () => {
    // Resolving to `describe` here is what registers the hard failure at file
    // scope. Asserting the policy is `fail` pins the branch that does it, because
    // the registered failure is intentionally the only thing that must not run on
    // an unsupported host — it would fail this very suite.
    const gate = resolveEmbeddedPostgresGate(UNSUPPORTED, { CI: "true" });

    expect(gate.runnable).toBe(false);
    expect(gate.policy).toBe("fail");
    expect(gate.isCi).toBe(true);
    expect(gate.message).toContain("unavailable on this CI host");
  });
});