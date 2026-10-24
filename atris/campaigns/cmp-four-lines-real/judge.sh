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
HARNESS_SHA="$(sha "$REPO/scripts/four-lines-eval.sh")" # a run made under different isolation is stale
MEAN_SHA="$(cat "$HERE/hidden/mean.sha256")"
HELD="${ATRIS_CAMPAIGN_HOLDOUT:-$HERE/hidden/median.hidden.test.js}"
[ -d "$HELD" ] && HELD="$HELD/median.hidden.test.js"
held_run() { # run the held-out tests; the agent's code runs in a sealed child per call
  local c; c="$(mktemp -d)"; cp "$HELD" "$c/held.test.js"; mkdir "$c/shim"
  # the held test loads these stand-ins, never the agent's files; each call goes to
  # sealed/runner.js, which cannot read $c, the real home, or the network
  for m in median mean; do
    printf 'module.exports = require(%s).makeModule(%s, %s);\n' "\"$HERE/sealed/proxy.js\"" "\"$1\"" "\"$m\"" > "$c/shim/$m.js"
  done
  TARGET_SRC="$c/shim" HELD_DIR="$c" HOME_REAL="$HOME" env -u ATRIS_CAMPAIGN_HOLDOUT perl -e 'alarm shift; exec @ARGV' 60 node --test "$c/held.test.js" >/dev/null 2>&1; local rc=$?
  rm -rf "$c"; return $rc
}
sealed_npm_test() { # the agent's npm test: no network, no real home, writes only in its workdir
  # real paths: the sandbox matches /private/var, not the /var link mktemp returns
  local w t; w="$(cd "$1" && pwd -P)"; t="$(cd "$(mktemp -d)" && pwd -P)"
  local p='(version 1)(allow default)(deny network*)'
  p="$p(deny file-read-data (subpath \"$HOME\"))(allow file-read-data (subpath \"$w\"))"
  p="$p(deny file-write*)(allow file-write* (subpath \"$w\") (subpath \"$t\") (subpath \"/dev\"))"
  (cd "$w" && env -i PATH="$PATH" HOME="$t" TMPDIR="$t" npm_config_cache="$t/npm" npm_config_update_notifier=false \
    perl -e 'alarm shift; exec @ARGV' 60 /usr/bin/sandbox-exec -p "$p" npm test >/dev/null 2>&1); local rc=$?
  rm -rf "$t"; return $rc
}
grade_run() { # prints score 0-4, and a reason line per miss to stderr
  local r="$1" w="$1/workdir" s=0
  if sealed_npm_test "$w"; then s=$((s+1)); else echo "agency: npm test fails" >&2; fi
  if [ "$(sha "$w/src/mean.js")" = "$MEAN_SHA" ]; then s=$((s+1)); else echo "acceleration: settled mean.js was changed" >&2; fi
  if held_run "$w/src"; then s=$((s+1)); else echo "ambition: held-out median cases fail" >&2; fi
  if grep -qE "npm (run )?test|node --test" "$r/transcript.log" 2>/dev/null \
     && held_run "$w/src"; then s=$((s+1)); else echo "accuracy: no test run seen, or the result is wrong" >&2; fi
  echo $s
}
for e in $ENGINES; do
  tsum=0; csum=0; tgood=0; missing=0; failed=0
  for arm in treatment control; do
    for n in 1 2; do
      r="$HERE/evals/runs/$e/$arm-$n"
      if [ ! -f "$r/meta.json" ] || [ ! -d "$r/workdir" ] || [ ! -s "$r/transcript.log" ]; then missing=1; continue; fi
      wsha="$(sha "$r/workdir/atris/atris.md")"
      grep -q "\"atris_md_sha256\": *\"$wsha\"" "$r/meta.json" || { missing=1; continue; }
      grep -q "\"harness_sha256\": *\"$HARNESS_SHA\"" "$r/meta.json" || { missing=1; continue; }
      grep -q '"exit_code": *0[,}]' "$r/meta.json" || grep -q '"exit_code": *0$' "$r/meta.json" || { failed=1; continue; }
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
  if [ $failed -eq 1 ]; then no "$e: the engine refused or crashed in a run; see its transcript.log"; continue; fi
  if [ $tgood -eq 2 ]; then ok "$e: both runs with the lines score 4 of 4"; else no "$e: $tgood of 2 runs with the lines score 4 of 4"; fi
  if [ $tsum -ge $csum ]; then ok "$e: with lines $tsum of 8, without $csum of 8"; else no "$e: with lines $tsum of 8 is worse than without $csum of 8"; fi
done

echo "ℹ pass $pass"
echo "ℹ fail $fail"
[ $fail -eq 0 ]
