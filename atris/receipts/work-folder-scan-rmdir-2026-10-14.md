# Older directory deletes are checked

The removal scan now catches recursive rmdir calls. The required tests passed: 24 pass, 0 fail, exit 0.

Scope: finish the interrupted prior attempt, retaining its regex changes and adding four saved probe cases. No production deletion code changed; synthetic delete calls were read as text, never executed.

Files edited: `test/worktree-removal-guard.test.js`, `atris/receipts/work-folder-scan-probe.js`, `atris/MAP.md`, `atris/refs/MAP-NOTES.md`, this receipt, and `atris/team/architect/logs/2026-10-14.md`. The pre-existing rendered TODO change is left unstaged.

Plan: inherited scan -> four source examples -> old/new comparison -> required tests -> proof saved.

Real changed-surface invocation:

```sh
node atris/receipts/work-folder-scan-probe.js --require-protection
```

Output excerpt, exit 0:

```text
older synchronous directory removal: detected 1, bypasses 1; required 1, 1
older callback directory removal: detected 1, bypasses 1; required 1, 1
older promise directory removal: detected 1, bypasses 1; required 1, 1
older multiline generic directory removal: detected 1, bypasses 1; required 1, 1
review gaps: 0; synthetic source only, no folders removed
```

Before/after proof: loaded the scanner from `git show HEAD:test/worktree-removal-guard.test.js` and the current file into a Node VM, then ran the saved probe against each. Old scan: four gaps, all four older directory cases detected 0. New scan: zero gaps. Real source removal count was 17 in both scans; no existing allowance grew.

Required rerunnable check:

```sh
node --test test/worktree-removal-guard.test.js test/member-tidy.test.js
```

Exact final output, exit 0:

```text
ℹ tests 24
ℹ suites 0
ℹ pass 24
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 2711.29775
```

Other commands: mission status, mission goal, task list/create/claim/note, git status/diff/log/remote, brain activate and compile. Both brain commands returned exit 2 with a plan-only response requiring --yes; no generated policy files were overwritten.

Learned: an interrupted scan repair can look complete while lacking persistent cases. Pair the inherited change with old/new evidence before treating it as proven.

Stop: one bounded slice proved; no second slice started. Mission remains running.

next_push: make the frozen removal test run the saved scanner probe so missed source patterns fail the normal test command.

layer: capabilities
