# Auth and config

Login and logout, tokens and refresh, the API client, config files, the auto update check and portable local roots. Exact `file:line` refs and search shortcuts. Back to [MAP-NOTES.md](../MAP-NOTES.md).

## Quick Reference Index

| Route | Paths | Purpose |
| --- | --- | --- |
| Portable local roots and owner | `utils/backend-root.js:10`, `utils/backend-root.js:31`, `utils/config.js:18`, `utils/owner-identity.js:17`, `lib/fleet.js:1324`, `commands/autopilot.js:34`, `commands/study.js:94`, `lib/codex-flight.js:101`, `lib/business-core.js:11`, `test/no-hardcoded-home-paths.test.js:42`, `test/no-hardcoded-home-paths.test.js:80` | Backend lookup uses the environment or workspace config, then the workspace and installed CLI siblings. NODE_TEST_CONTEXT skips only the install sibling; ATRIS_BACKEND_INSTALL_SIBLING=1 opts in, 0 disables it even outside tests. The install-layout regression exercises both the test fence and normal discovery. Study prefers the workspace study folder before the backend root. Codex companion lookup uses an override or the newest installed version. Owner checks use the signed-in account or configured operator, then git and local user names when logged out. Sealed fleet children inherit the resolved owner names. Autopilot skips human claims. Business workspace prompts use the configured folder. |

- Login token isolation: `utils/auth.js:487` (`saveCredentials`) refuses scoped tokens in the login field; `utils/auth.js:512` (`loadCredentials`) repairs legacy files through refresh for authenticated callers while synchronous local reads stay offline. `commands/auth.js:126` (`isAgentAccessToken`), `scopedTokenCandidate`, and `canMintFromLogin` reuse matching scoped keys without reminting from agent-only credentials. `utils/auth.js:552` (`readCredentials`) preserves placed-file precedence; `utils/auth.js:254` (`loadLeftoverCredentialsAgentToken`) and `utils/auth.js:274` (`loadLeftoverProfileAgentToken`) preserve scopes and expiry when the environment repeats a saved agent token. `commands/auth.js:154` (`persistMintedAgentToken`) keeps environment credentials off disk, including saved profiles; `commands/auth.js:281` (`ensureBilledCommandAuth`) caches environment mints per login, API base and requested scope until expiry, with forced replacement evicting rejected tokens. `utils/auth.js:13` (`openBrowser`) passes URLs directly to native launchers with no shell. Regression: `test/auth-security.test.js`, `test/auth-login-storage.test.js`, `test/auth-agent-token.test.js`, `test/auth-placed-token.test.js`, `test/billed-command-auth.test.js`.

**Feature maps (driving the running product, not the code):** `atris/refs/FEATURE-MAP-ax.md`: ax chat app screens, keys, slash commands, and how to verify against the live app. UI work on ax starts there, not with a grep.

## Search shortcuts: Core CLI logic

```bash
rg "atrisFastChat|atrisFastOnce|streamProChat|text_delta|Usage: atris fast" bin/atris.js utils/api.js test/commands-1.test.js test/api-stream.test.js  # Atris2 Fast one-shot chat CLI and SSE text_delta streaming
```

## Search shortcuts: Modular commands

```bash
rg "loginAtris|mintAgentToken|mintScopedAgentToken|ensureBilledCommandAuth|parseAgentTokenArgs|--agent|agent-token|showAuthHelp|--global|scope" bin/atris.js commands/auth.js lib/cli-scope.js test/auth-agent-token.test.js test/billed-command-auth.test.js test/dogfood-p1.test.js # Auth/account commands, scoped agent-token mint from stored JWT (`atris login --agent`), billed-command auto-mint via ensureBilledCommandAuth, and workspace vs --global account list
rg "formatCliVersionLine|inspectInstallGitState|dirty git checkout|version_line" utils/update-check.js commands/doctor.js bin/atris.js test/dogfood-pass2-t1-t5.test.js  # Git checkout --version shows sha/dirty/branch; doctor --json warnings
rg "addTask|claimTask|doneTask|appendTaskCompletionLogs|appendTaskWorkLog|listTasks|workspaceRoot|findWorkspaceRoot|isGenericScratchRoot|isUnboundScratchFolder|isUnderGenericScratchRoot" lib/task-db.js lib/scratch-root.js lib/mission-root.js commands/spaceship.js commands/autopilot-front.js test/scratch-root-room.test.js test/dogfood-spaceship-scratch.test.js  # SQLite task store + workspace walk-up; scratch roots (/tmp, /private/tmp, /var/tmp) are never inherited by child folders; an empty child under those roots is not a room, so spaceship/autopilot --yes refuse (exit 2) instead of minting atris/
```

