# Runnable folder-removal scan review

Builders now have one read-only command reproducing four known source-scan gaps. The probe ran with exit 0; the frozen behavior command passed with exit 0, 23 passed and 0 failed. This is an advisory handoff, not a scanner repair or proof of a current runtime bypass.

## Verdict

Proceed with changes to the scanner repair plan. One risk: source text can hide unguarded deletion and give false assurance. Require the acceptance mode below to pass before relying on broader detection. Keep the real Git and process tests; these six synthetic examples do not prove control flow or exhaustive source coverage.

Plan: actual scanner -> synthetic source -> observations -> repair acceptance.

## Real surface proof

Command: `node atris/receipts/work-folder-scan-probe.js`

Actual output, exit 0:

```text
bare synchronous removal: detected 1, bypasses 1; required 1, 1
guarded synchronous control: detected 1, bypasses 0; required 1, 0
callback removal: detected 0, bypasses 0; required 1, 1
promise removal: detected 0, bypasses 0; required 1, 1
comment-only protection: detected 1, bypasses 0; required 1, 1
multiline generic removal: detected 0, bypasses 0; required 1, 1
review gaps: 4; synthetic source only, no folders removed
```

Command: `node atris/receipts/work-folder-scan-probe.js --require-protection`

Actual output: identical to the preceding block. Exit 1, intentionally rejecting the current four gaps. The acceptance mode must return 0 after repair; default reporting mode is not a protection gate. The tool evaluates the scanner and bypass predicate extracted from the existing test, with a layout check that stops if extraction fails. It never executes the synthetic deletion code.

Command: `node --test test/worktree-removal-guard.test.js test/member-tidy.test.js`

Actual output excerpt, exit 0:

```text
✔ every work folder removal goes through the git check and the removal log (100.498292ms)
ℹ tests 23
ℹ suites 0
ℹ pass 23
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 2876.358834
```

## Artifacts and progress

Files edited: `atris/receipts/work-folder-scan-probe.js`, this receipt, `atris/MAP.md`, `atris/refs/MAP-NOTES.md`, and the ignored local `atris/team/architect/logs/2026-10-14.md`. Existing rendered task changes were left unstaged.

Commands run: brain activation preview (exit 2, no files written), mission status and goal, atris boot, task list/new/claim/note/ready, file reads, both probe modes above, frozen behavior command, brain compile preview, git diff check, scoped git commit and push. No runtime code changed, no mission settings changed, no folders deleted by this review.

Metric: six runnable examples, two controls matched, four known gaps reproduced, 23 behavior tests passing. Prior check-runner unavailability was not reproduced by the direct invocation.

next_push: repair the source scan until all six examples pass acceptance mode, preserving the real Git and process behavior checks.

layer: capabilities
