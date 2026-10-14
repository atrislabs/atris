# Wider folder deletion check, proof and review note

The wider folder deletion check passed its real Git fixture tests. Reviewers now have the exact coverage, the new exception, and the remaining limit in one saved note.

## Review note

Proceed with the existing change. The source scan also catches a recursive deletion through a plain name such as `dir` when its enclosing named function lists, adds, or walks worktrees.

The new exception is `lib/land-green.js:scratchCheckout`. Its folder comes from `mkdtempSync`, and the raw deletion occurs only after `git worktree add` fails, before the folder is returned to a caller. Successful creation returns the folder and leaves later cleanup to the guarded `dropScratch` path.

Named risk: the scan checks source text, not control flow. It looks for guard and log names anywhere in a named function and scans recursive deletions one line at a time. A passing scan cannot prove that every deletion executes after the guard, and multiline recursive calls can escape the plain-name rule. Keep the real Git and process tests as the behavior proof.

## State checked

- Mission remained running; no mission settings changed.
- Read member identity, workspace map, current task list, recent log, deletion scan, sandbox disposal, and scratch creation.
- `gh pr view 1184 --json state,headRefOid,mergeable,statusCheckRollup,url` exited 0: current head `895023a27348d4133ff24cf9e3e805f23f7bcb08`, one CI check succeeded, another was in progress. Full CI success is not claimed.
- Existing generated `atris/TODO.md` modification was left unstaged.
- No code changed, no external comment sent, and no merge performed.

## Proof

Command: `node --test test/worktree-removal-guard.test.js test/member-tidy.test.js`
Exit code: 0

Actual command output:

```text
✔ tidy removes landed clean copies and leaves everything else to git and the rules (1023.6495ms)
✔ tidy asks origin for its current default branch instead of the stale local note (539.05775ms)
✔ tidy keeps every copy when the running-program scan fails (458.817875ms)
✔ tidy keeps every copy when origin cannot be fetched (368.502417ms)
✔ tidy keeps a landed copy while git is paused mid-rebase in it, and logs what it removes (464.676625ms)
✔ reap keeps a folder a run is working in, even with --force (134.831834ms)
✔ reap sees a real live process in the folder without being told (274.639792ms)
✔ reap names who removed a folder and why (164.763291ms)
✔ reap summary counts folders removed today and by whom (88.821333ms)
✔ worktree cleanup names who removed a folder and why (133.65925ms)
✔ reap keeps a folder while git holds its lock, even with --force (149.983542ms)
✔ worktree cleanup keeps a clean folder paused mid-rebase (100.601417ms)
✔ fleet review cleanup keeps a sandbox while git holds its lock (82.415542ms)
✔ fleet review cleanup names who removed a sandbox and why (85.312875ms)
✔ autopilot regression check keeps its folder while git holds its lock (117.1825ms)
✔ autopilot regression check keeps its folder while a run is inside it (116.198666ms)
✔ autopilot regression check sees a real leftover process without being told (255.5115ms)
✔ autopilot regression check names who removed its folder and why (124.802917ms)
✔ autopilot regression check keeps an existing clean folder when creation fails (125.674583ms)
✔ autopilot regression check keeps an existing dirty folder when creation fails (130.210583ms)
✔ every work folder removal goes through the git check and the removal log (100.639958ms)
✔ green landing keeps its scratch folder while a test is still running in it (81.06575ms)
✔ green landing names who removed its scratch folder and why (101.960292ms)
ℹ tests 23
ℹ suites 0
ℹ pass 23
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 2954.520459
```

Metric: 23 tests passed, 0 failed; one previously unproven head now has current local proof and one reviewer note saved.

Files edited: `atris/briefs/work-folder-protection-tick-24.md`, `atris/team/architect/logs/2026-10-14.md` (local member log, ignored by Git).
Artifact: this receipt is the reviewer note; the member log records the handoff.

next_push: make the deletion scan recognize multiline recursive calls with plain path names, using a regression that first fails on the current scan.

layer: beliefs
