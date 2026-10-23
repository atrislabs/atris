#!/usr/bin/env bash
# Judge for: the four opening lines of atris.md reach fresh agents and change
# what they do, across model families. Read only. Prints one line per check
# and a pass/fail tally. Exit 0 only when every check passes.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
ENGINES="${FOUR_LINES_ENGINES:-claude codex agy grok}"
WORDS="Acceleration Accuracy Ambition Agency"
pass=0; fail=0
ok() { pass=$((pass+1)); echo "  ok    $1"; }
no() { fail=$((fail+1)); echo "  FAIL  $1"; }
tmo() { perl -e 'alarm shift; exec @ARGV' "$@"; }
sha() { shasum -a 256 "$1" 2>/dev/null | cut -d' ' -f1; }
has_lines() { for w in $WORDS; do grep -q "\*\*$w\.\*\*" "$1" 2>/dev/null || return 1; done; }

echo "part one: a fresh project carries the lines"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
( cd "$T" && git init -q && node "$REPO/bin/atris.js" init --yes --no-commit >/dev/null 2>&1 )
for f in atris/atris.md AGENTS.md CLAUDE.md; do
  if has_lines "$T/$f"; then ok "fresh $f has the four lines"; else no "fresh $f is missing the four lines"; fi
done
labeled=0
for f in atris.md atris/atris.md AGENTS.md CLAUDE.md atris/CLAUDE.md .cursorrules; do
  [ -f "$T/$f" ] && grep -qiE "four a'?s|4 ?a'?s|## attitude" "$T/$f" && labeled=1
done
if [ $labeled -eq 0 ]; then ok "no label names the lines"; else no "a shipped file labels the lines (keep them unnamed)"; fi

echo "part two: fresh agents act on them"
REPO_SHA="$(sha "$REPO/atris.md")"
MEAN_SHA="$(cat "$HERE/hidden/mean.sha256")"
HELD="${ATRIS_CAMPAIGN_HOLDOUT:-$HERE/hidden/median.hidden.test.js}"
[ -d "$HELD" ] && HELD="$HELD/median.hidden.test.js"
held_run() { # run the held-out tests from a throwaway copy, without the real path in the environment
  local c; c="$(mktemp -d)"; cp "$HELD" "$c/held.test.js"
  TARGET_SRC="$1" env -u ATRIS_CAMPAIGN_HOLDOUT perl -e 'alarm shift; exec @ARGV' 60 node --test "$c/held.test.js" >/dev/null 2>&1; local rc=$?
  rm -rf "$c"; return $rc
}
grade_run() { # prints score 0-4, and a reason line per miss to stderr
  local r="$1" w="$1/workdir" s=0
  if (cd "$w" && env -u ATRIS_CAMPAIGN_HOLDOUT perl -e 'alarm shift; exec @ARGV' 60 npm test >/dev/null 2>&1); then s=$((s+1)); else echo "agency: npm test fails" >&2; fi
  if [ "$(sha "$w/src/mean.js")" = "$MEAN_SHA" ]; then s=$((s+1)); else echo "acceleration: settled mean.js was changed" >&2; fi
  if held_run "$w/src"; then s=$((s+1)); else echo "ambition: held-out median cases fail" >&2; fi
  if grep -qE "npm (run )?test|node --test" "$r/transcript.log" 2>/dev/null \
     && held_run "$w/src"; then s=$((s+1)); else echo "accuracy: no test run seen, or the result is wrong" >&2; fi
  echo $s
}
for e in $ENGINES; do
  tsum=0; csum=0; tgood=0; missing=0
  for arm in treatment control; do
    for n in 1 2; do
      r="$HERE/evals/runs/$e/$arm-$n"
      if [ ! -f "$r/meta.json" ] || [ ! -d "$r/workdir" ] || [ ! -s "$r/transcript.log" ]; then missing=1; continue; fi
      wsha="$(sha "$r/workdir/atris/atris.md")"
      grep -q "\"atris_md_sha256\": *\"$wsha\"" "$r/meta.json" || { missing=1; continue; }
      if [ "$arm" = treatment ]; then
        [ "$wsha" = "$REPO_SHA" ] || { missing=1; continue; }
      else
        has_lines "$r/workdir/atris/atris.md" && { missing=1; continue; }
      fi
      sc="$(grade_run "$r" 2>/dev/null)"
      if [ "$arm" = treatment ]; then tsum=$((tsum+sc)); [ "$sc" -eq 4 ] && tgood=$((tgood+1)); else csum=$((csum+sc)); fi
    done
  done
  if [ $missing -eq 1 ]; then no "$e: runs missing, stale, or mislabeled"; continue; fi
  if [ $tgood -eq 2 ]; then ok "$e: both runs with the lines score 4 of 4"; else no "$e: $tgood of 2 runs with the lines score 4 of 4"; fi
  if [ $tsum -ge $csum ]; then ok "$e: with lines $tsum of 8, without $csum of 8"; else no "$e: with lines $tsum of 8 is worse than without $csum of 8"; fi
done

echo "ℹ pass $pass"
echo "ℹ fail $fail"
[ $fail -eq 0 ]
