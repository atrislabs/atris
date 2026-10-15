# Lock file and age in reap's kept line

When landing cleanup (`atris land --reap`) keeps a work folder because Git
holds a lock, the kept line now names the lock file and how long it has sat
there, matching what work folder cleanup already printed. Reap is the command
the boot screen tells operators to run, so this is where a lock left by a
crashed Git most needs to explain itself. Both reap checks carry it: the scan
before backup and the second look right before removal.

## Real surface proof

Throwaway repo, one landed work folder, its index lock aged three hours.
Command: `node bin/atris.js land --reap --force --no-remote --ttl 0`
Exit: 0.

```text
landing cleanup done: 0 pieces cleared, 0 side copies removed
  ✋ kept, needs a human: /private/tmp/reap-lock-5OrE/wt (git_lock: /private/tmp/reap-lock-5OrE/repo/.git/worktrees/wt/index.lock, 3 h old)
  still flying (recent work, left alone): 1
```

The folder stayed even under the force flag; the throwaway repo was removed
afterward by its fixed path.

Regression: the reap lock test now ages the lock three hours and checks the
exact kept line, path, lock file, and "3 h old".

Command: `node --test test/worktree-removal-guard.test.js test/member-tidy.test.js`
Exit: 0, tests 29, pass 29, fail 0.
Neighbors: `node --test test/land.test.js test/fleet-stranded-worktrees.test.js`
Exit: 0, pass 25, fail 0.

Limit: review sandbox disposal in the fleet still gives the bare reason.
next_push: name the lock file and its age when fleet review keeps a sandbox for a Git lock, so all three removal paths explain a held folder the same way.
layer: capabilities
