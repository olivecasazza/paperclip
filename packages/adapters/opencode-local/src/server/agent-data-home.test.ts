import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prepareOpenCodePerAgentDataHome } from "./agent-data-home.js";

const AGENT_A = "11111111-2222-3333-4444-555555555555";
const AGENT_B = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

let tmpRoot: string;
let previousPaperclipHome: string | undefined;
let previousInstanceId: string | undefined;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "oc-data-home-test-"));
  previousPaperclipHome = process.env.PAPERCLIP_HOME;
  previousInstanceId = process.env.PAPERCLIP_INSTANCE_ID;
  process.env.PAPERCLIP_HOME = tmpRoot;
  process.env.PAPERCLIP_INSTANCE_ID = "default";
});

afterEach(async () => {
  if (previousPaperclipHome === undefined) delete process.env.PAPERCLIP_HOME;
  else process.env.PAPERCLIP_HOME = previousPaperclipHome;
  if (previousInstanceId === undefined) delete process.env.PAPERCLIP_INSTANCE_ID;
  else process.env.PAPERCLIP_INSTANCE_ID = previousInstanceId;
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe("prepareOpenCodePerAgentDataHome", () => {
  it("gives two agents distinct data homes so they never open the same opencode.db", async () => {
    const envA: Record<string, string> = {};
    const envB: Record<string, string> = {};

    const a = await prepareOpenCodePerAgentDataHome({ env: envA, config: {}, agentId: AGENT_A });
    const b = await prepareOpenCodePerAgentDataHome({ env: envB, config: {}, agentId: AGENT_B });

    expect(a.dataHome).not.toBeNull();
    expect(b.dataHome).not.toBeNull();
    expect(envA.XDG_DATA_HOME).not.toBe(envB.XDG_DATA_HOME);
    expect(path.join(envA.XDG_DATA_HOME!, "opencode.db")).not.toBe(
      path.join(envB.XDG_DATA_HOME!, "opencode.db"),
    );
    await expect(fs.stat(path.join(envA.XDG_DATA_HOME!, "opencode.db"))).rejects.toThrow();
  });

  it("keeps one agent's data home stable across heartbeats so sessions stay resumable", async () => {
    const first: Record<string, string> = {};
    const second: Record<string, string> = {};
    await prepareOpenCodePerAgentDataHome({ env: first, config: {}, agentId: AGENT_A });
    await prepareOpenCodePerAgentDataHome({ env: second, config: {}, agentId: AGENT_A });
    expect(first.XDG_DATA_HOME).toBe(second.XDG_DATA_HOME);
  });

  it("seeds auth.json from the previous data dir without copying opencode.db", async () => {
    const previous = path.join(tmpRoot, "previous-data");
    await fs.mkdir(previous, { recursive: true });
    await fs.writeFile(path.join(previous, "auth.json"), '{"anthropic":{"type":"api"}}');
    await fs.writeFile(path.join(previous, "opencode.db"), "not-a-real-db");
    await fs.mkdir(path.join(previous, "repos"), { recursive: true });
    await fs.writeFile(path.join(previous, "repos", "keep.txt"), "keep");

    const env: Record<string, string> = { XDG_DATA_HOME: previous };
    const result = await prepareOpenCodePerAgentDataHome({ env, config: {}, agentId: AGENT_A });

    expect(env.XDG_DATA_HOME).not.toBe(previous);
    expect(await fs.readFile(path.join(env.XDG_DATA_HOME!, "auth.json"), "utf8")).toBe(
      '{"anthropic":{"type":"api"}}',
    );
    expect(await fs.readFile(path.join(env.XDG_DATA_HOME!, "repos", "keep.txt"), "utf8")).toBe("keep");
    // The multi-GB shared DB must not be copied into every agent's dir.
    await expect(fs.stat(path.join(env.XDG_DATA_HOME!, "opencode.db"))).rejects.toThrow();
    expect(result.notes.join(" ")).toContain("Isolated OpenCode data dir per agent");
  });

  it("does not clobber an agent's own auth.json on a later heartbeat", async () => {
    const first: Record<string, string> = {};
    await prepareOpenCodePerAgentDataHome({ env: first, config: {}, agentId: AGENT_A });
    const dataHome = first.XDG_DATA_HOME!;
    await fs.writeFile(path.join(dataHome, "auth.json"), '{"mine":true}');

    const second: Record<string, string> = {};
    await prepareOpenCodePerAgentDataHome({ env: second, config: {}, agentId: AGENT_A });
    expect(await fs.readFile(path.join(dataHome, "auth.json"), "utf8")).toBe('{"mine":true}');
  });

  it("honours an explicit data root override", async () => {
    const base = path.join(tmpRoot, "custom-root");
    const env: Record<string, string> = {};
    await prepareOpenCodePerAgentDataHome({
      env,
      config: { openCodeDataRoot: base },
      agentId: AGENT_A,
    });
    expect(env.XDG_DATA_HOME).toBe(path.join(base, AGENT_A));
  });

  it("opts out when sharedDataHome is configured", async () => {
    const env: Record<string, string> = {};
    const result = await prepareOpenCodePerAgentDataHome({
      env,
      config: { sharedDataHome: true },
      agentId: AGENT_A,
    });
    expect(env.XDG_DATA_HOME).toBeUndefined();
    expect(result.dataHome).toBeNull();
  });

  it("opts out via the env kill switch", async () => {
    const env: Record<string, string> = { PAPERCLIP_OPENCODE_SHARED_DATA_HOME: "1" };
    await prepareOpenCodePerAgentDataHome({ env, config: {}, agentId: AGENT_A });
    expect(env.XDG_DATA_HOME).toBeUndefined();
  });

  it("skips remote targets, which already get per-run isolated homes", async () => {
    const env: Record<string, string> = {};
    const result = await prepareOpenCodePerAgentDataHome({
      env,
      config: {},
      agentId: AGENT_A,
      targetIsRemote: true,
    });
    expect(env.XDG_DATA_HOME).toBeUndefined();
    expect(result.dataHome).toBeNull();
  });

  it("refuses an agent id that is not a safe path segment", async () => {
    const env: Record<string, string> = {};
    const result = await prepareOpenCodePerAgentDataHome({
      env,
      config: {},
      agentId: "../../etc",
    });
    expect(env.XDG_DATA_HOME).toBeUndefined();
    expect(result.notes.join(" ")).toContain("not a safe path segment");
  });
});
