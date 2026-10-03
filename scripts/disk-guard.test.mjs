import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  accessSync,
  closeSync,
  constants,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";

// Pins the disk-pressure guard (scripts/disk-guard.sh, runbook in
// docs/deploy/disk-guard.md) that protects the /paperclip PVC.
//
// Two things are load-bearing and both are asserted here:
//   1. The threshold matrix. Every knob is a DISK_GUARD_* env override so the
//      matrix can be pinned without a genuinely full volume, which is the only
//      way to test warn/critical on a CI runner.
//   2. The nlink==1 reclaim gate. `du` and `find -printf '%s'` over the whole
//      tree are both wrong here: pnpm's store looks like 581M but 31261 of
//      31417 inodes are hardlinked into live node_modules trees, so unlinking
//      it frees ~15M and breaks hardlink dedup. Only nlink==1 predicts bytes
//      actually returned to the filesystem.
//
// Every case runs against a tmpdir fixture via DISK_GUARD_MOUNT /
// DISK_GUARD_STATUS_FILE, so the suite never measures or writes the real
// /paperclip even if a knob regresses.

const repoRoot = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const scriptPath = join(repoRoot, "scripts", "disk-guard.sh");
const script = readFileSync(scriptPath, "utf8");

// Unreachable thresholds: `use_pct` is an integer percentage, so >100 pins
// level=ok regardless of how full the CI runner's tmpdir happens to be.
const OK = { DISK_GUARD_WARN_PCT: "101", DISK_GUARD_CRIT_PCT: "102", DISK_GUARD_MIN_FREE_MB: "1" };
// Deterministic warn: `use_pct >= 0` always holds and 101 is unreachable.
const WARN = { DISK_GUARD_WARN_PCT: "0", DISK_GUARD_CRIT_PCT: "101", DISK_GUARD_MIN_FREE_MB: "1" };

const MIB = 1024 * 1024;

// Sources the guard to call its internal unlinked_bytes(). `$1` inside the
// sourced script is this script's own path, so the trailing `case` lands on the
// usage-error branch: it only logs and calls `exit`, which is stubbed out so
// sourcing does not terminate the shell. No `df` runs and no status file is
// written on this path.
const UNLINKED_BYTES_PROBE = `
set -uo pipefail
exit() { :; }
. "$1"
unlinked_bytes "$2"
`;

function measureUnlinkedBytes(target) {
  const r = spawnSync("bash", ["-c", UNLINKED_BYTES_PROBE, "disk-guard-probe", scriptPath, target], {
    encoding: "utf8",
  });
  assert.equal(r.status, 0, `unlinked_bytes probe failed: ${r.stderr}`);
  return Number(r.stdout.trim());
}

function writeMiB(filePath) {
  const fd = openSync(filePath, "w");
  try {
    writeSync(fd, Buffer.alloc(MIB));
  } finally {
    closeSync(fd);
  }
  return filePath;
}

