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

## Credits (metering only, v1)

Price: engine cost plus margin. `credits` on each view:

```json
{ "engine_cost_usd": 0.56, "margin": 0.30, "billable_usd": 0.73, "credits": <billable_usd converted at the platform's credit rate>, "charged": false }
```

`engine_cost_usd` is the campaign's folded `budget.spent`. v1 meters only (`charged: false`); nothing is debited until Keshav approves charging. Local campaigns synced from a person's own machine on their own subscription are never billable (`billable_usd: 0`, `basis: "own_engines"`); `basis: "atris_cloud"` is billable.

## CLI

`atris campaign sync <id>` pushes events the cloud lacks and pulls the ones the computer lacks (answers, actions from screens), by event id. `atris campaign start ... --cloud` starts it locally and syncs at once; `atris campaign run` on a synced campaign syncs before and after every step, so a phone answer reaches a running loop.

The CLI keeps the trust rule: it never pushes `ask_answered`, `budget_added`, or `done`. On a synced campaign, a person's `atris campaign answer` and `atris campaign budget --add` go through the person routes above and come back by pull; offline they are recorded on the computer only. The CLI keeps each campaign's cloud link and the last pulled `last_event_seq` in the store's `meta` table (`lib/campaign-sync.js`).

## Facts the builders need (scouted 2026-10-15)

- Credits: 1 credit = $0.01 (`ATRIS2_CREDIT_USD = 0.01`, `backend/services/atris2_billing.py:21`). So `credits = round(billable_usd * 100)`. Margin 0.30 lives in one constant.
- Backend auth: `user = await authenticate_request(request)` from `routers/auth_utils.py:300`. The campaign router (`backend/routers/campaign_router.py`, on origin/master since #4506) and `backend/services/campaign_service.py` already exist; extend them. The `campaigns` table is unique on (owner_user_id, campaign_id) and is LIVE in production.
- Backend deploys are manual (render.yaml autoDeploy false); merging does not deploy.
- CLI backend calls: `apiRequestJson` from `utils/api.js:127` (Bearer, renews token, retries once), token from `loadCredentials` in `utils/auth.js`; base URL `getApiBaseUrl()` (`https://api.atris.ai/api`, `ATRIS_API_URL` overrides). Example: `lib/cloud-mission.js`.
- Web: BFF proxy routes under `app/api/...` using `app/api/_utils/proxy-mission-request.ts` and `build-auth-headers.ts`; the typed decoder `app/dashboard/preview/campaign-view.ts` exists.
- iOS (terrace, `votd/`): `AuthManager.performAuthenticatedRequest` (`AuthManager.swift` ~298), `AppConfig.apiBaseURL`, polling pattern in `MissionsStore.swift`, pages in `SwipeShellView.swift` (`Page` enum, `MissionsPage()` ~596), `votd/CampaignView.swift` model exists.
