# Atris roadmap: clarity in, magic out, on a loop

Owner: Keshav. Read this before picking overnight work. This is the goal the loop pursues.

## The one goal

100% clarity. Get the human clear, and the magic falls out: setups, blocks (card, reel, deck, site), reports, answers. Then run it on a loop that provably improves itself.

## Three jobs (everything fits under these)

1. Draw out clarity (the front door, the real magic)
   - interview the user for style and how they work
   - interactive modes that move 1 or 2 ideas at a time so you stay in flow (writing, feature ideas)
   - payoff: once the human is clear, agents can prompt themselves well, and that is what lets it self-improve

2. Set up anything fast
   - messy input becomes a working setup
   - integrations on demand; if one does not exist, build it on the spot

3. Run the loop
   - overnight, local-fast (ax / atris2 + local models) and on cloud computers
   - recursively self-improving, provably
   - the blocks are the output: card, reel, deck, site, plus weekly reports and data answers; saved local or cloud, the atris way

## Non-negotiable, cross-cutting

- productive language, zero jargon. we read the agent so the human does not. this is the product.
- Fable-ready: a strong model should drive this repo and 10x it. clean map, tight loop, no sprawl.
- phenomenal terminal UX. people live in an agentic chat, an IDE terminal, or tmux. mission must feel great there.
- onboarding that is alive, not a static MAP/TODO wall: show the 3 next moves, human approves or kills, it suggests. seed of proactiveness.
- multiplayer, when the base is solid.

## Open loop items

Small, bounded tasks the loop pulls one at a time when idle (top first), and
`atris moves` surfaces. Keep each executable in one plan -> do -> review cycle.
Epics live below in "Big jobs" and are NOT loop-seedable, so an unattended
cycle never chases something too vague to finish.

- [ ] `atris moves` should mark a move already seeded/approved so the human sees what's queued
- [ ] fix the em dash in the canonical journal title (`# Log — ` in lib/journal.js); the repo's own slop rule bans it
- [ ] `atris loop status --json` should emit a combined machine-readable summary (pulse + local runs)
- [x] point `pulse` help at `atris loop start` (shipped)
- [x] add `atris/CLARITY.md` to the boot-load list in `atris.md` (shipped)
- [x] `atris loop status` summarizes local runs, not just pulse (shipped)
- [x] wire ROADMAP open items into the loop planner (shipped: hasWork + idle seed pull the top item into the inbox)
- [x] atris clarity: interview the user for style and workflow, write a durable profile (shipped)

## Big jobs (epics, not loop-seedable)

Too coarse for one autonomous cycle. Break into bounded open-loop items first.

- Set up anything fast / integrations on demand: messy input becomes a working setup; build the integration if one does not exist. Needs atrisos-backend.
- Real `--cloud`: run the loop on remote computers via atrisos-backend (`--overnight` today is a local OS-cron heartbeat).
- Weekly report + data-answer output blocks (card, reel, deck, site already ship).

## The gate (do this before anything on top)

Foundation first. Dynamic onboarding, the clarity interview, and reports all sit on top of these two.

1. **Green means green.** Kill the flaky tests so an unattended run is trustable. A full-suite pass must be deterministic, not "passes alone, flakes under the live fleet."
2. **One dead-simple start a loop.** Collapse loop / autopilot / run / mission / improve into one obvious entry, local and cloud. Pick the spine; the rest defer to it.

## Leash (current)

Stage-only. The overnight loop may fix, build, test, and prepare a release, and leave a tag ready. It does **not** push a publish tag to npm unattended. Keshav publishes in the morning after reviewing. Flip to full auto-publish only on explicit say-so.

Also: no junk commits. Every commit message must say what changed in plain English. The "fix: overnight loop tick N" pattern is banned.

## Status (updated by the loop)

- branch `feat/pulse-self-improve-loop` is at v3.17.0 while master/npm is at v3.25.1 (51 ahead, 6 behind). Reconcile before any release work; do not publish from this branch.

### foundation task 1 (flakes): met on this branch, with proof

