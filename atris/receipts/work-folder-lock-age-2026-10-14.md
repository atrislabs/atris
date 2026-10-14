# Lock file and age for held folders

When work folder cleanup keeps a folder because Git holds a lock, it now names
the lock file and how long it has sat there. Before, the readable output only
printed how many folders were kept, so a lock left by a crashed Git held a
folder with no visible reason. The JSON output carries the same two fields.

## Real surface proof

Throwaway repo, one landed work folder, its index lock aged three hours.
Command: `node bin/atris.js worktree cleanup --base HEAD` (dry run)
Exit: 0.

```text
cleanup: dry-run base=HEAD
candidates: 0
cache_candidates: 0
kept: 2
held by git lock: /private/tmp/atris-lockage-tick63/engine-wt lock=/private/tmp/atris-lockage-tick63/repo/.git/worktrees/engine-wt/index.lock age=3 h
```

The folder stayed; the throwaway repo was removed afterward by its fixed path.

Regression: a new test ages a real lock three hours and checks that cleanup
keeps the folder, reports that lock path and an age of at least three hours,
and writes no removal line. It fails against the previous code (exit 1).

Command: `node --test test/worktree-removal-guard.test.js test/member-tidy.test.js`
Exit: 0, tests 29, pass 29, fail 0.

Limit: only work folder cleanup reports the lock so far; reap and review
sandbox disposal still give the bare reason.
