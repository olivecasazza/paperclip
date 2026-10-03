import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "reclaim-opencode-shared-db.sh");

const RC_OK = 0;
const RC_USAGE = 1;
const RC_REFUSED = 3;

const SPLIT_COMMIT = "c226db7b3cb45cd66aa20005783798759af5cd03";
const PRE_SPLIT_COMMIT = "379fc19457588eef1fbd3cc1db3aa0e22adad9d5";

function makeSandbox() {
  const root = mkdtempSync(path.join(os.tmpdir(), "reclaim-opencode-test-"));
  const shared = path.join(root, "home", ".local", "share", "opencode");
  const perAgent = path.join(root, "instances", "default", "adapter-data", "opencode");
  mkdirSync(shared, { recursive: true });
  mkdirSync(perAgent, { recursive: true });
  return {
    root,
    shared,
    perAgent,
    sharedDb: path.join(shared, "opencode.db"),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function writeSharedDb(sandbox, bytes = 4096) {
  writeFileSync(sandbox.sharedDb, Buffer.alloc(bytes, 7));
  writeFileSync(`${sandbox.sharedDb}-wal`, Buffer.alloc(1024, 1));
  writeFileSync(`${sandbox.sharedDb}-shm`, Buffer.alloc(512, 2));
}

function writePerAgentDb(sandbox, agentId, bytes = 2048) {
  const dir = path.join(sandbox.perAgent, agentId, "opencode");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "opencode.db"), Buffer.alloc(bytes, 3));
}

function run(sandbox, args = [], env = {}) {
  return spawnSync("bash", [SCRIPT, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      OPENCODE_SHARED_DATA_DIR: sandbox.shared,
      PER_AGENT_DATA_DIR: sandbox.perAgent,
      EXPECTED_COMMIT: SPLIT_COMMIT,
      IDLE_SECONDS: "0",
      HEALTH_URL: "",
      ...env,
    },
  });
}

function refuse(result) {
  assert.equal(result.status, RC_REFUSED, `expected refusal, got rc=${result.status}\n${result.stderr}`);
  assert.match(result.stderr, /REFUSED/);
}

test("refuses when no per-agent data home exists yet", () => {
  const sandbox = makeSandbox();
  try {
    writeSharedDb(sandbox);
    refuse(run(sandbox, ["--yes"]));
  } finally {
    sandbox.cleanup();
  }
});

test("refuses when the per-agent dir exists but holds no populated DB", () => {
  const sandbox = makeSandbox();
  try {
    writeSharedDb(sandbox);
    mkdirSync(path.join(sandbox.perAgent, "agent-a", "opencode"), { recursive: true });
    refuse(run(sandbox, ["--yes"]));
  } finally {
    sandbox.cleanup();
  }
});

test("refuses when the deployed build predates the split", () => {
  const sandbox = makeSandbox();
  try {
    writeSharedDb(sandbox);
    writePerAgentDb(sandbox, "agent-a");
    refuse(run(sandbox, ["--yes"], { EXPECTED_COMMIT: PRE_SPLIT_COMMIT }));
  } finally {
    sandbox.cleanup();
  }
});

test("refuses when the shared DB is inside the per-agent tree", () => {
  const sandbox = makeSandbox();
  try {
    writePerAgentDb(sandbox, "agent-a");
    const nested = path.join(sandbox.perAgent, "agent-a", "opencode");
    const result = run(sandbox, ["--yes"], { OPENCODE_SHARED_DATA_DIR: nested });
    refuse(result);
    assert.match(result.stderr, /per-agent tree/);
  } finally {
    sandbox.cleanup();
  }
});

test("refuses when a process holds the shared DB open", async () => {
  const sandbox = makeSandbox();
  try {
    writeSharedDb(sandbox);
    writePerAgentDb(sandbox, "agent-a");
    const holder = spawn("bash", ["-c", 'exec 9>"$1"; sleep 10', "_", sandbox.sharedDb], { stdio: "ignore" });
    try {
      await new Promise((resolve) => setTimeout(resolve, 300));
      const result = run(sandbox, ["--yes"]);
      refuse(result);
      assert.match(result.stderr, /hold .* open/);
      assert.ok(existsSync(sandbox.sharedDb), "shared DB must survive a refused run");
    } finally {
      holder.kill("SIGKILL");
    }
  } finally {
    sandbox.cleanup();
  }
});

test("refuses when the shared DB was written recently", () => {
  const sandbox = makeSandbox();
  try {
    writeSharedDb(sandbox);
    writePerAgentDb(sandbox, "agent-a");
    refuse(run(sandbox, ["--yes"], { IDLE_SECONDS: "3600" }));
  } finally {
    sandbox.cleanup();
  }
});

test("dry run reports the gates and deletes nothing", () => {
  const sandbox = makeSandbox();
  try {
    writeSharedDb(sandbox);
    writePerAgentDb(sandbox, "agent-a");
    const result = run(sandbox);
    assert.equal(result.status, RC_OK, result.stderr);
    assert.match(result.stderr, /dry run/);
    assert.match(result.stderr, /all gates passed/);
    assert.ok(existsSync(sandbox.sharedDb), "dry run must not delete");
    assert.ok(existsSync(`${sandbox.sharedDb}-wal`), "dry run must not delete the WAL");
  } finally {
    sandbox.cleanup();
  }
});

