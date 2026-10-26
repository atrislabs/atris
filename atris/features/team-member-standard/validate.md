---
last_compiled: 2026-10-23
sources:
  - commands/member.js:11626-11875 (member command dispatch and help)
  - commands/mission.js:2028-2068 (renderMemberNowMarkdown, member now.md rendering)
  - lib/member-scaffold.js:145-177 (ensureMemberBundle, files a new member gets)
  - test/commands-1.test.js:30 (member create, archive, goal, goal-from-mission, goal-from-score, and wake coverage starts here)
  - test/commands-2.test.js:1205-1533 (member loop, alive, status, and block coverage)
  - test/member-steering-root.test.js
  - test/member-history.test.js
---

# Team Member Standard: Validation

> **Status:** implemented and re-verified (local-first member runtime)
> **Validated:** 2026-10-23

## Checks

- [x] `atris member create <name>` scaffolds MEMBER.md + SOUL.md + MISSION.md + goals.json + goals.md + skills/ + tools/ + context/ + logs/
- [x] `atris member list` shows members with roles
- [x] `atris member activate <name>` links skills, shows context
- [x] Frontmatter schema includes name, role, description, version, permissions, skills, tools
- [x] `atris member goal`, `tick`, `review`, `block`, and `status` preserve proof and useful next command state
- [x] `atris member goal-from-mission` derives a bounded goal from MISSION.md and refuses placeholder missions
- [x] `atris member goal-from-score` creates the active self-improvement goal from Team score evidence
- [x] `atris member wake` returns one finite decision and refuses to pile work onto open experiments; from a terminal it then runs one bounded work step unless `--plan` or `--dry-run` is passed
- [x] `atris member loop` repeats wake quickly, skips when a lease is already active, and exits early on a repeated identical `ask` decision
- [x] `atris member wake` resolves steering from the shared workspace root, so it works when run from a subdirectory
- [x] `atris member alive` runs the loop in always-on liveness mode
- [x] `atris member run` delegates active member runtime work to `atris mission run`; a job that is not a member name is dispatched to the best member
- [x] `atris member history` reads git history for MEMBER.md and SOUL.md
- [x] `supervisor recommendations`, `objective-generator proposals`, `generalist proof`, and `generalist patterns` are exposed from member help
- [x] `archive` and `purge-archived` are exposed for retired members
- [ ] Open source spec published
- [ ] Cross-tool compatibility verified by external agents reading MEMBER.md

## Verification

```bash
node --test --test-name-pattern 'member' test/commands-1.test.js test/commands-2.test.js test/member-steering-root.test.js test/member-history.test.js
node -c commands/member.js
node -c commands/mission.js
node -c bin/atris.js
node bin/atris.js member --help
node bin/atris.js member list
node bin/atris.js clean --dry-run --json
```
