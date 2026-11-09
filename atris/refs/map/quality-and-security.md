# Quality and security

Slop checks, voice, design checks, outbound gates, local HTTP server safety and the sentinel security audit. Exact `file:line` refs and search shortcuts. Back to [MAP-NOTES.md](../MAP-NOTES.md).

## Search shortcuts: Modular commands

```bash
rg "syncAtris|upsertAtrisClaudeBootBlock|upsertClaudeVoiceHook|upsertCursorVoiceCard|upsertAgentVoiceCard" commands/sync.js lib/claude-boot-block.js lib/voice-card.js test/claude-boot-block.test.js test/voice-card.test.js  # Update/sync command, shared root CLAUDE.md block updater, and idempotent voice-card refresh that preserves user settings and marker-external text
rg "brainCommand|collectState|countStateRows|certifiedReviewTasks|latestTaskEpisodes|latestScorecard|isActionableScorecardNextMove|operatorActivationNextMove|normalizeMemberSlug|memberProfileIssues|renderMissingMemberCard|renderPlaceholderMemberCard|recordTaskEpisodeScorecards|renderActivationCard|modeNextMove|renderActivationGallery|readMemberContext|rememberOperator|recordFeedback|recordApproval|voiceCardForRoot|brain --help" commands/brain.js lib/voice-card.js test/commands-1.test.js test/voice-card.test.js  # Brain compile/activate/gallery/feedback/approval/scorecard, certified review routing, workspace-free help, and doctrine-driven AGENTS/Cursor voice-card refresh
```

## Search shortcuts: Documentation

```bash
rg "Phase 1" atris.md                       # Agent generation spec
rg "outbound artifact gate|raw-html-in-plain-body|render-proof-missing|coach-surface|coach-signal-proof-missing" atris/policies/outbound-artifact-gate.md atris/policies/day-loop-voice.md scripts/outbound-artifact-gate.js test/outbound-artifact-gate.test.js  # Human-facing send gate: no raw HTML/source artifacts, render proof for HTML/visual sends, anti-slop copy check, and day-loop coach boundaries with fresh-signal proof for warm pings
---
```

## By-Feature Map

Design/MCP test isolation: `test/mcp.test.js:66` starts the CLI from its disposable directory. `commands/design.js:360` and `lib/design-api.js:124` export only consumed entry points; `test/repo-hygiene.test.js` guards both boundaries.

- **atris design + mcp:** `commands/design.js` runs `design extract <url> [--json] [--sections a,b]` (POST `/design/extractions` then polls `GET /design/extractions/{id}` every 3s up to 3m), `design check <url> --against <brand-url>` (`/design/adherence`), and `design search "<words>" [--limit n]` (`/design/search`); `lib/design-api.js` resolves the key (ATRIS_API_KEY, then login token, then `~/.atris/design-api-key`), wraps `utils/api.js` `httpRequest` against `getApiBaseUrl()`, and owns `pollDesignJob` plus the credits/balance line. `mcp/atris-mcp/index.mjs` uses built-in stdio JSON-RPC, no dependencies, to expose `design_extract`, `design_check`, `design_search` through `atris mcp` and the `atris-mcp` bin; `bin/atris.js` skips the update check for `mcp` so stdout stays clean JSON-RPC. Dispatch: `bin/atris.js` `command === 'design'` and `command === 'mcp'`. Registry: `lib/known-commands.js`. Tests: `test/design.test.js` (mocked HTTP, three commands plus polling), `test/mcp.test.js` (stdio handshake, tools, and errors). Docs: `docs/MCP.md`.

## Feature: Autoland (`atris autoland`)

- **Whitespace refusal text:** `lib/voice-gate.js:253` explains `non_falsifying_verify` with an action to add a real check; `test/landing-reasons.test.js:51` inventories the gate's reason codes and requires plain sentences.

- **Shared human voice gate:** `lib/voice-gate.js` reuses the autoland clarity helpers to scan and deterministically clean operator prose without silently dropping unresolved details; task review landing fields and group summaries, mission human status, and the autoland tick summary use the shared gate. Regression: `test/voice-gate.test.js`

- **Reply voice command and pinned card:** `commands/voice.js` routes `atris voice scan` to `scripts/det/voice.js`, asks one optional small model to judge shape and plainness, and prints the deterministic `atris voice card [--hook]` payload. `lib/voice-card.js` composes the card from `atris.md ## voice`, merges the Claude UserPromptSubmit hook without clobbering settings, and upserts marked Cursor/AGENTS copies. Init, sync, and brain compile wire or refresh the three doors; regressions live in `test/voice-command.test.js` and `test/voice-card.test.js`.

## Concern: Output Quality Policies

- `scripts/outbound-artifact-gate.js`: Cheap validator for raw HTML/source sends, missing render proof, and slop copy

- `test/outbound-artifact-gate.test.js`: Regression coverage for the Justin raw-HTML failure class

