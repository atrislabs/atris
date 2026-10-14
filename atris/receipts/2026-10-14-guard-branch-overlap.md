# Two work-folder guard branches overlap

Verdict: proceed-with-changes. Land one guard, then carry only the other branch's distinct parts onto it.

## What is on each side

- Pull request 1184 (`codex/architect-finish-work-folder-protection-across-20261014-113334`, head `a34aa48d`) adds its own lock helpers inside `commands/worktree.js` and uses them in reap, worktree cleanup, member tidy, green landing, autopilot's regression check, and fleet review cleanup. It names one lock per kept folder. It merges cleanly into master.
- This branch (`architect-help-output-not-cut-short`, 16 commits past master, no pull request) adds `lib/git-activity.js` and uses it in reap, worktree cleanup, member tidy, and autopilot's regression check. It lists every lock path and age. It does not guard fleet review cleanup, which is a protected surface. It also carries the fleet and autopilot cleanup audits under `atris/receipts/`.
- Master has neither guard.

## Proof

```text
$ git merge-tree --write-tree --name-only HEAD a34aa48d
CONFLICT (content): Merge conflict in atris/MAP.md
CONFLICT (content): Merge conflict in atris/refs/MAP-NOTES.md
CONFLICT (content): Merge conflict in atris/team/architect/logs/2026-10-14.md
CONFLICT (content): Merge conflict in commands/autopilot.js
CONFLICT (content): Merge conflict in commands/worktree.js
CONFLICT (content): Merge conflict in lib/member-tidy.js
CONFLICT (content): Merge conflict in test/worktree-removal-guard.test.js
exit 1

$ git merge-tree --write-tree --name-only origin/master a34aa48d
exit 0
```

## The one risk

Someone resolves the conflicts file by file and keeps both guards. Fleet cleanup would then use the pull request's helper, which names one lock, and reap would use this branch's helper, which names every lock. That leaves two definitions of "git is busy here" that can disagree, and every later fix would have to land twice.

## Safeguard

Merge pull request 1184 first, since it is the only side that covers fleet review cleanup and it merges clean. Then rebase this branch onto it and keep only three things: listing every lock instead of one, the cleanup audits, and the tests. Replace the pull request's single-lock lookups with that one helper in the same change. Do not merge this branch as it stands.
