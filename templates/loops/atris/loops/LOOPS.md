# The Loops

**Boot phrase:** "atris loops" or "run the loops" - audits every loop file live,
routes every open loop back to an owner, and keeps the product improving from proof
instead of memory.

Missions are point-in-time. Loops are forever. A loop owns one thing that must always
work and always improve, names the signal that proves it, and feeds the loops
downstream of it. Every mission dispatched in this project should name the loop it
serves; a mission that serves no loop is probably make-work.

Each loop file follows the same contract, enforced by `atris loops audit`:

- **Owner** - the `team/<member>` accountable for the loop.
- **Wiki** - the knowledge page that keeps the loop context alive across sessions.
- **Runner** - the named thing that executes the signal: script, CI, mission, tick.
- **Protects** - the user-felt thing that must never break.
- **Signal** - the receipt that proves it. Green is an exit code or a number, not vibes.
- **Check** - optional shell command run by `atris loops audit`.
- **Cadence** - when the loop runs: per-commit, per-tick, nightly, weekly.
- **Feeds / Fed by** - the loop graph. No loop is an island.

## The Starter Loops

| # | Loop | Protects | Signal |
|---|------|----------|--------|
| 1 | [feedback](feedback.md) | user pain becomes tracked work | TODO: intake count, queue check, or triage command |
| 2 | [quality](quality.md) | changes do not regress trust | TODO: test, lint, audit, or review gate |

## The Graph

```text
users
  |
  v
[feedback] ---- pain becomes tasks ----+
  |                                    |
  v                                    v
[quality] <--------- fixes, reviews, receipts
```

Reading the graph: feedback is the intake. Quality is the ratchet. Feedback discovers
breaks and turns them into work; quality proves the work made the project tighter.

## Learning Rule

Every error that reaches a loop exits as a dated line in that loop's **Log** before the
work closes. The loop file is the owner member's training data: a class of error is
allowed to happen once per lesson.

## Operating Rule

One tick = run `atris loops audit`, pick the first open loop, run or fix its signal,
re-run the audit, and append a dated Log line with the receipt. When every loop is
green, raise one bar instead of idling.
