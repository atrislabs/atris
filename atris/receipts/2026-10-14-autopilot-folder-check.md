# Regression folder cleanup

Automatic cleanup now preserves folders with Git activity and records successful removals. The required tests and a real cleanup invocation both exited 0.

Plan: created folder -> running program and Git lock checks -> keep with reason or remove and log.

Changed files: `commands/autopilot.js`, `test/worktree-removal-guard.test.js`, `atris/MAP.md`, `atris/refs/MAP-NOTES.md`, `atris/team/architect/logs/2026-10-14.md`, and this receipt with its matching JavaScript proof.

Verify: `node --test test/worktree-removal-guard.test.js test/member-tidy.test.js`

Output excerpt, exit 0:
```text
tests 12
pass 12
fail 0
cancelled 0
skipped 0
todo 0
```

Real surface: `node atris/receipts/2026-10-14-autopilot-folder-check.js`, exit 0. This calls the production regression routine directly, creates real Git copies, runs real check commands, and retains its locked fixture for inspection. It avoids starting the unrelated full automatic build loop.

Output excerpt:
```text
fixture: /private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-regression-check-jfGlLi
removal recorded: /private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-regression-check-jfGlLi/.atris/state/worktree_removals.jsonl
  kept /private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-regression-check-jfGlLi/.regression-worktree-7e7393ed: git locks: /private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-regression-check-jfGlLi/.git/worktrees/-regression-worktree-7e7393ed/index.lock (7200s old)
clean folder removed and logged; locked folder retained with its exact lock path and age
```

Progress: one remaining removal path guarded; two added real-runtime tests cover old private/shared locks, successful logging, and failed creation of an already-existing folder. No dependencies or protected filename words added. A first test run exposed a circular import; loading the shared removal helpers when the routine runs fixed it.

Other commands: mission status, task list/new/claim/note/ready, Git status/diff, and the brain activation/compile commands. Brain commands exited 2 with a preview of unrelated generated files; those files were not changed. Existing edits to `bin/atris.js` and `atris/TODO.md` remain outside this change.

Save-check lesson: the proof now runs only when called directly and clears inherited Git environment settings before creating its fixture. Its initial load altered the checkout index; the index was restored from unchanged HEAD and only the declared files were staged. The save check passed without overrides. The change was committed and pushed, with task proof ready for review.

next_push: Protect fleet cleanup with the shared Git-activity check and removal log.

layer: behaviors
