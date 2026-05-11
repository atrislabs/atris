#!/usr/bin/env bash
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
FORGE_DIR="$REPO/atris/.forge"
PID_FILE="$FORGE_DIR/overnight-loop.pid"
WAKE_PID_FILE="$FORGE_DIR/overnight-loop.caffeinate.pid"
LOG_FILE="$FORGE_DIR/overnight-loop.log"
INTERVAL_SECONDS=780
WORKER_SCRIPT="$REPO/scripts/forge_overnight_worker.sh"

mkdir -p "$FORGE_DIR"

is_running() {
  [ -f "$PID_FILE" ] || return 1
  local pid
  pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  [ -n "$pid" ] || return 1
  kill -0 "$pid" 2>/dev/null
}

start_loop() {
  if is_running; then
    printf 'already running pid=%s log=%s\n' "$(cat "$PID_FILE")" "$LOG_FILE"
    return 0
  fi

  nohup setsid env FORGE_INTERVAL_SECONDS="$INTERVAL_SECONDS" "$WORKER_SCRIPT" </dev/null >/dev/null 2>&1 &

  local pid=$!
  printf '%s\n' "$pid" > "$PID_FILE"
  nohup /usr/bin/caffeinate -dims -w "$pid" >/dev/null 2>&1 &
  printf '%s\n' "$!" > "$WAKE_PID_FILE"
  sleep 1

  if kill -0 "$pid" 2>/dev/null; then
    printf 'started pid=%s log=%s interval=%ss\n' "$pid" "$LOG_FILE" "$INTERVAL_SECONDS"
  else
    rm -f "$PID_FILE"
    rm -f "$WAKE_PID_FILE"
    echo "failed to start forge overnight loop" >&2
    exit 1
  fi
}

stop_loop() {
  if ! is_running; then
    rm -f "$PID_FILE"
    echo "not running"
    return 0
  fi

  local pid
  pid="$(cat "$PID_FILE")"
  kill "$pid" 2>/dev/null || true
  if [ -f "$WAKE_PID_FILE" ]; then
    kill "$(cat "$WAKE_PID_FILE")" 2>/dev/null || true
  fi
  rm -f "$PID_FILE"
  rm -f "$WAKE_PID_FILE"
  printf 'stopped pid=%s\n' "$pid"
}

show_status() {
  if is_running; then
    printf 'running pid=%s log=%s\n' "$(cat "$PID_FILE")" "$LOG_FILE"
  else
    echo "not running"
  fi
}

show_tail() {
  if [ ! -f "$LOG_FILE" ]; then
    echo "no log yet"
    return 0
  fi
  tail -n 40 "$LOG_FILE"
}

case "${1:-start}" in
  start)
    start_loop
    ;;
  stop|kill)
    stop_loop
    ;;
  restart)
    stop_loop
    start_loop
    ;;
  status)
    show_status
    ;;
  tail)
    show_tail
    ;;
  *)
    echo "usage: scripts/forge_overnight.sh [start|stop|restart|status|tail]" >&2
    exit 1
    ;;
esac
