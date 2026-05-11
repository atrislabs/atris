#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

SMOKE="scripts/smoke.sh"
BIN="bin/atris.js"
MAP="atris/MAP.md"

tmp_dir="$(mktemp -d)"
orig_bin="$tmp_dir/atris.js.orig"
orig_map="$tmp_dir/MAP.md.orig"

cleanup() {
  if [ -f "$orig_bin" ]; then
    cp "$orig_bin" "$BIN"
    chmod +x "$BIN"
  fi
  if [ -f "$orig_map" ]; then
    cp "$orig_map" "$MAP"
  fi
  rm -rf "$tmp_dir"
}
trap cleanup EXIT

cp "$BIN" "$orig_bin"
cp "$MAP" "$orig_map"

assert_fails() {
  local label="$1"
  local pattern="$2"
  local out

  if out="$(bash "$SMOKE" 2>&1)"; then
    printf 'FAIL %s\n  smoke.sh passed under deliberate break\n' "$label" >&2
    exit 1
  fi

  if ! printf '%s\n' "$out" | grep -Fq "$pattern"; then
    printf 'FAIL %s\n  expected pattern: %s\n  got:\n%s\n' "$label" "$pattern" "$out" >&2
    exit 1
  fi

  printf 'ok   %s\n' "$label"
}

break_syntax() {
  cp "$orig_bin" "$BIN"
  chmod +x "$BIN"
  # Append a syntax error to bin/atris.js so node --check fails.
  printf '\n)%s\n' 'SYNTAX_BREAK' >> "$BIN"
  assert_fails "syntax break trips parse check" "bin/atris.js parses"
  cp "$orig_bin" "$BIN"
  chmod +x "$BIN"
}

break_exec_bit() {
  cp "$orig_bin" "$BIN"
  chmod -x "$BIN"
  assert_fails "exec-bit break is caught" "bin/atris.js is executable"
  cp "$orig_bin" "$BIN"
  chmod +x "$BIN"
}

break_fake_map_ref() {
  cp "$orig_map" "$MAP"
  printf '\n- smoke falsifier fake ref: `bin/atris.js:999999`\n' >> "$MAP"
  assert_fails "fake MAP ref is caught" "ALL MAP.md refs resolve"
  cp "$orig_map" "$MAP"
}

break_syntax
break_exec_bit
break_fake_map_ref

printf 'PASS 3/3\n'
