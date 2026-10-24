#!/usr/bin/env bash
# fix-lane.sh <job-number>: one Codex worker fixes one confirmed pinned bug in
# its own copy of master. It must show the bug first (the corrected test fails
# on today's code), then make the smallest fix. It commits and stops; it never
# pushes. Output: atris/campaigns/cmp-reaudit/fix-out/<n>.txt
set -u
N="$1"
H="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$H/../../.." && pwd)"
JOB=$(sed -n "${N}p" "$H/fix-jobs.jsonl")
W="$REPO/../reaudit-fix-$N"
mkdir -p "$H/fix-out"
git -C "$REPO" fetch -q origin
git -C "$REPO" worktree add -q -b "reaudit-fix-$N" "$W" origin/master 2>/dev/null || true
FILE=$(node -p "JSON.parse(process.argv[1]).file" "$JOB")
CLAIM=$(node -p "JSON.parse(process.argv[1]).claim" "$JOB")
CHECK=$(node -p "JSON.parse(process.argv[1]).check" "$JOB")
PROMPT="A test in this repo locks in a bug as correct behavior. Two independent reviewers agree:

Test: $FILE
Claim: $CLAIM
Second reviewer: $CHECK

Do this, in order, and nothing else:
1. Read the test, the code it checks, its comments, and its callers. If you find the behavior is actually intended, change nothing and reply 'NOT A BUG: <one sentence of evidence>'.
2. Change the pinned assertion in $FILE to expect the correct behavior. Run 'node --test $FILE' and confirm it FAILS on the current code. If it does not fail, stop and reply 'NO REPRO'.
3. Make the smallest fix in the product code so it passes. Do not change unrelated behavior, wording, or files.
4. Run 'node --test $FILE' and every test file that requires the module you changed (grep test/ for it). All must pass.
5. Commit with a plain one-line subject saying what now works, a short body naming the bug, and this exact last line:
Co-authored-by: Atris <299057014+atris-builder[bot]@users.noreply.github.com>
Never use --no-verify. If the commit is blocked, stop and report why. Do not push.
Reply last with one line: FIXED <subject> or NOT A BUG <reason> or NO REPRO <reason> or BLOCKED <reason>."
cd "$W" && env -u ANTHROPIC_API_KEY perl -e 'alarm shift; exec @ARGV' 1500 \
  codex exec -m gpt-6.1-sol --dangerously-bypass-approvals-and-sandbox "$PROMPT" </dev/null > "$H/fix-out/$N.txt" 2>&1
echo "lane $N exit $? :: $(grep -E '^(FIXED|NOT A BUG|NO REPRO|BLOCKED)' "$H/fix-out/$N.txt" | tail -1)"
