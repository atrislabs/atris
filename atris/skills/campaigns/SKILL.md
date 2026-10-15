---
name: campaigns
description: "Run an Atris campaign: a long goal with a judge that fails today, a budget, and members in seats, worked by missions until the judge passes. Use when the goal takes many runs, needs several members, or must spend under a cap. Triggers on: run a campaign, long goal, big goal, keep going until it passes, campaign, judge, budget, atris campaign."
version: 1.0.0
tags:
  - campaign
  - judge
  - budget
  - missions
  - mcp
---

# Campaigns

A campaign is a goal plus a judge. The judge is a command that exits 0 only when the goal is met. The campaign runs missions under a budget until the judge passes, the money runs out, or a person has to decide something.

## Campaign or mission

- **Mission**: one member, one objective, one check. Done in a run or a few ticks.
- **Campaign**: the goal needs many missions, more than one member, or a spending cap. A campaign decides what to do next; its missions do the work.

If one `atris mission start` would finish it, use a mission.

## The five commands

```bash
atris campaign "<goal>"                      # drafts a judge, proves it fails today, starts on a yes (agents pass --yes; --run keeps going)
atris campaign run <id> --max-steps 5        # judge, propose missions, run them; stops and says why
atris campaign show <id>                     # judge reading, money, missions, open asks, next move
atris campaign answer <id> <ask-id> "<yes>"  # a person answers; agents cannot
atris campaign sync <id>                     # share it with the Atris web app and iOS
```

`atris campaign "<goal>"` is the same as `atris campaign new "<goal>"`. Already have a judge? Start directly: `atris campaign "<goal>" --judge "<command>"`. A local campaign needs no budget; one that runs in the cloud does (`--budget 20`). Add `--json` to any verb for machine output. `atris campaign` alone lists every campaign and its next move.

## Write a good judge

1. **Outside the model.** Tests, counts, greps, a build, a local script. Never ask a model whether it is done.
2. **Fails first.** A judge that passes today is refused: it cannot tell you when the work landed.
3. **Graded.** Print progress, not just exit status. Lines like `ℹ pass 3` and `ℹ fail 2` become the campaign's answer, so a person sees 3 of 5 instead of "failed".
4. **Read only and quick.** It runs after every mission. It changes nothing and finishes in minutes.

`atris campaign new` writes the judge to `atris/campaigns/<id>/judge.sh`. Read it before you start; edit it if it checks the wrong thing.

## The no-reload line

Before anything that cannot be undone (sending, paying, deleting, deploying, publishing), stop and ask:

```bash
atris campaign ask <id> "Deploy the billing change to production?"
```

The campaign waits. `run` stops with `needs you: 1 open ask`. Only a person closes an ask, in their own terminal. An agent that writes an answer leaves the ask open with a warning.

## From an MCP client

`atris mcp` serves the same verbs as tools: `campaign_list`, `campaign_show`, `campaign_new`, `campaign_start`, `campaign_run` (takes `max_steps`, returns `reason`), `campaign_ask`, `campaign_answer`. Every write is recorded as an agent. `campaign_answer` returns the `person_command` the person runs to close the ask.

## 60-second example

```bash
atris campaign new "every command in bin/atris.js has a --help that exits 0"
# draft for: every command ...
# judge     sh atris/campaigns/cmp-help-everywhere-1a2b/judge.sh
# today     fails, as it should: pass 41, fail 6
# start it:  atris campaign start 'Help everywhere' --judge 'sh atris/campaigns/cmp-help-everywhere-1a2b/judge.sh' ...
atris campaign start 'Help everywhere' --judge 'sh atris/campaigns/cmp-help-everywhere-1a2b/judge.sh' --budget 20 --id cmp-help-everywhere-1a2b
atris campaign run cmp-help-everywhere-1a2b --max-steps 5
# stopped after 4 steps: finished
atris campaign show cmp-help-everywhere-1a2b
# state     done (judge passed)
# answer    answered: pass 47, fail 0
# budget    $6.20 spent of $20.00
```

## Rules

- No campaign without a judge that fails today.
- Only the judge or a person finishes a campaign. An agent saying done changes nothing.
- Every mission reports what it spent. When the budget is gone, the campaign stops.
- Bound every run with `--max-steps`, then read the stop reason before running again.
