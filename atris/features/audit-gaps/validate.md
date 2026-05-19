# Validation — Audit Gaps

> **Rule:** If ANY step fails, the feature is broken.

---

## Checks

- [x] `for f in atris/team/{navigator,executor,validator,brainstormer,launcher,researcher}/MEMBER.md; do rg -q "Read \`atris/PERSONA.md\` for communication style" "$f"; done`
  - **Result:** PASS — navigator:1, executor:1, validator:1, brainstormer:1, launcher:1, researcher:1
- [x] self-improving-loop marked "complete" in features/README.md
  - **Result:** PASS — Moved to Completed Features section, status: complete
- [x] audit-gaps marked "complete" in features/README.md
  - **Result:** PASS — Moved to Completed Features section, status: complete
- [x] `awk '/### Active Features/{flag=1;next}/---/{if(flag) exit}flag' atris/features/README.md | rg -q '^None\\.$'`
  - **Result:** PASS — Active Features has no stale audit-gaps entry
- [x] `! rg -n "Status:\\*\\* in-progress|> \\*\\*Status:\\*\\* in-progress|atris/team/[a-z-]+\\.md" atris/features/README.md atris/features/audit-gaps/idea.md atris/features/audit-gaps/build.md`
  - **Result:** PASS — no stale status or old direct team spec paths remain

---

**Status:** Verified
