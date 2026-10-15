The whole command test file now runs in 160.5s, down from 186.2s at the last full timing; all 437 checks passed, exit 0, with plain git first on the path.

Files edited: atris/team/auto-improver/logs/2026-10-14.md; atris/team/auto-improver/receipts/2026-10-14-command-tests-retime-after-setup-cuts.md. No code or test changed this tick.

Rerunnable verification command:
`PATH="/opt/homebrew/bin:$PATH" node --test test/commands.test.js && node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js`

Ran bare. Actual output excerpt:
```text
exit=0 secs=161
ℹ tests 437
ℹ pass 437
ℹ fail 0
ℹ duration_ms 160473.128667
```

Slowest checks now:
```text
  3.18s  task review-chat extracts only proof-derived verifier commands
  2.62s  task ready holds work in review until human accept
  2.60s  task current-step advances the scoped current task one safe action
  2.59s  task headless JSON contract supports create, claim, note, finish, and events
  2.55s  task serve exposes a local task factory API
  2.48s  task backlog and clear-plan demote only planned open tasks
  1.99s  task review-lane-act executes only safe drain actions and supports dry-run
  1.99s  task plan and do record an explicit headless stage contract
```

Why plain git first: a mission git wrapper sits first on the path in this checkout, and every git call in a test goes through it. Earlier full timings put plain git first, so this one does too, to compare like with like.

What the slowest check still launches: 22 command runs. Four of them run ready only to read the sentences it writes about how the work was checked, and two more read those sentences next to the command list. Those sentences come from a builder the task command already shares, so the next cut needs no new export. Not done this tick: first confirm ready passes nothing but the proof into that builder for these cases.

Metric: whole file 186.2s to 160.5s across the setup and launch cuts since the last timing. Run-to-run noise on this file has been a few seconds, so treat the gap as roughly 25s, not exact.

next_push: Move the four ready-only landing sentence cases in the slowest check to the shared builder, after confirming ready feeds it only the proof; keep one case on the real command to prove they match.
layer: capabilities
