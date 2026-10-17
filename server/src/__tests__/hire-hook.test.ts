import { afterEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { notifyHireApproved } from "../services/hire-hook.js";

// Canonical operator-facing copy mirrored from hire-hook.ts. The constant is
// module-private, so assert against a literal: a copy change must be a
// deliberate, visible edit here rather than a silent divergence.
const HIRE_APPROVED_MESSAGE =
  "Tell your user that your hire was approved, now they should assign you a task in Paperclip or ask you to create issues.";

// Mock the registry so we control whether the adapter has onHireApproved and what it does.
vi.mock("../adapters/registry.js", () => ({
  findActiveServerAdapter: vi.fn(),
}));

vi.mock("../services/activity-log.js", () => ({
  logActivity: vi.fn().mockResolvedValue(undefined),
}));

const { findActiveServerAdapter } = await import("../adapters/registry.js");
const { logActivity } = await import("../services/activity-log.js");

function mockDbWithAgent(agent: { id: string; companyId: string; name: string; adapterType: string; adapterConfig?: Record<string, unknown> }): Db {
  return {
    select: () => ({
      from: () => ({
        where: () =>
          Promise.resolve([
            {
              id: agent.id,
              companyId: agent.companyId,
              name: agent.name,
              adapterType: agent.adapterType,
              adapterConfig: agent.adapterConfig ?? {},
            },
          ]),
      }),
    }),
  } as unknown as Db;
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("notifyHireApproved", () => {
  it("writes success activity when adapter hook returns ok", async () => {
    const onHireApproved = vi.fn().mockResolvedValue({ ok: true });
    vi.mocked(findActiveServerAdapter).mockReturnValue({
      type: "openclaw_gateway",
      onHireApproved,
    } as any);

    const db = mockDbWithAgent({
      id: "a1",
      companyId: "c1",
      name: "OpenClaw Agent",
      adapterType: "openclaw_gateway",
    });

    const approvedAt = new Date("2026-01-02T03:04:05.000Z");
    await expect(
      notifyHireApproved(db, {
        companyId: "c1",
        agentId: "a1",
        source: "approval",
        sourceId: "ap1",
        approvedAt,
      }),
    ).resolves.toBeUndefined();

    expect(onHireApproved).toHaveBeenCalledTimes(1);
    const [payload, adapterConfig] = onHireApproved.mock.calls[0] as [
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(payload).toEqual({
      companyId: "c1",
      agentId: "a1",
      agentName: "OpenClaw Agent",
      adapterType: "openclaw_gateway",
      source: "approval",
      sourceId: "ap1",
      approvedAt: "2026-01-02T03:04:05.000Z",
      message: HIRE_APPROVED_MESSAGE,
    });
    expect(adapterConfig).toEqual({});

    expect(logActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "hire_hook.succeeded",
        entityId: "a1",
        details: expect.objectContaining({ source: "approval", sourceId: "ap1", adapterType: "openclaw_gateway" }),
      }),
    );
  });

  it("does nothing when agent is not found", async () => {
    const db = {
      select: () => ({
        from: () => ({
          where: () => Promise.resolve([]),
        }),
      }),
    } as unknown as Db;

    await expect(
      notifyHireApproved(db, {
        companyId: "c1",
        agentId: "a1",
        source: "join_request",
        sourceId: "jr1",
      }),
    ).resolves.toBeUndefined();

    expect(findActiveServerAdapter).not.toHaveBeenCalled();
  });

  it("does nothing when adapter has no onHireApproved", async () => {
    vi.mocked(findActiveServerAdapter).mockReturnValue({ type: "process" } as any);

    const db = mockDbWithAgent({
      id: "a1",
      companyId: "c1",
      name: "Agent",
      adapterType: "process",
    });

    await expect(
      notifyHireApproved(db, {
        companyId: "c1",
        agentId: "a1",
        source: "approval",
        sourceId: "ap1",
      }),
    ).resolves.toBeUndefined();

    expect(findActiveServerAdapter).toHaveBeenCalledWith("process");
    expect(logActivity).not.toHaveBeenCalled();
  });

  it("logs failed result when adapter onHireApproved returns ok=false", async () => {
    const onHireApproved = vi.fn().mockResolvedValue({ ok: false, error: "HTTP 500", detail: { status: 500 } });
    vi.mocked(findActiveServerAdapter).mockReturnValue({
      type: "openclaw_gateway",
      onHireApproved,
    } as any);

    const db = mockDbWithAgent({
      id: "a1",
      companyId: "c1",
      name: "OpenClaw Agent",
      adapterType: "openclaw_gateway",
    });

    await expect(
      notifyHireApproved(db, {
        companyId: "c1",
        agentId: "a1",
        source: "join_request",
        sourceId: "jr1",
      }),
    ).resolves.toBeUndefined();

    // A failed hook reports once: no retry delivery to the external gateway.
    expect(onHireApproved).toHaveBeenCalledTimes(1);
    expect(onHireApproved.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        companyId: "c1",
        agentId: "a1",
        agentName: "OpenClaw Agent",
        adapterType: "openclaw_gateway",
        source: "join_request",
        sourceId: "jr1",
        message: HIRE_APPROVED_MESSAGE,
      }),
    );

    expect(logActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "hire_hook.failed",
        entityId: "a1",
        details: expect.objectContaining({ source: "join_request", sourceId: "jr1", error: "HTTP 500" }),
      }),
    );
    expect(logActivity).toHaveBeenCalledTimes(1);
  });

  it("does not throw when adapter onHireApproved throws (non-fatal)", async () => {
    const onHireApproved = vi.fn().mockRejectedValue(new Error("Network error"));
    vi.mocked(findActiveServerAdapter).mockReturnValue({
      type: "openclaw_gateway",
      onHireApproved,
    } as any);

    const db = mockDbWithAgent({
      id: "a1",
      companyId: "c1",
      name: "OpenClaw Agent",
      adapterType: "openclaw_gateway",
    });

    await expect(
      notifyHireApproved(db, {
        companyId: "c1",
        agentId: "a1",
        source: "join_request",
        sourceId: "jr1",
      }),
    ).resolves.toBeUndefined();

    // A throwing hook is not retried; the agent is told exactly once.
    expect(onHireApproved).toHaveBeenCalledTimes(1);
    expect(onHireApproved.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        companyId: "c1",
        agentId: "a1",
        agentName: "OpenClaw Agent",
        adapterType: "openclaw_gateway",
        source: "join_request",
        sourceId: "jr1",
        message: HIRE_APPROVED_MESSAGE,
      }),
    );

    expect(logActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "hire_hook.error",
        entityId: "a1",
        details: expect.objectContaining({ source: "join_request", sourceId: "jr1", error: "Network error" }),
      }),
    );
    expect(logActivity).toHaveBeenCalledTimes(1);
  });
});
