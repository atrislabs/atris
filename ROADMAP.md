# Atris roadmap: mission run to Valhalla

Owner: Keshav. Read this before picking overnight work. This is the goal the loop pursues.

## What we seek

The product, deep down, is the collapse of the distance between wanting and having.
You feel something at 3am, you say it badly, and a machine takes custody of it,
makes it falsifiable, and works it until it exists or you get one honest sentence
about why not. The product is kept promises at machine speed.

The desire under every stage below: the day the loop closes without the founder
inside it. Not because he leaves, but because his job upgrades from operator to
source of wants. Taste becomes sufficient.

The unit of progress is the receipt, and receipts climb a currency ladder:

1. developer currency: tests pass, PRs land, CI green (mostly built)
2. operator currency: Keshav's day runs itself, plain-english surfaces, zero revisions (in flight)
3. civilian currency: a stranger's world changes, a gig booked, an invoice paid, money in (the frontier)

Every feature, every stage, every gate is a rung on that ladder. A wish is a debt
taken against the world's state; the roadmap is the order we learn to repay new
kinds of debt.

## The one goal

`atris mission run "<intent>"` becomes the dream product: one command turns messy intent into a visible mission, a functional team, a proof-backed change, a human-readable landing, and the next move. The loop keeps going until the product is obviously useful, tasteful, and self-improving, with no stale proof and no slop in durable memory.

The horizon: this loop gets strong enough that a lab can point it at cancer research and a founder can point it at building a billion-dollar company, and it just runs.

The near horizon, the one we can feel: anyone met in the desert can be onboarded
in one sitting. A DJ, a small business owner, anyone with a want. `atris meet`
interviews them, their folder appears, their currency is named, and the loop
starts repaying their debt. The first proof is one stranger who pays.

How the layers relate: this file is the master. The five-stage reverse path
lives in atris/wiki/roadmap-to-agi-foundation.md (stage 0 proven 2026-07-06,
stage 1 in flight). The 15-feature orb slate in atris/pitch/orb-features.md is
the feature spine for stages 1 to 3. The alpha judge (atris/team/alpha-judge/)
keeps the slate stocked: combinations of proven features self-build, true gaps
escalate to Keshav.

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

## The 2026-07-10 slate (25 items, one day, receipts or it did not happen)

Sol (GPT-5.6) arrives today. Fable judges, Sol grinds, engines fan out.
Each item names its receipt. Owner in parens.

Sol onboarding
1. Sol's first flight: the till brief (atris/briefs/2026-07-10-the-till.md). Protected lane, no self-landing, orchestrator reviews the diff. (sol + orb)
2. Calibrate Sol on the agents-v1 25-task bench before trusting it; scorecard on the leaderboard next to claude 25/25 and cursor 24/25. (orb)
3. Register Sol as a first-class engine: dispatch contract, fallback order updated, engines skill entry. (executor)
4. Mechanize judge-not-worker across engines: every dispatch prompt names its post-merge judge, judge is never the builder. Written into routing doctrine. (orb)

Money
5. The till live end to end: payment link on /book, read-only money-arrived adapter, `atris till check` exits 0/1, hermetic tests, CI run id cited. (sol)
6. First real dollar: Keshav pays $1 through a test booking page; the system notices by itself and renders the first civilian receipt. (keshav + till)
7. Rainmaker pitch kit: the custody promise in 3 niche-specific linkedin openers, each naming a metric with a floor; passes atris slop. (linguist)
8. Meet golden path proven cold: fresh temp HOME, stranger to live /book link in under 5 minutes, screen recording is the receipt. (validator)
9. Ten linkedin connects sent with the rainmaker opener. Human action, kit prepared. (keshav)

Suite organs
10. Postgres runner v1: psql subprocess det-script, read-only, plain-english question returns real rows rendered as a blocks table, live round trip observed. (codex)
11. Runnable query cell v0 in the blocks doc: one cell executes against postgres and pins a timestamped chart block. Cross-project task filed to atrisos-web. (cross-project-architect)
12. The paper-cut tap v1: keshav fires friction reports at random moments in any words; each becomes a live repro + bounded fix task + regression test, 100% capture, before/after shown back. (executor + linguist, INSPIRATION entry 4)
13. atris.ai/rainmaker page live: the promise with a named metric, live receipts, one button into the meet interview. Filed to atrisos-web. (cross-project-architect, INSPIRATION entry 5)

Loop and infrastructure
14. Land or reject grok's member-switches build after independent verification; verdict recorded on the engine leaderboard. (orb)
15. Wish-discharge launch card ships: a closing wish auto-renders its on-brand receipt image. (cursor)
16. CI-green law mechanized: a receipt claiming green without a CI run id is rejected at the autoland gate. (executor)
17. Mission wall-clock fixed: verifier no longer killed at 15 minutes mid-suite; stranger-pays mission reruns 4 clean ticks. (executor)
18. Alpha judge pass 2: sweep INSPIRATION.md, dispatch the top ripened combo, escalate any new true gap. (orb)
19. Roadmap-fed autonomy proven: inbox empty, loop pulls from this slate on its own, receipt shows the pull. (mission runtime)

