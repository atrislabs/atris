# Renamed members receive work by job

Dispatch now uses the existing job picker for renamed members, verified through real CLI previews and focused regression tests.

## Change and scope

- `commands/member.js`: replace the core-name discount and name bonuses with job rules and status/type ranking; preserve specialized idea rules and direct experiment requests.
- `test/member-fleet.test.js`: temporary payments, qa, and scout team tested through actual CLI; experimental, one-off, parked, and human members rank behind normal members; unfamiliar titles keep the default build job.
- `atris/team/opus-overnight/MEMBER.md`: explicitly mark this overnight experiment experimental.
- `atris/MAP.md`, `atris/refs/MAP-NOTES.md`: record dispatch navigation.
- `atris/team/navigator/logs/2026-10-14.md`: append the lesson and next move.
- `lib/member-engine.js`: no final change; reuse `autoJobForMember` rather than introducing a second job inference function.

Flow: idea -> existing job inference -> card status/type rank -> idea score -> member.

## Runnable proof

`node --test test/member-fleet.test.js`

Exit 0. Output excerpt:
```
✔ member dispatch prefers the core team over an experiment member unless the idea names it
✔ member dispatch ranks renamed members by their inferred job through the CLI
ℹ tests 8
ℹ pass 8
ℹ fail 0
```

`env -u CODEX_THREAD_ID -u CODEX_SESSION_ID -u ATRIS_CALLER_RUNTIME node --test test/roster-markdown.test.js`

Exit 0. Output excerpt: `tests 19`, `pass 19`, `fail 0`. Initial run inherited the active Codex caller session and failed two runner-default assertions; removing only caller identity variables makes the existing human-default tests pass. The first CLI regression attempt omitted its temporary working directory; corrected before the successful final run.

Actual surface commands, run with `cwd` set to a throwaway team containing payments (Payments Owner), qa (QA Reviewer), scout (Market Scout), and experimental, parked, human, and one-off candidates:
```
node /Users/keshavrao/arena/.agent-worktrees/atris-cli/navigator-fix-atris-member-dispatch-picking-by-20261014-065552/bin/atris.js member dispatch "Build the refund flow for failed card charges" --dry-run --json
{"ok":true,"member":"payments","role":"Payments Owner","reason":"builds and tests concrete product changes"}
exit: 0
node /Users/keshavrao/arena/.agent-worktrees/atris-cli/navigator-fix-atris-member-dispatch-picking-by-20261014-065552/bin/atris.js member dispatch "Review the diff and verify the tests before merge" --dry-run --json
{"ok":true,"member":"qa","role":"QA Reviewer","reason":"reviews changes and blocks weak work before merge"}
exit: 0
node /Users/keshavrao/arena/.agent-worktrees/atris-cli/navigator-fix-atris-member-dispatch-picking-by-20261014-065552/bin/atris.js member dispatch "Research how competitors price their annual plans" --dry-run --json
{"ok":true,"member":"scout","role":"Market Scout","reason":"researches options and gathers grounded evidence"}
exit: 0
```
The checked-in regression recreates this team and runs these CLI commands, so a reviewer can rerun it without preserving the temporary folder.

Frozen check: `git diff --check`, exit 0, no output.
Progress: all three renamed jobs route correctly; 27 focused tests pass; the overnight regression remains green. No dependencies added. Stop: requested dispatch fix is proven; no second slice started.

Boot/status commands: `atris brain activate --root . --verify`, `atris`, `git status --short`, `atris mission status mission-2026-10-13-fix-atris-member-dispatch-pi-76db2680`, `atris mission goal --json`, `atris task list`, `atris worktree status`, `atris brain compile --root .`. Brain commands returned plan-only (exit 2); generated policy files were not rewritten for this bounded fix.

Delivery: committed and pushed to origin. Task proof is ready for approval; no human acceptance was claimed. The ready command reran `node --test test/member-fleet.test.js` and returned exit 0.

next_push: honor explicit team job overrides when routing ideas, matching engine roster overrides.
layer: behaviors
