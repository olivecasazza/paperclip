#!/usr/bin/env bash
# disk-guard.sh — disk-pressure guard for the /paperclip Longhorn PVC.
#
# Background: agents on this volume died with `ENOSPC: no space left on
# device, write`. The volume has since been grown in place 20G -> 197G
# (`df -h`; 196.7 GiB) across 2026-09-27/28 under the same PVC
# `pvc-16b1231a-b6f0-4293-b8c1-08d3974be5a8`. Headroom is no longer
# the problem, but it will erode again, so this guard exists to report pressure
# deterministically *before* free space hits zero, making the condition visible
# instead of surfacing as a dead agent.
#
# This file is the version-controlled source of truth. The deployed copy lives
# at /paperclip/bin/disk-guard.sh, with a convenience copy at
# /paperclip/disk-guard.sh; keep both byte-identical to this file. It was
# un-versioned for the first months of its life; it now ships here.
# Re-deploy it from this file. See docs/deploy/disk-guard.md for the
# ops runbook.
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
# Every knob is overridable via the environment so the threshold matrix is
# testable without a full volume; see scripts/disk-guard.test.mjs.
#
# Exit codes: 0 ok, 1 usage error, 2 warn, 3 critical.

set -uo pipefail

MOUNT="${DISK_GUARD_MOUNT:-/paperclip}"
WARN_PCT="${DISK_GUARD_WARN_PCT:-88}"
CRIT_PCT="${DISK_GUARD_CRIT_PCT:-94}"
MIN_FREE_MB="${DISK_GUARD_MIN_FREE_MB:-1500}"
STATUS_FILE="${DISK_GUARD_STATUS_FILE:-/paperclip/run/disk-guard.status}"

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

unlinked_bytes() {
  # Bytes held by inodes with nlink==1 under $1. This is the only figure that
  # predicts space actually returned to the filesystem.
  find "$1" -xdev -type f -links 1 -printf '%s\n' 2>/dev/null | awk '{s+=$1} END{print s+0}'
}

measure() {
  # df -P columns: 1=filesystem 2=size 3=used 4=avail 5=capacity 6=mount
  # Use awk so column positions and the percentage are explicit rather than
  # depending on locale, field wrapping, or bash having a ternary operator.
  df --block-size=1 -P "$MOUNT" 2>/dev/null | awk '
    NR>1 && NF>=5 {
      size=$2+0; used=$3+0; avail=$4+0
      printf "%d %d %d %d\n", size, used, avail, (size>0 ? int(used*100/size) : 0)
    }' | tail -1
}

report() {
  local size used avail pct avail_mb level rc floor_mb
  read -r size used avail pct <<<"$(measure)"
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
    printf 'guard_version=2\n'
  } >"$STATUS_FILE" 2>/dev/null

  return "$rc"
}

prune() {
  local before after p freed total=0
  local lvl
  # Pruning is a pressure response, not a scheduled chore. At 35% usage there
  # is nothing to fix, and deleting a 917MiB regenerable browser cache
  # "because the routine ran" costs a slow re-download for no gain. Only prune
  # when the volume is actually warn/critical, unless forced.
  report >/dev/null 2>&1
  lvl="$(awk -F= '/^level=/{print $2; exit}' "$STATUS_FILE" 2>/dev/null)"
  if [ "$lvl" != "warn" ] && [ "$lvl" != "critical" ] && [ "${DISK_GUARD_FORCE:-0}" != "1" ]; then
    printf 'prune_skipped=level_%s\n' "${lvl:-unknown}"
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
    rm -rf -- "$p" 2>/dev/null
    log "prune $p (~$((freed/1024/1024))MiB reclaimable)"
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
