# Mission

<!-- Human-authored purpose file. Keep this durable; runtime state belongs in .atris/state/*.jsonl and now.md. -->

## North Star

Any agent finds the right file in one hop, and the docs never drift from the code.

## Score

`atris doc-health --json` overall total, higher is better (87.4 on 2026-10-13). It is free, steady, and runs in about a tenth of a second. Wired as the gate: `atris member score launcher --gate` (1 run, 0.5% margin, since the number does not drift).

## One Tick

Pick the worst doc-health line, such as moved refs, boot size, or a stale feature. Fix that one thing and re-run doc-health to show the number moved.

## Stop

Stop when a fix would only game the score, such as deleting refs instead of correcting them.
