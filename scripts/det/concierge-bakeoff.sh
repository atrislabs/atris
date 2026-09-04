#!/bin/sh
# concierge bakeoff: does a fresh-install agent translate plain english into
# atris moves on its own? usage: concierge-bakeoff.sh <engine> <project-dir>
# engine: opencode | devin. logs land in <project-dir>/bakeoff/<n>.log
set -u
engine="$1"; dir="$2"; logdir=/tmp/bakeoff-logs/$engine; mkdir -p "$logdir"
export PATH=/tmp/atris-shim:$PATH
i=0
while IFS= read -r prompt; do
  i=$((i+1)); log="$logdir/$i.log"
  echo "prompt: $prompt" > "$log"
  start=$(date +%s)
  case "$engine" in
    opencode) (cd "$dir" && perl -e 'alarm shift; exec @ARGV' 420 opencode run --model opencode/muse-spark-1.3-contributor-free "$prompt" </dev/null >>"$log" 2>&1); code=$? ;;
    devin)    (cd "$dir" && perl -e 'alarm shift; exec @ARGV' 420 devin -p --model swe-1-7 -- "$prompt" </dev/null >>"$log" 2>&1); code=$? ;;
    *) echo "unknown engine" >&2; exit 2 ;;
  esac
  echo "exit=$code seconds=$(( $(date +%s) - start ))" >> "$log"
  hits=$(grep -o 'atris \(guide\|next\|engine\|spaceship\|plan\|moves\|improve\|task\|atris\.md\)[^ "]*' "$log" | sort | uniq -c | tr '\n' ';')
  told=$(grep -c '^`atris [a-z]' "$log")
  echo "$engine #$i exit=$code atris-calls=[$hits] told-user-to-run=$told"
done <<'PROMPTS'
what should I do next on this project?
use a free model so we don't burn credits
keep going on this while I'm away tonight
PROMPTS
