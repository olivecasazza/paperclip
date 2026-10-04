import { describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import {
  privateHostnameGuard,
  resolvePrivateHostnameAllowSet,
} from "../middleware/private-hostname-guard.js";

const unknownHostname = "blocked-host.invalid";

/**
 * Stand in for the compiled Express `trust proxy fn`. The real setting is
 * derived from the operator's TRUST_PROXY env var, so the guard's behavior
 * here has to be pinned against an explicitly trusted and explicitly untrusted
 * peer.
 */
function trustProxyReturning(trusted: boolean) {
  return () => trusted;
}

function createApp(
  opts: {
    enabled: boolean;
    allowedHostnames?: string[];
    bindHost?: string;
    trustProxy?: ReturnType<typeof trustProxyReturning>;
  },
) {
  const app = express();
  if (opts.trustProxy) app.set("trust proxy", opts.trustProxy);
  app.use(
    privateHostnameGuard({
      enabled: opts.enabled,
      allowedHostnames: opts.allowedHostnames ?? [],
      bindHost: opts.bindHost ?? "0.0.0.0",
    }),
  );
  app.get("/api/health", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });
  app.get("/dashboard", (_req, res) => {
    res.status(200).send("ok");
  });
  return app;
}

describe("privateHostnameGuard", () => {
  it("allows requests when disabled", async () => {
    const app = createApp({ enabled: false });
    const res = await request(app).get("/api/health").set("Host", "dotta-macbook-pro:3100");
    expect(res.status).toBe(200);
  });

  it("allows loopback hostnames", async () => {
    const app = createApp({ enabled: true });
    const res = await request(app).get("/api/health").set("Host", "localhost:3100");
    expect(res.status).toBe(200);
  });

  it("allows explicitly configured hostnames", async () => {
    const app = createApp({ enabled: true, allowedHostnames: ["dotta-macbook-pro"] });
    const res = await request(app).get("/api/health").set("Host", "dotta-macbook-pro:3100");
    expect(res.status).toBe(200);
  });

  it("blocks unknown hostnames with a static remediation command", async () => {
    const app = createApp({ enabled: true, allowedHostnames: ["some-other-host"] });
    const res = await request(app).get("/api/health").set("Host", `${unknownHostname}:3100`);
    expect(res.status).toBe(403);
    // The remediation command carries a static `<host>` placeholder. It never
    // interpolates the request Host header into the command.
    expect(res.body?.error).toContain("run npx paperclipai allowed-hostname <host>");
    expect(res.body?.error).not.toContain(unknownHostname);
  });

  it("blocks unknown hostnames on page routes with a static plain-text remediation command", async () => {
    const middleware = privateHostnameGuard({
      enabled: true,
      allowedHostnames: ["some-other-host"],
      bindHost: "0.0.0.0",
    });
    const req = {
      path: "/dashboard",
      header: (name: string) => (name.toLowerCase() === "host" ? `${unknownHostname}:3100` : undefined),
      accepts: () => "html",
    } as any;
    const res = {
      status: vi.fn().mockReturnThis(),
      type: vi.fn().mockReturnThis(),
      send: vi.fn(),
      json: vi.fn(),
    } as any;
    const next = vi.fn();

    middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.send).toHaveBeenCalledWith(
      expect.stringContaining("run npx paperclipai allowed-hostname <host>"),
    );
    expect(res.send).not.toHaveBeenCalledWith(expect.stringContaining(unknownHostname));
  }, 20_000);

  it("does not reflect a hostile Host header into the remediation command", async () => {
    // An unauthenticated requester can send an invalid Host header that holds
    // shell metacharacters. `extractHostname` falls back to the raw header when
    // URL parsing fails. The 403 guidance must not echo that value, so an
    // operator or an agent cannot paste an attacker-controlled span into a
    // shell. Use a harmless, nonexistent command name inside the span.
    const hostileHost = "evil$(echo marker)host";
    const app = createApp({ enabled: true, allowedHostnames: ["some-other-host"] });
    const res = await request(app).get("/api/health").set("Host", hostileHost);
    expect(res.status).toBe(403);
    expect(res.body?.error).toContain("run npx paperclipai allowed-hostname <host>");
    expect(res.body?.error).not.toContain("evil");
    expect(res.body?.error).not.toContain("$(");
    expect(res.body?.error).not.toContain("marker");
  });

  it("ignores X-Forwarded-Host from an untrusted direct client", async () => {
    // An unauthenticated client that can reach the server directly must not be
    // able to spoof the guard by claiming a loopback forwarded host.
    const app = createApp({
      enabled: true,
      allowedHostnames: ["some-other-host"],
      trustProxy: trustProxyReturning(false),
    });
    const res = await request(app)
      .get("/api/health")
      .set("Host", `${unknownHostname}:3100`)
      .set("X-Forwarded-Host", "localhost");
    expect(res.status).toBe(403);
  });

  it("rejects the forwarded-host spoof when no trust proxy is configured", async () => {
    // Express defaults to trusting nothing. Without an explicit TRUST_PROXY the
    // `trust proxy fn` is absent, so the header must never be consulted.
    const app = createApp({ enabled: true, allowedHostnames: ["some-other-host"] });
    const res = await request(app)
      .get("/api/health")
      .set("Host", `${unknownHostname}:3100`)
      .set("X-Forwarded-Host", "localhost");
    expect(res.status).toBe(403);
  });

  it("honors X-Forwarded-Host from a trusted proxy", async () => {
    // Behind a configured trusted proxy the forwarded host is the real public
    // hostname, so a legitimate allowlisted value must still pass.
    const app = createApp({
      enabled: true,
      allowedHostnames: ["paperclip.example.com"],
      trustProxy: trustProxyReturning(true),
    });
    const res = await request(app)
      .get("/api/health")
      .set("Host", "internal-service:3100")
      .set("X-Forwarded-Host", "paperclip.example.com");
    expect(res.status).toBe(200);
  });

  it("still blocks a trusted proxy that forwards a disallowed host", async () => {
    const app = createApp({
      enabled: true,
      allowedHostnames: ["paperclip.example.com"],
      trustProxy: trustProxyReturning(true),
    });
    const res = await request(app)
      .get("/api/health")
      .set("Host", "paperclip.example.com")
      .set("X-Forwarded-Host", `${unknownHostname}:3100`);
    expect(res.status).toBe(403);
  });

  it("blocks a request with no Host header with a JSON 403 on API routes", async () => {
    const app = createApp({ enabled: true });
    const res = await request(app).get("/api/health").set("Host", "");
    expect(res.status).toBe(403);
    expect(res.body?.error).toContain("Missing Host header");
  });

  it("blocks a request with no Host header with a plain-text 403 on page routes", async () => {
    const middleware = privateHostnameGuard({
      enabled: true,
      allowedHostnames: [],
      bindHost: "0.0.0.0",
    });
    const req = {
      path: "/dashboard",
      header: () => undefined,
      accepts: () => "html",
    } as any;
    const res = {
      status: vi.fn().mockReturnThis(),
      type: vi.fn().mockReturnThis(),
      send: vi.fn(),
      json: vi.fn(),
    } as any;
    const next = vi.fn();

    middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.send).toHaveBeenCalledWith(expect.stringContaining("Missing Host header"));
  });

  it("allows the configured bind host when it is not 0.0.0.0", async () => {
    const app = createApp({ enabled: true, bindHost: "paperclip.internal" });
    const res = await request(app).get("/api/health").set("Host", "paperclip.internal:3100");
    expect(res.status).toBe(200);
  });
});

