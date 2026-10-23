# Overnight run, 2026-10-23: can the system improve its own instructions?

## What ran

A scanner made one small deliberate break at a time in the code (for example a `<` turned into `<=`) and kept only the breaks that every existing test missed. Each kept break became a job: write a test that passes on the real code and fails on the broken line.

Fast agents (Codex, Gemini, Devin; Claude and Grok until they ran out of quota) took one job each. A strict check judged every test: it had to pass twice, in time zones a day apart, with an empty environment, and fail once the line was broken. A reviewer from a different AI then read each kept test blind and dropped weak ones.

Between rounds, a coach rewrote the agents' instructions from that round's misses and drops. Each round split its jobs between the newest instructions and the current leader, so every comparison is on the same mix of work. The check and the reviewers never changed.

## Results

Head to head, same round, newer version against the version it faced:

| round | newer | kept | older | kept | result |
|---|---|---|---|---|---|
| 6 | v2 | 77% | v1 | 65% | won |
| 7 | v3 | 88% | v2 | 74% | won |
| 8 | v4 | 72% | v3 | 82% | lost, set aside |
| 9 | v5 | 84% | v3 | 82% | won |
| 10 | v6 | 81% | v5 | 75% | won |
| 11 | v7 | 72% | v6 | 77% | lost, set aside |
| 12 | v8 | 74% | v6 | 69% | won |
| 13 | v9 | 67% | v8 | 74% | lost, set aside |
| 14 | v10 | 81% | v8 | 84% | lost, set aside |
| 15 | v11 | 83% | v8 | 63% | won |
| 16 | v12 | 77% | v11 | 65% | won |

The newer version won 7 of 11. Pooled across those rounds: newer 78%, older 74%.

The final exam (round 17) put the last leader, v12, against the first instructions, v1, on 128 fresh jobs: **both kept 62%.** v12's tests were cleaner (reviewers dropped 21% of them against 29% of v1's), but v1 got more tests through the check, so they came out even.

## What this shows

Each step looked like a gain, but each comparison was about 48 jobs a side, and always keeping the winner of a noisy comparison overstates the gain. The direct test against the starting point shows no net improvement on this task. Rewriting instructions alone did not make the agents better at it.

What did hold up: 1,017 tests that each catch a break no earlier test caught, on master after review; a loop that ran for hours, set aside every losing version on its own, and caught its own failures (a usage limit that skipped reviews, tests that only passed on this Mac, flaky checks); and a final exam honest enough to catch the overstated story before it was posted.

## Receipts

`rounds.jsonl` (every score), `ledger.jsonl` (every job), `receipts/` (drops per round, coach evidence), `prompts/` (kept versions), `prompts/rejected/` (versions that lost), `prompts/untested/` (written after the last round, never scored).
