import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, closeSync, copyFileSync, existsSync, linkSync, lutimesSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
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
      DISK_GUARD_WT_DIR: path.join(sandbox.mount, "wt"),
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

/**
 * Seed a nix git-fetch cache repo at `$MOUNT/.cache/nix/gitv3/<hash>/` holding
 * temp packs in `objects/pack/`, the way an aborted `nix build` leaves them.
 *
 * The shape matters more than the size here, because the guard's argument for
 * touching this tree at all is that the shape is evidence. Each option removes
 * one piece of evidence, so each one is a case the sweep must refuse:
 *
 *   `hash`        the repo directory name. Nix derives it from the fetch URL, so
 *                 a real one is a base32-looking string.
 *   `files`       names to create in `objects/pack/`. Defaults to a single
 *                 `tmp_pack_*`; pass `tmp_idx_*` to cover the index case.
 *   `sizeBytes`   per file. Defaults to 2MiB, above the 1MiB floor below which a
 *                 candidate is reported but not reclaimed, so the reclaim and the
 *                 "too small to bother" path are distinguishable.
 *   `fresh`       minutes-old mtimes instead of six-day-old. A pack this young may
 *                 be an in-flight fetch, which is the single most important thing
 *                 this sweep must not delete.
 *   `refs`        `heads`/`tags` to create refs for, or `false` for none. A repo
 *                 that has a ref may have completed a fetch, so its packs are not
 *                 proven abandoned.
 *   `origin`      the remote URL to record, or `false` for none. Same reasoning as
 *                 refs: a recorded origin means a fetch got far enough to save
 *                 where it was fetching from.
 *   `nlink`       extra hardlinks to make, so the file's link count is above 1 and
 *                 the nlink==1 gate must refuse it.
 *   `openFd`      hold an actual open descriptor on the file from this process, so
 *                 the /proc gate is exercised against a real open fd rather than a
 *                 stubbed one.
 *   `gitInit`     initialise a real git repo rather than leaving bare on-disk
 *                 scaffolding. Both shapes occur: nix leaves a directory git can
 *                 open, and leaves one it cannot.
 */
function seedNixGitCache(
  sandbox,
  {
    hash = "034j5c5gi6rhff4xf4g5x4lgfljp7xy9bgpshj4vf5bwshg1659x",
    files = ["tmp_pack_aaaaaa"],
    sizeBytes = 2 * MIB,
    fresh = false,
    refs = { heads: [], tags: [] },
    origin = false,
    nlink = 0,
    openFd = false,
    gitInit = true,
  } = {},
) {
  const repo = path.join(sandbox.mount, ".cache/nix/gitv3", hash);
  const packDir = path.join(repo, "objects", "pack");
  mkdirSync(path.join(repo, "refs", "heads"), { recursive: true });
  mkdirSync(path.join(repo, "refs", "tags"), { recursive: true });
  mkdirSync(packDir, { recursive: true });

  const age = fresh
    ? new Date(Date.now() - 5 * 60 * 1000)
    : new Date(Date.now() - 6 * 24 * 60 * 60 * 1000);

  const created = [];
  for (const name of files) {
    const full = path.join(packDir, name);
    writeFileSync(full, Buffer.alloc(sizeBytes));
    utimesSync(full, age, age);
    for (let i = 0; i < nlink; i += 1) {
      linkSync(full, `${full}.link${i}`);
    }
    created.push(full);
  }

  if (refs?.heads?.length || refs?.tags?.length) {
    if (gitInit) {
      // A real repo, because `for-each-ref` is how the guard reads refs and a
      // string written into refs/heads/ by hand is not what it reads.
      spawnSync("git", ["init", "-q"], { cwd: repo });
      spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
      spawnSync("git", ["config", "user.name", "Test"], { cwd: repo });
      if (origin !== false) {
        spawnSync("git", ["remote", "add", "origin", origin], { cwd: repo });
      }
      writeFileSync(path.join(repo, "seed.txt"), "seed\n");
      spawnSync("git", ["add", "seed.txt"], { cwd: repo });
      spawnSync("git", ["commit", "-q", "-m", "seed"], { cwd: repo });
      for (const branch of refs.heads ?? []) {
        spawnSync("git", ["branch", branch], { cwd: repo });
      }
      for (const tag of refs.tags ?? []) {
        spawnSync("git", ["tag", tag], { cwd: repo });
      }
    } else {
      for (const branch of refs.heads ?? []) {
        writeFileSync(path.join(repo, "refs", "heads", branch), "0".repeat(40) + "\n");
      }
      for (const tag of refs.tags ?? []) {
        writeFileSync(path.join(repo, "refs", "tags", tag), "0".repeat(40) + "\n");
      }
      writeFileSync(
        path.join(repo, "config"),
        `[core]\n\trepositoryformatversion = 0\n${origin !== false ? `[remote "origin"]\n\turl = ${origin}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n` : ""}`,
      );
    }
  } else if (origin !== false) {
    // No refs, but a recorded origin: still a repo that got somewhere.
    if (gitInit) {
      spawnSync("git", ["init", "-q"], { cwd: repo });
      spawnSync("git", ["remote", "add", "origin", origin], { cwd: repo });
    } else {
      writeFileSync(
        path.join(repo, "config"),
        `[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = ${origin}\n`,
      );
    }
  } else if (gitInit) {
    // No refs and no origin: a real repo that has never fetched. This is the
    // exact shape of the CON-458 orphans.
    spawnSync("git", ["init", "-q"], { cwd: repo });
    spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
    spawnSync("git", ["config", "user.name", "Test"], { cwd: repo });
    writeFileSync(path.join(repo, "README"), "unfetched\n");
    spawnSync("git", ["add", "README"], { cwd: repo });
    spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: repo });
    // A commit leaves refs/heads/master behind, which is a ref the guard refuses
    // on. Strip it back to the never-fetched state an aborted nix fetch leaves.
    spawnSync("git", ["update-ref", "-d", "refs/heads/master"], { cwd: repo });
    rmSync(path.join(repo, "refs", "heads", "master"), { force: true });
    rmSync(path.join(repo, "packed-refs"), { force: true });
  }

  // Age the repo itself, so the directory mtimes do not read as "in flight" to
  // anything that walks the tree rather than the file.
  utimesSync(packDir, age, age);
  utimesSync(path.join(repo, "objects"), age, age);

  return { repo, packDir, files: created };
}

/**
 * Hold an open read descriptor on `file` for the lifetime of the returned handle,
 * so a gate that consults /proc for open file descriptors has a real one to find.
 *
 * Returned rather than opened inside seedNixGitCache because the open fd has to
 * outlive the child process that reads it: the guard runs in a spawned bash, so
 * an fd closed when the seeding function returned would prove nothing.
 */
function holdOpen(file) {
  const fd = openSync(file, "r");
  return { fd, release: () => closeSync(fd) };
}

function installPaperclipApiStub(sandbox, { roster = ["agent-1"], issues = { "DEF-1": "done" }, ignoreQuery = false, strictScope = false } = {}) {
  const stub = path.join(sandbox.binDir, "paperclip-api-stub.mjs");
  const body = [
    "#!/usr/bin/env node",
    `const roster = ${JSON.stringify(roster)};`,
    `const issues = ${JSON.stringify(issues)};`,
    "const requestPath = process.argv[2] || '';",
    "if (requestPath.includes('/agents')) { console.log(JSON.stringify(roster.map((id) => ({ id })))); process.exit(0); }",
    `const ignoreQuery = ${JSON.stringify(ignoreQuery)};`,
    `const strictScope = ${JSON.stringify(strictScope)};`,
    "const match = requestPath.match(/[?&]q=([^&]+)/);",
    "const identifier = match ? decodeURIComponent(match[1]) : '';",
    "if (ignoreQuery) { console.log(JSON.stringify({ items: [{ identifier: 'DEF-999', status: 'done' }] })); process.exit(0); }",
    // strictScope models the real company-scoped route: an identifier from
    // another company's namespace simply is not in the result set, so the guard
    // must treat it as non-terminal rather than as a status it can read.
    "if (strictScope && !Object.prototype.hasOwnProperty.call(issues, identifier)) { console.log(JSON.stringify({ items: [] })); process.exit(0); }",
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

/**
 * Seed `$MOUNT/wt/<dirName>` as a git checkout with `rel` build output in it.
 *
 * `branch` is set explicitly rather than derived from `dirName` because the two
 * disagree in the wild, and the guard's safety argument for this root rests on
 * requiring agreement. Real measured case: `wt/con-220` sits on
 * `fix/con-220-clippy-194-stacked`, where the branch alone reads as CLIPPY-194.
 *
 * `origin` is settable because the wt/ gate demands repository provenance *before*
 * corroboration: a tree whose origin is not the company project repo must be
 * refused even when its name and branch agree perfectly. That is the shape of 83
 * of the 112 trees measured on the live volume.
 */
function seedWorktree(sandbox, { dirName, branch, origin = COMPANY_PROJECT_REPO, rel = "target", ignored = true, tracked = false, fresh = false, symlinkCheckout = false } = {}) {
  const checkout = path.join(sandbox.mount, "wt", dirName);
  mkdirSync(checkout, { recursive: true });
  spawnSync("git", ["init", "-q"], { cwd: checkout });
  spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: checkout });
  spawnSync("git", ["config", "user.name", "Test"], { cwd: checkout });
  if (origin) spawnSync("git", ["remote", "add", "origin", origin], { cwd: checkout });
  if (branch) spawnSync("git", ["checkout", "-q", "-b", branch], { cwd: checkout });
  if (ignored) {
    writeFileSync(path.join(checkout, ".gitignore"), rel + "\n");
    // Commit the .gitignore. `git check-ignore` reads ignore rules from the
    // working tree *and* the index, but only for tracked rules does it match a
    // directory as a whole; an untracked .gitignore makes check-ignore answer
    // "no" for the dir, so a fixture that leaves it untracked silently stops at
    // the gitignore gate and never exercises the gate behind it.
    spawnSync("git", ["add", "-f", ".gitignore"], { cwd: checkout });
    spawnSync("git", ["commit", "-q", "-m", "ignore"], { cwd: checkout });
  }
  const full = path.join(checkout, rel, "blob");
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, Buffer.alloc(2 * MIB));
  if (tracked) spawnSync("git", ["add", "-f", path.join(rel, "blob")], { cwd: checkout });
  if (!fresh) {
    const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    utimesSync(full, old, old);
    utimesSync(path.dirname(full), old, old);
    utimesSync(path.join(checkout, rel), old, old);
  }
  if (symlinkCheckout) {
    const elsewhere = path.join(sandbox.mount, "outside-wt", dirName);
    mkdirSync(path.dirname(elsewhere), { recursive: true });
    renameSync(checkout, elsewhere);
    rmSync(checkout, { recursive: true, force: true });
    symlinkSync(elsewhere, checkout);
  }
  return { checkout, full };
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

