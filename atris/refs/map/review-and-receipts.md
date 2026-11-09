# Review and receipts

Verification, code review, receipts, scorecards and the auto-accept gate. Exact `file:line` refs and search shortcuts. Back to [MAP-NOTES.md](../MAP-NOTES.md).

## Search shortcuts: Modular commands

```bash
rg "renderCard|renderPageSection|renderEmailLine|renderMorningCardRow|directProofText|earnedUsd|todayMissionReceiptLines" lib/receipt-block.js commands/now.js commands/mission.js test/receipt-block.test.js # Receipt block: existing mission receipt schema gains optional render surfaces, now.md preserves complete mission results and their why clauses without ellipsis fragments, and first-person check process becomes a direct passed fact; surfaces lead with a plain sentence plus one checkable link (localhost, loopback and *.local hosts never count), machinery sits in a details line, and earned_usd (a real number or plain decimal string only) shows there as earned dollars
rg "namedUnrunProofCommand|unrunNamedProofCommandIssue|proof_command_not_run|requireRanNamedProofCommand" lib/task-proof.js commands/task.js test/task-proof.test.js  # Ready, step-to-ready, and API ready fail when --proof names npm test, node --test, or git diff --check and this process did not run that command; headless, no prompt
```

## By-Feature Map

- **atris scorecard:** `commands/scorecard.js:269` routes find, run and show (no step finds tasks the first time, then shows). `lib/repo-scorecard.js:777` (`findTasks`) walks first-parent changes and keeps one when its tests fail on the parent with the change's tests put back and pass on the change; the ask is the change's message, plus the merged commits' messages for a pull request merge. `lib/repo-scorecard.js:723` (`namesFor`) adds the names the hidden tests call that the change added or changed: new files the tests load, new JS exports, new Python functions, classes and top-level names, and functions whose arguments changed, each written the way its definition is called (`lib/repo-scorecard.js:682`). A result counts only for the exact ask it was given (`lib/repo-scorecard.js:770`), so a changed ask is tried again. `lib/repo-scorecard.js:594` makes the throwaway clone (no remote, venv and node_modules linked, `.env` only with `--with-env`). `lib/repo-scorecard.js:846` (`preflight`) needs the Claude plan login, extra usage off unless `--allow-extra-usage`, and `ATRIS_CLAUDE_SPEND_OK` for any model past haiku. `lib/repo-scorecard.js:877` (`runTry`) runs the engine with billing keys removed (`lib/repo-scorecard.js:153`) and pushes rewritten (`lib/repo-scorecard.js:182`), stops it when the stream's first line names a billing source other than the plan, then puts the hidden tests back to grade. `lib/repo-scorecard.js:960` resumes missing tries and stops when the plan runs out; `lib/repo-scorecard.js:1000` and `lib/repo-scorecard.js:1065` build and print the scorecard. Test commands per path come from `.atris/scorecard.json` or `--config`. `bin/atris.js:2238` routes it. Regression: `test/repo-scorecard.test.js` (temp repo, fake engine).

## Feature: Receipts (`atris receipt`)

**Purpose:** Save simple evidence from agent/business-computer work: task -> commands -> checks -> receipt.

- **Entry point:** `bin/atris.js` command routing for `receipt` (`proof` and `openclaw` remain quiet aliases).
- **Handler:** `commands/proof.js`
- **Core flows:** `doctor` checks business binding + `.atris/receipts`; `init <slug>` scaffolds `.atris/tasks/<slug>.json` and `.atris/receipts/`; `run --dry-run` prints the two commands without backend calls.
- **Value:** Gives users receipts instead of asking them to trust agent claims.

**Search:** `rg "proofCommand|Receipt check|Receipt run" commands/proof.js bin/atris.js`

## Feature: Autoland (`atris autoland`)

- **Personal protected work:** `lib/auto-accept-certified.js:1126` (`PROTECTED_LANE_TERMS`) includes personal money and messaging; `lib/auto-accept-certified.js:1134` (`sniffedProtectedLane`) uses word starts so syntax does not match tax. Regression: `test/auto-accept-certified.test.js:551`.

- **Eligibility engine:** `lib/auto-accept-certified.js` `evaluateAutoAccept()` checks independent review, denied tags, proof evidence, strict verify, and `candidatePolicyGate()`. Candidate scope comes only from declared artifacts or an exact checked-out branch diff; ambiguous scope records advice instead of blocking. Touched prose uses the existing slop rules and refuses as `slop_gate` with rule ids plus file:line locations. The verifier tokenizer accepts quoted Node test-name regexes, rejects shell operators, and executes with `shell: false`; `lib/task-proof.js` validates proof citations. Regression: `test/auto-accept-certified.test.js`, `test/landing-reasons.test.js`.

## Feature: Work Verification (`atris verify`)

**Purpose:** Validate work is actually done - tests pass, MAP.md updated, changes exist

- **Entry point:** `commands/verify.js:13-35` (verifyAtris function)
- **Help:** `bin/atris.js:788-799` (showVerifyHelp) and `bin/atris.js:788-799` (showVerifyHelp short-circuit)
- **Rubric runner:** `commands/verify.js:495-529` (verifyRubric)
- **Regression:** `test/commands-2.test.js:1512-1527` covers `verify --help` without verifier execution
- **Modes:**
- `atris verify`: Verify entire workspace health
- `atris verify [task]`: Verify specific task completion
- **Checks:**
- MAP.md has real content (not placeholder)
- Tests pass (auto-detects npm test, pytest, etc.)
- Recent git changes are documented in MAP.md
- Task-specific: claimed files exist, symbols defined
- **Output:**
- Verification status per check
- VERIFIED ✓ or issue count
- **Value:** Confidence before marking work complete