describe("resolvePrivateHostnameAllowSet", () => {
  it("always allows loopback hostnames", () => {
    const allowSet = resolvePrivateHostnameAllowSet({ allowedHostnames: [], bindHost: "0.0.0.0" });
    expect(allowSet.has("localhost")).toBe(true);
    expect(allowSet.has("127.0.0.1")).toBe(true);
    expect(allowSet.has("::1")).toBe(true);
  });

  it("does not add the wildcard bind host to the allow set", () => {
    const allowSet = resolvePrivateHostnameAllowSet({ allowedHostnames: [], bindHost: "0.0.0.0" });
    expect(allowSet.has("0.0.0.0")).toBe(false);
  });

  it("adds a non-wildcard bind host to the allow set", () => {
    const allowSet = resolvePrivateHostnameAllowSet({
      allowedHostnames: [],
      bindHost: "paperclip.internal",
    });
    expect(allowSet.has("paperclip.internal")).toBe(true);
  });

  it("normalizes configured allow hostnames and de-duplicates", () => {
    const allowSet = resolvePrivateHostnameAllowSet({
      allowedHostnames: ["  Paperclip.Example.COM ", "paperclip.example.com", "", "  "],
      bindHost: "0.0.0.0",
    });
    expect(allowSet.has("paperclip.example.com")).toBe(true);
    expect(allowSet.size).toBe(4);
  });
});
