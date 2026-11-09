# Packs, apps and integrations

Packs, apps, buying, Google and Slack integrations and outside CLI wrappers. Exact `file:line` refs and search shortcuts. Back to [MAP-NOTES.md](../MAP-NOTES.md).

## Quick Reference Index

**Explicit Pack recovery:** `commands/pack.js:2699` handles `pack run <existing-dir> --recover <receipt.json>`; `lib/pack-capabilities.js:488` validates the authoritative journal and prior failed exit, and `lib/pack-capabilities.js:890` prevents writes to completed files during recovery. `test/pack-run.test.js:2091` covers corrupt history and `test/pack-run.test.js:2232` exercises process exit and empty arguments. Contract and limits: `atris/features/pack-recovery/plan.md`.

## Search shortcuts: Modular commands

```bash
rg "meetCommand|buildBookingProfile|runPlainInterview|atris meet" commands/meet.js commands/interview.js bin/atris.js test/meet.test.js  # Meet command: non-technical onboarding in one sitting, init/theme/avail composition, local profile, booking link
rg "wantsLocal|errors --account|--approved|twitter post|slack send" commands/errors.js commands/integrations.js test/dogfood-pass3-27-28.test.js # errors --local by default; twitter/slack send need --approved
rg "githubCommand|createOfficialCliCommand|github cli wrapper|github help is workspace-free" bin/atris.js commands/github.js lib/official-cli-integration.js test/official-cli-integrations.test.js # github official cli wrapper: gh binary/auth detection plus pr list/create/checks/view passthrough
rg "vercelCommand|vercel cli wrapper|vercel help is workspace-free" bin/atris.js commands/vercel.js test/official-cli-integrations.test.js # vercel official cli wrapper: vercel binary/auth detection plus deploy/ls/logs/inspect passthrough
rg "supabaseCommand|supabase cli wrapper|supabase help is workspace-free" bin/atris.js commands/supabase.js test/official-cli-integrations.test.js # supabase official cli wrapper: supabase binary/auth detection plus status/db push/functions passthrough
rg "linearCommand|linear cli wrapper|linear help is workspace-free" bin/atris.js commands/linear.js test/official-cli-integrations.test.js # linear official cli wrapper: linear binary/auth detection plus issue list/create/view/update passthrough
rg "stripeCommand|stripe cli wrapper|stripe help is workspace-free" bin/atris.js commands/stripe.js test/official-cli-integrations.test.js # stripe official cli wrapper: stripe binary/auth detection plus listen/trigger/products passthrough
```

## By-Feature Map

MCP stdio request flow: `mcp/atris-mcp/index.mjs:142` reads requests while design calls run, tracks cancellations, and waits for pending replies on stdin close. `test/mcp.test.js` checks ping order, blank lines, cancellations, and stdin close.

