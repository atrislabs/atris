#!/usr/bin/env bash
# check.sh <job.json> <checkout> [lane]
# Exit 0 only when the job's new test is real: it loads the module, passes on
# the real code (twice, in time zones a day apart, empty environment, no git
# config), and fails once the job's line is broken. Restores the line after.
# With a third argument, also refuses any change outside the job's file.
set -u
JOB="$1"; W="$2"; LANE_MODE="${3:-}"
cd "$W" || { echo "no checkout"; exit 1; }
target=$(node -p "require('$JOB').target"); file=$(node -p "require('$JOB').files[0]")
[ -f "$file" ] || { echo "file not written"; exit 1; }
if [ -n "$LANE_MODE" ]; then
  extra=$(git status --porcelain | awk '{print $2}' | grep -vxF "$file")
  [ -z "$extra" ] || { echo "touched other files: $(echo $extra | head -c 120)"; exit 1; }
fi
mod=$(basename "$target" .js); dir=$(dirname "$target")
grep -qE "require\(['\"]\.\./$dir/$mod(\.js)?['\"]\)" "$file" || { echo "does not load $target"; exit 1; }
grep -v "require(" "$file" | grep -qE "$dir/$mod" && { echo "reads the source file"; exit 1; }
[ "$(grep -cE "^\s*(test|it)\(" "$file")" -ge 1 ] || { echo "no test"; exit 1; }
[ "$(grep -cE "assert(\.[a-zA-Z]+)?\(" "$file")" -ge 1 ] || { echo "no assert"; exit 1; }
grep -qE "assert\.ok\(true\)|assert\(true\)" "$file" && { echo "empty assert"; exit 1; }

run_clean() { # tz -> exit code of the new test in an empty environment
  local T; T=$(mktemp -d)
  env -i PATH="$PATH" HOME="$T" TMPDIR="${TMPDIR:-/tmp}" TZ="$1" GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 ATRIS_SKIP_UPDATE_CHECK=1 \
    perl -e 'alarm shift; exec @ARGV' 90 node --test "$file" >/dev/null 2>&1
  local c=$?; rm -rf "$T" 2>/dev/null; return $c
}
for tz in Pacific/Kiritimati Pacific/Pago_Pago; do
  run_clean "$tz" || { echo "fails on the real code (TZ=$tz)"; exit 1; }
done

# break the line, run the new test, put the line back no matter what
cp "$target" "$target.check-orig"
restore() { mv -f "$target.check-orig" "$target"; }
trap restore EXIT
node -e '
  const fs = require("fs"); const job = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const lines = fs.readFileSync(job.target, "utf8").split("\n"); const i = job.line - 1;
  if (!lines[i] || lines[i].trim() !== job.before) { console.error("line moved"); process.exit(2); }
  lines[i] = lines[i].slice(0, lines[i].length - lines[i].trimStart().length) + job.after;
  fs.writeFileSync(job.target, lines.join("\n"));
' "$JOB" || { echo "the target line moved"; exit 1; }
if run_clean UTC; then echo "still passes when the line is broken"; exit 1; fi
exit 0
