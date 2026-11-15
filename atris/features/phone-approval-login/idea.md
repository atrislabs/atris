# phone approval for atris login

> **Status:** planning (plan only, nothing built)
> **Created:** 2026-11-12
> **Last Updated:** 2026-11-12
> **Task:** CLI-1469
> **Touches:** atrisos-backend (new endpoints, new table), atrisos-web (approve page), atris-cli (login flow)

---

## problem

An agent on a box with no browser cannot sign in by itself. Today `atris login` needs a person to open a browser, copy a one-time code and paste it back. With no terminal and no code, it prints help and exits 1 (`commands/auth.js:836-853`).

A person is usually holding a phone. They should be able to tap one button there and let the agent finish.

Agents also cannot get their own agent client without a person's login already on the box. `atris agent-client create` needs one (`commands/agent-client.js:223-226`).

## solution

Add a device-code style flow (the shape of RFC 8628). The CLI asks the server to start a request and gets a short code plus a link. The person opens the link on their phone, checks the code and taps approve. The CLI polls the server and finishes sign-in on its own when the approval lands.

The same flow has two outcomes. `kind=login` hands the box the person's login, exactly what `--code` does today. `kind=agent_client` hands the box a scoped agent client owned by the person, which is the safer default for an agent.

```text
agent box (no browser)           server                         person's phone
────────────────────────         ──────────────────────         ─────────────────────
atris login
  POST /start ─────────────────▶ new row: pending
  ◀── link + code ABCD-EFGH
prints link + code ─ agent relays it to the person ───────────▶ opens link, signs in
                                                                 sees code + what asks
                                                                 taps approve
                                 row: approved (user id from
                                 the phone's session)  ◀──────── POST /approve
  POST /poll ────────────────▶ approved? mint once, mark used
  ◀── login tokens or client id + secret
saves to ~/.atris, done
```

---

## what exists today

These are the facts the plan builds on. Each one was read in code on 2026-11-12.

- **Login with a code.** In a terminal, `atris login` shows a menu, opens `${app}/auth/cli` and prompts for the pasted code (`commands/auth.js:860-882`). The code is sent to `POST /auth/cli/exchange` (`commands/auth.js:693`). The tokens are saved by `saveCredentials` (`commands/auth.js:715`) into `~/.atris/credentials.json` with owner-only permissions (`utils/auth.js:194-196`, `utils/auth.js:487-510`). A named profile is saved too (`utils/auth.js:480-485`).
- **`lib/engine-login.js` is not this.** It only stores a Claude token for sealed builds (`lib/engine-login.js:1-9`). Nothing to reuse there.
- **The code on the server.** `GET /api/auth/cli/login` needs a signed-in session. It mints both tokens right then (`atrisos-backend/backend/auth.py:1929-1930`), stores them in the code's payload and returns a code that lasts 300 seconds (`backend/auth.py:1937`, `backend/services/cli_auth_service.py:19-44`). `POST /api/auth/cli/exchange` consumes it (`backend/auth.py:1955`). One-time use is the guarded update `used_at IS NULL` (`backend/services/auth_exchange_code_service.py:103-105`).
- **The web page.** `/auth/cli` fetches a code and shows it (`atrisos-web/app/auth/cli/page.tsx:72`). When signed out it sends the visitor to `/login?returnTo=...` (`page.tsx:229-230`). A return path with a query string survives sign-in (`app/auth/callback/returnTo-roundtrip.test.tsx:114`). The page talks to the backend through a Next route that reads the cookie and forwards a Bearer token (`app/api/auth/cli/login/route.ts:9`).
- **`atris login --agent` does not make an agent client.** It mints a scoped agent token from the stored login by calling `POST /auth/agent-token` (`commands/auth.js:9`, `commands/auth.js:209-279`, `commands/auth.js:749-764`). The default scopes are `x-search,youtube` and the default daily cap is 50 (`commands/auth.js:10-11`). With no stored login it stops with "not signed in" (`commands/auth.js:381`). The task text says `--agent` creates the client. That is the new behavior this plan adds, only for the no-login case.
- **Agent clients today.** A person creates one with `atris agent-client create` (`commands/agent-client.js:193-240`), which calls `POST /api/auth/agent-clients` (`backend/routers/agent_client_router.py:63-66`). Only a person's own session may do it (`agent_client_router.py:1-17`, `backend/routers/auth_utils.py:607-631`). A person may hold 25 live clients, a self-signed-up agent 3 (`backend/services/agent_client_service.py:38-40`). The agent then signs in with `atris login --client-id ... --client-secret-file ...` (`commands/auth.js:497-541`), which trades the secret for short tokens at `/oauth/token` (`utils/agent-client.js:190`, `backend/routers/agent_client_token.py:1-20`).
- **A no-human path already exists, with a different owner.** `atris signup <handle>` calls `POST /api/auth/agent/signup` with no login (`commands/signup.js:105`, `backend/routers/agent_auth_router.py:434`). It returns a token and an "account" client (`agent_auth_router.py:420-426`) that `adoptSignupClient` stores (`commands/signup.js:57-77`). That account is a new inert identity with no credits. It does not act for a person. Phone approval is for the other case: an agent that should act for an existing person.
- **No inbound device flow exists.** Every "device code" hit in the backend is outbound, for engine logins and the Link wallet (`backend/routers/engine_logins_router.py:200`, `backend/services/link_wallet_service.py:11-12`, `:135`).
- **Guards a new mint must respect.** A request authenticated by an agent token cannot mint credentials (`backend/services/credential_mint_guard.py:1-17`, `:44`). Account-scoped agent tokens are denied `/api/auth/cli/login` (`backend/services/agent_scopes.py:265`).
- **Limits today.** The signup limiters live in process memory and reset on deploy (`backend/routers/agent_auth_router.py:129-146`). The shared limiter is Redis-backed when Redis is up (`backend/middleware/rate_limiter.py:516-526`) and `agent_client_token.py:93-104` shows how to use it. The `/api/auth/*` pattern matches one path segment only (`rate_limiter.py:75`, `rate_limiter.py:225-228`). Nested paths like `/api/auth/cli/device/poll` get the anonymous default of 60 a minute per IP (`rate_limiter.py:42-46`, `rate_limiter.py:1011-1013`).

