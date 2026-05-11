---
last_compiled: 2026-05-10
sources:
  - commands/member.js:1209-3054 (member command handlers)
  - commands/mission.js:304-346 (member mission status rendering)
  - test/commands.test.js:86-845 (member create, goal, wake, loop, status coverage)
---

# Team Member Standard — Validation

> **Status:** implemented (local-first member runtime)
> **Validated:** 2026-05-10

## Checks

- [x] `atris member create <name>` scaffolds MEMBER.md + MISSION.md + skills/ + tools/ + context/ + logs/
- [x] `atris member list` shows members with roles
- [x] `atris member activate <name>` links skills, shows context
- [x] Frontmatter schema includes name, role, description, version, permissions, skills, tools
- [x] `atris member goal`, `tick`, `review`, `block`, and `status` preserve proof and useful next command state
- [x] `atris member goal-from-mission` derives a bounded goal from MISSION.md and refuses placeholder missions
- [x] `atris member goal-from-score` creates the active self-improvement goal from Team score evidence
- [x] `atris member wake` returns one finite decision and refuses to pile work onto open experiments
- [x] `atris member loop` repeats wake quickly and skips when a lease is already active
- [x] `atris member run` delegates active member runtime work to `atris mission run`
- [ ] Open source spec published
- [ ] Cross-tool compatibility verified

## Verification

```bash
node --test test/commands.test.js --test-name-pattern 'member'
node -c commands/member.js
node -c commands/mission.js
node -c bin/atris.js
node bin/atris.js member --help
```
