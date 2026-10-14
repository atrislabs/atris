Landing task setup now uses real SQLite creation and claim operations for repeated fixtures. Two sequential changed runs of `node --test test/autoland.test.js` passed all 68 tests, with no failures, cancellations or skips, exit 0.

Files edited: `test/autoland.test.js`, `atris/MAP.md`, `atris/refs/MAP-NOTES.md`, `atris/team/auto-improver/logs/2026-10-14.md`, `atris/status/for-you.md`, and this receipt. Only one test file changed; the pre-existing rendered `atris/TODO.md` change is excluded.

Root cause: 18 certification fixture tasks repeated 36 CLI creation/claim startups. One complete CLI new/claim flow is retained per helper (proof and verify), reducing these startups to four. The other 16 tasks use the actual task store with independent SQLite databases and resolved workspace roots. Each seeded row checks title, tag, workspace, claimed status, builder identity and created/claimed event order. Both ready passes, every verifier, every landing command and all original test assertions remain unchanged. No mocks or dependencies added.

Plan: time -> real task-store fixture setup -> keep CLI certification -> repeat full-file proof.

Progress: baseline 52123.9345 and 45204.739875 ms; after 43749.922417 and 36096.4225 ms. Mean before 48664.3371875 ms, mean after 39923.1724585 ms, approximately 18% faster. All four sequential runs passed 68/68; two repeats per version found no flakiness. Shared machine load varies; these are observed timings, not a fixed speed guarantee.

Rerun command: `node --test test/autoland.test.js`. Frozen check: `git diff --check`.

Commands run: mission status and goal, git status, task list/new/claim/note, brain activate/compile (exit 2, plan-only, no generated policy edits), four sequential full test invocations, and git diff --check. Final shipping uses explicit git add, git commit and git push; task proof is moved to Review without self-acceptance.

before 1:
```text
$ node --test test/autoland.test.js
ℹ tests 68
ℹ suites 0
ℹ pass 68
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 52123.9345
exit code: 0
```

before 2:
```text
$ node --test test/autoland.test.js
ℹ tests 68
ℹ suites 0
ℹ pass 68
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 45204.739875
exit code: 0
```

after 1:
```text
$ node --test test/autoland.test.js
ℹ tests 68
ℹ suites 0
ℹ pass 68
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 43749.922417
exit code: 0
```

after 2:
```text
$ node --test test/autoland.test.js
ℹ tests 68
ℹ suites 0
ℹ pass 68
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 36096.4225
exit code: 0
```

```text
$ git diff --check
(no output)
exit code: 0
```

Raw captured outputs: `/tmp/atris-tick13-before2.txt`, `/tmp/atris-tick13-after1.txt`, `/tmp/atris-tick13-after2.txt`; the first baseline was returned directly by the command runner.

next_push: Time the auto-accept certification test file repeatedly and identify its largest avoidable setup or wait cost.
layer: capabilities
