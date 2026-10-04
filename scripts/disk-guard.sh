#!/usr/bin/env bash
# disk-guard.sh — disk-pressure guard for the /paperclip Longhorn PVC.
#
# Background: agents on this volume died with `ENOSPC: no space left on
# device, write`. The volume has since been grown in place 20G -> 197G
# (`df -h`; 196.7 GiB) across 2026-09-27/28 under the same PVC
# `pvc-16b1231a-b6f0-4293-b8c1-08d3974be5a8` (CON-211). Headroom is no longer
# the problem, but it will erode again, so this guard exists to report pressure
# deterministically *before* free space hits zero, making the condition visible
# instead of surfacing as a dead agent.
#
# Source of truth for the guard deployed on this volume. The repo copy is
# canonical; the two runtime copies at /paperclip/bin/disk-guard.sh and
# /paperclip/disk-guard.sh are deployed from it and must stay byte-identical.
# scripts/disk-guard.test.mjs pins the safety properties below, so run
# `node --test scripts/disk-guard.test.mjs` after any edit here.
#
# Safety rules baked in from measured behaviour on this volume:
#   * .local/share/opencode/opencode.db-wal  — live SQLite WAL. Deleting it
#     corrupts the DB. NEVER unlink. Only checkpoint via sqlite if asked.
#   * .local/share/pnpm/store                — 31261 of 31417 inodes are
#     hardlinked into node_modules, so it LOOKS like 581M but is almost
#     entirely un-reclaimable. Purging it frees ~15M and breaks hardlink dedup.
#   * instances/                             — live agent homes on open branches.
#     Deleting loses uncommitted work. Only build output (*/target, node_modules)
#     inside a checkout whose issue is terminal is ever a candidate.
#   * wt/                                    — shared git worktrees. Same rule:
#     the trees themselves and any source are never touched, only regenerable
#     build output, and only for this company's issues.
#   * .nix-portable, .local/share/nix, .rustup — live toolchains; nix GC needs
#     proot and is not safe to run unsupervised from a live pod.
#
# Everything in safe_caches/ is regenerable from the network. Reclaim is
# verified per-path by counting only nlink==1 inodes, so a path that has been
# hardlinked into a live tree is skipped rather than deleted.
#
# .cache/nix is deliberately NOT in safe_caches/. The nix git-fetch and tarball
# caches hold entries a *running* build may still need, so deleting the tree
# wholesale trades a rare orphan for a routine cache miss on a live build. Instead
# nix_orphan_temp_pack_candidates sweeps only what can be *proven* abandoned: a
# tmp_pack_*/tmp_idx_* that nix will never rename into place because the fetch
# died before it wrote a ref or an origin. Nix writes a fetch into
# `objects/pack/tmp_pack_*` and renames it into place only on success, so an
# interrupted fetch leaves the file there permanently, and nothing else on this
# volume ever cleaned them up. Three of them, abandoned 2026-09-28, held 9.3GiB
# that no authorized path could reach, which is why two consecutive runs
# escalated "prune insufficient" and blamed the PVC when the PVC was fine
# (CON-453, CON-458).
#
# The nix garbage collectors and the copy/import commands are NOT reclaim paths
# here, and must not become one. This volume's nix store is effectively empty
# (`$MOUNT/nixstore` is 1MiB, `.local/state/nix/profiles/` is empty) while the
# toolchains that matter live outside it, so GC roots would not cover them: a
# store GC here would collect the paths nothing appears to be using and leave the
# toolchains it cannot see. Proving roots cover the real toolchain is a
# precondition, not something to assume.
#
# A level alone cannot see a leak, so the guard also trends free space against its
# own previous measurement. On 2026-10-04 free space fell 13,022 -> 8,052 MiB in
# about an hour (~240 MiB/min) while the routine was a periodic ok-check: two runs
# read "critical but unexplainable", and the gap between the two facts -- the
# volume was critical *and* falling fast -- was only visible by hand, from
# diffing prose. A steady warn with reclaimable headroom is not an incident; an ok
# that is actively collapsing is. The rate, the delta and the previous value are
# all written to the status file so the trend is machine-readable.
#
# cargo-target-shared/ holds two kinds of dir. A dir named <PREFIX>-<number>
# belongs to one issue and is reclaimed only once that issue is terminal and the
# dir carries a matching .paperclip-owner marker. A dir belonging to no single
# issue (`debug/`, `tmp/`) has no issue to be terminal, so it is reclaimed on age
# and containment instead -- but only if its name is not attributed to some other
# company or issue, no cargo/rustc is running, and its inodes are unshared.
#
# wt/ holds shared git worktrees, scanned as a second deletion-capable root. It
# runs the *same* gate as instances/default/workspaces -- `corroborated_checkout_
# issue`, which demands repository identity first and then directory/branch
# agreement -- so a worktree is reclaimable only when a company clone vouches for
# it and its name and branch name the same ticket.
#
# That ordering is load-bearing, and the reason wt/ needed the gate at all rather
# than only name+branch. Measured across the 110 wt/ trees on this volume: 83 are
# not clones of the project repo and two have no origin at all, so 74 of them
# clear a name+branch check that carries no provenance -- including foreign
# `nixlab-*` and `sti-*` trees whose branches are free to name tickets in our
# namespace. A directory name is a label any process can create; `git
# rev-parse --git-common-dir` is evidence. Only the latter keeps them out.
#
# Within a company-vouched tree, corroboration is still required, because the
# names themselves disagree in the wild: `wt/con-220` is on
# `fix/con-220-clippy-194-stacked`, so the branch alone reads as `CLIPPY-194`,
# an issue that does not exist. Disagreement skips and fails closed.
#
# Usage:
#   disk-guard.sh --check     report only; exit 2 at WARN, 3 at CRIT
#   disk-guard.sh --prune     prune the verified-safe set, then report.
#                             No-op unless level is warn/critical; force with
#                             DISK_GUARD_FORCE=1.
#   disk-guard.sh --status    print last recorded status (no measurement)
#
# Thresholds are volume-relative: percentages are absolute, but the free-space
# floor is max(MIN_FREE_MB, 3% of total) so it stays correct after a resize.
# Set DISK_GUARD_MIN_FREE_MB=0 to disable the floor entirely.
#
# Trend thresholds: FALL_RATE_MB_PER_HOUR (default -1024, i.e. "losing more than
# 1GiB/hour") escalates a falling trend to warn even when the snapshot level is
# still ok, and TREND_MIN_INTERVAL_MINUTES (default 5) is the shortest gap between
# two checks for the rate to be believed at all. Set FALL_RATE_MB_PER_HOUR=0 to
# disable the rate test and escalate only on an absolute level or a level
# regression.
#
# Two levels, and the difference is load-bearing. `level` is what to tell a human
# and what the exit code carries: the trend can raise it. `level_snapshot` is what
# df alone said. Only level_snapshot authorises deletion -- --prune is a response to
# present pressure, and a healthy volume falling 10GiB/hour is a reason to check
# again sooner, not to delete a cache on a guess about the future.
#
# Exit codes: 0 ok, 1 usage error, 2 warn, 3 critical. Exit 1 also covers a
# failed measurement: if df cannot be read we cannot know the level, and the
# guard reports that rather than guessing a level it did not measure.
#
# Requires bash (shebang above), not POSIX sh: it uses `local`, a here-string,
# and two arrays. Keep it that way -- do not "simplify" it to sh.

set -uo pipefail

# Per-run memo directory for issue-terminality lookups. Torn down on exit so no
# cached decision from one invocation can be read by the next.
RUN_CACHE_DIR=""
cleanup_run_cache() {
  [ -n "$RUN_CACHE_DIR" ] && [ -d "$RUN_CACHE_DIR" ] && rm -rf -- "$RUN_CACHE_DIR" 2>/dev/null
  return 0
}
trap cleanup_run_cache EXIT
init_run_cache() {
  RUN_CACHE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/disk-guard-cache.XXXXXX" 2>/dev/null)" || RUN_CACHE_DIR=""
  [ -n "$RUN_CACHE_DIR" ] || return 1
  chmod 700 "$RUN_CACHE_DIR" 2>/dev/null
}