## Search shortcuts: Utilities

```bash
rg "ensureValidCredentials" utils/auth.js   # Auth flow
rg "apiRequestJson" utils/api.js            # API requests
rg "checkForUpdates|autoUpdate|shouldAutoUpdate|helpRequested|help invocations skip" bin/atris.js utils/update-check.js test/update-check-install-state.test.js test/commands-1.test.js  # Version checks, packaged auto-update, and help-side-effect skip
```

## By-Feature Map

- **ConfigGuard:** `lib/config-guard.js:86` `enforceConfigGuard` denies Write/Edit that plant `SessionStart` or set `disableAllHooks: true` on user/project `.claude/settings.json`, and denies Bash that names that file (closes `cat >>` around the pack-root confine). `lib/pack-capabilities.js:222` PreToolUse matcher includes Bash; `lib/pack-capabilities.js:617` runs the guard before pack-root. Voice-card/init still write UserPromptSubmit and SessionStart through Node `upsertClaudeVoiceHook`, not pack tool hooks. Regression: `test/config-guard.test.js`.

## Feature: Authentication (`atris login/logout/whoami/switch/use/accounts`)

**Purpose:** Optional cloud features - auth with Atris backend

- **Entry point (modular):** `commands/auth.js`
- `commands/auth.js:625` (`loginAtris`): OAuth code exchange + manual token entry + `--token`/`--force` flags
- `commands/auth.js:806` (`logoutAtris`): Delete credentials
- `commands/auth.js:835` (`whoamiAtris`): Show auth status via `displayAccountSummary`
- **Auth (canonical):** `utils/auth.js` + `utils/api.js`: all auth logic consolidated, no inline duplicates
- **Help:** `bin/atris.js:1017-1046` (`showAuthHelp`) prints login/logout/whoami/switch/use/accounts usage before auth workers can prompt, create state, delete credentials, or touch session/profile dirs
- **Dispatch:** `bin/atris.js:1205-1239` routes login/logout/whoami/switch/use/accounts `--help`, `-h`, and bare `help` before calling `commands/auth.js`
- **Regression:** `test/commands-2.test.js:1438-1483` covers auth/account help without login prompts, status output, `.atris` creation, session/profile dir creation, or credential deletion
- JWT helpers: `utils/auth.js:113` (`decodeJwtClaims`), `utils/auth.js:150` (`shouldRefreshToken`)
- **Credentials storage:** `~/.atris/credentials.json` (chmod 0o600 on save)
- **Placed agent key:** `utils/auth.js:218` (`loadPlacedAgentToken`) and `utils/auth.js:552` (`readCredentials`) read `~/.atris/agent-token.json` or `ATRIS_AGENT_TOKEN_FILE` after `ATRIS_TOKEN` and before profiles, with the narrow fresh-file override for a different stale environment token; `test/auth-placed-token.test.js` covers precedence, expiry fallback, silent ignores, and the re-mint error
- **Login flow:**
  1. Browser OAuth: opens `{APP_BASE}/auth/cli`, user pastes code, CLI exchanges via `POST /auth/cli/exchange`
  2. Manual token: user pastes raw token, saved + validated
  3. Non-interactive: `--token <t>` flag for CI/scripts
