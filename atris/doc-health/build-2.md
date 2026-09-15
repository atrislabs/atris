# Doc health, part two: compact TODO render, boot score, thresholds

> For the executor. One PR on this branch, which already contains `atris doc-health` (read `commands/doc-health.js`, `atris/doc-health/build.md`, and `REPORT.md` first). Keshav's bar: a workspace should score 99 of 100 and any model should find docs in one hop. Today the backend workspace scores 67. The boot set is 220,000 chars, and `atris/TODO.md` alone is 94,000 because the renderer writes seven lines per task.

## Do these four things

One. **Compact TODO render.** In `lib/task-db.js`, `renderTodoMarkdown()` currently emits per task: title, Why it matters, Done looks like, Approve or change, Technical details, Claimed by, Verify. Make the default render one line per task in Backlog, In Progress, Review, and Blocked: `- **[ID]** title · owner · verify: <short>` where verify is the first 60 chars of the verify command or omitted. Keep "Done looks like" as a second indented line only for In Progress and Review (the reader needs it to approve). Completed stays capped at 8, one line each. Add a top line under the title: `Details for any task: atris task show <ID>`. Keep an env switch `ATRIS_TODO_RENDER=full` that restores the old shape so nothing that depends on it is stranded. Then find every reader of TODO.md in this repo (grep `TODO.md`, `parseTodo`, `state-detection`, `getTaskGlance`, `accept`, `reviews`) and make sure they still parse the compact shape; their tests must pass. Target: the backend TODO.md renders under 12,000 chars with the same task counts.

Two. **Boot shows the score.** In `bin/atris.js` `showWelcomeVisualization()` add one line after the truth line: `docs   <score>/100 · <one-hop share> one hop · boot <tokens>k tokens` computed by calling the doc-health module directly (export a `computeDocHealth(root)` from `commands/doc-health.js`, no child process). It must add under 150 ms to boot; if the workspace has no questions file, print `docs   <score>/100 · add atris/doc-health/questions.jsonl` instead. Never throw from boot because of this line.

Three. **Thresholds.** Boot load full credit moves from 60,000 to 80,000 chars total (zero still at 200,000). Reason: MAP.md is the index and is worth its size; the real waste was TODO.md and the wiki index. Update the brief, the tests, and the README line.

Four. **Exclusions.** Members whose MEMBER.md frontmatter has `status: retired`, `status: parked`, or `status: archived` do not count toward member freshness. Features whose status line contains `parked` already skip; also skip `retired` and `superseded`. Folders under `atris/features/_archive` and `_templates` never count. Add tests for each.

## Rules

- No new dependencies. No em dashes anywhere.
- Commit after each of the four items. Final commit message starts with `Compact TODO render and boot doc score`.
- Run `node --test` for the whole test folder at the end and paste the summary into `atris/doc-health/REPORT-2.md` with anything you could not do. Do not open a PR.
