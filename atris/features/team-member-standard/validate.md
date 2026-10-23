---
last_compiled: 2026-10-14
sources:
  - commands/member.js:11385-11622 (member command dispatch and help)
  - commands/mission.js:1981-2021 (renderMemberNowMarkdown, member now.md rendering)
  - test/commands.test.js:187 (member create, goal, wake, loop, status coverage starts here)
---

# Team Member Standard: Validation

> **Status:** implemented and re-verified (local-first member runtime)
> **Validated:** 2026-07-25, rechecked 2026-10-14

## Checks

- [x] `atris member create <name>` scaffolds MEMBER.md + MISSION.md + skills/ + tools/ + context/ + logs/
- [x] `atris member list` shows members with roles
- [x] `atris member activate <name>` links skills, shows context
- [x] Frontmatter schema includes name, role, description, version, permissions, skills, tools
- [x] `atris member goal`, `tick`, `review`, `block`, and `status` preserve proof and useful next command state
- [x] `atris member goal-from-mission` derives a bounded goal from MISSION.md and refuses placeholder missions
- [x] `atris member goal-from-score` creates the active self-improvement goal from Team score evidence
- [x] `atris member wake` returns one finite decision and refuses to pile work onto open experiments
- [x] `atris member loop` repeats wake quickly, skips when a lease is already active, and exits early on a repeated identical `ask` decision
- [x] `atris member wake` resolves steering from the shared workspace root, so it works when run from a subdirectory
- [x] `atris member alive` runs the loop in always-on liveness mode
- [x] `atris member run` delegates active member runtime work to `atris mission run`
- [x] `atris member history` reads git history for MEMBER.md and SOUL.md
- [x] `supervisor recommendations`, `objective-generator proposals`, `generalist proof`, and `generalist patterns` are exposed from member help
- [x] `archive` and `purge-archived` are exposed for retired members
- [ ] Open source spec published
- [ ] Cross-tool compatibility verified by external agents reading MEMBER.md

## Rechecked 2026-10-14

- `node --test --test-name-pattern 'member' test/commands.test.js`: exit 0, 65 passed.
- `node -c` on `commands/member.js`, `commands/mission.js`, `bin/atris.js`: all parse.
- `atris member --help` exits 0 and still lists goal-from-mission, goal-from-score, alive, history, archive, purge-archived, supervisor, and generalist.
- `atris member list` exits 0 and prints the team table.
- `atris clean --dry-run --json` exits 0. It reported this page stale because member code changed after July; the source refs above now point at the current lines. The build page still carries July refs and needs its own recompile.

## Verification

```bash
node --test test/commands.test.js --test-name-pattern 'member'
node -c commands/member.js
node -c commands/mission.js
node -c bin/atris.js
node bin/atris.js member --help
node bin/atris.js member list
node bin/atris.js clean --dry-run --json
```