MOUNT="${DISK_GUARD_MOUNT:-/paperclip}"
WARN_PCT="${DISK_GUARD_WARN_PCT:-88}"
CRIT_PCT="${DISK_GUARD_CRIT_PCT:-94}"
MIN_FREE_MB="${DISK_GUARD_MIN_FREE_MB:-1500}"
STATUS_FILE="${DISK_GUARD_STATUS_FILE:-/paperclip/run/disk-guard.status}"
API_URL="${PAPERCLIP_API_URL:-http://127.0.0.1:3100}"
WORKSPACES_DIR="${DISK_GUARD_WORKSPACES_DIR:-$MOUNT/instances/default/workspaces}"
WORKSPACE_RECLAIM_MIN_AGE_HOURS="${DISK_GUARD_WORKSPACE_RECLAIM_MIN_AGE_HOURS:-24}"
CARGO_TARGET_SHARED_DIR="${DISK_GUARD_CARGO_TARGET_SHARED_DIR:-$MOUNT/cargo-target-shared}"
CARGO_TARGET_RECLAIM_MIN_AGE_HOURS="${DISK_GUARD_CARGO_TARGET_RECLAIM_MIN_AGE_HOURS:-24}"
WT_DIR="${DISK_GUARD_WT_DIR:-$MOUNT/wt}"
WT_RECLAIM_MIN_AGE_HOURS="${DISK_GUARD_WT_RECLAIM_MIN_AGE_HOURS:-24}"
# In-band ownership marker each shared cargo target dir must carry to be
# reclaimable. The dir name alone is a human-typed label, not proof of who owns
# the build output inside it.
CARGO_TARGET_OWNER_MARKER="${DISK_GUARD_CARGO_TARGET_OWNER_MARKER:-.paperclip-owner}"
# Root of the process table consulted when pgrep and pidof are both unavailable.
# Overridable only so the "cannot tell" branch of cargo_rustc_running is
# testable; production never sets it.
PROC_ROOT="${DISK_GUARD_PROC_ROOT:-/proc}"
# Nix git-fetch cache. Swept by a targeted rule rather than by adding `.cache/nix`
# to safe_caches[]: the gitv3 and tarball caches hold entries a running build may
# still need, so only evidence-of-abandonment is eligible, never the whole tree.
# See nix_orphan_temp_pack_candidates.
NIX_GIT_CACHE_DIR="${DISK_GUARD_NIX_GIT_CACHE_DIR:-$MOUNT/.cache/nix/gitv3}"
# How old a tmp_pack_* must be before it can be an abandoned fetch rather than an
# in-flight one. Nix renames a temp pack into place only when a fetch completes, so
# the file cannot be renamed at all while git holds it open; but a *threshold* is
# still the honest gate, because age is what separates the two cases without
# trusting a process table. The orphans reclaimed by hand on 2026-10-04 were 6 days
# old (CON-458), and a large pack takes minutes to hours to fetch, so a day leaves
# a wide margin on both sides and still catches the class within a routine.
NIX_ORPHAN_MIN_AGE_HOURS="${DISK_GUARD_NIX_ORPHAN_MIN_AGE_HOURS:-24}"
# Free space falling faster than this (MiB/hour, signed: negative is falling)
# escalates even when the absolute level is still ok. See report.
FALL_RATE_MB_PER_HOUR="${DISK_GUARD_FALL_RATE_MB_PER_HOUR:--1024}"
# A trend needs two measurements far enough apart to be more than rounding. Two
# checks a second apart divide a MiB-sized delta by a near-zero interval and
# manufacture an enormous rate out of noise, which would escalate on every pair of
# back-to-back invocations. Measured in whole minutes, and floored at 1 so the
# division below can never divide by zero.
TREND_MIN_INTERVAL_MINUTES="${DISK_GUARD_TREND_MIN_INTERVAL_MINUTES:-5}"
# The one repository a workspace checkout may belong to and still be reclaimable
# for. Gate 2 binds repository identity from `origin`, because terminality is
# read from this company's issue API and a checkout of another repo must never be
# able to spend one of our ticket identifiers. There is deliberately no "accept
# any origin that looks like ours" fallback: a wrong default here would be a
# silent authorization mismatch, and an unset one fails closed.
PROJECT_REPO="${DISK_GUARD_PROJECT_REPO:-https://github.com/olivecasazza/definitely-not-crosswords.git}"

mode="${1:---check}"

# Pruned only when the path is missing or contains no hardlinked inodes,
# so we never delete an inode another tree still depends on.
safe_caches=(
  "$MOUNT/.cache/node"
  "$MOUNT/.cache/zig"
  "$MOUNT/.cache/opencode"
  "$MOUNT/.cache/pnpm"
  "$MOUNT/.cache/ms-playwright"
  "$MOUNT/.npm/_cacache"
  "$MOUNT/.npm/_npx"
)

# Rotated logs only; never the live WAL, never opencode.db.
log_dirs=(
  "$MOUNT/.local/share/opencode/log"
)

log() { printf '%s\n' "$*" >&2; }

# Company whose issue API decides terminality. There is deliberately NO
# hardcoded fallback here. This guard previously fell back to a *different*
# company's id, so any invocation without PAPERCLIP_COMPANY_ID in the
# environment (cron, systemd, a bare shell) queried the wrong tenant, got a
# 403, and silently reclaimed nothing while still reporting a healthy level.
# A missing company id must be a loud configuration error, never a silent
# wrong-tenant lookup that degrades to "no reclaim" invisibly.
#
# Only --prune consults the issue API. --check and --status are the monitoring
# surface and must keep working with no company id at all: a guard that cannot
# measure pressure is worse than one that cannot reclaim, because the failure
# is invisible until the volume is already full.
require_company_id() {
  if [ -n "${DISK_GUARD_COMPANY_ID:-}" ]; then
    COMPANY_ID="$DISK_GUARD_COMPANY_ID"
  elif [ -n "${PAPERCLIP_COMPANY_ID:-}" ]; then
    COMPANY_ID="$PAPERCLIP_COMPANY_ID"
  else
    log "no company id: set DISK_GUARD_COMPANY_ID or PAPERCLIP_COMPANY_ID"
    exit 1
  fi
}

remove_path() {
  local p="$1"
  if [ "${DISK_GUARD_DRY_RUN:-0}" = "1" ]; then
    log "dry-run rm -rf $p"
    return 0
  fi
  rm -rf -- "$p" 2>/dev/null
}

api_get() {
  local path="$1" max_time="${2:-}"
  if [ -n "${DISK_GUARD_API_STUB:-}" ]; then
    "$DISK_GUARD_API_STUB" "$path"
    return $?
  fi
  [ -n "${PAPERCLIP_API_KEY:-}" ] || return 1
  # Every request is bounded: one hung endpoint must not be able to consume a
  # whole heartbeat. Callers that legitimately expect a larger body pass their
  # own ceiling.
  curl -fsS \
    --max-time "${max_time:-${DISK_GUARD_API_MAX_TIME:-15}}" \
    --connect-timeout "${DISK_GUARD_API_CONNECT_TIMEOUT:-5}" \
    -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
    -H "X-Paperclip-Run-Id: ${PAPERCLIP_RUN_ID:-disk-guard}" \
    "${API_URL%/}/api$path"
}

json_agent_ids() {
  node -e 'const fs=require("fs"); const data=JSON.parse(fs.readFileSync(0,"utf8")); for (const a of (Array.isArray(data)?data:data.items??[])) if (a&&a.id) console.log(a.id);'
}

json_issue_status() {
  node -e 'const fs=require("fs"); const want=process.argv[1]; const data=JSON.parse(fs.readFileSync(0,"utf8")); const items=Array.isArray(data)?data:data.items??[data.issue??data]; const issue=items.find((item)=>item&&String(item.identifier||"").toUpperCase()===want.toUpperCase()); if (issue&&issue.status) console.log(issue.status);' "$1"
}

unlinked_bytes() {
  # Bytes held by inodes with nlink==1 under $1. This is the only figure that
  # predicts space actually returned to the filesystem.
  find "$1" -xdev -type f -links 1 -printf '%s\n' 2>/dev/null | awk '{s+=$1} END{print s+0}'
}

# Whether anything under $2 is newer than the cutoff epoch.
#
# Replaces taking the newest mtime with a full sort. The only question any
# caller asks is "is anything here newer than the cutoff", so find can stop at
# the first entry that answers it: -print -quit short-circuits and nothing is
# sorted, so cost becomes the position of the first fresh entry rather than the
# size of the tree.
#
# The comparison is -newermt "@$((cutoff - 1))", not "@$cutoff", and that
# difference is load-bearing: callers skip when newest >= cutoff while -newermt
# is strictly newer, so testing the raw cutoff would let a candidate whose
# newest mtime is exactly the cutoff through as reclaimable where the old gate
# skipped it. Stepping back one second makes "mtime > cutoff-1" identical to
# "mtime >= cutoff" on whole seconds, which is the resolution compared here.
tree_has_entry_newer_than() {
  local cutoff="$1" dir="$2"
  [ -d "$dir" ] || return 1
  find "$dir" -xdev -newermt "@$(( cutoff - 1 ))" -print -quit 2>/dev/null
}

newest_mtime_epoch() {
  find "$1" -xdev -printf '%T@\n' 2>/dev/null | sort -nr | awk 'NR==1{printf "%d\n", $1; exit}'
}

candidate_issue_identifier() {
  local checkout="$1" branch identifier
  branch="$(git -C "$checkout" branch --show-current 2>/dev/null || true)"
  identifier="$(printf '%s\n' "$branch" | sed -nE 's/.*\b([A-Za-z]+-[0-9]+)\b.*/\U\1/p' | head -1)"
  [ -n "$identifier" ] && printf '%s\n' "$identifier"
}

# The ticket a directory name attributes to the <PREFIX>-<number> head, uppercased.
# `def-235-eventbus-lagged` names DEF-235 and `def-133-cargo-test` names DEF-133,
# matching the cargo-target rule at cargo_target_reclaim_candidates. A name with
# no ticket head yields nothing: not an identity, so the caller fails closed.
directory_issue_identifier() {
  printf '%s\n' "${1##*/}" | sed -nE 's/^([A-Za-z]+)-([0-9]+).*/\U\1-\2/p' | head -1
}