- `commands/slop.js`: deterministic frontend and prose rules live in `RULES` and `PAIR_RULES`; `scanPaths()` (`:247`) exposes the same scanner for exact candidate paths and optional changed-line maps. CLI `detect --fix/--diff/--staged` uses project rules from `.atris/slop.rules.json`; `slop dead` provides require-graph and orphan-export checks. Regressions: `test/slop.test.js`, `test/repo-hygiene.test.js`.

- `commands/strings.js` (`stringsCommand`): content design system from live code (WHAT words you ship): `scan` extracts user-facing strings → `.atris/strings.json` (`isUserFacing` `:53`, `extractStrings` `:75`), `variants` flags the same string written N ways (`variantClusters` `:112`), `term --ban/--prefer` codifies preferred terms, `check --staged` gates banned terms (exit 1, reuses slop's `gitChangedLines`); wired in `bin/atris.js` `command === 'strings'`

- `test/strings.test.js`: extraction precision, variant clustering, and scan→variants→term→check round trip

- `lib/taste-lessons.js` (`addTaste`, `listTaste`, `matchTaste`) - stores scoped operator verdicts in `atris/taste.json`, ranks keyword and surface matches, and caps the owner's taste section appended by `lib/fleet.js`; CLI: `commands/taste.js`, routing/help: `bin/atris.js`, regression: `test/taste.test.js`

**Search:** `rg "slop|kill list|outbound artifact gate" policies/ scripts/outbound-artifact-gate.js` · commands: `rg "stringsCommand|variantClusters|isUserFacing" commands/strings.js`

## Local HTTP server security

- Phone request parsing and credentials: `lib/gm-phone.js:305`; bounded body reader: `lib/gm-phone.js:332`; handler: `lib/gm-phone.js:368`; listener rejection fallback: `commands/gm.js:1536`. Wifi pairing stays available on the selected network interface plus loopback.
- Static preview: `lib/site.js:104`, GET/HEAD only, loopback Host checks and binding, rejects malformed URLs and request bodies.
- Credential gateway: `lib/secret-gateway.js:240`, unchanged read-only grant, placeholder credential, local Host checks, body rejection and loopback binding.
- Benchmark denial listener: `scripts/det/xsearch-bench.js:129`, loopback only and unconditional 401, exported for real HTTP tests.
- Proof and user-visible changes: `atris/receipts/local-http-security.md`.

## Sentinel security audit

- `atris sentinel` dispatches to `commands/security-review.js:600` (`auditCommand`), same as `atris security-review audit`. Method adapted from cloudflare/security-audit-skill (MIT).
- Map: `lib/security-audit.js:267` (`mapTarget`) turns tracked source files x attack classes (`lib/security-audit-classes.js`) into a sorted coverage ledger; no model call. Quick profile groups by subsystem.
- Additive runs: `lib/security-audit.js:412` (`mergePrior`) keeps unchanged covered areas, re-checks old findings through the verifier (areas held in `reserved_for`), and reloads `carried-pending.json` so a cheap run never drops a finding.
- Contracts: `lib/security-audit.js:483` (`validateLedger`, the state table) and `lib/security-audit.js:577` (`validateFindings`; with root set every cited file:line must resolve). `lib/security-audit.js:1070` (`citationErrors`) rejects dead citations before any verifier spend.
- Run: `lib/security-audit.js:1355` (`runAudit`) hunters on `--hunter` (codex), critic, verifier and final recheck on `--verifier` (claude) via `runEngineAskJobs` read-only. Output under `~/.atris/security-audit/<repo>/run-<N>/` (`ATRIS_SECURITY_AUDIT_HOME` overrides); refuses any folder inside the target unless git ignores it. Exit 1 on a confirmed high or critical.
- Atris models (`--engine atris`): hunters on `atris:fast`, critic and verifier on `atris:pro`. `lib/sentinel-cloud.js:64` (`resolveEngines`) keeps codex/claude the default and picks atris only with no local engine and a login.
- What may leave: `lib/security-audit.js:698` (`hostedAllowedFiles`) is the only file set a hosted engine sees (tracked, not ignored, in scope, no keys or .env-style files); candidates citing anything else are rejected before a hosted verifier. `lib/security-audit.js:763` (`withHostedSource`) adds numbered source from that set. `lib/sentinel-cloud.js:155` (`redactOutgoing`) runs on every message in `runAtrisTurn` (`lib/sentinel-cloud.js:183`): whole private key blocks, any line matching a secret rule raw (no allow markers) and long base64 or hex runs are hidden.
- Spend: `lib/security-audit.js:1343` (`spendEstimate`) prices every budgeted call at its largest allowed size (one token per byte) and full output limit; `lib/sentinel-cloud.js:307` (`quoteEstimate`) quotes it and `opts.confirmSpend` must say yes (or `--yes`). `lib/sentinel-cloud.js:247` (`atrisJobRunner`) holds each call's own quoted worst case against the approved limit before it starts, counts receipts after and sends `max_output_tokens`.
- Upload: `lib/sentinel-cloud.js:407` (`buildUploadBody`) maps a run folder to the `POST /api/sentinel/runs` contract; each sentence is kept only if it is plain prose (letters, digits, spaces and . , ' ( ) : -, no dotted, camelCase or 20+ character words, no secret match), else it becomes "See the full report on your machine." File:line is checked on its own. The fix sent is `remediation.summary`, a plain sentence the prompts ask for; the code-level `strategy` stays in the local report. The guarantee and its accepted limit sit above `plain()`. `lib/sentinel-cloud.js:469` (`uploadRun`). On by default when logged in, `--no-upload` skips, `atris sentinel upload [run-folder]` is `commands/security-review.js:489`. A failed upload only warns.
- Timer: `atris sentinel schedule --every day|week [--engine atris --max-credits N] [path]` is `commands/security-review.js:522`. The engine is fixed at install; atris needs a priced yes and stores a per-run cap via `lib/sentinel-cloud.js:516` (`writeApproval`). `lib/sentinel-cloud.js:484` (`schedulePlan`) reuses `lib/campaign-keep.js`, the same launchd/cron path as `atris worktree sweep --install` and runs `atris sentinel --quick --scheduled` that reads only that approval.
- Free checks: `atris sentinel agents|guard|watch|flush` dispatch at `commands/security-review.js:612` to `commands/sentinel-powers.js`. A scheduled run calls `commands/sentinel-powers.js:246` (`runScheduledFreeChecks`) once its approval reads, before the paid review: `scan_started`, agent_check and threat events, `scan_finished`.
- Agent setup check: `lib/sentinel-agents.js:123` (`RULES`, the fixed sentences per finding), `lib/sentinel-agents.js:439` (`checkFile`: secrets, permissions, hooks, mcp, hidden text by file role), `lib/sentinel-agents.js:503` (`runAgentCheck`, grades per area; `--home` adds ~/.claude, ~/.claude.json mcp servers, ~/.codex). Fingerprints hold rule, file and a key, never a secret value.
- Action guard: `lib/sentinel-guard.js:599` (`decide`) reads the command like a shell through `commandsOf` (:244: quotes, pipes, sh -c, sudo/env/xargs wrappers, program paths, git global options) then runs `checkExfil` (:406, fail closed: with a secret var, auth header or user:password, every positional word is a destination and each must parse to a trusted `URL` hostname), `checkDestroy` (:427, SQL deletion only with a database client) and `checkDisarm` (:507, shell writes to any Claude settings file or guard file, every target resolved against the command folder first); edits must keep the guard entry and matcher unchanged. The guarantee and accepted limits sit at the top of the file; `lib/sentinel-guard.js:704` (`hookMain`) exits 2 on block and 0 on its own errors (fail open, logged to `~/.atris/sentinel/guard-errors.log`). `lib/sentinel-guard.js:636` (`recordBlock`) writes `guard.log` (time, program, rule and a short hash only, never command text) and queues a `blocked` event; `lib/sentinel-guard.js:686` (`kickFlush`) starts a detached `atris sentinel flush` at most once a minute. The file stands alone because `lib/sentinel-guard-install.js:115` (`install`) copies it into `.claude/hooks/`. Trusted hosts for secrets: `~/.atris/sentinel/guard.json`.
- Dependency watch: `lib/sentinel-watch.js:309` (`runWatch`) parses seven lockfile kinds, skips and counts any name or version without a real package shape, calls OSV `/v1/querybatch` then `/v1/vulns/<id>` (`ATRIS_OSV_BASE` overrides); `lib/sentinel-watch.js:221` (`fixedVersionFor`) picks the lowest fix above the version in use. `lib/sentinel-watch.js:440` (`applyFix`) refuses a dirty tree, branches `sentinel/fix-dependencies-<stamp>`, commits there, never pushes.
- Events: `lib/sentinel-events.js:119` (`makeEvent`) builds the v2 contract body and reruns the review `plain()` allowlist (versions and shape-checked package names masked); `lib/sentinel-events.js:86` (`fillPlain`) fills fixed templates with shape-checked slots. `lib/sentinel-events.js:240` (`reportFindings`) adds a resolved copy of each finding gone since the last good upload; state moves only on success. `lib/sentinel-events.js:278` (`flushQueue`) puts unsent events back.
- Regression: `test/sentinel-powers.test.js` (each agents rule positive and negative, guard samples and hook exit codes, install in temp HOME, lockfile parsers, fake OSV and events server, resolve on a later run, upload failure, `--fix` branch, scheduled events), `test/security-audit.test.js`, `test/sentinel-cloud.test.js` (fake backend: quote then confirm, model routing, exact upload body, upload failure, `--no-upload`, schedule install/uninstall, secret and scope leaks, schedule approval, spend cap).
