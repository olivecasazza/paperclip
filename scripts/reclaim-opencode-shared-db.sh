#!/usr/bin/env bash
# reclaim-opencode-shared-db.sh — delete the LEGACY shared OpenCode SQLite DB
# after per-agent OpenCode data homes have shipped.
#
# Background: every `opencode_local` agent resolved XDG_DATA_HOME to the same
# `$HOME/.local/share/opencode`, so one `opencode.db` held every agent's
# sessions on the /paperclip PVC. `prepareOpenCodePerAgentDataHome` (PR #6)
# splits that per agent under `<instance>/adapter-data/opencode/<agentId>/`,
# and once the new build is live the shared DB is orphaned state nobody reads.
#
# This script exists because that step is otherwise a hand-typed `rm` of a
# multi-GiB file on a live volume, which fails in two ways:
#
#   * Removing `opencode.db-wal` while any process has the DB open does not
#     reclaim the space and corrupts the DB for those processes -- SQLite keeps
#     writing to the unlinked inode. disk-guard.sh already refuses to touch the
#     WAL for this reason; this script must refuse for the same reason.
#   * Running it against a build that does NOT have the per-agent split deletes
#     the live session store of every agent on the instance.
#
# So every destructive step is gated on positive proof, and the gates default to
# refusing:
#
#   GATE 1  per-agent data homes exist and hold real per-agent DBs
#   GATE 2  the deployed build carries the split -- proven by the running
#           image's own tree, falling back to commit ancestry
#   GATE 3  no process on this host holds the shared DB open
#   GATE 4  the shared DB is idle (no writes for --idle-seconds)
#   GATE 5  the file being removed is the shared DB, not a per-agent one
#
# Dry run is the default; --yes is required to actually delete.
#
# Usage:
#   reclaim-opencode-shared-db.sh                 report + gates, delete nothing
#   reclaim-opencode-shared-db.sh --yes           run the gates, then delete
#   reclaim-opencode-shared-db.sh --yes --backup-to /paperclip/elsewhere
#   reclaim-opencode-shared-db.sh --expect-commit c226db7b --yes
#
# Environment overrides (all optional):
#   OPENCODE_SHARED_DATA_DIR  shared data dir      (default $XDG_DATA_HOME/opencode,
#                                                       else $HOME/.local/share/opencode)
#   PER_AGENT_DATA_DIR        per-agent data root   (default <instance>/adapter-data/opencode)
#   PAPERCLIP_APP_DIR         deployed app tree     (default /app; the source of
#                                                       GATE 2's primary proof)
#   OPENCODE_SPLIT_COMMITS    commits carrying the split, for the GATE 2 ancestry
#                             fallback when the app tree is not mounted
#   HEALTH_URL                base URL for the server health probe
#   EXPECTED_COMMIT           accept this commit without consulting HEALTH_URL
#
# Exit codes:
#   0  nothing to reclaim, or reclaim completed with --yes
#   1  usage error
#   3  a gate refused; the shared DB was NOT touched

set -uo pipefail

# The two roots mirror resolveOpenCodeDataDir and resolvePaperclipInstanceRootForAdapter
# in @paperclipai/adapter-utils/server-utils.ts, which is what the adapter itself uses to
# decide these paths. If either diverges from that resolver, the gates below are checking
# different directories than the ones the running adapter writes to.
SHARED_DATA_DIR="${OPENCODE_SHARED_DATA_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/opencode}"
INSTANCE_ROOT="${PAPERCLIP_INSTANCE_ROOT:-${PAPERCLIP_HOME:-$HOME/.paperclip}/instances/${PAPERCLIP_INSTANCE_ID:-default}}"
PER_AGENT_DATA_DIR="${PER_AGENT_DATA_DIR:-$INSTANCE_ROOT/adapter-data/opencode}"
SHARED_DB="$SHARED_DATA_DIR/opencode.db"
HEALTH_URL="${HEALTH_URL:-${PAPERCLIP_API_URL:-}}"
IDLE_SECONDS="${IDLE_SECONDS:-900}"
ASSUME_YES=0
BACKUP_TO=""

# The one file that exists if and only if the build serving this instance carries
# the per-agent split. It is the function this whole gate exists to verify, and
# the image copies the whole repo to /app (Dockerfile production stage:
# `COPY --from=build /app /app`), so the deployed tree can be inspected directly
# instead of trusting a hard-coded commit list.
AGENT_DATA_HOME_SRC="packages/adapters/opencode-local/src/server/agent-data-home.ts"
APP_DIR="${PAPERCLIP_APP_DIR:-/app}"

# Commits on olivecasazza/paperclip that contain $AGENT_DATA_HOME_SRC, verified
# by fetching that path from the fork at each revision. The fix landed in the
# merge commit ef74a7a3 (PR #6) and every descendant carries it, so this is a
# prefix list to match against, not an exhaustive one.
#
# This is a FALLBACK, not the primary signal. It only proves the deployed commit
# descends from a commit that added the file; it cannot prove that commit is the
# one actually running, and the prefix list goes stale as the fork moves on --
# every image published after ef74a7a3 (0fb95072, cadea06cb, 15ab3438b) fails it.
OPENCODE_SPLIT_COMMITS_DEFAULT="ef74a7a3 c226db7b c7165e96"

