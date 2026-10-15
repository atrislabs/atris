# Campaign fold contract

Every Atris surface folds campaign events the same way: the CLI (JavaScript), the backend (Python), desktop and web (TypeScript), and terrace (Swift). The golden files in this folder are the proof. A surface conforms when its fold turns each file's `events` into exactly that file's `expected`.

The judge `node scripts/campaign-conformance.js` runs every surface over these files. `MANIFEST.json` pins each file's sha256, so a surface cannot pass by editing a fixture.

Spec: `atris/features/campaign/idea.md`. Event types and field checks: `lib/campaign-schema.js`.

## Golden file shape

```json
{
  "name": "judge-pass-finishes",
  "about": "one plain sentence on what this file proves",
  "events": [ ...events... ],
  "expected": { ...folded view... }
}
```

When the events must be refused, `expected` is `{ "error": "<code>" }` instead of a view.

## Event shape

```json
{
  "id": "evt-0001",
  "campaign_id": "cmp-ship",
  "type": "mission_ended",
  "at": "2026-10-15T10:00:00Z",
  "origin": "laptop",
  "seq": 4,
  "actor": "builder",
  "data": { "mission_id": "m1", "outcome": "kept", "cost_usd": 2.25 }
}
```

- `id` is globally unique, created where the event happened: 1 to 128 printable ASCII characters, no spaces.
- `at` is an RFC 3339 timestamp with a `Z` or a `+hh:mm` / `-hh:mm` offset and at most 9 fraction digits, for example `2026-10-15T10:00:00Z` or `2026-10-15T03:00:00.250-07:00`. A timestamp without a zone is refused, so no surface depends on its own timezone.
- `origin` is the computer that wrote it (1 to 64 of `A-Z a-z 0-9 . _ : -`), and `seq` counts up from 1 per origin.
- `actor` is a member name, `judge`, `system`, or `human:<name>` for a person. Only `human:` actors count as a person.

## Refusals (fold fails closed)

Return `{ "error": code }` and no view when:

- `invalid_event`: any event fails `validateEvent` (unknown type, missing field, bad id, missing cost on `mission_ended`, and so on).
- `mixed_campaigns`: events carry more than one `campaign_id`.
- `no_start`: no `campaign_started` event.

## Order and duplicates

1. Drop every event whose `id` was already seen, keeping the first in the given order.
2. Sort the rest by `at` (compare as instants at full precision, down to the nanosecond, never rounded to milliseconds), then `origin`, then `seq`, then `id` (plain string order). The same events in any arrival order fold to the same view.
3. The first `campaign_started` in sorted order starts the campaign and is applied before every other event, even one with an earlier `at`. A later `campaign_started` is ignored with warning `duplicate_start`.

## Money

Every dollar amount becomes integer cents on the way in: `floor(amount * 100 + 0.5)`. All sums use cents. The view prints dollars as `cents / 100`.

## Applying events

| Event | Effect |
|---|---|
| `campaign_started` | sets `title`, `judge`, `budget.total`, `owner` (data.owner, else `mission-lead`), `standing` (default false), `bet` (data.bet as `{ "text": bet, "wrong_if": null }`, else null), `seats` from data.seats (a string seat is `{ "member": s, "role": null }`), `home` = this event's origin, `created_from` = data.created_from or null |
| `seat_filled` | adds `{member, role}`; an identical pair already seated is ignored silently |
| `bet_set` | `bet = { text: data.bet, wrong_if: data.wrong_if or null }` |
| `judge_set` | only the owner or a `human:` actor: `judge = data.judge`, and the judge becomes due. Anyone else gets warning `judge_set_not_owner` and nothing changes |
| `attached` | `parent = data.parent_id` |
| `mission_proposed` | creates the mission if new, status `proposed`, member = data.member or null, estimate_usd = data.estimate_usd or null |
| `mission_claimed` | if another mission already holds `claim_key`: warning `duplicate_claim`, this mission's status becomes `dropped`. Otherwise this mission holds the key and becomes `claimed` (created if new) |
| `mission_vetoed` | status `vetoed`. Only the owner or a `human:` actor may veto; anyone else gets warning `veto_not_owner` and nothing changes |
| `mission_started` | creates the mission if new, status `running`. Sets member when the mission has none. A different member than the one set gets warning `second_assignee`, and the member does not change |
| `step`, `kept`, `reverted` | add 1 to that mission's `steps`, `kept`, or `reverted` (mission created with status `proposed` if new) |
| `mission_ended` | status `ended`, `outcome` and `cost_usd` set, `budget.spent += cost`, and the mission's open reservation is released |
| `budget_reserved` | the mission's open reservation becomes `amount_usd` (replacing any earlier one) |
| `budget_released` | the mission's open reservation is removed |
| `budget_added` | `budget.total += amount_usd` |
| `judge_ran` | adds a judge run. A passing run on a campaign that is not standing finishes it: `done`, stop_reason `judge_passed` |
| `ask_opened` | adds an open ask `{id: ask_id, question, mission_id or null}` |
| `ask_answered` | removes that open ask, but only when the actor is `human:`. An agent answering gets warning `ask_answered_by_agent` and the ask stays open. Answering an unknown or closed ask gets warning `unknown_ask` |
| `paused` / `resumed` | sets or clears paused |
| `stopped` | finishes: `done`, stop_reason `stopped` |
| `home_moved` | `home = data.to` |
| `done` | from a `human:` actor finishes with stop_reason `done_by_human`. From anyone else it is ignored with warning `done_without_judge` (a model saying done does not count) |

