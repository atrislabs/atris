The headless task contract check dropped from about 2.50s to 1.87s by running its last eight read-only commands at the same time; it passed five runs in a row, a planted bug in the event order failed it, and the 35 required checks passed, exit 0.

Files edited: test/commands.test.js; atris/refs/MAP-NOTES.md; atris/team/auto-improver/logs/2026-10-14.md; atris/team/auto-improver/receipts/2026-10-14-headless-contract-read-only-tail-concurrent.md.

Rerunnable verification command:
`PATH="/opt/homebrew/bin:$PATH" node --test --test-name-pattern='^task headless JSON contract supports create, claim, note, finish, and events$' test/commands.test.js && node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js`

Ran bare. Actual output excerpt:
```text
✔ task headless JSON contract supports create, claim, note, finish, and events (1858.171333ms)
✔ task headless JSON contract supports create, claim, note, finish, and events (1912.855625ms)
✔ task headless JSON contract supports create, claim, note, finish, and events (1865.208667ms)
✔ task headless JSON contract supports create, claim, note, finish, and events (1855.530125ms)
✔ task headless JSON contract supports create, claim, note, finish, and events (1853.195459ms)
verifier_exit=0
ℹ tests 35
ℹ pass 35
ℹ fail 0
map refs: 1115 right, 0 moved, 3 unclear, 0 gone
```

Why not the task store: this check is the command contract. Of its 23 launches, every one but the first claim asserts that command's own output, so moving them to the store would remove what the check exists to test. Nothing moved to the store.

Change: the last eight launches (the event list, where the task store lives, two unknown commands, two missing titles, a missing claim id, and a missing task) start after every write is done, and all eight now run at once with the existing concurrent runner. Every assertion is unchanged.

Why it is safe: on a scratch workspace, those eight commands left the task store unchanged in task count, last update time, and event count. The only file they touch is the usage log, which each command appends one line to inside a guard that can never fail the command. The task store also waits up to 30 seconds on a lock and retries, so overlapping reads cannot error out.

Proof the check still bites: the event list was patched to come back newest first. The check failed. The source was restored from git and checked clean.

Metric: three runs before with plain git first: 2460ms, 2517ms, 2513ms. Five runs after: 1858ms, 1913ms, 1865ms, 1856ms, 1853ms.

Map refs: 62 refs below the edit shifted by 3, each matched by line content, 0 mismatches.

next_push: Take the task factory API check (2.55s), count its command launches and server waits, and cut the ones that only seed or read saved state.
layer: capabilities
