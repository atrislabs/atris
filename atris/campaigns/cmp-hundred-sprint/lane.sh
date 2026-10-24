#!/usr/bin/env bash
# lane.sh <lane-name> <engine> <model>
# One worker. Owns its own checkout, takes one job at a time from the shared
# queue, runs the engine, checks the result, and commits only a passing job.
set -u
LANE="$1"; ENGINE="$2"; MODEL="$3"
H="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$H/../../.." && pwd)"
W="$ROOT/../sprint-lanes/$LANE"
CAP="${SPRINT_JOB_SECONDS:-420}"
DEADLINE="${SPRINT_DEADLINE:-0}"
MAXJOBS="${SPRINT_MAX_JOBS:-0}"; done_jobs=0
mkdir -p "$H/claimed" "$H/logs"
if [ ! -d "$W" ]; then git -C "$ROOT" worktree add -q -b "sprint-lane-$LANE" "$W" HEAD; fi
cd "$W"
tmo() { perl -e 'alarm shift; exec @ARGV' "$@"; }

prompt_for() {
  local kind="$1" target="$2" file="$3"
  if [ "$kind" = test ]; then cat <<EOF
You are in the atris-cli repo: Node, zero dependencies, tests use node:test.
Write ONE new test file at $file that tests $target. Read $target first.

Rules:
- Create only $file. Change nothing else, not even the code under test.
- It must load the module with require('../${target%.js}').
- Test real behavior of exported functions or the command's argument and help handling: at least two test() blocks with real asserts on real outputs.
- Use require('node:test') and require('node:assert').
- No network, no spawning AI engines, no long-running commands. Write only inside a fs.mkdtempSync(path.join(os.tmpdir(), ...)) dir, and point process.env.HOME there if the code reads it.
- Run: node --test $file and make it pass.
- If the module cannot be tested safely without changing it, write nothing and stop.
- Do not commit.
EOF
  else cat <<EOF
You are in the atris-cli repo. Fix the writing problems in $file.
Run: node bin/atris.js slop detect $file to see them.

Rules:
- Edit only $file, and only the flagged lines.
- Replace each em dash with a comma, colon, or period so the sentence still reads naturally. Keep the meaning. Keep every other line exactly as is.
- Rerun the check until it reports clean.
- Do not commit.
EOF
  fi
}

run_engine() {
  local p="$1"
  case "$ENGINE" in
    claude) env -u ANTHROPIC_API_KEY -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT perl -e 'alarm shift; exec @ARGV' "$CAP" claude -p "$p" --model "$MODEL" \
              --permission-mode bypassPermissions --no-session-persistence \
              --strict-mcp-config --mcp-config '{"mcpServers":{}}' < /dev/null ;;
    codex)  env -u OPENAI_API_KEY perl -e 'alarm shift; exec @ARGV' "$CAP" codex exec --model "$MODEL" -c model_reasoning_effort='"low"' \
              --cd "$W" --sandbox workspace-write -c approval_policy='"never"' --ephemeral "$p" < /dev/null ;;
    devin)  tmo "$CAP" devin --permission-mode dangerous --model "$MODEL" -p "$p" < /dev/null ;;
    grok)   tmo "$CAP" grok -p "$p" --model "$MODEL" --always-approve --no-memory < /dev/null ;;
    agy)    tmo "$CAP" agy -p "You are running headless with edit permission already granted. Apply changes directly and never ask for confirmation.

$p" --model "$MODEL" --add-dir "$(pwd -P)" --dangerously-skip-permissions < /dev/null ;;
  esac
}

record() { printf '%s\n' "$1" >> "$H/ledger.jsonl"; }

while :; do
  [ "$MAXJOBS" -gt 0 ] && [ "$done_jobs" -ge "$MAXJOBS" ] && break
  done_jobs=$((done_jobs+1))
  [ "$DEADLINE" -gt 0 ] && [ "$(date +%s)" -ge "$DEADLINE" ] && { echo "$LANE: time is up"; break; }
  job=""
  for q in "$H"/queue/*.json; do
    [ -e "$q" ] || break
    if mv "$q" "$H/claimed/$(basename "$q")" 2>/dev/null; then job="$H/claimed/$(basename "$q")"; break; fi
  done
  [ -n "$job" ] || { echo "$LANE: queue empty"; break; }
  id=$(node -p "require('$job').id"); kind=$(node -p "require('$job').kind")
  target=$(node -p "require('$job').target"); file=$(node -p "require('$job').files[0]")
  start=$(date +%s)
  echo "$LANE $(date +%H:%M:%S) start $id"
  run_engine "$(prompt_for "$kind" "$target" "$file")" > "$H/logs/$LANE-$id.log" 2>&1
  code=$?
  reason=$(bash "$H/check.sh" "$job" "$W" HEAD 2>&1); ok=$?
  secs=$(( $(date +%s) - start ))
  if [ $ok -eq 0 ]; then
    if [ "$kind" = test ]; then msg="Add tests for $target"; else msg="Clean the writing in $file"; fi
    git add -- "$file" && git commit -q -m "$msg

Written by $ENGINE $MODEL in the 100-fix sprint; checked before commit.

Co-authored-by: Atris <299057014+atris-builder[bot]@users.noreply.github.com>" >> "$H/logs/$LANE-$id.log" 2>&1
    if [ $? -eq 0 ]; then
      sha=$(git rev-parse HEAD)
      record "{\"id\":\"$id\",\"lane\":\"$LANE\",\"engine\":\"$ENGINE\",\"model\":\"$MODEL\",\"ok\":true,\"commit\":\"$sha\",\"secs\":$secs}"
      echo "$LANE $(date +%H:%M:%S) kept  $id (${secs}s)"
      continue
    fi
    reason="commit blocked"
  fi
  git reset -q --hard HEAD; git clean -qfd
  record "{\"id\":\"$id\",\"lane\":\"$LANE\",\"engine\":\"$ENGINE\",\"model\":\"$MODEL\",\"ok\":false,\"reason\":\"$(echo "$reason" | tr -d '"\n' | head -c 120)\",\"exit\":$code,\"secs\":$secs}"
  echo "$LANE $(date +%H:%M:%S) miss  $id: $reason"
done
