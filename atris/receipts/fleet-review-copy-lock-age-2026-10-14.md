# Lock file and age when fleet review keeps a sandbox

When fleet review keeps a review sandbox because Git holds a lock, it now names
the lock file and how long it has sat there. The lock can sit in any of three
Git stores (the work folder, the sandbox store, or the quarantine store), so
the lookup now works against a store directly, not only through a work folder.
All three removal paths (work folder cleanup, landing cleanup, fleet review)
now explain a held folder the same way.

## Real surface proof

Throwaway repo, a work folder plus bare sandbox and quarantine stores, the
quarantine store's HEAD lock aged three hours. Called the real sandbox
disposal and printed the line fleet logs for a kept sandbox. Exit: 0.

```text
{"removed":false,"reason":"git_lock","lock":"/tmp/fleet-lock-zQiV/quarantine.git/HEAD.lock","lock_age_ms":10800077.171142578}
    kept review sandbox for T-demo (git_lock, lock /tmp/fleet-lock-zQiV/quarantine.git/HEAD.lock, 3 h old): /tmp/fleet-lock-zQiV/sandbox
```

The work folder, sandbox store, and quarantine store all stayed; the
throwaway repo was removed afterward by its fixed path. Limit: this calls the
disposal function directly, not a full fleet dispatch with a live engine.

Regression: the three sandbox lock tests now pin the exact lock file in each
store (work folder index, quarantine HEAD, and branch and packed reference
locks in both stores), and one ages it three hours. Against the previous fleet
code they fail, 0 passed, 3 failed, exit 1.

Command: `node --test test/worktree-removal-guard.test.js test/member-tidy.test.js`
Exit: 0, tests 29, pass 29, fail 0.
Neighbors: `node --test test/land.test.js test/fleet-stranded-worktrees.test.js`
Exit: 0, pass 25, fail 0.

next_push: show the same lock file and age when autopilot's regression check or green landing keeps its scratch folder for a Git lock, so the smaller removal paths match the three main ones.
layer: capabilities
