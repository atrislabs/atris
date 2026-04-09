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

## Collision: c65aaf9 vs 2279936

Forensic write-up of the 2026-04-08 multi-agent collision on
`commands/autopilot.js` that motivates this whole feature.

### Commit c65aaf9 — autopilot tick agent

- **Author:** Keshav <keshavrao250@gmail.com> (Co-Authored-By: Claude Opus 4.6)
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

- **Author:** Keshav <keshavrao250@gmail.com>
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
