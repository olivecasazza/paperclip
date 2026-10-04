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
#   * instances/ and wt/                     — live agent homes and git worktrees
#     on open branches. Deleting loses uncommitted work.
#   * .nix-portable, .local/share/nix, .rustup — live toolchains; nix GC needs
#     proot and is not safe to run unsupervised from a live pod.
#
# Everything in safe_caches/ is regenerable from the network. Reclaim is
# verified per-path by counting only nlink==1 inodes, so a path that has been
# hardlinked into a live tree is skipped rather than deleted.
#
# cargo-target-shared/ holds two kinds of dir. A dir named <PREFIX>-<number>
# belongs to one issue and is reclaimed only once that issue is terminal and the
# dir carries a matching .paperclip-owner marker. A dir belonging to no single
# issue (`debug/`, `tmp/`) has no issue to be terminal, so it is reclaimed on age
# and containment instead -- but only if its name is not attributed to some other
# company or issue, no cargo/rustc is running, and its inodes are unshared.
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
# Exit codes: 0 ok, 1 usage error, 2 warn, 3 critical. Exit 1 also covers a
# failed measurement: if df cannot be read we cannot know the level, and the
# guard reports that rather than guessing a level it did not measure.
#
# Requires bash (shebang above), not POSIX sh: it uses `local`, a here-string,
# and two arrays. Keep it that way -- do not "simplify" it to sh.

set -uo pipefail

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
# In-band ownership marker each shared cargo target dir must carry to be
# reclaimable. The dir name alone is a human-typed label, not proof of who owns
# the build output inside it.
CARGO_TARGET_OWNER_MARKER="${DISK_GUARD_CARGO_TARGET_OWNER_MARKER:-.paperclip-owner}"
# Root of the process table consulted when pgrep and pidof are both unavailable.
# Overridable only so the "cannot tell" branch of cargo_rustc_running is
# testable; production never sets it.
PROC_ROOT="${DISK_GUARD_PROC_ROOT:-/proc}"
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
  local path="$1"
  if [ -n "${DISK_GUARD_API_STUB:-}" ]; then
    "$DISK_GUARD_API_STUB" "$path"
    return $?
  fi
  [ -n "${PAPERCLIP_API_KEY:-}" ] || return 1
  curl -fsS \
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
  #
  # The walk cannot be shortened: a sum over every unlinked inode is what the
  # figure means, and the nlink==1 test is the gate itself. What changed in
  # DEF-306 is only how many times it runs -- see candidate_age_and_unlinked_bytes,
  # which answers the mtime question in the same walk.
  find "$1" -xdev -type f -links 1 -printf '%s\n' 2>/dev/null | awk '{s+=$1} END{print s+0}'
}

# Whether anything under $1 is newer than the cutoff epoch.
#
# This replaces taking the newest mtime with a full sort. The only question any
# caller asks is "is anything here newer than the cutoff", so `find` can stop at
# the first entry that answers it: `-print -quit` short-circuits, and nothing is
# sorted, so the cost becomes the position of the first fresh entry rather than
# the size of the tree.
#
# The comparison is `-newermt "@$((cutoff - 1))"`, not `"@$cutoff"`, and the
# difference is load-bearing. Callers skip when `newest >= cutoff`, while
# -newermt is *strictly* newer. Testing only the cutoff would let an entry whose
# mtime is exactly the cutoff through as a candidate where the old gate skipped
# it -- a candidate that must be skipped no longer is. Stepping the cutoff back
# one second makes "mtime > cutoff-1" identical to "mtime >= cutoff" on whole
# seconds, which is the resolution %T@ is compared at here.
#
# Prints nothing when nothing is newer. A caller that skips on a non-empty
# result is unchanged: an empty tree is still empty, and the "cannot tell" case
# that used to be an empty `newest` becomes an empty result too.
tree_has_entry_newer_than() {
  local cutoff="$1" dir="$2"
  [ -d "$dir" ] || return 1
  find "$dir" -xdev -newermt "@$(( cutoff - 1 ))" -print -quit 2>/dev/null
}

# Age and size in ONE walk of the candidate, for the enumeration path that needs
# both answers per candidate.
#
# Enumeration used to walk every candidate twice: newest_mtime_epoch sorted the
# whole tree, then unlinked_bytes walked it again to sum it. On the 78 build
# output trees this volume actually holds that was 265s for a single --prune
# enumeration (DEF-306), and one of them was so slow the run had to be killed at
# a 280s ceiling without reaching the last candidate.
#
# Both facts come from the same directory entries, so one `find` answers both:
#   -type f -links 1 -printf '%s\n'  the unlinked-byte total, unchanged
#   -newermt "@cutoff-1" -printf F   a freshness sentinel, and -quit ends the
#                                     walk the moment one is found
#
# The nlink==1 accounting and the cutoff are both preserved exactly; only the
# number of walks changes. Echoes "<bytes> <fresh|stale>".
candidate_age_and_unlinked_bytes() {
  local dir="$1" cutoff="$2"
  [ -d "$dir" ] || { printf '0 stale\n'; return 0; }
  find "$dir" -xdev \
    \( -type f -links 1 -printf '%s\n' \) \
    -o \( -newermt "@$(( cutoff - 1 ))" -printf 'F\n' -quit \) \
    2>/dev/null |
    awk '/^F$/ { fresh = 1; next } { sum += $1 } END { printf "%d %s\n", sum + 0, (fresh ? "fresh" : "stale") }'
}

newest_mtime_epoch() {
  # Retained for the call sites that report a specific newest mtime. The
  # enumeration gate uses candidate_age_and_unlinked_bytes instead; this stays a
  # full sort because answering "what is the exact newest epoch" is not a
  # question that short-circuits.
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

issue_is_terminal() {
  local identifier="$1" status
  [ -n "$identifier" ] || return 1
  status="$(api_get "/companies/$COMPANY_ID/issues?q=$identifier&limit=10" 2>/dev/null | json_issue_status "$identifier" 2>/dev/null || true)"
  [ "$status" = "done" ] || [ "$status" = "cancelled" ]
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

report() {
  local size used avail pct avail_mb level rc floor_mb
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

  printf 'mount=%s size=%sGiB used=%sGiB(>%s%%) free=%sMiB floor=%sMiB level=%s\n' \
    "$MOUNT" "$(( size / 1024 / 1024 / 1024 ))" \
    "$(( used / 1024 / 1024 / 1024 ))" "$pct" "$avail_mb" "$floor_mb" "$level"

  # Durable, parseable state so a monitor/routine can read it without df.
  mkdir -p "$(dirname "$STATUS_FILE")" 2>/dev/null
  {
    printf 'checked_at=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    printf 'mount=%s\n' "$MOUNT"
    printf 'size_bytes=%s\nused_bytes=%s\navail_bytes=%s\nuse_pct=%s\navail_mb=%s\nfloor_mb=%s\n' \
      "$size" "$used" "$avail" "$pct" "$avail_mb" "$floor_mb"
    printf 'level=%s\nwarn_pct=%s\ncrit_pct=%s\nmin_free_mb=%s\n' \
      "$level" "$WARN_PCT" "$CRIT_PCT" "$MIN_FREE_MB"
    printf 'guard_version=4\n'
  } >"$STATUS_FILE" 2>/dev/null

  return "$rc"
}

prune() {
  local before after p freed total=0
  local lvl="" rc report_output
  local workspace_candidates=()
  local cargo_target_candidates=()
  # Everything below this point consults the issue API, so the company id must
  # resolve before any reclaim work starts.
  require_company_id
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
