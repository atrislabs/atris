#!/usr/bin/env bash
# verify-fix.sh <job-number>: checks a fix lane without trusting it. The lane's
# test changes alone, on master's code, must fail (the bug is real); the lane's
# full change must pass that test and every test loading a changed module, in
# two time zones a day apart. Prints one line: VERIFIED / REJECTED <why>.
set -u
N="$1"
H="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$H/../../.." && pwd)"
W="$REPO/../reaudit-fix-$N"
B="reaudit-fix-$N"
base=$(git -C "$W" merge-base HEAD origin/master)
[ "$(git -C "$W" rev-list --count "$base..HEAD")" -ge 1 ] || { echo "REJECTED $N: no commit"; exit 1; }
[ -z "$(git -C "$W" status --porcelain)" ] || { echo "REJECTED $N: uncommitted changes left"; exit 1; }
tests=$(git -C "$W" diff --name-only "$base" HEAD -- 'test/*.test.js')
code=$(git -C "$W" diff --name-only "$base" HEAD -- lib commands bin scripts)
[ -n "$tests" ] || { echo "REJECTED $N: no test changed"; exit 1; }
[ -n "$code" ] || { echo "REJECTED $N: no product change"; exit 1; }
git -C "$W" log -1 --format=%B | grep -q "Co-authored-by: Atris" || { echo "REJECTED $N: missing Atris credit"; exit 1; }

run() { # dir file tz -> exit code
  local T; T=$(mktemp -d)
  (cd "$1" && env -i PATH="$PATH" HOME="$T" TMPDIR="${TMPDIR:-/tmp}" TZ="$3" ATRIS_SKIP_UPDATE_CHECK=1 \
    perl -e 'alarm shift; exec @ARGV' 300 node --test "$2" >/dev/null 2>&1); local c=$?; rm -rf "$T"; return $c
}

# the bug is real: the new tests fail on master's code
P=$(mktemp -d /tmp/verify-fix-XXXX)
git -C "$REPO" worktree add -q --detach "$P/m" "$base"
for t in $tests; do git -C "$W" show "HEAD:$t" > "$P/m/$t"; done
fails=0; for t in $tests; do run "$P/m" "$t" UTC || fails=$((fails+1)); done
git -C "$REPO" worktree remove --force "$P/m"; rm -rf "$P"
[ "$fails" -ge 1 ] || { echo "REJECTED $N: new test passes on master too, so it proves nothing"; exit 1; }

# the fix holds: every test loading a changed module passes
related=$tests
for f in $code; do
  base_name=$(basename "$f" .js); dir=$(dirname "$f")
  related="$related $(cd "$W" && grep -lE "require\(['\"]\.\./$dir/$base_name(\.js)?['\"]\)" test/*.test.js 2>/dev/null)"
done
related=$(echo $related | tr ' ' '\n' | sort -u)
for t in $related; do
  for tz in Pacific/Kiritimati Pacific/Pago_Pago; do
    run "$W" "$t" "$tz" || { echo "REJECTED $N: $t fails with the fix (TZ=$tz)"; exit 1; }
  done
done
echo "VERIFIED $N: fails on master, passes with fix; $(echo $related | wc -w | tr -d ' ') test files checked"
