---
title: Disk Guard
summary: Disk-pressure guard for the /paperclip Longhorn PVC
---

Operational runbook for `scripts/disk-guard.sh`, the disk-pressure guard on the `/paperclip` Longhorn PVC. Written after the 2026-09-27/28 `ENOSPC` incident, where a full volume killed agents instead of reporting pressure.

## Why this matters

On 2026-09-27 agents on this volume started dying with `ENOSPC: no space left on device, write`. The failure mode was silent from the outside: the run was a dead agent with no disk explanation, and nothing in the control plane distinguished "the model gave up" from "the volume is full".

The volume was grown in place, 20G -> 59G on 2026-09-27 and then to 197G (196.7 GiB) under the same PVC `pvc-16b1231a-b6f0-4293-b8c1-08d3974be5a8`. Headroom is no longer the problem, but it will erode again, so the guard exists to report pressure deterministically *before* free space hits zero.

This guard is an instance-level utility for self-hosted Paperclip deployments backed by a shared volume. It is not a product feature: nothing in the server mounts it, and the control plane has no dependency on it.

## Where the script lives

| What | Where |
|---|---|
| Version-controlled source of truth | `scripts/disk-guard.sh` in this repo |
| Deployed copy | `/paperclip/bin/disk-guard.sh` (plus a convenience copy at `/paperclip/disk-guard.sh`) |
| Last recorded state | `/paperclip/run/disk-guard.status` |
| Thresholds test | `scripts/disk-guard.test.mjs` (`pnpm run test:disk-guard`) |

The script existed for its first months only on the PVC it guards, so a PVC restore or a fresh cluster lost it. It is now in the repo; keep the deployed copies byte-identical to `scripts/disk-guard.sh` and re-deploy from this repo:

```bash
install -m 0755 scripts/disk-guard.sh /paperclip/bin/disk-guard.sh
install -m 0755 scripts/disk-guard.sh /paperclip/disk-guard.sh
diff /paperclip/bin/disk-guard.sh /paperclip/disk-guard.sh
```

Run that after every change to the script. A deployed copy that drifts is the failure this doc exists to prevent.

## Using it

```bash
/paperclip/bin/disk-guard.sh --check    # report only; exit 2 at warn, 3 at critical
/paperclip/bin/disk-guard.sh --prune    # prune the verified-safe set, then report
/paperclip/bin/disk-guard.sh --status   # replay the last recorded state, no measurement
```

Exit codes: `0` ok, `1` usage error, `2` warn, `3` critical.

`--check` prints one line and then writes a parseable key/value status file:

```
mount=/paperclip size=196GiB used=35GiB(>17%) free=166379MiB floor=6041MiB level=ok
```

## Thresholds

| Knob | Default | Meaning |
|---|---|---|
| `DISK_GUARD_WARN_PCT` | `88` | usage at or above this is `warn` |
| `DISK_GUARD_CRIT_PCT` | `94` | usage at or above this is `critical` |
| `DISK_GUARD_MIN_FREE_MB` | `1500` | free-space floor; the effective floor is `max(MIN_FREE_MB, 3% of total)` |
| `DISK_GUARD_MOUNT` | `/paperclip` | volume to measure |
| `DISK_GUARD_STATUS_FILE` | `/paperclip/run/disk-guard.status` | where to record state |
| `DISK_GUARD_FORCE` | unset | `1` makes `--prune` run even at `level=ok` |

The floor is volume-relative on purpose: a fixed 1500MiB floor meant something different on a 20G volume than on a 197G one, so the effective floor is `max(1500MiB, 3% of total)` and stays correct across resizes. `DISK_GUARD_MIN_FREE_MB=0` disables the floor entirely, leaving percentage as the only signal. On the current 197G volume the floor resolves to 6041MiB.

Every knob exists as an env override so the threshold matrix is testable without a genuinely full volume; that is what `scripts/disk-guard.test.mjs` drives.

## Rules of thumb

