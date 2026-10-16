# A campaign can run on a schedule

From the 2026-10-16 trigger research (research/agent-landscape/TRIGGERS.md): build the schedule trigger first, because it needs no outside account, no stored secret, and no public endpoint.

## The rule

A trigger can start work, but it cannot approve it. A schedule is a person's standing yes, given once when it is set. After that, each run starts on its own until the campaign's budget is spent, and a run that needs more money or an answer stops and asks, as any run does.

## How it works

- `atris campaign schedule <id> --every "weekdays 09:00" [--steps 4]` saves `campaigns/<id>/schedule.json` beside the campaign store. It is local, like `protect.json`, so the shared event contract and other surfaces do not change.
- Only a person can set one (an agent gets a refusal that points at `atris campaign ask`). The campaign must have a budget and must not be done. Anyone can remove one with `--off`.
- `--every` takes `daily 18:30`, `weekdays 09:00`, `weekends 10:00`, `mon,thu 07:00`, a bare `09:00` (every day), or an interval like `30m` or `2h`. Clock times are local to the computer running the timer.
- `atris campaign wake` (the one-minute timer from `keep --install`) and `atris campaign tick` (the overnight heartbeat) leave a scheduled campaign alone until its slot. When the slot comes, the slot is used up first, then the campaign gets one bounded run of up to `--steps` steps, one mission at a time.
- A slot missed while the computer slept fires once, as soon as it can. A run that crashes does not fire again until the next slot.

## Not yet

GitHub, Slack, and webhook triggers. Each needs inbound auth and a yes from a person before every run (TRIGGERS.md, Spec).

## The proof

`test/campaign-schedule.test.js`, and a real one-minute schedule on a laptop: wake skipped it before its minute, fired it once at the minute, and booked the next.