---

## what the person sees

On their phone they tap a link their agent sent them and see a code like ABCD-EFGH, the name of the machine asking and what it will be allowed to do. They check the code matches what the agent said and tap approve; the agent finishes signing in a few seconds later. If they did not ask for this they tap deny or close the page, which grants nothing.

## server endpoints

New router `backend/routers/cli_device_router.py`, prefix `/api/auth/cli/device`, registered in `backend/main.py` next to the other routers (the auth router is mounted at `main.py:1769`). New table `cli_device_logins` in a new file under `backend/migrations/`, service-role only like `auth_exchange_codes` (`supabase/migrations/20260205_rls_lockdown.sql:44`, `:184`).

Why a new table: `auth_exchange_codes` holds one payload with a `used_at` flag. This flow needs states (pending, approved, denied, redeemed) and poll counters. Reuse its helpers instead: `generate_auth_code` and `hash_token` (`backend/services/oauth_utils.py:50`) and the guarded one-time update pattern.

**`POST /start`** (no sign-in).

- Request: `kind` ("login" or "agent_client"), `label` (machine name, 80 characters at most), `cli_version`. For `agent_client` also `scopes`, optional `name`, `daily_credit_cap`.
- Response: `device_code` (secret, prefix `dvc_`), `user_code` (ABCD-EFGH), `verification_uri`, `verification_uri_complete` (link with the code in it), `expires_in` (600), `interval` (5).
- The prefix matters. A bare 43-character device code would match the CLI's one-time-code pattern (`commands/auth.js:629`) and be mistaken for a pasted code.
- Scopes are checked with `agent_client_service.clean_settings` (`agent_client_service.py:95-110`). The `account` scope is refused here, because that scope is only for agents that signed themselves up (`agent_client_service.py:131-135`).