- **atris buy / transactions:** `commands/buy.js` quote|approve|status on `/commerce/*` (POST with retries 0, never charges; approve returns the human's Link link or payment page; trades say to check texts, the code never reaches the CLI). `commands/transactions.js` GET `/transactions` as a when/kind/what/amount/state table. Shared helpers: `lib/commerce.js` (flag parse, cents, error envelope; bare 404 prints backend rolling out). Skill: `atris/skills/commerce/SKILL.md`. Tests: `test/commerce.test.js`.

- **atris meet:** `commands/meet.js` composes interview flags, `init`, `theme init`, and `avail` helpers to create a first profile plus a `/book/{username}` link with coverage in `test/meet.test.js`.

- **atris pack:** `commands/pack-craft.js:1` scaffolds a research pack with `atris pack craft "<topic>" [--dir <target>] [--force]`; `commands/pack.js` publishes, installs, updates, lists, and runs packs, preserves browser-authored visibility, price, and a declared in-pack verifier path while rebuilding manifests, generates complete canonical SHA-256 `content-hashes` maps on publish, verifies every declared digest before install/update state or writes, rejects signed byte changes hidden behind an unchanged version, reports verified/partial/failed/absent hash truth in inspect, validates a single root manifest plus normalized paths and symlink-safe destinations before archive writes, records successful remote observations in `.atris/state/pack.json`, routes registry and URL updates through one semantic-version gate, rejects downgrades unless `--allow-downgrade` is explicit, stages every accepted update in `.upstream/` without overwriting installed files, reports installed, origin, remote-check, and staged-review truth, resolves `atris pack show <slug|dir>` into an eight-line student card with purpose, readiness, local location, download/update truth, plain access, verifier availability, and one next command, keeps `atris pack inspect <slug|dir> [--json]` as the expert read-only location, declared description, origin, provenance, entry-contract, non-executed verifier availability, capability, update-state, file-summary, and hash-truth report, names every uncovered installed content path even when hashes are wholly absent, and emits one versioned automation object for success, help, and failures, classifies local contracts as ready/revise/reject through the offline, read-only `atris pack doctor <slug|dir> [--json]` integrity, capability, entrypoint, payload, provenance, and obvious lexical-alignment checks, prints source-aware install destination/source/git preflight before writing, hands successful installs to the student card before a bounded `pack run`, never recommends raw Claude execution that bypasses the pack boundary, resolves manifest entrypoints and `RUN.md`, accepts one capped local regular UTF-8 `--input` file for an enforced run while injecting only its bytes and receipting only size plus digest, forces that evidence path headless, and pipes the separated opening/evidence envelope to Claude stdin with `--print` so it never enters runner argv, exposes declared shipped skills through a transient skills-only Claude plugin whose frontmatter is projected through a safe metadata allowlist, runs packets with honest zero-context orientation, refuses unbounded `--trust` for legacy packs while pointing users to explicit grants, and provides read-only `atris pack runs` history whose derived `launcher-lost` state says Atris lost lifecycle control without claiming the runner stopped or rewriting receipt evidence; `commands/console.js` preserves interactive no-input runs while providing the stdin opening-prompt transport; `lib/pack-capabilities.js` defines the canonical `pack.read`, `pack.write`, `web.read`, and high-risk `host.shell` vocabulary, maps declarations plus explicit per-run `--grant` escalations to an exact local Claude tool ceiling, rejects symlinked declared execution trees before Atris gathers pre-launch context, disables Claude memory files, auto-memory, Chrome integration, and headless session persistence while disclosing interactive transcript and workspace-trust behavior, records opening-prompt stdin/argv truth, disables user/project extension discovery, skill approval/hook controls, and invisible skill shell preprocessing while importing only user deny rules and requesting subprocess credential scrubbing, confines built-in file tools to the pack root, preflights WebFetch destinations against literal and DNS-resolved local/private addresses while disclosing DNS-rebinding limits, blocks project settings and MCP discovery, makes `--trust` the only pack-run pre-approval switch inside that ceiling, writes requested/granted/used receipts with direct slash-skill coverage limits and launcher identity, records sanitized Claude session-end reasons, distinguishes exit-unconfirmed ended sessions from live runs, and fails declared-capability cloud runs closed until cloud can enforce the same contract; `lib/zip.js` provides zero-dependency zip reads and writes with pre-inflation archive, entry-count, per-entry, and aggregate unpacked limits plus post-inflation size and checksum verification; `bin/atris.js` routes the command; `test/pack*.test.js` and `test/zip.test.js` cover publishing, install/update/pull/status, craft/run/share, show/doctor/inspect, install preflight, run orientation, operator-input stdin/argv privacy, capability enforcement and receipts, sanitized skill loading, packet safety, and adversarial ZIP resources.
  Doctor readiness counts non-empty binary files and text with usable content; empty or whitespace-only text cannot qualify through a title-matching filename alone. Promise alignment uses declared description rather than title identity and emits reproducible bounded lexical evidence: promise source/tokens, payload paths, per-file text bytes scanned, generated/empty exclusions, limits, and overlap; missing description revises instead of inventing a promise. JSON mode returns one versioned object for verdicts, help, usage failures, pack-resolution failures, and invalid local artifacts.
  Sealing: `atris pack seal <dir> [--type <t>] [--entrypoint <file>]` fills only missing contract fields, always rebuilds canonical content hashes without hashing `pack.json`, and prints the existing doctor verdict; `test/pack.test.js` covers ready sealing, explicit-field preservation, resealing, and self-hash exclusion.
  Sharing and discovery: `buildManifest` is visibility-aware (`--visibility public|unlisted|private`; new packs default unlisted while legacy omissions stay unchanged), `atris pack share <slug> --for "<Name>" [--days N]` lists, mints, and revokes authenticated signed share links individually or in bulk with a public-only `?for=` fallback, `atris pack browse [--mine]` lists up to 50 registry packs with owner visibility, optional prices, and optional stars, `atris pack sales` shows authenticated seller earnings, and `atris pack purchases` lists a buyer's authenticated purchases; unpaid `atris pack install <slug>` (and registry pull/update) treats a paid pack without entitlement, or an empty/402/403 download, as a buy barrier: `lib/pack-core.js:719` `paidPackBarrierFromResponse` and `lib/pack-core.js:780` `printPaidPackBarrier` print the pack name, price when the API sends `price_cents`/`priceCents`, the pack page to buy, and `atris login` to link an existing purchase, then exit nonzero without writing an empty install; `test/pack-share.test.js` covers signed sharing, link listing, individual and bulk revocation, fallback safety, browse auth/table/caps, and seller sales output/auth, and `test/pack.test.js` covers unpaid paid-pack install copy plus no-write, refunded sales, and buyer purchase output/auth in addition to browse pricing.

## Feature: App Pack Wrapper (`atris apps`)

**Purpose:** Keep local APP.md app-pack operations machine-readable and load owned cloud apps without booting the heavier natural-language workspace path.

- **Dispatch:** `bin/atris.js` routes `apps` directly into `commands/apps.js` before natural-language planning
- **Handler:** `commands/apps.js` (`appsCommand`)
- **Cloud load:** `commands/apps.js` handles `apps load|cloud|mine [--filter kind] [--json]` through `/api/apps` with `atris login` credentials and no local app-pack requirement
- **JSON helpers:** `commands/apps.js:48-72` normalize `apps --json` to `list --json` and route JSON errors through `exitAppsError`
- **Missing pack:** `commands/apps.js:169-179` returns `{ ok:false }` when the pack is missing under JSON mode
- **Usage errors:** `commands/apps.js:215-236` keeps `run|owner --json` missing slug and unknown subcommands machine-readable
- **Manifest reader:** `commands/apps.js:85-127` parses app `APP.md` frontmatter into agent-readable JSON
- **Regression:** `test/apps.test.js` covers `apps --json` shorthand, missing-pack JSON errors, cloud load JSON/auth behavior, JSON usage errors, and unknown-command JSON usage

**Search:** `rg "appsCommand|loadCloudApps|exitAppsError|findAppsPackRoot|listAppManifests|apps load|apps --json|apps unknown" commands/apps.js test/apps.test.js bin/atris.js`

## Feature: Autoland (`atris autoland`)

- **Trust tiers:** `lib/trust-tiers.js` derives deterministic trusted, standard, or probation gates from the last 20 member/engine outcomes; standard work gets a strict verifier rerun and probation work also needs independent review, while `lib/autoland.js` renders only plain-word operator labels

## Feature: github cli integration (`atris github`)

**Purpose:** Agent-friendly wrapper for the official `gh` cli with binary detection, auth status, and pull request operations.

- **Command:** `commands/github.js:3` (`githubCommand`)
- **Shared wrapper:** `lib/official-cli-integration.js:184` (`createOfficialCliCommand`)
- **Help line:** `bin/atris.js:616` (`github cli wrapper`)
- **Known command:** `lib/known-commands.js:7` (`github`)
- **Routing:** `bin/atris.js:2141` (`command === 'github'`)
- **Subcommands:** `commands/github.js:12` (`pr list`), `commands/github.js:18` (`pr create`), `commands/github.js:24` (`pr checks`), `commands/github.js:30` (`pr view`)
- **Regression:** `test/official-cli-integrations.test.js:38` (workspace-free help), `test/official-cli-integrations.test.js:53` (missing `gh` install hint), `test/official-cli-integrations.test.js:67` (auth status), `test/official-cli-integrations.test.js:84` (passthrough args)

**Search:** `rg "githubCommand|github cli wrapper|github help is workspace-free" bin/atris.js commands/github.js test/official-cli-integrations.test.js`

## Feature: vercel cli integration (`atris vercel`)

**Purpose:** Agent-friendly wrapper for the official `vercel` cli with binary detection, auth status, and deployment operations.

- **Command:** `commands/vercel.js:3` (`vercelCommand`)
- **Shared wrapper:** `lib/official-cli-integration.js:184` (`createOfficialCliCommand`)
- **Help line:** `bin/atris.js:617` (`vercel cli wrapper`)
- **Known command:** `lib/known-commands.js:7` (`vercel`)
- **Routing:** `bin/atris.js:2144` (`command === 'vercel'`)
- **Subcommands:** `commands/vercel.js:12` (`deploy`), `commands/vercel.js:18` (`ls`), `commands/vercel.js:24` (`logs`), `commands/vercel.js:30` (`inspect`)
- **Regression:** `test/official-cli-integrations.test.js:100` (workspace-free help), `test/official-cli-integrations.test.js:115` (missing `vercel` install hint), `test/official-cli-integrations.test.js:129` (auth status), `test/official-cli-integrations.test.js:146` (passthrough args)

**Search:** `rg "vercelCommand|vercel cli wrapper|vercel help is workspace-free" bin/atris.js commands/vercel.js test/official-cli-integrations.test.js`

## Feature: supabase cli integration (`atris supabase`)

**Purpose:** Agent-friendly wrapper for the official `supabase` cli with binary detection, auth status, and project/database/function operations.

- **Command:** `commands/supabase.js:3` (`supabaseCommand`)
- **Shared wrapper:** `lib/official-cli-integration.js:184` (`createOfficialCliCommand`)
- **Help line:** `bin/atris.js:618` (`supabase cli wrapper`)
- **Known command:** `lib/known-commands.js:7` (`supabase`)
- **Routing:** `bin/atris.js:2147` (`command === 'supabase'`)
- **Subcommands:** `commands/supabase.js:13` (`status`), `commands/supabase.js:19` (`db push`), `commands/supabase.js:25` (`functions list`), `commands/supabase.js:31` (`functions deploy`)
- **Regression:** `test/official-cli-integrations.test.js:226` (workspace-free help), `test/official-cli-integrations.test.js:241` (missing `supabase` install hint), `test/official-cli-integrations.test.js:255` (auth status), `test/official-cli-integrations.test.js:272` (status passthrough), `test/official-cli-integrations.test.js:288` (db passthrough)

**Search:** `rg "supabaseCommand|supabase cli wrapper|supabase help is workspace-free" bin/atris.js commands/supabase.js test/official-cli-integrations.test.js`

## Feature: linear cli integration (`atris linear`)

**Purpose:** Agent-friendly wrapper for the official `linear` cli with binary detection, auth status, and issue operations.

- **Command:** `commands/linear.js:3` (`linearCommand`)
- **Shared wrapper:** `lib/official-cli-integration.js:184` (`createOfficialCliCommand`)
- **Help line:** `bin/atris.js:619` (`linear cli wrapper`)
- **Known command:** `lib/known-commands.js:7` (`linear`)
- **Routing:** `bin/atris.js:2150` (`command === 'linear'`)
- **Subcommands:** `commands/linear.js:12` (`issue list`), `commands/linear.js:18` (`issue create`), `commands/linear.js:24` (`issue view`), `commands/linear.js:30` (`issue update`)
- **Regression:** `test/official-cli-integrations.test.js:304` (workspace-free help), `test/official-cli-integrations.test.js:319` (missing `linear` install hint), `test/official-cli-integrations.test.js:333` (auth status), `test/official-cli-integrations.test.js:350` (passthrough args)

**Search:** `rg "linearCommand|linear cli wrapper|linear help is workspace-free" bin/atris.js commands/linear.js test/official-cli-integrations.test.js`

## Feature: stripe cli integration (`atris stripe`)

**Purpose:** Agent-friendly wrapper for the official `stripe` cli with binary detection, auth status, and webhook/product operations.

- **Command:** `commands/stripe.js:3` (`stripeCommand`)
- **Shared wrapper:** `lib/official-cli-integration.js:184` (`createOfficialCliCommand`)
- **Help line:** `bin/atris.js:620` (`stripe cli wrapper`)
- **Known command:** `lib/known-commands.js:7` (`stripe`)
- **Routing:** `bin/atris.js:2153` (`command === 'stripe'`)
- **Subcommands:** `commands/stripe.js:12` (`listen`), `commands/stripe.js:18` (`trigger`), `commands/stripe.js:24` (`products list`), `commands/stripe.js:30` (`products create`)
- **Regression:** `test/official-cli-integrations.test.js:366` (workspace-free help), `test/official-cli-integrations.test.js:381` (missing `stripe` install hint), `test/official-cli-integrations.test.js:395` (auth status), `test/official-cli-integrations.test.js:412` (listen passthrough), `test/official-cli-integrations.test.js:428` (products passthrough)

**Search:** `rg "stripeCommand|stripe cli wrapper|stripe help is workspace-free" bin/atris.js commands/stripe.js test/official-cli-integrations.test.js`

## Feature: Integrations (`atris gmail/calendar/twitter/slack/integrations`)

**Purpose:** External service integrations - email, calendar, social, messaging

- **Entry point:** `commands/integrations.js`, shared helpers in `lib/integrations-core.js`
- **Commands:**
- `atris gmail inbox [--account <id>]` (`commands/integrations.js:99`, `gmailInbox`): lists messages and names the resolved mailbox when its email is known
- `atris gmail triage [--account <id>] [--limit N]` (`commands/integrations.js:159`, `gmailTriage`): reads recent inbox messages, records the deterministic rule reason, and appends keep or archive verdicts without changing the mailbox
- `atris gmail verdicts --summary [--account <id>]` (`lib/integrations-core.js:146`, `printGmailVerdicts`): groups the full verdict log by day and account with keep and archive counts; legacy rows without reasons remain readable
- `atris gmail send <to> <subject> <body...> [--account <id>]` (`commands/integrations.js:275`, `gmailSend`): resolves the server default mailbox, verifies it is connected, and sends the joined body or `--body-file` contents
- `atris gmail voice [account] [--clear]` (`commands/integrations.js:308`, `gmailVoice`): edits, pipes, or clears per-account `voice_md` through the Gmail account API
- `atris gmail connect [name]` (`commands/integrations.js:535`, `gmailConnectUnified`): starts browser auth and polls its sign-in status; unbound scratch folders refuse `atris gmail connect` via the same `requireAccountBound` lock (exit 2, no Gmail network, no OAuth)
- `atris gmail accounts` (`commands/integrations.js:385`, `gmailAccounts`): prints the default-first, aligned account roster and marks the active account
- `atris gmail use [<account_id|name>]` (`commands/integrations.js:398`, `gmailUse`): picks an account interactively or resolves an id/display name and saves the choice on the server and keeps a local copy
- Gmail dispatch and help live in `commands/integrations.js:633` (`gmailCommand`); unbound scratch folders refuse bare `atris gmail` via `requireAccountBound` before this runs
- `atris calendar [today|week]` (`commands/integrations.js:888`): Calendar events
- `atris twitter [post <text>]` (`commands/integrations.js:1010`): Twitter posting
- `atris slack [channels]` (`commands/integrations.js:1205`): Slack channel listing; unbound scratch folders refuse every slack verb via `requireAccountBound` before this runs
- `atris integrations` (`commands/integrations.js:1279`): Show status of all integrations
- **Auth:** Uses `getAuthToken()` (`lib/integrations-core.js:415`) from `~/.atris/credentials.json`
- **Routing:** `bin/atris.js:3047` (`command === 'gmail'`) and `bin/atris.js:3102` (`command === 'slack'`): use `requireAccountBound`, or a named business for gmail; both extract `--account <id>` first and do not treat that selector as the workspace opt-in, so scratch `gmail send --account foo` and `slack send --account foo` refuse like the bare verbs; a refused gate returns before `gmailCommand` / `slackCommand` so send cannot fall through; `--help` still prints usage
- **Help:** `bin/atris.js:1098` (`showIntegrationsHelp`) routes `integrations --help` before auth/session state or backend status checks; Gmail subcommand help is in `commands/integrations.js:660`
- **Gmail regressions:** `test/gmail-triage.test.js` (rule reasons, verdict log rows, read-only Gmail calls), `test/gmail-verdicts.test.js` (legacy rows, reason passthrough, daily account summaries), `test/gmail-account.test.js:99` (connect validation), `test/gmail-account.test.js:129` (poll success), `test/gmail-account.test.js:182` (timeout), `test/gmail-account.test.js:298` (inbox mailbox header), `test/gmail-account.test.js:386` (send request), `test/gmail-account.test.js:436` (unowned send refusal), `test/gmail-account.test.js:471` (send usage), `test/gmail-account.test.js:501` (voice clear), `test/gmail-account.test.js:531` (piped voice), `test/gmail-account.test.js:564` (account roster), `test/gmail-account.test.js:610` (interactive display-name picker), `test/dogfood-pass3-27-28.test.js` (unbound scratch `gmail connect`, `gmail send --account foo`, and `slack send --account foo` exit 2 with no network, lookup, or send)
- **Regression:** `test/commands-2.test.js:1468-1483` covers integrations help without login errors or `.atris` creation
- **Value:** Manage external services without leaving the CLI

**Search:** `rg "gmailInbox|gmailTriage|gmailTriageVerdict|printGmailVerdicts|gmailSend|gmailVoice|gmailConnect|gmailAccounts|gmailUse|gmailCommand|calendarCommand|twitterCommand|slackCommand|integrationsStatus|showIntegrationsHelp|integrations --help|--approved|requireAccountBound" bin/atris.js commands/integrations.js lib/account-bound.js test/gmail-triage.test.js test/gmail-verdicts.test.js test/gmail-account.test.js test/commands-1.test.js test/dogfood-pass3-27-28.test.js`

## Revision reports across out-of-order commit dates

Pack CLI test runner: `test/helpers/pack-cli.js:8` binds each original fifteen- or twenty-second limit; `test/helpers/pack-cli.js:10` retains the real synchronous child, full inherited environment, caller overrides last, UTF-8 and original launch-error/result behavior. Craft, show and safety tests keep their private fixtures and every behavior check. Check: `node --test test/pack-craft.test.js test/pack-show.test.js test/pack-safety.test.js`.

## google account commands

- Account request context and business header: `lib/integrations-core.js:30`; capability checks: `lib/integrations-core.js:252`; mail default migration: `lib/integrations-core.js:273`; selector resolution: `lib/integrations-core.js:369` checks exact names and emails before display labels and refuses ambiguous matches.
- Google account cache, sign-in and commands: `lib/integrations-core.js:605`, `lib/integrations-core.js:620`, `commands/integrations.js:446`, `commands/integrations.js:544`. Retry and json failure formatting live at `lib/integrations-core.js:649` and `lib/integrations-core.js:653`. Modern sign-in uses its own status and explains incomplete results; older mail sign-in remains unconfirmed. Account lists show reconnect commands in text and json.
- Calendar ordering, partial results and scoped search errors: `lib/integrations-core.js:716`, `lib/integrations-core.js:733`, `commands/integrations.js:888`. Router: `bin/atris.js:3072`. Tests: `test/google-accounts.test.js`, `test/google-accounts-http.test.js`.
