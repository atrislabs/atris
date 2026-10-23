# Local research budget ceiling, independent test witness

owned_by: validator
executed_by: codex
independent: true
decision: pass
scope: requested CLI regression checks and focused contract inspection only

Read AGENTS.md, the campaign build document's current October 22 contract,
the campaign idea's history/accounting principles, the complete finished diff
and the new budget-limit tests. The reviewer did not implement or repair this
change. Opus source review is a separate required verdict; this receipt does
not substitute for it or approve installation, applying a real ceiling,
research execution or cloud changes.

## Independently executed commands and actual results

From the isolated CLI repository, run bare without pipes:

```bash
node --test test/campaign-budget-limit.test.js test/campaign-command.test.js test/campaign-core.test.js test/campaign-schema.test.js test/campaign-store.test.js test/campaign-missions.test.js test/campaign-sync.test.js test/campaign-loop.test.js test/campaign-schedule.test.js test/campaign-wake.test.js
```

Exit 0: 169 tests passed, zero failures, skips, cancellations or todo,
2936.457958 milliseconds. Includes all 15 new budget-limit regressions.

```bash
node scripts/campaign-conformance.js --only cli --json
```

Exit 0: passed true, CLI only, all 21 golden files and all 14 decision
cases matched, no manifest problems or mismatches. Other surfaces were not run.

```bash
git diff --check
```

Exit 0, no whitespace errors. Status after checks retained the original six
tracked changed files and the single new regression file; no test-created
tracked or untracked artifact remained.

## Contract and regression inspection

The tests exercise real SQLite and memory stores, and a disposable real CLI
process across restarts. They check append-only history, recorded spend and
reservations, pause preservation, whole-cent input, refusing increases and
below-commitment limits, unchanged --add behavior, raw event guard, current
reservation and cloud-link checks at append time, updated admission and
exhaustion, and refusal of cloud sync before credentials/network access.
The real admission refusal verifies no mission file was created. A judge
runs only while constructing disposable test fixtures, never to set a ceiling.

Direct inspection confirms the CLI validates the new limit inside the existing
append transaction. The SQLite store acquires its write transaction before
folding/checking current state and inserting the event. The pure fold retains
commitments and warns without applying an invalid increase or reduction.
Schema validation rejects invalid raw amounts. The sync guard runs before
credentials/network work and rechecks after saving link metadata. Existing
golden behavior and --add remain intact in the requested tests.

No material bug found in this bounded inspection. Concurrency regressions
inject the competing reservation/link immediately before append; they are
not a new multi-process stress test for this feature. The existing store suite
does exercise concurrent process writes. Passing CLI conformance preserves
existing golden fixtures; it does not establish support for this new local
extension in older CLI, cloud, desktop or web readers.

## Reviewed artifact identity

Tracked patch SHA-256, from git diff --binary | shasum -a 256:
8e43fac336ed08bfbd935fef8c23d4a97fbef7e38aca21e8c332acd2c3e982dd

Untracked test/campaign-budget-limit.test.js SHA-256:
5164a1ada4326a10c57531f676fc2e5ce0d6f626fe5aafd5b11baa7f23712103

## Remaining limits and handoff

This is an accounting ceiling for recorded campaign mission costs, not a
universal provider spending circuit breaker. Existing work can report higher
actual cost, direct paid training is outside this meter, and old readers
cannot consume the new event. No real campaign budget was modified and no
research, provider call, cloud write or landing action ran during this review.

Final decision: pass for the requested independent test witness. The owner
must also obtain the separate Opus verdict before proceeding.
