import { describe, expect, it } from "vitest";
import {
  isEmbeddedPostgresCiHost,
  resolveEmbeddedPostgresGate,
  resolveEmbeddedPostgresUnavailablePolicy,
} from "./test-embedded-postgres.js";

// This suite pins the gate that stops an embedded-Postgres test file from
// silently reporting green while executing zero cross-tenant/authz assertions.
// It is deliberately free of vitest collectors and of a real Postgres probe, so
// it runs on every host — including the unsupported hosts it exists to police.

const SUPPORTED = { supported: true } as const;
const UNSUPPORTED = { supported: false, reason: "initdb failed on this host" } as const;

describe("isEmbeddedPostgresCiHost", () => {
  it("treats an unset environment as a local host", () => {
    expect(isEmbeddedPostgresCiHost({})).toBe(false);
  });

  it("recognises each conventional CI marker", () => {
    for (const key of ["CI", "CONTINUOUS_INTEGRATION", "BUILD_NUMBER", "GITHUB_ACTIONS", "GITLAB_CI"]) {
      expect(isEmbeddedPostgresCiHost({ [key]: "true" })).toBe(true);
    }
  });

  it("does not treat falsy markers as CI", () => {
    for (const key of ["CI", "GITHUB_ACTIONS", "GITLAB_CI"]) {
      expect(isEmbeddedPostgresCiHost({ [key]: "false" })).toBe(false);
      expect(isEmbeddedPostgresCiHost({ [key]: "0" })).toBe(false);
      expect(isEmbeddedPostgresCiHost({ [key]: "" })).toBe(false);
    }
  });
});

describe("resolveEmbeddedPostgresUnavailablePolicy", () => {
  it("honours an explicit override over the CI default", () => {
    expect(
      resolveEmbeddedPostgresUnavailablePolicy(
        { CI: "true", PAPERCLIP_EMBEDDED_POSTGRES_UNAVAILABLE_POLICY: "skip" },
        { defaultPolicy: "fail" },
      ),
    ).toBe("skip");
  });

  it("falls back to the caller's default when the override is absent or invalid", () => {
    expect(
      resolveEmbeddedPostgresUnavailablePolicy({ PAPERCLIP_EMBEDDED_POSTGRES_UNAVAILABLE_POLICY: "nope" }, {
        defaultPolicy: "fail",
      }),
    ).toBe("fail");
    expect(resolveEmbeddedPostgresUnavailablePolicy({}, { defaultPolicy: "skip" })).toBe("skip");
  });
});

describe("resolveEmbeddedPostgresGate", () => {
  it("runs the suites on a supported host regardless of environment", () => {
    for (const env of [{}, { CI: "true" }]) {
      const gate = resolveEmbeddedPostgresGate(SUPPORTED, env);
      expect(gate.runnable).toBe(true);
      expect(gate.isCi).toBe(env.CI === "true");
    }
  });

  it("fails an unsupported CI host instead of skipping it", () => {
    // This is the whole point of the gate: an unsupported CI host must never
    // reach `describe.skip`, because that reported green with zero coverage.
    const gate = resolveEmbeddedPostgresGate(UNSUPPORTED, { CI: "true" });

    expect(gate.runnable).toBe(false);
    expect(gate.policy).toBe("fail");
    expect(gate.isCi).toBe(true);
    expect(gate.message).toContain("initdb failed on this host");
  });

  it("skips an unsupported local host with a visible reason", () => {
    const gate = resolveEmbeddedPostgresGate(UNSUPPORTED, {});

    expect(gate.runnable).toBe(false);
    expect(gate.policy).toBe("skip");
    expect(gate.isCi).toBe(false);
    expect(gate.message).toContain("Skipping");
    expect(gate.message).toContain("initdb failed on this host");
  });

  it("lets an operator force a local host to fail loudly", () => {
    const gate = resolveEmbeddedPostgresGate(UNSUPPORTED, {
      PAPERCLIP_EMBEDDED_POSTGRES_UNAVAILABLE_POLICY: "fail",
    });

    expect(gate.policy).toBe("fail");
    expect(gate.isCi).toBe(false);
    expect(gate.message).toContain("local host");
  });

  it("cannot resolve an unsupported host to skip on CI unless an operator opts in", () => {
    const gate = resolveEmbeddedPostgresGate(UNSUPPORTED, {
      CI: "true",
      PAPERCLIP_EMBEDDED_POSTGRES_UNAVAILABLE_POLICY: "skip",
    });

    // The explicit opt-out is honoured — but it had to be deliberate.
    expect(gate.policy).toBe("skip");
    expect(gate.isCi).toBe(true);
  });
});