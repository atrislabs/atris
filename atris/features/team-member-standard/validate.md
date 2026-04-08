---
last_compiled: 2026-04-08
sources:
  - commands/member.js
---

# Team Member Standard — Validation

> **Status:** implemented (core)
> **Validated:** 2026-04-08

## Checks

- [x] `atris member create <name>` scaffolds MEMBER.md + skills/ + context/
- [x] `atris member list` shows members with roles
- [x] `atris member activate <name>` links skills, shows context
- [x] 6 built-in members exist in atris/team/
- [x] Frontmatter schema includes name, role, permissions, skills, traits
- [ ] Open source spec published
- [ ] Cross-tool compatibility verified

## Verification

```bash
atris member list                           # Should show navigator, executor, validator, etc.
atris member create test-agent --role="QA"  # Should scaffold directory
atris member activate navigator             # Should link skills, show context
atris member upgrade executor               # Should convert flat MEMBER.md to directory format
```
