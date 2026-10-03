import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, linkSync, lutimesSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "disk-guard.sh");

// Exit codes documented in the script header.
const RC_OK = 0;
const RC_ERROR = 1;
const RC_WARN = 2;
const RC_CRITICAL = 3;

const MIB = 1024 * 1024;

// The one repository a workspace checkout may belong to and still be reclaimed
// for. Gate 2 binds repository identity from `origin`, and any other origin --
// including a checkout of this control plane's own repo -- is refused, because
// the issue terminality that authorizes deletion is this company's, read from
// this company's API.
const COMPANY_PROJECT_REPO = "https://github.com/olivecasazza/definitely-not-crosswords.git";
// A different repository on the same account. Its branches name tickets in our
// namespace (a branch called `def-139-...` on a foreign repo resolves to DEF-139
// under any branch-string regex), which is exactly the confusion that makes
// deleting from it a cross-repo deletion.
const FOREIGN_REPO = "https://github.com/olivecasazza/paperclip.git";

function makeSandbox() {
  const root = mkdtempSync(path.join(os.tmpdir(), "disk-guard-test-"));
  const mount = path.join(root, "mnt");
  const binDir = path.join(root, "bin");
  mkdirSync(mount);
  mkdirSync(binDir);
  return {
    root,
    mount,
    binDir,
    statusFile: path.join(root, "run", "disk-guard.status"),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/**
 * Shadow `df` with a stub so usage is deterministic and independent of the real
 * filesystem. The script calls `df --block-size=1 -P "$MOUNT"`; size/used/avail
 * are emitted in 1-byte blocks, matching what the script's awk expects.
 *
 * The Use% column is computed the way GNU df computes it: 100*used/(used+avail)
 * taken to the ceiling, which is how coreutils arrives at its figure (82.4977%
 * prints as 83%, not 82%). The guard escalates on the Use% it is handed, so a
 * stub whose percentage contradicts the byte columns beside it would make every
 * level assertion in this file meaningless.
 *
 * `usePct: N` overrides that, for the cases where the point under test is what
 * the guard does when df's own column is unusable.
 *
 * `broken: true` makes the stub fail the way an unmounted or unreadable volume
 * does, which is how we exercise the measurement-failure path.
 */
function installDfStub(sandbox, { size, used, avail, broken = false, usePct }) {
  const pct =
    usePct !== undefined
      ? usePct
      : Math.ceil((100 * used) / (used + avail || 1));
  const lines = broken
    ? "#!/bin/sh\nexit 1\n"
    : [
        "#!/bin/sh",
        'echo "Filesystem 1024-blocks Used Available Capacity Mounted on"',
        `echo "stub ${size} ${used} ${avail} ${pct}% /mnt"`,
        "",
      ].join("\n");
  const stub = path.join(sandbox.binDir, "df");
  writeFileSync(stub, lines, { mode: 0o755 });
  return stub;
}

function run(sandbox, args, env = {}) {
  const result = spawnSync("bash", [SCRIPT, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${sandbox.binDir}:${process.env.PATH}`,
      DISK_GUARD_MOUNT: sandbox.mount,
      DISK_GUARD_STATUS_FILE: sandbox.statusFile,
      DISK_GUARD_COMPANY_ID: "company-1",
      DISK_GUARD_WORKSPACES_DIR: path.join(sandbox.mount, "instances/default/workspaces"),
      DISK_GUARD_PROJECT_REPO: COMPANY_PROJECT_REPO,
      ...env,
    },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function seed(sandbox, relPath, sizeBytes) {
  const full = path.join(sandbox.mount, relPath);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, Buffer.alloc(sizeBytes));
  return full;
}

function exists(sandbox, relPath) {
  return existsSync(path.join(sandbox.mount, relPath));
}

function installPaperclipApiStub(sandbox, { roster = ["agent-1"], issues = { "DEF-1": "done" }, ignoreQuery = false } = {}) {
  const stub = path.join(sandbox.binDir, "paperclip-api-stub.mjs");
  const body = [
    "#!/usr/bin/env node",
    `const roster = ${JSON.stringify(roster)};`,
    `const issues = ${JSON.stringify(issues)};`,
    "const requestPath = process.argv[2] || '';",
    "if (requestPath.includes('/agents')) { console.log(JSON.stringify(roster.map((id) => ({ id })))); process.exit(0); }",
    `const ignoreQuery = ${JSON.stringify(ignoreQuery)};`,
    "const match = requestPath.match(/[?&]q=([^&]+)/);",
    "const identifier = match ? decodeURIComponent(match[1]) : '';",
    "if (ignoreQuery) { console.log(JSON.stringify({ items: [{ identifier: 'DEF-999', status: 'done' }] })); process.exit(0); }",
    "const status = issues[identifier] || 'todo';",
    "console.log(JSON.stringify({ items: [{ identifier, status }] }));",
    "",
  ].join("\n");
  writeFileSync(stub, body);
  chmodSync(stub, 0o755);
  return stub;
}

/**
 * Initialise a git clone at `dir` with an `origin` remote. `origin: false` leaves
 * the clone with no remote, which is a third case gate 2 must refuse rather than
 * guess at: a checkout with no remote and no company clone to resolve through
 * has no repository identity to corroborate anything against.
 */
function seedGitClone(dir, { origin = COMPANY_PROJECT_REPO } = {}) {
  mkdirSync(dir, { recursive: true });
  spawnSync("git", ["init", "-q"], { cwd: dir });
  spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "Test"], { cwd: dir });
  if (origin !== false) {
    spawnSync("git", ["remote", "add", "origin", origin], { cwd: dir });
  }
  return dir;
}

/**
 * Seed a roster workspace checkout at
 * `$MOUNT/instances/default/workspaces/<agentId>/<checkoutName>`.
 *
 * Gate 2 resolves the owning issue from git metadata, so the shape of the seed
 * matters as much as its size:
 *
 *   `origin`        the checkout's `origin` remote URL. Defaults to the company
 *                   project repo, which is the only value that may be reclaimed.
 *                   Pass another URL to model a checkout of a foreign repo, or
 *                   `false` for a checkout with no `origin` at all.
 *   `dirIssue`      the ticket token written into the directory name, which
 *                   gate 2 corroborates the branch against. Defaults to `issue`.
 *   `branchName`    the branch to check out. Defaults to `issue` lowercased, which
 *                   agrees with the directory name. Pass a branch naming a
 *                   different ticket to model a renamed or shared branch.
 *   `linked`        register the checkout as a worktree of `baseClone` instead of
 *                   leaving it an independent clone, so the git-common-dir gate
 *                   has something inside the company clone to resolve to.
 */
function seedWorkspaceCheckout(sandbox, { agentId = "agent-1", checkoutName = "repo", issue = "DEF-1", rel = "client/target", ignored = true, tracked = false, fresh = false, worktree = false, origin = COMPANY_PROJECT_REPO, dirIssue, branchName, linked = false } = {}) {
  const workspace = path.join(sandbox.mount, "instances/default/workspaces", agentId);
  const checkout = worktree
    ? path.join(workspace, "repo", ".paperclip", "worktrees", checkoutName)
    : path.join(workspace, checkoutName);
  const branch = branchName ?? issue.toLowerCase();
  if (worktree) {
    const base = path.join(workspace, "repo");
    seedGitClone(base, { origin });
    writeFileSync(path.join(base, "README.md"), "test\n");
    spawnSync("git", ["add", "README.md"], { cwd: base });
    spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: base });
    mkdirSync(path.dirname(checkout), { recursive: true });
    spawnSync("git", ["worktree", "add", "-q", "-b", branch, checkout, "HEAD"], { cwd: base });
  } else {
    mkdirSync(checkout, { recursive: true });
    if (linked) {
      // Register with a base clone so `rev-parse --git-common-dir` resolves into
      // the company clone rather than to the checkout's own .git.
      const baseClone = path.join(sandbox.root, "clones", checkoutName);
      seedGitClone(baseClone, { origin });
      writeFileSync(path.join(baseClone, "README.md"), "test\n");
      spawnSync("git", ["add", "README.md"], { cwd: baseClone });
      spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: baseClone });
      spawnSync("git", ["worktree", "add", "-q", "-b", branch, checkout, "HEAD"], { cwd: baseClone });
    } else {
      seedGitClone(checkout, { origin });
      spawnSync("git", ["checkout", "-q", "-b", branch], { cwd: checkout });
    }
  }
  if (ignored) writeFileSync(path.join(checkout, ".gitignore"), `${rel}\n`);
  const full = path.join(checkout, rel, "blob");
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, Buffer.alloc(2 * MIB));
  if (tracked) {
    spawnSync("git", ["add", "-f", path.join(rel, "blob")], { cwd: checkout });
  }
  if (!fresh) {
    const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    utimesSync(full, old, old);
    utimesSync(path.dirname(full), old, old);
    utimesSync(path.join(checkout, rel), old, old);
  }
  return { checkout, full };
}

/**
 * Seed `$MOUNT/cargo-target-shared/<name>/blob`. The shared cargo target root is
 * the guard's second deletion-capable path, and it resolves the owning issue
 * from an in-band marker rather than from the directory name, so its gates need
 * their own coverage.
 *
 * `marker` is what gets written to the ownership marker file: a string to
 * attribute the dir, `false` to write no marker at all, `true` for a marker that
 * agrees with the directory name.
 */
function seedCargoTarget(sandbox, { name, fresh = false, symlink = false, marker = true } = {}) {
  const root = path.join(sandbox.mount, "cargo-target-shared");
  const full = path.join(root, name, "blob");
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, Buffer.alloc(2 * MIB));
  if (marker !== false) {
    const owner = marker === true
      ? name.replace(/^([a-z]+)-([0-9]+)$/, (_m, k, n) => `${k.toUpperCase()}-${n}`)
      : marker;
    const markerFile = path.join(path.dirname(full), ".paperclip-owner");
    writeFileSync(markerFile, `${owner}\n`);
    if (!fresh) {
      const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
      utimesSync(markerFile, old, old);
    }
  }
  if (!fresh) {
    const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    utimesSync(full, old, old);
    utimesSync(path.dirname(full), old, old);
    utimesSync(path.join(root, name), old, old);
  }
  if (symlink) {
    const outside = path.join(sandbox.root, "outside-cargo-target");
    mkdirSync(outside, { recursive: true });
    renameSync(path.dirname(full), path.join(outside, "real"));
    rmSync(path.join(sandbox.mount, "cargo-target-shared", name), { recursive: true, force: true });
    symlinkSync(path.join(outside, "real"), path.join(root, name));
  }
  return full;
}

/**
 * Seed `$MOUNT/cargo-target-shared/<name>/blob` for a shared, non-per-issue dir.
 * Unlike seedCargoTarget this writes no ownership marker: a shared dir has no
 * issue to attribute, so the marker gate does not apply to it.
 */
function seedSharedCargoTarget(sandbox, { name, fresh = false, symlink = false } = {}) {
  const root = path.join(sandbox.mount, "cargo-target-shared");
  const full = path.join(root, name, "blob");
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, Buffer.alloc(2 * MIB));
  if (!fresh) {
    const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    utimesSync(full, old, old);
    utimesSync(path.dirname(full), old, old);
    utimesSync(path.join(root, name), old, old);
  }
  if (symlink) {
    const outside = path.join(sandbox.root, "outside-cargo-target");
    mkdirSync(outside, { recursive: true });
    renameSync(path.dirname(full), path.join(outside, "real"));
    rmSync(path.join(sandbox.mount, "cargo-target-shared", name), { recursive: true, force: true });
    symlinkSync(path.join(outside, "real"), path.join(root, name));
  }
  return full;
}

/** Total bytes of file content under `dir`, used to assert prune freed nothing. */
function treeBytes(dir) {
  const result = spawnSync("find", [dir, "-type", "f", "-printf", "%s\n"], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`find failed: ${result.stderr}`);
  return result.stdout
    .split("\n")
    .filter((line) => line.trim() !== "")
    .reduce((sum, line) => sum + Number(line), 0);
}

test("threshold and floor logic: WARN_PCT=1 yields rc=2", () => {
  const sandbox = makeSandbox();
  try {
    installDfStub(sandbox, { size: 100 * 1024 * MIB, used: 5 * 1024 * MIB, avail: 95 * 1024 * MIB });
    const result = run(sandbox, ["--check"], { DISK_GUARD_WARN_PCT: "1", DISK_GUARD_MIN_FREE_MB: "0" });
    assert.equal(result.status, RC_WARN);
    assert.match(result.stdout, /level=warn/);
  } finally {
    sandbox.cleanup();
  }
});

test("threshold and floor logic: CRIT_PCT=1 yields rc=3", () => {
  const sandbox = makeSandbox();
  try {
    installDfStub(sandbox, { size: 100 * 1024 * MIB, used: 5 * 1024 * MIB, avail: 95 * 1024 * MIB });
    const result = run(sandbox, ["--check"], { DISK_GUARD_CRIT_PCT: "1", DISK_GUARD_MIN_FREE_MB: "0" });
    assert.equal(result.status, RC_CRITICAL);
    assert.match(result.stdout, /level=critical/);
  } finally {
    sandbox.cleanup();
  }
});

test("a healthy volume under both thresholds yields rc=0", () => {
  const sandbox = makeSandbox();
  try {
    installDfStub(sandbox, { size: 100 * 1024 * MIB, used: 5 * 1024 * MIB, avail: 95 * 1024 * MIB });
    const result = run(sandbox, ["--check"]);
    assert.equal(result.status, RC_OK);
    assert.match(result.stdout, /level=ok/);
  } finally {
    sandbox.cleanup();
  }
});

test("use_pct equals the Use% df itself prints, not a truncated recomputation", () => {
  // The /paperclip PVC as measured on 2026-10-03: df printed Use%=83 while the
  // guard published use_pct=77/82. The disagreement was truncation against total
  // blocks versus df's rounding against used+avail, and it read as a 6-point
  // drift to anyone cross-checking the status file (DEF-291). A guard is only
  // trustworthy if the number an operator can reproduce with `df -h /paperclip`
  // is the number the guard escalated on, so pin them together here.
  const sandbox = makeSandbox();
  try {
    const size = 211182436352;
    const used = 174206820352;
    const avail = 36958838784;
    // 82.498% of used+avail: truncating against total blocks gives 82, df
    // rounds to 83. The stub emits the df-accurate 83.
    installDfStub(sandbox, { size, used, avail });
    const result = run(sandbox, ["--check"]);
    // stdout carries the operator summary, the status file the key/value form.
    assert.match(result.stdout, />83%\)/);
    assert.match(result.stdout, /level=ok/);

    const status = readFileSync(sandbox.statusFile, "utf8");
    assert.match(status, /^use_pct=83$/m);
  } finally {
    sandbox.cleanup();
  }
});

test("a df that omits Use% still measures from the byte columns", () => {
  // Falling back must not turn into failing to measure: the byte columns are
  // always present, so a blank or zero percentage still yields a real level
  // rather than a spurious measurement error.
  const sandbox = makeSandbox();
  try {
    installDfStub(sandbox, { size: 100 * 1024 * MIB, used: 5 * 1024 * MIB, avail: 95 * 1024 * MIB, usePct: 0 });
    const result = run(sandbox, ["--check"]);
    assert.equal(result.status, RC_OK);
    assert.match(result.stdout, />5%\)/);
    assert.doesNotMatch(result.stderr, /cannot measure/);
  } finally {
    sandbox.cleanup();
  }
});

test("a MIN_FREE_MB above available free space trips warn even at low usage", () => {
  const sandbox = makeSandbox();
  try {
    // 5% used, so percentage is nowhere near WARN_PCT=88. Only the free-space
    // floor can make this warn.
    installDfStub(sandbox, { size: 100 * 1024 * MIB, used: 5 * 1024 * MIB, avail: 2 * 1024 * MIB });
    const result = run(sandbox, ["--check"], { DISK_GUARD_MIN_FREE_MB: "100000" });
    assert.equal(result.status, RC_WARN);
    assert.match(result.stdout, /level=warn/);
  } finally {
    sandbox.cleanup();
  }
});

test("MIN_FREE_MB=0 disables the floor, leaving percentage as the only signal", () => {
  const sandbox = makeSandbox();
  try {
    // Same starved free space as above, but the floor is disabled.
    installDfStub(sandbox, { size: 100 * 1024 * MIB, used: 5 * 1024 * MIB, avail: 2 * 1024 * MIB });
    const result = run(sandbox, ["--check"], { DISK_GUARD_MIN_FREE_MB: "0" });
    assert.equal(result.status, RC_OK);
    assert.match(result.stdout, /level=ok/);
    assert.match(result.stdout, /floor=0MiB/);
  } finally {
    sandbox.cleanup();
  }
});

test("unparseable usage is a measurement error (rc=1), not a pressure signal", () => {
  const sandbox = makeSandbox();
  try {
    // An unreadable/unmounted volume makes df produce no usable row. This must
    // not be reported as ok/warn: the guard simply could not measure.
    installDfStub(sandbox, { broken: true });
    const result = run(sandbox, ["--check"]);
    assert.equal(result.status, RC_ERROR);
    assert.doesNotMatch(result.stdout, /level=/, "must not publish a level it could not measure");
    assert.match(result.stderr, /cannot measure/);
  } finally {
    sandbox.cleanup();
  }
});

test("an unknown mode is a usage error (rc=1)", () => {
  const sandbox = makeSandbox();
  try {
    installDfStub(sandbox, { size: 100 * 1024 * MIB, used: 5 * 1024 * MIB, avail: 95 * 1024 * MIB });
    const result = run(sandbox, ["--bogus"]);
    assert.equal(result.status, RC_ERROR);
    assert.match(result.stderr, /usage: disk-guard\.sh/);
  } finally {
    sandbox.cleanup();
  }
});

test("--status reads the durable state file written by a previous --check", () => {
  const sandbox = makeSandbox();
  try {
    installDfStub(sandbox, { size: 100 * 1024 * MIB, used: 5 * 1024 * MIB, avail: 95 * 1024 * MIB });
    run(sandbox, ["--check"]);
    const result = run(sandbox, ["--status"]);
    assert.equal(result.status, RC_OK);
    assert.match(result.stdout, /^mount=/m);
    assert.match(result.stdout, /^level=ok$/m);
  } finally {
    sandbox.cleanup();
  }
});

test("allowlist: prune deletes only the approved cache paths", () => {
  const sandbox = makeSandbox();
  try {
    // Force pressure so prune is allowed to run at all; CRIT_PCT=1 guarantees
    // critical regardless of the stub's numbers.
    installDfStub(sandbox, { size: 100 * 1024 * MIB, used: 5 * 1024 * MIB, avail: 95 * 1024 * MIB });
    const approved = [
      ".cache/node/blob",
      ".cache/zig/blob",
      ".cache/opencode/blob",
      ".cache/pnpm/blob",
      ".cache/ms-playwright/blob",
      ".npm/_cacache/blob",
      ".npm/_npx/blob",
    ];
    const forbidden = [
      "instances/default/keep",
      "wt/repo/keep",
      "opencode.db",
      "opencode.db-wal",
      ".nix-portable/store/keep",
      ".rustup/toolchains/keep",
      ".local/share/opencode/opencode.db",
      ".local/share/opencode/opencode.db-wal",
      ".local/share/pnpm/store/blob",
    ];
    for (const rel of [...approved, ...forbidden]) {
      seed(sandbox, rel, 3 * MIB);
    }

    const result = run(sandbox, ["--prune"], { DISK_GUARD_CRIT_PCT: "1" });
    assert.equal(result.status, RC_CRITICAL);

    for (const rel of approved) {
      assert.ok(!exists(sandbox, rel), `expected ${rel} to be pruned`);
    }
    for (const rel of forbidden) {
      assert.ok(exists(sandbox, rel), `expected ${rel} to survive the prune`);
    }
  } finally {
    sandbox.cleanup();
  }
});

test("allowlist: prune only removes rotated logs (mtime>1d) from the log dir", () => {
  const sandbox = makeSandbox();
  try {
    installDfStub(sandbox, { size: 100 * 1024 * MIB, used: 5 * 1024 * MIB, avail: 95 * 1024 * MIB });
    const oldLog = seed(sandbox, ".local/share/opencode/log/old.log", 2 * MIB);
    const freshLog = seed(sandbox, ".local/share/opencode/log/fresh.log", 2 * MIB);
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    utimesSync(oldLog, threeDaysAgo, threeDaysAgo);

    const result = run(sandbox, ["--prune"], { DISK_GUARD_CRIT_PCT: "1" });
    assert.equal(result.status, RC_CRITICAL);
    assert.ok(!existsSync(oldLog), "expected the rotated log to be deleted");
    assert.ok(existsSync(freshLog), "expected the current log to be kept");
  } finally {
    sandbox.cleanup();
  }
});

test("nlink gate: a cache hardlinked into a live node_modules is skipped, not deleted", () => {
  const sandbox = makeSandbox();
  try {
    installDfStub(sandbox, { size: 100 * 1024 * MIB, used: 5 * 1024 * MIB, avail: 95 * 1024 * MIB });
    // .cache/pnpm is on the prune allowlist, so the gate is what stands between
    // it and deletion: its inodes are shared with a live node_modules tree, so
    // reclaim measured with `-links 1` is 0 and the path must take the skip
    // branch. This mirrors the real volume, where the analogous pnpm store
    // frees only ~15M while breaking hardlink dedup.
    const liveBlob = seed(sandbox, "live/node_modules/dep/blob", 5 * MIB);
    const cacheBlob = path.join(sandbox.mount, ".cache/pnpm/store/blob");
    mkdirSync(path.dirname(cacheBlob), { recursive: true });
    linkSync(liveBlob, cacheBlob);

    const result = run(sandbox, ["--prune"], { DISK_GUARD_CRIT_PCT: "1" });
    assert.equal(result.status, RC_CRITICAL);
    assert.ok(existsSync(cacheBlob), "hardlinked cache must survive (skip branch)");
    assert.ok(existsSync(liveBlob), "the live tree sharing the inode must survive");
    assert.match(result.stderr, /skip .*\.cache\/pnpm \(only 0KiB unlinked-reclaimable\)/);
  } finally {
    sandbox.cleanup();
  }
});

test("nlink gate: the same allowlisted cache with its own inodes is pruned", () => {
  const sandbox = makeSandbox();
  try {
    installDfStub(sandbox, { size: 100 * 1024 * MIB, used: 5 * 1024 * MIB, avail: 95 * 1024 * MIB });
    // Control case for the test above: identical path and size, but nlink==1,
    // so it is genuinely reclaimable and must be deleted. Without this, the
    // skip branch could pass simply because the path was mis-seeded.
    const cacheBlob = seed(sandbox, ".cache/pnpm/blob", 5 * MIB);
    const bytesBefore = treeBytes(sandbox.mount);

    const result = run(sandbox, ["--prune"], { DISK_GUARD_CRIT_PCT: "1" });
    assert.equal(result.status, RC_CRITICAL);
    assert.ok(!existsSync(cacheBlob), "an unhardlinked cache must be pruned");
    assert.ok(
      treeBytes(sandbox.mount) < bytesBefore,
      "pruning must actually reclaim the space it reported",
    );
  } finally {
    sandbox.cleanup();
  }
});

test("prune is a no-op at level=ok: nothing is deleted and exactly 0 bytes are freed", () => {
  const sandbox = makeSandbox();
  try {
    installDfStub(sandbox, { size: 100 * 1024 * MIB, used: 5 * 1024 * MIB, avail: 95 * 1024 * MIB });
    const cacheBlob = seed(sandbox, ".cache/node/blob", 3 * MIB);
    const logBlob = seed(sandbox, ".local/share/opencode/log/old.log", 2 * MIB);
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    utimesSync(logBlob, threeDaysAgo, threeDaysAgo);
    const bytesBefore = treeBytes(sandbox.mount);

    const result = run(sandbox, ["--prune"], { DISK_GUARD_CRIT_PCT: "99" });
    assert.equal(result.status, RC_OK);
    assert.match(result.stdout, /prune_skipped=level_ok/);
    // The skip path returns before prune prints its reclaimed_mib line, so
    // measure the tree directly: 0 bytes freed is the property under test.
    assert.equal(treeBytes(sandbox.mount) - bytesBefore, 0, "prune must free exactly 0 bytes at level=ok");
    assert.ok(existsSync(cacheBlob), "cache must be untouched when there is no pressure");
    assert.ok(existsSync(logBlob), "logs must be untouched when there is no pressure");
  } finally {
    sandbox.cleanup();
  }
});

test("workspace scope: closed issue build output is pruned and failing gates survive", () => {
  const sandbox = makeSandbox();
  try {
    installDfStub(sandbox, { size: 100 * 1024 * MIB, used: 5 * 1024 * MIB, avail: 95 * 1024 * MIB });
    const apiStub = installPaperclipApiStub(sandbox, {
      roster: ["agent-1"],
      issues: { "DEF-1": "done", "DEF-2": "todo", "DEF-3": "done", "DEF-4": "done", "DEF-5": "done", "DEF-6": "done" },
    });
    const closed = seedWorkspaceCheckout(sandbox, { checkoutName: "def-1-closed", issue: "DEF-1" });
    const open = seedWorkspaceCheckout(sandbox, { checkoutName: "def-2-open", issue: "DEF-2" });
    const tracked = seedWorkspaceCheckout(sandbox, { checkoutName: "def-3-tracked", issue: "DEF-3", tracked: true });
    const notIgnored = seedWorkspaceCheckout(sandbox, { checkoutName: "def-4-not-ignored", issue: "DEF-4", ignored: false });
    const fresh = seedWorkspaceCheckout(sandbox, { checkoutName: "def-5-fresh", issue: "DEF-5", fresh: true });
    const outsider = seedWorkspaceCheckout(sandbox, { agentId: "agent-2", checkoutName: "def-6-outsider", issue: "DEF-6" });

    const result = run(sandbox, ["--prune"], { DISK_GUARD_CRIT_PCT: "1", DISK_GUARD_API_STUB: apiStub });
    assert.equal(result.status, RC_CRITICAL);
    assert.ok(!existsSync(closed.full), "closed issue build output in a roster workspace must be pruned");
    assert.ok(existsSync(open.full), "open issue build output must survive");
    assert.ok(existsSync(tracked.full), "tracked build output must survive");
    assert.ok(existsSync(notIgnored.full), "non-gitignored build output must survive");
    assert.ok(existsSync(fresh.full), "fresh build output must survive");
    assert.ok(existsSync(outsider.full), "workspace outside the company roster must survive");
  } finally {
    sandbox.cleanup();
  }
});

test("workspace scope: ignored issue filters and rejects mismatched issue identifiers", () => {
  const sandbox = makeSandbox();
  try {
    installDfStub(sandbox, { size: 100 * 1024 * MIB, used: 5 * 1024 * MIB, avail: 95 * 1024 * MIB });
    const apiStub = installPaperclipApiStub(sandbox, { roster: ["agent-1"], ignoreQuery: true });
    const checkout = seedWorkspaceCheckout(sandbox, { checkoutName: "def-7-mismatch", issue: "DEF-7" });

    const result = run(sandbox, ["--prune"], { DISK_GUARD_CRIT_PCT: "1", DISK_GUARD_API_STUB: apiStub });
    assert.equal(result.status, RC_CRITICAL);
    assert.ok(existsSync(checkout.full), "mismatched API results must not authorize deletion");
  } finally {
    sandbox.cleanup();
  }
});

test("workspace scope: linked worktrees with .git files are scanned", () => {
  const sandbox = makeSandbox();
  try {
    installDfStub(sandbox, { size: 100 * 1024 * MIB, used: 5 * 1024 * MIB, avail: 95 * 1024 * MIB });
    const apiStub = installPaperclipApiStub(sandbox, { roster: ["agent-1"], issues: { "DEF-8": "done" } });
    const checkout = seedWorkspaceCheckout(sandbox, { checkoutName: "def-8-linked", issue: "DEF-8", worktree: true });

    const result = run(sandbox, ["--prune"], { DISK_GUARD_CRIT_PCT: "1", DISK_GUARD_API_STUB: apiStub });
    assert.equal(result.status, RC_CRITICAL);
    assert.ok(!existsSync(checkout.full), "linked worktree build output must be pruned when all gates pass");
  } finally {
    sandbox.cleanup();
  }
});

/*
 * Gate 2: which issue owns this checkout, and therefore whether the issue is
 * terminal and its build output may be deleted.
 *
 * Every test in this block fails against the branch-name regex this gate used to
 * be: a `sed -nE` substitution matching a `[A-Za-z]+-[0-9]+` token anywhere in
 * `git branch --show-current` and upper-casing it, which reads the owning issue
 * out of a label a person typed. A regex is right whenever the branch happens to
 * be well-named, which is precisely when its answer does not matter.
 */

test("gate 2: a branch whose ticket disagrees with the directory name is not reclaimed", () => {
  const sandbox = makeSandbox();
  try {
    installDfStub(sandbox, { size: 100 * 1024 * MIB, used: 5 * 1024 * MIB, avail: 95 * 1024 * MIB });
    // Every issue the branch names is terminal, so the only thing standing
    // between this checkout and deletion is that its two identity signals
    // disagree. Under the old regex the branch alone decided, and DEF-41 won.
    const apiStub = installPaperclipApiStub(sandbox, {
      roster: ["agent-1"],
      issues: { "DEF-41": "done", "DEF-40": "done" },
    });
    const divergent = seedWorkspaceCheckout(sandbox, {
      checkoutName: "def-40-thing",
      dirIssue: "DEF-40",
      branchName: "def-41-thing",
    });

    const result = run(sandbox, ["--prune"], { DISK_GUARD_CRIT_PCT: "1", DISK_GUARD_API_STUB: apiStub });
    assert.equal(result.status, RC_CRITICAL);
    assert.ok(
      existsSync(divergent.full),
      "a checkout whose branch names a different issue than its directory must not be reclaimed",
    );
    // Assert the gate's own refusal, not just survival: the build output is
    // gitignored, untracked and stale, so only gate 2 can be holding it.
    assert.match(
      result.stderr,
      /branch says 'DEF-41', directory says 'DEF-40'/,
      "the disagreement must be reported, not silently skipped",
    );
  } finally {
    sandbox.cleanup();
  }
});

test("gate 2: a checkout of a foreign repo naming one of our terminal issues is not reclaimed", () => {
  const sandbox = makeSandbox();
  try {
    installDfStub(sandbox, { size: 100 * 1024 * MIB, used: 5 * 1024 * MIB, avail: 95 * 1024 * MIB });
    // The branch names a terminal issue of *our* company while the repository is
    // somebody else's. This is the live pc-guard shape with the branch renamed,
    // and it is the cross-repo deletion class CON-375 exists to prevent.
    const apiStub = installPaperclipApiStub(sandbox, { roster: ["agent-1"], issues: { "DEF-139": "done" } });
    const foreign = seedWorkspaceCheckout(sandbox, {
      checkoutName: "pc-guard",
      dirIssue: "DEF-139",
      branchName: "def-139-fix-paperclip-node-modules",
      origin: FOREIGN_REPO,
    });

    const result = run(sandbox, ["--prune"], { DISK_GUARD_CRIT_PCT: "1", DISK_GUARD_API_STUB: apiStub });
    assert.equal(result.status, RC_CRITICAL);
    assert.ok(
      existsSync(foreign.full),
      "build output in a checkout of another repository must never be reclaimed against our issue API",
    );
    assert.match(
      result.stderr,
      /is not the company project repo/,
      "a repo-identity mismatch must be refused with its reason logged",
    );
  } finally {
    sandbox.cleanup();
  }
});

test("gate 2: a checkout whose issue cannot be established is skipped, not guessed", () => {
  const sandbox = makeSandbox();
  try {
    installDfStub(sandbox, { size: 100 * 1024 * MIB, used: 5 * 1024 * MIB, avail: 95 * 1024 * MIB });
    // DEF-51 is terminal. The first checkout has no origin and no company clone
    // to resolve through, so nothing binds it to a repository at all; the second
    // is a detached HEAD, so there is no branch to corroborate a directory name
    // against. Both look reclaimable to a regex and to a terminality query.
    const apiStub = installPaperclipApiStub(sandbox, {
      roster: ["agent-1"],
      issues: { "DEF-51": "done", "DEF-52": "done" },
    });
    const noOrigin = seedWorkspaceCheckout(sandbox, {
      checkoutName: "def-51-orphan",
      dirIssue: "DEF-51",
      branchName: "def-51-orphan",
      origin: false,
    });
    const detached = seedWorkspaceCheckout(sandbox, {
      checkoutName: "def-52-detached",
      dirIssue: "DEF-52",
      branchName: "def-52-detached",
      linked: true,
    });
    // A worktree whose branch is gone reads as a detached HEAD: there is no
    // branch left to agree with the directory name, so identity cannot be
    // established even though the repository is ours.
    spawnSync("git", ["checkout", "-q", "--detach", "HEAD"], { cwd: detached.checkout });

    const result = run(sandbox, ["--prune"], { DISK_GUARD_CRIT_PCT: "1", DISK_GUARD_API_STUB: apiStub });
    assert.equal(result.status, RC_CRITICAL);
    assert.ok(existsSync(noOrigin.full), "a checkout with no repository identity must survive");
    assert.ok(existsSync(detached.full), "a checkout with no branch to corroborate against must survive");
    assert.match(
      result.stderr,
      /cannot establish the repository identity/,
      "unestablished identity must be reported with a reason",
    );
  } finally {
    sandbox.cleanup();
  }
});

test("gate 2: the 3.3G live case is refused with a reason naming identity, not skipped silently", () => {
  const sandbox = makeSandbox();
  try {
    // The real /paperclip measurement this gate was written for: a stale,
    // gitignored, untracked 3.3G client/target under a roster workspace whose
    // branch reads DEF-235. Every other gate passes; gate 2 is the only thing
    // that can hold it.
    installDfStub(sandbox, { size: 100 * 1024 * MIB, used: 5 * 1024 * MIB, avail: 95 * 1024 * MIB });
    const apiStub = installPaperclipApiStub(sandbox, { roster: ["agent-1"], issues: { "DEF-235": "blocked" } });
    const live = seedWorkspaceCheckout(sandbox, {
      checkoutName: "def-235-eventbus-lagged",
      dirIssue: "DEF-235",
      branchName: "fix/def-235-eventbus-lagged",
    });

    const result = run(sandbox, ["--prune"], { DISK_GUARD_CRIT_PCT: "1", DISK_GUARD_API_STUB: apiStub });
    assert.equal(result.status, RC_CRITICAL);
    assert.ok(existsSync(live.full), "the 3.3G live case must not be reclaimed");
    assert.match(result.stderr, /def-235-eventbus-lagged\/client\/target/);
    // Whatever the reason, it must be a decision gate 2 made and reported. A
    // silent skip is the failure mode this issue exists to close: it reads as
    // "nothing here to reclaim" rather than "the guard declined to attribute it".
    assert.match(
      result.stderr,
      /identity|issue DEF-235 is not terminal/,
      "the refusal must name the identity decision that produced it",
    );
    assert.doesNotMatch(
      result.stderr,
      /dry-run rm -rf .*def-235-eventbus-lagged/,
      "the 3.3G live case must never reach the removal path",
    );
  } finally {
    sandbox.cleanup();
  }
});

test("gate 2: agreeing name, branch and origin still reclaim a worktree inside the company clone", () => {
  const sandbox = makeSandbox();
  try {
    installDfStub(sandbox, { size: 100 * 1024 * MIB, used: 5 * 1024 * MIB, avail: 95 * 1024 * MIB });
    const apiStub = installPaperclipApiStub(sandbox, { roster: ["agent-1"], issues: { "DEF-53": "done" } });
    // The positive control. If gate 2 could not resolve a well-formed checkout,
    // every test above would pass against a guard that reclaims nothing.
    const agreeing = seedWorkspaceCheckout(sandbox, {
      checkoutName: "def-53-agreeing",
      dirIssue: "DEF-53",
      branchName: "fix/def-53-agreeing",
      linked: true,
    });

    const result = run(sandbox, ["--prune"], { DISK_GUARD_CRIT_PCT: "1", DISK_GUARD_API_STUB: apiStub });
    assert.equal(result.status, RC_CRITICAL);
    assert.ok(
      !existsSync(agreeing.full),
      "a checkout whose name, branch and origin all agree must still be reclaimable",
    );
  } finally {
    sandbox.cleanup();
  }
});

test("workspace scope: directory names and symlinks do not authorize deletion", () => {
  const sandbox = makeSandbox();
  try {
    installDfStub(sandbox, { size: 100 * 1024 * MIB, used: 5 * 1024 * MIB, avail: 95 * 1024 * MIB });
    const apiStub = installPaperclipApiStub(sandbox, { roster: ["agent-1"], issues: { "DEF-9": "done", "DEF-10": "done" } });
    const branchOnly = seedWorkspaceCheckout(sandbox, { checkoutName: "def-9", issue: "feature-open" });
    const symlinkCheckout = seedWorkspaceCheckout(sandbox, { checkoutName: "def-10-symlink", issue: "DEF-10" });
    const outside = path.join(sandbox.mount, "outside");
    mkdirSync(outside);
    rmSync(path.dirname(symlinkCheckout.full), { recursive: true, force: true });
    symlinkSync(outside, path.dirname(symlinkCheckout.full));

    const result = run(sandbox, ["--prune"], { DISK_GUARD_CRIT_PCT: "1", DISK_GUARD_API_STUB: apiStub });
    assert.equal(result.status, RC_CRITICAL);
    assert.ok(existsSync(branchOnly.full), "checkout directory names must not determine issue ownership");
    assert.ok(existsSync(path.dirname(symlinkCheckout.full)), "symlinked candidates must survive");
  } finally {
    sandbox.cleanup();
  }
});

test("prune gates on this invocation's measured level instead of stale status", () => {
  const sandbox = makeSandbox();
  try {
    mkdirSync(path.dirname(sandbox.statusFile), { recursive: true });
    writeFileSync(sandbox.statusFile, "level=critical\n");
    installDfStub(sandbox, { size: 100 * 1024 * MIB, used: 5 * 1024 * MIB, avail: 95 * 1024 * MIB });
    const cacheBlob = seed(sandbox, ".cache/node/blob", 3 * MIB);

    const result = run(sandbox, ["--prune"], { DISK_GUARD_CRIT_PCT: "99" });
    assert.equal(result.status, RC_OK);
    assert.match(result.stdout, /prune_skipped=level_ok/);
    assert.ok(existsSync(cacheBlob), "stale critical status must not authorize pruning");
  } finally {
    sandbox.cleanup();
  }
});

test("prune fails closed when df is unusable, rather than trusting a stale status file", () => {
  const sandbox = makeSandbox();
  try {
    // A previous run left level=critical in the durable status file. If prune
    // trusted that stale reading while df was broken it would delete caches
    // without having measured anything.
    mkdirSync(path.dirname(sandbox.statusFile), { recursive: true });
    writeFileSync(sandbox.statusFile, "level=critical\n");
    const cacheBlob = seed(sandbox, ".cache/node/blob", 3 * MIB);
    installDfStub(sandbox, { broken: true });

    const result = run(sandbox, ["--prune"]);
    assert.equal(result.status, RC_ERROR);
    assert.match(result.stdout, /prune_skipped=measurement_failed/);
    assert.ok(existsSync(cacheBlob), "cache must survive an unmeasurable run");
  } finally {
    sandbox.cleanup();
  }
});

test("cargo target scope: closed issue target dir is pruned and failing gates survive", () => {
  const sandbox = makeSandbox();
  try {
    installDfStub(sandbox, { size: 100 * 1024 * MIB, used: 5 * 1024 * MIB, avail: 95 * 1024 * MIB });
    const apiStub = installPaperclipApiStub(sandbox, {
      roster: ["agent-1"],
      issues: { "DEF-1": "done", "DEF-2": "todo", "DEF-3": "done", "DEF-4": "done", "DEF-5": "done", "DEF-6": "done", "DEF-7": "done", "DEF-8": "done" },
    });
    // The root dir name is lowercased on disk and uppercased by the script, so
    // "def-1" must still resolve to the DEF-1 issue in the control plane.
    const closed = seedCargoTarget(sandbox, { name: "def-1" });
    const open = seedCargoTarget(sandbox, { name: "def-2" });
    const fresh = seedCargoTarget(sandbox, { name: "def-3", fresh: true });
    const unnamed = seedCargoTarget(sandbox, { name: "shared-fallback" });
    const unmarked = seedCargoTarget(sandbox, { name: "def-4", marker: false });
    const misattributed = seedCargoTarget(sandbox, { name: "def-5", marker: "DEF-6" });
    const symlink = seedCargoTarget(sandbox, { name: "def-7", symlink: true });
    // A marker that is itself a symlink would let a dir outside the mount
    // dictate what this one claims to own.
    const linkedMarker = seedCargoTarget(sandbox, { name: "def-8" });
    rmSync(path.join(path.dirname(linkedMarker), ".paperclip-owner"), { force: true });
    const outsideMarker = path.join(sandbox.root, "outside-marker");
    writeFileSync(outsideMarker, "DEF-8\n");
    const markerLink = path.join(path.dirname(linkedMarker), ".paperclip-owner");
    symlinkSync(outsideMarker, markerLink);
    // Age the link and its parent: creating the link refreshes the directory
    // mtime, and find reports it, so without this the min-age gate would skip
    // the dir and hide the result. find reports the symlink's own mtime, so
    // utimes on the link would age the target instead and not help.
    const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    lutimesSync(markerLink, old, old);
    lutimesSync(path.dirname(linkedMarker), old, old);

    const result = run(sandbox, ["--prune"], { DISK_GUARD_CRIT_PCT: "1", DISK_GUARD_API_STUB: apiStub });
    assert.equal(result.status, RC_CRITICAL);
    assert.ok(!existsSync(closed), "closed issue cargo target must be pruned");
    assert.ok(existsSync(open), "open issue cargo target must survive");
    assert.ok(existsSync(fresh), "cargo target under the min-age gate must survive");
    assert.ok(existsSync(unnamed), "a dir that is not named after an issue must survive");
    assert.ok(existsSync(unmarked), "a dir with no ownership marker must survive");
    assert.ok(existsSync(misattributed), "a dir whose marker names another issue must survive");
    assert.ok(existsSync(linkedMarker), "a symlinked ownership marker must survive");
    // Assert the gate's own refusal, not just that the file survived: `find
    // -xdev` and `rm -rf` both refuse to descend a symlink anyway, so survival
    // alone would not catch the symlink check being deleted.
    assert.match(result.stderr, /candidate is a symlink/);
    assert.match(result.stderr, /not a per-issue name, but named for a company or issue/);
    assert.match(result.stderr, /is not terminal/);
    assert.match(result.stderr, /no \.paperclip-owner ownership marker/);
    assert.match(result.stderr, /marker says 'DEF-6', dir says 'DEF-5'/);
  } finally {
    sandbox.cleanup();
  }
});

test("cargo target scope: a mis-named dir borrows no status from another issue", () => {
  const sandbox = makeSandbox();
  try {
    installDfStub(sandbox, { size: 100 * 1024 * MIB, used: 5 * 1024 * MIB, avail: 95 * 1024 * MIB });
    // The stub ignores the `q=` filter and answers with an unrelated issue that
    // happens to be done. Without an identifier match the guard must refuse.
    const apiStub = installPaperclipApiStub(sandbox, { roster: ["agent-1"], ignoreQuery: true });
    const target = seedCargoTarget(sandbox, { name: "def-1" });

    const result = run(sandbox, ["--prune"], { DISK_GUARD_CRIT_PCT: "1", DISK_GUARD_API_STUB: apiStub });
    assert.equal(result.status, RC_CRITICAL);
    assert.ok(existsSync(target), "mismatched API results must not authorize cargo target deletion");
  } finally {
    sandbox.cleanup();
  }
});

test("a missing company id is a loud prune error, not a wrong-tenant lookup", () => {
  const sandbox = makeSandbox();
  try {
    installDfStub(sandbox, { size: 100 * 1024 * MIB, used: 5 * 1024 * MIB, avail: 95 * 1024 * MIB });
    const cacheBlob = seed(sandbox, ".cache/node/blob", 3 * MIB);
    const env = { ...process.env };
    delete env.DISK_GUARD_COMPANY_ID;
    delete env.PAPERCLIP_COMPANY_ID;
    const base = {
      ...env,
      PATH: `${sandbox.binDir}:${env.PATH}`,
      DISK_GUARD_MOUNT: sandbox.mount,
      DISK_GUARD_STATUS_FILE: sandbox.statusFile,
      DISK_GUARD_CRIT_PCT: "1",
    };
    const result = spawnSync("bash", [SCRIPT, "--prune"], { encoding: "utf8", env: base });
    assert.equal(result.status, RC_ERROR);
    assert.match(result.stderr, /no company id/);
    assert.ok(existsSync(cacheBlob), "a prune with no company id must not delete anything");
  } finally {
    sandbox.cleanup();
  }
});

test("--check and --status work with no company id, because neither queries issues", () => {
  const sandbox = makeSandbox();
  try {
    installDfStub(sandbox, { size: 100 * 1024 * MIB, used: 5 * 1024 * MIB, avail: 95 * 1024 * MIB });
    const cacheBlob = seed(sandbox, ".cache/node/blob", 3 * MIB);
    const env = { ...process.env };
    delete env.DISK_GUARD_COMPANY_ID;
    delete env.PAPERCLIP_COMPANY_ID;
    const base = {
      ...env,
      PATH: `${sandbox.binDir}:${env.PATH}`,
      DISK_GUARD_MOUNT: sandbox.mount,
      DISK_GUARD_STATUS_FILE: sandbox.statusFile,
      DISK_GUARD_CRIT_PCT: "1",
    };
    // A guard that cannot measure pressure when the environment is incomplete is
    // worse than one that cannot reclaim: the blind spot is invisible until the
    // volume is already full.
    const check = spawnSync("bash", [SCRIPT, "--check"], { encoding: "utf8", env: base });
    assert.equal(check.status, RC_CRITICAL);
    assert.match(check.stdout, /level=critical/);
    const status = spawnSync("bash", [SCRIPT, "--status"], { encoding: "utf8", env: base });
    assert.equal(status.status, RC_OK);
    assert.match(status.stdout, /level=critical/);
    assert.ok(existsSync(cacheBlob), "monitoring must never delete");
  } finally {
    sandbox.cleanup();
  }
});

test("shared cargo target scope: a stale non-per-issue dir is a candidate and a fresh one is not", () => {
  const sandbox = makeSandbox();
  try {
    installDfStub(sandbox, { size: 100 * 1024 * MIB, used: 5 * 1024 * MIB, avail: 95 * 1024 * MIB });
    const apiStub = installPaperclipApiStub(sandbox, { roster: ["agent-1"], issues: { "DEF-1": "todo" } });
    // The two real shapes on the volume: `debug` is 7GiB of shared output and
    // `tmp` a smaller sibling, and neither names an issue, so the shared path
    // decides on age alone. A fresh one must be left alone.
    const stale = seedSharedCargoTarget(sandbox, { name: "debug" });
    const fresh = seedSharedCargoTarget(sandbox, { name: "tmp", fresh: true });
    const bytesBefore = treeBytes(sandbox.mount);

    const result = run(sandbox, ["--prune"], { DISK_GUARD_CRIT_PCT: "1", DISK_GUARD_API_STUB: apiStub });
    assert.equal(result.status, RC_CRITICAL);
    assert.ok(!existsSync(stale), "a stale shared cargo target must be pruned");
    assert.ok(existsSync(fresh), "a fresh shared cargo target must survive the age gate");
    assert.match(result.stderr, /tmp \(newest mtime under 24h\)/);
    assert.ok(
      treeBytes(sandbox.mount) < bytesBefore,
      "reclaiming a shared dir must actually free the space it reported",
    );
  } finally {
    sandbox.cleanup();
  }
});

test("shared cargo target scope: a name attributed to a company or issue is never a shared candidate", () => {
  const sandbox = makeSandbox();
  try {
    installDfStub(sandbox, { size: 100 * 1024 * MIB, used: 5 * 1024 * MIB, avail: 95 * 1024 * MIB });
    const apiStub = installPaperclipApiStub(sandbox, { roster: ["agent-1"], issues: { "DEF-1": "done" } });
    // These all fail the <PREFIX>-<number> shape, which is what routes a dir to
    // the shared path, but each names a company or issue and so is not shared
    // output. Reclaiming them here is the cross-company deletion CON-375 owns,
    // and DEF-1 being terminal must not be what stops it: no marker is written,
    // so these are unreclaimable on the per-issue path too.
    const suffixVariant = seedSharedCargoTarget(sandbox, { name: "def-129-base" });
    const doc = seedSharedCargoTarget(sandbox, { name: "def-doc" });
    const sibling = seedSharedCargoTarget(sandbox, { name: "def-129-cold" });

    const result = run(sandbox, ["--prune"], { DISK_GUARD_CRIT_PCT: "1", DISK_GUARD_API_STUB: apiStub });
    assert.equal(result.status, RC_CRITICAL);
    assert.ok(existsSync(suffixVariant), "a <PREFIX>-<number> variant must not be reclaimed as shared output");
    assert.ok(existsSync(doc), "a company-named dir must not be reclaimed as shared output");
    assert.ok(existsSync(sibling), "a second variant must not be reclaimed as shared output");
    assert.match(result.stderr, /named for a company or issue/);
  } finally {
    sandbox.cleanup();
  }
});

test("shared cargo target scope: a live cargo or rustc blocks the shared reclaim", () => {
  const sandbox = makeSandbox();
  try {
    installDfStub(sandbox, { size: 100 * 1024 * MIB, used: 5 * 1024 * MIB, avail: 95 * 1024 * MIB });
    const apiStub = installPaperclipApiStub(sandbox, { roster: ["agent-1"], issues: { "DEF-1": "todo" } });
    // A shared dir is likelier to be mid-build than a per-issue dir, because
    // every build in the company can point at it, so age alone is not enough to
    // call it idle. Shadow the process lister: the guard tries pgrep then pidof,
    // and installing a pgrep stub in the sandbox binDir makes it deterministic
    // regardless of what the host happens to be running.
    const running = path.join(sandbox.binDir, "pgrep");
    writeFileSync(running, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const target = seedSharedCargoTarget(sandbox, { name: "debug" });

    const result = run(sandbox, ["--prune"], { DISK_GUARD_CRIT_PCT: "1", DISK_GUARD_API_STUB: apiStub });
    assert.equal(result.status, RC_CRITICAL);
    assert.ok(existsSync(target), "a shared cargo target must survive while cargo or rustc is running");
    assert.match(result.stderr, /cargo or rustc is running/);
  } finally {
    sandbox.cleanup();
  }
});

test("shared cargo target scope: a broken process lister falls back to /proc and still catches a live build", () => {
  const sandbox = makeSandbox();
  try {
    installDfStub(sandbox, { size: 100 * 1024 * MIB, used: 5 * 1024 * MIB, avail: 95 * 1024 * MIB });
    const apiStub = installPaperclipApiStub(sandbox, { roster: ["agent-1"], issues: { "DEF-1": "todo" } });
    // pgrep is absent from several of the images this guard runs on, and an
    // erroring lister is not evidence of absence. The /proc scan is the real
    // fallback, so break both tools and start a process actually named cargo:
    // the dir must still be skipped. Without the fallback this would either
    // crash or treat the broken tool as "nothing is running" and delete a tree
    // a build is writing into.
    for (const tool of ["pgrep", "pidof"]) {
      writeFileSync(path.join(sandbox.binDir, tool), "#!/bin/sh\nexit 2\n", { mode: 0o755 });
    }
    // A binary whose own comm is literally "cargo", started detached so the
    // guard's own /proc scan can see it.
    const cargoBin = path.join(sandbox.binDir, "cargo");
    copyFileSync("/bin/sleep", cargoBin);
    const build = spawn(cargoBin, ["30"], { stdio: "ignore", detached: true });
    const target = seedSharedCargoTarget(sandbox, { name: "debug" });

    try {
      const result = run(sandbox, ["--prune"], { DISK_GUARD_CRIT_PCT: "1", DISK_GUARD_API_STUB: apiStub });
      assert.equal(result.status, RC_CRITICAL);
      assert.ok(existsSync(target), "a shared cargo target must survive while a cargo process is live");
      assert.match(result.stderr, /cargo or rustc is running/);
    } finally {
      try { process.kill(-build.pid); } catch { /* already gone */ }
    }
  } finally {
    sandbox.cleanup();
  }
});

test("shared cargo target scope: an unreadable process table skips the reclaim instead of deleting", () => {
  const sandbox = makeSandbox();
  try {
    installDfStub(sandbox, { size: 100 * 1024 * MIB, used: 5 * 1024 * MIB, avail: 95 * 1024 * MIB });
    const apiStub = installPaperclipApiStub(sandbox, { roster: ["agent-1"], issues: { "DEF-1": "todo" } });
    // cargo_rustc_running has three outcomes, and this is the third: every
    // lister is broken AND /proc cannot be read at all, so it cannot say
    // whether a build is writing into the tree. That is `return 2`, and the
    // only safe reading of it is "skip" -- the alternative bug is treating an
    // unreadable process table as "nothing is running" and reclaiming a
    // directory a live cargo is midway through filling.
    //
    // /proc is pointed at an empty directory: the fallback iterates
    // PROC_ROOT/[0-9]*/comm, finds no readable entry, and never sets seen=1,
    // which is exactly the "cannot tell" condition. A real /proc cannot be
    // emptied from an unprivileged container, so PROC_ROOT is the seam.
    const emptyProc = path.join(sandbox.root, "empty-proc");
    mkdirSync(emptyProc);
    for (const tool of ["pgrep", "pidof"]) {
      writeFileSync(path.join(sandbox.binDir, tool), "#!/bin/sh\nexit 2\n", { mode: 0o755 });
    }
    const target = seedSharedCargoTarget(sandbox, { name: "debug" });
    const bytesBefore = treeBytes(sandbox.mount);

    const result = run(sandbox, ["--prune"], {
      DISK_GUARD_CRIT_PCT: "1",
      DISK_GUARD_API_STUB: apiStub,
      DISK_GUARD_PROC_ROOT: emptyProc,
    });
    assert.equal(result.status, RC_CRITICAL, `expected a critical measurement, got ${result.status}: ${result.stderr}`);
    assert.ok(
      existsSync(target),
      "a shared cargo target must survive when the guard cannot tell whether a build is running",
    );
    assert.match(result.stderr, /cannot tell whether cargo or rustc is running/);
    assert.equal(treeBytes(sandbox.mount), bytesBefore, "an unreadable process table must free nothing");
  } finally {
    sandbox.cleanup();
  }
});

test("shared cargo target scope: a symlinked shared dir is never a candidate", () => {
  const sandbox = makeSandbox();
  try {
    installDfStub(sandbox, { size: 100 * 1024 * MIB, used: 5 * 1024 * MIB, avail: 95 * 1024 * MIB });
    const apiStub = installPaperclipApiStub(sandbox, { roster: ["agent-1"], issues: { "DEF-1": "todo" } });
    const link = seedSharedCargoTarget(sandbox, { name: "debug", symlink: true });

    const result = run(sandbox, ["--prune"], { DISK_GUARD_CRIT_PCT: "1", DISK_GUARD_API_STUB: apiStub });
    assert.equal(result.status, RC_CRITICAL);
    assert.ok(existsSync(link), "a symlinked shared dir must survive");
    assert.match(result.stderr, /candidate is a symlink/);
  } finally {
    sandbox.cleanup();
  }
});

test("shared cargo target scope: a hardlinked shared dir is skipped, not deleted", () => {
  const sandbox = makeSandbox();
  try {
    installDfStub(sandbox, { size: 100 * 1024 * MIB, used: 5 * 1024 * MIB, avail: 95 * 1024 * MIB });
    const apiStub = installPaperclipApiStub(sandbox, { roster: ["agent-1"], issues: { "DEF-1": "todo" } });
    // Same nlink gate as every other candidate: a shared dir whose inodes are
    // also linked into a live tree frees nothing and must not be removed.
    const live = seed(sandbox, "live/blob", 2 * MIB);
    const shared = seedSharedCargoTarget(sandbox, { name: "debug" });
    rmSync(shared, { force: true });
    linkSync(live, shared);
    // Linking refreshes the directory mtime, which find reports, so without
    // re-aging the age gate would skip the dir and hide the nlink result.
    const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    utimesSync(shared, old, old);
    utimesSync(path.dirname(shared), old, old);
    utimesSync(path.join(sandbox.mount, "cargo-target-shared", "debug"), old, old);

    const result = run(sandbox, ["--prune"], { DISK_GUARD_CRIT_PCT: "1", DISK_GUARD_API_STUB: apiStub });
    assert.equal(result.status, RC_CRITICAL);
    assert.ok(existsSync(shared), "a hardlinked shared dir must survive the nlink gate");
    assert.ok(existsSync(live), "the live tree sharing the inode must survive");
    assert.match(result.stderr, /only 0KiB unlinked-reclaimable/);
  } finally {
    sandbox.cleanup();
  }
});

test("a name that parses as <PREFIX>-<number> still routes down the per-issue path and still needs terminality", () => {
  const sandbox = makeSandbox();
  try {
    installDfStub(sandbox, { size: 100 * 1024 * MIB, used: 5 * 1024 * MIB, avail: 95 * 1024 * MIB });
    // DEF-1 and DEF-2 are both terminal, so if either reached the shared path it
    // would be deleted on age alone with no marker consulted. The per-issue path
    // must still demand a matching ownership marker, and DEF-3 is terminal but
    // unreclaimable, proving the issue query is still what gates that path.
    const apiStub = installPaperclipApiStub(sandbox, {
      roster: ["agent-1"],
      issues: { "DEF-1": "done", "DEF-2": "done", "DEF-3": "done" },
    });
    const unmarked = seedCargoTarget(sandbox, { name: "def-1", marker: false });
    const closed = seedCargoTarget(sandbox, { name: "def-2" });
    const misattributed = seedCargoTarget(sandbox, { name: "def-3", marker: "DEF-9" });

    const result = run(sandbox, ["--prune"], { DISK_GUARD_CRIT_PCT: "1", DISK_GUARD_API_STUB: apiStub });
    assert.equal(result.status, RC_CRITICAL);
    assert.ok(existsSync(unmarked), "a terminal per-issue dir with no marker must still survive");
    assert.ok(existsSync(misattributed), "a dir whose marker names another issue must still survive");
    assert.ok(!existsSync(closed), "a marked, terminal per-issue dir must still be reclaimed");
    assert.match(result.stderr, /no \.paperclip-owner ownership marker/);
    assert.match(result.stderr, /marker says 'DEF-9', dir says 'DEF-3'/);
    // The shared path's own refusals must not fire for these: they are per-issue
    // names, so the age-only judgement must never have been applied to them.
    assert.doesNotMatch(result.stderr, /def-1 \(newest mtime/, "a per-issue dir must not be judged on age alone");
  } finally {
    sandbox.cleanup();
  }
});

// Expected guard_version of the committed script. This constant is the whole
// point of DEF-294: the previous version of this test only compared against the
// runtime copies under /paperclip, and `continue`d past any that were absent --
// so on a GitHub runner, where /paperclip does not exist, it asserted nothing
// at all and could not fail. A test that can only fail on the one machine that
// already drifted is a test that did not catch the drift.
//
// The manifest is what makes the check mean something off-volume. A deployment
// has to be performed by something (`install -m 0755 scripts/disk-guard.sh
// /paperclip/bin/disk-guard.sh`), so a copy can legitimately be absent; a copy
// that is PRESENT but reports a different version, or differs by a byte, is
// always a bug and is checked. Set the env var only for a deliberate
// uninstall, never to quiet a real mismatch.
const EXPECTED_GUARD_VERSION = 4;
const RUNTIME_COPIES = ["/paperclip/bin/disk-guard.sh", "/paperclip/disk-guard.sh"];

test("the committed script declares the guard_version the repo expects", () => {
  const committed = readFileSync(SCRIPT, "utf8");
  const declared = committed.match(/guard_version=(\d+)/);
  assert.ok(declared, "scripts/disk-guard.sh must write a guard_version into its status file");
  assert.equal(
    Number(declared[1]),
    EXPECTED_GUARD_VERSION,
    `scripts/disk-guard.sh declares guard_version=${declared[1]} but the repo expects ${EXPECTED_GUARD_VERSION}; bump the constant deliberately and redeploy /paperclip in the same change`,
  );
});

test("every installed runtime copy of the guard is the version the repo ships", { skip: process.env.DISK_GUARD_SKIP_SYNC_CHECK === "1" }, () => {
  const committed = readFileSync(SCRIPT);
  const committedVersion = committed.toString("utf8").match(/guard_version=(\d+)/)[1];
  assert.equal(
    committedVersion,
    String(EXPECTED_GUARD_VERSION),
    "bump EXPECTED_GUARD_VERSION before comparing runtime copies, or this asserts nothing",
  );

  const present = RUNTIME_COPIES.filter((copy) => existsSync(copy));
  for (const runtimeCopy of present) {
    const deployed = readFileSync(runtimeCopy, "utf8");
    const deployedVersion = deployed.match(/guard_version=(\d+)/);
    assert.equal(
      deployedVersion && deployedVersion[1],
      committedVersion,
      `${runtimeCopy} reports guard_version=${deployedVersion ? deployedVersion[1] : "none"} but the repo ships ${committedVersion}; redeploy it from the repo copy`,
    );
    assert.ok(
      deployed === committed.toString("utf8"),
      `${runtimeCopy} has drifted from scripts/disk-guard.sh; redeploy it from the repo copy`,
    );
  }
  // No assertion on a machine that has never deployed the guard (a CI runner,
  // a fresh contributor checkout). The version test above is what holds there.
  if (present.length === 0) {
    assert.equal(
      EXPECTED_GUARD_VERSION,
      Number(committed.toString("utf8").match(/guard_version=(\d+)/)[1]),
      "with no runtime copy installed, the committed version is the only thing that can be checked",
    );
  }
});