Ship and comms
20. atris 3.36.0 on npm: meet, avail fix, hermetic CI fixes, member switches. Tag, CI publish, npm view verified. (keshav flips, agents stage)
21. Launch post + reel for meet: onboard anyone in one sitting. (linguist + reel)
22. Day loop live: morning card mirrors this slate, evening operator email reports receipts against it. (housekeeper)
23. MAP.md updated and brain recompiled after every landing; drift check passes at day end. (validator)

Big swings
24. Last night's interview task accepted and the wish-label wart fixed (the "yo can you" phrasing no longer shortened). (validator)
25. Investor evidence pack updated with the week's story: the red-CI discovery, the green law, meet, the till. Honest numbers only. (orb)
26. Blocks spine day 1 (see "The blocks plan" below): receipt block, verifier block, intake block, serial, plus one thin fixture pack (rainmaker-thin) compiling through all three with a live receipt. (sol + codex, brief: atris/briefs/2026-07-10-blocks.md)

## The blocks plan (the generator, 2026-07-10 onward)

We are not building all software; we are building the thing that builds it.
A business capability becomes a PACK: one markdown manifest (name, niche,
metric, question pack, mission template, verifier, cadence, page copy) that
compiles into a page + intake + loop + receipts. Packs are written, not built.

The seven blocks (each kills a class of repeated code):
1. receipt block: one receipt schema rendering to card / page section / email
   line / morning card / investor stat
2. verifier block: typed verifier (command OR adapter query + predicate,
   currency label, freshness rule) replacing shell strings
3. intake block: generic interview engine driven by question packs as data
   (meet, theme create, wish drill collapse into configs)
4. adapter block: one read-only contract for external surfaces,
   ask(question) -> rows + provenance; stripe adapter = the till role
5. cadence block: schedule + condition + escalation + TTL (pulse, day loop,
   outreach follow-ups, close TTLs collapse into configs)
6. policy gate: no-send / human-accept / scope limits, embedded in the
   compiler, not optional
7. compile contract (keystone): manifest -> surfaces, golden fixture test,
   proven by a stranger-run receipt

Build order (grok-reviewed 2026-07-09, verdict: build with changes):
serial spine first (1 -> 2 -> 3) plus the rainmaker-thin fixture pack, then
4 -> 5 -> 6 -> 7, then the business packs as manifests: rainmaker (gtm),
popshare (marketing), aeo, agentgrads, security, data. Till stays before
rainmaker: money verification precedes outreach promises. No parallel fleet
on shared runtime files; engines serialize on the spine, parallelize only on
packs once the compiler exists.

## Open loop items

Small, bounded tasks the loop pulls one at a time when idle (top first), and
`atris moves` surfaces. Keep each executable in one plan -> do -> review cycle.
Epics live below in "Big jobs" and are NOT loop-seedable, so an unattended
cycle never chases something too vague to finish.


- Restore green means green for real: make the two CI-only failures hermetic
  (bench-agents merge-conflict fixture, wish-bench floor) and right-size the CI
  job timeout. A receipt may only claim green by citing the CI run, never a
  local pass. (codex flight in the air 2026-07-09)
- Per-member wake and sleep switches (member + gm + loops combo, open wish)
- Wish-discharge launch card: when a wish closes, auto-render the on-brand
  receipt image (wish + card + recap combo)
- atris meet follow-through: golden-path test from a stranger's empty laptop to
  a live /book link (flight in the air 2026-07-09)

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

## Status (updated by the loop, last: 2026-07-09)

- master is at v3.35.0. The old `feat/pulse-self-improve-loop` divergence is resolved: loop/moves/clarity all route on master, and `atris run`/`autopilot` front doors sit on the mission runtime.
- Foundation gate 1 (green means green): REGRESSED the day it was declared.
  GitHub Actions on master went red 2026-07-05 and stayed red for 60+ runs while
  local receipts kept claiming green (two CI-only test failures plus a 15-minute
  job timeout). Discovered 2026-07-09 by the stranger-pays mission; fix flight
  in the air. New law: green claims must cite the CI run id, not a local pass.
- 2026-07-09: stranger-pays mission live (first tick resurrected the dead
  `atris avail` /book front door). Alpha judge born: combinations self-build,
  gaps escalate. `atris meet` dispatched. PR 317 killed: mission self-landing lives.
- Foundation gate 1 (green means green): the 2026-07-05 local receipt was real. `npm test` in a fresh worktree exits 0 with 1988/1988; the old "green" was `| tail` masking exit codes: verify gates now run unpiped. But see the regression note above: local green and CI green are different claims.
- Foundation gate 2 (one front door): `atris loop` is the entry; run/autopilot help converge on it.
- Autonomy live: autoland accepts certified work, `atris land` enforces merged-or-salvaged, `atris mission run --fleet` dispatches parallel engines, and every dispatched engine prompt now carries the fable-method kernel (unpiped verify, receipts, caller sweeps, smallest diff).
- Open loop items above are the seedable queue; when it runs dry, the loop stalls: keep it stocked.

### archived detail

Older per-task status narratives (flake forensics, loop front-door build log, clarity slices) were pruned 2026-07-05; they live in git history and atris/logs.

