# Try Campaign

Campaign is the struct for long-horizon work: a goal with a judge, a budget, and members in seats, made of missions. This page gets a new person from zero to seeing it work in about ten minutes.

## What exists today

- **The core, in atris-cli.** A schema (`lib/campaign-schema.js`), a pure fold and decide (`lib/campaign-core.js`), and a SQLite event store (`lib/campaign-store.js`).
- **`atris campaign` commands** (branch `campaign/phase2-cli-verbs`): list, start, show, judge, seat, bet, budget, pause, resume, stop, and a by-hand `event` verb, each with `--json`.
- **One contract for every surface.** `test/fixtures/campaign/README.md` says how events become state. 20 golden files and 14 decide cases prove it, pinned by `MANIFEST.json`.
- **A judge across five repos.** `npm run validate:campaign` checks that the CLI and backend fold events identically, and that desktop, web, and terrace decode the result identically.
- **Five branches, one per repo:**

| Surface | Repo | Branch | What it adds |
|---|---|---|---|
| cli | atris-cli | `campaign/core-schema-fold` | core, store, golden files, judge |
| backend | atrisos-backend | `campaign/python-fold` | `backend/services/campaign_fold.py` |
| desktop | atris-desktop-v2 | `campaign/view-model` | `src/lib/campaignView.ts` |
| web | atrisos-web | `campaign/view-model` | `app/dashboard/preview/campaign-view.ts` |
| terrace (iOS) | terrace | `campaign/view-model` | `votd/CampaignView.swift` |

## Before you start

- Node 22.13 or newer. Check with `node --version`. Some shells on this Mac find Node 20 first at `/usr/local/bin/node`; use `/opt/homebrew/bin/node` if so.
- The five repos checked out side by side in one folder, for example `~/arena/empire/atris-cli`, `~/arena/empire/atrisos-backend`, and so on. The judge finds them by those folder names.
- Python 3 for the backend runner, and Xcode command line tools (`swiftc`) for the terrace runner.

## 1. Run the CLI tests

```bash
cd atris-cli
git fetch origin && git switch campaign/core-schema-fold
node --test test/campaign-schema.test.js test/campaign-core.test.js test/campaign-store.test.js test/campaign-conformance.test.js
```

Expect 71 passing tests and exit 0.

## 2. Run the judge

```bash
npm run validate:campaign
```

Before the other four branches merge, this fails, and that is correct: the judge for a new campaign must fail first. Point it at the branches to see every surface pass:

```bash
for r in atrisos-backend atris-desktop-v2 atrisos-web terrace; do
  b=campaign/view-model; [ $r = atrisos-backend ] && b=campaign/python-fold
  git -C ../$r fetch origin $b && git -C ../$r worktree add ../.try-$r origin/$b
done
node scripts/campaign-conformance.js \
  --surface backend=../.try-atrisos-backend \
  --surface desktop=../.try-atris-desktop-v2 \
  --surface web=../.try-atrisos-web \
  --surface terrace=../.try-terrace
```

Expect five `pass` lines and `judge passes`. Remove the try copies afterward with `git -C ../<repo> worktree remove ../.try-<repo>`.

## 3. Drive a campaign from the terminal

On the `campaign/phase2-cli-verbs` branch, point the store at a scratch file so you do not touch real campaigns, then play:

```bash
export ATRIS_CAMPAIGN_DB=/tmp/try-campaign.db
node bin/atris.js campaign start "Try it" --judge "echo two of five; exit 1" --budget 20 --id cmp-try
node bin/atris.js campaign start "Too easy" --judge true --budget 5     # refused: write a judge that fails first
node bin/atris.js campaign "Every command has a --help that exits 0" --run   # one sentence: drafts a judge, starts on a yes, keeps going
node bin/atris.js campaign seat cmp-try validator
node bin/atris.js campaign event cmp-try mission_started --data '{"mission_id":"m1","member":"builder"}'
node bin/atris.js campaign event cmp-try mission_ended --data '{"mission_id":"m1","outcome":"kept","cost_usd":4.4}'
node bin/atris.js campaign show cmp-try          # next: run the judge, because a mission ended
node bin/atris.js campaign judge cmp-try
node bin/atris.js campaign                       # every campaign and its next move
```

Or drive the library directly. Save this as `try-campaign.js` in the atris-cli root and run `node try-campaign.js`:

