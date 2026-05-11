#!/usr/bin/env bash
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
LOG_FILE="$REPO/atris/.forge/overnight-loop.log"
INTERVAL_SECONDS="${FORGE_INTERVAL_SECONDS:-780}"
TICK_TIMEOUT_SECONDS="${FORGE_TICK_TIMEOUT_SECONDS:-900}"

mkdir -p "$(dirname "$LOG_FILE")"

while true; do
  printf '\n[%s] tick start\n' "$(date '+%Y-%m-%d %H:%M:%S %Z')" >> "$LOG_FILE"

  if perl -e 'alarm shift @ARGV; exec @ARGV' \
    "$TICK_TIMEOUT_SECONDS" \
    /bin/zsh -lc "cd '$REPO' && atris autopilot --auto --iterations=1" \
    >> "$LOG_FILE" 2>&1; then
    printf '[%s] tick end exit=0\n' "$(date '+%Y-%m-%d %H:%M:%S %Z')" >> "$LOG_FILE"
  else
    code=$?
    printf '[%s] tick end exit=%s\n' "$(date '+%Y-%m-%d %H:%M:%S %Z')" "$code" >> "$LOG_FILE"
  fi

  sleep "$INTERVAL_SECONDS"
done