1. **`--prune` is a pressure response, not a scheduled chore.** At healthy usage it is a no-op and prints `prune_skipped=level_ok`. Deleting a 917MiB regenerable browser cache "because the routine ran" costs a slow re-download for no gain. Only reach for `DISK_GUARD_FORCE=1` when you have already decided the download cost is worth it.
2. **Never hand-delete the biggest-looking directories.** Read "Deliberate non-targets" below first. The reclaim figure that matters is `nlink==1` bytes, not `du`.
3. **Treat `--status` as the alert source, `--check` as the diagnosis.** A monitor or routine can read `/paperclip/run/disk-guard.status` without shelling out to `df`.
4. **A `warn` that `--prune` cannot clear is an escalation, not a retry loop.** The safe set is bounded; if it is not enough, the space is somewhere the guard will not touch, and that needs a human decision.
5. **Re-measure after a prune, not before.** `--prune` prints `reclaimed_mib=` from a `df` diff taken around the delete, so the number is the real one, not a prediction.

## Deliberate non-targets

The guard will never delete these, and a test asserts it:

| Path | Why it is off-limits |
|---|---|
| `.local/share/opencode/opencode.db-wal` | A **live SQLite WAL**. Unlinking it corrupts the database. Reclaim it by checkpointing through `sqlite`, never by unlinking. |
| `.local/share/opencode/opencode.db` | The live state DB. |
| `.local/share/pnpm/store` | *Looks* like 581M, but 31261 of 31417 inodes are hardlinked into live `node_modules` trees. Purging it frees ~15M and breaks hardlink dedup. |
| `instances/` | Live agent homes. Deleting loses uncommitted work. |
| `wt/` | Git worktrees on open branches. Deleting loses uncommitted work. |
| `.nix-portable`, `.local/share/nix` | Live toolchains. nix GC needs proot and is not safe to run unsupervised from a live pod. |
| `.rustup` | Live toolchain. |

The one path the guard treats as a log is `.local/share/opencode/log`, and there it deletes only files with `mtime` older than a day — rotated logs, never the current one.

## Why reclaim is measured by `nlink`, not `du`

`du` and a plain `find -printf '%s'` sum both count an inode once per directory entry that references it. For pnpm's store that is 581M on paper and ~15M of real bytes. The guard instead counts only inodes with exactly one link:

```bash
find <path> -xdev -type f -links 1 -printf '%s\n' | awk '{s+=$1} END{print s+0}'
```

This is the only figure that predicts space actually returned to the filesystem. A path whose inodes are all hardlinked elsewhere measures 0 and is skipped rather than deleted, and a path under 1MiB of solo bytes is skipped as not worth the churn. Both branches are pinned in `scripts/disk-guard.test.mjs`.

## Spotting pressure by hand

```bash
df -h /paperclip
cat /paperclip/run/disk-guard.status
```

The status file carries `use_pct`, `avail_mb`, `floor_mb`, `level`, the thresholds in force, and `guard_version`. A stale `checked_at` means the routine has stopped firing — treat that as its own incident, because a guard that silently stops reporting is indistinguishable from a healthy volume.

When `--prune` is not enough, size the paths the guard will not touch:

```bash
du -sh /paperclip/instances /paperclip/wt /paperclip/.local/share/opencode 2>/dev/null
```

## The routine that runs it

A Paperclip routine drives the guard every 6 hours:

- Title "Disk-pressure check: /paperclip PVC". Find it under Routines, or via `GET /api/companies/{companyId}/routines`.
- Schedule `23 */6 * * *` UTC, so runs land at 00:23 / 06:23 / 12:23 / 18:23 UTC.
- `concurrencyPolicy: coalesce_if_active`, `catchUpPolicy: skip_missed` — a missed window is skipped, never stacked.
- Each trigger creates an issue with that same title, which the run agent closes.

The routine's instructions are deliberately asymmetric about outcomes. At `level=ok` the run records one short comment and closes — disk pressure is not a reason to consume attention when the volume is fine. At `warn` or `critical` it runs `--prune`, and if the level is still not `ok` it leaves the issue `blocked` with the measured numbers and a `du` of `instances/`, `wt/`, and `.local/share/opencode`, so a human decides what to do about the space the guard will not touch.

## Related

- [Dev-Plane Deploy & Restart Hygiene](dev-plane-restart-hygiene.md) — the other instance-level runbook; restart bursts and `process_lost`, not disk.
- [Storage](storage.md) — where uploaded files live. Unrelated to PVC sizing, but it is what fills the volume.
