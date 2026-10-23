#!/usr/bin/env bash
# Judge for the 100-fix sprint. A fix counts only if its commit is on this
# branch and its check still passes on the files as they are now. Read only.
set -u
H="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$H/../../.." && pwd)"
GOAL="${SPRINT_GOAL:-100}"
pass=0; fail=0
[ -f "$H/ledger.jsonl" ] || { echo "ℹ pass 0"; echo "ℹ fail $GOAL"; exit 1; }
while IFS=$'\t' read -r id commit; do
  job="$H/claimed/$id.json"
  if [ -f "$job" ] && git -C "$ROOT" merge-base --is-ancestor "$commit" HEAD 2>/dev/null && bash "$H/check.sh" "$job" "$ROOT" >/dev/null 2>&1; then
    pass=$((pass+1))
  else
    fail=$((fail+1)); echo "  not kept: $id"
  fi
done < <(node -e 'const seen=new Set();for(const l of require("fs").readFileSync(process.argv[1],"utf8").split("\n")){if(!l.trim())continue;const r=JSON.parse(l);if(r.ok&&!seen.has(r.id)){seen.add(r.id);console.log(r.id+"\t"+r.commit)}}' "$H/ledger.jsonl")
echo "kept $pass of $GOAL"
echo "ℹ pass $pass"
echo "ℹ fail $(( GOAL > pass ? GOAL - pass : 0 ))"
[ $pass -ge $GOAL ]