# Which repository a checkout belongs to, from git metadata rather than from
# where the directory sits.
#
# This is the half of gate 2 that the branch-name regex could not express at all.
# `workspaces/<agent>/pc-guard` is a checkout of a *different repository* -- this
# control plane's own -- whose branches are free to name tickets in our
# namespace (`def-139-fix-paperclip-node-modules` resolves to DEF-139 under any
# branch regex). Terminality is read from this company's issue API, so a foreign
# repo that mentions our ticket identifiers must never be able to spend them:
# that is the cross-repo deletion class CON-375 exists to prevent.
#
# `rev-parse --git-common-dir` answers "which clone owns this working tree".
# For a worktree of a known company clone it points at that clone's .git; for an
# independent clone it points at the checkout's own .git, which is the signal to
# fall back to binding by origin. Returns 1 when no identity can be established
# at all, so the caller skips rather than guessing.
checkout_repo_is_ours() {
  local checkout="$1" common toplevel origin
  common="$(git -C "$checkout" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)"
  toplevel="$(git -C "$checkout" rev-parse --show-toplevel 2>/dev/null || true)"
  [ -n "$common" ] && [ -n "$toplevel" ] || return 1
  # The checkout's own .git means nothing else in this volume vouches for it, so
  # the origin URL is the only remaining evidence and must match exactly.
  [ "$common" = "$toplevel/.git" ] || return 0
  origin="$(git -C "$checkout" remote get-url origin 2>/dev/null || true)"
  [ -n "$origin" ] || return 1
  [ "$origin" = "$PROJECT_REPO" ]
}

# The issue a workspace checkout is reclaimable against, or nothing at all.
#
# Three independent pieces of evidence must corroborate each other, and the
# function prints an identifier only when they do:
#
#   repository  `origin` (or the owning clone) says this is the project repo.
#               Refuses a foreign repo and a checkout with no identity at all.
#   directory   the <PREFIX>-<number> head of the directory name.
#   branch      the ticket token in the branch.
#
# The directory name and the branch are each sufficient to look convincing and
# each wrong alone, which is why neither may decide. Measured on this volume:
# `def-227-incorrect-state` sits on `fix/def-235-presence-ring` and
# `def-133-cargo-test` sits on `def-103-e2e-canary` -- both terminal, both
# disagreeing. A branch-name regex resolves those to the *branch's* issue and
# would reclaim a directory filed under a different one, and it resolves a
# foreign repo's branch to one of ours. Requiring all three to agree means a
# renamed, shared or borrowed branch fails closed instead of quietly spending
# whichever ticket it happened to mention.
#
# Prints the agreed identifier; returns 1 and logs the reason otherwise.
corroborated_checkout_issue() {
  local checkout="$1" from_dir from_branch
  if ! checkout_repo_is_ours "$checkout"; then
    local origin
    origin="$(git -C "$checkout" remote get-url origin 2>/dev/null || true)"
    if [ -n "$origin" ]; then
      log "skip  $checkout (origin '$origin' is not the company project repo '$PROJECT_REPO')"
    else
      log "skip  $checkout (cannot establish the repository identity: no origin and no company clone)"
    fi
    return 1
  fi
  from_dir="$(directory_issue_identifier "$checkout")"
  from_branch="$(candidate_issue_identifier "$checkout")"
  if [ -z "$from_dir" ]; then
    log "skip  $checkout (directory name does not attribute it to an issue)"
    return 1
  fi
  if [ -z "$from_branch" ]; then
    log "skip  $checkout (branch does not name an issue; a detached HEAD has no branch to agree with '$from_dir')"
    return 1
  fi
  if [ "$from_dir" != "$from_branch" ]; then
    log "skip  $checkout (branch says '$from_branch', directory says '$from_dir')"
    return 1
  fi
  printf '%s\n' "$from_dir"
}

# Read `key=value` out of the previous status file. Prints nothing when the file
# is absent or the key is missing or blank, so a caller can never mistake an empty
# field for a number.
status_field() {
  local key="$1" file="${2:-$STATUS_FILE}" value
  [ -f "$file" ] || return 1
  value="$(grep -m1 "^${key}=" "$file" 2>/dev/null)" || return 1
  value="${value#*=}"
  [ -n "$value" ] || return 1
  printf '%s\n' "$value"
}

