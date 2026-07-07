# The Loop System - how this project improves itself

A loop owns one user-felt thing that must never break, names the receipt that proves it,
has a team member accountable for it, and feeds the loops downstream. Missions are
point-in-time; loops are forever. Source of truth: `atris/loops/LOOPS.md`.

## The Closure Contract

A loop is **closed** when all five hold; a project where every loop is closed is
**self-improving**: breaks discover themselves, route to an owner, and land as fixes
without waiting for a human to notice first.

1. **Owner** - a `team/<member>/` directory exists. Someone wakes for it.
2. **Wiki** - a knowledge page resolves, so context survives sessions.
3. **Runner** - the named thing executes the signal: script, CI job, mission, or tick.
4. **Signal** - green is an exit code or number, never vibes.
5. **Fresh log** - a dated receipt in the loop file is newer than 14 days.

`atris loops audit` enforces this contract and prints the self-improving verdict. If a
loop file has `**Check:** \`<command>\``, the audit runs that command from the project
root and reports its exit code.

## Starter Owner Map

| # | Loop | Owner | Runner class |
|---|------|-------|--------------|
| 1 | feedback | TODO-feedback-owner | TODO intake command, mission, or wake tick |
| 2 | quality | TODO-quality-owner | TODO test, audit, review lane, or CI job |

## Known Open Edges

- Replace TODO owners with real `team/<member>/` directories.
- Replace TODO runners with real commands or missions.
- Replace `true` starter checks with project-native proof commands.
- Add loops only when they protect a real user-felt thing.

## Learning Rule

An error closes only by becoming a dated Log line in its owning loop, with a receipt.
Members wake with their loop file, this wiki, and recent receipts in context. Each
lesson removes a class of error; the loop audit makes the next tick cheap.
