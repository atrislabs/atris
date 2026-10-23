#!/usr/bin/env bash
# check.sh <job.json> <checkout> [base-ref]
# Exit 0 only when the job's file is real, valid work. Read only, except a
# temp HOME for test runs. Prints one reason line on failure.
set -u
JOB="$1"; W="$2"; BASE="${3:-}"
kind=$(node -p "require('$JOB').kind"); target=$(node -p "require('$JOB').target"); file=$(node -p "require('$JOB').files[0]")
tmo() { perl -e 'alarm shift; exec @ARGV' "$@"; }
cd "$W" || { echo "no checkout"; exit 1; }
[ -f "$file" ] || { echo "file not written"; exit 1; }
if [ -n "$BASE" ]; then
  extra=$(git status --porcelain | awk '{print $2}' | grep -vxF "$file")
  [ -z "$extra" ] || { echo "touched other files: $(echo $extra | head -c 120)"; exit 1; }
fi
if [ "$kind" = test ] || [ "$kind" = fn ]; then
  mod=$(basename "$target" .js)
  if [ "$kind" = fn ]; then fn=$(node -p "require('$JOB').fn"); grep -qw "$fn" "$file" || { echo "never calls $fn"; exit 1; }; fi
  grep -qE "require\(['\"]\.\./(commands|lib)/$mod(\.js)?['\"]\)" "$file" || { echo "does not load $target"; exit 1; }
  [ "$(grep -cE "^\s*(test|it)\(" "$file")" -ge 2 ] || { echo "fewer than two tests"; exit 1; }
  [ "$(grep -cE "assert(\.[a-zA-Z]+)?\(" "$file")" -ge 2 ] || { echo "fewer than two asserts"; exit 1; }
  grep -qE "assert\.ok\(true\)|assert\(true\)" "$file" && { echo "empty assert"; exit 1; }
  # Run twice, in time zones a day apart, with a blank home and no git config,
  # so tests that lean on today's date or this machine's settings fail here.
  for tz in Pacific/Kiritimati Pacific/Pago_Pago; do
    T=$(mktemp -d)
    env -i PATH="$PATH" HOME="$T" TMPDIR="${TMPDIR:-/tmp}" TZ="$tz" GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 ATRIS_SKIP_UPDATE_CHECK=1 \
      perl -e 'alarm shift; exec @ARGV' 90 node --test "$file" >"$T/out" 2>&1
    code=$?; rm -rf "$T" 2>/dev/null
    [ $code -eq 0 ] || { echo "tests fail (TZ=$tz)"; exit 1; }
  done
else
  node bin/atris.js slop detect "$file" >/dev/null 2>&1 || { echo "writing problems remain"; exit 1; }
  if [ -n "$BASE" ]; then
    read add del _ < <(git diff --numstat -- "$file")
    [ "${del:-0}" -le $(( ${add:-0} + 3 )) ] || { echo "removed too much ($del lines out, $add in)"; exit 1; }
  fi
fi
exit 0
