# Bind protection to the removed folder

Verdict: proceed-with-changes. The single failure mode is false certification: function-wide helper names accept deletion of a folder that was neither checked nor logged. Independently mismatching either path reproduces this weakness. This is a source-check weakness, not evidence of a live unsafe deletion.

Plan: removal target -> matching guard argument -> matching log path -> accept.

For the next bounded repair, retain each detected removal's call text and extract the deleted path expression. For ordinary removals, require the same expression in `worktreeGitActivity(...)` and the `path` property of `recordWorktreeRemoval(...)`. Normalize whitespace only; unresolved aliases or computed expressions must report a review gap rather than count helper-name presence as protection. Matching text is a structural check, not proof of execution order; keep the real lock/process tests.

Safeguard: do not apply the ordinary-path rule blindly to `lib/fleet.js:disposeReviewSandbox`. It checks the work folder plus two Git stores before any deletion and records the group under `boundary.worktreePath`. Preserve this as one explicit, count-checked group contract: require that work-folder check, both store checks, and the parent log. Keep the real quarantine-lock regression. Do not add a blanket function exemption or widen the existing exemption counts.

Acceptance for the repair: matching control stays protected; wrong guard alone, wrong log alone, and both wrong paths each report one bypass. All sixteen saved removal-form examples and the required tests must pass. Wire the binding probe into the required check only once it reports zero gaps in acceptance mode. No production cleanup refactor is needed for this slice.

Changed surface: `node atris/receipts/work-folder-scan-binding-probe.js`
Exit code: 0. Actual output:
```text
matching folder control: detected 1, bypasses 0; required 1, 0
unrelated folder guard: detected 1, bypasses 0; required 1, 1
unrelated folder log: detected 1, bypasses 0; required 1, 1
unrelated folder protection: detected 1, bypasses 0; required 1, 1
review gaps: 3; advisory only, synthetic source never executed
```
Advisory exit zero means the probe ran, not that protection is repaired.

Files edited: `atris/receipts/work-folder-scan-binding-probe.js`, `atris/MAP.md`, `atris/refs/MAP-NOTES.md`, this receipt, and `atris/team/architect/logs/2026-10-14.md`.

Rerunnable verification: `node --test test/worktree-removal-guard.test.js test/member-tidy.test.js`
Exit code: 0. Actual output excerpt:
```text
ℹ tests 25
ℹ suites 0
ℹ pass 25
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 2579.035
```

Progress: four saved comparisons instead of two; three measured false-certification cases instead of one. No production behavior changed.

next_push: bind ordinary removal targets to their guard and log paths, with an explicit grouped sandbox contract.

layer: capabilities
