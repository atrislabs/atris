#!/usr/bin/env bash
# atris-cli smoke test — RL scorecard for forge/autopilot loops.
# Exit 0 = healthy. Exit 1 = regression. Designed to run in <30s with no network.
#
# Add a test: write a `t_<name>` function, then call `run t_<name> "label"`.

set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PASS=0
FAIL=0
FAILURES=()

run() {
  local fn="$1" label="$2"
  if out=$("$fn" 2>&1); then
    PASS=$((PASS+1))
    printf "  ok   %s\n" "$label"
  else
    FAIL=$((FAIL+1))
    FAILURES+=("$label")
    printf "  FAIL %s\n    %s\n" "$label" "$(echo "$out" | head -3 | sed 's/^/    /')"
  fi
}

# ── Tests ────────────────────────────────────────────────────────────────

t_shebang_present() {
  head -1 bin/atris.js | grep -q '^#!/usr/bin/env node$'
}

t_bin_executable_bit() {
  [ -x bin/atris.js ]
}

t_version_via_bin() {
  # Run via the actual bin file, not via node — catches broken shebang/exec bit.
  out=$(./bin/atris.js version 2>&1) || return 1
  echo "$out" | grep -Eq '^atris v[0-9]+\.[0-9]+\.[0-9]+'
}

t_help_exits_zero() {
  ./bin/atris.js help >/dev/null 2>&1
}

t_help_lists_core_commands() {
  out=$(./bin/atris.js help 2>&1) || return 1
  for cmd in init plan do review activate status; do
    echo "$out" | grep -q "$cmd" || { echo "missing: $cmd"; return 1; }
  done
}

t_bin_syntax() {
  node --check bin/atris.js
}

t_commands_load() {
  # require() each command — catches missing deps, bad exports, top-level throws.
  local bad=0
  for f in commands/*.js; do
    [ -f "$f" ] || continue
    node -e "require('./$f')" 2>&1 || { echo "load error: $f"; bad=1; }
  done
  return $bad
}

t_lib_load() {
  local bad=0
  for f in lib/*.js utils/*.js; do
    [ -f "$f" ] || continue
    node -e "require('./$f')" 2>&1 || { echo "load error: $f"; bad=1; }
  done
  return $bad
}

t_package_json_valid() {
  node -e "
    const p = require('./package.json');
    if (!p.name) throw new Error('missing name');
    if (!p.version) throw new Error('missing version');
    if (!p.bin || !p.bin.atris) throw new Error('missing bin.atris entry');
    if (!/^[0-9]+\.[0-9]+\.[0-9]+/.test(p.version)) throw new Error('bad semver: ' + p.version);
  "
}

t_bin_entry_exists() {
  node -e "
    const fs = require('fs');
    const p = require('./package.json');
    if (!fs.existsSync(p.bin.atris)) throw new Error('bin file missing: ' + p.bin.atris);
  "
}

t_map_present_and_referential() {
  [ -f atris/MAP.md ] || { echo "atris/MAP.md missing"; return 1; }
  # MAP.md must contain at least one file:line reference (the contract).
  grep -Eq '[A-Za-z0-9_/.-]+\.(js|md|sh|py|ts):[0-9]+' atris/MAP.md
}

t_map_refs_all_resolve() {
  # Validate ALL file:line refs in MAP.md — file exists AND has >= line N.
  refs=$(grep -Eo '[A-Za-z0-9_/.-]+\.(js|md|sh|py|ts):[0-9]+' atris/MAP.md | sort -u)
  [ -n "$refs" ] || { echo "no refs found"; return 1; }
  local bad=0 broken=()
  while IFS= read -r ref; do
    file="${ref%:*}"
    line="${ref##*:}"
    if [ ! -f "$file" ]; then
      broken+=("missing-file:$ref"); bad=1
    else
      maxline=$(wc -l < "$file" | tr -d ' ')
      if [ "$line" -gt "$maxline" ]; then
        broken+=("line-out-of-range:$ref(file has $maxline)"); bad=1
      fi
    fi
  done <<< "$refs"
  if [ $bad -ne 0 ]; then
    printf "broken refs (%d):\n" "${#broken[@]}"
    printf "  %s\n" "${broken[@]:0:5}"
  fi
  return $bad
}

t_persona_present() {
  [ -f atris/PERSONA.md ] && [ -s atris/PERSONA.md ]
}

t_no_merge_conflict_markers() {
  # Scan all source surfaces, not just src/.
  local found
  found=$(grep -RIln --include='*.js' --include='*.md' --include='*.sh' \
            --include='*.json' --include='*.yml' --include='*.yaml' \
            -E '^(<{7}|={7}|>{7}) ' \
            bin commands lib utils atris test scripts .github 2>/dev/null \
          | grep -v node_modules || true)
  if [ -n "$found" ]; then
    echo "conflict markers in:"; echo "$found"
    return 1
  fi
  return 0
}

# ── Run ──────────────────────────────────────────────────────────────────

echo "atris-cli smoke @ $(./bin/atris.js version 2>/dev/null || echo unknown)"
echo

run t_shebang_present               "bin/atris.js has node shebang"
run t_bin_executable_bit            "bin/atris.js is executable"
run t_version_via_bin               "./bin/atris.js version returns semver"
run t_help_exits_zero               "atris help exits 0"
run t_help_lists_core_commands      "help lists core commands"
run t_bin_syntax                    "bin/atris.js parses"
run t_commands_load                 "commands/*.js require()s cleanly"
run t_lib_load                      "lib + utils require() cleanly"
run t_package_json_valid            "package.json well-formed"
run t_bin_entry_exists              "package.json bin file exists on disk"
run t_map_present_and_referential   "MAP.md exists and has file:line refs"
run t_map_refs_all_resolve          "ALL MAP.md refs resolve (file + line range)"
run t_persona_present               "PERSONA.md present and non-empty"
run t_no_merge_conflict_markers     "no conflict markers in any source"

echo
TOTAL=$((PASS+FAIL))
if [ "$FAIL" -eq 0 ]; then
  printf "PASS  %d/%d\n" "$PASS" "$TOTAL"
  exit 0
else
  printf "FAIL  %d/%d  failed: %s\n" "$FAIL" "$TOTAL" "${FAILURES[*]}"
  exit 1
fi
