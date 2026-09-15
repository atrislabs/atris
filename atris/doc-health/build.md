# Document health: `atris doc-health`

> For the executor. One PR in atris-cli. Read this whole file, then `commands/doctor.js`, `commands/brain.js` (collectState, readText helpers), `lib/mission-root.js`, and `test/brain-command.test.js` before writing code.

## Why

Every model that boots into an Atris workspace pays a read tax. Keshav wants one number that says how organized and token efficient the workspace docs are, and how few file reads a fresh model needs to find things. Tracked over time, it makes doc hygiene measurable and model agnostic.

## The command

`atris doc-health [--json] [--questions <path>]`

Runs against the workspace root from `resolveWorkspaceRoot(cwd)`. Prints a short scorecard in text, or a JSON object with `--json`. Exit 0 always unless the workspace has no `atris/` folder (exit 1 with a plain message).

## What it measures

One. **Boot load.** For each file in the boot set, report size in chars and approximate tokens (chars divided by 4, say so in the output). Boot set: `CLAUDE.md`, `AGENTS.md`, `atris/atris.md`, `atris/MAP.md`, `atris/TODO.md`, `atris/now.md`, `atris/PERSONA.md`, `atris/brain/STATUS.md`, `atris/brain/self_improvement_ledger.md`, `atris/wiki/index.md`, `atris/skills/atris/SKILL.md`. Missing files are listed as missing, not errors. Report the total and flag any single file over 20,000 chars.

Two. **Map coverage.** Parse the routing table rows in `atris/MAP.md` (markdown table rows whose second cell has backticked paths). Report rows, paths, and how many paths exist on disk. Also report how many `atris/features/*` folders and `atris/team/*` folders are mentioned anywhere in MAP.md versus how many exist.

Three. **Lookup hops.** Read a question file, default `atris/doc-health/questions.jsonl`, one JSON object per line: `{"q": "where is the RL API", "expect": "backend/routers/rl_api_router.py"}`. For each question, tokenise `q` into keywords (lowercase, drop stop words and words under 3 chars). Hop 1: does any MAP.md line contain the expected path AND at least one keyword? Hop 2: does any file that MAP.md points to (backticked paths that are .md files) contain the expected path? Otherwise unresolved. Score = share of questions resolved in one hop. Print each question with its hop count. If the file is missing, print how to create it and skip the section with score null.

Four. **Staleness.** Features: for each `atris/features/<name>/idea.md`, read the `Last Updated:` or `Created:` line; flag if older than 60 days and the Status line does not contain complete, shipped, live, archived, or parked. Members: for each `atris/team/<name>/` folder with a MEMBER.md, find the newest file under `logs/`; flag if older than 30 days or no logs at all. Print counts and the ten oldest.

Five. **Near duplicates.** Feature folder names that share a prefix of 5 or more chars with another (for example `aeo` and `aeo-anyone`, `rl-api` and `rl-environment`). List the groups. No judgement, just the list.

Six. **Overall score** 0 to 100: 30 points for lookup hops (share resolved in one hop), 25 for map coverage (paths that exist), 20 for boot load (full points at or under 80,000 chars total, zero at 200,000, linear between), 15 for feature freshness (share not flagged), 10 for member freshness (share not flagged). Show each part and the sum.

## Files

Created: `commands/doc-health.js`, `test/doc-health.test.js`, `atris/doc-health/questions.jsonl` (in this repo's own atris folder, ten real questions about atris-cli with paths that exist), and a README section.
Modified: `bin/atris.js` (register next to `doctor`, same pattern), `README.md` (one short section under the doctor command), `atris/MAP.md` here (one row).

## Rules

- Plain Node, no new dependencies.
- Reuse `resolveWorkspaceRoot` and the read helpers that exist; do not write a new root finder.
- Text output: short lines, one idea per line, no em dashes anywhere. Numbers in a small table.
- Tests: `node --test test/doc-health.test.js` with a temp workspace seeded like `test/brain-command.test.js`. Cover: missing atris folder, boot set with one oversized file, a question resolved in one hop, one in two hops, one unresolved, a stale feature, a member with no logs, the JSON shape.
- Commit early and often on this branch. First commit within 10 minutes of starting, even if it is only the skeleton. Final commit message starts with `Add atris doc-health`.
- When done, write `atris/doc-health/REPORT.md`: what landed, the test command and its output, and anything you could not do. Do not open a PR.