log() { printf '%s\n' "$*" >&2; }
usage() { sed -n '2,45p' "$0" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --yes|-y) ASSUME_YES=1; shift ;;
    --backup-to) [ $# -ge 2 ] || usage; BACKUP_TO="$2"; shift 2 ;;
    --expect-commit) [ $# -ge 2 ] || usage; EXPECTED_COMMIT="$2"; shift 2 ;;
    --idle-seconds) [ $# -ge 2 ] || usage; IDLE_SECONDS="$2"; shift 2 ;;
    -h|--help) usage ;;
    *) log "unknown argument: $1"; usage ;;
  esac
done

case "$IDLE_SECONDS" in ''|*[!0-9]*) log "--idle-seconds must be a non-negative integer"; exit 1 ;; esac

fail() { log "REFUSED: $*"; exit 3; }

# ---------------------------------------------------------------------------
# GATE 1 — the split has actually produced per-agent data homes.
#
# Presence of the directory is not enough: an adapter that created the tree and
# then failed would leave empty dirs. Require at least one per-agent opencode.db
# that is non-empty, so this cannot pass on a half-applied deploy.
# ---------------------------------------------------------------------------
gate_per_agent_homes() {
  local n
  n=$(find "$PER_AGENT_DATA_DIR" -mindepth 3 -maxdepth 3 -name opencode.db -type f -size +0 2>/dev/null | wc -l)
  [ "$n" -gt 0 ] || fail "no per-agent opencode.db under $PER_AGENT_DATA_DIR — the per-agent data-home fix is not live, so the shared DB is still the live store"
  log "gate 1 ok: $n per-agent opencode.db under $PER_AGENT_DATA_DIR"
}

# ---------------------------------------------------------------------------
# GATE 2 — the build serving this instance contains the split.
#
# Primary signal: the deployed tree itself. If $APP_DIR/$AGENT_DATA_HOME_SRC is
# present, the running image carries the fix, whatever its commit is called.
# That is direct evidence about this build, and it does not rot.
#
# Fallback: prefix-match the commit reported by /api/health (or --expect-commit)
# against a known post-split commit. Kept for the case where the repo tree is not
# mounted into the container (a dist-only or packaged deployment), where commit
# ancestry is the best available evidence.
# ---------------------------------------------------------------------------
commit_is_post_split() {
  local commit="$1" known
  [ -n "$commit" ] || return 1
  for known in ${OPENCODE_SPLIT_COMMITS:-$OPENCODE_SPLIT_COMMITS_DEFAULT}; do
    case "$commit" in
      "$known"*) return 0 ;;
    esac
  done
  return 1
}

deployed_commit() {
  local commit="${EXPECTED_COMMIT:-}"
  if [ -z "$commit" ]; then
    [ -n "$HEALTH_URL" ] || fail "no EXPECTED_COMMIT and no HEALTH_URL, and $APP_DIR/$AGENT_DATA_HOME_SRC is absent — cannot prove the deployed build carries the per-agent split"
    commit=$(curl -fsS --max-time 10 "${HEALTH_URL%/}/api/health" 2>/dev/null \
      | sed -nE 's/.*"commit"[[:space:]]*:[[:space:]]*"([0-9a-fA-F]+)".*/\1/p')
    [ -n "$commit" ] || fail "could not read a commit from ${HEALTH_URL%/}/api/health"
  fi
  printf '%s' "$commit"
}

gate_deployed_build() {
  local commit
  if [ -f "$APP_DIR/$AGENT_DATA_HOME_SRC" ]; then
    log "gate 2 ok: deployed tree $APP_DIR/$AGENT_DATA_HOME_SRC is present — the running build carries the per-agent split"
    return 0
  fi
  log "gate 2: $APP_DIR/$AGENT_DATA_HOME_SRC is absent (dist-only or packaged deployment); falling back to commit ancestry"
  commit=$(deployed_commit)
  commit_is_post_split "$commit" \
    || fail "deployed build is $commit, which predates the per-agent OpenCode data-home fix (merge ef74a7a3) — deleting the shared DB now would drop every live session"
  log "gate 2 ok: deployed build $commit descends from a commit carrying the per-agent split"
}

# ---------------------------------------------------------------------------
# GATE 3 — nobody has the shared DB open.
#
# This is the gate that makes the WAL rule safe. An open process keeps writing
# to the unlinked inode: the space is not reclaimed until that process exits, and
# every row it writes in the meantime is lost. /proc/<pid>/fd is the only
# portable-enough enumeration available in this image (no lsof, no fuser).
# ---------------------------------------------------------------------------
shared_db_open_pids() {
  local pid link target
  for pid in /proc/[0-9]*; do
    pid="${pid#/proc/}"
    for link in "/proc/$pid/fd/"*; do
      [ -e "$link" ] || continue
      target=$(readlink -f -- "$link" 2>/dev/null) || continue
      case "$target" in
        "$SHARED_DB"|"$SHARED_DB-wal"|"$SHARED_DB-shm") printf '%s\n' "$pid"; break ;;
      esac
    done
  done
}