test("--yes removes db, wal and shm once every gate passes", () => {
  const sandbox = makeSandbox();
  try {
    writeSharedDb(sandbox);
    writePerAgentDb(sandbox, "agent-a");
    const result = run(sandbox, ["--yes"]);
    assert.equal(result.status, RC_OK, result.stderr);
    assert.equal(existsSync(sandbox.sharedDb), false, "db should be gone");
    assert.equal(existsSync(`${sandbox.sharedDb}-wal`), false, "wal should be gone");
    assert.equal(existsSync(`${sandbox.sharedDb}-shm`), false, "shm should be gone");
    assert.match(result.stderr, /RESULT: removed/);
  } finally {
    sandbox.cleanup();
  }
});

test("--backup-to copies the DB before deleting it", () => {
  const sandbox = makeSandbox();
  try {
    writeSharedDb(sandbox, 8192);
    writePerAgentDb(sandbox, "agent-a");
    const backup = path.join(sandbox.root, "backup", "opencode.db");
    const result = run(sandbox, ["--yes", "--backup-to", backup]);
    assert.equal(result.status, RC_OK, result.stderr);
    assert.ok(existsSync(backup), "backup should exist");
    assert.equal(statSync(backup).size, 8192);
    assert.equal(existsSync(sandbox.sharedDb), false);
  } finally {
    sandbox.cleanup();
  }
});

test("succeeds as a no-op when the shared DB is already gone", () => {
  const sandbox = makeSandbox();
  try {
    writePerAgentDb(sandbox, "agent-a");
    const result = run(sandbox, ["--yes"]);
    assert.equal(result.status, RC_OK, result.stderr);
    assert.match(result.stderr, /nothing to do/);
  } finally {
    sandbox.cleanup();
  }
});

test("does not require an idle window when IDLE_SECONDS is 0", () => {
  const sandbox = makeSandbox();
  try {
    writeSharedDb(sandbox);
    writePerAgentDb(sandbox, "agent-a");
    const now = new Date();
    utimesSync(sandbox.sharedDb, now, now);
    const result = run(sandbox, ["--yes"], { IDLE_SECONDS: "0" });
    assert.equal(result.status, RC_OK, result.stderr);
    assert.equal(existsSync(sandbox.sharedDb), false);
  } finally {
    sandbox.cleanup();
  }
});