/**
 * Seed a checkout whose `origin/main` already contains its HEAD, then detach.
 *
 * This is the `def-299-verify` shape: a checkout left detached at a commit that
 * is already merged, holding stale gitignored build output behind a done issue.
 * A detached HEAD is the one case where gate 2 has no branch name to corroborate
 * a directory name against, so it needs `origin/main` to exist as real ancestry
 * evidence -- which a single-clone `seedWorkspaceCheckout` cannot provide, since
 * nothing has ever pushed anything anywhere.
 *
 * `merged` selects which side of the new rule is under test: true detaches at a
 * commit that IS an ancestor of origin/main, false at a commit that is not.
 */
function seedDetachedCheckoutWithMainline(sandbox, { agentId = "agent-1", checkoutName, issue = "DEF-1", merged = true } = {}) {
  const checkout = path.join(sandbox.mount, "instances/default/workspaces", agentId, checkoutName);

  // A bare stand-in for the project's real remote. `src` pushes to it so
  // origin/main is a ref that genuinely exists, rather than one invented by
  // update-ref -- otherwise the ancestry test would prove nothing.
  const bare = path.join(sandbox.root, `${checkoutName}-origin.git`);
  mkdirSync(bare, { recursive: true });
  spawnSync("git", ["init", "-q", "--bare", "-b", "main", bare]);
  const src = path.join(sandbox.root, `${checkoutName}-src`);
  seedGitClone(src, { origin: false });
  writeFileSync(path.join(src, "README.md"), "merged\n");
  spawnSync("git", ["add", "."], { cwd: src });
  spawnSync("git", ["commit", "-q", "-m", "docs(ci): correct a stale comment (#232)"], { cwd: src });
  spawnSync("git", ["push", "-q", bare, "HEAD:main"], { cwd: src });

  // When the commit must NOT be a mainline ancestor, main gets a commit the
  // checkout never saw *and* the checkout is left at a commit that diverged from
  // main instead of one behind it. The distinction matters: ancestry is
  // transitive, so simply leaving HEAD one commit behind main still makes it an
  // ancestor of main, which is the `merged` case and not the negative one. Only
  // a commit that is not on main's history at all fails `--is-ancestor`.
  if (!merged) {
    spawnSync("git", ["checkout", "-q", "-b", "side", "HEAD~1"], { cwd: src });
    writeFileSync(path.join(src, "SIDE.md"), "work that was never merged\n");
    spawnSync("git", ["add", "."], { cwd: src });
    spawnSync("git", ["commit", "-q", "-m", "wip: unmerged work off to the side"], { cwd: src });
    spawnSync("git", ["push", "-q", bare, "HEAD:side"], { cwd: src });
  }

  spawnSync("git", ["clone", "-q", bare, checkout]);
  // The checkout's `origin` must be the company project repo for the
  // repository-identity gate to pass, and origin/main must be the ref this seed
  // built. A later `git fetch` against the real remote would overwrite the latter,
  // so the fetch is rewritten to read the local bare repo; without the rewrite a
  // real network fetch would silently replace the ancestry under test.
  spawnSync("git", ["config", "remote.origin.url", bare], { cwd: checkout });
  spawnSync(
    "git",
    ["config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"],
    { cwd: checkout },
  );
  spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: checkout });
  spawnSync("git", ["config", "user.name", "Test"], { cwd: checkout });
  // Fetch the branch this case hangs on, then point origin at the company repo so
  // identity passes while refs/remotes/origin/main stays exactly what was seeded.
  spawnSync("git", ["fetch", "-q", "origin"], { cwd: checkout });
  spawnSync("git", ["remote", "set-url", "origin", COMPANY_PROJECT_REPO], { cwd: checkout });
  spawnSync(
    "git",
    ["config", `remote.${COMPANY_PROJECT_REPO}.url`, bare],
    { cwd: checkout },
  );
  spawnSync(
    "git",
    ["config", `remote.${COMPANY_PROJECT_REPO}.fetch`, "+refs/heads/*:refs/remotes/origin/*"],
    { cwd: checkout },
  );

  writeFileSync(path.join(checkout, ".gitignore"), "client/target\n");
  const full = path.join(checkout, "client/target/blob");
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, Buffer.alloc(2 * MIB));
  const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
  utimesSync(full, old, old);
  utimesSync(path.dirname(full), old, old);
  utimesSync(path.join(checkout, "client/target"), old, old);

  spawnSync("git", ["checkout", "-q", "--detach", merged ? "origin/main" : "origin/side"], { cwd: checkout });
  // Assert the seed is the shape the test claims, so a broken seed fails as a
  // seed rather than silently passing for the wrong reason.
  assert.notEqual(
    spawnSync("git", ["symbolic-ref", "-q", "HEAD"], { cwd: checkout }).status,
    0,
    "seed must leave HEAD detached or this case is not the detached-HEAD rule",
  );
  const isAncestor =
    spawnSync("git", ["merge-base", "--is-ancestor", "HEAD", "origin/main"], { cwd: checkout }).status === 0;
  assert.equal(isAncestor, merged, "seed must produce the mainline ancestry the case under test needs");

  return { checkout, full };
}

test("workspace scope: a checkout with no .git is named in the log, not dropped in silence", () => {
  const sandbox = makeSandbox();
  try {
    installDfStub(sandbox, { size: 100 * 1024 * MIB, used: 90 * 1024 * MIB, avail: 10 * 1024 * MIB });
    const apiStub = installPaperclipApiStub(sandbox, { roster: ["agent-1"], issues: { "DEF-275": "done" } });

    // The `def-275-outbox-replay` shape on /paperclip: an abandoned build scratch
    // copy with `client/` and `env.sh` and no `.git` anywhere. 7.62 GiB of
    // nlink==1, the largest such block on the volume.
    const checkout = path.join(sandbox.mount, "instances/default/workspaces/agent-1/def-275-outbox-replay");
    const full = path.join(checkout, "client/target/debug/blob");
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, Buffer.alloc(2 * MIB));
    writeFileSync(path.join(checkout, "env.sh"), "# run environment for the trimmed client/ build copy\n");
    const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    utimesSync(full, old, old);
    utimesSync(path.dirname(full), old, old);
    utimesSync(path.join(checkout, "client/target"), old, old);

    const result = run(sandbox, ["--prune"], { DISK_GUARD_CRIT_PCT: "1", DISK_GUARD_API_STUB: apiStub });

    // The refusal itself is correct and unchanged: no repository, no commit, no
    // corroboration, so nothing under it may be deleted.
    assert.ok(existsSync(full), "build output under an unauditable checkout must survive");

    // What was broken is that it produced no line at all. A skip the owner cannot
    // see is indistinguishable from a tree that does not exist, so the whole tree
    // left the books silently.
    assert.match(
      result.stderr,
      /def-275-outbox-replay \(no \.git; cannot corroborate ownership\)/,
      "a checkout with no .git must be named with an explicit reason",
    );
  } finally {
    sandbox.cleanup();
  }
});

test("gate 2: a detached HEAD that is a merged ancestor of origin/main is corroborated by its directory name", () => {
  const sandbox = makeSandbox();
  try {
    installDfStub(sandbox, { size: 100 * 1024 * MIB, used: 90 * 1024 * MIB, avail: 10 * 1024 * MIB });
    const apiStub = installPaperclipApiStub(sandbox, { roster: ["agent-1"], issues: { "DEF-299": "done" } });
    const detached = seedDetachedCheckoutWithMainline(sandbox, { checkoutName: "def-299-verify", issue: "DEF-299" });

    const result = run(sandbox, ["--prune"], { DISK_GUARD_CRIT_PCT: "1", DISK_GUARD_API_STUB: apiStub });

    assert.equal(result.status, RC_CRITICAL);
    // HEAD is merged, so the tree is a snapshot of mainline: the branch check has
    // nothing to say, but the commit itself is evidence that the content belongs.
    assert.ok(!existsSync(detached.full), "a detached HEAD already on origin/main must be reclaimable");
    assert.match(
      result.stderr,
      /prune .*def-299-verify\/client\/target/,
      "the reclaim must be reported, so the freed bytes are auditable too",
    );
  } finally {
    sandbox.cleanup();
  }
});