**`GET /lookup?user_code=...`** (person's session only). Returns `kind`, `label`, `scopes`, `name`, `requested_seconds_ago`, `expires_in`, `status`. Unknown, expired and used codes all answer the same 404. It does not bind or change anything.

**`POST /approve`** and **`POST /deny`** (person's session only). Body is `user_code`.

- Auth is `authenticate_human_owner` (`auth_utils.py:607`). That already turns away agent tokens, API keys and agent identity JWTs.
- Add `/api/auth/cli/device/(approve|deny)` to `ACCOUNT_DENIED_ROUTES` (`agent_scopes.py:249-265`) as a second layer, next to `/api/auth/cli/login`.
- Approve is one guarded update: `pending` to `approved`, `approved_user_id` taken from the session and never from the body. It also checks the owner is under the live client limit when `kind=agent_client`. The person then sees the refusal on the phone.
- Deny moves `pending` to `denied`. Both are audited with `auth_audit_service.record` (`backend/services/auth_audit_service.py:113`).

**`POST /poll`** (no sign-in, `device_code` in the body, never in a URL).

- `authorization_pending` (400) while waiting, with the current `interval`.
- `slow_down` (400) when polled faster than `interval`. The new interval is returned.
- `access_denied`, `expired_token` (400) as terminal answers.
- On `approved` it claims the row first (`approved` to `redeemed`, guarded by `redeemed_at IS NULL`, same shape as `auth_exchange_code_service.py:103-105`). Only then does it mint. Two racing polls cannot both mint.
  - `kind=login`: load the user's email and provider and make the same two token calls `cli_login_page` makes (`backend/auth.py:1903-1930`). The answer has the same shape as the exchange (`auth.py:1963-1969`): `token`, `refresh_token`, `user_id`, `email`, `provider`. The CLI can reuse its saving code unchanged.
  - `kind=agent_client`: `agent_client_service.create(approved_user_id, name, scopes, cap, ttl)` (`agent_client_service.py:148`) plus the strict `client_create` audit row with `via: device_login`, copied from `_signup_client` (`agent_auth_router.py:386-418`). The answer has the same shape as signup's `client` object: `client_id`, `client_secret`, `scopes`, `token_endpoint`, `expires_in_seconds`. The shared client adoption code (see command tool flow) takes it as is.
  - If minting fails after the claim, the row goes back to `approved` and the answer is 503. The next poll retries.
- Minting at poll time means no token or secret sits in the database. Today's code stores tokens in the code payload (`cli_auth_service.py:37-43`). This plan does not copy that.

Kill switch: `/start` answers 503 unless `CLI_DEVICE_LOGIN=1`. Slice 1 can merge and deploy dark. The flag is flipped once the whole path is checked.

Accepted limit: if the network drops after the server created an agent client but before the CLI read the answer, the secret is lost. The client sits unused in the person's list and can be revoked from there. The CLI says "run atris login again".

## web approve page

Route `/auth/cli/approve?code=ABCD-EFGH`, as `app/auth/cli/approve/page.tsx` under the existing `/auth/cli` layout. That layout is `force-dynamic` so the CSP nonce reaches the page (`app/auth/cli/layout.tsx:1-9`). Three small Next routes forward to the backend the way `app/api/auth/cli/login/route.ts` does: `.../device/lookup`, `.../device/approve`, `.../device/deny`.

- **Signed-in requirement.** The page calls lookup first. A 401 sends the visitor to `/login?returnTo=<this page with its query>`, copied from `page.tsx:229-230`. Nothing needs adding to `protectedRoutes` (`proxy.ts:162-169`). Sign-in returns to the same link with the code.
- **What it shows.** The code in large type. The machine label, marked "the machine says its name is". How long ago it asked. For `agent_client`: the scopes in plain words, the daily credit cap and "this key can be revoked any time". For `login`: a stronger line, "this gives the machine your full login".
- **One tap.** A single approve button. For `kind=login` approve needs a second confirm tap. Deny sits next to it.
- **After.** Approved shows "done, you can close this page". Denied shows "nothing was granted". Expired shows "this request ended, ask your agent to start again".
- **Browser side checks.** Posts pass the origin check in `proxy.ts:651-722` as normal page fetches. The `/api/auth` bucket of 10 a minute (`proxy.ts:24`) is plenty for a person.
- **No cookie token reaches the page.** The Next routes read the cookie on the server. The page only sees the lookup answer.

## command tool flow

**Deciding there is no browser.** The CLI does not probe the machine. "No terminal to prompt" already means non-interactive (`lib/noninteractive.js:30-34`) and that is where the dead end sits today (`commands/auth.js:836-853`). Two changes:

- Non-interactive `atris login` with no code, no token and no client env starts the phone flow instead of printing help.
- A terminal can ask for it: the menu gains "approve on your phone" (`commands/auth.js:860`). `atris login --phone` skips the menu. An SSH session with a terminal and no browser uses this.

`--code`, a piped code, `--token` and `--client-id` stay exactly as they are (`commands/auth.js:737-784`).

**Why two calls for agents.** Most agent tools return a command's output only when the command ends. If the command waited ten minutes, the agent could not show the link in the meantime. So:

- With a terminal on stdout: print the link and code, then poll live until approved or expired. Ctrl-C leaves the request pending.
- With no terminal on stdout (agent): the first call prints the link and code and returns immediately with exit code 75. Later `atris login` calls resume the same request, poll for up to `--wait` seconds (default 60), then return success or 75 again.

Pending state is `~/.atris/login-pending.json` with owner-only permissions (the pattern at `utils/auth.js:179`). It holds `device_code`, `user_code`, `kind`, `expires_at` and the API base. The device code is a secret until it expires. It never prints.

**Output.** Plain mode:

```text
open this on your phone:
  https://atris.ai/auth/cli/approve?code=ABCD-EFGH
check the code reads ABCD-EFGH, then tap approve.
waiting for approval (ends in 10 minutes)
```

`--json` gives one document: `{"ok":false,"status":"pending","user_code":"ABCD-EFGH","verification_uri_complete":"...","expires_in":600,"next":"atris login"}`, then on success the same fields `exchangeCliCodeAndSave` prints today (`commands/auth.js:717-722`). Exit codes: 0 signed in, 75 still waiting, 1 denied, expired, or error.

**Polling.** Start at the server's `interval` (5 seconds). On `slow_down` add 5 seconds. On a network error or 5xx, double the wait up to 30 seconds. On 429, wait for `Retry-After`. Use `retries: 0` on each call (`utils/api.js:169`) because the loop owns the retry. No Retry-After handling exists in `utils/api.js` today. The loop reads the header itself.

**Saving.**

- `kind=login`: `saveCredentials(...)` as `exchangeCliCodeAndSave` does (`commands/auth.js:715`).
- `kind=agent_client`: the tail of `adoptSignupClient` moves into `utils/agent-client.js` as one shared function (write the secret file, `requestClientToken`, `saveAgentClientCredentials`, `writeTokenCache`). Signup and login both call it. Signup's version also keeps a fallback profile from a login it just saved (`commands/signup.js:68-70`). Phone login has no such login. That part stays in signup. `keepHumanLoginAsProfile` (`commands/auth.js:526`) runs first so an existing login stays switchable.

**`atris login --agent` after this change.**

- A stored login exists: unchanged. It mints a scoped token (`commands/auth.js:749-764`).
- No stored login: instead of the dead end at `commands/auth.js:381`, it starts a phone flow with `kind=agent_client`. Scopes come from `--scopes` (default `x-search,youtube`), the cap from `--daily-credit-cap` (default 50). When approved the box signs in as an agent client, the same state `atris login --client-id` produces. `atris whoami --json` shows `auth_type: agent_client` (the agent client branch of `printWhoamiPayload`, `commands/auth.js:417-432`).
- `--commerce` stays on the token path. A commerce key carries a largest-quote limit (`commands/auth.js:59-72`) and the agent client create body has no such field (`backend/routers/agent_client_router.py:42-55`). Combining `--commerce` with the no-login phone path prints a clear refusal.

## expiry and abuse limits

| thing | rule |
|---|---|
| request lifetime | 600 seconds to approve. After approval, 120 seconds to redeem. |
| `user_code` | 8 characters from 20 consonants (no vowels, no look-alikes), shown ABCD-EFGH. About 34 bits. |
| `device_code` | `dvc_` plus 32 random bytes. Only a sha256 hash is stored. |
| poll interval | server says 5 seconds. Faster polls get `slow_down`. Hard stop after 150 polls per request. |
| starts | 20 an hour per IP and 5 live pending per IP, on the shared Redis limiter. Global ceiling 100 live pending, same idea as the signup backstop (`agent_auth_router.py:146`). |
| code guessing | 10 unknown `user_code` lookups per 10 minutes per account, then a one hour lock. At about 1,000 live codes in 34 bits, one guess hits a live code about 4 in 100 million times. |
| approvals | 10 an hour per account. 25 live agent clients per person (`agent_client_service.py:38`). |
| one-time use | `redeemed_at IS NULL` guarded update before any mint. A second poll gets `expired_token`. |
| who approved | `approved_user_id` is read from the session only. The poll mints for that id and nobody else. The device cannot choose the account. |
| who can approve | a person's own session. Agent tokens, API keys and agent identity JWTs are refused (`auth_utils.py:607-631`, `credential_mint_guard.py`). |
| audit | `start`, `approve`, `deny`, `redeem` each write an `auth_audit_events` row with IP and label (`auth_audit_service.py:113`). Client creation uses the strict write. |
| cleanup | rows older than a day are deleted by the next `/start`. The audit table is the long record. |

The main attack is an attacker starting a request and sending the victim the link. The page defends with the visible code, the machine label, the age and the plain statement of what is granted. It cannot stop a victim who ignores all four. That is why scoped client is the default and full login needs the second tap.

The other attack is guessing someone else's pending code with the attacker's own account, to point the victim's agent at the attacker's account. The lookup limit above is the control.

IP keys use `helpers/client_ip.py`, which trusts only edge-set headers.

## ship order

Backend deploys right after merge. Web deploys on its own ship step. The CLI ships by tag.

**Slice 1: backend only.** Migration, `cli_device_router.py`, service, rate limit registration, the `ACCOUNT_DENIED_ROUTES` line, the kill switch (off).

- Proof: new pytest file in `atrisos-backend/backend/tests/` (models: `test_cli_auth_service.py`, `test_agent_clients.py`) covering: start then pending poll; approve with a person's token then one poll returns the exchange-shaped login and the second poll is refused; an agent token calling approve gets 403; `slow_down`; expired; deny; wrong device code; lookup lockout after 10 misses; `agent_client` kind creates a client owned by the approver and refuses the `account` scope; the 25 client limit refuses at approve; client audit failure returns 503 and leaves the row approved.
- Safe to merge first. It adds a table, a router and one denied-route line. No existing route changes. With the flag off, `/start` is 503. With the table missing, the service answers 503 the way `agent_client_service.py:113-121` does. Apply the migration before the deploy, as `backend/migrations/20261112_swarlo_inbox.sql:6-7` asks.

**Slice 2: web.** Approve page, three Next routes, tests.

- Proof: component tests in the style of `app/auth/cli/page.test.tsx` (signed out goes to login with returnTo, lookup shows the details, approve posts once, deny posts once, expired state). Then every step of `scripts/ship-prod.sh`, because the web repo has no CI. Then one real run: flag on in a preview, `curl` a start, open the link at a phone-sized window signed in, tap approve, `curl` the poll and see tokens once.
- Merge only after slice 1 is live. Before that the page would 404 on lookup.

**Slice 3: CLI.** Phone flow in `commands/auth.js`, new `lib/phone-login.js` for start, poll, pending file, shared client adoption in `utils/agent-client.js`, help text in `bin/atris.js:1065-1095`, minor version bump (new capability, not a story jump), a routing row in `atris/MAP.md` and refs in `atris/refs/MAP-NOTES.md`.

- Proof: node tests in the style of `test/login-headless-code.test.js` (real binary, real HTTP, fake backend): non-terminal login prints link and code and exits 75; resume polls and saves credentials with mode 0600; `slow_down` backs off; denied exits 1; expired exits 1; `--json` shape; `--agent` with no login ends signed in as an agent client and `whoami --json` says so; `--agent` with a login still mints a token; `--code`, piped code and `--token` behave as before. The test that pins the old dead-end output (`test/login-headless-code.test.js`) is updated on purpose.
- Last, a run in a clean Linux container with no browser against the deployed backend with the flag on. Then tag master and let CI publish.

Order: migration, slice 1 merge (dark), slice 2 merge, flag on, slice 3 merge, tag.

## success criteria

- [ ] On a box with no browser, `atris login` prints a link and code. A phone tap signs the box in with no paste.
- [ ] `atris login --agent` with no login ends as a scoped agent client owned by the approver. It renews itself.
- [ ] A code works once and dies in 10 minutes. Only the signed-in person who approved can receive it.
- [ ] Every path that worked before (`--code`, piped code, `--token`, `--client-id`, `atris signup`) works the same.

## open questions for Keshav

One. Should phone approval ever hand a box the person's full login, or only scoped agent keys? My lean: allow both, scoped by default, full login behind a second tap with a plain warning.

Two. A phone-approved agent client spends the person's credits up to its daily cap. Keep the default at 50 a day, the same as `atris login --agent` today (`commands/auth.js:11`), or start lower?

Three. Do you want a short link like `atris.ai/d/ABCD-EFGH` now? It costs one extra web redirect route. Without it the link is `atris.ai/auth/cli/approve?code=ABCD-EFGH`, which an agent can paste in chat as is.
