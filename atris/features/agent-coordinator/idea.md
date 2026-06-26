# Agent Coordinator

> Status: planning
> Picked: 2026-04-08
> Source: inbox idea — multi-agent collision on `commands/autopilot.js`

## Problem

Multiple agents (autopilot ticks, sub-agents, codex, humans) edit the same files
concurrently and step on each other. No claim, no dep graph, no arbitration.

**Proof:** 2026-04-08 collision between an autopilot tick and a parallel
sub-agent on `commands/autopilot.js` produced commit-title drift — commit
`c65aaf9` was titled "M1 helper" but contained an inbox parser fix; the actual
M1 helper landed separately as `2279936` after manual recovery.

Without coordination, scaling to 50+ parallel agents will lose coherence.

## Goal

Thin coordination layer so concurrent agents don't clobber each other:

1. **File locks** — claim a file before editing; loser halts.
2. **Dependency graph** — task A blocks task B; B can't start until A clears.
3. **Conflict log** — collisions append to today's journal under a known section.
4. **Arbitration rules** — codified in `lessons.md`: first-claimer wins, loser
   halts, stale claims expire.

## Non-goals

- Not a full distributed lock service. Filesystem-based, single-repo scope.
- Not a scheduler. Agents still pick their own work; coordinator only mediates
  contention.
- Not a merge tool. If two agents legitimately need the same file, the second
  halts and requests human/loop arbitration.

## Sketch

```
.atris/locks/
  commands__autopilot.js.lock     # { agent, task, claimed_at, pid }
  TODO.md.lock
.atris/coord/
  deps.json                       # { "T42": ["T40","T41"], ... }
  conflicts.log                   # append-only collision record
```

- `atris claim <file> --task T# --agent <name>` → writes lock or exits non-zero.
- `atris release <file>` → removes lock (or auto-release on stale TTL).
- Autopilot tick wraps its edit phase in claim/release.
- Conflict → append to journal `## Conflicts` + `.atris/coord/conflicts.log`.

## Queue position

Next endgame after the current `loop-self-seeds-horizons` horizon closes.

## Open questions

- TTL for stale locks? (proposed: 10 min, configurable)
- How does the dep graph get populated — manual `[blocks: T#]` tag or inferred?
- Does the lock live in git (visible to all clones) or only locally?

## Prior art

Survey of existing lock/claim/lease/mutex patterns in `commands/`, `lib/`, `.atris/` (2026-04-08, T29). No filesystem locks, no PID files, no leases, no mutexes. Only TODO.md "Claimed by:" string markers and a remote fleet API.

**TODO.md task-claim string markers** (textual, no filesystem lock):
- `lib/todo.js:7,82-85` — parser for `**Claimed by:** <agent>` lines under In Progress.
- `commands/clean.js:138-175` — stale-claim detector: parses `Claimed by: <agent> at <ISO>`, flags >3 days as stale.
- `commands/autopilot.js:51,73-80` — surfaces stale/in-progress claims as next-task suggestions.
- `commands/run.js:65` — executor prompt instructs the agent to write `**Claimed by:** Executor at <ISO>`.
- `commands/autopilot.js:446` — same instruction in the autopilot do-phase prompt.
- `commands/workflow.js:516-517` — manual workflow doc: "claim next unclaimed Backlog task".
- `commands/status.js:236` — displays `t.claimed || 'unclaimed'`.
- `commands/init.js:624` — onboarding checklist item.

**Remote fleet API claims** (network, not filesystem):
- `commands/fleet.js:8-9,162-185,228-237,343,368-370` — `atris fleet claim <task_key>` POSTs to a hub `/api/<id>/claims` endpoint. Server-side, not local.

**Not locks (false positives swept):**
- `commands/serve.js:36` — comment "won't lock the CLI" (timeout, not a lock).
- `lib/file-ops.js:67`, `lib/journal.js:230` — "never block journal creation" (control flow, not a lock).
- `commands/brainstorm.js:931` — "Vision locked in" (UX string).
- "block" hits in autopilot/status/brainstorm/file-ops/sync/init = markdown-block helpers, not blocking primitives.
- `commands/clean.js` "stale tasks" = TODO.md string parsing, no filesystem lease.

