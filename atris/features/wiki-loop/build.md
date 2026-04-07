# Wiki Upkeep Loop — Build Plan

> **For Executor Agent** — Follow these steps exactly.

---

## Overview

Ship the maintenance layer for the local wiki. The command should be deterministic, cheap to run, and useful before any cron or autopilot scheduler exists.

---

## Files Touched

**Created:**
- `commands/loop.js` - wiki upkeep report builder and CLI output
- `atris/skills/loop/SKILL.md` - project-local `/loop` skill
- `atris/features/wiki-loop/idea.md`
- `atris/features/wiki-loop/build.md`
- `atris/features/wiki-loop/validate.md`

**Modified:**
- `lib/wiki.js` - stale/orphan/suggestion helpers plus STATUS/log writers
- `commands/wiki.js` - `wiki loop` alias
- `bin/atris.js` - top-level `loop` command + help text
- `README.md` - document the upkeep command
- `atris/MAP.md` - map the loop feature and search paths
- `atris/features/README.md` - register the feature
- `test/commands.test.js` - upkeep command tests
- `test/cli-smoke.test.js` - end-to-end loop smoke

---

## Build Steps

### Step 1: Add deterministic upkeep helpers

**Files:** `lib/wiki.js`

**What to do:**
- Read wiki pages from the canonical `atris/wiki/` content folders.
- Parse frontmatter cheaply; no new dependency.
- Detect stale pages from `sources` and `last_compiled`.
- Detect orphan pages from missing index coverage and inbound wiki links.
- Suggest a short next-ingest queue from important repo files not yet present in page frontmatter.
- Add helpers to rewrite `STATUS.md` and append a `LOOP` line to `log.md`.

**Validation:**
- helper-level command tests can prove stale/orphan/suggestion behavior through CLI output

### Step 2: Add the command surface

**Files:** `commands/loop.js`, `commands/wiki.js`, `bin/atris.js`

**What to do:**
- Add `atris loop` as a top-level command.
- Add `atris wiki loop` as a namespace alias.
- Support `--dry-run`, `--json`, and `--limit=N`.
- Keep the command local-only for now; if a user passes `--cloud`, fail directly and tell them to run local upkeep first.

**Validation:**
- `atris loop` prints a report box with health and next move
- `atris wiki loop` prints the same style of report

### Step 3: Teach the repo about the loop

**Files:** `atris/skills/loop/SKILL.md`, `README.md`, `atris/MAP.md`, `atris/features/README.md`, `atris/features/wiki-loop/*`

**What to do:**
- Add the `/loop` skill so future agents treat upkeep as a first-class action.
- Update README and MAP so a cold reader finds `atris loop` quickly.
- Create the feature pack with honest scope: upkeep command now, scheduling later.

**Validation:**
- a cold reader can find the loop flow from README, MAP, or the feature pack

### Step 4: Prove it updates wiki memory

**Files:** `test/commands.test.js`, `test/cli-smoke.test.js`

**What to do:**
- Keep focused command tests for stale pages, orphan pages, suggestion queue, and `wiki loop` aliasing.
- Add one smoke test that proves `atris loop` rewrites `STATUS.md` and appends to `log.md` in a fresh workspace.

**Validation:**
- targeted tests pass
- full test suite passes
- fresh temp-dir manual smoke shows `STATUS.md` + `log.md` changed after running `atris loop`

---

## Out of Scope

- background cron scheduling
- autopilot calling `atris loop`
- auto-ingest of suggested files
- cloud upkeep mode
- auto-push

---

## Notes for Executor

- Reuse the existing wiki scaffold; do not invent a second state system.
- Keep the output plain-English and non-technical where possible.