# Whether any process holds an open file descriptor pointing at $1.
#
# This is the gate that separates "stale temp pack nobody is reading" from "temp
# pack a fetch is still writing", and it is checked directly against /proc rather
# than inferred from a process name: git does not keep the name `git fetch` for the
# whole fetch, and a name-based check would miss an in-flight fetch running under a
# different argv. Readlink on each fd resolves the target, and an unresolvable fd
# (a socket, an anon inode) is simply not a match.
#
# PROC_ROOT is overridable so this branch is testable; production never sets it.
path_has_open_fd() {
  local target="$1" target_real proc fd link seen=0
  target_real="$(realpath -e -- "$target" 2>/dev/null)" || return 1
  for proc in "$PROC_ROOT"/[0-9]*; do
    [ -d "$proc/fd" ] || continue
    seen=1
    for fd in "$proc"/fd/*; do
      [ -e "$fd" ] || continue
      link="$(readlink -- "$fd" 2>/dev/null)" || continue
      [ "$link" = "$target_real" ] && return 0
      # A deleted-but-open file reads as "<path> (deleted)"; comparing only the
      # exact realpath above would miss it, and an unlinked-but-open temp pack is
      # exactly the state worth catching. Strip the suffix before comparing.
      case "$link" in
        *" (deleted)")
          [ "${link% (deleted)}" = "$target_real" ] && return 0
          ;;
      esac
    done
  done
  # A /proc that existed and held processes but matched nothing is a real "no":
  # return 1, so the caller proceeds. The inverse of what it reads like -- get it
  # backwards and *every* candidate is reported as held-open, which is a silent
  # total no-op of the sweep rather than a visible failure.
  [ "$seen" -eq 0 ]
}

# Whether a git fetch cache repo never completed a fetch: no ref points into its
# packs and it recorded no origin.
#
# Both halves matter and either alone is enough. The CON-458 orphans had neither a
# ref nor an origin, because the fetch died before it wrote either. A repo that has
# an origin has been fetched at least once, so its temp packs may be adjacent to a
# legitimate second fetch; requiring both to be absent means only a repo that has
# demonstrably never completed a fetch is eligible.
nix_repo_never_fetched() {
  local repo="$1" heads tags origin
  # `show-ref` reads the packed-refs file as well as refs/, so a ref that has been
  # packed away is still seen. An unreadable or absent repo is not "never fetched".
  if git -C "$repo" rev-parse --git-dir >/dev/null 2>&1; then
    heads="$(git -C "$repo" for-each-ref --format='%(refname)' refs/heads 2>/dev/null || true)"
    tags="$(git -C "$repo" for-each-ref --format='%(refname)' refs/tags 2>/dev/null || true)"
    if [ -n "$heads" ] || [ -n "$tags" ]; then
      return 1
    fi
    origin="$(git -C "$repo" remote get-url origin 2>/dev/null || true)"
    [ -z "$origin" ]
    return
  fi
  # Not a readable git repo. Inspect the on-disk shape directly rather than
  # skipping: an aborted nix fetch can leave scaffolding too damaged for git to
  # open, and those are the cases most likely to be holding a multi-GiB pack.
  # Empty refs directories plus a config with no origin is the same evidence.
  heads="$(find "$repo/refs/heads" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null || true)"
  tags="$(find "$repo/refs/tags" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null || true)"
  [ -z "$heads" ] && [ -z "$tags" ] || return 1
  [ -z "$(grep -m1 -E '^\s*\[remote "origin"\]|^\s*url\s*=' "$repo/config" 2>/dev/null || true)" ]
}

# Orphaned nix git-fetch temp packs and indexes: reclaim candidates, one path per
# line.
#
# Why this exists and why it is not `.cache/nix` in safe_caches[]: nix writes a
# fetch into `objects/pack/tmp_pack_*` and renames it into place only when the fetch
# succeeds, so an interrupted fetch leaves the file there permanently. On
# 2026-10-04 three of them, abandoned on 2026-09-28, held 9.3GiB that nothing in
# this guard's authorized set could ever reclaim -- which is why two consecutive
# runs (CON-453, CON-458) escalated "prune insufficient" and blamed the PVC, when
# the PVC was fine and the reclaim sat outside the blast radius. Adding the whole
# cache would fix the symptom and break the guard: gitv3 and tarball-cache also
# hold entries a *running* build may still need, so blanket deletion trades a rare
# orphan for a routine cache miss on a live build. Only evidence of abandonment is
# eligible here.
#
# Four gates, all required, each independent of the others:
#
#   1. age       mtime older than NIX_ORPHAN_MIN_AGE_HOURS. A pack minutes old may
#                be a fetch in flight; the CON-458 orphans were six days old.
#   2. nlink     nlink==1, so the bytes are held here and nowhere else and are not
#                hardlinked into a live nix store path. Same measure every other
#                reclaim path in this guard uses.
#   3. open fd   no /proc/*/fd points at it. This is what makes the age gate a
#                backstop rather than the only defence: a fetch that has been
#                running for days still holds its pack open.
#   4. repo      the containing repo has no refs/heads, no refs/tags, and no
#                remote.origin.url -- it never completed a fetch, so no ref can
#                point into the pack being deleted.
#
# Each gate fails closed: an unreadable stat, an unreadable /proc, or a repo whose
# state cannot be established skips the candidate rather than guessing.
nix_orphan_temp_pack_candidates() {
  local cutoff repo pack size mtime nlinks
  [ -d "$NIX_GIT_CACHE_DIR" ] || return 0
  cutoff=$(( $(date +%s) - NIX_ORPHAN_MIN_AGE_HOURS * 3600 ))
  for repo in "$NIX_GIT_CACHE_DIR"/*; do
    [ -d "$repo" ] || continue
    [ ! -L "$repo" ] || { log "skip  $repo (repo is a symlink)"; continue; }
    [ -d "$repo/objects/pack" ] || continue
    if ! nix_repo_never_fetched "$repo"; then
      log "skip  $repo (repo is not a never-fetched cache repo: it has refs or a recorded origin)"
      continue
    fi
    # -maxdepth 1 so the walk cannot descend into a pack that happens to be a
    # directory, and -type f so a directory or fifo named tmp_pack_* is not walked
    # into. The link count is deliberately *not* a find predicate here: `-links 1`
    # is the cheaper way to enforce the nlink gate, but it drops the file from the
    # output entirely, so the sweep says nothing about it. A refusal an operator
    # cannot see is indistinguishable from the sweep not having run, which is the
    # same blind spot that let CON-458 read as a mystery. Enforcing nlink in the
    # loop below keeps the gate and makes it report its reason.
    while IFS= read -r pack; do
      [ -n "$pack" ] || continue
      if [ ! -f "$pack" ]; then
        log "skip  $pack (not a regular file)"
        continue
      fi
      if [ -L "$pack" ]; then
        log "skip  $pack (candidate is a symlink)"
        continue
      fi
      # contained_realpath, not realpath, so a path that is a symlink chain out of
      # the cache cannot authorize a delete somewhere else on the volume.
      local pack_real
      pack_real="$(contained_realpath "$NIX_GIT_CACHE_DIR" "$pack")" || {
        log "skip  $pack (outside the nix git cache)"
        continue
      }
      # stat as one call so nlink and mtime come from the same observation. A file
      # that disappears between enumeration and here is a fetch that completed or
      # was cleaned; either way there is nothing left to decide.
      read -r nlinks mtime <<<"$(stat -c '%h %Y' -- "$pack_real" 2>/dev/null)" || {
        log "skip  $pack (cannot stat)"
        continue
      }
      if [ -z "${nlinks:-}" ] || [ -z "${mtime:-}" ]; then
        log "skip  $pack (cannot stat)"
        continue
      fi
      if [ "$mtime" -ge "$cutoff" ]; then
        log "skip  $pack (mtime is within ${NIX_ORPHAN_MIN_AGE_HOURS}h; may be an in-flight fetch)"
        continue
      fi
      if [ "$nlinks" -ne 1 ]; then
        log "skip  $pack (nlink=$nlinks; held by another link, not reclaimable here)"
        continue
      fi
      if path_has_open_fd "$pack_real"; then
        log "skip  $pack (a process holds it open)"
        continue
      fi
      size="$(stat -c '%s' -- "$pack_real" 2>/dev/null || echo 0)"
      printf '%s\t%s\n' "$pack_real" "${size:-0}"
    done < <(find "$repo/objects/pack" -xdev -maxdepth 1 \
                \( -name 'tmp_pack_*' -o -name 'tmp_idx_*' \) \
                -type f -print 2>/dev/null)
  done
}

# Delete orphaned nix git-fetch temp packs and indexes.
# This runs as part of --prune when the volume is warn/critical (or forced) and
# targets only the temp packs/idxs under .cache/nix/gitv3.
reclaim_nix_orphans() {
  local before after candidate size total=0

  before="$(df --block-size=1 -P "$MOUNT" | awk 'NR>1 && NF>=5 {print $4; exit}')"

  while IFS=$'\t' read -r candidate size; do
    [ -n "$candidate" ] || continue
    if [ "${size:-0}" -lt 1048576 ]; then
      log "skip  $candidate (only $(( ${size:-0} / 1024 ))KiB unlinked-reclaimable)"
      continue
    fi
    remove_path "$candidate"
    log "reclaim $candidate (~$(( size / 1024 / 1024 ))MiB orphaned nix temp pack/idx)"
    total=$(( total + size ))
  done <<<"$(nix_orphan_temp_pack_candidates)"

  # Nothing matched is a normal no-op, not an error: on a healthy volume there are
  # no orphans and the sweep has nothing to say. Reporting only when it reclaimed
  # keeps the routine's comments readable and keeps "swept, found nothing" from
  # reading like a failure.
  [ "$total" -gt 0 ] || return 0
  after="$(df --block-size=1 -P "$MOUNT" | awk 'NR>1 && NF>=5 {print $4; exit}')"
  printf 'reclaimed_nix_mib=%s\n' "$(( (after - before) / 1024 / 1024 ))"
}

issue_is_terminal() {
  local identifier="$1" status
  [ -n "$identifier" ] || return 1
  [ -n "$RUN_CACHE_DIR" ] || return 1

  # A terminal decision for one identifier is a property of the issue, not of the
  # checkout that mentions it, so it is memoised for the rest of the run. The memo
  # records only a status we actually recognised: a transport failure leaves no
  # memo, so the lookup below retries and the caller still fails closed.
  local memo="$RUN_CACHE_DIR/issue-${identifier}"
  if [ -f "$memo" ]; then
    read -r status <"$memo"
    log "issue_cache hit $identifier -> $status"
    [ "$status" = "done" ] || [ "$status" = "cancelled" ]
    return
  fi

  status="$(_lookup_issue_status "$identifier")"
  case "$status" in
    done|cancelled|active|blocked|in_progress|todo|backlog|in_review)
      printf '%s\n' "$status" >"$memo" 2>/dev/null
      ;;
    *)
      # Unknown or empty: not ours to reclaim. Deliberately uncached so the next
      # checkout that names it is judged on its own evidence, never on a guess.
      ;;
  esac
  [ "$status" = "done" ] || [ "$status" = "cancelled" ]
}

# Resolve one identifier to a status, spending at most one network request.
#
# The question "is <identifier> terminal?" is asked once per checkout, and the
# answer must come from *this* company's issues -- that tenant scoping is what
# stops a foreign repository that happens to name our ticket from spending it.
# It was previously answered with one unbounded `?q=<identifier>` fuzzy search per
# checkout, which is a full server-side scan: ~7s and ~38KB to return ten issues.
# Across a `--prune` over 116 checkouts that was 76 sequential round trips, ~193s
# of a ~197s run, against a heartbeat with a finite ceiling (DEF-304, DEF-307).
#
# Two facts make one page fetch sufficient instead:
#
#   1. The snapshot is this company's whole issue list, so any identifier we own is
#      in it. `?q=` could only ever find an issue the snapshot also contains.
#   2. An identifier outside this company's namespace cannot match anything here,
#      so its answer is "not ours" without a request. Fuzzy `?q=` on a foreign
#      identifier returns unrelated issues that merely contain the string, which
#      is exactly what the fail-closed branch below treats as not-ours anyway.
#
# Fail-closed is preserved throughout: no snapshot, or an unreadable one, falls
# back to the original per-identifier search.
_lookup_issue_status() {
  local identifier="$1" snapshot=""
  case "$identifier" in
    "" ) return 0 ;;
    *-* ) ;;
    * ) return 0 ;;
  esac

  if [ ! -f "$RUN_CACHE_DIR/snapshot.done" ]; then
    # The bulk page is much larger than a ten-issue search (1MB/296 issues here),
    # so it gets its own, longer ceiling -- but still a bounded one.
    #
    # A failed attempt is remembered for the rest of the run. Without that, every
    # checkout retries a request we have already seen fail or exceed its ceiling,
    # which is how one expensive probe becomes the entire heartbeat: the failure
    # costs as much as the success, times the number of checkouts.
    if [ ! -f "$RUN_CACHE_DIR/snapshot.failed" ]; then
      if snapshot="$(api_get "/companies/$COMPANY_ID/issues?limit=500" 2>/dev/null \
                       "${DISK_GUARD_API_BULK_MAX_TIME:-45}")" \
         && [ -n "$snapshot" ] \
         && snapshot="$(_slim_issue_list "$snapshot")" \
         && _snapshot_is_issue_list "$snapshot"; then
        printf '%s' "$snapshot" >"$RUN_CACHE_DIR/snapshot.json" 2>/dev/null
        : >"$RUN_CACHE_DIR/snapshot.done" 2>/dev/null
        _company_prefixes >"$RUN_CACHE_DIR/prefixes.txt" 2>/dev/null
        : >"$RUN_CACHE_DIR/prefixes.ready" 2>/dev/null
      else
        # Not a list of issues we can read, or too slow to fetch. Do not trust it.
        # Fall back to the per-identifier search for the rest of this run.
        log "issue_snapshot unusable; falling back to per-issue search"
        : >"$RUN_CACHE_DIR/snapshot.failed" 2>/dev/null
      fi
    fi
  fi

  if [ -s "$RUN_CACHE_DIR/snapshot.json" ]; then
    local status
    status="$(json_issue_status "$identifier" <"$RUN_CACHE_DIR/snapshot.json" 2>/dev/null || true)"
    if [ -n "$status" ]; then
      log "issue_snapshot hit $identifier -> $status"
      printf '%s\n' "$status"
      return 0
    fi
    # Absent from our own issue list: not ours, definitively. No request needed.
    log "issue_snapshot miss $identifier (not in this company's issues)"
    return 0
  fi

  # No usable snapshot. An identifier in a namespace this company does not use
  # still cannot resolve, and a fuzzy search for it only returns unrelated
  # issues -- which the caller already reads as not-ours. Decline it locally
  # rather than spend a request to learn nothing.
  if _identifier_outside_company_namespace "$identifier"; then
    log "issue_namespace_miss $identifier (not a prefix this company uses; not searched)"
    return 0
  fi

  api_get "/companies/$COMPANY_ID/issues?q=$identifier&limit=10" 2>/dev/null \
    | json_issue_status "$identifier" 2>/dev/null || true
}

# The set of identifier prefixes this company actually uses, learned from the
# snapshot rather than assumed. `?q=` is a fuzzy server-side scan, so searching
# for another company's ticket cannot return that ticket -- it returns whatever
# unrelated issue happens to contain the string, which the caller already treats
# as "not ours". Knowing the prefixes lets us decline those searches outright.
#
# Only ever *adds* to the skip set, and only from data this company served, so a
# wrong or empty answer costs requests but can never authorise a delete.
_company_prefixes() {
  [ -s "$RUN_CACHE_DIR/snapshot.json" ] || return 0
  node -e '
    const fs = require("fs");
    let data;
    try { data = JSON.parse(fs.readFileSync(0, "utf8")); } catch { process.exit(0); }
    const items = Array.isArray(data) ? data : (data && Array.isArray(data.items) ? data.items : []);
    const prefixes = new Set();
    for (const i of items) {
      const m = /^([A-Za-z]+)-[0-9]+$/.exec(String(i && i.identifier || ""));
      if (m) prefixes.add(m[1].toUpperCase());
    }
    console.log([...prefixes].sort().join(" "));
  ' <"$RUN_CACHE_DIR/snapshot.json"
}

# True when this identifier is in a namespace this company demonstrably does not
# use, so no request can resolve it and its answer is already known.
_identifier_outside_company_namespace() {
  local identifier="$1" prefixes prefix
  [ -n "${DISK_GUARD_ASSUME_NAMESPACE:-}" ] && return 1
  [ -f "$RUN_CACHE_DIR/prefixes.ready" ] || return 1
  read -r prefixes <"$RUN_CACHE_DIR/prefixes.txt" 2>/dev/null || return 1
  [ -n "$prefixes" ] || return 1
  case "${identifier%%-*}" in
    [A-Za-z]*) prefix="$(printf '%s' "${identifier%%-*}" | tr '[:lower:]' '[:upper:]')" ;;
    *) return 1 ;;
  esac
  case " $prefixes " in
    *" $prefix "*) return 1 ;;
    *) return 0 ;;
  esac
}

# Keep only the two fields the terminality decision reads. A 296-issue page
# carries descriptions, conversation state and counters that cost bytes on the
# wire and time to parse, none of which any reclaim gate consults.
_slim_issue_list() {
  printf '%s' "$1" | node -e '
    const fs = require("fs");
    let data;
    try { data = JSON.parse(fs.readFileSync(0, "utf8")); } catch { process.exit(1); }
    const items = Array.isArray(data) ? data : (data && Array.isArray(data.items) ? data.items : null);
    if (!items) process.exit(1);
    console.log(JSON.stringify(items
      .filter((i) => i && i.identifier && i.status)
      .map((i) => ({ identifier: i.identifier, status: i.status }))));
  '
}

# True only when the payload really is a list of issues carrying a usable
# identifier and status. This is the guard on the guard: a 200 response that is
# not an issue list (an error envelope, an empty object, a filtered page with no
# identifying fields) must not be able to read as "this company has no such
# issue", because that reading is what licenses a delete.
_snapshot_is_issue_list() {
  printf '%s' "$1" | node -e '
    const fs = require("fs");
    let data;
    try { data = JSON.parse(fs.readFileSync(0, "utf8")); } catch { process.exit(1); }
    const items = Array.isArray(data) ? data : (data && Array.isArray(data.items) ? data.items : null);
    if (!items) process.exit(1);
    // An empty list is a legitimate answer only if the route really returned an
    // issue list; require the envelope to look like one.
    if (items.length === 0) process.exit(1);
    process.exit(items.some((i) => i && i.identifier && i.status) ? 0 : 1);
  '
}

contained_realpath() {
  local base="$1" target="$2" base_real target_real
  base_real="$(realpath -e -- "$base" 2>/dev/null)" || return 1
  target_real="$(realpath -e -- "$target" 2>/dev/null)" || return 1
  case "$target_real" in
    "$base_real"/*) printf '%s\n' "$target_real" ;;
    *) return 1 ;;
  esac
}

# Whole minutes between two `YYYY-MM-DDTHH:MM:SSZ` stamps, or nothing.
#
# The conversion goes through `date -d` rather than a hand-rolled substring parse
# because the failure modes differ in a way that matters here: an unparseable
# stamp must produce *no answer*, and `date -d` failing is exactly that signal,
# whereas a field extraction on a malformed string would happily return the
# numbers it found and produce a plausible-looking interval from nonsense. The
# caller treats empty as "no trend", which is the correct reading of "I cannot
# tell how long ago that was".
_iso8601_elapsed_minutes() {
  local from="$1" to="$2" from_s to_s
  # Only the exact shape this guard writes is accepted. A stamp carrying anything
  # else -- a local offset, fractional seconds, an empty field -- is not one of
  # ours to interpret.
  case "$from" in
    [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]Z) ;;
    *) return 1 ;;
  esac
  case "$to" in
    [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]Z) ;;
    *) return 1 ;;
  esac
  from_s="$(date -u -d "$from" +%s 2>/dev/null)" || return 1
  to_s="$(date -u -d "$to" +%s 2>/dev/null)" || return 1
  case "$from_s" in ''|*[!0-9]*) return 1 ;; esac
  case "$to_s" in ''|*[!0-9]*) return 1 ;; esac
  printf '%d\n' "$(( (to_s - from_s) / 60 ))"
}

workspace_reclaim_candidates() {
  local agents_json agent_id workspace checkout rel p p_real identifier newest cutoff tracked
  [ -d "$WORKSPACES_DIR" ] || return 0
  agents_json="$(api_get "/companies/$COMPANY_ID/agents" 2>/dev/null)" || return 0
  cutoff=$(( $(date +%s) - WORKSPACE_RECLAIM_MIN_AGE_HOURS * 3600 ))
  while IFS= read -r agent_id; do
    workspace="$WORKSPACES_DIR/$agent_id"
    [ -d "$workspace" ] || continue
    for checkout in "$workspace"/* "$workspace"/*/.paperclip/worktrees/*; do
      [ -e "$checkout" ] || continue
      [ -d "$checkout/.git" ] || [ -f "$checkout/.git" ] || continue
      # Gate 2. Returns nothing when repository, directory name and branch do not
      # corroborate one issue, and has already logged why, so the refusal is
      # visible in --prune output rather than being an undecided-looking skip.
      identifier="$(corroborated_checkout_issue "$checkout")"
      if ! issue_is_terminal "$identifier"; then
        for rel in client/target target node_modules; do
          [ -e "$checkout/$rel" ] && log "skip  $checkout/$rel (issue ${identifier:-unknown} is not terminal)"
        done
        continue
      fi
      for rel in client/target target node_modules; do
        p="$checkout/$rel"
        [ -e "$p" ] || continue
        if [ -L "$p" ]; then
          log "skip  $p (candidate is a symlink)"
          continue
        fi
        p_real="$(contained_realpath "$workspace" "$p")" || {
          log "skip  $p (outside rostered workspace)"
          continue
        }
        if ! git -C "$checkout" check-ignore -q -- "$rel"; then
          log "skip  $p (not gitignored)"
          continue
        fi
        tracked="$(git -C "$checkout" ls-files -- "$rel" 2>/dev/null | wc -l | tr -d ' ')"
        if [ "${tracked:-0}" -ne 0 ]; then
          log "skip  $p (contains tracked files)"
          continue
        fi
        if [ "$(tree_has_entry_newer_than "$cutoff" "$p")" ]; then
          log "skip  $p (newest mtime under ${WORKSPACE_RECLAIM_MIN_AGE_HOURS}h)"
          continue
        fi
        printf '%s\n' "$p_real"
      done
    done
  done <<<"$(printf '%s' "$agents_json" | json_agent_ids)"
}

# Second deletion-capable root: shared git worktrees under wt/.
#
# Build output under a worktree is regenerable, so reclaiming it cannot lose
# source -- but the tree itself can still be another company's, and this volume
# holds `wt/nixlab-*` and `wt/sti-*` from three other repos. So this root runs
# the identical gate the workspace root runs, via the identical function:
# `corroborated_checkout_issue`, which refuses unless a company clone vouches for
# the repository AND the directory name and git branch name the same ticket.
#
# Reusing the workspace gate rather than a wt-only name+branch helper is the point
# of the change: name and branch agree on 74 of the 83 trees here that are not
# clones of the project repo, so corroboration alone is a name-based check standing
# in for a provenance-based one. Provenance first, corroboration second.
wt_reclaim_candidates() {
  local checkout rel p p_real identifier tracked newest cutoff
  [ -d "$WT_DIR" ] || return 0
  cutoff=$(( $(date +%s) - WT_RECLAIM_MIN_AGE_HOURS * 3600 ))
  for checkout in "$WT_DIR"/*; do
    [ -d "$checkout" ] || continue
    [ ! -L "$checkout" ] || { log "skip  $checkout (worktree is a symlink)"; continue; }
    [ -e "$checkout/.git" ] || continue
    identifier="$(corroborated_checkout_issue "$checkout")"
    if [ -z "$identifier" ]; then
      continue
    fi
    if ! issue_is_terminal "$identifier"; then
      log "skip  $checkout (issue $identifier is not terminal)"
      continue
    fi
    for rel in target node_modules client/target; do
      p="$checkout/$rel"
      [ -e "$p" ] || continue
      if [ -L "$p" ]; then
        log "skip  $p (candidate is a symlink)"
        continue
      fi
      p_real="$(contained_realpath "$WT_DIR" "$p")" || {
        log "skip  $p (outside wt)"
        continue
      }
      # `git check-ignore` exits 1 both for "no rule matches" and for "a rule
      # matches but the path is tracked" -- tracked files are never ignored, so a
      # force-added build dir reports NOT ignored here. That is what makes the
      # check-ignore gate alone sufficient to exclude tracked files; the explicit
      # `git ls-files` gate below re-states the same condition as a readable
      # defence rather than a second independent one, and is deliberately kept so
      # a future git behaviour change cannot turn a tracked path into a candidate.
      if ! git -C "$checkout" check-ignore -q -- "$rel"; then
        log "skip  $p (not gitignored)"
        continue
      fi
      tracked="$(git -C "$checkout" ls-files -- "$rel" 2>/dev/null | wc -l | tr -d ' ')"
      if [ "${tracked:-0}" -ne 0 ]; then
        log "skip  $p (contains tracked files)"
        continue
      fi
      if [ "$(tree_has_entry_newer_than "$cutoff" "$p")" ]; then
        log "skip  $p (newest mtime under ${WT_RECLAIM_MIN_AGE_HOURS}h)"
        continue
      fi
      printf '%s\n' "$p_real"
    done
  done
}

# A name that fails the <PREFIX>-<number> shape is not automatically shared
# output. `def-129-base`, `def-129-cold` and `def-doc` all fail it too, but their
# `def-` head attributes them to another company's issue namespace, and
# reclaiming on name shape alone is exactly the cross-company deletion CON-375
# exists to prevent. So a shared candidate must carry no company/issue prefix at
# all: `debug` and `tmp` qualify, `def-129-base` does not. Failing closed here
# leaves a labelled dir for a human to attribute rather than guessing.
shared_name_unattributed() {
  case "$1" in
    [A-Za-z]*-*) return 1 ;;
    *) return 0 ;;
  esac
}

# 0 = a cargo or rustc process is live, 1 = none is, 2 = cannot tell.
#
# A shared target dir is likelier to be mid-build than a per-issue dir, because
# every build in the company can point at it, so this guard is what stands
# between --prune and a build writing into the tree. pgrep is absent from some of
# the images this guard runs on, so fall back to pidof and then to /proc. A tool
# that errors is not evidence of absence: only a clean "no match" counts, and an
# unreadable process table reports 2 so the caller can skip.
cargo_rustc_running() {
  local tool name rc
  for tool in pgrep pidof; do
    command -v "$tool" >/dev/null 2>&1 || continue
    for name in cargo rustc; do
      "$tool" -x "$name" >/dev/null 2>&1
      rc=$?
      [ "$rc" -eq 0 ] && return 0
      [ "$rc" -ne 1 ] && continue 2
    done
    return 1
  done
  local comm proc seen=0
  # PROC_ROOT exists so the "cannot tell" outcome is reachable in a test. The
  # production value is /proc and nothing should override it; a mount namespace
  # that hides /proc is not something a test can arrange in an unprivileged
  # container, and an untestable fail-closed branch is one that rots.
  for proc in "$PROC_ROOT"/[0-9]*/comm; do
    [ -r "$proc" ] || continue
    seen=1
    read -r comm <"$proc" 2>/dev/null || continue
    case "$comm" in
      cargo|rustc) return 0 ;;
    esac
  done
  [ "$seen" -eq 1 ] && return 1
  return 2
}

