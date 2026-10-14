import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { cloudRoutes } from "../routes/cloud.js";

/**
 * The portfolio route maps four distinct misconfiguration/upstream conditions
 * onto three error codes and two status classes. The split matters to whoever
 * gets paged: 503 means "this stack is not wired up", 502 means "the provider
 * let us down", and the re-throw guard in the outer catch is the only thing
 * keeping the first from being reported as the second.
 */

const cloudEnv = {
  PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN: "tenant-secret",
  PAPERCLIP_CLOUD_STACK_ID: "stack-current",
  PAPERCLIP_CLOUD_API_ORIGIN: "https://cloud.example.test/control-plane",
};

function cloudActor(userId: string) {
  return {
    type: "board" as const,
    source: "cloud_tenant" as const,
    userId,
    companyIds: ["company-1"],
  };
}

function createApp(options: {
  actor?: ReturnType<typeof cloudActor> | {
    type: "board";
    source: "session";
    userId: string;
  };
  runtimeEnv?: Record<string, string | undefined>;
  fetchImpl: typeof fetch;
  now?: () => number;
}) {
  const app = express();
  app.use((req, _res, next) => {
    (req as any).actor = options.actor ?? cloudActor("actor-user");
    next();
  });
  app.use("/api/cloud", cloudRoutes({
    runtimeEnv: options.runtimeEnv ?? cloudEnv,
    fetchImpl: options.fetchImpl,
    now: options.now,
  }));
  app.use(errorHandler);
  return app;
}

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("GET /api/cloud/stacks", () => {
  it("returns the actor's portfolio without forwarding client-supplied identity", async () => {
    const portfolio = { stacks: [{ slug: "current", displayName: "Current" }] };
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(portfolio));
    const app = createApp({ fetchImpl });

    const res = await request(app)
      .get("/api/cloud/stacks?userId=client-supplied-user")
      .set("x-paperclip-cloud-user-id", "spoofed-header-user")
      .set("authorization", "Bearer client-token");

    expect(res.status).toBe(200);
    expect(res.body).toEqual(portfolio);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url.toString()).toBe("https://cloud.example.test/v1/tenant/portfolio");
    expect(init).toMatchObject({ method: "GET" });
    expect(init?.headers).toEqual({
      accept: "application/json",
      authorization: "Bearer tenant-secret",
      "x-paperclip-cloud-user-id": "actor-user",
      "x-paperclip-cloud-stack-id": "stack-current",
    });
    expect(JSON.stringify(init)).not.toContain("client-supplied-user");
    expect(JSON.stringify(init)).not.toContain("spoofed-header-user");
    expect(JSON.stringify(init)).not.toContain("client-token");
  });

  it("caches successful portfolios per actor for 30 seconds", async () => {
    let currentTime = 1_000;
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ generation: 1 }))
      .mockResolvedValueOnce(jsonResponse({ generation: 2 }));
    const app = createApp({ fetchImpl, now: () => currentTime });

    const first = await request(app).get("/api/cloud/stacks");
    currentTime += 29_999;
    const cached = await request(app).get("/api/cloud/stacks");
    currentTime += 1;
    const refreshed = await request(app).get("/api/cloud/stacks");

    expect(first.body).toEqual({ generation: 1 });
    expect(cached.body).toEqual({ generation: 1 });
    expect(refreshed.body).toEqual({ generation: 2 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("keeps cache entries isolated by the server-derived actor user id", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      const headers = new Headers(init?.headers);
      return jsonResponse({ userId: headers.get("x-paperclip-cloud-user-id") });
    });
    const app = express();
    app.use((req, _res, next) => {
      const userId = req.header("x-test-actor-user") ?? "user-a";
      (req as any).actor = cloudActor(userId);
      next();
    });
    app.use("/api/cloud", cloudRoutes({ runtimeEnv: cloudEnv, fetchImpl }));
    app.use(errorHandler);

    const first = await request(app).get("/api/cloud/stacks").set("x-test-actor-user", "user-a");
    const second = await request(app).get("/api/cloud/stacks").set("x-test-actor-user", "user-b");
    const firstAgain = await request(app).get("/api/cloud/stacks").set("x-test-actor-user", "user-a");

    expect(first.body).toEqual({ userId: "user-a" });
    expect(second.body).toEqual({ userId: "user-b" });
    expect(firstAgain.body).toEqual({ userId: "user-a" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("returns 404 on self-hosted instances without calling upstream", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const app = createApp({ runtimeEnv: {}, fetchImpl });

    const res = await request(app).get("/api/cloud/stacks");

    expect(res.status).toBe(404);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects non-tenant actors on managed instances without calling upstream", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const app = createApp({
      actor: { type: "board", source: "session", userId: "session-user" },
      fetchImpl,
    });

    const res = await request(app).get("/api/cloud/stacks");

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("cloud_tenant_required");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  describe("cloud_portfolio_not_configured", () => {
    // Reaching the 503 guard requires the instance to still look *managed*.
    // getCloudStackContext returns null (=> 404) when neither the tenant token
    // nor PAPERCLIP_MANAGED_CONFIG is present, so these cases keep the managed
    // signal and vary only the value the route actually reads.
    const managedSignal = { PAPERCLIP_MANAGED_CONFIG: "{}" };

    it.each([
      [
        "the tenant server token",
        { ...managedSignal, PAPERCLIP_CLOUD_STACK_ID: "stack-current", PAPERCLIP_CLOUD_API_ORIGIN: "https://cloud.example.test" },
      ],
      [
        "the stack id",
        { ...managedSignal, PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN: "tenant-secret", PAPERCLIP_CLOUD_API_ORIGIN: "https://cloud.example.test" },
      ],
      [
        "the cloud origin",
        { ...managedSignal, PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN: "tenant-secret", PAPERCLIP_CLOUD_STACK_ID: "stack-current" },
      ],
    ])("returns 503 when a managed instance is missing %s", async (_label, runtimeEnv) => {
      const fetchImpl = vi.fn<typeof fetch>();
      const app = createApp({ runtimeEnv, fetchImpl });

      const res = await request(app).get("/api/cloud/stacks");

      expect(res.status).toBe(503);
      expect(res.body.code).toBe("cloud_portfolio_not_configured");
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it.each([
      ["the tenant server token", { ...managedSignal, PAPERCLIP_CLOUD_STACK_ID: "stack-current", PAPERCLIP_CLOUD_API_ORIGIN: "https://cloud.example.test" }],
      ["the stack id", { ...cloudEnv, PAPERCLIP_CLOUD_STACK_ID: "   " }],
      ["the cloud origin", { ...cloudEnv, PAPERCLIP_CLOUD_API_ORIGIN: "   " }],
    ])("treats a blank-but-present %s as missing config", async (_label, runtimeEnv) => {
      const fetchImpl = vi.fn<typeof fetch>();
      const app = createApp({ runtimeEnv, fetchImpl });

      const res = await request(app).get("/api/cloud/stacks");

      expect(res.status).toBe(503);
      expect(res.body.code).toBe("cloud_portfolio_not_configured");
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it("prefers the 404 self-hosted lane over 503 when no managed signal exists at all", async () => {
      // Both the tenant token and PAPERCLIP_MANAGED_CONFIG are absent, so
      // getCloudStackContext bails before the misconfiguration guard runs.
      // A 503 here would mean the predicate is not the one operators expect.
      const fetchImpl = vi.fn<typeof fetch>();
      const app = createApp({ runtimeEnv: {}, fetchImpl });

      const res = await request(app).get("/api/cloud/stacks");

      expect(res.status).toBe(404);
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it("returns 503 when the configured cloud origin is not a parseable URL", async () => {
      const fetchImpl = vi.fn<typeof fetch>();
      const app = createApp({
        runtimeEnv: { ...cloudEnv, PAPERCLIP_CLOUD_API_ORIGIN: "http://" },
        fetchImpl,
      });

      const res = await request(app).get("/api/cloud/stacks");

      expect(res.status).toBe(503);
      expect(res.body.code).toBe("cloud_portfolio_not_configured");
      expect(fetchImpl).not.toHaveBeenCalled();
    });
  });

  describe("cloud_portfolio_upstream_error", () => {
    it.each([400, 401, 429, 500, 503])(
      "returns 502 when the provider answers %i, without leaking the upstream status as success",
      async (upstreamStatus) => {
        const fetchImpl = vi.fn<typeof fetch>()
          .mockResolvedValue(jsonResponse({ message: "provider detail" }, upstreamStatus));
        const app = createApp({ fetchImpl });

        const res = await request(app).get("/api/cloud/stacks");

        expect(res.status).toBe(502);
        expect(res.body.code).toBe("cloud_portfolio_upstream_error");
        expect(res.body).not.toHaveProperty("stacks");
        expect(fetchImpl).toHaveBeenCalledTimes(1);
      },
    );

    it("returns 502 invalid_response when the provider answers 200 with an empty body", async () => {
      // An empty 200 is ok=true with an unparseable body, so it belongs to the
      // invalid_response class rather than upstream_error.
      const fetchImpl = vi.fn<typeof fetch>()
        .mockResolvedValue(new Response(null, { status: 200 }));
      const app = createApp({ fetchImpl });

      const res = await request(app).get("/api/cloud/stacks");

      expect(res.status).toBe(502);
      expect(res.body.code).toBe("cloud_portfolio_invalid_response");
    });

    it("returns 502 when the upstream fetch rejects outright", async () => {
      const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error("ECONNREFUSED"));
      const app = createApp({ fetchImpl });

      const res = await request(app).get("/api/cloud/stacks");

      expect(res.status).toBe(502);
      expect(res.body.code).toBe("cloud_portfolio_upstream_error");
    });

    it("returns 502 when the upstream fetch aborts on the route timeout budget", async () => {
      // Mirrors AbortSignal.timeout firing: a DOMException with name "TimeoutError".
      const abortError = Object.assign(new Error("The operation was aborted"), {
        name: "TimeoutError",
      });
      const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(abortError);
      const app = createApp({ fetchImpl });

      const res = await request(app).get("/api/cloud/stacks");

      expect(res.status).toBe(502);
      expect(res.body.code).toBe("cloud_portfolio_upstream_error");
    });

    it("passes a 10s abort signal budget upstream so a hung provider cannot pin the request open", async () => {
      let observedSignal: AbortSignal | undefined;
      const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
        observedSignal = init?.signal ?? undefined;
        return jsonResponse({ stacks: [] });
      });
      const app = createApp({ fetchImpl });

      const res = await request(app).get("/api/cloud/stacks");

      expect(res.status).toBe(200);
      expect(observedSignal).toBeInstanceOf(AbortSignal);
      expect(observedSignal?.aborted).toBe(false);
    });

    it("does not cache a failed upstream fetch, so a recovering provider is retried", async () => {
      const fetchImpl = vi.fn<typeof fetch>()
        .mockResolvedValueOnce(jsonResponse({ detail: "boom" }, 500))
        .mockResolvedValueOnce(jsonResponse({ stacks: [{ slug: "current" }] }));
      const app = createApp({ fetchImpl });

      const failed = await request(app).get("/api/cloud/stacks");
      const recovered = await request(app).get("/api/cloud/stacks");

      expect(failed.status).toBe(502);
      expect(failed.body.code).toBe("cloud_portfolio_upstream_error");
      expect(recovered.status).toBe(200);
      expect(recovered.body).toEqual({ stacks: [{ slug: "current" }] });
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    });
  });

  describe("cloud_portfolio_invalid_response", () => {
    it("returns 502 when the provider answers 200 with a non-JSON body", async () => {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
        new Response("<html>proxy error</html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
      );
      const app = createApp({ fetchImpl });

      const res = await request(app).get("/api/cloud/stacks");

      expect(res.status).toBe(502);
      expect(res.body.code).toBe("cloud_portfolio_invalid_response");
    });

    it("returns 502 when the provider body is truncated JSON", async () => {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
        new Response('{"stacks":[{"slug":"cur"', {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
      const app = createApp({ fetchImpl });

      const res = await request(app).get("/api/cloud/stacks");

      expect(res.status).toBe(502);
      expect(res.body.code).toBe("cloud_portfolio_invalid_response");
    });

    it("does not cache an unparseable body, so a later valid payload is served", async () => {
      const fetchImpl = vi.fn<typeof fetch>()
        .mockResolvedValueOnce(
          new Response("not json", { status: 200, headers: { "content-type": "text/plain" } }),
        )
        .mockResolvedValueOnce(jsonResponse({ stacks: [{ slug: "current" }] }));
      const app = createApp({ fetchImpl });

      const failed = await request(app).get("/api/cloud/stacks");
      const recovered = await request(app).get("/api/cloud/stacks");

      expect(failed.status).toBe(502);
      expect(failed.body.code).toBe("cloud_portfolio_invalid_response");
      expect(recovered.status).toBe(200);
      expect(recovered.body).toEqual({ stacks: [{ slug: "current" }] });
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    it("keeps a 502 invalid_response distinct from a 502 upstream_error for the same failure class", async () => {
      // Both are 502, so the operator-facing `code` is the only discriminator.
      // If the outer catch ever stops re-throwing HttpError, both collapse onto
      // cloud_portfolio_upstream_error and this pairing silently degrades.
      const invalidJson = vi.fn<typeof fetch>()
        .mockResolvedValue(new Response("not json", { status: 200 }));
      const upstreamFailure = vi.fn<typeof fetch>()
        .mockResolvedValue(jsonResponse({ detail: "boom" }, 500));

      const invalidJsonRes = await request(createApp({ fetchImpl: invalidJson }))
        .get("/api/cloud/stacks");
      const upstreamFailureRes = await request(createApp({ fetchImpl: upstreamFailure }))
        .get("/api/cloud/stacks");

      expect(invalidJsonRes.status).toBe(502);
      expect(upstreamFailureRes.status).toBe(502);
      expect(invalidJsonRes.body.code).toBe("cloud_portfolio_invalid_response");
      expect(upstreamFailureRes.body.code).toBe("cloud_portfolio_upstream_error");
      expect(invalidJsonRes.body.code).not.toBe(upstreamFailureRes.body.code);
    });
  });

  it("never rewrites the 503 misconfiguration signal as a 502 when the re-throw guard runs", async () => {
    // routes/cloud.ts:105 catches everything from the fetch and re-throws
    // HttpError untouched. If that guard were deleted, every 503 raised inside
    // the try block would be reported as cloud_portfolio_upstream_error and
    // operators would chase the provider instead of the stack wiring.
    const unparseableOrigin = await request(
      createApp({
        runtimeEnv: { ...cloudEnv, PAPERCLIP_CLOUD_API_ORIGIN: "http://" },
        fetchImpl: vi.fn<typeof fetch>(),
      }),
    ).get("/api/cloud/stacks");

    expect(unparseableOrigin.status).toBe(503);
    expect(unparseableOrigin.body.code).toBe("cloud_portfolio_not_configured");

    // Same guard, opposite side: a provider failure raised inside the try
    // block must reach the client as 502, not leak as an unhandled rejection.
    const upstreamFailure = await request(
      createApp({
        fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ detail: "boom" }, 500)),
      }),
    ).get("/api/cloud/stacks");

    expect(upstreamFailure.status).toBe(502);
    expect(upstreamFailure.body.code).toBe("cloud_portfolio_upstream_error");
  });

  it("prefers 502 upstream_error over 502 invalid_response when the body read fails after a non-ok status", async () => {
    // `!upstream.ok` is checked before `.json()`, so a non-ok response whose
    // body is unreadable must still surface the upstream failure code.
    const unreadableBody = {
      ok: false,
      status: 500,
      json: () => Promise.reject(new Error("stream already consumed")),
    } as unknown as Response;
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(unreadableBody);
    const app = createApp({ fetchImpl });

    const res = await request(app).get("/api/cloud/stacks");

    expect(res.status).toBe(502);
    expect(res.body.code).toBe("cloud_portfolio_upstream_error");
  });
});