Once finished, a campaign stays finished. Later events still apply to missions, money, asks, and the judge history, but they never change `state` or `stop_reason`.

## Settled edge cases

These close every ambiguity found while writing the goldens (`AMBIGUITIES.md`).

- **Missions are created by any mission event.** `mission_proposed`, `mission_claimed`, `mission_vetoed`, `mission_started`, `step`, `kept`, `reverted`, and `mission_ended` create the mission (status `proposed`, member null) when its id is new, then apply. `budget_reserved` and `budget_released` never create a mission.
- **`mission_proposed` on a known mission is ignored.**
- **Statuses only move forward.** Rank: `proposed` < `claimed` < `running` < `ended`. `dropped` and `vetoed` are final. An event that would move a status backward, or out of a final status, leaves the status unchanged with no warning. Exceptions: `mission_ended` always sets `ended` and always counts its cost, because money spent is real even on a vetoed mission.
- **Claims.** The holder claiming its own key again is a no-op. A duplicate claim always warns `duplicate_claim`; the mission becomes `dropped` only when its status was `proposed`.
- **Vetoes.** An allowed veto changes only a `proposed` or `claimed` mission. `veto_not_owner` is checked first.
- **Asks.** `ask_answered_by_agent` is checked before `unknown_ask`. `ask_opened` with an id that is already open is ignored.
- **Reservations.** `budget_reserved` for a mission whose status is `ended` is ignored.
- **Seats.** Seats inside `campaign_started` are deduplicated like `seat_filled`. A seat object without a role gets role null.
- **After finishing.** A `done` from a non-human actor always warns `done_without_judge`, finished or not. A second `stopped`, a human `done`, or a passing `judge_ran` after finishing is silent.
- **Confidence.** `answered` means finished by the judge (stop_reason `judge_passed`). Any other campaign whose latest run passed is `leaning` or `stronger` by its passing streak, whether standing or not.
- **Order.** `seq` compares as a number; `origin` and `id` compare as plain strings. `last_judge.at` is the event's `at` exactly as written.
- **Decide.** `decide` reads `view.state`; it never recomputes state. "Fits" is inclusive (estimate <= available), so a 0 estimate does not fit a negative available.

## State (computed after all events)

First match wins:

1. finished: `done`
2. `budget.spent >= budget.total`: `out_of_budget`, stop_reason `budget_spent`
3. paused: `paused`
4. any open ask: `needs_you`
5. any mission `running`: `running`
6. any mission `proposed` or `claimed`: `queued`
7. otherwise `resting`

`stop_reason` is null unless rule 1 or 2 set it.

## Answer and confidence

- `answer.text` is the latest judge run's `data.summary`, or null.
- `confidence`:
  - no judge runs: `open`
  - finished by the judge: `answered`
  - latest run passed: `stronger` when the last 3 or more runs all passed, otherwise `leaning`
  - latest run failed: the run's `data.confidence` hint if present, otherwise `open`

## Budget

- `total`: start budget plus every `budget_added`
- `spent`: sum of `mission_ended` costs
- `reserved`: sum of open reservations
- `available`: `total - spent - reserved` (can go below zero)

