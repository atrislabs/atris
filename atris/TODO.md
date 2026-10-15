# TODO.md

Details for any task: atris task show <ID>

> Regenerated from durable Atris task state. Do not treat this file as truth.

<!-- ATRIS_TODO_COMPACT:2 -->

## Endgame

**Slug:** zero-revision-nights
**Picked:** 2026-08-26 00:48
**Horizon:** Overnight agent work lands itself and holds up, proven the day Keshav reviews a full night of landed changes and changes nothing.
**Source:** user-prompt (Lauren Tan talk, atris/wiki/briefs/youtube-Cmoh-yR-usA.md)

## Backlog

(Empty)

## In Progress

(Empty)

## Review

- **[ACW-24]** Say when shared cleanup could not refresh its base · architect
  **Done looks like:** When the refresh fails, the cleanup output says so and why, and a healthy refresh prints nothing extra.
- **[ACW-23]** Stop a damaged remote from breaking the local record that start and ship use · architect
  **Done looks like:** After meeting a damaged remote, the local record still holds the last good commit, and a healthy remote still refreshes it.
- **[ACW-22]** Prove a normal cleanup leaves the local record of the remote main branch alone · architect
  **Done looks like:** Writers can trust a normal cleanup to remove landed work and keep their local record of the remote main branch unchanged.
- **[ACW-21]** Keep the local record of the remote main branch safe during cleanup · architect
  **Done looks like:** After cleanup meets a damaged remote, the local copy of its main branch still holds the last good commit.
- **[ACW-20]** Prove cleanup keeps notes when the remote main branch is not a commit · architect
  **Done looks like:** Writers can trust cleanup to keep every folder and all notes when the remote main branch is damaged.
- **[ACW-19]** Prove cleanup keeps notes when the remote default cannot be fetched · architect
  **Done looks like:** Writers can trust cleanup to keep every folder and all notes when the remote default branch cannot be fetched.
- **[ACW-18]** Prove cleanup keeps notes when the remote disappears · architect
  **Done looks like:** Writers can trust cleanup to keep every folder and all notes when the remote repository becomes unavailable.
- **[ACW-17]** Prove cleanup keeps notes when remote default is missing · architect
  **Done looks like:** Writers can trust cleanup to keep every folder and all notes when the remote default branch is missing, reducing the risk of lost work.
- **[ACW-16]** Prove cleanup preserves notes after remote default rename · architect
  **Done looks like:** Writers can trust cleanup to keep their notes after the main branch changes, reducing the risk of lost work.
- **[ACW-15]** Prove cleanup keeps notes after unrelated upstream history · architect
  **Done looks like:** Operators can trust cleanup to keep their notes after upstream history is replaced, reducing the risk of losing work.
- **[ACW-14]** Prove cleanup keeps notes after upstream moves backward · architect
  **Done looks like:** Cleanup preserves staged and unsaved notes when upstream history moves backward, so writers keep their work.
- **[ACW-13]** Prove cleanup keeps folders whose branch disappeared · architect
  **Done looks like:** Operators can trust cleanup to preserve their folders after a branch disappears, reducing the risk of losing draft notes.
- **[ACW-12]** Prove cleanup keeps folders with unreadable Git status · architect
  **Done looks like:** Operators can now preview cleanup with confidence because unreadable folders keep their drafts, reducing the risk of losing work.
- **[ACW-11]** Keep dirty landed folders in cleanup preview · architect
  **Done looks like:** Cleanup preview now keeps folders with unsaved work, so people can trust its removal plan.
- **[ACW-10]** Prove idle landed folders retain staged and unsaved notes · architect
  **Done looks like:** Operators can trust cleanup to preserve staged and unsaved notes in idle landed folders, reducing the risk of losing work.
- **[ACW-9]** Prove idle unfinished folders retain staged and unsaved notes · architect
  **Done looks like:** Operators can trust cleanup to preserve notes in idle unfinished folders, reducing the risk of losing work.
- **[ACW-8]** Prove busy unfinished folders retain staged notes · architect
  **Done looks like:** Operators can trust cleanup to preserve staged notes and later edits in busy unfinished folders, reducing the risk of losing work.
- **[ACW-7]** Prove busy unfinished folders retain unsaved notes · architect
  **Done looks like:** Operators can trust cleanup to preserve unsaved notes in busy unfinished folders because real preview and cleanup now check their contents.
- **[ACW-6]** Prove busy unfinished copies keep their pin reason · architect
  **Done looks like:** Operators can now see why busy unfinished folders stay protected, reducing risk of losing work during cleanup.
- **[ACW-5]** Prove pins stay visible from inside a landed copy · architect
  **Done looks like:** Operators can trust cleanup to show why their current folder stays, reducing the risk of losing unfinished notes.
- **[ACW-4]** Keep pins visible on busy landed copies · architect
  **Done looks like:** Cleanup now names pinned busy copies so their reasons stay visible beside ordinary ongoing work.
- **[ACW-3]** Name pinned unfinished copies in member cleanup · architect
  **Done looks like:** Operators can now see pinned unfinished copies during cleanup, so work that needs attention stays visible.
- **[ACW-2]** Prove grouped reap output keeps pinned copies visible · architect
  **Done looks like:** Operators can trust that cleanup names pinned work beside grouped ongoing work, reducing the risk of missing a copy that needs attention.
- **[ACW-1]** Finish reap summary for copies still at work · architect
  **Done looks like:** Operators can find copies needing attention faster because copies still being worked on share one count line.

## Blocked

(Empty)

## Completed

(Empty)
