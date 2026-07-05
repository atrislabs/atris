# Atris roadmap: mission run to Valhalla

Owner: Keshav. Read this before picking overnight work. This is the goal the loop pursues.

## The one goal

`atris mission run "<intent>"` becomes the dream product: one command turns messy intent into a visible mission, a functional team, a proof-backed change, a human-readable landing, and the next move. The loop keeps going until the product is obviously useful, tasteful, and self-improving, with no stale proof and no slop in durable memory.

The horizon: this loop gets strong enough that a lab can point it at cancer research and a founder can point it at building a billion-dollar company, and it just runs.

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

## Valhalla gates

1. One command, zero confusion: `atris mission run "<intent>"` starts or resumes the right loop, mirrors the visible goal, attaches task context, and prints Landing / Changed / Proof / Next.
2. Roadmap-fed autonomy: when inbox and tasks are empty, the loop pulls from this roadmap, not from stale TODO markdown or random housekeeping.
3. Proof economy: every done state has a fresh verifier, every review lane item is accepted or sent back, and stale receipts cannot land.
4. No-slop interface: operator output is short, human-readable, and free of runner plumbing unless debugging is requested.
5. Dream-product surface: the operator can see active mission, current blocker, next action, proof, and accept/revise in one glance.
6. Durable cloud loop: the same mission spine runs on a local checkout or a remote computer without changing product semantics.
7. Self-improving taste: scorecards change future behavior; low-value loops, stale docs, and cosmetic grind get killed automatically.

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

- [ ] worktree start cuts stale bases: atris worktree start prints base: origin/master but cut a ref 71 commits behind it on 2026-07-05 (two codex flights died on rebase conflicts from it). Find where the base ref is resolved in commands/worktree.js, fetch origin master first (or resolve the remote tip), and pin with a test. Done: fresh worktree HEAD equals the true remote master tip. Check: node --test test/worktree.test.js.

(Shipped items are pruned on completion; git history is the archive.)

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

## Status (updated by the loop, last: 2026-07-05)

- master is at v3.35.0. The old `feat/pulse-self-improve-loop` divergence is resolved: loop/moves/clarity all route on master, and `atris run`/`autopilot` front doors sit on the mission runtime.
- Foundation gate 1 (green means green): met for real. `npm test` in a fresh worktree exits 0 with 1988/1988 (2026-07-05 receipt); the old "green" was `| tail` masking exit codes: verify gates now run unpiped.
- Foundation gate 2 (one front door): `atris loop` is the entry; run/autopilot help converge on it.
- Autonomy live: autoland accepts certified work, `atris land` enforces merged-or-salvaged, `atris mission run --fleet` dispatches parallel engines, and every dispatched engine prompt now carries the fable-method kernel (unpiped verify, receipts, caller sweeps, smallest diff).
- Open loop items above are the seedable queue; when it runs dry, the loop stalls: keep it stocked.

### archived detail

Older per-task status narratives (flake forensics, loop front-door build log, clarity slices) were pruned 2026-07-05; they live in git history and atris/logs.