- **Token refresh:** `utils/auth.js:737` (`performTokenRefresh`) saves new access token, optionally rotates refresh token, re-validates, updates user metadata. Profile-sourced creds write back to the profile file. `utils/auth.js:704` (`refreshAccessToken`) sends `refresh_token` and omits `provider=google` unless the token is a Google OAuth refresh (`1//...`); that hint makes `/auth/refresh` skip app-JWT refresh and return `google_refresh_failed`.
- **Credential guard:** `utils/auth.js:854` (`ensureValidCredentials`) checks selected-source and agent-JWT expiry, proactively refreshes within the 5-minute buffer, validates, then falls back to refresh
- **Wake auth abort:** `utils/auth.js:719` (`isAuthFailure`) and `utils/auth.js:729` (`abortOnAuthFailure`) stop status/wake polling on 401/403 and prints login guidance instead of a computer timeout. Used by `commands/terminal.js:35`, `lib/computer-core.js:2179`, `commands/aeo.js:98`, `commands/pull.js:361`, `commands/push.js:530`, `commands/align.js:180`.
- **Dependencies:** `utils/auth.js` for token management, `utils/api.js` for HTTP
- **Consumers:**
  - `commands/auth.js` (login/logout/whoami): uses modular `utils/auth.js`
  - `commands/workflow.js` (plan/do/review --execute, plus `2 pro --business`): `ensureValidCredentials()` (full refresh flow, `:311/:588/:963/:1351`)
  - `commands/brainstorm.js` (brainstorm/autopilot --execute): `ensureValidCredentials()` (full refresh flow, `:70`)
  - `commands/log-sync.js`: `ensureValidCredentials()` (full refresh flow)
  - `commands/integrations.js` (gmail/calendar/twitter/slack): `ensureValidCredentials()` (full refresh flow, `:28`)
  - `bin/atris.js` agent/chat: `ensureValidCredentials()` (full refresh flow, `:2093/:2202`)
- **Value:** Enables cloud sync, chat, agent selection

**Search:** `rg "showAuthHelp|loginAtris|logoutAtris|whoamiAtris|switchAccount|useAccount|accountsCmd|auth --help|account and integrations --help" bin/atris.js commands/auth.js test/commands-1.test.js`

## Feature: Auto Update Check

**Purpose:** Keep packaged installs current without interrupting workflow

- **Entry point:** `utils/update-check.js:1-334`
- **Dispatch skip:** `bin/atris.js:84-108` skips background update checks for version/update/help and any command whose args request help, so documentation paths cannot create `$HOME/.atris/.update-check`
- **Logic:**
- Background check on normal commands except version/update/help/help-flag invocations
- Fetches latest from npm registry
- Compares with local version
- Packaged installs spawn `npm install -g atris@latest` in the background; git checkout installs fall back to notification/manual `atris upgrade`
- **Cache:** 1-hour cache for registry checks and auto-update start throttling
- **Regression:** `test/commands-2.test.js:1453-1474` covers representative help commands that previously wrote only the update-check cache
- **Value:** Keep users up-to-date without interrupting workflow

**Search:** `rg "checkForUpdates|autoUpdate|shouldAutoUpdate|helpRequested|help invocations skip" bin/atris.js utils/update-check.js test/update-check-install-state.test.js test/commands-1.test.js`

## Concern: API Communication

**Files:**

- `utils/api.js` (306 lines): HTTP requests, error handling, SSE streaming
- `utils/claude_sdk.js` (172 lines): Claude API wrapper

**Key functions (utils/api.js):**

- Lines 23-37: URL builders (`getApiBaseUrl`, `getAppBaseUrl`, `buildApiUrl`): env-overridable via `ATRIS_API_URL` / `ATRIS_APP_URL`
- `utils/api.js:61`: `httpRequest()` uses Node https/http with a configurable timeout; redirects at `utils/api.js:79` drain the response and reject a changed origin before replaying headers or bodies.
- `lib/site-publish.js:327`: credentialed fetch uses manual redirects; the origin check at `lib/site-publish.js:342` rejects another origin and reports only its host.
- `test/api-redirect.test.js:88`: real local-server tests preserve same-origin credentials and refuse another port before any request reaches it, covering API bearer tokens, refresh tokens, client secrets, design and site uploads.
- Lines 84-147: `apiRequestJson()`: Generic API: auto-sets Bearer token, User-Agent, X-Atris-Client headers, JSON body serialization
- Lines 149-239: `streamProChat()`: SSE streaming for chat (text/event-stream)
- Lines 241-293: `spawnClaudeCodeSession()`: Non-streaming backend call

**Auth endpoints used:**

- `POST /auth/cli/exchange`: Exchange OAuth code for token+refresh_token
- `POST /auth/validate`: Validate access token, returns `{ valid, user }`
- `POST /auth/refresh`: Exchange refresh_token for new access_token