**`.atris/` directory:** no `locks/`, `coord/`, or lease files. Only `scratch-t27a-heartbeat.txt`, `scheduled_tasks.lock` (Claude Code internal, not ours), and `business.json`.

**Conclusion:** zero filesystem-level lock primitives exist. T30+ builds greenfield. The only existing "claim" concept is the textual `**Claimed by:**` line in TODO.md, which is advisory-only and has no atomicity guarantee — exactly the gap that produced the c65aaf9/2279936 collision.

---

## Collision: c65aaf9 vs 2279936

Forensic write-up of the 2026-04-08 multi-agent collision on
`commands/autopilot.js` that motivates this whole feature.

### Commit c65aaf9 — autopilot tick agent

- **Author:** Keshav <dev@example.com> (Co-Authored-By: Claude Opus 4.6)
- **Date:** Wed Apr 8 12:12:06 2026 -0700
- **Subject:** `autopilot: add getIdleTickCount helper (M1)`
- **Written by:** an `atris autopilot` tick running the M1 task. The tick had
  been running since ~12:00 (its plan phase later timed out at 748s per the
  2279936 message), and committed in its do/review window at 12:12.

```diff
diff --git a/atris/lessons.md b/atris/lessons.md
@@ -17,3 +17,9 @@
+- **[2026-04-08] benchmark-prompt-paths** — fail — ...
+- **[2026-04-08] clean-absolute-source-paths** — fail — ...
+- **[2026-04-08] no-authed-route-group** — pass — ...
+- **[2026-04-08] inbox-trigger-survives-shipping** — pass — ...
+- **[2026-04-08] inbox-parser-eats-hr-separator** — fail — ...
+- **[2026-04-08] inbox-parser-fix-shipped** — pass — ...
diff --git a/commands/autopilot.js b/commands/autopilot.js
@@ -113,7 +113,10 @@ function suggestNextTask(cwd, skipped = new Set()) {
     const inboxMatch = content.match(/## Inbox\n([\s\S]*?)(?=\n##|$)/);
     if (inboxMatch && inboxMatch[1].trim()) {
-      const items = inboxMatch[1].trim().split('\n').filter(l => l.trim().startsWith('-'));
+      const items = inboxMatch[1].trim().split('\n').filter(l => {
+        const t = l.trim();
+        return t.startsWith('- ') && t.length > 2;
+      });
```

The diff is **only** the inbox-parser `--` separator fix plus six lessons
appended. There is no `getIdleTickCount` function anywhere in the patch.

### Commit 2279936 — recovery commit (parallel sub-agent)

- **Author:** Keshav <dev@example.com>
- **Date:** Wed Apr 8 12:14:38 2026 -0700 (≈ 2m32s after c65aaf9)
- **Subject:** `fix(autopilot): commit the real M1 helper (getIdleTickCount)`
- **Written by:** a parallel sub-agent doing manual recovery after noticing
  the title/content mismatch in c65aaf9.