# Shared, non-per-issue target dirs: output that belongs to no single issue, so
# issue_is_terminal has nothing to resolve and age/containment alone decide. All
# five gates must pass, and any uncertainty skips.
shared_cargo_target_candidate() {
  local p="$1" name="$2" cutoff="$3" p_real newest running
  if ! shared_name_unattributed "$name"; then
    log "skip  $p (not a per-issue name, but named for a company or issue)"
    return 1
  fi
  p_real="$(contained_realpath "$CARGO_TARGET_SHARED_DIR" "$p")" || {
    log "skip  $p (outside cargo-target-shared)"
    return 1
  }
  if [ "$(tree_has_entry_newer_than "$cutoff" "$p")" ]; then
    log "skip  $p (newest mtime under ${CARGO_TARGET_RECLAIM_MIN_AGE_HOURS}h)"
    return 1
  fi
  cargo_rustc_running
  running=$?
  if [ "$running" -eq 0 ]; then
    log "skip  $p (cargo or rustc is running)"
    return 1
  fi
  if [ "$running" -ne 1 ]; then
    log "skip  $p (cannot tell whether cargo or rustc is running)"
    return 1
  fi
  # The nlink==1 count is applied by the caller, same as every other candidate:
  # only inodes nothing else links to are counted as reclaimable, so a shared
  # tree that shares inodes with a live build is skipped rather than deleted.
  printf '%s\n' "$p_real"
}

