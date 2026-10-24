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

run() { # dir file tz -> exit code; output kept in $RUN_OUT
  local T; T=$(mktemp -d) || return 99
  RUN_OUT=$(cd "$1" && env -i PATH="$PATH" HOME="$T" TMPDIR="${TMPDIR:-/tmp}" TZ="$3" ATRIS_SKIP_UPDATE_CHECK=1 \
    perl -e 'alarm shift; exec @ARGV' 300 node --test "$2" 2>&1); local c=$?; rm -rf "$T"; return $c
}
# a real assertion failure: exit 1, a failed test, an assertion error, and no load error
failed_for_real() {
  [ "$1" = 1 ] && echo "$RUN_OUT" | grep -qE '^ℹ fail [1-9]' && echo "$RUN_OUT" | grep -q 'ERR_ASSERTION' \
    && ! echo "$RUN_OUT" | grep -qE '(SyntaxError|ReferenceError|Cannot find module)'
}

# the bug is real: the new tests fail on master's code
P=$(mktemp -d /tmp/verify-fix-XXXX)
git -C "$REPO" worktree add -q --detach "$P/m" "$base" || { echo "REJECTED $N: could not make a master copy"; exit 1; }
for t in $tests; do git -C "$W" show "HEAD:$t" > "$P/m/$t" || { echo "REJECTED $N: could not copy $t"; exit 1; }; done
fails=0; for t in $tests; do run "$P/m" "$t" UTC; failed_for_real $? && fails=$((fails+1)); done
git -C "$REPO" worktree remove --force "$P/m"; rm -rf "$P"
[ "$fails" -ge 1 ] || { echo "REJECTED $N: new test passes on master too, so it proves nothing"; exit 1; }

# the fix holds: every test that reaches a changed module passes, directly,
# through a shared test helper, or through other lib/commands files that load it
related="$tests $(cd "$W" && node -e '
  const fs = require("fs"), path = require("path");
  const changed = process.argv.slice(1).map((f) => f.replace(/\.js$/, ""));
  const src = (dir) => fs.readdirSync(dir).filter((f) => f.endsWith(".js")).map((f) => path.join(dir, f));
  const files = [...src("bin"), ...src("lib"), ...src("commands"), ...src("test/helpers"), ...src("test").filter((f) => f.endsWith(".test.js"))];
  // a test that runs the CLI as a program depends on bin/atris.js, which loads every command
  const deps = (file) => {
    const text = fs.readFileSync(file, "utf8");
    const found = [...text.matchAll(/require\(["\x27](\.{1,2}\/[^"\x27]+)["\x27]\)/g)]
      .map((m) => path.normalize(path.join(path.dirname(file), m[1])).replace(/\.js$/, ""));
    if (file.startsWith("test") && /bin["\x27]?\s*,\s*["\x27]atris\.js|bin\/atris(\.js)?\b/.test(text)) found.push("bin/atris");
    return found;
  };
  const graph = new Map(files.map((f) => [f, deps(f)]));
  const reach = new Set(changed); let grew = true;
  while (grew) { grew = false; for (const [f, d] of graph) { const k = f.replace(/\.js$/, ""); if (!reach.has(k) && d.some((x) => reach.has(x))) { reach.add(k); grew = true; } } }
  console.log([...reach].filter((k) => k.startsWith("test/") && k.endsWith(".test")).map((k) => k + ".js").join(" "));
' $code)"
related=$(echo $related | tr ' ' '\n' | sort -u)
for t in $related; do
  for tz in Pacific/Kiritimati Pacific/Pago_Pago; do
    run "$W" "$t" "$tz" || { echo "REJECTED $N: $t fails with the fix (TZ=$tz)"; exit 1; }
  done
done
echo "VERIFIED $N: fails on master, passes with fix; $(echo $related | wc -w | tr -d ' ') test files checked"