```diff
diff --git a/commands/autopilot.js b/commands/autopilot.js
@@ -639,6 +639,41 @@ function printTickStatus(cwd) {
+/**
+ * Count consecutive idle-tick markers at the bottom of today's journal `## Notes`.
+ * ...
+ */
+function getIdleTickCount(cwd) {
+  const now = new Date();
+  ...
+  if (!fs.existsSync(journalPath)) return 0;
+  const content = fs.readFileSync(journalPath, 'utf8');
+  const notesMatch = content.match(/##\s+Notes\s*\n([\s\S]*?)(?=\n##\s|$)/);
+  if (!notesMatch) return 0;
+  const marker = '0 tasks in 0s';
+  const lines = notesMatch[1].split('\n');
+  let count = 0;
+  for (let i = lines.length - 1; i >= 0; i--) {
+    const line = lines[i];
+    if (!line.trim()) continue;
+    if (line.toLowerCase().includes(marker)) { count += 1; continue; }
+    break;
+  }
+  return count;
+}
@@ -816,6 +851,7 @@ module.exports = {
+  getIdleTickCount,
```

This diff contains the **actual** M1 helper that c65aaf9's title promised.

### Timeline

| Time (PDT) | Agent | Action |
|---|---|---|
| ~12:00     | autopilot tick A      | Starts M1 plan phase against `commands/autopilot.js`; stages helper in working tree |
| ~12:00–12:12 | sub-agent B          | Concurrently editing `commands/autopilot.js` to fix the inbox-parser `---` bug |
| 12:12:06   | sub-agent B (commits) | `c65aaf9` lands — diff = inbox parser fix + 6 lessons; **title** = "add getIdleTickCount helper (M1)" (inherited from tick A's stale task header in the agent's commit context) |
| ~12:12–12:14 | autopilot tick A    | Plan phase finally times out at 748s; never reaches its own commit step. Helper still sits unstaged from B's perspective |
| 12:14:38   | recovery sub-agent    | `2279936` lands — diff = the real `getIdleTickCount` function + module export; title corrects the record |

Wallclock overlap window where both agents had `commands/autopilot.js` open
and dirty: **roughly 12:00 → 12:14 PDT**, ~14 minutes. The two commits
themselves are 2m32s apart on the same file.

### Drift

- **c65aaf9** — title says "add getIdleTickCount helper (M1)", diff actually
  ships the inbox-parser `- ` filter fix and six lessons. **Zero overlap**
  between subject line and patch contents. The helper is not present.
- **2279936** — title says "commit the real M1 helper (getIdleTickCount)",
  diff actually adds that function and exports it. Title and contents agree;
  the commit message itself documents the prior drift in plain English.

### Root cause

Two agents held `commands/autopilot.js` dirty at the same time with no claim
or arbitration: an `atris autopilot` tick was mid-plan on M1 (the
`getIdleTickCount` helper) with the helper staged but not yet committed,
while a parallel sub-agent independently patched the inbox-parser bug in the
same file. When the sub-agent committed at 12:12:06, the autopilot tick's
in-flight task header ("M1 helper") was the freshest task context in the
shared agent state, so the sub-agent's commit inherited that subject line —
but the diff was only the sub-agent's own inbox-parser change. The plan
phase then timed out at 748s without ever committing the helper, stranding
real M1 work in the working tree until a recovery sub-agent landed it
explicitly as `2279936` two and a half minutes later. Nothing was lost
because the quality contract halted on the mismatch, but commit titles
drifted from commit contents — exactly the failure mode a file-claim
primitive (first-claimer-wins on `commands/autopilot.js`, loser halts) is
designed to make impossible.

---

## Decision: lock storage

Where does a file-claim lock physically live? Three candidates, scored on
visibility (can other agents/clones see the claim?), staleness (how fast do
dead claims rot?), and merge-conflict risk (does the lock itself cause the
kind of collision it's meant to prevent?).

| Option | Visibility | Staleness | Merge-conflict risk |
|---|---|---|---|
| (a) `.atris/locks/` gitignored, local-only | low — invisible across clones/CI, only the local shell sees it | good — dies with the machine, PID check is cheap and authoritative | none — never committed |
| (b) `atris/locks/` tracked in git | high — every clone sees every claim | bad — a stale claim survives forever until someone commits a delete; crash = permanent lock | **high** — every claim is a commit on a shared directory; two agents claiming in parallel produces the exact collision this feature exists to stop |
| (c) **CHOSEN** — hybrid: claim in git (`atris/locks/*.lock`), heartbeat local (`.atris/locks/*.heartbeat`) | high on the claim itself; heartbeat is local-only but TTL-bounded | good — heartbeat TTL (default 10 min) expires the claim without needing a commit; `atris claim` treats missing/stale heartbeat as reclaimable | medium — claim files still land in git, but they're single-writer by definition (first-claimer-wins), and the heartbeat churn stays out of the tree |

**CHOSEN: (c) hybrid.** Option (a) fails the core requirement — a 50-agent
fleet needs cross-process visibility of who owns what, and a gitignored lock
can't give that. Option (b) is visible but turns every claim into a
merge-conflict surface, reintroducing the collision class we're eliminating.
The hybrid keeps the authoritative claim in git (visible to every agent and
CI) while pushing high-frequency liveness signals to a local heartbeat file
whose TTL lets `atris claim` break stale locks without a human commit.

---

## Schema: lock file

A lock file represents a single agent's claim on a single repo-relative path.
Claim files live in `atris/locks/` (tracked in git; cross-clone visible).
Heartbeat files live in `.atris/locks/` (gitignored; local-only liveness).
Both share the same filename encoding and the same JSON body shape.

### Filename encoding

The claimed path is encoded into the lock filename by replacing every `/`
with `__` and appending `.lock`. The encoding is reversible and produces no
subdirectories, so `atris/locks/` stays flat and globbable.

| Claimed path | Lock filename |
|---|---|
| `commands/autopilot.js` | `commands__autopilot.js.lock` |
| `atris/features/agent-coordinator/idea.md` | `atris__features__agent-coordinator__idea.md.lock` |
| `TODO.md` | `TODO.md.lock` |
| `lib/wiki.js` | `lib__wiki.js.lock` |

Rules:
- Only `/` is encoded. Dots, dashes, and underscores pass through untouched.
- Paths must be repo-relative and POSIX-style (forward slashes only).
- A literal `__` in a source path is not supported — flag and halt. None
  exist in this repo today.

### JSON body shape

```json
{
  "agent": "string — human or agent identifier (e.g. 'executor', 'autopilot-tick', 'keshav')",
  "task": "string — task ID from TODO.md (e.g. 'T31') or free-form slug if ad-hoc",
  "claimed_at": "string — ISO 8601 UTC timestamp with milliseconds (e.g. '2026-04-09T01:28:15.117Z')",
  "pid": "number — OS process ID of the claiming process (used by heartbeat liveness check)",
  "ttl_seconds": "number — stale-TTL in seconds; claim is reclaimable after claimed_at + ttl_seconds with no heartbeat refresh",
  "host": "string — os.hostname() of the claiming machine (disambiguates PIDs across clones)"
}
```

All six fields are required. Unknown fields are ignored on read but
forbidden on write (keeps the schema tight).

### Stale-TTL default + override

- **Default:** `600` seconds (10 minutes). Long enough to survive a normal
  plan→do→review cycle, short enough that a crashed agent doesn't block the
  fleet for more than one coffee break.
- **Override:** `ATRIS_LOCK_TTL_SECONDS` env var. If set and parseable as a
  positive integer, it replaces the default for any new claim written by
  that process. Existing locks keep whatever TTL they were written with —
  the TTL is baked into the lock file itself, not read dynamically.
- **Reclaim rule:** `atris claim` treats a lock as stale (and therefore
  reclaimable) when `now - claimed_at > ttl_seconds` AND the local heartbeat
  file is missing or older than `ttl_seconds`. Both conditions must hold so
  a live long-running task refreshing its heartbeat is never stolen.

### Example lock file

Path: `atris/locks/commands__autopilot.js.lock`

```json
{
  "agent": "executor",
  "task": "T31",
  "claimed_at": "2026-04-09T01:28:15.117Z",
  "pid": 48213,
  "ttl_seconds": 600,
  "host": "keshavs-mbp.local"
}
```

Decoded: the `executor` agent, running as PID 48213 on `keshavs-mbp.local`,
claimed `commands/autopilot.js` at `2026-04-09T01:28:15.117Z` for task `T31`
with a 10-minute stale TTL. Any other agent hitting this path before
`2026-04-09T01:38:15.117Z` (or before the heartbeat at
`.atris/locks/commands__autopilot.js.heartbeat` goes cold) halts.

---

## CLI surface

The two commands an executor needs to implement in `commands/claim.js` and
`commands/release.js`. They wrap the filename encoding from
`## Schema: lock file` (`/` → `__`) and the hybrid storage from
`## Decision: lock storage` (authoritative claim in `atris/locks/*.lock`,
local heartbeat in `.atris/locks/*.heartbeat`). No new primitives here —
just the operator-facing surface over the already-decided schema.

### Usage

```
atris claim <path> --task T# --agent <name> [--ttl <sec>] [--force]
atris release <path>
```

- `<path>` is repo-relative, POSIX-style, and gets filename-encoded per
  `## Schema: lock file` (e.g. `commands/autopilot.js` →
  `commands__autopilot.js.lock`). A literal `__` in the source path is a
  usage error (exit `1`) — the encoding is not reversible otherwise.
- `atris claim` writes BOTH the git-tracked claim file at
  `atris/locks/<encoded>.lock` and the local heartbeat at
  `.atris/locks/<encoded>.heartbeat` in one step (hybrid storage).
- `atris release` removes both files. Releasing a lock you don't own is a
  no-op unless `--force` is passed.

### Flags

| Flag | Type | Default | Purpose |
|---|---|---|---|
| `--task` | string (required) | — | Task ID from `atris/TODO.md` (e.g. `T32`) or free-form slug. Written to the `task` field of the lock body. |
| `--agent` | string (required) | — | Human or agent identifier (`executor`, `autopilot-tick`, `keshav`). Written to the `agent` field; identity check for release and reclaim. |
| `--ttl` | integer seconds | `600` (or `ATRIS_LOCK_TTL_SECONDS` if set) | Stale-TTL baked into the lock body's `ttl_seconds` field. Per `## Schema: lock file` the TTL is frozen at write time, not read dynamically. |
| `--force` | boolean flag | `false` | On `claim`: reclaim a stale/broken lock (exit `3` without it). On `release`: remove a lock owned by a different agent. Never breaks a live lock whose heartbeat is fresh. |

### Exit codes

| Code | Meaning | When |
|---|---|---|
| `0` | claimed / released | Lock written (or removed) successfully. Stdout prints the encoded lock filename. |
| `1` | usage error | Missing `--task`/`--agent`, path contains `__`, path is absolute or non-POSIX, or the flag parse fails. |
| `2` | already claimed by a different agent | Live lock exists for `<path>`, owned by someone else, heartbeat is fresh. Loser halts per arbitration rule. Stderr prints owner + claimed_at + remaining TTL. |
| `3` | stale/broken lock found | Lock file exists but `now - claimed_at > ttl_seconds` AND heartbeat is missing/cold, OR the lock body is malformed JSON. Reclaimable only with `--force`; without it the command exits `3` so a human can look. |

Exit code `2` is the first-claimer-wins signal — the second caller gets a
hard non-zero and is expected to halt, not retry in a loop. Exit code `3`
separates "this lock is dead" from "this lock is live and someone else owns
it" so stale reclaim never races with legitimate ownership.

### Example session — first-claimer-wins

Two agents race on `commands/autopilot.js`. Agent A calls `atris claim`
first, wins, and gets exit `0`. Agent B calls the same command a moment
later, sees A's live lock, and gets exit `2`:

```sh
$ atris claim commands/autopilot.js --task T32 --agent executor-A   # exit 0
claimed commands__autopilot.js.lock
$ atris claim commands/autopilot.js --task T32 --agent executor-B   # exit 2
error: commands/autopilot.js already claimed by executor-A (T32, 9m left)
```

Agent B reads exit `2` and halts its edit phase. When A finishes its work
and calls `atris release commands/autopilot.js`, the lock is removed and B
(or any later agent) can claim it cleanly.