```js
const path = require('path');
const os = require('os');
const { createSqliteStore, getCampaign } = require('./lib/campaign-store');
const { decide } = require('./lib/campaign-core');

const store = createSqliteStore(path.join(os.tmpdir(), `try-campaign-${Date.now()}.db`));
const id = 'cmp-try-it';
const add = (type, data, actor = 'builder') => store.append({ campaign_id: id, type, actor, data });

add('campaign_started', { title: 'Try it', judge: 'npm run validate:campaign', budget: 20, owner: 'mission-lead' }, 'mission-lead');
console.log('1.', decide(getCampaign(store, id)));
add('judge_ran', { passed: false, summary: 'backend not built' }, 'judge');
add('mission_claimed', { mission_id: 'm1', claim_key: 'python fold' });
console.log('2.', decide(getCampaign(store, id)));
add('mission_started', { mission_id: 'm1', member: 'backend-feature-owner' });
add('mission_ended', { mission_id: 'm1', outcome: 'kept', cost_usd: 4.4 });
add('done', {}, 'builder');
console.log('3.', decide(getCampaign(store, id)));
add('judge_ran', { passed: true, summary: 'all five surfaces agree' }, 'judge');
const view = getCampaign(store, id);
console.log('4.', view.state, view.stop_reason, view.answer, view.budget, view.warnings);
```

What you should see, and why:

1. `run_judge`: a new campaign checks its judge first.
2. `start_mission m1`: the judge failed and a claimed mission fits the budget.
3. `run_judge` again: a mission ended, so the judge is due. The agent's `done` changed nothing.
4. `done judge_passed`, confidence `answered`, $4.40 spent of $20, and one warning, `done_without_judge`. Only the judge or a person can finish a campaign.

## 4. Try to break it

- **Edit any golden file** in `test/fixtures/campaign/`, then run the judge. It stops before running any surface and names the changed file.
- **Have an agent answer an ask**: append `ask_opened`, then `ask_answered` with actor `builder`. The ask stays open with warning `ask_answered_by_agent`. Use actor `human:<name>` to close it.
- **End a mission without a cost**: `mission_ended` without `cost_usd` is refused. Every mission reports what it spent.
- **Send a timestamp without a zone**: `2026-10-15T10:00:00` is refused, so no computer folds in its own timezone.

## 5. Cloud

A campaign on your laptop can sync with the Atris cloud, so web and iOS show it and an answer from your phone reaches a running loop. Sign in first with `atris login`. Point at a local backend with `ATRIS_API_URL=http://localhost:8000/api` if the routes are not deployed yet.

```bash
node bin/atris.js campaign start "Try the cloud" --judge "exit 1" --budget 5 --id cmp-try-cloud --cloud
node bin/atris.js campaign sync cmp-try-cloud           # sends what the cloud lacks, takes in answers and actions
node bin/atris.js campaign run cmp-try-cloud            # syncs before and after every step
```

What to expect:

- `sync` says how many events it sent and received. Run it twice and the second run sends and receives nothing.
- Answer an open ask on your phone, and the next sync (or the next step of `run`) closes it here, so the loop moves on.
- Offline, `run` warns once and keeps going. The next sync sends what it missed.
- A 403 or 409 from the cloud is shown as it is and not retried. `run` stops syncing for the rest of that run.
- Answers, added budget, and `done` only come from a person. On a synced campaign, `atris campaign answer` sends your answer through the cloud.

The routes are in `atris/features/campaign/api.md`. The tests run against a fake cloud: `node --test test/campaign-sync.test.js`.

## Where to read next

- `atris/features/campaign/idea.md`: the design and why.
- `atris/features/campaign/build.md`: the phases. Phases 0 and 1 are done here; Phase 2 (CLI verbs) and Phase 3 (missions joined to campaigns) are next.
- `test/fixtures/campaign/README.md`: the contract every surface follows.
- `atris/features/campaign/by-hand.md`: what running the first campaign by hand taught us.
- `atris/campaigns/cmp-ships-across-atris.md`: the campaign that built this, with its judge readings.

## Not built yet

- `atris campaign` verbs, and missions that join a campaign and reserve its budget.
- Backend routes for sync are being built; until they deploy, `atris campaign sync` shows the cloud's 404 as it is. The budget pool is billing and needs sign-off.
- Screens that show campaigns. The view models exist; the pages do not.
- Cost for engines other than Claude: their missions would spend without being counted.