function parseStatusFile(text) {
  const out = {};
  for (const line of text.split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0) out[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return out;
}

// Extracts a bash array literal assigned with one quoted entry per line, so the
// prune target lists can be asserted without executing the script.
function arrayLiteral(name) {
  const m = new RegExp(`^${name}=\\(\n((?:\\s*"[^"]*"\n)+)\\)`, "m").exec(script);
  assert.ok(m, `could not locate the ${name}= array literal in disk-guard.sh`);
  return [...m[1].matchAll(/"([^"]*)"/g)].map((entry) => entry[1]);
}

function makeFixture(t) {
  const root = mkdtempSync(join(os.tmpdir(), "disk-guard-test-"));
  const mount = join(root, "mount");
  const statusFile = join(root, "run", "disk-guard.status");
  mkdirSync(mount, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  return {
    root,
    mount,
    statusFile,
    guard(args = [], env = {}) {
      const r = spawnSync("bash", [scriptPath, ...args], {
        encoding: "utf8",
        env: {
          ...process.env,
          DISK_GUARD_MOUNT: mount,
          DISK_GUARD_STATUS_FILE: statusFile,
          DISK_GUARD_FORCE: "",
          ...env,
        },
      });
      return {
        status: r.status,
        stdout: r.stdout ?? "",
        stderr: r.stderr ?? "",
        output: `${r.stdout ?? ""}${r.stderr ?? ""}`,
      };
    },
    status() {
      assert.ok(existsSync(statusFile), `expected a status file at ${statusFile}`);
      return parseStatusFile(readFileSync(statusFile, "utf8"));
    },
  };
}

// Populate every safe-cache target with a solo (nlink==1) 1MiB file.
function seedSafeCaches(mount) {
  const seeded = [];
  for (const rel of [".cache/node", ".cache/zig", ".npm/_cacache"]) {
    const dir = join(mount, rel);
    mkdirSync(dir, { recursive: true });
    seeded.push(writeMiB(join(dir, "solo.bin")));
  }
  return seeded;
}

test("guard is executable and parses", () => {
  accessSync(scriptPath, constants.X_OK);
  execFileSync("bash", ["-n", scriptPath]);
});

test("prune target lists exclude every measured non-reclaimable path", () => {
  const targets = [...arrayLiteral("safe_caches"), ...arrayLiteral("log_dirs")];

  for (const forbidden of [
    // Live SQLite WAL and database. Unlinking the WAL corrupts the DB; it can
    // only be reclaimed by checkpointing through sqlite.
    "opencode.db",
    // 31261 of 31417 inodes hardlinked into live node_modules: looks like 581M,
    // frees ~15M, breaks hardlink dedup.
    "pnpm/store",
    // Live agent homes and git worktrees on open branches.
    "/instances",
    "/wt/",
    // Live toolchains. nix GC needs proot and is unsafe unsupervised.
    ".nix-portable",
    "share/nix",
    ".rustup",
  ]) {
    assert.ok(
      targets.every((t) => !t.includes(forbidden)),
      `prune targets must not contain ${forbidden}: ${targets.join(" ")}`,
    );
  }

  // Every target must be rooted at $MOUNT so DISK_GUARD_MOUNT fully contains
  // what a prune can touch; a hardcoded /paperclip path would escape the
  // fixture and, worse, ignore a relocated deployment.
  for (const target of targets) {
    assert.ok(target.startsWith("$MOUNT/"), `prune target must be under $MOUNT: ${target}`);
  }
});

test("log rotation is limited to the opencode log directory", () => {
  const logDirs = arrayLiteral("log_dirs");
  assert.deepEqual(logDirs, ["$MOUNT/.local/share/opencode/log"]);
});

test("unlinked_bytes counts only nlink==1 inodes", (t) => {
  const f = makeFixture(t);
  const probe = join(f.root, "probe");
  mkdirSync(probe, { recursive: true });

  const solo = writeMiB(join(probe, "solo.bin"));
  const shared = writeMiB(join(probe, "shared.bin"));
  const sharedLink = join(probe, "shared-link.bin");
  linkSync(shared, sharedLink);

  // A tree that is mostly hardlinked measures as reclaimable only for the
  // genuinely solo bytes. This is the figure that forced the nlink gate, so it
  // is pinned byte-exactly rather than by range.
  assert.equal(measureUnlinkedBytes(solo), MIB);
  assert.equal(measureUnlinkedBytes(shared), 0);

  // And the gate survives a real hardlink fan-out, not just a two-name case.
  for (let i = 0; i < 8; i++) linkSync(shared, join(probe, `shared-link-${i}.bin`));
  assert.equal(measureUnlinkedBytes(shared), 0);
  assert.equal(measureUnlinkedBytes(probe), MIB);
});

test("--check writes the status file inside the fixture, never the real mount", (t) => {
  const f = makeFixture(t);
  const r = f.guard(["--check"], OK);
  assert.equal(r.status, 0);
  const status = f.status();
  assert.equal(status.mount, f.mount);
  assert.equal(status.level, "ok");
  assert.match(r.stdout, new RegExp(`mount=${f.mount.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} `));
});

test("WARN_PCT=1 is reachable on the fixture filesystem", (t) => {
  // The two cases below pin the documented 1% thresholds, which are only
  // meaningful if the fixture volume actually reports >=1% used. Asserting the
  // precondition separately means an unusually empty CI tmpfs fails here with
  // a readable reason instead of as a matrix mismatch.
  const f = makeFixture(t);
  f.guard(["--check"], OK);
  const pct = Number(f.status().use_pct);
  assert.ok(Number.isInteger(pct) && pct >= 1, `fixture reports use_pct=${pct}; the 1% threshold cases need >=1`);
});

test("--check exits 2 with level=warn at WARN_PCT=1", (t) => {
  const f = makeFixture(t);
  const r = f.guard(["--check"], {
    DISK_GUARD_WARN_PCT: "1",
    DISK_GUARD_CRIT_PCT: "101",
    DISK_GUARD_MIN_FREE_MB: "1",
  });
  assert.equal(r.status, 2, r.output);
  assert.equal(f.status().level, "warn");
  assert.match(r.stdout, /level=warn\b/);
});

test("--check exits 3 with level=critical at CRIT_PCT=1", (t) => {
  const f = makeFixture(t);
  const r = f.guard(["--check"], {
    DISK_GUARD_WARN_PCT: "1",
    DISK_GUARD_CRIT_PCT: "1",
    DISK_GUARD_MIN_FREE_MB: "1",
  });
  assert.equal(r.status, 3, r.output);
  assert.equal(f.status().level, "critical");
  assert.match(r.stdout, /level=critical\b/);
});

test("a too-high free-space floor trips warn even when the percentage is fine", (t) => {
  const f = makeFixture(t);
  const r = f.guard(["--check"], { ...OK, DISK_GUARD_MIN_FREE_MB: "999999999" });
  assert.equal(r.status, 2, r.output);
  const status = f.status();
  assert.equal(status.level, "warn");
  assert.equal(status.floor_mb, "999999999");
  assert.ok(Number(status.avail_mb) < 999999999, "floor must be above actual free space for this to trip");
  assert.match(r.stdout, /floor=999999999MiB/);
});

test("MIN_FREE_MB=0 zeroes the floor and restores level=ok", (t) => {
  const f = makeFixture(t);

  // Same unreachable percentage thresholds, floor disabled: nothing can warn.
  const disabled = f.guard(["--check"], { ...OK, DISK_GUARD_MIN_FREE_MB: "0" });
  assert.equal(disabled.status, 0, disabled.output);
  assert.equal(f.status().floor_mb, "0");
  assert.equal(f.status().level, "ok");
  assert.match(disabled.stdout, /floor=0MiB/);

  // Contrast: identical thresholds with a floor above actual free space warn.
  // The percentage is the same and unreachable in both runs, so the floor is
  // the only thing that changed.
  const floored = f.guard(["--check"], { ...OK, DISK_GUARD_MIN_FREE_MB: "999999999" });
  assert.equal(floored.status, 2, floored.output);
  assert.equal(f.status().floor_mb, "999999999");
  assert.equal(f.status().level, "warn");
});

test("--prune at level=ok is a no-op and says so", (t) => {
  const f = makeFixture(t);
  const seeded = seedSafeCaches(f.mount);

  const r = f.guard(["--prune"], OK);
  assert.equal(r.status, 0, r.output);
  assert.match(r.output, /prune_skipped=level_ok/);
  // Pruning is a pressure response, not a scheduled chore: a healthy volume
  // must not pay for regenerating a multi-hundred-MiB cache.
  for (const file of seeded) assert.ok(existsSync(file), `prune deleted ${file} at level=ok`);
  assert.doesNotMatch(r.output, /reclaimed_mib=/);
});

test("--prune deletes a solo cache and skips a hardlinked one", (t) => {
  const f = makeFixture(t);
  const soloDir = join(f.mount, ".cache", "node");
  const sharedDir = join(f.mount, ".cache", "zig");
  mkdirSync(soloDir, { recursive: true });
  mkdirSync(sharedDir, { recursive: true });
  writeMiB(join(soloDir, "solo.bin"));

  // A 1MiB cache that is hardlinked outside itself: 100% reclaimable by `du`,
  // 0 bytes by nlink accounting. Deleting it would break the live copy.
  const shared = writeMiB(join(sharedDir, "shared.bin"));
  linkSync(shared, join(f.root, "shared-outside.bin"));

  const r = f.guard(["--prune"], WARN);
  assert.equal(r.status, 2, r.output);
  assert.match(r.output, /prune .*\.cache\/node/);
  assert.match(r.output, /skip {2}.*\.cache\/zig \(only 0KiB unlinked-reclaimable\)/);
  assert.match(r.output, /reclaimed_mib=/);

  assert.equal(existsSync(soloDir), false, "solo cache should be pruned");
  assert.equal(existsSync(sharedDir), true, "hardlinked cache must survive the nlink gate");
  assert.equal(existsSync(shared), true);
  assert.equal(existsSync(join(f.root, "shared-outside.bin")), true);
});

test("--prune skips a cache that is too small to be worth deleting", (t) => {
  const f = makeFixture(t);
  const dir = join(f.mount, ".cache", "node");
  mkdirSync(dir, { recursive: true });
  const tiny = join(dir, "tiny.bin");
  writeFileSync(tiny, "x");

  const r = f.guard(["--prune"], WARN);
  assert.match(r.output, /skip {2}.*\.cache\/node \(only 0KiB unlinked-reclaimable\)/);
  assert.equal(existsSync(tiny), true);
});

test("--prune removes only rotated logs older than a day", (t) => {
  const f = makeFixture(t);
  const logDir = join(f.mount, ".local", "share", "opencode", "log");
  mkdirSync(logDir, { recursive: true });
  const stale = join(logDir, "rotated.log");
  const fresh = join(logDir, "live.log");
  writeFileSync(stale, "old");
  writeFileSync(fresh, "new");
  // `find -mtime +1` rounds down, so "more than a day" really means >=2 days.
  const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
  utimesSync(stale, threeDaysAgo, threeDaysAgo);

  const r = f.guard(["--prune"], WARN);
  assert.match(r.output, /prune .*opencode\/log \(rotated logs, mtime>1d\)/);
  assert.equal(existsSync(stale), false);
  assert.equal(existsSync(fresh), true, "a log written today is not rotated");
});

test("DISK_GUARD_FORCE=1 prunes a healthy volume anyway", (t) => {
  const f = makeFixture(t);
  const seeded = seedSafeCaches(f.mount);

  const r = f.guard(["--prune"], { ...OK, DISK_GUARD_FORCE: "1" });
  assert.equal(r.status, 0, r.output);
  assert.doesNotMatch(r.output, /prune_skipped=/);
  for (const file of seeded) assert.equal(existsSync(file), false);
});

test("--status replays the recorded state without measuring", (t) => {
  const f = makeFixture(t);
  f.guard(["--check"], { ...OK, DISK_GUARD_WARN_PCT: "1" });
  const recorded = f.status();

  const r = f.guard(["--status"]);
  assert.equal(r.status, 0, r.output);
  assert.equal(parseStatusFile(r.stdout).checked_at, recorded.checked_at);
  assert.equal(parseStatusFile(r.stdout).level, "warn");
});

test("--status and an unknown mode fail with the usage exit code", (t) => {
  const f = makeFixture(t);

  const missing = f.guard(["--status"]);
  assert.equal(missing.status, 1);
  assert.match(missing.output, /no status file/);

  const bogus = f.guard(["--bogus"]);
  assert.equal(bogus.status, 1);
  assert.match(bogus.output, /usage: disk-guard\.sh \[--check\|--prune\|--status\]/);
});
