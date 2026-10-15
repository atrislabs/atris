The slowest command check, which proves the review chat lists only commands named in the proof, dropped from about 3.33s to 2.85s; it passed three runs, a planted change to one landing sentence failed it, and the 35 required checks passed, exit 0.

Files edited: test/commands.test.js; atris/refs/MAP-NOTES.md; atris/team/auto-improver/logs/2026-10-14.md; atris/team/auto-improver/receipts/2026-10-14-review-chat-landing-cases-in-process.md.

Rerunnable verification command:
`PATH="/opt/homebrew/bin:$PATH" node --test --test-name-pattern='^task review-chat extracts only proof-derived verifier commands$' test/commands.test.js && node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js`

Ran bare. Actual output excerpt:
```text
✔ task review-chat extracts only proof-derived verifier commands (2855.354292ms)
✔ task review-chat extracts only proof-derived verifier commands (2857.858375ms)
✔ task review-chat extracts only proof-derived verifier commands (2838.697334ms)
verifier_exit=0
ℹ tests 35
ℹ pass 35
ℹ fail 0
map refs: 1115 right, 0 moved, 3 unclear, 0 gone
```

Confirmed first: when ready gets only a proof, the "checked" and "tested" sentences it writes come from that proof alone. Explicit values would win, but these cases pass none.

Change: four cases ran ready only to read one of those sentences. They now call the same sentence builder in the test process. A case that still runs ready for real, and reads both sentences, now also asserts the in-process builder gives the same two sentences. Four fewer launches.

Cost: the four converted proofs no longer pass through ready's own gates; other checks cover those gates, and the kept case would catch ready and the builder drifting apart.

Proof the check still bites: the receipt sentence in the builder was changed to a different wording. The check failed on exactly that case. The source was restored from git and checked clean.

Metric: three runs before with plain git first: 3315ms, 3323ms, 3348ms. Three runs after: 2855ms, 2858ms, 2839ms. With the mission git wrapper first on the path, the same check took about 6.9s before; that path is slower for every git call.

Map refs: the edit moved lines by different amounts in three places. 100 refs were shifted by content match, then all 148 refs were cross-checked against the shift their position implies, with 0 mismatches.

next_push: Take the second slowest command check, ready holds work until a human accepts (2.62s), count its command launches, and move the ones that only read saved state to the task store.
layer: capabilities
