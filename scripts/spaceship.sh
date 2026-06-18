#!/usr/bin/env bash
#
# spaceship.sh — bounded, self-reporting overnight runner for the autonomous
# team member ("the spaceship").
#
# The problem this fixes: every existing overnight loop (forge_overnight_worker,
# atris pulse) writes only to local log files and journals. When a tick halts or
# the loop goes idle for hours, nobody finds out. The HVAC loop went dark for 11
# hours that way. This runner makes the loop FAIL LOUD: it survives bad ticks
# instead of dying on the first one, watches for no-op streaks, and emails Keshav
# on every meaningful state change plus a final summary.
#
# It does NOT reimplement the tick — it shells out to the real one
# (`atris autopilot --auto --iterations=1` by default) and classifies the result
# by what actually landed in git, which is model-agnostic.
#
# Usage:
#   scripts/spaceship.sh --hours 4
#   scripts/spaceship.sh --hours 4 --repo /path/to/repo --interval 780
#   scripts/spaceship.sh --hours 0.01 --tick-cmd /tmp/stub.sh --no-email   # test
#
# Env:
#   SPACESHIP_EMAIL_CMD   command that takes "--subject X" and reads body on stdin.
#                         Default: the atrisos-backend SES helper (see below).
#
set -uo pipefail

# ---- defaults ----------------------------------------------------------------
HOURS=4
INTERVAL=780                 # seconds between ticks (~13 min)
REPO="$(pwd)"
TICK_CMD="atris autopilot --auto --iterations=1"
TICK_TIMEOUT=900             # per-tick hard cap (seconds)
IDLE_ALERT=3                 # email after this many consecutive idle ticks
HALT_ALERT=2                 # email after this many consecutive halted ticks
EMAIL=1
LABEL="spaceship"

# Default email channel: the verified SES helper in atrisos-backend.
BACKEND_DEFAULT="${SPACESHIP_BACKEND:-/Users/keshavrao/arena/atrisos-backend}"
DEFAULT_EMAIL_CMD="${BACKEND_DEFAULT}/venv/bin/python ${BACKEND_DEFAULT}/backend/scripts/spaceship_update.py"
EMAIL_CMD="${SPACESHIP_EMAIL_CMD:-$DEFAULT_EMAIL_CMD}"

# ---- args --------------------------------------------------------------------
while [ $# -gt 0 ]; do
  case "$1" in
    --hours) HOURS="$2"; shift 2;;
    --interval) INTERVAL="$2"; shift 2;;
    --repo) REPO="$2"; shift 2;;
    --tick-cmd) TICK_CMD="$2"; shift 2;;
    --tick-timeout) TICK_TIMEOUT="$2"; shift 2;;
    --idle-alert) IDLE_ALERT="$2"; shift 2;;
    --halt-alert) HALT_ALERT="$2"; shift 2;;
    --label) LABEL="$2"; shift 2;;
    --no-email) EMAIL=0; shift;;
    -h|--help) sed -n '2,40p' "$0"; exit 0;;
    *) echo "unknown arg: $1" >&2; exit 2;;
  esac
done

REPO="$(cd "$REPO" && pwd)"
STATE_DIR="$REPO/atris/.spaceship"
mkdir -p "$STATE_DIR"
LOG_FILE="$STATE_DIR/run.log"
BUDGET_SECONDS="$(awk "BEGIN{printf \"%d\", $HOURS*3600}")"
START_EPOCH="$(date +%s)"

# ---- helpers -----------------------------------------------------------------
now() { date '+%Y-%m-%d %H:%M:%S %Z'; }
elapsed_min() { echo $(( ( $(date +%s) - START_EPOCH ) / 60 )); }

logline() { printf '[%s] %s\n' "$(now)" "$1" | tee -a "$LOG_FILE"; }

# send_email <subject> <body>
send_email() {
  local subject="$1" body="$2"
  if [ "$EMAIL" -ne 1 ]; then
    logline "EMAIL(skipped): $subject"
    return 0
  fi
  if printf '%s\n' "$body" | $EMAIL_CMD --subject "$subject" >>"$LOG_FILE" 2>&1; then
    logline "EMAIL sent: $subject"
  else
    logline "EMAIL FAILED: $subject (channel down — check $LOG_FILE)"
  fi
}

git_head() { git -C "$REPO" rev-parse HEAD 2>/dev/null || echo "nogit"; }
git_last_subject() { git -C "$REPO" log -1 --pretty=%s 2>/dev/null || echo ""; }
# Count commits reachable from ANY ref, not just the checked-out HEAD. The live
# loop often commits on its own branch inside a linked worktree (that is exactly
# how the pulse loop ran on 2026-06-17), so HEAD never moves even though real
# work landed. Watching all refs keeps the supervisor from reporting that as idle.
all_commit_count() { git -C "$REPO" rev-list --all --count 2>/dev/null || echo 0; }
git_last_subject_any() { git -C "$REPO" log --all -1 --pretty=%s 2>/dev/null || echo ""; }

# run one tick with a hard timeout; returns exit code, writes output to $1
run_tick() {
  local out="$1"
  # perl alarm = portable timeout (macOS has no coreutils `timeout` by default)
  perl -e 'alarm shift @ARGV; exec @ARGV' "$TICK_TIMEOUT" \
    /bin/bash -lc "cd '$REPO' && $TICK_CMD" >"$out" 2>&1
  return $?
}

# ---- run ---------------------------------------------------------------------
ticks=0; shipped=0; halted=0; idle=0
idle_streak=0; halt_streak=0
idle_alerted=0
declare -a shipped_subjects=()

logline "spaceship start: repo=$REPO budget=${HOURS}h interval=${INTERVAL}s tick='$TICK_CMD'"
send_email "${LABEL}: started a ${HOURS}h run" \
"Spaceship is live in $(basename "$REPO").

