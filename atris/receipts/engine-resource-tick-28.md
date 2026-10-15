The engine recording check now catches runners kept available after a block closes; the required behavior checks passed, exit 0.

Files edited: test/engine-resource.test.js, atris/MAP.md, atris/refs/MAP-NOTES.md, atris/team/executor/logs/2026-10-14.md, atris/receipts/engine-resource-tick-28.md.

Plan: closed-block runner -> function boundary check -> required tests.

Verify command: `node --test test/engine-resource.test.js test/engine-dispatch.test.js`
Exit: 0
Output excerpt:
```
real runner and profile launch scan: 8 engine launches through a variable, 0 unrecorded
ℹ tests 148
ℹ pass 148
ℹ fail 0
ℹ duration_ms 36141.461375
```

Other commands: mission status, mission goal --json, task list/new/claim/note/ready, git status, git diff --check (exit 0, no output), targeted runner-scan regression, git commit, git push. Full check output: /tmp/engine-resource-tick28-proof.txt.

Progress: 18 new regression assertions; all 148 tests pass. Plain var declarations survive conditional, loop, and try blocks. Captured runners remain visible, while callback and method locals stay private. No runtime behavior or dependencies changed.

Independent review found callback scope and whitespace defects in the first attempt. Both were fixed, including nested parameter expressions and methods; final review found no blocking correctness concerns. The initial full check also caught shifted navigation references; refreshed both maps and confirmed the reference check passed.

Readiness requires its own executed check rather than accepting a pasted result. Its login shell selects an unsupported Node version, so the existing local workaround reruns the same tests with `PATH=/opt/homebrew/bin:$PATH`; the frozen mission command remains unchanged. The readiness rerun exited 0 and moved the task to Review. Automatic certification cannot rerun the path-prefixed command. Readiness receipt: atris/runs/2026-10-15-task-ecm-13-2026-10-15T00-31-40-054Z.json.

Brain activation and compile commands returned plan-only output, exit 2; generated policy files were left untouched. Existing edits to atris/TODO.md, commands/scout.js, and lib/fleet.js were preserved and excluded from this commit. JavaScript destructuring and reassignment remain outside this bounded text scan.

next_push: Follow a runner passed through a second local helper parameter without confusing unrelated arguments.
layer: capabilities
