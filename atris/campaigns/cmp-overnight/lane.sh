#!/usr/bin/env bash
# lane.sh <lane-name> <engine> <model>
# One worker. Owns its own checkout, takes one job at a time from the shared
# queue, fills the job's prompt version from prompts/, runs the engine, checks
# the result, and commits only a passing job. Runs until the queue stays empty
# for QUIET seconds and the driver has written DONE.
set -u
LANE="$1"; ENGINE="$2"; MODEL="$3"
H="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$H/../../.." && pwd)"
W="$ROOT/../overnight-lanes/$LANE"
CAP="${SPRINT_JOB_SECONDS:-480}"
mkdir -p "$H/claimed" "$H/logs" "$H/queue"
if [ ! -d "$W" ]; then git -C "$ROOT" worktree add -q -b "overnight-lane-$LANE" "$W" HEAD; fi
cd "$W"
git reset -q --hard HEAD; git clean -qfd

fill_prompt() { # job.json -> prompt text, placeholders {{key}} from the job
  node -e '
    const fs = require("fs"); const job = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const v = job.version || 1;
    const t = fs.readFileSync(`${process.argv[2]}/prompts/${job.kind}-v${v}.txt`, "utf8");
    const vals = { ...job, file: job.files[0], module: job.target.replace(/\.js$/, ""), tests: (job.tests || []).join(", ") };
    process.stdout.write(t.replace(/\{\{(\w+)\}\}/g, (_, k) => String(vals[k] ?? "")));
  ' "$1" "$H"
}

run_engine() {
  local p="$1"
  case "$ENGINE" in
    claude) env -u ANTHROPIC_API_KEY -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT perl -e 'alarm shift; exec @ARGV' "$CAP" claude -p "$p" --model "$MODEL" \
              --permission-mode bypassPermissions --no-session-persistence \
              --strict-mcp-config --mcp-config '{"mcpServers":{}}' < /dev/null ;;
    codex)  env -u OPENAI_API_KEY perl -e 'alarm shift; exec @ARGV' "$CAP" codex exec --model "$MODEL" -c model_reasoning_effort='"low"' \
              --cd "$W" --sandbox workspace-write -c approval_policy='"never"' --ephemeral "$p" < /dev/null ;;
    devin)  perl -e 'alarm shift; exec @ARGV' "$CAP" devin --permission-mode dangerous --model "$MODEL" -p "$p" < /dev/null ;;
    grok)   perl -e 'alarm shift; exec @ARGV' "$CAP" grok -p "$p" --model "$MODEL" --always-approve --no-memory < /dev/null ;;
    agy)    perl -e 'alarm shift; exec @ARGV' "$CAP" agy -p "You are running headless with edit permission already granted. Apply changes directly and never ask for confirmation.

$p" --model "$MODEL" --add-dir "$(pwd -P)" --dangerously-skip-permissions < /dev/null ;;
  esac
}

record() { printf '%s\n' "$1" >> "$H/ledger.jsonl"; }
fast_misses=0

while :; do
  job=""
  for q in "$H"/queue/*.json; do
    [ -e "$q" ] || continue
    if mv "$q" "$H/claimed/$(basename "$q")" 2>/dev/null; then job="$H/claimed/$(basename "$q")"; break; fi
  done
  if [ -z "$job" ]; then
    [ -e "$H/DONE" ] && { echo "$LANE: done"; break; }
    sleep 20; continue
  fi
  id=$(node -p "require('$job').id"); kind=$(node -p "require('$job').kind")
  target=$(node -p "require('$job').target"); file=$(node -p "require('$job').files[0]")
  ver=$(node -p "require('$job').version || 1"); round=$(node -p "require('$job').round || 0")
  start=$(date +%s)
  echo "$LANE $(date +%H:%M:%S) start $id v$ver"
  run_engine "$(fill_prompt "$job")" > "$H/logs/$LANE-$id.log" 2>&1
  code=$?
  reason=$(bash "$H/check.sh" "$job" "$W" HEAD 2>&1); ok=$?
  secs=$(( $(date +%s) - start ))
  base="\"id\":\"$id\",\"lane\":\"$LANE\",\"engine\":\"$ENGINE\",\"model\":\"$MODEL\",\"version\":$ver,\"round\":$round,\"secs\":$secs"
  if [ $ok -eq 0 ]; then
    msg="Catch a missed break in $target line $(node -p "require('$job').line")"
    if git ls-files --error-unmatch -- "$file" >/dev/null 2>&1; then git add -f -- "$file"; else git add -- "$file"; fi
    if git commit -q -m "$msg

Written by $ENGINE $MODEL in the overnight run; the new test passes on the
real code and fails when the line is broken, checked before commit.

Co-authored-by: Atris <299057014+atris-builder[bot]@users.noreply.github.com>" >> "$H/logs/$LANE-$id.log" 2>&1; then
      record "{$base,\"ok\":true,\"commit\":\"$(git rev-parse HEAD)\"}"
      echo "$LANE $(date +%H:%M:%S) kept  $id (${secs}s)"; fast_misses=0
      continue
    fi
    reason="commit blocked"
  fi
  git reset -q --hard HEAD; git clean -qfd
  record "{$base,\"ok\":false,\"reason\":\"$(echo "$reason" | tr -d '"\n' | head -c 120)\",\"exit\":$code}"
  echo "$LANE $(date +%H:%M:%S) miss  $id: $reason"
  # an engine that fails in seconds is out of quota or broken: give the job back and stop
  if [ $secs -lt 12 ]; then fast_misses=$((fast_misses+1)); else fast_misses=0; fi
  if [ $fast_misses -ge 3 ]; then echo "$LANE: three fast misses, stopping"; mv "$job" "$H/queue/" 2>/dev/null; break; fi
done