Budget: ${HOURS} hours, one tick about every $(( INTERVAL/60 )) min.
I'll email you when something ships, when a tick halts, or if I go idle for ${IDLE_ALERT} ticks in a row. A final summary lands when the run ends.

If you get nothing for over an hour, the supervisor itself died — that's the signal."

while true; do
  remaining=$(( BUDGET_SECONDS - ( $(date +%s) - START_EPOCH ) ))
  if [ "$remaining" -le 0 ]; then
    logline "budget exhausted after $(elapsed_min)m"
    break
  fi

  ticks=$((ticks+1))
  head_before="$(git_head)"
  refs_before="$(all_commit_count)"
  tick_out="$STATE_DIR/tick.$ticks.out"
  logline "tick $ticks start (remaining ~$(( remaining/60 ))m)"

  run_tick "$tick_out"; code=$?
  head_after="$(git_head)"
  refs_after="$(all_commit_count)"
  tail_out="$(tail -c 1200 "$tick_out" 2>/dev/null)"

  # ---- classify outcome by what actually happened ----
  head_moved=0
  if [ "$head_before" != "$head_after" ] && [ "$head_after" != "nogit" ]; then head_moved=1; fi
  refs_grew=0
  if [ "${refs_after:-0}" -gt "${refs_before:-0}" ] 2>/dev/null; then refs_grew=1; fi
  if [ "$head_moved" -eq 1 ] || [ "$refs_grew" -eq 1 ]; then
    # real work landed: a new commit exists — on HEAD, another branch, or a worktree
    shipped=$((shipped+1)); idle_streak=0; halt_streak=0; idle_alerted=0
    if [ "$head_moved" -eq 1 ]; then subj="$(git_last_subject)"; else subj="$(git_last_subject_any)"; fi
    shipped_subjects+=("$subj")
    logline "tick $ticks SHIPPED: $subj"
    send_email "${LABEL}: shipped — $subj" \
"Tick $ticks landed a real change.

Commit: ${head_after:0:9}  ${subj}

Run so far: ${shipped} shipped, ${halted} halted, ${idle} idle over ${ticks} ticks (${elapsed_min:+$(elapsed_min)}m in).
Next tick in ~$(( INTERVAL/60 ))m."
  elif [ "$code" -eq 142 ] || [ "$code" -eq 124 ]; then
    # timed out (perl alarm = SIGALRM = 142)
    halted=$((halted+1)); halt_streak=$((halt_streak+1)); idle_streak=0
    logline "tick $ticks TIMEOUT (exit $code), halt_streak=$halt_streak"
    if [ "$halt_streak" -ge "$HALT_ALERT" ]; then
      send_email "${LABEL}: ${halt_streak} ticks timed out in a row" \
"Heads up — the last ${halt_streak} ticks hit the ${TICK_TIMEOUT}s wall without landing work.

Last tick tail:
${tail_out}

I'm still running and will keep trying, but a tick this slow usually means a stuck do-phase. Worth a look when you're back."
    fi
  elif [ "$code" -ne 0 ] || printf '%s' "$tail_out" | grep -qiE 'halted|verify failed|review (flagged|found)|hit an error'; then
    # the tick halted / errored / failed review or verify — but we DON'T die
    halted=$((halted+1)); halt_streak=$((halt_streak+1)); idle_streak=0
    logline "tick $ticks HALTED (exit $code), halt_streak=$halt_streak"
    if [ "$halt_streak" -ge "$HALT_ALERT" ]; then
      send_email "${LABEL}: ${halt_streak} ticks halted in a row" \
"The last ${halt_streak} ticks halted without shipping (exit $code).

Last tick tail:
${tail_out}

The supervisor is still alive and will keep picking new work — it does not die on a bad tick. But repeated halts mean the top of the backlog needs a human. Flagging now instead of going dark."
    fi
  else
    # clean exit, no commit, no error markers -> nothing to pick up
    idle=$((idle+1)); idle_streak=$((idle_streak+1)); halt_streak=0
    logline "tick $ticks IDLE, idle_streak=$idle_streak"
    if [ "$idle_streak" -ge "$IDLE_ALERT" ] && [ "$idle_alerted" -eq 0 ]; then
      idle_alerted=1
      send_email "${LABEL}: idle ${idle_streak} ticks — backlog looks empty" \
"I've checked the repo ${idle_streak} ticks in a row and found nothing to pick up. The workspace looks clean.

I'll keep checking (in case new signals appear), but this usually means the backlog needs a fresh horizon from you. Not dead — just out of well-defined work."
    fi
  fi

  # sleep, but never past the budget
  remaining=$(( BUDGET_SECONDS - ( $(date +%s) - START_EPOCH ) ))
  if [ "$remaining" -le 0 ]; then break; fi
  sleep_for=$(( INTERVAL < remaining ? INTERVAL : remaining ))
  sleep "$sleep_for"
done

# ---- final summary -----------------------------------------------------------
mins="$(elapsed_min)"
summary_list=""
for s in "${shipped_subjects[@]:-}"; do
  [ -n "$s" ] && summary_list="${summary_list}- ${s}"$'\n'
done
[ -z "$summary_list" ] && summary_list="(nothing shipped this run)"$'\n'

logline "spaceship done: ${ticks} ticks, ${shipped} shipped, ${halted} halted, ${idle} idle, ${mins}m"
send_email "${LABEL}: run finished — ${shipped} shipped in ${mins}m" \
"The ${HOURS}h run is done.

Ticks: ${ticks}   Shipped: ${shipped}   Halted: ${halted}   Idle: ${idle}   Elapsed: ${mins}m

What shipped:
${summary_list}
Full log: ${LOG_FILE}"

exit 0
