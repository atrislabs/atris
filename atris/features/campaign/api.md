# Campaign cloud API, v1

The backend is the hub. Computers (a laptop, a business EC2 computer) run campaigns and push their events; screens (web, iOS, desktop) read the folded view and send a person's answers and actions. State is always `campaign_fold.fold(events)`, never stored by hand. Contract for the view and events: atris-cli `test/fixtures/campaign/README.md`.

All routes are under `/api/campaigns`, need the signed-in user (the same auth the mission control routes use), and only ever show the caller's own campaigns. Errors are `{ "ok": false, "error": "<plain sentence>" }` with a 4xx status.

## Read (screens)

`GET /api/campaigns` → `{ "ok": true, "campaigns": [ { ...view, "next": <decide output>, "credits": <metering> } ] }`, needs-you first, then running, queued, paused, resting, out of budget, done.

`GET /api/campaigns/{campaign_id}` → `{ "ok": true, "campaign": <view>, "next": <decide>, "credits": <metering>, "last_event_seq": <int> }`

`GET /api/campaigns/{campaign_id}/events?after=<ingest_seq>&limit=500` → `{ "ok": true, "events": [<event>...], "last_event_seq": <int> }` in ingest order. Screens poll this (every 5 s while open) and refetch the view when anything new arrives.

## Write (computers)

`POST /api/campaigns/{campaign_id}/events` with `{ "events": [<event>...] }` → `{ "ok": true, "accepted": <n new>, "duplicates": <n>, "last_event_seq": <int> }`. Idempotent by event id; a different event at the same origin and seq is refused (409). The first push of a campaign must include its `campaign_started`. Trust: a computer may not push `ask_answered`, `budget_added`, or `done`; those come only from the person routes below (403 with a plain reason). Every pushed event must pass `validate_event`.

## Act (a person, from a screen)

`POST /api/campaigns/{campaign_id}/asks/{ask_id}/answer` with `{ "answer": "<text>" }` → appends `ask_answered` with actor `human:<user handle or id>`, origin `cloud` → returns the new view.

`POST /api/campaigns/{campaign_id}/actions` with `{ "action": "pause" | "resume" | "stop" | "add_budget", "amount_usd": <for add_budget> }` → appends `paused` / `resumed` / `stopped` / `budget_added` as the person → returns the new view.

Events the backend writes itself use origin `cloud` and its own seq per campaign.

## Run in the cloud (the owner, from a screen or the CLI)

`POST /api/campaigns/{campaign_id}/run-in-cloud` with `{ "work": "50m", "break": "10m", "max_rounds": <optional, 1 to 48> }` runs the campaign on the owner's Atris computer, so it keeps going while the laptop sleeps. Only the owner's own login may call it (agent tokens, API keys, and campaign tokens get 403), and only a campaign whose `campaign_started` says `basis: "atris_cloud"` runs there (403 otherwise). The backend finds the person's computer and wakes it if it sleeps; a computer still waking answers 503 with `Retry-After`. It then checks that the computer's CLI reports the `cloud_pull` and `campaign_token_file` features (`atris campaign features --json`), claims the campaign's one runner slot, and starts one tracked background command:

```text
ATRIS_CAMPAIGN_TOKEN_FILE=.atris/campaign-runs/<id>.token atris campaign sync <id> &&
ATRIS_CAMPAIGN_TOKEN_FILE=.atris/campaign-runs/<id>.token atris campaign run <id> --work <s>s --break <s>s [--rounds <n>];
code=$?; rm -f .atris/campaign-runs/<id>.token; exit $code
```

- **The computer's login is one campaign token, not the person's.** It opens only `GET /campaigns/<id>`, `GET /campaigns/<id>/events`, and `POST /campaigns/<id>/events` for that one campaign. It expires at the run deadline and stops working once the run's claim ends. The backend writes it to a 0600 file in a 0700 folder kept out of git, never on a command line. The CLI reads the path from `ATRIS_CAMPAIGN_TOKEN_FILE`, takes it out of its environment so no mission or engine inherits it, and uses it only for that campaign's sync calls.
- **One runner per campaign.** Each run is a claim, a `home_moved` event with the fixed id `cloudrun-<id>-<n>` written before anything starts, so two starts cannot both win. `cloudrun-<id>-<n>-run` records the run id. `cloudrun-<id>-<n>-end` ends the claim when the run finishes, fails to start, or passes its deadline (the rounds plus 30 minutes, or one day). A claim without a run record blocks new starts until its deadline.

