Member runs now check repo formatting before finishing, verified by nine passing checks and real command runs that blocked committed whitespace and completed clean work.

Plan: run -> named behavior check -> review -> repo formatting checks -> completion.

Files edited:
- commands/member.js
- commands/mission.js
- lib/member-extra-checks.js
- test/member-extra-checks.test.js
- atris/MAP.md
- atris/refs/MAP-NOTES.md
- atris/team/architect/logs/2026-10-14.md

Artifacts:
- atris/receipts/member-extra-checks-2026-10-14.md
- atris/receipts/member-extra-checks-live-2026-10-14.json

Verification command: node --test test/member-extra-checks.test.js
Exact summary: tests 9; pass 9; fail 0; cancelled 0; skipped 0; todo 0. Exit: 0.
Related verification: node --test test/member-extra-checks.test.js test/member-run-one-run-outcome.test.js test/member-run-start.test.js
Exact summary: tests 24; pass 24; fail 0; cancelled 0; skipped 0; todo 0. Exit: 0.
git diff --check: empty output; exit 0.

Real changed-surface command: node bin/atris.js member run demo 'update hello.txt' --runner claude --shared-checkout --ignite --no-referee --max-ticks 1 --verify 'node check.cjs' --json
Invoked in temporary committed Git projects with a deterministic local worker, the actual CLI and Git were not mocked. Full absolute command, project path, Git commands, exit codes, and output excerpts are saved in the live JSON artifact.
Committed-whitespace run output: {"ok":false,"state":"blocked","error":"the work ran but the repo formatting check failed"}; named behavior check printed "behavior passed" and exited 0; extra check printed "hello.txt:1: trailing whitespace." and exited 2; member command exited 1.
Clean run output: {"ok":true,"state":"complete","error":null}; named behavior check printed "behavior passed"; all three Git checks exited 0; member command exited 0.

Progress: one bounded behavior improvement; committed, staged, and unstaged whitespace now block completion and GitHub handoff without replacing the named verifier. Non-git and unborn repos work; explicit no-verify opts out. Checks apply to tracked/indexed changes, not new untracked files. Cached steps still run the repo checks.

State: local task proof submitted for review. The active parent driver holds the mission lock, so attach-task exited 3 rather than modifying a live mission. The parent owns final mission state; frozen verifier and lane remain unchanged. Brain activation and compilation returned plan-only exit 2, with no generated policy files written. A local task render replaced the existing TODO view; restore its prior bytes before committing because the shared queue is not this slice.

next_push: Check new untracked source files for formatting problems before completion.

Review submission: task ready with the frozen --verify command exited 0 and reported ready; no human acceptance was attempted.
Landing commands: git add with only declared files, git commit, git push -u origin HEAD.
layer: behaviors
