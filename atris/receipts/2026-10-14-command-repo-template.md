# Reuse prepared command-test repositories

Six command-test cases now copy one prepared repository instead of repeating its Git setup. The nine affected start and ship tests passed, and the frozen regression and staged writing checks passed.

Files: `test/commands.test.js`, `atris/MAP.md`, `atris/refs/MAP-NOTES.md`, `atris/receipts/2026-10-14-command-repo-template.md`, `atris/team/auto-improver/logs/2026-10-14.md`.

The inherited unfinished helper was retained and completed. Every original command and assertion remains; each case receives its own copied repository and bare origin, with origin relinked to that copy. Bare initialization now checks its exit status. A file-level cleanup hook removes the shared template even if setup fails. A cleanup hook registered inside setup initially attached to the current case and removed the template early; moving registration to file scope fixed the observed ENOENT failures.

Metric: setup Git launches fall from 60 to 16 across six cases, saving 44 launches. Focused whole-command samples: committed baseline 9503.477458ms, changed version 9040.988208ms. These single samples do not establish a stable wall-time gain.

Commands and real output:

- `node --test --test-name-pattern='^worktree (start|ship)' test/zz-old-commands.tmp.test.js`: exit 0, `tests 9`, `pass 9`, `fail 0`, `duration_ms 9503.477458`.
- `node --test --test-name-pattern='^worktree (start|ship)' test/commands.test.js`: exit 0, `tests 9`, `pass 9`, `fail 0`, `duration_ms 9040.988208`.
- `node --test test/roster-run-record.test.js && node bin/atris.js slop --staged`: exit 0, `tests 12`, `pass 12`, `fail 0`, `duration_ms 12104.071209`; `clean, no slop tells in 3 files`.
- `atris brain activate --root . --verify` and `atris brain compile --root .`: exit 2, plan only; no brain files or policy adapters were rewritten.

Rerun: `node --test --test-name-pattern='^worktree (start|ship)' test/commands.test.js && node --test test/roster-run-record.test.js && node bin/atris.js slop --staged`.

The inherited temporary baseline exactly matched committed test content. It was preserved outside test discovery at `/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-smoke-baseline-s3lweuih/zz-old-commands.tmp.test.js`, avoiding a second copy of the entire command suite in later broad runs. Task commands regenerated the rendered TODO from the isolated local database; restore the original rendered view to avoid replacing unrelated historical rows. Current ownership and proof remain in the local task database.

Lesson: register shared test cleanup at file scope; a hook registered while a case is running belongs to that case.

Review proof: the task runner initially selected an older Node without `node:sqlite`. Re-running the same checks with `/opt/homebrew/bin/node` exited 0, recorded in `atris/runs/2026-10-15-task-aic-1-2026-10-15T06-10-23-272Z.json`. The task is ready for human review; no acceptance was performed. The mission check was unchanged.

next_push: batch the independent brainstorm help checks while retaining all output and no-state assertions.
layer: capabilities
