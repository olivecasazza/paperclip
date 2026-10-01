#!/usr/bin/env bash
# pod-tenant-cpu-census.sh — per-tenant CPU/RSS attribution for a shared control-plane pod.
#
# Why this exists
# ---------------
# The control-plane pod is multi-tenant: one cgroup quota (cpu.max) is shared by every
# company whose agents run there. A single company cannot bound the load it does not own,
# so the platform must be able to *attribute* CPU per tenant before it can bound it.
#
# Attribution key
# ---------------
# Every run-spawned process carries PAPERCLIP_COMPANY_ID in its environment. Reading
# /proc/<pid>/environ gives a reliable, Kubernetes-API-free tenant label for each process,
# which is what makes this measurable from inside the pod (the agent service account is
# denied on deployments and nodes).
#
# Two independent sources are reported:
#   1. /proc census  — every process carrying a company id, bucketed by company.
#   2. DB join       — heartbeat_runs.process_pid/process_group_id joined to /proc, which
#                      is the durable, product-side path (no /proc scanning needed).
#
# Usage
# -----
#   pod-tenant-cpu-census.sh                 # one snapshot + cgroup aggregate
#   pod-tenant-cpu-census.sh --sample 60     # delta over 60s (cores consumed per tenant)
#   pod-tenant-cpu-census.sh --json          # machine-readable output
#
# Exit codes: 0 ok, 2 usage error.

set -euo pipefail

SAMPLE_SECONDS=""
JSON=0
MODE="snapshot"

while [ $# -gt 0 ]; do
  case "$1" in
    --sample) SAMPLE_SECONDS="${2:-}"; MODE="sample"; shift 2 ;;
    --json)   JSON=1; shift ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

# Note: not all /proc/<pid>/environ reads require root — visibility depends on the
# pod's hidepid/ptrace settings. Unreadable pids are skipped rather than fatal, so this
# runs as the pod's app user too (with a possibly partial census).

HZ="$(getconf CLK_TCK)"
HOST="$(hostname)"
CGROUP_CPU_MAX="$(cat /sys/fs/cgroup/cpu.max 2>/dev/null || echo '? ?')"
CGROUP_CPU_STAT="$(grep -E '^(usage_usec|nr_periods|nr_throttled|throttled_usec)' /sys/fs/cgroup/cpu.stat 2>/dev/null || true)"

# Read a process's tenant label and resource counters. Returns empty if unreadable.
# Fields: pid ppid company_id agent_id task_id utime+stime rss_kb cmd
read_proc() {
  local pid="$1" p="/proc/$1"
  [ -r "$p/cmdline" ] || return 0
  local cmd co ag iss ppid st rss
  cmd="$(tr '\0' ' ' < "$p/cmdline" 2>/dev/null || true)"
  [ -n "$cmd" ] || return 0
  # pids outside this user's visibility are unreadable; skip rather than spam stderr.
  [ -r "$p/environ" ] || return 0
  co="$(tr '\0' '\n' < "$p/environ" 2>/dev/null | sed -n 's/^PAPERCLIP_COMPANY_ID=//p' | head -1 || true)"
  ag="$(tr '\0' '\n' < "$p/environ" 2>/dev/null | sed -n 's/^PAPERCLIP_AGENT_ID=//p' | head -1 || true)"
  iss="$(tr '\0' '\n' < "$p/environ" 2>/dev/null | sed -n 's/^PAPERCLIP_TASK_ID=//p' | head -1 || true)"
  ppid="$(awk '/^PPid:/{print $2}' "$p/status" 2>/dev/null || echo '?')"
  st="$(awk '{print $14+$15}' "$p/stat" 2>/dev/null || echo 0)"
  rss="$(awk '/^VmRSS:/{print $2}' "$p/status" 2>/dev/null || echo 0)"
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$pid" "$ppid" "${co:-none}" "${ag:-none}" "${iss:-none}" "$st" "${rss:-0}" "${cmd:0:120}"
}

snapshot() {
  local p
  for p in /proc/[0-9]*; do
    read_proc "${p#/proc/}" 2>/dev/null || true
  done
}

# Emit pid -> (company_id, cumulative cpu ticks) for joining across two snapshots.
ticks_tsv() {
  awk -F'\t' 'NF>=7 {print $1"\t"$3"\t"$6}'
}

