# The safety scan checks the deleted folder, not just the helper names

The folder safety scan now accepts a deletion only when the git check and the removal log name the folder being deleted. Before this change, any function that mentioned both helpers passed, even if they pointed at a different folder.

What changed in the scan:
- Each deletion's target folder is read from the call: the first argument of a delete, the last path in a git removal list (including paths pushed onto a named list), or the folder inside a typed shell command.
- A name made with path.resolve or realpath of another name counts as the same folder. Any other mismatch, or a target the scan cannot read, is a gap.
- The review sandbox cleanup is a named group with a pinned count of five deletes. It must check the work folder and both git stores, and its log must name the work folder.
- The path-binding probe now has an acceptance mode and runs in the required checks.

No production code changed. All six guarded real cleanups bind cleanly: green landing, member tidy, regression check, land reap, worktree cleanup, and the sandbox group.

## Proof

`node atris/receipts/work-folder-scan-binding-probe.js --require-protection`, exit 0:
```text
matching folder control: detected 1, bypasses 0; required 1, 0
resolved same folder control: detected 1, bypasses 0; required 1, 0
unrelated folder guard: detected 1, bypasses 1; required 1, 1
unrelated folder log: detected 1, bypasses 1; required 1, 1
unrelated folder protection: detected 1, bypasses 1; required 1, 1
review gaps: 0; synthetic source only, never executed
```
Before this change the same three mismatch cases reported zero bypasses.

Real-source mutation: pointed the green landing git check at the project folder instead of the scratch folder, ran the scan, then restored the file with git.
```text
mutated exit 1
  +   'lib/land-green.js:dropScratch (line 200)',
  +   'lib/land-green.js:dropScratch (line 201)'
restored
```
The old scan would have passed this, since both helper names were still present.

Saved examples and group probes, both with `--require-protection`, exit 0: `review gaps: 0` and `group: 4 recursive targets; 0 missing from scan`.

Required check: `node --test test/worktree-removal-guard.test.js test/member-tidy.test.js`, exit 0:
```text
ℹ tests 27
ℹ pass 27
ℹ fail 0
```

Files edited: `test/worktree-removal-guard.test.js`, `atris/receipts/work-folder-scan-binding-probe.js`, `atris/receipts/work-folder-scan-probe.js`, `atris/MAP.md`, `atris/refs/MAP-NOTES.md`, this receipt, `atris/team/architect/logs/2026-10-14.md`.

Remaining risk: matching names is a source check, not proof of order. The real lock and process tests still carry that.

next_push: require the git check to come before the delete in source order, so a check written after the deletion stops counting.

layer: capabilities