cargo_target_reclaim_candidates() {
  local p p_real name identifier marked newest cutoff
  [ -d "$CARGO_TARGET_SHARED_DIR" ] || return 0
  cutoff=$(( $(date +%s) - CARGO_TARGET_RECLAIM_MIN_AGE_HOURS * 3600 ))
  for p in "$CARGO_TARGET_SHARED_DIR"/*; do
    [ -d "$p" ] || continue
    [ ! -L "$p" ] || { log "skip  $p (candidate is a symlink)"; continue; }
    name="$(basename -- "$p")"
    identifier="$(printf '%s\n' "$name" | sed -nE 's/^([A-Za-z]+)-([0-9]+)$/\U\1-\2/p')"
    if [ -z "$identifier" ]; then
      # No issue to be terminal, so the shared path decides instead of skipping
      # outright. It prints the candidate on success and logs its own refusals.
      shared_cargo_target_candidate "$p" "$name" "$cutoff"
      continue
    fi
    # A directory name is a label a person or agent typed, not evidence of who
    # owns the build output inside it. `def-190/` can hold another issue's
    # artifacts, and this volume already holds `def-129-base/` and
    # `def-129-cold/` beside `def-129/`. Deleting on the name alone removes
    # output the name does not describe, so require an in-band marker written by
    # whoever populated the directory and require it to agree with the name. A
    # dir with no marker is skipped: fail closed, and leave the space for a
    # human to attribute.
    if [ ! -f "$p/$CARGO_TARGET_OWNER_MARKER" ] || [ -L "$p/$CARGO_TARGET_OWNER_MARKER" ]; then
      log "skip  $p (no $CARGO_TARGET_OWNER_MARKER ownership marker)"
      continue
    fi
    marked="$(tr -d '[:space:]' <"$p/$CARGO_TARGET_OWNER_MARKER" 2>/dev/null || true)"
    if [ "$(printf '%s\n' "$marked" | tr '[:lower:]' '[:upper:]')" != "$identifier" ]; then
      log "skip  $p (marker says '${marked:-<empty>}', dir says '$identifier')"
      continue
    fi
    if ! issue_is_terminal "$identifier"; then
      log "skip  $p (issue $identifier is not terminal)"
      continue
    fi
    p_real="$(contained_realpath "$CARGO_TARGET_SHARED_DIR" "$p")" || {
      log "skip  $p (outside cargo-target-shared)"
      continue
    }
    if [ "$(tree_has_entry_newer_than "$cutoff" "$p")" ]; then
      log "skip  $p (newest mtime under ${CARGO_TARGET_RECLAIM_MIN_AGE_HOURS}h)"
      continue
    fi
    printf '%s\n' "$p_real"
  done
}

measure() {
  # df -P columns: 1=filesystem 2=size 3=used 4=avail 5=capacity 6=mount
  # Use awk so column positions and the percentage are explicit rather than
  # depending on locale, field wrapping, or bash having a ternary operator.
  #
  # The percentage is taken from df’s own Use% column (5) rather than
  # recomputed here. df reports Use% against used+avail, rounded up to the
  # ceiling, while `int(used*100/size)` truncates against total blocks. On
  # the /paperclip PVC reserved space is only 16MiB of 197GiB (0.008%), so the
  # two denominators agree to within rounding and the difference is truncation:
  # at 82.498% the guard published 82 while `df -h` printed 83, and a
  # human comparing the status file against the df they just ran read that as a
  # 6-point disagreement and escalated it (DEF-291). Adopting df’s own value
  # makes the number the guard escalates on identical to the one an operator
  # sees, which is the whole point of a guard a human must be able to
  # cross-check.
  df --block-size=1 -P "$MOUNT" 2>/dev/null | awk '
    NR>1 && NF>=5 {
      size=$2+0; used=$3+0; avail=$4+0
      pct=$5+0
      # A df that omits a usable Use% still yields a usable measurement from
      # the byte columns; fall back to the truncation rather than failing.
      if (pct <= 0) pct=(size>0 ? int(used*100/size) : 0)
      printf "%d %d %d %d\n", size, used, avail, pct
    }' | tail -1
}

# The previous measurement, read once per process from the status file.
#
# report() may run twice in one process (--prune measures to decide whether to
# delete, then reports again to answer the caller), and the first run overwrites
# the status file. Read at the top of each report() but only the first time, so
# both runs compare against the last *invocation* rather than the second against
# the first -- which would report a rate of exactly 0 and a level that can never
# regress, silently disabling the trend in the one mode where an operator most
# wants to know the volume was falling.
PREV_MEASUREMENT_CAPTURED=0
PREV_AVAIL_MB=""
PREV_CHECKED_AT=""
PREV_LEVEL=""
capture_prev_measurement() {
  [ "$PREV_MEASUREMENT_CAPTURED" = "1" ] && return 0
  PREV_MEASUREMENT_CAPTURED=1
  PREV_AVAIL_MB="$(status_field avail_mb || true)"
  PREV_CHECKED_AT="$(status_field checked_at || true)"
  PREV_LEVEL="$(status_field level || true)"
  return 0
}

report() {
  local size used avail pct avail_mb level rc floor_mb
  local prev_avail_mb prev_checked_at elapsed_min delta_mb rate_mb_hour
  local trend="" level_prev level_snapshot
  capture_prev_measurement
  read -r size used avail pct <<<"$(measure)"

  # An unreadable or unparseable df is a measurement failure, not a pressure
  # signal. Without this guard the empty fields fall through the integer
  # comparisons below, which emit "integer expression expected" on stderr and
  # then return whatever the leftover status happens to be -- silently reporting
  # level=ok (and writing it to the durable status file) for a volume we could
  # not actually measure. rc=1 is the documented usage/measurement error.
  if [ -z "$size" ] || [ -z "$used" ] || [ -z "$avail" ] || [ -z "$pct" ]; then
    log "cannot measure $MOUNT (df returned no usable row); treating as a measurement error"
    return 1
  fi

  avail_mb=$(( avail / 1024 / 1024 ))

  # Free-space floor scales with the volume: a fixed 1500MiB floor meant
  # something different on a 20G volume than on a 59G one. 3% of total keeps
  # the guard's real intent (never run on a sliver) correct across resizes.
  # MIN_FREE_MB<=0 disables the floor, leaving percentage as the only signal.
  if [ "$MIN_FREE_MB" -le 0 ]; then
    floor_mb=0
  else
    floor_mb=$(( size * 3 / 100 / 1024 / 1024 ))
    [ "$floor_mb" -lt "$MIN_FREE_MB" ] && floor_mb=$MIN_FREE_MB
  fi

  level="ok"; rc=0
  if   [ "$pct" -ge "$CRIT_PCT" ]; then level="critical"; rc=3
  elif [ "$pct" -ge "$WARN_PCT" ] || [ "$avail_mb" -lt "$floor_mb" ]; then level="warn"; rc=2
  fi
  # What df said, before any trend escalated it. Kept separately because the two
  # answer different questions and callers need to be able to tell them apart:
  # `level` is what to tell a human, `level_snapshot` is what authorises deletion.
  # An ok volume falling 10GiB/hour is an incident and still not a reclaim trigger.
  level_snapshot="$level"

  # Trend against the previous recorded measurement, read from the status file
  # this function is about to overwrite. Read here, not after the write: the file
  # is the only place the previous check's numbers survive, so anything that ran
  # after the write would be comparing this run against itself and reporting a
  # rate of exactly zero.
  #
  # This is the signal CON-461 added because a level alone cannot see a leak: on
  # 2026-10-04 free space fell 13,022 -> 8,052 MiB in about an hour, ~240 MiB/min,
  # while the routine was a periodic ok-check. Two consecutive runs both read
  # "critical but unexplainable" and concluded the PVC needed an operator resize
  # (CON-453, CON-458) when the guard simply had nothing authorized to reclaim and
  # no way to express "and it is getting worse at 14GB/hour". A steady warn with
  # reclaimable headroom is not an incident; an ok that is actively collapsing is.
  prev_avail_mb="$PREV_AVAIL_MB"
  prev_checked_at="$PREV_CHECKED_AT"
  level_prev="$PREV_LEVEL"
  delta_mb=""; rate_mb_hour=""
  elapsed_min=""
  # A value that is not a bare non-negative integer is not a measurement, and
  # treating it as one would let a hand-edited or truncated status file drive an
  # escalation. Empty fields are written instead, which reads as "no trend".
  case "$prev_avail_mb" in
    ''|*[!0-9]*) prev_avail_mb="" ;;
  esac
  if [ -n "$prev_avail_mb" ] && [ -n "$prev_checked_at" ]; then
    elapsed_min="$(_iso8601_elapsed_minutes "$prev_checked_at" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" || true)"
    case "$elapsed_min" in
      ''|*[!0-9]*) elapsed_min="" ;;
    esac
    # Too short to be two measurements. Two checks inside one minute are one
    # measurement, not two: a MiB or two of churn divided by ~0 minutes is
    # either an enormous rate or a division by zero, and either way the number is
    # noise wearing a rate's clothing. The interval is cleared rather than kept as
    # 0 so the status file reads "no trend" (empty delta *and* empty rate) rather
    # than a delta with no denominator for a consumer to divide by itself.
    if [ -n "$elapsed_min" ] && [ "$elapsed_min" -lt "$TREND_MIN_INTERVAL_MINUTES" ]; then
      elapsed_min=""
    fi
    if [ -n "$elapsed_min" ]; then
      delta_mb=$(( avail_mb - prev_avail_mb ))
      # Integer division, signed, and bash truncates toward zero, so a small fall
      # rounds toward zero rather than away from it. Sign is preserved because the
      # escalation compares against a negative threshold.
      rate_mb_hour=$(( (delta_mb * 60) / elapsed_min ))
      # A rate alone says a fall is fast; `trend` says which way. Label every
      # measured interval, so `trend=falling` cannot mean "a number was computed"
      # while the number is positive -- a consumer reading the level string and
      # never comparing the sign would read a recovery as a leak.
      if [ "$delta_mb" -lt 0 ]; then
        trend="falling"
      elif [ "$delta_mb" -gt 0 ]; then
        trend="rising"
      else
        trend="steady"
      fi
    fi
  fi

  # Escalate on the *trend* even when the snapshot level is ok. A level regression
  # across consecutive runs is the same fact stated in fewer samples: ok -> warn
  # means the volume crossed a threshold between two checks nobody was watching,
  # which is the specific blind spot that let CON-458 read as a mystery.
  #
  # The threshold is a signed MiB/hour, so falling faster than it (more negative)
  # escalates and steady or rising does not. FALL_RATE_MB_PER_HOUR<=0 disables
  # the rate test, leaving the level-regression test alone.
  #
  # A single `[ ]` test, not two joined by ||. The guard runs under
  # `set -uo pipefail` without -e, but the branch still has to read as the
  # positive form it is; an `A || B` where the first conjunct already carries the
  # negation is how the escalation inverts into firing on *rising* space, which is
  # the one condition that must never be an incident.
  if [ -n "$rate_mb_hour" ] && [ "$rate_mb_hour" -lt "$FALL_RATE_MB_PER_HOUR" ]; then
    if [ "$rc" -lt 2 ]; then
      level="warn"; rc=2
    fi
    log "falling free space: ${rate_mb_hour}MiB/hour (${prev_avail_mb} -> ${avail_mb}MiB in ${elapsed_min}m); threshold ${FALL_RATE_MB_PER_HOUR}MiB/hour"
  fi
  # A level regression is itself an escalation, not only a log line. `warn ->
  # critical` used to be logged and then returned as warn, so a caller reading the
  # exit code -- which is how a routine or a monitor decides -- saw the worse of the
  # two levels reported as the milder one. The regression is what the level itself
  # now says, so the status file and the exit code agree with the log.
  if [ -n "$level_prev" ] && [ "$level_prev" != "$level" ]; then
    case "$level_prev:$level" in
      ok:warn|ok:critical|warn:critical)
        log "level regressed $level_prev -> $level since the previous check"
        ;;
      critical:ok|critical:warn|warn:ok)
        # Improved, not an incident. Recorded so a consumer can see the recovery,
        # but never escalated: a volume that got better is not a finding.
        log "level improved $level_prev -> $level since the previous check"
        ;;
    esac
  fi

  printf 'mount=%s size=%sGiB used=%sGiB(>%s%%) free=%sMiB floor=%sMiB level=%s\n' \
    "$MOUNT" "$(( size / 1024 / 1024 / 1024 ))" \
    "$(( used / 1024 / 1024 / 1024 ))" "$pct" "$avail_mb" "$floor_mb" "$level"
  # The trend on the same line as the level, so a routine comment carries the
  # whole story and a human diffing two runs does not have to open the status file.
  if [ -n "$rate_mb_hour" ]; then
    printf 'trend=%s rate=%sMiB/hour delta=%sMiB over %sm (prev %sMiB)\n' \
      "$trend" "$rate_mb_hour" "$delta_mb" "$elapsed_min" "$prev_avail_mb"
  fi

  # Durable, parseable state so a monitor/routine can read it without df.
  #
  # The trend fields are written on every check, including when there is no trend
  # (empty), so a consumer can rely on the key always being present rather than
  # treating a missing key as a different condition from a measured zero. Written
  # as one flat key=value block, which is what makes the trend machine-readable
  # instead of something a human has to reconstruct by diffing routine comments --
  # the reason the CON-461 escalation had to be argued from prose in the first
  # place.
  mkdir -p "$(dirname "$STATUS_FILE")" 2>/dev/null
  {
    printf 'checked_at=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    printf 'mount=%s\n' "$MOUNT"
    printf 'size_bytes=%s\nused_bytes=%s\navail_bytes=%s\nuse_pct=%s\navail_mb=%s\nfloor_mb=%s\n' \
      "$size" "$used" "$avail" "$pct" "$avail_mb" "$floor_mb"
    printf 'avail_mb_prev=%s\navail_mb_delta=%s\navail_mb_elapsed_minutes=%s\nfall_rate_mb_per_hour=%s\n' \
      "${prev_avail_mb:-}" "${delta_mb:-}" "${elapsed_min:-}" "${rate_mb_hour:-}"
    printf 'level=%s\nlevel_snapshot=%s\nlevel_prev=%s\nwarn_pct=%s\ncrit_pct=%s\nmin_free_mb=%s\nfall_rate_threshold_mb_per_hour=%s\n' \
      "$level" "${level_snapshot:-}" "${level_prev:-}" "$WARN_PCT" "$CRIT_PCT" "$MIN_FREE_MB" "$FALL_RATE_MB_PER_HOUR"
    printf 'guard_version=7\n'
  } >"$STATUS_FILE" 2>/dev/null

  return "$rc"
}

prune() {
  local before after p freed total=0
  local lvl="" rc report_output snapshot_lvl=""
  local workspace_candidates=()
  local wt_candidates=()
  local cargo_target_candidates=()
  # Everything below this point consults the issue API, so the company id must
  # resolve before any reclaim work starts.
  require_company_id
  init_run_cache
  # Pruning is a pressure response, not a scheduled chore. At 35% usage there
  # is nothing to fix, and deleting a 917MiB regenerable browser cache
  # "because the routine ran" costs a slow re-download for no gain. Only prune
  # when the volume is actually warn/critical, unless forced.
  #
  # The level must come from *this* run's measurement. report() returns 1 when
  # df is unusable and bails before writing the status file, so the file would
  # still hold a level from an earlier run -- and pruning on that stale reading
  # would delete caches without having measured anything. Fail closed.
  #
  # Only rc=1 counts as a measurement failure. report() also returns 2 (warn)
  # and 3 (critical) for successful measurements, so test the code exactly
  # rather than treating any non-zero status as an error.
  # Capture the previous measurement in the *current* shell before report() runs.
  # report() is invoked in a command substitution, so any state it sets for a
  # later caller would be discarded with the subshell; doing it here is what makes
  # the second report() (the --prune exit path) trend against the last check rather
  # than against this process's own first measurement.
  capture_prev_measurement
  report_output="$(report 2>/dev/null)"
  rc=$?
  if [ "$rc" -eq 1 ]; then
    printf 'prune_skipped=measurement_failed\n'
    return 1
  fi
  case "$rc" in
    2) lvl="warn" ;;
    3) lvl="critical" ;;
    *) lvl="ok" ;;
  esac
  # Deletion is authorised by *present pressure*, never by a trend. A volume that
  # is measured ok right now is not under pressure, however fast it is falling;
  # the trend is a reason to look again sooner or to page a human, not a licence to
  # delete a cache, drop a build tree, or reclaim a hardlink-shared node_modules on
  # a guess about the future. So the gate below uses the level the measurement
  # itself produced (`level_snapshot`), not the level report() ended up publishing
  # after the trend escalation. Reading the published level here would make every
  # fast-falling-but-healthy volume reclaim on every tick.
  #
  # Unconditional, not just a downgrade of warn/critical: `lvl` currently holds the
  # *published* level, which is warn purely because of the trend, so a conditional
  # override would leave it at warn and prune anyway.
  snapshot_lvl="$(status_field level_snapshot || true)"
  case "$snapshot_lvl" in
    ok|warn|critical) lvl="$snapshot_lvl" ;;
  esac
  if [ "$lvl" != "warn" ] && [ "$lvl" != "critical" ] && [ "${DISK_GUARD_FORCE:-0}" != "1" ]; then
    printf 'prune_skipped=level_%s\n' "$lvl"
    return 0
  fi

  before="$(df --block-size=1 -P "$MOUNT" | awk 'NR>1 && NF>=5 {print $4; exit}')"

  for p in "${safe_caches[@]}"; do
    [ -e "$p" ] || continue
    freed="$(unlinked_bytes "$p")"
    if [ "$freed" -lt 1048576 ]; then
      # Either tiny, or made of hardlinked inodes that still have live copies.
      log "skip  $p (only $((freed/1024))KiB unlinked-reclaimable)"
      continue
    fi
    remove_path "$p"
    log "prune $p (~$((freed/1024/1024))MiB reclaimable)"
    total=$(( total + freed ))
  done

  # Orphaned nix git-fetch temp packs, before the build-output roots. It runs
  # first because it is the only reclaim on this volume that has ever recovered
  # gigabytes (9.3GiB on 2026-10-04, CON-458) without touching live workspace
  # state, so the cheapest and safest space is taken before anything that needs a
  # git-identity or issue-terminality argument.
  reclaim_nix_orphans

  while IFS= read -r p; do
    [ -n "$p" ] && workspace_candidates+=("$p")
  done <<<"$(workspace_reclaim_candidates)"
  for p in "${workspace_candidates[@]}"; do
    [ -e "$p" ] || continue
    freed="$(unlinked_bytes "$p")"
    if [ "$freed" -lt 1048576 ]; then
      log "skip  $p (only $((freed/1024))KiB unlinked-reclaimable)"
      continue
    fi
    remove_path "$p"
    log "prune $p (~$((freed/1024/1024))MiB reclaimable workspace build output)"
    total=$(( total + freed ))
  done

  while IFS= read -r p; do
    [ -n "$p" ] && wt_candidates+=("$p")
  done <<<"$(wt_reclaim_candidates)"
  for p in "${wt_candidates[@]}"; do
    [ -e "$p" ] || continue
    freed="$(unlinked_bytes "$p")"
    if [ "$freed" -lt 1048576 ]; then
      log "skip  $p (only $((freed/1024))KiB unlinked-reclaimable)"
      continue
    fi
    remove_path "$p"
    log "prune $p (~$((freed/1024/1024))MiB reclaimable worktree build output)"
    total=$(( total + freed ))
  done

  while IFS= read -r p; do
    [ -n "$p" ] && cargo_target_candidates+=("$p")
  done <<<"$(cargo_target_reclaim_candidates)"
  for p in "${cargo_target_candidates[@]}"; do
    [ -e "$p" ] || continue
    freed="$(unlinked_bytes "$p")"
    if [ "$freed" -lt 1048576 ]; then
      log "skip  $p (only $((freed/1024))KiB unlinked-reclaimable)"
      continue
    fi
    remove_path "$p"
    log "prune $p (~$((freed/1024/1024))MiB reclaimable cargo target)"
    total=$(( total + freed ))
  done

  for p in "${log_dirs[@]}"; do
    [ -d "$p" ] || continue
    find "$p" -xdev -type f -mtime +1 -delete 2>/dev/null
    log "prune $p (rotated logs, mtime>1d)"
  done

  sync
  after="$(df --block-size=1 -P "$MOUNT" | awk 'NR>1 && NF>=5 {print $4; exit}')"
  printf 'reclaimed_mib=%s\n' "$(( (after - before) / 1024 / 1024 ))"
}

case "$mode" in
  --check)
    report; exit $?
    ;;
  --prune)
    prune
    report; rc=$?
    # prune() already measured and wrote status; report() re-ran for the caller.
    exit $rc
    ;;
  --status)
    [ -f "$STATUS_FILE" ] && cat "$STATUS_FILE" || { log "no status file: $STATUS_FILE"; exit 1; }
    exit 0
    ;;
  *)
    log "usage: disk-guard.sh [--check|--prune|--status]"; exit 1
    ;;
esac