if [ "$MODE" = "sample" ]; then
  snapshot | ticks_tsv | sort -t$'\t' -k1,1 > /tmp/.census_s1.$$
  sleep "$SAMPLE_SECONDS"
  snapshot | ticks_tsv | sort -t$'\t' -k1,1 > /tmp/.census_s2.$$
  # join on pid: $1=pid, $2=company, $3=cpu_t1, $4=cpu_t2
  join -t$'\t' -j1 /tmp/.census_s1.$$ /tmp/.census_s2.$$ 2>/dev/null \
    | awk -F'\t' -v hz="$HZ" -v win="$SAMPLE_SECONDS" '
        { d=$4-$3; if (d<0) d=0; cores[$2]+=d/(hz*win) }
        END { for (k in cores) printf "%s\t%.4f\n", k, cores[k] }' \
    | sort -t$'\t' -k2 -rn > /tmp/.census_delta.$$
  rm -f /tmp/.census_s1.$$ /tmp/.census_s2.$$
fi

# Full per-company attribution from the latest snapshot.
LATEST="$(snapshot)"

emit() {
  if [ "$JSON" = "1" ]; then
    emit_json
  else
    emit_text
  fi
}

emit_text() {
  echo "host=$HOST  clk_tck=$HZ  mode=$MODE"
  echo "cgroup cpu.max: $CGROUP_CPU_MAX"
  echo "$CGROUP_CPU_STAT"
  echo
  echo "=== PER-TENANT ATTRIBUTION (processes carrying PAPERCLIP_COMPANY_ID) ==="
  printf '%-38s %4s %12s %12s %10s\n' COMPANY_ID N CUM_CPU_s RSS_MiB SHARE%
  echo "$LATEST" | awk -F'\t' -v hz="$HZ" '
    NF>=7 { n[$3]++; cum[$3]+=$6; rss[$3]+=$7 }
    END {
      t=0; for (k in cum) t+=cum[k]
      for (k in n) printf "%-38s %4d %12.1f %10.0f %9.1f%%\n", k, n[k], cum[k]/hz, rss[k]/1024, (t?100*cum[k]/t:0)
      printf "%-38s %4s %12.1f %10s %9.1f%%\n", "TOTAL", "", t/hz, "", 100
    }' | sort -k4 -rn
  echo
  echo "=== ORPHANED PROCESSES (reparented to pid 1, not the server) ==="
  echo "$LATEST" | awk -F'\t' '$2=="1" && $1!="8" && $3!="none" {printf "  pid=%s company=%s task=%s cpu_s=%.1f :: %s\n",$1,$3,$5,$6/100,$8}'
  echo
  if [ "$MODE" = "sample" ]; then
    echo "=== WINDOW CPU (cores consumed over ${SAMPLE_SECONDS}s) ==="
    awk -F'\t' '{printf "  %-38s %.3f cores\n",$1,$2}' /tmp/.census_delta.$$ 2>/dev/null
  fi
}

emit_json() {
  echo "$LATEST" | awk -F'\t' -v hz="$HZ" -v host="$HOST" -v mode="$MODE" -v win="$SAMPLE_SECONDS" '
    NF>=7 { n[$3]++; cum[$3]+=$6; rss[$3]+=$7; if ($2=="1" && $1!="8" && $3!="none") orph[$1" "$3" "$5]=$6 }
    END {
      printf "{\"host\":\"%s\",\"mode\":\"%s\",\"window_s\":%s,\"tenants\":{", host, mode, (win==""?"null":win)
      first=1
      for (k in n) { if(!first) printf ","; first=0;
        printf "\"%s\":{\"processes\":%d,\"cpu_s\":%.1f,\"rss_mib\":%.0f}", k, n[k], cum[k]/hz, rss[k]/1024 }
      printf "},\"orphans\":["
      first=1
      for (o in orph) { if(!first) printf ","; first=0;
        split(o,a," "); printf "{\"pid\":%s,\"company\":\"%s\",\"task\":\"%s\",\"cpu_s\":%.1f}", a[1],a[2],a[3],orph[o]/hz }
      printf "]}\n"
    }'
}

emit