→ `{ "ok": true, "computer", "claim", "run_id", "status", "woke", "recorded", "deadline", "check" }`.

`GET /api/campaigns/{campaign_id}/cloud-run` → `{ "ok": true, "state", "home", "basis", "summary", "run": null | { "claim", "run_id", "computer", "status": "running" | "finished" | "ended" | "unknown" | "computer_asleep" | "unreachable", "exit_code", "timed_out", "output_tail" } }`. It never wakes a computer, and a finished run's claim is ended here.

## Credits

Price: engine cost plus margin. `credits` on each view:

```json
{ "engine_cost_usd": 0.56, "margin": 0.30, "billable_usd": 0.73, "credits": <billable_usd converted at the platform's credit rate>, "charged": false }
```

`engine_cost_usd` is the campaign's folded `budget.spent`. Local campaigns synced from a person's own machine on their own subscription are never charged (`basis: "own_engines"`). Campaigns with `basis: "atris_cloud"` are charged for real (approved by Keshav 2026-10-16):

- When a `mission_ended` with a cost is stored, the owner pays `ceil(cost * 1.30 * 100)` credits, once per event (the ledger key `charge:campaign:<row id>:<event id>` makes resends and retries free).
- A settle pass after every push and every person action charges anything still unpaid, so a crash between storing and charging is collected later.
- Charges never pass the budget: the cap is the budget minus what the ledger already charged, taken under a lock on the campaign (database function `campaign_charge_capped`). The rest shows as `over_budget`.
- A short wallet keeps the event, charges nothing, and pauses the campaign; a computer cannot resume a cloud campaign, and a person's resume is refused while credits are owed.
- The block reports `charged`, `credits_charged`, `credits_owed`, `over_budget`, and `short`.

Proven in production with a 13-credit probe ($0.10 mission): charged once, resend charged nothing.

## CLI

`atris campaign sync <id>` pushes events the cloud lacks and pulls the ones the computer lacks (answers, actions from screens), by event id. On a computer that has never seen the campaign it pulls the whole log first, `campaign_started` before anything else, and says plainly when the cloud has no such campaign for this login. `atris campaign start ... --cloud` starts it locally and syncs at once (`--basis atris_cloud` marks it as run and billed on Atris engines; it needs `--cloud`); `atris campaign cloud-run <id> [--work 50m --break 10m --rounds N]` syncs, then calls run-in-cloud, and `--status` reads cloud-run; `atris campaign run` on a synced campaign syncs before and after every step, so a phone answer reaches a running loop.

The CLI keeps the trust rule: it never pushes `ask_answered`, `budget_added`, or `done`. On a synced campaign, a person's `atris campaign answer` and `atris campaign budget --add` go through the person routes above and come back by pull; offline they are recorded on the computer only. The CLI keeps each campaign's cloud link and the last pulled `last_event_seq` in the store's `meta` table (`lib/campaign-sync.js`).

## Facts the builders need (scouted 2026-10-15)

- Credits: 1 credit = $0.01 (`ATRIS2_CREDIT_USD = 0.01`, `backend/services/atris2_billing.py:21`). So `credits = round(billable_usd * 100)`. Margin 0.30 lives in one constant.
- Backend auth: `user = await authenticate_request(request)` from `routers/auth_utils.py:300`. The campaign router (`backend/routers/campaign_router.py`, on origin/master since #4506) and `backend/services/campaign_service.py` already exist; extend them. The `campaigns` table is unique on (owner_user_id, campaign_id) and is LIVE in production.
- Backend deploys are manual (render.yaml autoDeploy false); merging does not deploy.
- CLI backend calls: `apiRequestJson` from `utils/api.js:127` (Bearer, renews token, retries once), token from `loadCredentials` in `utils/auth.js`; base URL `getApiBaseUrl()` (`https://api.atris.ai/api`, `ATRIS_API_URL` overrides). Example: `lib/cloud-mission.js`.
- Web: BFF proxy routes under `app/api/...` using `app/api/_utils/proxy-mission-request.ts` and `build-auth-headers.ts`; the typed decoder `app/dashboard/preview/campaign-view.ts` exists.
- iOS (terrace, `votd/`): `AuthManager.performAuthenticatedRequest` (`AuthManager.swift` ~298), `AppConfig.apiBaseURL`, polling pattern in `MissionsStore.swift`, pages in `SwipeShellView.swift` (`Page` enum, `MissionsPage()` ~596), `votd/CampaignView.swift` model exists.
