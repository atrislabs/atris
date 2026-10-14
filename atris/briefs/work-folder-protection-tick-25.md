# Work-folder protection: local proof recovery

The required protection checks passed locally: 23 passed, 0 failed, exit 0.
No runtime code changed.

## Finding
The mission's previous blocked record says the engine verification pass was
unavailable. The supplied failure excerpt contains passing tests and zero
failures. This direct run supplies local proof, but does not establish that
the engine verification service has recovered or change its saved state.

## Files
- atris/briefs/work-folder-protection-tick-25.md: this receipt and exact output.
- atris/team/architect/logs/2026-10-14.md: action, learning and next move.
The preexisting change to atris/TODO.md is left out of the commit.

## Invocation
`node --test test/worktree-removal-guard.test.js test/member-tidy.test.js`

Exit code: 0

```text
✔ tidy removes landed clean copies and leaves everything else to git and the rules (1015.421666ms)
✔ tidy asks origin for its current default branch instead of the stale local note (540.250792ms)
✔ tidy keeps every copy when the running-program scan fails (612.566959ms)
✔ tidy keeps every copy when origin cannot be fetched (378.8565ms)
✔ tidy keeps a landed copy while git is paused mid-rebase in it, and logs what it removes (474.975833ms)
✔ reap keeps a folder a run is working in, even with --force (130.244042ms)
✔ reap sees a real live process in the folder without being told (277.141125ms)
✔ reap names who removed a folder and why (158.9765ms)
✔ reap summary counts folders removed today and by whom (88.91175ms)
✔ worktree cleanup names who removed a folder and why (128.2605ms)
✔ reap keeps a folder while git holds its lock, even with --force (132.694916ms)
✔ worktree cleanup keeps a clean folder paused mid-rebase (99.412792ms)
✔ fleet review cleanup keeps a sandbox while git holds its lock (81.875708ms)
✔ fleet review cleanup names who removed a sandbox and why (86.9535ms)
✔ autopilot regression check keeps its folder while git holds its lock (115.070125ms)
✔ autopilot regression check keeps its folder while a run is inside it (108.14125ms)
✔ autopilot regression check sees a real leftover process without being told (267.307625ms)
✔ autopilot regression check names who removed its folder and why (124.977042ms)
✔ autopilot regression check keeps an existing clean folder when creation fails (124.177584ms)
✔ autopilot regression check keeps an existing dirty folder when creation fails (126.874958ms)
✔ every work folder removal goes through the git check and the removal log (48.590291ms)
✔ green landing keeps its scratch folder while a test is still running in it (87.083208ms)
✔ green landing names who removed its scratch folder and why (96.976833ms)
ℹ tests 23
ℹ suites 0
ℹ pass 23
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 3120.01275
```

## Scope
These tests invoke the real folder-removal helpers, real git repositories and
live processes. No CLI behavior was changed in this increment.
The source scan remains a heuristic, not proof of control flow.

State inspected with `git status --short`,
`atris mission status mission-2026-10-14-finish-work-folder-protectio-35ad161f`,
`atris task list`, `atris task show AFW-3` and `atris mission goal --json`.
The startup brain command offered a plan rather than activating missing files;
no generated policy changes were made.

Progress: one fresh local proof recorded; 23 passing checks, zero failures.
Stop: the single verification step passed; no second slice was started.
next_push: reproduce the unavailable engine verification pass with a read-only diagnostic and record its concrete failure before changing any runner behavior.
layer: beliefs

