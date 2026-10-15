# Reference lock guard on real folders

Verdict: proceed. The reference lock guard holds no real folder by mistake and
adds about a millisecond per store. The suggested follow-up, extending it to
member tidy and green landing stores, has no target: both remove only linked
work folders and never delete a separate Git store, and no script or entry
point outside the scanned code deletes a work folder.

One failure mode left: a lock left by a crashed Git now keeps a fleet sandbox
indefinitely, and nothing tells the operator why it stays.

## Real surface proof

Read-only guard pass over every real work folder in this repo:

```text
folders 92 held 0
shared store activity null in 1.1 ms
all 92 folders checked in 6.7 ms
```

Shared store contents: 88 loose reference files, 0 reference locks, no packed
reference lock.

Command: `node bin/atris.js worktree cleanup --json` (dry run, nothing applied)
Exit: 0.

```text
apply false candidates 0 removed 0 kept 92
primary_checkout 1, unmerged 80, current_checkout 1, active_process 4, dirty 6
```

No folder was held for a Git lock, and all 92 folders remain listed afterward.

Scope check: deletes in scripts/ touch only fresh temp folders; bin/ has none.
Member tidy, green landing, and the autopilot regression check each remove one
linked folder through the per-folder check, whose own lock and state markers
live in that folder's private Git directory.