gate_no_open_handles() {
  local pids
  pids=$(shared_db_open_pids | sort -u | tr '\n' ' ')
  [ -z "${pids// /}" ] || fail "$pids still hold $SHARED_DB open — the WAL must never be unlinked under a live writer; wait for runs to drain"
  log "gate 3 ok: no process holds $SHARED_DB open"
}

# ---------------------------------------------------------------------------
# GATE 4 — the DB has been idle.
#
# Belt to gate 3's braces: a run can create and drop its handles between two
# samples, and a process that opens the DB a second after the scan would write
# into a deleted inode. Requiring the file to be untouched for IDLE_SECONDS
# bounds that race to a window an operator can reason about.
# ---------------------------------------------------------------------------
gate_idle() {
  local now mtime age
  [ "$IDLE_SECONDS" -eq 0 ] && { log "gate 4 skipped (--idle-seconds 0)"; return 0; }
  now=$(date +%s)
  mtime=$(find "$SHARED_DATA_DIR" -maxdepth 1 -name 'opencode.db*' -printf '%T@\n' 2>/dev/null | sort -nr | head -1 | cut -d. -f1)
  [ -n "$mtime" ] || fail "cannot read the mtime of $SHARED_DATA_DIR/opencode.db* — refusing to guess whether it is idle"
  age=$((now - mtime))
  [ "$age" -ge "$IDLE_SECONDS" ] \
    || fail "shared DB was written ${age}s ago, below the ${IDLE_SECONDS}s idle threshold"
  log "gate 4 ok: shared DB idle ${age}s (threshold ${IDLE_SECONDS}s)"
}

# ---------------------------------------------------------------------------
# GATE 5 — we are pointed at the shared DB and not a per-agent one.
#
# A mis-set OPENCODE_SHARED_DATA_DIR pointing into the per-agent tree would make
# this script delete a live agent's session store while every other gate passed.
# ---------------------------------------------------------------------------
gate_target_is_shared() {
  case "$SHARED_DB" in
    "$PER_AGENT_DATA_DIR"/*) fail "SHARED_DB ($SHARED_DB) is inside the per-agent tree ($PER_AGENT_DATA_DIR) — refusing" ;;
  esac
  [ -f "$SHARED_DB" ] || { log "gate 5 skipped: $SHARED_DB does not exist"; return 0; }
  local base
  base=$(basename "$(dirname "$SHARED_DB")")
  [ "$base" = "opencode" ] || fail "refusing to remove $SHARED_DB: its parent directory is '$base', expected 'opencode'"
  log "gate 5 ok: target is the shared data dir ($SHARED_DB)"
}

# ---------------------------------------------------------------------------
# Reclaim. Nothing above this point has modified the filesystem.
# ---------------------------------------------------------------------------
reclaim_bytes() {
  local f
  for f in "$SHARED_DB" "$SHARED_DB-wal" "$SHARED_DB-shm"; do
    [ -e "$f" ] && stat -c %s "$f" 2>/dev/null || true
  done | awk '{s+=$1} END{print s+0}'
}

avail_bytes() { df --block-size=1 --output=avail "$SHARED_DATA_DIR" 2>/dev/null | tail -1 | tr -d ' '; }

report() {
  log "shared DB   : $SHARED_DB"
  log "reclaimable : $(reclaim_bytes) bytes across opencode.db{,-wal,-shm}"
  log "filesystem  : $(avail_bytes) bytes available under $SHARED_DATA_DIR"
}

main() {
  log "== reclaim-opencode-shared-db (dry run; pass --yes to delete) =="
  report
  gate_per_agent_homes
  gate_deployed_build
  gate_target_is_shared
  if [ ! -f "$SHARED_DB" ]; then
    log "gate 3/4 skipped: nothing to reclaim"
    log "RESULT: no shared opencode.db present; nothing to do"
    exit 0
  fi
  gate_no_open_handles
  gate_idle

  if [ "$ASSUME_YES" -ne 1 ]; then
    log "RESULT: all gates passed. Re-run with --yes to delete."
    exit 0
  fi

  if [ -n "$BACKUP_TO" ]; then
    mkdir -p "$(dirname "$BACKUP_TO")" || fail "cannot create backup destination $(dirname "$BACKUP_TO")"
    cp -a "$SHARED_DB" "$BACKUP_TO" || fail "backup to $BACKUP_TO failed; refusing to delete"
    log "backed up to $BACKUP_TO"
  fi

  local before after f
  before=$(avail_bytes)
  for f in "$SHARED_DB" "$SHARED_DB-wal" "$SHARED_DB-shm"; do
    [ -e "$f" ] && rm -f -- "$f"
  done
  after=$(avail_bytes)
  log "RESULT: removed $SHARED_DB{,-wal,-shm}; ${before} -> ${after} bytes available (+$((after - before)))"
}

main "$@"