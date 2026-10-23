#!/usr/bin/env bash
# overnight.sh: run rounds until the blind-spot pool runs dry or ROUNDS end.
# Each round: queue jobs (half on the newest instructions, half on the ones
# before, so the coach's change is measured side by side), wait for the lanes,
# merge, run every new test together, have a reviewer from a different AI
# read each file blind, drop what it flags, open a pull request, merge it once
# every check passes, then let the coach write the next instructions from
# this round's misses and drops. Writes rounds.jsonl as the receipt.
set -u
H="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$H/../../.." && pwd)"
cd "$ROOT"
ROUND_SIZE="${ROUND_SIZE:-150}"; ROUNDS="${ROUNDS:-10}"; ROUND_MINUTES="${ROUND_MINUTES:-75}"
log() { echo "$(date +%H:%M:%S) $*" | tee -a "$H/overnight.log"; }
newest() { ls "$H"/prompts/mut-v*.txt | sed 's/.*-v\([0-9]*\)\.txt/\1/' | sort -n | tail -1; }
commit() { git commit -q -m "$1

Co-authored-by: Atris <299057014+atris-builder[bot]@users.noreply.github.com>"; }
last="$(git rev-parse HEAD)"

START_ROUND="${START_ROUND:-1}"
for round in $(seq "$START_ROUND" $(( START_ROUND + ROUNDS - 1 ))); do
  v=$(newest)
  old=$(ls "$H"/prompts/mut-v*.txt | sed 's/.*-v\([0-9]*\)\.txt/\1/' | sort -n | tail -2 | head -1)
  n=$(node -e '
    const fs = require("fs"), H = process.argv[1], [round, v, old, size] = process.argv.slice(2).map(Number);
    const taken = new Set([...fs.readdirSync(H + "/claimed"), ...fs.readdirSync(H + "/queue")]);
    const byTarget = {};
    for (const f of fs.readdirSync(H + "/pool")) { if (taken.has(f)) continue;
      const j = JSON.parse(fs.readFileSync(H + "/pool/" + f, "utf8")); (byTarget[j.target] ||= []).push([f, j]); }
    const picked = []; let more = true;
    while (picked.length < size && more) { more = false;
      for (const list of Object.values(byTarget)) if (list.length && picked.length < size) { picked.push(list.shift()); more = true; } }
    picked.forEach(([f, j], i) => { j.round = round; j.version = (i % 2 === 0) ? v : old;
      fs.writeFileSync(H + "/queue/" + f, JSON.stringify(j)); fs.unlinkSync(H + "/pool/" + f); });
    console.log(picked.length);' "$H" "$round" "$v" "$old" "$ROUND_SIZE")
  if [ "$n" -eq 0 ]; then log "round $round: pool is empty, stopping"; break; fi
  log "round $round: queued $n jobs, instructions v$v and v$old"

  # wait for this round's jobs to finish
  deadline=$(( $(date +%s) + ROUND_MINUTES * 60 ))
  while :; do
    left=$(ls "$H/queue" | wc -l | tr -d ' ')
    open=$(node -e '
      const fs = require("fs"), H = process.argv[1], round = Number(process.argv[2]);
      const seen = new Set(fs.existsSync(H + "/ledger.jsonl") ? fs.readFileSync(H + "/ledger.jsonl", "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l).id) : []);
      let n = 0; for (const f of fs.readdirSync(H + "/claimed")) { const j = JSON.parse(fs.readFileSync(H + "/claimed/" + f, "utf8")); if (j.round === round && !seen.has(j.id)) n++; }
      console.log(n);' "$H" "$round")
    [ "$left" -eq 0 ] && [ "$open" -eq 0 ] && break
    [ "$(date +%s)" -ge "$deadline" ] && { log "round $round: time limit, moving on with $left queued and $open open"; break; }
    sleep 30
  done

  bash "$H/merge.sh" | tee -a "$H/overnight.log" >/dev/null
  git fetch -q origin master && git merge -q --no-edit origin/master || { git merge --abort; log "round $round: master merge conflict, stopping"; break; }
  git diff --name-only --diff-filter=A "$last" HEAD -- 'test/*--mut-*.test.js' > "$H/round-$round-files.txt"
  total=$(wc -l < "$H/round-$round-files.txt" | tr -d ' ')
  log "round $round: $total new tests to review"
  [ "$total" -eq 0 ] && continue

  # anything that fails next to everything else, or on the merged code, is out
  : > "$H/round-$round-drops.txt"
  if ! bash -c "T=\$(mktemp -d); HOME=\$T node --test \$(cat '$H/round-$round-files.txt') >/dev/null 2>&1"; then
    while read -r f; do
      T=$(mktemp -d); HOME=$T node --test "$f" >/dev/null 2>&1 || echo "DROP $f: fails on the merged code" >> "$H/round-$round-drops.txt"
    done < "$H/round-$round-files.txt"
  fi

  # blind review: a different AI family than the writer
  node -e '
    const fs = require("fs"), H = process.argv[1], round = process.argv[2];
    const files = fs.readFileSync(`${H}/round-${round}-files.txt`, "utf8").trim().split("\n").filter(Boolean);
    const rows = fs.readFileSync(H + "/ledger.jsonl", "utf8").trim().split("\n").map(JSON.parse).filter((r) => r.ok);
    const engineOf = {}; for (const r of rows) engineOf[r.id] = r.engine;
    const jobOf = {}; for (const f of fs.readdirSync(H + "/claimed")) { const j = JSON.parse(fs.readFileSync(H + "/claimed/" + f, "utf8")); jobOf[j.files[0]] = j; }
    const groups = { codex: [], claude: [] };
    for (const f of files) { const j = jobOf[f]; if (!j) continue;
      const reviewer = engineOf[j.id] === "codex" ? "claude" : "codex";
      groups[reviewer].push(`${f} :: ${j.target} line ${j.line}: \`${j.before}\` -> \`${j.after}\``); }
    for (const [who, list] of Object.entries(groups)) for (let i = 0; i < list.length; i += 35)
      fs.writeFileSync(`${H}/round-${round}-review-${who}-${i / 35}.txt`, list.slice(i, i + 35).join("\n"));
  ' "$H" "$round"
  for part in "$H"/round-"$round"-review-*.txt; do
    [ -e "$part" ] || continue
    prompt="$(cat "$H/review-prompt.txt")
$(cat "$part")"
    if [[ "$part" == *review-claude-* ]]; then
      ( env -u ANTHROPIC_API_KEY -u CLAUDECODE perl -e 'alarm 1500; exec @ARGV' claude -p "$prompt" --model claude-opus-5-5 --permission-mode default --allowedTools "Read,Grep,Glob" --no-session-persistence < /dev/null > "$part.out" 2>&1 ) &
    else
      ( env -u OPENAI_API_KEY perl -e 'alarm 1500; exec @ARGV' codex exec --model gpt-6.1-sol -c model_reasoning_effort='"medium"' --sandbox read-only -c approval_policy='"never"' --ephemeral "$prompt" < /dev/null > "$part.out" 2>&1 ) &
    fi
  done
  wait
  # a review that did not finish gets a second reviewer from a third AI family
  for part in "$H"/round-"$round"-review-*.txt; do
    [ -e "$part" ] || continue
    grep -qE "^kept " "$part.out" 2>/dev/null && continue
    log "round $round: review $(basename "$part") did not finish, asking Gemini"
    prompt="$(cat "$H/review-prompt.txt")
$(cat "$part")"
    perl -e 'alarm 1500; exec @ARGV' agy -p "$prompt" --model gemini-3.8-flash --add-dir "$ROOT" < /dev/null > "$part.out" 2>&1
    if ! grep -qE "^kept " "$part.out"; then
      log "round $round: no reviewer finished $(basename "$part"), its tests are left out"
      cut -d' ' -f1 "$part" | sed 's/^/DROP /; s/$/: no reviewer finished/' >> "$H/round-$round-drops.txt"
    fi
  done
  cat "$H"/round-"$round"-review-*.out 2>/dev/null | grep -E "^DROP test/" >> "$H/round-$round-drops.txt"
  awk '{print $2}' "$H/round-$round-drops.txt" | sed 's/:$//' | sort -u | while read -r f; do
    grep -qxF "$f" "$H/round-$round-files.txt" && [ -f "$f" ] && git rm -q "$f"
  done
  cp "$H/round-$round-drops.txt" "$H/receipts/round-$round-drops.txt" 2>/dev/null || { mkdir -p "$H/receipts"; cp "$H/round-$round-drops.txt" "$H/receipts/"; }
  touch "$H/rounds.jsonl"; git add -f "$H/receipts" "$H/ledger.jsonl" "$H/rounds.jsonl" && commit "Overnight round $round: drop what review flagged, save the receipt"
  kept=$(git diff --name-only --diff-filter=A "$last" HEAD -- 'test/*--mut-*.test.js' | wc -l | tr -d ' ')
  log "round $round: $kept of $total kept after review"

  # ship it: merge once every check passes
  br="overnight-round-$round"; git branch -f "$br" HEAD; git push -q -f origin "$br" 2>/dev/null
  pr=$(gh pr create --base master --head "$br" --title "Overnight round $round: $kept tests that catch breaks the old tests missed" \
    --body "Each test passes on the real code and fails when one line is deliberately broken, a break no existing test caught. Every file was read blind by a reviewer from a different AI than its writer. Receipts in atris/campaigns/cmp-overnight/receipts/.

🤖 Generated with [Claude Code](https://claude.com/claude-code)" 2>/dev/null | grep -oE '[0-9]+$')
  if [ -n "$pr" ]; then
    sleep 60
    for i in $(seq 1 60); do out=$(gh pr checks "$pr" 2>&1); echo "$out" | grep -qE "pending|queued|in_progress|no checks" || break; sleep 30; done
    if echo "$out" | grep -q fail; then log "round $round: pull request $pr has a failing check, left open"
    else gh pr merge "$pr" >/dev/null 2>&1
      for i in $(seq 1 60); do s=$(gh pr view "$pr" --json state -q .state); [ "$s" = MERGED ] && break; sleep 20; done
      log "round $round: pull request $pr $s"; fi
  fi
  last="$(git rev-parse HEAD)"

  # score the two instruction versions side by side
  node "$H/score.js" "$H" "$round" | tee -a "$H/overnight.log"

  # keep the winner: a newer version that keeps less than the one it faced is set aside
  lost_note=""
  verdict=$(node -e '
    const rows = require("fs").readFileSync(process.argv[1], "utf8").trim().split("\n");
    const r = JSON.parse(rows[rows.length - 1]); const vs = r.versions;
    if (vs.length < 2) { console.log("none"); process.exit(0); }
    const hi = Math.max(...vs.map((x) => x.version)); const n = vs.find((x) => x.version === hi); const o = vs.find((x) => x.version !== hi);
    console.log(n.keep_rate < o.keep_rate ? `lost ${hi} ${o.version} ${Math.round(n.keep_rate*100)} ${Math.round(o.keep_rate*100)}` : "won");' "$H/rounds.jsonl")
  case "$verdict" in
    lost*)
      set -- $verdict
      mkdir -p "$H/prompts/rejected"
      git mv -f "$H/prompts/mut-v$2.txt" "$H/prompts/rejected/mut-v$2.txt" && commit "Set aside instructions v$2: kept $4% against v$3's $5%"
      lost_note="The last change lost. Version $2 kept $4% of jobs against version $3's $5% in the same round, and was slower. Its text is in prompts/rejected/mut-v$2.txt. Do not repeat what it added; prefer small, specific changes over longer instructions."
      log "round $round: v$2 lost to v$3, set aside"
      v=$(newest) ;;
  esac

  # coach writes the next instructions from this round's evidence
  next=$(( $(ls "$H"/prompts/mut-v*.txt "$H"/prompts/rejected/mut-v*.txt 2>/dev/null | sed 's/.*-v\([0-9]*\)\.txt/\1/' | sort -n | tail -1) + 1 ))
  node "$H/score.js" "$H" "$round" --evidence > "$H/round-$round-evidence.txt"
  env -u ANTHROPIC_API_KEY -u CLAUDECODE perl -e 'alarm 900; exec @ARGV' claude -p "$(cat "$H/coach-prompt.txt")

Current instructions (version $v), the file prompts/mut-v$v.txt:
$(cat "$H/prompts/mut-v$v.txt")

This round's evidence:
$(cat "$H/round-$round-evidence.txt")
$lost_note

Write the improved instructions to atris/campaigns/cmp-overnight/prompts/mut-v$next.txt and change no other file." \
    --model claude-opus-5-5 --permission-mode acceptEdits --allowedTools "Read,Write" --no-session-persistence < /dev/null > "$H/round-$round-coach.log" 2>&1
  if [ ! -f "$H/prompts/mut-v$next.txt" ]; then
    log "round $round: Claude coach did not write, asking Codex"
    env -u OPENAI_API_KEY perl -e 'alarm 900; exec @ARGV' codex exec --model gpt-6.1-sol -c model_reasoning_effort='"high"' --cd "$ROOT" --sandbox workspace-write -c approval_policy='"never"' --ephemeral "$(cat "$H/coach-prompt.txt")

Current instructions (version $v), the file prompts/mut-v$v.txt:
$(cat "$H/prompts/mut-v$v.txt")

This round's evidence:
$(cat "$H/round-$round-evidence.txt")

Write the improved instructions to atris/campaigns/cmp-overnight/prompts/mut-v$next.txt and change no other file." < /dev/null >> "$H/round-$round-coach.log" 2>&1
  fi
  if [ -f "$H/prompts/mut-v$next.txt" ] && grep -q "{{file}}" "$H/prompts/mut-v$next.txt" && grep -q "{{after}}" "$H/prompts/mut-v$next.txt"; then
    git add -f "$H/prompts/mut-v$next.txt" && commit "Coach writes instructions v$next from round $round's misses and drops"
    log "round $round: coach wrote v$next"
  else
    rm -f "$H/prompts/mut-v$next.txt"; log "round $round: coach output rejected, keeping v$v"
  fi
done
touch "$H/DONE"
log "overnight run finished"