**Search:** `rg "verifyAtris|verifyRubric|showVerifyHelp|verify --help" bin/atris.js commands/verify.js test/commands-1.test.js`

## Feature: Specialist Code Review (`atris code-review`, `atris cr`)

**Purpose:** Run the optional six-specialist review engine without confusing it with the core `atris review` workflow validator.

- **Routing:** `bin/atris.js:1334-1331` routes `code-review` and `cr` to `commands/review.js`
- **Engine discovery:** `commands/review.js:14-30` searches for `review_engine.py`
- **Missing-engine JSON:** `commands/review.js:32-46` returns `{ ok:false, error:"not installed" }` under `--json` and prints `not installed; atris skill install code-review` on stderr for humans, both exit 2 (no stack trace)
- **JSON error helper:** `commands/review.js:48-55` keeps wrapper-owned setup failures parseable
- **Handler:** `commands/review.js:57-182` parses file/diff/all/json args and delegates to the Python engine when present
- **All-mode setup:** `commands/review.js:93-101` returns `{ ok:false }` for missing `backend/services/` under `--all --json`, before auditing services
- **All-mode JSON success:** `commands/review.js:127-140` returns one parseable `{ ok:true, action:"code_review_all" }` summary instead of human `AUDIT:` prose
- **All-mode human success:** `commands/review.js:142-151` keeps the existing audit banner and table for non-JSON callers
- **Regression:** `test/code-review.test.js` and `test/dogfood-t6-t10.test.js` cover not-installed exit 2, JSON missing-services, and JSON success summaries

**Search:** `rg "reviewCommand|printMissingReviewEngine|exitReviewError|code_review_all|code-review --json|not installed" commands/review.js test/code-review.test.js test/dogfood-t6-t10.test.js bin/atris.js`

## Concern: Endgame Scorecards

**Files:**

- `lib/reward-config.js`: Frozen reward constants + judge checksum (immutable by loop, guarded by `scripts/pre-commit`)
- `scripts/pre-commit`: Git pre-commit hook: blocks staged changes to `lib/reward-config.js` unless `ATRIS_REWARD_EDIT=1`
- `lib/scorecard.js` (284 lines): Scorecard writing, parsing, and endgame closeout metric synthesis
- `.atris/presidio/scorecards.md` (generated, local-only): Append-only endgame results log
- `atris/wiki/concepts/horizon-types.md`: Horizon type categorization guide for slug prefixes and historical reward weighting

**Key functions (lib/scorecard.js):**

- Lines 147-184: `buildScorecardData(atrisDir, { slug, pickedAt })`: Synthesizes closeout metrics from TODO.md, journal reward blocks, and lessons.md so endgame scorecards reflect real loop output
- Line 220: `writeScorecard(atrisDir, data)` appends an endgame result to `.atris/presidio/scorecards.md`. New format: `- **[date] slug** - shipped: X/Y - wall-clock: Nh - halt: Z% - reward: total - lessons: N`.
- Lines 227-254: `detectEndgameCompletion(atrisDir)`: Check if all endgame-tagged tasks have been moved to Completed, return `{ complete: boolean, endgameSlug: string }`
- Line 297: `readScorecards(atrisDir)` parses old and new separators and returns scorecard objects.

**Type Inference (commands/autopilot.js:2656):**

- Horizon slugs follow prefix-based type convention (e.g., `loop-*`, `wiki-*`, `verify-*`, `refactor-*`, `human-*`, `agent-*`)
- `scoreEndgameCandidates()` extracts type by splitting slug on first dash: `slug.split('-')[0]`
- Uses historical reward means per type to score and weight candidates
- Adaptive explore rate: 20% when diverse, up to 50% when last 5 are same type
- Difficulty floor: filters candidates with >80% success rate AND mean reward >5 when harder options exist
- Full convention rules in `atris/wiki/concepts/horizon-types.md`

**Data structure per scorecard:**

```
{
  endDate,           // ISO date when endgame closed (YYYY-MM-DD)
  slug,              // Horizon slug (e.g., "loop-self-seeds-horizons")
  tasksShipped,      // Count of completed tasks
  tasksAttempted,    // Count of started/completed tasks
  wallClockHours,    // Duration in hours (float, e.g., 18.5)
  haltRatio,         // Fraction of ticks that halted (0.0-1.0)
  totalReward,       // Sum of per-tick reward scores
  lessonsGenerated   // Count of lessons appended during endgame
}
```

**Usage:**

- Called by validator/autopilot when endgame completes (future wiring)
- Read by R5 task (`/endgame reads scorecards for historical reward weighting`)

**Search:** `rg "writeScorecard|detectEndgameCompletion" lib/scorecard.js`

## Concern: Output Quality Policies

- `test/review-corrections-gate.test.js`: CI ratchets repeated review corrections for bare test commands, hook-safe dispatch briefs, and database-backed endgame tasks; every rule proves a planted violation fails before checking the live repository.

## Engine dispatch default branch and refusals

- Readiness runtime selection: `lib/task-proof.js:157` uses `bash -lc`; a login profile can replace the caller's Node path. Reproduction and full failure evidence: `atris/receipts/readiness-runtime-proof-2026-10-14.txt`.

## Revision reports across out-of-order commit dates

Task verification receipts: `lib/task-receipt.js:46` resolves the bounded `ATRIS_VERIFY_TIMEOUT_MS` budget with the existing ten-minute default and one-hour ceiling; `lib/task-receipt.js:57` keeps actual timeout and launch-error results in nonpassing receipts. The caller Node selection and nonzero-exit checks remain intact. Real runtime and CLI regressions live in `test/task-receipt.test.js`; evidence rejection remains covered by `test/task-receipt-evidence.test.js`.
