# COORDINATION.md — how agents and humans share this workspace without friction

> Forked from `terrace/atris/COORDINATION.md` (the reference implementation,
> proven 2026-06-10), in lockstep with the `atrisos-web/atris/COORDINATION.md`
> fork. Product-agnostic on purpose; this repo's product tag is **`cli`**, and
> the cross-repo **`chat-lane`** tag (the /atris2/turn surface) is owned by
> **relay** in terrace. If a rule here conflicts with an older doc, this wins.

## Where feedback goes (the whole point)

```
Keshav types bullets → today's log, under "## Feedback inbox"
       (atris/logs/2026/YYYY-MM-DD.md — from Cursor, phone, anywhere)
            ↓ any agent's next tick (≤15 min)
atris task add --tag cli  (+ say context, plan, verify cmd)
            ↓ bullet DELETED from inbox (inbox stays empty)
claim --as <member> → ship → ready --proof → PM accept → one-line receipt in the log
```

Every agent looks in exactly two places: the **inbox** (newest logs) and the
**plane** (`atris task`). If feedback is anywhere else, the first agent to see
it moves it to the inbox — never works from a side channel.

## The five rules

### 1. One plane

Open work lives in **`atris task`** (tag per product: `--tag cli`; cross-repo
chat-lane work: `--tag chat-lane`). Nothing else is a backlog:

| Surface | Is | Is NOT |
|---------|----|--------|
| `atris task` | the queue: state, claims, proofs, blocked lane | a journal |
| Daily log (`atris/logs/`) | inbox for raw feedback + one-line receipts after ship | a second backlog |
| TODO.md / feature folders / MAP.md | context and maps | where open bugs live |

Changing the plane is a **migration**: move every open item, leave a tombstone
pointer at the old location, done in one commit. Don't do it twice a quarter.

### 2. Claim before work — and only members claim

Tags have **owners**: each product tag belongs to a team member in
`atris/team/` (encoded as a task). The **`chat-lane`** tag belongs to
**relay** (terrace `atris/team/relay/MEMBER.md`) — the CLI is one of relay's
four surfaces (iOS, web, Obelisk, CLI), and the chat-lane probe commands are
how the lane is validated from this repo. Claiming inside a tag means acting
*as* its owner: `atris task claim <id> --as <member>` after reading that
member's MEMBER.md (+ SOUL.md when present).

- **Visiting agents never claim.** An agent passing through (a one-off Cursor
  session, a research agent, a cron from another project) may `atris task add`,
  `say` context, or `atris task delegate --to <member>` — then leave. Picking
  up a task you don't own is the bug this file exists to prevent.
- Claimed by someone else → skip it this tick. No exceptions for "it's quick".
- Finish or release: if you can't complete in your tick, `say` what you found
  and leave it claimed only if you'll resume next tick.
- **Many concurrent agents → use swarlo** (`arena/swarlo`): atomic `claim_next`,
  file-level locks via pre-commit hook, liveness. Same protocol,
  machine-enforced. Never both planes at once for the same tag.

### 3. Evidence has a timestamp

Before acting on another agent's triage, probe, or recommendation, check its
timestamp against the newest fix receipts. Pre-fix evidence is void.
Chat-lane claims need a live probe receipt from the current cycle — never
"it worked yesterday".

### 4. Files are shared

- `git status` before editing. Never revert changes you didn't make.
- A file mid-edit by someone else (uncommitted, not yours) → skip slices that
  need it this tick.
- Your diff stays inside your claimed task's scope.

### 5. Human waits are Blocked tasks, not buried sentences

Anything waiting on a human becomes a task tagged **`waiting-on-human`**,
titled "WAITING ON <who>: <exact action>"
(e.g. "WAITING ON Keshav: merge atrisos-backend PR #2017 + grant the IAM
secret read so member secrets resolve").
- One glance at `atris task` shows everything waiting on Keshav.
- Never note a human dependency only in a journal paragraph — it disappears.
- When the human acts, the unblocked task re-enters the normal lanes.

## Tick discipline (any agent, any loop)

```
1. Today's "## Feedback inbox" + atris task list --status open   ← not your memory
2. Inbox bullets → promote (add --tag cli + say + plan) → delete bullet
3. Top unclaimed item in your lane → claim --as <member> → plan → do → verify
   → ready --proof
4. One bounded slice per tick. Receipts: one line in today's log.
5. Blocked on a human? Rule 5. Nothing to do? End quietly.
```

## Roles route by lane, not by speed

Members own lanes (see `atris/team/`). A bug in another member's lane gets a
task + `delegate --to` naming the owner — not a fix from whoever saw it first.
Chat-lane bugs found here route to **relay** with a probe receipt attached.
Found work outside every member's lane? File it unowned and flag the gap to
the PM — a missing owner is itself feedback.
