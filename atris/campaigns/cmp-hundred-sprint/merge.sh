#!/usr/bin/env bash
# merge.sh: bring every lane's kept commits onto the sprint branch. Lanes own
# disjoint files, so a conflict means something went wrong: stop and report.
set -u
H="$(cd "$(dirname "$0")" && pwd)"; ROOT="$(cd "$H/../../.." && pwd)"; cd "$ROOT"
for b in $(git for-each-ref --format='%(refname:short)' 'refs/heads/sprint-lane-*'); do
  ahead=$(git rev-list --count HEAD.."$b")
  [ "$ahead" -gt 0 ] || continue
  if git merge -q --no-edit "$b" -m "Merge $b ($ahead kept fixes)" >/dev/null 2>&1; then echo "merged $b: $ahead"
  else git merge --abort; echo "CONFLICT in $b, left out"; fi
done
