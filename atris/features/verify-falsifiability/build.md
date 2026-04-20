# verify-falsifiability — Build Plan

> Executed 2026-04-19. Recorded retrospectively.

## Files touched

**Modified:**
- `commands/autopilot.js` — added falsifiability gate in `runTaskOnce` (before the phase loop). Runs Verify pre-execute for endgame + explicit-Verify tasks; halts with `verify-not-falsifiable` on pre-pass; proceeds on pre-fail. Verify cmd snapshotted for post-execute reuse.
- `commands/verify.js` — added `verifyRubric(slug, section, opts)`. Extracts first fenced `bash|sh` block under `## <section>` in `atris/features/<slug>/validate.md`, writes to tmp, executes, returns exit code.
- `bin/atris.js` — route `atris verify <slug> --section <name>` to `verifyRubric`. Preserves existing `atris verify` and `atris verify <task-id>` paths.
- `atris.md` — one line added to the task-shape section: Verify must be a falsifiable rubric or test, not a raw shell shortcut. Prefer `atris verify <slug> --section <name>`. Rubric is read-only, deterministic, references only the working tree.

**Created:**
- `test/autopilot-verify-falsifiability.test.js` — 8 tests covering the falsifiability gate and rubric extraction
- `atris/features/verify-falsifiability/idea.md` — this feature
- `atris/features/verify-falsifiability/build.md` — this file
- `atris/features/verify-falsifiability/validate.md` — runnable rubric

## Build steps

1. **Plan double-check.** Sent the draft spec to the Plan agent as an independent second signer. It caught 5 holes: wrong tag parsing (`task.tags` is an array, not a string match), reactive tasks would halt 80% of traffic at t=0, need to snapshot the cmd, trivial vs already-satisfied should be distinguished, need a `[refactor]` tag for behavior-preserving changes. Revised the plan; the user-level reviewer approved the revision and added the one-line atris.md constraint.

2. **`verifyRubric` first.** Built the extraction + exec command before wiring it into autopilot, so the Verify field can actually point somewhere. Uses a regex anchored on `## <section>` that skips intervening prose and captures the first fenced bash/sh block. Writes to an OS tmpfile with `set -e`, executes via `bash`, returns the exit code. Cleans up the tmpfile in a `finally`.

3. **Router.** `bin/atris.js` picks up `--section` flag. If present, routes to `verifyRubric`; otherwise preserves the old `verifyAtris` path so `atris verify` and `atris verify <task-id>` still work.

4. **Falsifiability gate.** Added to `runTaskOnce` in `commands/autopilot.js`, directly after the existing no-verify-field guard and before the plan/do/review loop. Guarded by `context.kind === 'endgame' && verifyResult.explicit`. Runs `execSync(verifyCmd, { timeout: 60000 })`. On success: writes `verify-not-falsifiable` lesson, halts. On throw: proceeds as normal. The cmd captured in `verifyCmd` is reused by the existing post-execute verify block unchanged.

5. **Test harness.** Eight node:test cases in isolated tmp dirs. Three halt cases, two proceed cases, three `verifyRubric` cases. Each fixture writes its own `TODO.md` and `lessons.md`. Proceed cases assert that the halt reason is anything *other than* `verify-not-falsifiable` — the gate let the tick through, subsequent failures (no claude CLI) are out of scope for this test.

6. **Self-rubric.** This feature's `validate.md#preflight` runs the full test file. That makes the feature self-verifying: `atris verify verify-falsifiability --section preflight` exits 0 iff the gate is live and correct.

## Testing strategy

`node --test test/autopilot-verify-falsifiability.test.js` — 8 tests.

```
✔ trivial Verify (true) halts with verify-not-falsifiable
✔ trivial Verify (echo ok) halts with verify-not-falsifiable
✔ non-falsifiable Verify via test -f on existing file halts
✔ falsifiable Verify (test -f missing file) would proceed past gate
✔ non-endgame task is exempt from the gate
✔ verifyRubric extracts and runs a passing fenced bash block
✔ verifyRubric returns non-zero when the rubric script fails
✔ verifyRubric returns 2 when the section is missing
```

Two of the "proceed past gate" tests run for ~95s each because `runTaskOnce` tries to spawn `claude -p` and times out. Correct behavior, slow test. Acceptable for now; can add a stub phase-executor via DI later.

## Error cases

- **Rubric missing:** `verifyRubric` returns 2, prints `✗ No rubric at <path>`. The autopilot gate treats this as "no explicit Verify" and applies the existing no-verify-field halt.
- **Section missing:** `verifyRubric` returns 2, prints `✗ No fenced bash block under "## <section>"`. Same handling.
- **Rubric hangs:** `execSync` has a 60s timeout. Worth tightening to 10s with explicit documentation of the limit — open item.
- **Judge integrity failure:** `verifyJudgeIntegrity()` already halts before the gate runs. Tamper protection unchanged.

## Dependencies

None new. Uses `child_process.spawnSync` (already imported), `fs`, `path`, `os` — all Node built-ins.

## Rollback plan

`git revert <sha>` reverts the full change. The test file can be deleted independently. No external state, no database, no schema. The falsifiability gate is a read-only check on existing commands; removing it returns the system to pre-M1 behavior.

## Notes for future agents

- If you add a new `context.kind`, decide whether it should be subject to the gate. Reactive kinds (inbox, staleness, imagined) are exempt because their default Verify (`npm test`) passes at t=0 in any healthy repo.
- The gate exists because a trivial Verify poisons the reward signal. Don't loosen it without replacing the protection. If a specific use case needs the gate bypassed, add the `skipFalsifiability: true` option to `runTaskOnce`; don't add a `tier` exemption.
- `validate.md#preflight` is the canonical section name for the machine-checkable rubric. Other sections can carry prose checks for human reviewers. The preflight is what the Verify field should point at.
