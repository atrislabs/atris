# For you

## Decide: make the mission git wrapper fast for non-commit calls
- found: during mission runs, every git call goes through a Node wrapper that only inspects commits. Each call costs about 85ms instead of about 4ms, and the slowest test drops from 6.1s to 1.7s without it. The full commands test file runs 3m52s with it and 2m25s without it.
- proof: atris/receipts/2026-10-14-mission-git-wrapper-cost.md, with the timings and the exact commands.
- options: (a) write the wrapper as a short shell script that hands non-commit calls straight to real git and runs the Node guard only for commits; (b) leave it, and accept that mission-run test timings are inflated about fourfold for Git-heavy tests.
- why a card: the wrapper enforces which commits a mission may land, so changing it is not self-landed, and this mission's own commits pass through it.
- reply: a / b
