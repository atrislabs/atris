# Separate Git store lock review

Verdict: proceed-with-changes. Before any disposal repair, require real-Git
regressions for packed-refs.lock and refs/heads/review.lock in each separate
store. Check these locks before the first deletion, keeping the entire sandbox
and writing no removal record. Keep the unlocked disposal control.

One failure mode: the guard recognizes index and HEAD locks but misses locks
held while Git updates references. Actual disposal deletes both separate stores
with these markers present. This probe models lock files, not a live writer.
No production code changed and no existing user folders were removed.

Flow: disposable Git stores -> one lock marker -> actual disposal ->
whole-folder retention and removal-log observation.

## Real surface proof

Command: `node atris/receipts/work-folder-quarantine-probe.js`
Exit: 0 (reporting mode).
Command: `node atris/receipts/work-folder-quarantine-probe.js --require-protection`
Exit: 1 (expected rejection of the four observed gaps).

```text
quarantine unlocked: removed true, all folders kept false, removal logged true
objects HEAD.lock: removed false, all folders kept true, removal logged false
objects index.lock: removed false, all folders kept true, removal logged false
objects packed-refs.lock: removed true, all folders kept false, removal logged true
objects refs/heads/review.lock: removed true, all folders kept false, removal logged true
quarantine HEAD.lock: removed false, all folders kept true, removal logged false
quarantine index.lock: removed false, all folders kept true, removal logged false
quarantine packed-refs.lock: removed true, all folders kept false, removal logged true
quarantine refs/heads/review.lock: removed true, all folders kept false, removal logged true
review gaps: 4; only disposable fixture repositories touched
```

Files edited: atris/receipts/work-folder-quarantine-probe.js, this receipt,
atris/MAP.md, atris/refs/MAP-NOTES.md, atris/team/architect/logs/2026-10-14.md.
Commands: mission status/goal, boot and activation preview, task list/new/claim/note,
source reads, both real probe modes, readiness check, compile preview,
git diff check, scoped commit and push. Missing optional brain/wiki files were
not created. Prior generated task-view and member-log edits were preserved.

Rerun: `node --test test/worktree-removal-guard.test.js test/member-tidy.test.js`
Readiness executed the required command through the actual receipt writer:
exit 0, `# tests 27`, `# pass 27`, `# fail 0`, `# skipped 0`.
Receipt: atris/runs/2026-10-14-task-afw-25-2026-10-14T16-49-21-555Z.json.
Proof is in review. Brain compile was a preview, exit 2, and wrote nothing.
Delivery: scoped advisory evidence committed and pushed; runtime repair remains
for a builder. No second implementation slice was started.
Metric: seven additional real controls, nine total; four deletion gaps measured.
next_push: build root and nested reference-lock protection before sandbox disposal, with full-retention regressions for both stores.
layer: capabilities
