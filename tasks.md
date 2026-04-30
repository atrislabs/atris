# Atris Tasks

Tasks are the atomic unit of work in Atris.

They are built for humans, agents, desktop UI, cloud teams, Swarlo coordination, and RL-style evaluation to share one work contract.

```text
Need something done
  -> create a task
  -> add context in the task thread
  -> claim it
  -> do the work
  -> attach proof
  -> review the result
  -> create the next sharper task
```

## Current Status

The local task loop works today.

```text
SQLite DB                ~/.atris/tasks.db
Workspace projection     .atris/state/tasks.projection.json
Human fallback view      atris/TODO.md
Review episodes          .atris/state/task_episodes.jsonl
CLI surface              atris task ...
Desktop surface          Atris Desktop Tasks / Command Center
Cloud sync               atris task sync --dry-run
```

A task can be created, claimed, discussed, finished, reviewed, exported for UI, and mapped to cloud writes.

## Why This Exists

`TODO.md` is easy to read but bad as source of truth.

Multiple agents can clobber it.

Markdown has no atomic claims.

It is hard to sync cleanly to a cloud app.

It is hard to turn into training data.

Atris Tasks fixes that by keeping durable state in SQLite and rendering markdown/projections from that state.

## The Data Model

The durable local database lives at:

```text
~/.atris/tasks.db
```

The core tables are:

```text
tasks
  id
  title
  status
  tag
  workspace_root
  source_key
  claimed_by
  claimed_at
  created_at
  updated_at
  done_at
  metadata

task_events
  event_id
  task_id
  version
  workspace_root
  actor
  event_type
  payload
  created_at
```

The important design choice is append-only events.

A task row says what the latest state is.

The event stream says how it got there.

## Task States

The CLI currently stores these task states:

```text
open      ready to plan or start
claimed   someone is doing it
done      work has been completed
failed    work could not complete cleanly
```

Product surfaces can map these into the Atris work loop:

```text
Plan      open
Do        claimed
Review    done without positive review reward, or failed/blocked
Done      done with review/proof
```

This lets the UI stay intuitive without changing the durable contract too early.

## CLI Usage

Create a task:

```bash
atris task new "Make the task board show active work" --tag ui
```

Claim the next task:

```bash
atris task next --as codex
```

Claim a specific task:

```bash
atris task claim <task_id> --as codex
```

Add context to the task thread:

```bash
atris task say <task_id> "User wants to see who is doing what" --as codex
```

Finish with proof:

```bash
atris task finish <task_id> --proof "npm run typecheck && npm run build passed" --as codex
```

Record review, lesson, and the next task:

```bash
atris task review <task_id> \
  --reward 1 \
  --proof "verified in Atris Desktop" \
  --lesson "small task rooms beat global TODO files" \
  --next "Add voice task creation"
```

Use `--json` for headless agents:

```bash
atris task next --as codex --json
```

## UI Projection

Every state change refreshes:

```text
.atris/state/tasks.projection.json
```

That projection is intentionally compact and UI-friendly.

It includes:

```text
task title
status
tag
claimed_by
current_version
latest_event_type
messages
events
review proof
review lesson
next task suggestion
lineage
work streams
goals
```

Desktop and web apps should read the projection, not the SQLite file directly.

That keeps local DB details private while giving every UI a stable task board contract.

## Goals And Self-Improvement

Tasks should connect to `atris/goals.md`.

The projection reads goals from:

```text
atris/goals.md
goals.md
atris/wiki/concepts/atris-labs-goals.md
```

Each task gets mapped to an objective.

The projection also groups tasks into work streams, so an agent or UI can answer:

```text
Which goal is this task serving?
What is active under that goal?
What has been completed?
What is blocked or waiting for review?
What should we do next?
```

The recursive self-improvement loop is:

```text
atris task next --as <agent>
  -> work the task
  -> atris task finish <id> --proof "..."
  -> atris task review <id> --reward 1 --lesson "..." --next "..." --create-next
  -> atris task --json
```

That produces:

```text
task event trace
review episode
goal-linked projection
next task suggestion
```

This is the nightly compounding loop.

## Atris Desktop Command Center

Atris Desktop reads `.atris/state/tasks.projection.json` from each local project.

It shows the same task loop as a board:

```text
Plan -> Do -> Review -> Done
```

It can create, claim, finish, and review tasks through Electron IPC wrappers around `atris task`.

The Command Center rail answers:

```text
What is active?
Who owns it?
What needs review?
What is the next ready task?
What proof exists?
```

Voice should eventually talk to the Command Center, not to random chat.

## Cloud Sync

Cloud sync is currently safe by default.

It only creates a plan:

```bash
atris task sync --dry-run --business-id <business_id> --json
```

The dry-run maps local tasks to canonical cloud task writes:

```text
POST  /business/{business_id}/work/tasks
PATCH /business/{business_id}/work/tasks/{cloud_task_id}
```

The cloud payload includes:

```text
title
description
owner_member_id
state
metadata.local_task_id
metadata.workspace_root
metadata.current_version
metadata.latest_event_type
metadata.swarlo.lease_owner
metadata.swarlo.lease_state
metadata.swarlo.lease_started_at
```

This is the bridge from local repo work to the Atris company OS.

The next production step is authenticated apply mode with idempotent `cloud_task_id` mapping.

## Swarlo

Swarlo is the live coordination layer.

The local task DB is durable truth.

Swarlo should handle leases, heartbeats, worker presence, and live reports.

```text
local task DB
  -> durable task truth

Swarlo
  -> who is holding the lease right now
  -> heartbeat
  -> progress report
  -> done report

cloud task DB
  -> shared company truth
```

Today, `atris task sync --dry-run` already emits Swarlo-style lease metadata from local claims.

The next step is a real handshake:

```text
agent claims task locally
  -> Swarlo lease starts
  -> agent heartbeats while working
  -> agent reports done/blocked
  -> canonical task state updates
```

## RL Environment

Tasks are a natural RL unit because they contain state, action, proof, reward, and lessons.

```text
state      task title, context, messages, repo, owner, history
action     claim, edit, run, message, finish, review
reward     review reward, tests passed, human approval, proof quality
trace      task_events
outcome    done, failed, blocked, next task
```

Review episodes are written to:

```text
.atris/state/task_episodes.jsonl
```

That file can become training/evaluation data without scraping chat logs.

The task is the label.

The proof is the evaluator input.

The event stream is the trajectory.

The review is the reward.

## Operating Rules

Use tasks for real work.

Keep each task small enough to understand in one screen.

Claim before doing work.

Attach proof before calling it done.

Use `review` to record lessons and next tasks.

Regenerate `TODO.md` from tasks when needed; do not make TODO the source of truth.

Use dry-run sync until cloud apply is explicitly enabled.

## Proof

Latest local smoke verified:

```text
create task        ok
claim task         ok
add thread note    ok
finish with proof  ok
review metadata    ok
cloud dry-run      ok
```

The cloud dry-run produced:

```text
POST /business/demo_business/work/tasks
state done
planned_writes 1
```

That means the local task loop and sync planner are working as a foundation.
