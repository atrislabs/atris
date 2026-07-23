#!/bin/sh
# Re-verify every completed CaDiCaL DRAT proof in ../seymour-r4 with drat-trim.
# Persists one receipt per instance to receipts/<name>.drattrim.txt and a
# summary line per instance to receipts/SUMMARY.txt.
# Runs everything under nice -n 15 with at most $JOBS concurrent checks
# (the machine is shared). Skips instances whose .res has no verdict yet.
# Usage: sh verify_all_drat.sh [JOBS]
set -u
DIR="$(cd "$(dirname "$0")/../seymour-r4" && pwd)"
OUT="$(cd "$(dirname "$0")" && pwd)/receipts"
JOBS="${1:-3}"
mkdir -p "$OUT"
: > "$OUT/SUMMARY.txt"

verify_one() {
  base="$1"
  cnf="$DIR/$base.cnf"; drat="$DIR/$base.drat"
  rc="$OUT/$base.drattrim.txt"
  if [ ! -s "$DIR/$base.res" ] || ! grep -q "^s UNSATISFIABLE" "$DIR/$base.res"; then
    echo "$base SKIP (no UNSAT verdict yet)" >> "$OUT/SUMMARY.txt"; return
  fi
  start=$(date +%s)
  nice -n 15 "$DIR/drat-trim/drat-trim" "$cnf" "$drat" > "$rc" 2>&1
  end=$(date +%s)
  if grep -q "s VERIFIED" "$rc"; then v="VERIFIED"; else v="FAILED"; fi
  echo "$base $v $((end-start))s" >> "$OUT/SUMMARY.txt"
  echo "$base $v $((end-start))s"
}

i=0
for res in "$DIR"/*.res; do
  base=$(basename "$res" .res)
  # order: everything except the two giant top shards first
  case "$base" in n16_s7|n15_s7) continue ;; esac
  verify_one "$base" &
  i=$((i+1))
  [ $((i % JOBS)) -eq 0 ] && wait
done
wait
# big ones last, serially
verify_one "n15_s7"
verify_one "n16_s7"
echo "DONE $(grep -c VERIFIED "$OUT/SUMMARY.txt" || true) verified; failures: $(grep -c FAILED "$OUT/SUMMARY.txt" || true)"