## The view

Exact keys, in this shape. Lists keep the order their first event was applied.

```json
{
  "id": "cmp-ship",
  "title": "...",
  "judge": "...",
  "owner": "mission-lead",
  "standing": false,
  "bet": { "text": "...", "wrong_if": null },
  "parent": null,
  "home": "laptop",
  "created_from": null,
  "seats": [{ "member": "builder", "role": "builder" }],
  "state": "running",
  "stop_reason": null,
  "answer": { "text": null, "confidence": "open" },
  "budget": { "total": 500, "spent": 2.25, "reserved": 0, "available": 497.75 },
  "asks": [{ "id": "a1", "question": "...", "mission_id": null }],
  "missions": [
    { "id": "m1", "member": "builder", "status": "ended", "outcome": "kept", "cost_usd": 2.25,
      "estimate_usd": null, "steps": 0, "kept": 0, "reverted": 0 }
  ],
  "judge_runs": 0,
  "judge_due": true,
  "last_judge": null,
  "warnings": [{ "event_id": "evt-0009", "code": "done_without_judge" }]
}
```

- A mission's `outcome` and `cost_usd` are null until it ends.
- `judge_due` is true when the judge has never run, or when a `mission_ended` or an allowed `judge_set` was applied after the latest `judge_ran` (fold order).
- `last_judge` is `{ "passed": bool, "reading": number or null, "at": "<the event's at>" }` for the latest run.
- `warnings` keeps the order the events were applied.
- Screens treat `warnings[].code` as an open string: a new code must never stop a view from decoding. Every other enum (`state`, `stop_reason`, `confidence`, mission `status` and `outcome`) is closed, so a new value there ships to screens before computers send it.

## Decide (next move, pure)

`decide(view)` returns one of:

- `{ "action": "none", "reason": "finished" }` when done
- `{ "action": "none", "reason": "budget spent" }` when out of budget
- `{ "action": "none", "reason": "paused" }` when paused
- `{ "action": "wait", "reason": "open asks", "asks": [ids] }` when an ask is open
- `{ "action": "run_judge" }` when `judge_due`
- `{ "action": "start_mission", "mission_id": id }` for the first `claimed` mission whose estimate (0 when null) fits in `available`
- `{ "action": "wait", "reason": "budget" }` when claimed missions exist but none fits
- `{ "action": "wait", "reason": "missions running" }` when a mission is running
- `{ "action": "propose", "reason": "no missions queued" }` otherwise


## Surfaces and the judge

Two kinds of surface take part:

- **Computers fold.** The CLI (`atris-cli`) and the backend (`atrisos-backend`) run campaigns, so each implements `fold` and `decide` from this file.
- **Screens decode.** Desktop (`atris-desktop-v2`), web (`atrisos-web`), and terrace (`terrace`, iOS) never fold. They receive the view from a computer, so each proves its native model decodes every golden view and encodes it back unchanged. A screen that computes campaign state on its own is the bug this design forbids.

Each surface ships one executable at `scripts/campaign-fold-runner` in its own repo (any language; a shell wrapper is fine). The judge runs it with the repo as the working directory and the fixtures folder as the only argument:

```text
scripts/campaign-fold-runner /abs/path/to/test/fixtures/campaign
```

It prints one JSON object on stdout and exits 0:

```json
{
  "surface": "backend",
  "kind": "fold",
  "results": { "<golden name>": <view or {"error": code}> },
  "decide": [ <decide output for each case in decide-cases.json, in order> ]
}
```

- `kind` is `fold` for computers and `view` for screens.
- A fold runner reads every golden file except `decide-cases.json`, folds its `events`, and reports the output under the file's `name`. It also runs `decide` on each case's `view`.
- A view runner reads every golden file whose `expected` is a view (skip `{"error"}` files and `decide-cases.json`), decodes `expected` into its native campaign model, encodes it back to JSON, and reports that. It omits `decide`.
- Print JSON numbers as plain numbers: `497.75`, `0`, `1`. The judge compares values, not text, so key order and `1` versus `1.0` do not matter.

The judge (`node scripts/campaign-conformance.js` in `atris-cli`) checks `MANIFEST.json` hashes first, then runs every surface and compares each result with `expected`. It exits 0 only when every surface matches every file. A missing runner counts as a failure.