**Pattern:** JSON-based REST API with Bearer token auth. Default base: `https://api.atris.ai/api`

**Search:** `rg "apiRequestJson|httpRequest" utils/api.js`

## Concern: Authentication & Token Management

**Files:**

- `utils/auth.js` (388 lines): Canonical auth module (modular commands import from here)
- `utils/auth.js` + `utils/api.js`: Canonical auth modules (DI wrappers at bin/atris.js:63-62)

**Key functions (utils/auth.js):**

- Lines 7-24: `openBrowser()`: Platform-aware browser launch (darwin/win32/linux)
- Lines 31-71: `promptUser()`: Readline with piped-input support
- Lines 73-109: JWT decode + expiry check (`decodeJwtClaims`, `getTokenExpiryEpochSeconds`, `shouldRefreshToken`)
- Lines 112-170: Credential CRUD (`getCredentialsPath`, `saveCredentials`, `loadCredentials`, `deleteCredentials`)
- Lines 173-196: `validateAccessToken()` + `refreshAccessToken()`: API calls to `/auth/validate` and `/auth/refresh`
- Lines 410-436: `refreshProviderHint()` + `refreshAccessToken()`: omit `provider=google` for app JWTs
- Lines 438-454: `isAuthFailure()` / `abortOnAuthFailure()`: stop wake polls on 401/403
- Lines 456-541: `performTokenRefresh()`: Full refresh: call API, save new token to profile or credentials.json, re-validate
- Lines 543-608: `ensureValidCredentials()`: Entry point for auth guard: proactive refresh (5-min buffer) -> validate -> fallback refresh
- Lines 306-324: `fetchMyAgents()`: GET `/agent/my-agents`
- Lines 326-369: `displayAccountSummary()`: Print auth status + agent list

**Pattern:** JWT with auto-refresh, 5-min buffer (`TOKEN_REFRESH_BUFFER_SECONDS = 300`). Credentials stored as JSON at `~/.atris/credentials.json` with `chmod 0o600`. Refresh token rotation: if API returns a new refresh_token, it replaces the old one; otherwise keeps existing.

Sync login renewal (2026-10-24): `commands/pull.js:161` (journal), `commands/pull.js:209` (business), `commands/push.js:460`, `commands/member.js:4945` (push), and `commands/member.js:5010` (pull) call `ensureFreshCredentials` at `utils/auth.js:816`. It checks local expiry, skips agent/client/environment credentials, and refreshes expiring user logins through `performTokenRefresh` at `utils/auth.js:723` with validation disabled. Renewal stays in the selected profile and updates a stored expiry from the new JWT, so the next file sync reuses it. Full `ensureValidCredentials` at `utils/auth.js:840` retains validation and its refresh-before-expiry-rejection guard. `node --test test/sync-auth-refresh.test.js` exercises all five sync paths with no `/auth/validate` calls, temporary profiles, and generated fake credentials; it also checks client passthrough, refresh failures, repeat syncs, and the full-validation guard.

**Known issue:** `bin/atris.js` contains a full copy of auth logic (JWT decode, credential CRUD, token refresh, API helpers) that diverges slightly from `utils/auth.js`: inline version lacks `chmod 0o600` on save, no timeout on HTTP requests.

**Search:** `rg "ensureValidCredentials|refreshAccessToken" utils/auth.js`

## Concern: Configuration Management

**File:** `utils/config.js` (66 lines)

**Stores:**

- Selected agent ID
- API base URL
- Custom preferences

**Location:** `~/.atris/config.json`

**Search:** `rg "loadConfig|saveConfig" utils/config.js`

## ⭐ `utils/auth.js` (382 lines, 10.2KB)

**Why critical:** Handles all authentication, token management

**Key functions:**

- `ensureValidCredentials()` (lines 543-608): Auto-refresh flow
- `refreshAccessToken()` (lines 423-436): Token refresh logic; omits google provider hint for app JWTs
- `abortOnAuthFailure()` (lines 448-454): Wake loops stop on 401/403

**Impact:** Cloud features depend on this working correctly

**Search:** `rg "ensureValidCredentials" utils/auth.js`

---
