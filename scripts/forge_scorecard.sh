#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

mkdir -p atris/.forge

now="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
commit="$(git rev-parse HEAD 2>/dev/null || printf 'unknown')"
branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || printf 'unknown')"

tmp_output="$(mktemp)"
cleanup() {
  rm -f "$tmp_output"
}
trap cleanup EXIT

if bash scripts/smoke.sh >"$tmp_output" 2>&1; then
  smoke_pass=true
  smoke_exit=0
else
  smoke_pass=false
  smoke_exit=$?
fi

summary="$(grep -E '^(PASS|FAIL)  ' "$tmp_output" | tail -1 || true)"
if [ -z "$summary" ]; then
  summary="$(tail -1 "$tmp_output" || true)"
fi

entry="$(
  jq -nc \
    --arg timestamp "$now" \
    --arg commit "$commit" \
    --arg branch "$branch" \
    --arg summary "$summary" \
    --arg output_preview "$(head -n 8 "$tmp_output")" \
    --argjson smoke_pass "$smoke_pass" \
    --argjson smoke_exit "$smoke_exit" \
    '{
      timestamp: $timestamp,
      commit: $commit,
      branch: $branch,
      smoke_pass: $smoke_pass,
      smoke_exit: $smoke_exit,
      summary: $summary,
      output_preview: $output_preview
    }'
)"

printf '%s\n' "$entry" >> atris/.forge/scorecard.jsonl
printf '%s\n' "$entry"