test("reads the commit from the health endpoint when EXPECTED_COMMIT is unset", () => {
  const sandbox = makeSandbox();
  try {
    writeSharedDb(sandbox);
    writePerAgentDb(sandbox, "agent-a");
    const stubDir = path.join(sandbox.root, "bin");
    mkdirSync(stubDir, { recursive: true });
    const stub = path.join(stubDir, "curl");
    writeFileSync(stub, `#!/bin/sh\nprintf '{"status":"ok","commit":"${SPLIT_COMMIT}"}\\n'\n`, { mode: 0o755 });
    const result = spawnSync("bash", [SCRIPT, "--yes"], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${stubDir}:${process.env.PATH}`,
        OPENCODE_SHARED_DATA_DIR: sandbox.shared,
        PER_AGENT_DATA_DIR: sandbox.perAgent,
        EXPECTED_COMMIT: "",
        HEALTH_URL: "https://paperclip.example.test",
        IDLE_SECONDS: "0",
      },
    });
    assert.equal(result.status, RC_OK, result.stderr);
    assert.equal(existsSync(sandbox.sharedDb), false);
  } finally {
    sandbox.cleanup();
  }
});

test("refuses a pre-split commit read from the health endpoint", () => {
  const sandbox = makeSandbox();
  try {
    writeSharedDb(sandbox);
    writePerAgentDb(sandbox, "agent-a");
    const stubDir = path.join(sandbox.root, "bin");
    mkdirSync(stubDir, { recursive: true });
    const stub = path.join(stubDir, "curl");
    writeFileSync(stub, `#!/bin/sh\nprintf '{"status":"ok","commit":"${PRE_SPLIT_COMMIT}"}\\n'\n`, { mode: 0o755 });
    const result = spawnSync("bash", [SCRIPT, "--yes"], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${stubDir}:${process.env.PATH}`,
        OPENCODE_SHARED_DATA_DIR: sandbox.shared,
        PER_AGENT_DATA_DIR: sandbox.perAgent,
        EXPECTED_COMMIT: "",
        HEALTH_URL: "https://paperclip.example.test",
        IDLE_SECONDS: "0",
      },
    });
    refuse(result);
    assert.ok(existsSync(sandbox.sharedDb));
  } finally {
    sandbox.cleanup();
  }
});

test("rejects a non-numeric --idle-seconds", () => {
  const sandbox = makeSandbox();
  try {
    const result = run(sandbox, ["--idle-seconds", "soon"]);
    assert.equal(result.status, RC_USAGE);
  } finally {
    sandbox.cleanup();
  }
});

// --- GATE 2: the deployed tree is the primary proof ------------------------
//
// The commits that ship the repin are descendants of the split merge, so they do
// not prefix-match OPENCODE_SPLIT_COMMITS_DEFAULT. Before GATE 2 learned to read
// the running image's own tree it refused every published post-split image, which
// silently made the whole reclaim path unreachable in production.

function makeAppTree(root, { withSplit }) {
  const app = path.join(root, "app");
  const dir = path.join(app, "packages", "adapters", "opencode-local", "src", "server");
  mkdirSync(dir, { recursive: true });
  if (withSplit) {
    writeFileSync(path.join(dir, "agent-data-home.ts"), "export const x = 1;\n");
  } else {
    writeFileSync(path.join(dir, "execute.ts"), "export const y = 2;\n");
  }
  return app;
}

test("accepts a real published post-split commit when the deployed tree carries the split", () => {
  const sandbox = makeSandbox();
  try {
    writeSharedDb(sandbox);
    writePerAgentDb(sandbox, "agent-a");
    const app = makeAppTree(sandbox.root, { withSplit: true });
    // sha-cadea06c: the repin target, a descendant of the split merge. It is NOT
    // in OPENCODE_SPLIT_COMMITS_DEFAULT, so only the tree proof can admit it.
    const result = run(sandbox, ["--yes"], { EXPECTED_COMMIT: "cadea06cbaf64079e5781f98fedb81b5a27bf216", PAPERCLIP_APP_DIR: app });
    assert.equal(result.status, RC_OK, result.stderr);
    assert.equal(existsSync(sandbox.sharedDb), false);
  } finally {
    sandbox.cleanup();
  }
});

test("accepts the split proof without any commit or health endpoint at all", () => {
  const sandbox = makeSandbox();
  try {
    writeSharedDb(sandbox);
    writePerAgentDb(sandbox, "agent-a");
    const app = makeAppTree(sandbox.root, { withSplit: true });
    const result = run(sandbox, ["--yes"], { EXPECTED_COMMIT: "", HEALTH_URL: "", PAPERCLIP_APP_DIR: app });
    assert.equal(result.status, RC_OK, result.stderr);
    assert.equal(existsSync(sandbox.sharedDb), false);
  } finally {
    sandbox.cleanup();
  }
});

test("refuses a published post-split commit when the deployed tree lacks the split", () => {
  const sandbox = makeSandbox();
  try {
    writeSharedDb(sandbox);
    writePerAgentDb(sandbox, "agent-a");
    const app = makeAppTree(sandbox.root, { withSplit: false });
    refuse(run(sandbox, ["--yes"], { EXPECTED_COMMIT: "cadea06cbaf64079e5781f98fedb81b5a27bf216", PAPERCLIP_APP_DIR: app }));
    assert.ok(existsSync(sandbox.sharedDb));
  } finally {
    sandbox.cleanup();
  }
});

test("still proves the split by ancestry when the app tree is not mounted", () => {
  const sandbox = makeSandbox();
  try {
    writeSharedDb(sandbox);
    writePerAgentDb(sandbox, "agent-a");
    const missing = path.join(sandbox.root, "no-such-app-tree");
    // A dist-only or packaged deployment has no source tree; ancestry is then
    // the only available evidence, and a known post-split commit must pass.
    const result = run(sandbox, ["--yes"], { EXPECTED_COMMIT: SPLIT_COMMIT, PAPERCLIP_APP_DIR: missing });
    assert.equal(result.status, RC_OK, result.stderr);
    assert.equal(existsSync(sandbox.sharedDb), false);
  } finally {
    sandbox.cleanup();
  }
});

test("refuses with no tree and no way to read a commit", () => {
  const sandbox = makeSandbox();
  try {
    writeSharedDb(sandbox);
    writePerAgentDb(sandbox, "agent-a");
    const missing = path.join(sandbox.root, "no-such-app-tree");
    const result = run(sandbox, ["--yes"], { EXPECTED_COMMIT: "", HEALTH_URL: "", PAPERCLIP_APP_DIR: missing });
    refuse(result);
    assert.ok(existsSync(sandbox.sharedDb));
  } finally {
    sandbox.cleanup();
  }
});

test("rejects an unknown argument", () => {
  const sandbox = makeSandbox();
  try {
    const result = run(sandbox, ["--nope"]);
    assert.equal(result.status, RC_USAGE);
  } finally {
    sandbox.cleanup();
  }
});

test("script is executable and documents the WAL rule and every gate", () => {
  const mode = statSync(SCRIPT).mode;
  assert.ok(mode & 0o111, "script should be executable");
  const body = readFileSync(SCRIPT, "utf8");
  assert.match(body, /must never be unlinked/, "the WAL safety rule must be stated in the script");
  for (const gate of [
    "gate_per_agent_homes",
    "gate_deployed_build",
    "gate_no_open_handles",
    "gate_idle",
    "gate_target_is_shared",
  ]) {
    assert.ok(body.includes(`${gate}() {`), `${gate} must be defined and called`);
  }
  assert.match(body, /Dry run is the default/, "the destructive path must be opt-in");
});
