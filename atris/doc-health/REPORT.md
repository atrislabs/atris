# Doc health: final receipt 2026-09-16

Score: 19 before the push, 100 now. Every question in `atris/doc-health/questions.jsonl` resolves in one hop from `atris/MAP.md`.

How to check: run `atris doc-health` at this root. Boot also prints the docs line.

What made the last points: the CLI with the compact task-list render and the fixed checker is installed globally, so boot no longer re-inflates `atris/TODO.md`. Idle members were parked with `scripts/park_idle_members.py` (adds `status: parked` plus a dated note to MEMBER.md; no logs were written for them). Parked here: eighteen members with no member log or none in 30 days (alpha-judge, coordinator, customer-lead, generalist, objective-generator, opus-overnight, problem-solver, supervisor had no logs at all). Delete the status line in MEMBER.md to bring one back.

Keeping it at 100: add a MAP row for any new folder, park ideas after 60 quiet days and members after 30, keep the boot set under 80k chars.

---

# Document health report, 2026-09-16

Devin (swe-2-max) rebuilt the map and questions and trimmed the protocol docs, then its service dropped mid-trim. The orb parked the stale features and scored the result.

| part | before | after |
|---|---|---|
| lookup hops | 0 of 30 (no questions) | 30 of 30, all one hop |
| map coverage | 0 of 25 (no routing table) | 25 of 25 (50 rows, every path exists) |
| boot load | 0 of 20 (423,975 chars) | 19.9 of 20 (80,761 chars; the compact task render lands with the CLI branch and takes it under 80,000) |
| feature freshness | 15 of 15 | 15 of 15 (six stale ideas parked with dated notes) |
| member freshness | 3.9 of 10 | 3.9 of 10 (19 of 31 members have no log in 30 days) |

The member number is the honest finding here: most CLI members are not running. The fix is to mark the ones that are truly retired with `status: retired` in their MEMBER.md frontmatter (the checker then leaves them out) and to wake the ones that should be running, not to invent logs.

What changed: `atris/MAP.md` went from 296,258 chars of generated listings to a 4,253 char routing table; the parts that still mattered moved to `atris/refs/MAP-NOTES.md`. Thirty questions live in `atris/doc-health/questions.jsonl`. `scripts/park_stale_features.py` is the same script the backend uses. Note `atris/features/` and `atris/wiki/` are gitignored in this repo, so those edits are local only.

Command: `atris doc-health` from this folder (from the CLI branch codex/doc-health-boot-20260915 until it ships). Nothing committed.