The suite is deterministically green here. Evidence: 6 consecutive full-suite runs at 1356 pass / 0 fail (`CI=true`, ambient agent env, and 3x repeat). The two historical flake causes are handled:
- agent-marker leak (`CLAUDECODE=1` etc. flipping the CLI into proof-only mode): fixed by `scrubAgentEnv` (`test/helpers/agent-env.js`) pulling `AGENT_ENV_MARKERS` from `commands/task.js`. A full run with every marker set still passes 1356/0.
- live-workspace collision: the only tests that spawn the CLI against the real repo (`cli-smoke`, `commands`, `xp`) load source code, not mutable state, so fleet journal-writing cannot flake them.

Honest verdict: the flakes do not reproduce on this branch. They came from running the suite while a live fleet mutated the same workspace (count drifted 1427->1355). Operational rule, not a code bug: run the trustable gate in a clean checkout (`atris worktree`) or in CI, not in a workspace the fleet is editing. Do not manufacture fixes for non-reproducing flakes.

Note: the "fix: overnight loop tick N" junk commit messages + `Co-Authored-By: Devin` trailers come from the external Devin runner, not this repo's code. Fix that in the runner config, not here.

### foundation task 2 (one-command loop): first slice shipped

`atris loop` is now the single front door, delegating to the engines that already exist (no seventh engine):
- `atris loop` -> home: status + the next moves (alive onboarding)
- `atris loop start` -> run now, local (-> `run.js`)
- `atris loop start --overnight` -> durable heartbeat (-> `pulse.js`)
- `atris loop status` / `atris loop stop` -> `pulse.js`
- `atris loop wiki` -> wiki upkeep (the old `loop`; `wiki loop` also works)

Built: `commands/loop-front.js` (pure `routeLoop` + executor), rewired dispatch + help in `bin/atris.js`, `test/loop-front.test.js` (9 tests), migrated 3 wiki tests to `loop wiki`. Full suite green.

Done since: `run` and `autopilot` help now point at `atris loop` (the six doors converge on one, discoverably).

Next on this task, in order:
1. **Wire this ROADMAP into the loop's planner.** Today the loop's `hasWork()` (`commands/run.js`) reads inbox + backlog only; it does not read ROADMAP.md, so "the overnight loop reads from ROADMAP" is still aspirational. Make the Navigator seed tasks from the unchecked items here when inbox/backlog are empty, and make `hasWork()` return true when ROADMAP has open items. Verify with a real `atris loop start --once` run (not a mock), confirming it picks a ROADMAP item. Do this when the branch is not being concurrently churned by the Devin runner.
2. Point `pulse` help at `atris loop` too (finish convergence).
3. A real `--cloud` that reaches remote computers (atrisos-backend); `--overnight` today is a local OS-cron heartbeat, not remote cloud.

Branch hygiene: this work sits on the stale `feat/pulse-self-improve-loop` (v3.17.0). The loop front door should be rebased/cherry-picked onto master (v3.25.x) before any release. The HEALTH.md fixes committed here are already on master via 3.25.x.

### job 1 (draw out clarity): first slices shipped

- `atris moves` (alive onboarding): reads the goal (ROADMAP open items), work in flight (task projection), and fresh inbox; shows the 3 highest-leverage next moves; approve one (seeds it into today's inbox, which the loop's `hasWork()` already reads, so onboarding feeds the loop), kill one (suppressed), or skip. Pure ranking in `lib/next-moves.js`, thin CLI in `commands/moves.js`, 8 tests.
- `atris clarity` (the interview): a short, high-signal interview (focus, voice, cadence, done, leash), one question at a time, writing `.atris/clarity.json` + readable `atris/CLARITY.md` that agents read so the human stops repeating how they work. `lib/clarity.js` + `commands/clarity.js`, 7 tests.
- `atris activate` now surfaces the 3 next moves + a clarity nudge on boot, so onboarding is alive, not a static MAP/TODO wall.

Next on this job: have the boot contract and agents actually read `atris/CLARITY.md` (wire into the activation card / persona load); interactive idea-at-a-time modes for writing and feature shaping.

### still open (the big multi-day jobs)

- Job 2 (set up anything fast / integrations on demand): not started; needs atrisos-backend integration work, too large to fake overnight.
- Job 3 (loop provably self-improving, running overnight on remote computers): the local engines exist (`run`, `pulse`); the gaps are (a) the planner reading ROADMAP, (b) real remote `--cloud`. Both queued above. Not safe to half-wire the autonomous core unverified while the Devin runner churns this branch.
