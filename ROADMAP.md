# Atris roadmap: mission run to Valhalla

Owner: Keshav. Read this before picking work. This is the goal the loop pursues. The ranked plan is in "The plan, finalized 2026-10-26".

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

## The plan, finalized 2026-10-26

Everything below is ranked. Each item names an owner, a done check that someone
other than the worker runs, and a kill rule. The July slate and status live in
git history (`git show b061f1fbc:ROADMAP.md`). A codex review attacked the first
draft; this version takes its fixes.

The one number this season: the first $1,000 from strangers. Baseline on 10-22:
29 repo visitors in 14 days, 71 stars, and every dollar so far came from Keshav
selling directly to businesses paying thousands a month or per project (DoorDash,
Pallet), not from small online purchases. The buyer is a business with no
engineers that has never seen what agents can do. So the offer and the payment
path come before anything internal.

How we know the season is won: a stranger with no prior tie to Keshav has paid at
least $1,000 in total, the bank deposit matches the payment, and the buyer says the
promised result arrived. That is Keshav's number, since a buyer's choice is
outside the team's control. Everything ranked below is what the team controls.

Two lanes:
- **build lane**: the path is known. The roster takes it (opus 5.5 builds, codex
  reviews), proof attached, merged whole.
- **fable lane**: the path is unknown, or a wrong move costs money or trust.
  Fable 5.5 leads (arrives 2026-10-27), splits the job, hands known-path pieces to
  the build lane, and judges the result. It never grades its own pieces.

### Now (this week: something a stranger can buy)

1. **The offer.** One page: which business, the painful job, the outcome we
   promise, the price, and how they hear about it. Start from what already paid:
   businesses paying thousands for work done, not $30 wishes. Owner: customer
   lead drafts from the partner and invoice records; Keshav sets the price. Done:
   Keshav approves the page, three named target businesses from the partner list
   are attached with why each fits, and the offer's price can be paid through the
   payment path in item 2. Kill: if no job is common to at least two
   past buyers, pick one buyer type and say so.
2. **Paying starts the right work.** The 10-22 trial found the wish page turns any
   typed budget into a charge, shows "your wish is in" even when no checkout
   happened, and after payment runs a fixed starter that never sees the buyer's
   words. The fixes are known: show the minimum, stop the false receipt, carry the
   buyer's words into the job, and have something pick up paid wishes. Owner:
   build lane, Fable reviews. Done: in payment test mode, the validator (not the
   builder) shows a paid wish starts a job holding the buyer's words and that job
   runs to a delivered result; a wish under the minimum, a buyer who leaves
   checkout, and a failed payment each show no receipt and start no job; and a
   repeated payment starts one job. Kill: until all four pass, the wish page takes no money.
