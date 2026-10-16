# A campaign is a promise to check again

Conclusion of 2026-10-16, from two independent reviews (Astra via Codex, Argon via Cursor) that reached the same idea.

A campaign is not a loop that has to stay alive. It is a saved promise: every tick does at most one step of work, then saves its next move (work, wait, or done) and exits. A plain timer wakes due campaigns. Day four is just another tick.

## The three gaps it closes

1. **Stalls when blocked.** An open question blocks only the work that needs its answer. When nothing can move the check (a payment, a person), the tick saves a wait and exits: no planning, no round, no lesson.
2. **Nothing keeps it alive.** The promise lives in the store, not in a process. `atris campaign wake` ticks every due campaign; `atris campaign keep --install` puts that on a one-minute timer (launchd on macOS, cron on Linux, which covers the cloud computer). A killed process loses nothing.
3. **Dishonest record.** A job that never ran is a fault with its reason, not failed work. Credit goes to what moved the check: when the judge passes or its reading improves, the jobs that ended since the last reading are credited.

## The loop, after

`makeLoop(root, options, deps).tick(id)`, with `deps.now()` as the clock:

1. If the saved next move is a wait and it is not due (time not reached, no new answer), return at once. No judge, no planner, no job.
2. If a wait is due: run the judge only. Same reading as before, wait again with the delay doubled (10, 20, 40, then 60 minutes). Changed reading or a new answer: plan again.
3. Otherwise take one step as today (judge, start missions, or propose), then save `next_move { action, wake_at, until, reason }` as an event. The campaign view shows it as `view.next_move`.
4. An empty plan saves a wait. It is never recorded as a failed mission.
5. A mission run that left no step behind ended before doing anything: record outcome `fault` with the last line of its output as the reason.
6. A round review asks a model for lessons only when some job ended that round.

## Refused

A daemon or queue server, a second planning layer, automatic answers to a person's question, an LLM grader for missions, and claims of work while the computer is off. Files, a one-minute timer, and the judge are enough.

## The proof

Judge: `~/.atris/campaign-judges/promise.cjs` (8 promises, fake clock, no model calls). Then one real campaign held only by `keep --install` for days.
