
## Silent Node repair fallback

The repair hint now bypasses a Node executable that exits successfully without running the launcher. The printed command repaired temporary startup files through sh and zsh.

Files: lib/engine-resource.js, test/engine-resource.test.js, atris/MAP.md, atris/refs/MAP-NOTES.md.
Verify: node --test test/engine-resource.test.js test/engine-dispatch.test.js
Exit: 0. Output: tests 168, pass 168, fail 0.
Real surface: the test invokes the landing status and its printed engine sweep --fix-startup command with temporary HOME directories. Output matched: changed ~/.zshrc line 1 to:. Both shells exited 0 and the saved file contained the socket guard.
Learned: exit success alone does not prove the launcher ran; require the version response. Existing test launchers needed a version response too. A fixture quoting error was corrected before the passing run.
Task attachment was unavailable because its existing lock was busy; mission scope was preserved.
next_push: Prove fallback when the first Node prints unrelated text and exits successfully.
layer: behaviors