3. **A stranger gets a useful answer alone.** A non-engineer, not Keshav and not
   the builder, goes from the offer page to an installed, signed-in orb answering
   one task card written before the run (for example: "read this week's inbox and
   name the three decisions only I can make"). Owner: validator runs it, build lane
   fixes every stuck step. Done: a recording under 15 minutes with no help, plus a
   weekly clean-machine run of the same steps. Kill: if they get stuck twice at the
   same step, fix that step before any page copy.
4. **Put the offer in front of the three businesses.** Owner: customer lead
   writes one note per business in its own words, saved as drafts; Keshav sends
   them, since sending waits on him. Done: three drafts ready in his inbox, each
   naming the job and the price. Kill: if a business has no reachable person,
   swap in the next name from the list.
5. **The desktop app keeps itself current.** Keshav's app sat at 0.1.47 while 0.1.66
   was live, so the Orb tab never appeared. A demo machine on an old app is a lost
   demo. Owner: build lane; fable lane if the cause is not found in a day. Done: an
   old signed build, launched for real, updates to the newest version after one
   restart.
6. **Pick the orb's model.** The orb page lists every model signed in on this
   computer (claude, gpt through codex including terra, the rest of the roster),
   saved per project, opus by default, falls back if the pick fails. Owner: build
   lane, in flight. Done: on npm and visible in the desktop Orb tab, with opus and
   terra timed on 10 real orb questions. Terra becomes the suggested pick only if
   it is faster and a blind judge on a third model prefers or ties its answers on 8
   of 10.

### Keep the floor (small, build lane, this week)

- **Green on the first try.** The orb animation test failed on CI on 10-25 and
  10-26 and passed on rerun. Done: 20 CI runs in a row pass, and the check stays
  as strict. Kill: if the stutter is real on slow machines, fix the animation.
- **The "go bigger" line stops widening exact jobs.** With it, claude passed an
  exact JSON task 5 of 33 times; without it, 10 of 12. Keshav picks the wording.
  Done: that task passes at least 10 of 12, and the four-lines judge still passes.
- **One clean queue.** 20 tasks in review, many of them the same three themes
  filed several times, and 23 open CLI changes, some from September. Done: review
  queue at 5 or fewer, each theme filed once, every change older than 7 days
  merged or closed with a reason.

### Next (the selling machine)

7. **See every loop.** One card on the orb page: every mission and member running,
   what each landed last, what each is stuck on. Owner: build lane. Done: on a
   real night, the card matches the mission log and task list line for line.
8. **A try page for strangers.** Try the orb from a link with no install. The
   mission for it stopped on 10-25. Owner: fable lane (public use on
   subscription-only engines, cost and abuse limits). Done: a stranger's link gets
   a real answer, and a test proves the daily cost cap holds. Kill: if
   subscription-only rules make it impossible, ship a recorded demo and say so.
9. **Finish the proof rule.** It cut hidden test results by more than half, but
   its mock and self-grading parts were never tested. Owner: build lane. Done: 12
   tasks that tempt mocks or self-grading, 48 blind runs per side as before; keep
   each part only if it cuts the bad behavior by at least a third and the pass
   rate is within 2 tasks of 48 of the old rule.

### Later

- Capital: map investors and intros, every no-equity grant and credit, a fund deck.
- Big science: the cancer lab rung (an engine change to beat the ~21% ceiling is
  running now); Fable reviews the result and picks the next rung.
- Joy: music, DJ tools, the artist profile, in their own folders.
- The cloud loop (gate 6), multiplayer, and voice on the orb, once strangers pay.

### The fable queue (for 2026-10-27)

In order. Each ends with pieces handed to the build lane and a result Fable did
not grade alone.

- **F1. Seat Fable 5.5.** The roster already has a fable engine and a "fable" name
  (`lib/engine-registry.js`, spellings in `lib/model-names.js`). On arrival,
  confirm the real model id, point "fable" at it in `lib/model-names.js`, and run
  the member lab head to head against opus 5.5 on the hardest tasks. Done: lab
  numbers attached; Fable keeps the hard-problem seat only if it wins or ties.
- **F2. Review the payment path** (item 2) and design the piece that picks up paid
  wishes so no paid wish waits on a person.
- **F3. A night with no revisions.** The standing goal: overnight work lands itself
  and holds up. Collapse the duplicate "members work for hours" tasks into this.
  Done: one night with at least 10 landings, each with proof, checked by a second
  model and by Keshav, and zero revisions.
- **F4. The try page** (item 8).
- **F5. Desktop updates** (item 5), only if the build lane did not find the cause.
- **F6. The cancer lab next rung**, once the current run reports.

### Waiting on Keshav

- The price on the offer (item 1).
- The wording of the "go bigger" line.
- The research campaign's spending limit: built and waiting for his approval
  (task CLI-1455).
- Allowing remote automation in Safari's developer settings, so desktop Safari can
  be tested.

### Stop doing

- Plan files that compete with this one: `atris/features/endstate/endgame.md`
  (a six-day horizon from April) now opens with a pointer here. The workspace
  `atris/now.md` one folder up (last updated 06-12) needs the same line.
- The old task database on Keshav's Mac (`.atris/state/tasks.db`, last written
  06-28) disagrees with the live task list. The live list wins.
- 102 stopped missions sit in the mission log. Archive them so the loop card
  stays honest.

## The unlock (why the blocks are the whole bet)

The fundamental block is the compiler: manifest in, business capability out
(page + intake + loop + receipts). Once it exists, growth stops being linear
in engineering hours:

- a new business function is a one-page manifest, not a codebase. The suite
  (rainmaker, popshare, aeo, agentgrads, security, data) becomes days of
  writing, not quarters of building.
- 80% of any company is repeatable machinery: funnel, launch, docs, outreach,
  support, billing. Packs compile that 80%, so a founder only has to be right
  about their core 20%. That is the product a founder respects.
- the positioning formula (full pitch: atris/decks/2026-07-09-what-atris-is.md):
  prime intellect's market-maker shape (they sell verified compute, we sell
  verified outcomes) + polsia's promise (runs your company while you sleep,
  made believable by auditable receipts) + cofounder's scope (every
  department) + snapchat's interface (one gesture: a wish).
- we can get data (plain english -> real rows -> living docs, the lakehouse
  feel without a data team) and we can build businesses (the shell in days).
  Both are the same blocks wearing different manifests.
- honesty is the product: every claim traces to a verifier that is not the
  thing that did the work. The pitch that closes: check the receipts yourself;
  if they are empty, stop paying.
- the end state is the outcome economy: anyone with a want meets capacity to
  fulfill it, receipts clear the market. Prime intellect for work itself.

Explosive growth is gated on exactly three proofs, in order: the compiler
works (golden fixture pack), money is verifiable (the till), and one stranger
pays. Everything else on this roadmap is in service of those three.

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


## Leash (current)

Reviewed and green work merges and releases without asking (standing yes from
Keshav, 2026-10-22). Spending, sending to people, and anything public outside npm
still wait for Keshav. Every commit says what changed in plain English.
