# Local-First Wiki — Build Plan

> **For Executor Agent** — Follow these steps exactly.

---

## Overview

Ship the first real local-first wiki slice. Canonical root is `atris/wiki/`, cloud becomes opt-in, sync keeps the old `--only wiki` language working, and the next agent gets a dedicated wiki skill plus tests.

---

## Files Touched

**Created:**
- `lib/wiki.js` - shared wiki scaffold, prompt builders, and path helpers
- `atris/skills/wiki/SKILL.md` - project-local wiki operating policy
- `atris/features/wiki/idea.md` - why this feature exists
- `atris/features/wiki/build.md` - this plan
- `atris/features/wiki/validate.md` - validation record

**Modified:**
- `commands/wiki.js` - local-first routing, prompt printing, `--cloud` opt-in
- `commands/init.js` - scaffold `atris/wiki/` during workspace bootstrap
- `commands/activate.js` - surface `atris/wiki/STATUS.md` during session start
- `commands/pull.js` - normalize `--only wiki` to `atris/wiki/`
- `commands/push.js` - normalize `--only wiki` to `atris/wiki/`
- `bin/atris.js` - add `ingest`, `query`, and `lint` aliases
- `test/commands.test.js` - wiki regression tests
- `test/cli-smoke.test.js` - init/activate wiki integration smoke coverage
- `README.md` - document local-first wiki behavior
- `atris/CLAUDE.md` - teach first-session agents to read wiki state
- `atris/atris.md` - load wiki state on activate
- `atris.md` - master spec mentions wiki activation
- `atris/team/navigator/MEMBER.md` - wiki-aware planning
- `atris/team/executor/MEMBER.md` - wiki-aware execution
- `atris/team/validator/MEMBER.md` - wiki-aware validation
- `atris/MAP.md` - update wiki navigation truth
- `atris/features/README.md` - register the feature
- `atris/wiki/*` - dogfood the repo-local wiki with seed pages and status

---

## Build Steps

### Step 1: Extract the wiki core

**Files:** `lib/wiki.js`, `commands/wiki.js`

**What to do:**
- Move wiki protocol, scaffold templates, prompt builders, and root-path helpers into `lib/wiki.js`.
- Keep one prompt shape for local and cloud so the logic does not drift.
- Make the canonical local root `atris/wiki/`, with legacy `wiki/` lookup only for reads.

**Validation:**
- `atris ingest README.md` prints a local prompt and creates `atris/wiki/`

---

### Step 2: Flip the command default

**Files:** `commands/wiki.js`, `bin/atris.js`

**What to do:**
- Default `ingest`, `query`, and `lint` to local mode.
- Support `--cloud` for the remote path using the same prompt builders.
- Add safe top-level aliases: `atris ingest`, `atris query`, `atris lint`.
- Keep `search` and `log` under `atris wiki` because those names already belong to journals at the CLI root.

**Validation:**
- `atris query "state"` prints a local wiki prompt
- `atris lint` prints a local wiki prompt

---

### Step 3: Keep sync language stable

**Files:** `commands/pull.js`, `commands/push.js`

**What to do:**
- Normalize `wiki`, `wiki/`, and `atris/wiki` to the canonical `atris/wiki/` prefix.
- Preserve the human-facing `--only wiki` wording so the command stays easy to remember.

**Validation:**
- Unit test proves `normalizeWikiOnlyPrefix('wiki') === 'atris/wiki/'`

---

### Step 4: Document the system the repo just learned

**Files:** `atris/skills/wiki/SKILL.md`, `README.md`, `atris/MAP.md`, `atris/features/README.md`, `atris/features/wiki/*`

**What to do:**
- Add the wiki skill so future agents use the same ingest/query/lint rules.
- Update README and MAP to point at the new local-first behavior and canonical path.
- Create the wiki feature pack with idea, build, and validation docs.

**Validation:**
- A cold reader can find the wiki flow from README, MAP, or the feature pack without rereading the conversation

---

### Step 5: Make the wiki compound

**Files:** `commands/init.js`, `commands/activate.js`, `atris/CLAUDE.md`, `atris/atris.md`, `atris.md`, `atris/team/*/MEMBER.md`, `atris/wiki/*`

**What to do:**
- Scaffold `atris/wiki/` during `atris init` so every new workspace starts with a wiki.
- Surface `atris/wiki/STATUS.md` in `atris activate` so the next session reads the wiki instead of leaving it write-only.
- Update the agent/spec docs so planning, execution, and validation all know when to read or lint the wiki.
- Dogfood the feature in this repo by seeding `atris/wiki/` with at least one useful page.

**Validation:**
- `atris init` creates `atris/wiki/`
- `atris activate` prints `atris/wiki/STATUS.md`
- this repo contains a non-empty `atris/wiki/`

---

## Testing Strategy

### Unit Tests

- `normalizeWikiOnlyPrefix` maps `wiki` to `atris/wiki/`

### Integration Tests

- `atris ingest README.md` scaffolds `atris/wiki/`
- `atris query "..."` uses local wiki mode by default
- `atris wiki search <term>` reads `atris/wiki/index.md`
- `atris wiki log` reads `atris/wiki/log.md`

### Manual Testing

1. Run `atris ingest README.md`
2. Confirm `atris/wiki/` exists with the four root files and three subfolders
3. Run `atris query "what is this repo?"`
4. Run `atris lint`

---

## Error Cases

**Error:** User asks for `--cloud` without login or business context

**Handling:** Fail directly and tell them to log in or provide a business slug. Do not silently fall back to local when they asked for cloud.

**Error:** Existing repo still has legacy `wiki/`

**Handling:** Read from it for compatibility, but write the new scaffold to `atris/wiki/`.

---

## Dependencies

- Existing cloud business chat flow in `commands/wiki.js`
- Existing `pull` and `push` prefix filtering
- Existing command test harness in `test/commands.test.js`

---

## Rollback Plan

1. Remove the new aliases from `bin/atris.js`
2. Restore the old `commands/wiki.js` behavior
3. Drop `lib/wiki.js` and the wiki skill
4. Revert sync prefix normalization if the canonical root decision changes

---

## Notes for Executor

- Do not fake the cron/vibe-check layer in this feature. Document it as follow-up work if needed.
- The one memorable decision is simple: `atris/wiki/` is where the repo brain lives.