test("gate 2: a detached HEAD that is NOT on origin/main, or whose name names no issue, still fails closed", () => {
  const sandbox = makeSandbox();
  try {
    installDfStub(sandbox, { size: 100 * 1024 * MIB, used: 90 * 1024 * MIB, avail: 10 * 1024 * MIB });
    const apiStub = installPaperclipApiStub(sandbox, {
      roster: ["agent-1"],
      issues: { "DEF-299": "done", "DEF-300": "done" },
    });
    // Half the new rule removed at a time: unmerged commit, and a merged commit
    // in a directory that names no ticket. Either alone must still refuse.
    const unmerged = seedDetachedCheckoutWithMainline(sandbox, { checkoutName: "def-299-unmerged", issue: "DEF-299", merged: false });
    const unnamed = seedDetachedCheckoutWithMainline(sandbox, { checkoutName: "scratch-tree", issue: "DEF-300", merged: true });
    // Ancestry is orthogonal to every other gate, so a merged detached HEAD must
    // still lose to them. This is the live shape from DEF-322: `def-300-rustfmt`
    // was refused for age alone, and the age gate is the one thing the new rule
    // must not have disturbed.
    const fresh = seedWorkspaceCheckout(sandbox, { checkoutName: "def-300-rustfmt", issue: "DEF-300", fresh: true });
    // And to the repo-identity gate: `pc-guard` is a clone of *this* control
    // plane's own repo, so no ancestry claim about its mainline authorises a
    // deletion read from our issue API.
    const foreign = seedWorkspaceCheckout(sandbox, { checkoutName: "pc-guard", issue: "DEF-300", origin: FOREIGN_REPO });

    const result = run(sandbox, ["--prune"], { DISK_GUARD_CRIT_PCT: "1", DISK_GUARD_API_STUB: apiStub });

    assert.ok(existsSync(unmerged.full), "a detached HEAD with work not on main must survive");
    assert.ok(existsSync(unnamed.full), "a merged detached HEAD in a directory naming no issue must survive");
    assert.ok(existsSync(fresh.full), "build output under the min-age threshold must still survive");
    assert.ok(existsSync(foreign.full), "a checkout of a foreign repo must survive");
    assert.match(
      result.stderr,
      /def-300-rustfmt\/client\/target \(newest mtime under 24h\)/,
      "the min-age gate must still report why it refused",
    );
    assert.match(
      result.stderr,
      /pc-guard \(origin .* is not the company project repo/,
      "the repo-identity gate must still report why it refused",
    );
    assert.match(
      result.stderr,
      /def-299-unmerged \(branch does not name an issue; a detached HEAD is not an ancestor of origin\/main\)/,
      "an unmerged detached HEAD must be refused with a reason that names the missing ancestry",
    );
    assert.match(
      result.stderr,
      /scratch-tree \(directory name does not attribute it to an issue\)/,
      "ancestry is not a substitute for a directory name that names a ticket",
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

test("wt scope: a terminal issue's worktree build output is pruned, and every failing gate survives", () => {
  const sandbox = makeSandbox();
  try {
    installDfStub(sandbox, { size: 100 * 1024 * MIB, used: 5 * 1024 * MIB, avail: 95 * 1024 * MIB });
    const apiStub = installPaperclipApiStub(sandbox, {
      issues: { "CON-1": "done", "CON-2": "todo", "CON-3": "done", "CON-4": "done", "CON-5": "done" },
    });
    // The suffix in `con-1-gate` must not change the issue it resolves to.
    const closed = seedWorktree(sandbox, { dirName: "con-1-gate", branch: "fix/con-1-retire-lanes" });
    const open = seedWorktree(sandbox, { dirName: "con-2", branch: "fix/con-2-still-open" });
    const tracked = seedWorktree(sandbox, { dirName: "con-3", branch: "fix/con-3-tracked", tracked: true });
    const notIgnored = seedWorktree(sandbox, { dirName: "con-4", branch: "fix/con-4-not-ignored", ignored: false });
    const fresh = seedWorktree(sandbox, { dirName: "con-5", branch: "fix/con-5-fresh", fresh: true });

    const result = run(sandbox, ["--prune"], { DISK_GUARD_CRIT_PCT: "1", DISK_GUARD_API_STUB: apiStub });
    assert.equal(result.status, RC_CRITICAL);
    assert.ok(!existsSync(closed.full), "a terminal issue's worktree build output must be pruned");
    assert.ok(existsSync(open.full), "an open issue's worktree build output must survive");
    assert.ok(existsSync(tracked.full), "tracked build output must survive");
    assert.ok(existsSync(notIgnored.full), "non-gitignored build output must survive");
    assert.ok(existsSync(fresh.full), "fresh build output must survive");
    // A force-added build file is reported *not ignored* by check-ignore (git
    // never ignores a tracked path), so this fixture is what keeps the gitignore
    // gate and the ls-files gate from being conflated: if check-ignore ever
    // started passing tracked paths, `tracked.full` would be deleted here.
    assert.match(result.stderr, /not gitignored/);
  } finally {
    sandbox.cleanup();
  }
});

test("wt scope: name and branch must agree on the issue, so a branch cannot reassign a tree", () => {
  const sandbox = makeSandbox();
  try {
    installDfStub(sandbox, { size: 100 * 1024 * MIB, used: 5 * 1024 * MIB, avail: 95 * 1024 * MIB });
    // CON-220 and CLIPPY-194 are both terminal, so only corroboration can tell
    // them apart. This is the measured live shape of wt/con-220.
    const apiStub = installPaperclipApiStub(sandbox, {
      issues: { "CON-220": "done", "CLIPPY-194": "done", "CON-9": "done" },
    });
    const mismatched = seedWorktree(sandbox, { dirName: "con-220", branch: "fix/con-220-clippy-194-stacked" });
    const noBranch = seedWorktree(sandbox, { dirName: "con-9", branch: "" });

    const result = run(sandbox, ["--prune"], { DISK_GUARD_CRIT_PCT: "1", DISK_GUARD_API_STUB: apiStub });
    assert.equal(result.status, RC_CRITICAL);
    assert.ok(
      existsSync(mismatched.full),
      "a tree whose branch names a different issue must survive, even when both issues are terminal",
    );
    assert.ok(existsSync(noBranch.full), "a detached tree with no branch identifier must survive");
    // The wt/ root now shares the workspace gate, so the refusal is reported with
    // the two disagreeing values rather than a generic "no agreement" message.
    // What matters is that it is refused *before* terminality is consulted, and
    // that CLIPPY-194 being terminal changes nothing.
    assert.match(result.stderr, /branch says 'CLIPPY-194', directory says 'CON-220'/);
    assert.match(result.stderr, /branch does not name an issue/);
  } finally {
    sandbox.cleanup();
  }
});

test("wt scope: another company's worktree is never reclaimed, however its branch is named", () => {
  const sandbox = makeSandbox();
  try {
    installDfStub(sandbox, { size: 100 * 1024 * MIB, used: 5 * 1024 * MIB, avail: 95 * 1024 * MIB });
    // strictScope: only CON-* exists in this company. Every foreign identifier
    // comes back as no result at all, exactly as the real company-scoped route
    // behaves, so these trees are protected by ownership rather than by luck.
    const apiStub = installPaperclipApiStub(sandbox, {
      strictScope: true,
      issues: { "CON-1": "done" },
    });
    const nixlab = seedWorktree(sandbox, { dirName: "nixlab-1771-timer-context", branch: "fix/nixlab-1771-timer-context" });
    const sti = seedWorktree(sandbox, { dirName: "sti-415-v2", branch: "fix/sti-415-v2" });
    // A foreign tree that also carries one of our identifiers in its branch.
    const impersonating = seedWorktree(sandbox, { dirName: "sti-500", branch: "fix/con-1-impersonator" });
    // Our own tree, to prove the ownership check is what separates them.
    const ours = seedWorktree(sandbox, { dirName: "con-1", branch: "fix/con-1-ours" });

    const result = run(sandbox, ["--prune"], { DISK_GUARD_CRIT_PCT: "1", DISK_GUARD_API_STUB: apiStub });
    assert.equal(result.status, RC_CRITICAL);
    assert.ok(!existsSync(ours.full), "our own terminal worktree is still reclaimed");
    assert.ok(existsSync(nixlab.full), "another company's worktree must survive");
    assert.ok(existsSync(sti.full), "another company's worktree must survive");
    assert.ok(existsSync(impersonating.full), "a foreign tree must not inherit our issue's status from its branch");
  } finally {
    sandbox.cleanup();
  }
});

test("wt scope: provenance outranks corroboration -- a foreign-origin clone of OUR issue is still skipped", () => {
  const sandbox = makeSandbox();
  try {
    installDfStub(sandbox, { size: 100 * 1024 * MIB, used: 5 * 1024 * MIB, avail: 95 * 1024 * MIB });
    // CON-1 is terminal, so terminality cannot be what saves the foreign tree.
    const apiStub = installPaperclipApiStub(sandbox, { issues: { "CON-1": "done", "CON-2": "done" } });

    // The dangerous shape, and the reason the wt/ gate checks origin first. Every
    // name-based signal agrees: the directory is named for our issue, the branch
    // names the same issue, and that issue is terminal. The only thing that
    // distinguishes this from ours is that its origin is a different repository.
    //
    // This is not hypothetical. Of the 112 trees measured under wt/ on the live
    // volume, 83 are not clones of the project repo and 74 of those clear a
    // name+branch check -- so a gate that stops at corroboration reclaims on the
    // strength of two labels that any process can create.
    const foreignOrigin = seedWorktree(sandbox, {
      dirName: "con-1",
      branch: "fix/con-1-looks-totally-legitimate",
      origin: "https://github.com/casazza-info/nixlab.git",
    });
    // No origin at all: a tree with no repository identity cannot be vouched for.
    const noOrigin = seedWorktree(sandbox, {
      dirName: "con-2",
      branch: "fix/con-2-also-perfectly-named",
      origin: "",
    });
    // The control: identical name and branch, company origin. If this one is not
    // reclaimed, the test is passing for the wrong reason.
    const ours = seedWorktree(sandbox, {
      dirName: "con-3",
      branch: "fix/con-3-ours",
      origin: COMPANY_PROJECT_REPO,
    });
    const apiStubWithCon3 = installPaperclipApiStub(sandbox, { issues: { "CON-1": "done", "CON-2": "done", "CON-3": "done" } });

    const result = run(sandbox, ["--prune"], { DISK_GUARD_CRIT_PCT: "1", DISK_GUARD_API_STUB: apiStubWithCon3 });
    assert.equal(result.status, RC_CRITICAL);

    assert.ok(
      existsSync(foreignOrigin.full),
      "a tree whose origin is another repository must survive even when name and branch both name a terminal issue of ours",
    );
    assert.ok(existsSync(noOrigin.full), "a tree with no origin must survive, not be guessed at");
    assert.ok(!existsSync(ours.full), "the company-origin control must still be reclaimed, or this test proves nothing");

    // Assert the gate's own words, so a deletion cannot pass by accident.
    assert.match(result.stderr, /is not the company project repo/);
  } finally {
    sandbox.cleanup();
  }
});

test("wt scope: symlinked worktrees and symlinked build output are skipped", () => {
  const sandbox = makeSandbox();
  try {
    installDfStub(sandbox, { size: 100 * 1024 * MIB, used: 5 * 1024 * MIB, avail: 95 * 1024 * MIB });
    const apiStub = installPaperclipApiStub(sandbox, { issues: { "CON-1": "done", "CON-2": "done" } });
    const symlinkedCheckout = seedWorktree(sandbox, { dirName: "con-1", branch: "fix/con-1-link", symlinkCheckout: true });
    const symlinkedTarget = seedWorktree(sandbox, { dirName: "con-2", branch: "fix/con-2-target-link" });
    const outside = path.join(sandbox.mount, "outside-build");
    mkdirSync(outside);
    rmSync(path.dirname(symlinkedTarget.full), { recursive: true, force: true });
    symlinkSync(outside, path.dirname(symlinkedTarget.full));

    const result = run(sandbox, ["--prune"], { DISK_GUARD_CRIT_PCT: "1", DISK_GUARD_API_STUB: apiStub });
    assert.equal(result.status, RC_CRITICAL);
    assert.ok(existsSync(symlinkedCheckout.full), "a symlinked worktree must survive");
    assert.ok(existsSync(path.dirname(symlinkedTarget.full)), "a symlinked build dir must survive");
  } finally {
    sandbox.cleanup();
  }
});

test("wt scope: build output that resolves outside wt/ is skipped", () => {
  const sandbox = makeSandbox();
  try {
    installDfStub(sandbox, { size: 100 * 1024 * MIB, used: 5 * 1024 * MIB, avail: 95 * 1024 * MIB });
    const apiStub = installPaperclipApiStub(sandbox, { issues: { "CON-1": "done" } });
    const tree = seedWorktree(sandbox, { dirName: "con-1", branch: "fix/con-1-escape" });
    // Move the build dir outside wt/ and symlink to it. The tree passes every
    // other gate -- real git repo, corroborated identifier, terminal issue,
    // gitignored, untracked, old -- so only containment can stop this, and
    // `rm -rf` would otherwise follow the link out of the root.
    const real = path.join(sandbox.mount, "outside-build-target");
    mkdirSync(real, { recursive: true });
    writeFileSync(path.join(real, "blob"), Buffer.alloc(2 * MIB));
    rmSync(path.join(tree.checkout, "target"), { recursive: true, force: true });
    symlinkSync(real, path.join(tree.checkout, "target"));

    const result = run(sandbox, ["--prune"], { DISK_GUARD_CRIT_PCT: "1", DISK_GUARD_API_STUB: apiStub });
    assert.equal(result.status, RC_CRITICAL);
    assert.ok(existsSync(path.join(real, "blob")), "build output resolving outside wt/ must survive");
    assert.match(result.stderr, /candidate is a symlink/);
  } finally {
    sandbox.cleanup();
  }
});

test("wt scope: the worktree itself and its sources are never deleted", () => {
  const sandbox = makeSandbox();
  try {
    installDfStub(sandbox, { size: 100 * 1024 * MIB, used: 5 * 1024 * MIB, avail: 95 * 1024 * MIB });
    const apiStub = installPaperclipApiStub(sandbox, { issues: { "CON-1": "done" } });
    const tree = seedWorktree(sandbox, { dirName: "con-1", branch: "fix/con-1-keep-source" });
    const sourceFile = path.join(tree.checkout, "src.rs");
    writeFileSync(sourceFile, "fn main() {}\n");
    spawnSync("git", ["add", "-f", "src.rs"], { cwd: tree.checkout });
    spawnSync("git", ["commit", "-q", "-m", "source"], { cwd: tree.checkout });

    const result = run(sandbox, ["--prune"], { DISK_GUARD_CRIT_PCT: "1", DISK_GUARD_API_STUB: apiStub });
    assert.equal(result.status, RC_CRITICAL);
    assert.ok(!existsSync(tree.full), "the build output is reclaimed");
    assert.ok(existsSync(tree.checkout), "the worktree itself must survive");
    assert.ok(existsSync(sourceFile), "committed source in the worktree must survive");
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

test("age gate: the bounded -newermt predicate keeps the >= cutoff boundary the sort-based gate had", () => {
  const sandbox = makeSandbox();
  try {
    // DEF-306 replaced `find -printf %T@ | sort -nr | head` with
    // `find -newermt @cutoff -print -quit`. Those are NOT interchangeable at the
    // boundary: -newermt is *strictly* newer, while the gate it replaced skipped
    // when newest >= cutoff. A candidate whose newest mtime is exactly the
    // cutoff was skipped before and would become reclaimable without the
    // one-second step back that tree_has_entry_newer_than applies.
    //
    // Pinned directly against the function so a future "simplify" back to
    // `-newermt "@$cutoff"` fails here rather than silently widening what the
    // guard is willing to delete.
    const cutoff = Math.floor(Date.now() / 1000) - 24 * 3600;

    // A candidate is a directory, and the gate is asked about a directory, so
    // each case gets its own tree rather than a single shared one.
    const treeAt = (name, epoch) => {
      const d = path.join(sandbox.root, name);
      mkdirSync(d, { recursive: true });
      const f = path.join(d, "blob");
      writeFileSync(f, "x");
      utimesSync(f, new Date(epoch * 1000), new Date(epoch * 1000));
      // The directory itself carries an mtime too and find reports it, so it
      // must not be the thing answering the question.
      utimesSync(d, new Date((epoch - 60) * 1000), new Date((epoch - 60) * 1000));
      return d;
    };

    const probe = (d, c) =>
      spawnSync(
        "bash",
        ["-c", `source <(sed -n '/^tree_has_entry_newer_than()/,/^}/p' "${SCRIPT}"); tree_has_entry_newer_than ${c} "${d}"`],
        { encoding: "utf8" },
      ).stdout.trim();

    // mtime exactly at the cutoff: the old gate skipped it, so the new one must
    // too. This is the case a raw -newermt "@$cutoff" gets wrong.
    assert.notEqual(probe(treeAt("at", cutoff), cutoff), "", "mtime == cutoff must still read as fresh");
    // One second under the cutoff is stale and reclaimable, as it always was.
    assert.equal(probe(treeAt("under", cutoff - 1), cutoff), "", "mtime == cutoff-1 must still read as stale");
    // Well inside the window is unambiguously fresh.
    assert.notEqual(probe(treeAt("over", cutoff + 3600), cutoff), "", "mtime above the cutoff must read as fresh");
    // Nothing in the tree at all is stale, not "cannot tell".
    assert.equal(probe(path.join(sandbox.root, "absent"), cutoff), "", "an absent tree must read as stale");
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
    // Shadow the process lister so "no build is running" is a fact about this
    // test rather than about the host. The guard tries pgrep then pidof before
    // falling back to a /proc scan, and the three sibling shared-scope tests
    // stub the lister for exactly this reason. Without the stub the result
    // depends on whether the machine happens to be running cargo or rustc:
    // it passed on a container with no pgrep (falling through to /proc) and
    // failed on a runner that had one (run 37233752756), for a reason that has
    // nothing to do with the nlink behaviour this test is about.
    //
    // exit 1 is "matched nothing", which is the one lister result the guard
    // treats as evidence of absence; 0 would mean a build is running and 2
    // would mean the table is unreadable, and both make the guard skip.
    for (const tool of ["pgrep", "pidof"]) {
      writeFileSync(path.join(sandbox.binDir, tool), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    }
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

/**
 * Read `key=value` out of the guard's status file, for the trend assertions.
 * Missing means "the guard did not write it", which is itself the failure.
 */
function statusValue(sandbox, key) {
  const body = readFileSync(sandbox.statusFile, "utf8");
  const match = new RegExp(`^${key}=(.*)$`, "m").exec(body);
  return match ? match[1] : undefined;
}

/**
 * Write a status file as a *previous* check, so the next `--check` sees a trend.
 *
 * The guard reads its own last-written file to compute the rate, so a test cannot
 * produce a trend any other way. Backdating `checked_at` is what sets the elapsed
 * time and therefore the rate, which is the whole point: a 5,000MiB fall over 60
 * minutes is a 5,000MiB/hour leak and the same fall over 600 minutes is 500MiB/hour
 * and must not escalate.
 */
function writePreviousStatus(sandbox, { checkedAt, availMb, level = "ok", usePct = 50 }) {
  const sizeBytes = 200 * 1024 * MIB;
  const availBytes = availMb * MIB;
  const usedBytes = sizeBytes - availBytes;
  mkdirSync(path.dirname(sandbox.statusFile), { recursive: true });
  writeFileSync(
    sandbox.statusFile,
    [
      `checked_at=${checkedAt}`,
      `mount=${sandbox.mount}`,
      `size_bytes=${sizeBytes}`,
      `used_bytes=${usedBytes}`,
      `avail_bytes=${availBytes}`,
      `use_pct=${usePct}`,
      `avail_mb=${availMb}`,
      `floor_mb=6144`,
      `level=${level}`,
      `warn_pct=88`,
      `crit_pct=94`,
      "min_free_mb=1500",
      "guard_version=5",
      "",
    ].join("\n"),
  );
}

function minutesAgo(minutes) {
  return new Date(Date.now() - minutes * 60 * 1000).toISOString().replace(/\.\d+Z$/, "Z");
}

/**
 * A previous check whose free space matches the stub exactly, one hour ago.
 *
 * The nix sweep tests care about what got deleted, not about the trend, and a
 * stale `avail_mb` from an earlier run would escalate the level out from under
 * them -- `prune()` decides whether to delete anything from the level the guard
 * measures, so a trend-driven escalation would silently turn "test the sweep"
 * into "test the sweep at critical", and a future change to the prune gate would
 * then look like a sweep failure.
 */
function writeFlatPreviousStatus(sandbox, availMb) {
  writePreviousStatus(sandbox, { checkedAt: minutesAgo(60), availMb, level: "ok", usePct: 40 });
}

// ---------------------------------------------------------------------------
// CON-461: orphaned nix git-fetch temp packs
// ---------------------------------------------------------------------------

test("nix git cache: an orphaned tmp_pack_*/tmp_idx_* in a never-fetched repo is reclaimed, and reported with its size", () => {
  const sandbox = makeSandbox();
  try {
    installDfStub(sandbox, { size: 100 * 1024 * MIB, used: 95 * 1024 * MIB, avail: 5 * 1024 * MIB });
    writeFlatPreviousStatus(sandbox, 5 * 1024);
    const apiStub = installPaperclipApiStub(sandbox);
    // The exact shape of the CON-458 orphans: 9.3GiB across three files in one
    // repo whose fetch died before it wrote a ref or an origin.
    const { packDir, files } = seedNixGitCache(sandbox, {
      files: ["tmp_pack_zSj50C", "tmp_pack_hl1ihe", "tmp_idx_Q8l6uu"],
      sizeBytes: 3 * MIB,
    });
    assert.equal(files.length, 3);

    const result = run(sandbox, ["--prune"], { DISK_GUARD_CRIT_PCT: "1", DISK_GUARD_API_STUB: apiStub });

    assert.equal(result.status, RC_CRITICAL);
    for (const f of files) {
      assert.ok(!existsSync(f), `orphaned temp pack ${path.basename(f)} must be reclaimed`);
    }
    assert.ok(existsSync(packDir), "the repo scaffolding itself is not this guard's to delete");
    // Each removal is reported with its size, so an operator can see what came
    // back without re-running df by hand.
    assert.match(result.stderr, /reclaim .*tmp_pack_zSj50C \(~3MiB orphaned nix temp pack\/idx\)/);
    assert.match(result.stderr, /reclaim .*tmp_idx_Q8l6uu \(~3MiB orphaned nix temp pack\/idx\)/);
  } finally {
    sandbox.cleanup();
  }
});

test("nix git cache: a fresh tmp_pack_* that may be an in-flight fetch is never deleted", () => {
  const sandbox = makeSandbox();
  try {
    installDfStub(sandbox, { size: 100 * 1024 * MIB, used: 95 * 1024 * MIB, avail: 5 * 1024 * MIB });
    writeFlatPreviousStatus(sandbox, 5 * 1024);
    const apiStub = installPaperclipApiStub(sandbox);
    // Minutes old, not days. This is the acceptance criterion that matters most:
    // the failure mode being guarded against is not reclaiming too little, it is
    // deleting a pack out from under a build that is still writing it.
    const { files } = seedNixGitCache(sandbox, { files: ["tmp_pack_inflight"], sizeBytes: 4 * MIB, fresh: true });

    const result = run(sandbox, ["--prune"], { DISK_GUARD_CRIT_PCT: "1", DISK_GUARD_API_STUB: apiStub });

    assert.equal(result.status, RC_CRITICAL);
    for (const f of files) {
      assert.ok(existsSync(f), "a minutes-old temp pack may be an in-flight fetch and must survive");
    }
    assert.match(result.stderr, /may be an in-flight fetch/);
  } finally {
    sandbox.cleanup();
  }
});

test("nix git cache: every evidence gate independently refuses the pack, so the sweep fails closed", () => {
  const sandbox = makeSandbox();
  try {
    installDfStub(sandbox, { size: 100 * 1024 * MIB, used: 95 * 1024 * MIB, avail: 5 * 1024 * MIB });
    writeFlatPreviousStatus(sandbox, 5 * 1024);
    const apiStub = installPaperclipApiStub(sandbox);

    // One repo per gate. Each is otherwise a perfect candidate: old, nlink==1, no
    // open fd. If any gate were dropped, exactly one of these would be deleted and
    // the assertion that all six survive would fail.
    const fresh = seedNixGitCache(sandbox, { hash: "aaa-fresh", files: ["tmp_pack_fresh"], fresh: true });
    const linked = seedNixGitCache(sandbox, { hash: "bbb-linked", files: ["tmp_pack_linked"] });
    // Two extra names for the link, because nix's own layout puts a hash beside a
    // pack and only the pack itself is a tmp_pack_*; a link that also matched the
    // name would be the same file enumerated twice, which proves nothing about the
    // nlink gate.
    linkSync(linked.files[0], path.join(linked.packDir, "pack-0123456789abcdef.idx"));
    linkSync(linked.files[0], path.join(linked.packDir, "pack-0123456789abcdef.pack"));
    const heads = seedNixGitCache(sandbox, { hash: "ccc-heads", files: ["tmp_pack_heads"], refs: { heads: ["main"], tags: [] } });
    const tags = seedNixGitCache(sandbox, { hash: "ddd-tags", files: ["tmp_pack_tags"], refs: { heads: [], tags: ["v1"] } });
    const origin = seedNixGitCache(sandbox, { hash: "eee-origin", files: ["tmp_pack_origin"], origin: "https://github.com/olivecasazza/definitely-not-crosswords.git" });
    // Bare on-disk scaffolding rather than a git repo git can open: an aborted
    // fetch can leave the repo too damaged to `git init` cleanly over, and that
    // is exactly when a multi-GiB pack is most likely to be stranded. A ref file
    // written directly must still be read as a ref.
    const rawRefs = seedNixGitCache(sandbox, {
      hash: "fff-rawrefs",
      files: ["tmp_pack_rawrefs"],
      gitInit: false,
      refs: { heads: ["main"], tags: [] },
    });

    const held = holdOpen(linked.files[0]);
    const result = run(sandbox, ["--prune"], { DISK_GUARD_CRIT_PCT: "1", DISK_GUARD_API_STUB: apiStub });
    held.release();

    assert.equal(result.status, RC_CRITICAL);
    for (const [name, seeded] of Object.entries({ fresh, linked, heads, tags, origin, rawRefs })) {
      for (const f of seeded.files) {
        assert.ok(existsSync(f), `${name}: a pack missing one piece of evidence must survive`);
      }
    }
    // The refusals have to be visible in the output. A skip that is silent is
    // indistinguishable from the sweep not running at all, which is the same
    // blind spot that let CON-458 read as a mystery.
    assert.match(result.stderr, /may be an in-flight fetch/);
    // nlink==2 is the observable consequence of the extra link, and it is what the
    // gate reports. A silent skip would be indistinguishable from the sweep not
    // running, which is the same blind spot that let CON-458 read as a mystery.
    assert.match(result.stderr, /tmp_pack_linked \(nlink=3/);
    assert.match(result.stderr, /not a never-fetched cache repo/);
  } finally {
    sandbox.cleanup();
  }
});

test("nix git cache: a pack a process is actively writing is skipped even when it is old, nlink==1, and in a never-fetched repo", () => {
  const sandbox = makeSandbox();
  try {
    installDfStub(sandbox, { size: 100 * 1024 * MIB, used: 95 * 1024 * MIB, avail: 5 * 1024 * MIB });
    writeFlatPreviousStatus(sandbox, 5 * 1024);
    const apiStub = installPaperclipApiStub(sandbox);
    const { files } = seedNixGitCache(sandbox, { hash: "held-open", files: ["tmp_pack_held"], sizeBytes: 3 * MIB });

    // A real open fd, held by this process, while the guard runs. The age gate
    // alone would have called this an orphan; the fd is what makes the sweep safe
    // against a long fetch that has outlived the age threshold.
    const held = holdOpen(files[0]);
    const result = run(sandbox, ["--prune"], { DISK_GUARD_CRIT_PCT: "1", DISK_GUARD_API_STUB: apiStub });
    held.release();

    assert.equal(result.status, RC_CRITICAL);
    assert.ok(existsSync(files[0]), "a pack with an open fd must survive whatever its age says");
    assert.match(result.stderr, /a process holds it open/);
  } finally {
    sandbox.cleanup();
  }
});

test("nix git cache: nothing to sweep is a normal no-op, not an error", () => {
  const sandbox = makeSandbox();
  try {
    installDfStub(sandbox, { size: 100 * 1024 * MIB, used: 95 * 1024 * MIB, avail: 5 * 1024 * MIB });
    writeFlatPreviousStatus(sandbox, 5 * 1024);
    const apiStub = installPaperclipApiStub(sandbox);
    // A cache dir with nothing but a completed repo in it: no tmp_pack_*, no
    // tmp_idx_*. This is the steady state of a healthy volume, and it must not
    // produce an error, a non-zero status, or a claim that it reclaimed anything.
    seedNixGitCache(sandbox, { hash: "clean-repo", files: [], origin: "https://github.com/olivecasazza/definitely-not-crosswords.git" });

    const result = run(sandbox, ["--prune"], { DISK_GUARD_CRIT_PCT: "1", DISK_GUARD_API_STUB: apiStub });

    assert.equal(result.status, RC_CRITICAL);
    assert.doesNotMatch(result.stdout, /reclaimed_nix_mib/, "a sweep that found nothing must not report a reclaim");
    assert.doesNotMatch(result.stderr, /reclaim /, "a sweep that found nothing must not claim a removal");
  } finally {
    sandbox.cleanup();
  }
});

test("nix git cache: the age threshold is the one the sweep documents, and an in-flight fetch has a wide margin above it", () => {
  const sandbox = makeSandbox();
  try {
    installDfStub(sandbox, { size: 100 * 1024 * MIB, used: 95 * 1024 * MIB, avail: 5 * 1024 * MIB });
    writeFlatPreviousStatus(sandbox, 5 * 1024);
    const apiStub = installPaperclipApiStub(sandbox);
    const sixDaysOld = seedNixGitCache(sandbox, { hash: "old-hash", files: ["tmp_pack_old"] });

    // Just inside the window the guard allows: 25 hours old. Reclaimed. A 24h
    // threshold admits anything *older* than 24h, so 25h is the youngest age that
    // passes and 23h the oldest that does not. An earlier version of this test had
    // the two the wrong way round -- it expected the 23h file deleted and the 25h
    // file kept -- which reads correctly only if "older than the threshold" is
    // taken to mean "more recently than the threshold".
    const justInside = seedNixGitCache(sandbox, { hash: "inside-hash", files: ["tmp_pack_inside"], fresh: false });
    utimesSync(justInside.files[0], new Date(Date.now() - 25 * 3600 * 1000), new Date(Date.now() - 25 * 3600 * 1000));

    // Just outside it: 23 hours old. Survives, because the threshold is a
    // conservative margin rather than "old enough to probably be dead".
    const justOutside = seedNixGitCache(sandbox, { hash: "outside-hash", files: ["tmp_pack_outside"] });
    utimesSync(justOutside.files[0], new Date(Date.now() - 23 * 3600 * 1000), new Date(Date.now() - 23 * 3600 * 1000));

    const result = run(sandbox, ["--prune"], { DISK_GUARD_CRIT_PCT: "1", DISK_GUARD_API_STUB: apiStub });

    assert.equal(result.status, RC_CRITICAL);
    assert.ok(!existsSync(sixDaysOld.files[0]), "the CON-458 case -- six days old -- must be reclaimed");
    assert.ok(!existsSync(justInside.files[0]), "25h is older than the 24h window and must be reclaimed");
    assert.ok(existsSync(justOutside.files[0]), "23h is younger than the 24h window and must survive");
    // The boundary is the whole point of this test, so pin the direction of the
    // skip message too: a gate that skipped the *older* file would still delete
    // both files in the other direction and pass a delete-only assertion.
    assert.match(result.stderr, /tmp_pack_outside \(mtime is within 24h/);
  } finally {
    sandbox.cleanup();
  }
});

test("nix: live nix state stays protected -- .nix-portable, .local/state/nix and the store are never reclaim paths, and no nix gc is introduced", () => {
  const sandbox = makeSandbox();
  try {
    installDfStub(sandbox, { size: 100 * 1024 * MIB, used: 95 * 1024 * MIB, avail: 5 * 1024 * MIB });
    writeFlatPreviousStatus(sandbox, 5 * 1024);
    const apiStub = installPaperclipApiStub(sandbox);
    // The live paths named in the guard's header, each holding enough to look
    // worth reclaiming and an mtime old enough to pass any age gate.
    const old = new Date(Date.now() - 30 * 24 * 3600 * 1000);
    const live = {};
    for (const rel of [".nix-portable/store/toolchain", ".local/state/nix/profiles/profile-1", "nixstore/aaa-linux-builder", ".local/share/nix/store/x"]) {
      const full = path.join(sandbox.mount, rel);
      mkdirSync(full, { recursive: true });
      writeFileSync(path.join(full, "blob"), Buffer.alloc(8 * MIB));
      utimesSync(path.join(full, "blob"), old, old);
      live[rel] = full;
    }
    // A temp pack-shaped name inside live state must not tempt anything either.
    const livePackDir = path.join(sandbox.mount, ".nix-portable/store/toolchain/objects/pack");
    mkdirSync(livePackDir, { recursive: true });
    writeFileSync(path.join(livePackDir, "tmp_pack_decoy"), Buffer.alloc(8 * MIB));
    utimesSync(path.join(livePackDir, "tmp_pack_decoy"), old, old);

    const result = run(sandbox, ["--prune"], { DISK_GUARD_CRIT_PCT: "1", DISK_GUARD_API_STUB: apiStub });

    assert.equal(result.status, RC_CRITICAL);
    for (const [rel, dir] of Object.entries(live)) {
      assert.ok(existsSync(path.join(dir, "blob")), `${rel} must survive a prune`);
    }
    assert.ok(existsSync(path.join(livePackDir, "tmp_pack_decoy")), "a temp pack outside the git cache must survive");

    // No reclaim path may invoke the nix store. `nix store gc` / `nix-store
    // --delete` / `nix copy` are unsafe here: this volume's store is effectively
    // empty while the toolchains that matter live outside it, so GC roots would
    // not cover them. A regression that reintroduced one would be invisible in
    // every other assertion in this file, because on this volume it would collect
    // paths nothing appears to be using and leave the real toolchains untouched.
    const script = readFileSync(SCRIPT, "utf8");
    assert.doesNotMatch(script, /\bnix\s+store\s+gc\b/, "nix store gc must never be a reclaim path on this volume");
    assert.doesNotMatch(script, /\bnix-store\b/, "nix-store must never be a reclaim path on this volume");
    assert.doesNotMatch(script, /\bnix\s+copy\b/, "nix copy must never be a reclaim path on this volume");
    assert.doesNotMatch(script, /\bnix-collect-garbage\b/, "nix-collect-garbage must never be a reclaim path on this volume");
  } finally {
    sandbox.cleanup();
  }
});

test("nix git cache: .cache/nix is not a blanket safe_cache, so a live gitv3 or tarball-cache entry is never deleted", () => {
  const sandbox = makeSandbox();
  try {
    installDfStub(sandbox, { size: 100 * 1024 * MIB, used: 95 * 1024 * MIB, avail: 5 * 1024 * MIB });
    writeFlatPreviousStatus(sandbox, 5 * 1024);
    const apiStub = installPaperclipApiStub(sandbox);
    const old = new Date(Date.now() - 30 * 24 * 3600 * 1000);
    // A successfully-fetched repo's real pack, plus the tarball cache. These are
    // the entries a running build may still need, which is the reason the sweep is
    // targeted rather than `.cache/nix` in safe_caches[].
    const live = seedNixGitCache(sandbox, {
      hash: "live-repo",
      files: ["pack-0123456789abcdef.pack"],
      origin: "https://github.com/olivecasazza/definitely-not-crosswords.git",
    });
    const tarball = path.join(sandbox.mount, ".cache/nix/tarball-cache/abc");
    mkdirSync(tarball, { recursive: true });
    writeFileSync(path.join(tarball, "source"), Buffer.alloc(8 * MIB));
    utimesSync(path.join(tarball, "source"), old, old);
    // And a sqlite side-car the fetcher keeps, which is live cache bookkeeping.
    const sidecar = path.join(sandbox.mount, ".cache/nix/fetcher-cache-v1.sqlite");
    writeFileSync(sidecar, Buffer.alloc(2 * MIB));
    utimesSync(sidecar, old, old);

    const result = run(sandbox, ["--prune"], { DISK_GUARD_CRIT_PCT: "1", DISK_GUARD_API_STUB: apiStub });

    assert.equal(result.status, RC_CRITICAL);
    assert.ok(existsSync(live.files[0]), "a fetched repo's pack must survive");
    assert.ok(existsSync(path.join(tarball, "source")), "the tarball cache must survive");
    assert.ok(existsSync(sidecar), "the fetcher cache sqlite must survive");

    // The whole point is that the eligible set is the temp packs, so the guard
    // must not list `.cache/nix` as a whole-path prune target either.
    assert.doesNotMatch(result.stderr, /prune \S*\.cache\/nix( |$)/, ".cache/nix must not be pruned as a whole path");
  } finally {
    sandbox.cleanup();
  }
});

// ---------------------------------------------------------------------------
// CON-461: falling free space between routine runs
// ---------------------------------------------------------------------------

test("trend: a volume that is still ok but losing over 1GiB/hour escalates, and reports the rate", () => {
  const sandbox = makeSandbox();
  try {
    // 40% used, so the snapshot level is unambiguously `ok`: this is the whole
    // point of the signal. A guard that only escalates at warn/critical cannot see
    // a collapse that has not arrived yet, and on 2026-10-04 the collapse was at
    // 240 MiB/min -- it reached critical before any check noticed it moving.
    installDfStub(sandbox, { size: 200 * 1024 * MIB, used: 80 * 1024 * MIB, avail: 120 * 1024 * MIB });
    writePreviousStatus(sandbox, { checkedAt: minutesAgo(60), availMb: 130 * 1024, level: "ok", usePct: 40 });

    const result = run(sandbox, ["--check"]);

    // 10,240MiB lost over 60 minutes = 10,240MiB/hour, far past the 1GiB/hour
    // threshold. rc=2 (warn) even though the volume reads ok.
    assert.equal(result.status, RC_WARN);
    assert.match(result.stdout, /level=warn/);
    assert.match(result.stdout, /trend=falling/);
    assert.match(result.stdout, /rate=-10240MiB\/hour/);
    assert.match(result.stderr, /falling free space/);
  } finally {
    sandbox.cleanup();
  }
});

test("trend: a steady volume with reclaimable headroom does not escalate, however long it has been flat", () => {
  const sandbox = makeSandbox();
  try {
    // Free space essentially unchanged over a day. A steady warn with headroom is
    // not an incident, and neither is a steady ok -- escalating on flatness would
    // make the guard cry wolf on every healthy run and train everyone to ignore it.
    installDfStub(sandbox, { size: 200 * 1024 * MIB, used: 80 * 1024 * MIB, avail: 120 * 1024 * MIB });
    writePreviousStatus(sandbox, { checkedAt: minutesAgo(24 * 60), availMb: 120 * 1024 + 3, level: "ok", usePct: 40 });

    const result = run(sandbox, ["--check"]);

    assert.equal(result.status, RC_OK);
    assert.match(result.stdout, /level=ok/);
    assert.match(result.stdout, /rate=0MiB\/hour/);
    assert.doesNotMatch(result.stderr, /falling free space/);
  } finally {
    sandbox.cleanup();
  }
});

test("trend: a slow leak below the threshold is reported but does not escalate, and only the rate keeps the level unchanged", () => {
  const sandbox = makeSandbox();
  try {
    // 500MiB/hour is a real trend and an operator should see it, but it is below
    // the 1GiB/hour escalation bar and would take two days to matter on a
    // 197GiB volume. Escalating here would fire on the volume's normal churn.
    installDfStub(sandbox, { size: 200 * 1024 * MIB, used: 80 * 1024 * MIB, avail: 120 * 1024 * MIB });
    writePreviousStatus(sandbox, { checkedAt: minutesAgo(60), availMb: 120 * 1024 + 500, level: "ok", usePct: 40 });

    const result = run(sandbox, ["--check"]);

    assert.match(result.stdout, /rate=-500MiB\/hour/, "a slow leak must still be visible");
    assert.doesNotMatch(result.stderr, /falling free space/, "a sub-threshold leak must not be escalated by the rate test");
    assert.equal(statusValue(sandbox, "level"), "ok", "the absolute level is unchanged: the volume is still only 40% full");
    // Nothing else escalates here either. The previous level is also ok and the
    // current level is ok, so there is no regression to report -- an earlier
    // version of this test asserted `level regressed ok -> warn` while also
    // asserting level=ok, which no guard can satisfy: the regression line compares
    // the recorded previous level against the level just measured, and both are ok
    // here. Escalation is covered by the cases that actually regress
    // ("an absolute level regression between consecutive runs") and by the cases
    // that actually cross the rate threshold.
    assert.doesNotMatch(result.stderr, /level regressed/, "with ok before and ok now there is no regression");
    assert.equal(statusValue(sandbox, "level_prev"), "ok");
    assert.equal(result.status, RC_OK, "a sub-threshold leak on a healthy volume is not an incident");
  } finally {
    sandbox.cleanup();
  }
});

test("trend: a fall that recovers within the interval is reported as a recovery, not as a leak", () => {
  const sandbox = makeSandbox();
  try {
    // Free space is *higher* than the last check: a prune ran, or a build finished
    // and released its temp. The rate must be non-negative, so it can never be
    // compared against the negative fall threshold and escalate.
    installDfStub(sandbox, { size: 200 * 1024 * MIB, used: 80 * 1024 * MIB, avail: 130 * 1024 * MIB });
    writePreviousStatus(sandbox, { checkedAt: minutesAgo(60), availMb: 120 * 1024, level: "ok", usePct: 40 });

    const result = run(sandbox, ["--check"]);

    assert.equal(result.status, RC_OK);
    assert.equal(statusValue(sandbox, "avail_mb_delta"), String(10 * 1024));
    assert.equal(statusValue(sandbox, "fall_rate_mb_per_hour"), String(10 * 1024));
    assert.doesNotMatch(result.stderr, /falling free space/);
  } finally {
    sandbox.cleanup();
  }
});

test("trend: the rate is normalised by elapsed time, so the same absolute fall is a fast leak or a slow one", () => {
  const sandbox = makeSandbox();
  try {
    installDfStub(sandbox, { size: 200 * 1024 * MIB, used: 80 * 1024 * MIB, avail: 120 * 1024 * MIB });
    // The same 2,000MiB the guard is watching for: over an hour it is 2,000MiB/hour
    // and escalates; over twelve hours it is ~166MiB/hour and does not. The
    // absolute fall is identical, so only the interval can be what decided it --
    // which is the property the escalation is actually about.
    writePreviousStatus(sandbox, { checkedAt: minutesAgo(60), availMb: 120 * 1024 + 2000, level: "ok", usePct: 40 });
    const fast = run(sandbox, ["--check"]);
    assert.match(fast.stderr, /falling free space/, "2,000MiB/hour is past the 1GiB/hour bar and must escalate");
    assert.equal(statusValue(sandbox, "avail_mb_delta"), "-2000");
    assert.equal(statusValue(sandbox, "fall_rate_mb_per_hour"), "-2000");

    rmSync(sandbox.statusFile, { force: true });
    writePreviousStatus(sandbox, { checkedAt: minutesAgo(12 * 60), availMb: 120 * 1024 + 2000, level: "ok", usePct: 40 });
    const slow = run(sandbox, ["--check"]);
    assert.doesNotMatch(slow.stderr, /falling free space/, "the same 2,000MiB over twelve hours is a slow leak");
    assert.equal(statusValue(sandbox, "fall_rate_mb_per_hour"), "-166");
    assert.equal(statusValue(sandbox, "avail_mb_delta"), "-2000", "the delta is the absolute fall, not a rate");
  } finally {
    sandbox.cleanup();
  }
});

test("trend: two checks in the same minute do not manufacture a leak out of rounding", () => {
  const sandbox = makeSandbox();
  try {
    installDfStub(sandbox, { size: 200 * 1024 * MIB, used: 80 * 1024 * MIB, avail: 120 * 1024 * MIB });
    writePreviousStatus(sandbox, { checkedAt: minutesAgo(0), availMb: 120 * 1024 + 3, level: "ok", usePct: 40 });

    const result = run(sandbox, ["--check"]);

    // 3MiB inside a single minute is 180MiB/hour if the interval is credited as a
    // minute and unbounded if it is credited as a second. Either way it is one
    // measurement, not two, and there is no interval to measure a trend over.
    assert.equal(statusValue(sandbox, "avail_mb_elapsed_minutes"), "");
    assert.equal(statusValue(sandbox, "fall_rate_mb_per_hour"), "");
    assert.equal(statusValue(sandbox, "avail_mb_delta"), "", "no interval means no delta either, rather than a delta with no rate");
    assert.doesNotMatch(result.stderr, /falling free space/);
  } finally {
    sandbox.cleanup();
  }
});

test("trend: disk-guard.status carries the previous value, the delta and the rate, so the trend is readable without diffing prose", () => {
  const sandbox = makeSandbox();
  try {
    installDfStub(sandbox, { size: 200 * 1024 * MIB, used: 80 * 1024 * MIB, avail: 120 * 1024 * MIB });
    writePreviousStatus(sandbox, { checkedAt: minutesAgo(60), availMb: 130 * 1024, level: "ok", usePct: 40 });

    run(sandbox, ["--check"]);

    // The acceptance criterion, stated as fields. `avail_mb_prev` and
    // `avail_mb_delta` are the two names the issue asks for by example, and the
    // rate and interval are what make the delta interpretable.
    assert.equal(statusValue(sandbox, "avail_mb_prev"), String(130 * 1024));
    assert.equal(statusValue(sandbox, "avail_mb"), String(120 * 1024));
    assert.equal(statusValue(sandbox, "avail_mb_delta"), String(-10 * 1024));
    assert.equal(statusValue(sandbox, "avail_mb_elapsed_minutes"), "60");
    assert.equal(statusValue(sandbox, "fall_rate_mb_per_hour"), String(-10 * 1024));
    assert.equal(statusValue(sandbox, "level_prev"), "ok");
    assert.equal(statusValue(sandbox, "fall_rate_threshold_mb_per_hour"), "-1024");
  } finally {
    sandbox.cleanup();
  }
});

test("trend: the first check on a clean volume has no previous value and writes empty trend fields rather than guessing", () => {
  const sandbox = makeSandbox();
  try {
    installDfStub(sandbox, { size: 200 * 1024 * MIB, used: 80 * 1024 * MIB, avail: 120 * 1024 * MIB });

    const result = run(sandbox, ["--check"]);

    assert.equal(result.status, RC_OK);
    // A trend needs two measurements. Writing zero here would report "free space
    // is not falling", which is a claim about a comparison that was never made.
    assert.equal(statusValue(sandbox, "avail_mb_prev"), "");
    assert.equal(statusValue(sandbox, "avail_mb_delta"), "");
    assert.equal(statusValue(sandbox, "fall_rate_mb_per_hour"), "");
    assert.equal(statusValue(sandbox, "avail_mb"), String(120 * 1024));
  } finally {
    sandbox.cleanup();
  }
});

test("trend: an absolute level regression between consecutive runs is escalated even when the level is only warn", () => {
  const sandbox = makeSandbox();
  try {
    // ok -> warn: the volume crossed the warn threshold between two checks. The
    // issue calls this out specifically, and it is the same fact as a fast fall
    // stated in fewer samples, so it escalates for the same reason.
    installDfStub(sandbox, { size: 200 * 1024 * MIB, used: 180 * 1024 * MIB, avail: 20 * 1024 * MIB });
    writePreviousStatus(sandbox, { checkedAt: minutesAgo(360), availMb: 20 * 1024 + 2, level: "ok", usePct: 40 });

    const result = run(sandbox, ["--check"]);

    assert.match(result.stdout, /level=warn/, "the trend must be reported and must have escalated the level");
    assert.match(result.stderr, /level regressed ok -> warn since the previous check/, "the regression must be logged with the exact past level that triggered it");
    // The test only asserts against status file here to confirm the new level is captured; the log is covered above.
    assert.equal(statusValue(sandbox, "level"), "warn");
    assert.equal(statusValue(sandbox, "level_prev"), "ok");
    // The fall here is tiny and well under the rate threshold, so this test is
    // only meaningful if the regression test is independent of the rate test.
    assert.match(result.stdout, /rate=-0MiB\/hour|rate=0MiB\/hour/);
  } finally {
    sandbox.cleanup();
  }
});

test("trend: a hand-edited or truncated previous value cannot drive an escalation", () => {
  const sandbox = makeSandbox();
  try {
    installDfStub(sandbox, { size: 200 * 1024 * MIB, used: 80 * 1024 * MIB, avail: 120 * 1024 * MIB });
    // An `avail_mb` that is not a bare integer. A substring-extraction-based parse
    // would hand this to the arithmetic and either error out or coerce it, and a
    // coerced value produces a confident rate out of nothing -- which is the
    // failure mode a guard that invents a level must never have.
    writePreviousStatus(sandbox, { checkedAt: minutesAgo(60), availMb: "120000 MiB", level: "ok", usePct: 40 });

    const result = run(sandbox, ["--check"]);

    assert.equal(result.status, RC_OK);
    assert.equal(statusValue(sandbox, "fall_rate_mb_per_hour"), "");
    assert.doesNotMatch(result.stderr, /falling free space/);
  } finally {
    sandbox.cleanup();
  }
});

test("trend: a previous stamp that is not the shape this guard writes yields no rate, not a guess", () => {
  const sandbox = makeSandbox();
  try {
    installDfStub(sandbox, { size: 200 * 1024 * MIB, used: 80 * 1024 * MIB, avail: 120 * 1024 * MIB });
    writePreviousStatus(sandbox, { checkedAt: minutesAgo(60), availMb: 130 * 1024, level: "ok", usePct: 40 });
    const body = readFileSync(sandbox.statusFile, "utf8").replace(/^checked_at=.*$/m, "checked_at=yesterday afternoon");
    writeFileSync(sandbox.statusFile, body);

    const result = run(sandbox, ["--check"]);

    assert.equal(result.status, RC_OK);
    assert.equal(statusValue(sandbox, "avail_mb_elapsed_minutes"), "");
    assert.equal(statusValue(sandbox, "fall_rate_mb_per_hour"), "");
    // The previous value is still recorded, because it is a fact about the last
    // run; only the interval we cannot establish is left empty.
    assert.equal(statusValue(sandbox, "avail_mb_prev"), String(130 * 1024));
  } finally {
    sandbox.cleanup();
  }
});

test("trend: the rate threshold is configurable, and disabling it leaves the level-regression signal working", () => {
  const sandbox = makeSandbox();
  try {
    installDfStub(sandbox, { size: 200 * 1024 * MIB, used: 80 * 1024 * MIB, avail: 120 * 1024 * MIB });
    writePreviousStatus(sandbox, { checkedAt: minutesAgo(60), availMb: 130 * 1024, level: "ok", usePct: 40 });

    // A threshold below the observed rate: the leak is still measured and still
    // written to the status file, it just is not an incident by this guard's
    // judgement. The rate is the output; the escalation is a policy over it, and
    // the two must be separable or an operator cannot tune one without losing
    // the other.
    const lenient = run(sandbox, ["--check"], { DISK_GUARD_FALL_RATE_MB_PER_HOUR: "-100000" });
    assert.doesNotMatch(lenient.stderr, /falling free space/, "a threshold below the observed rate must not escalate");
    assert.match(lenient.stdout, /rate=-10240MiB\/hour/, "the rate is still reported even when it does not escalate");
    assert.equal(statusValue(sandbox, "fall_rate_threshold_mb_per_hour"), "-100000");

    // Threshold disabled entirely, with a genuine ok -> warn regression. The
    // regression is a separate fact from the rate and must survive on its own.
    rmSync(sandbox.statusFile, { force: true });
    writePreviousStatus(sandbox, { checkedAt: minutesAgo(360), availMb: 20 * 1024 + 2, level: "ok", usePct: 40 });
    installDfStub(sandbox, { size: 200 * 1024 * MIB, used: 180 * 1024 * MIB, avail: 20 * 1024 * MIB });
    const disabled = run(sandbox, ["--check"], { DISK_GUARD_FALL_RATE_MB_PER_HOUR: "0" });
    assert.equal(disabled.status, RC_WARN, "the level regression is still escalated with the rate test off");
    assert.match(disabled.stderr, /level regressed ok -> warn/);
    assert.doesNotMatch(disabled.stderr, /falling free space/, "the rate test is off, so it must not have fired");
    assert.equal(statusValue(sandbox, "fall_rate_threshold_mb_per_hour"), "0");
  } finally {
    sandbox.cleanup();
  }
});

test("trend: --prune stays a no-op when the volume is ok, even with a falling trend", () => {
  const sandbox = makeSandbox();
  try {
    installDfStub(sandbox, { size: 200 * 1024 * MIB, used: 80 * 1024 * MIB, avail: 120 * 1024 * MIB });
    const apiStub = installPaperclipApiStub(sandbox);
    const { files } = seedNixGitCache(sandbox, { files: ["tmp_pack_sitting"], sizeBytes: 3 * MIB });
    const cache = seed(sandbox, ".cache/node/blob", 4 * MIB);

    // Pre-existing ok status with plenty of headroom: the guard must not delete a
    // cache because the *previous* run was trending down. Pruning is a response to
    // present pressure, and a trend is a reason to look, not a licence to delete.
    writePreviousStatus(sandbox, { checkedAt: minutesAgo(60), availMb: 130 * 1024, level: "ok", usePct: 40 });

    const result = run(sandbox, ["--prune"], { DISK_GUARD_API_STUB: apiStub });

    assert.equal(result.status, RC_WARN, "the trend escalates the reported level");
    assert.match(result.stdout, /prune_skipped=level_ok/, "but the prune itself is skipped at level ok");
    assert.ok(existsSync(cache), "a safe cache must survive a prune that was skipped");
    assert.ok(existsSync(files[0]), "an orphaned temp pack must survive a prune that was skipped");
    // The two answers have to be distinguishable, or "the guard escalated" and
    // "the guard deleted things" become the same event and neither is readable.
    assert.match(result.stdout, /prune_skipped=level_ok/);
    assert.doesNotMatch(result.stdout, /reclaimed_mib|reclaimed_nix_mib/);
  } finally {
    sandbox.cleanup();
  }
});

test("trend: --check needs no company id, so the signal cannot be lost to a tenant misconfiguration", () => {
  const sandbox = makeSandbox();
  try {
    installDfStub(sandbox, { size: 200 * 1024 * MIB, used: 80 * 1024 * MIB, avail: 120 * 1024 * MIB });
    writePreviousStatus(sandbox, { checkedAt: minutesAgo(60), availMb: 130 * 1024, level: "ok", usePct: 40 });

    const result = run(sandbox, ["--check"], { PAPERCLIP_COMPANY_ID: "", DISK_GUARD_COMPANY_ID: "" });

    assert.equal(result.status, RC_WARN);
    assert.match(result.stderr, /falling free space/, "the trend must be reported with no company id at all");
    assert.equal(statusValue(sandbox, "fall_rate_mb_per_hour"), String(-10 * 1024));
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
const EXPECTED_GUARD_VERSION = 8;
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
