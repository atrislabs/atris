# atris worktree

A build copy is a second checkout of a repo where one agent works without
touching anyone else. `atris worktree start` makes one, `atris worktree ship`
lands its work. This page is about how copies go away again.

## Only copies atris made

The cleaner touches a copy only when atris made it: it sits under
`.agent-worktrees`, or it carries the start marker
`.atris/agent-worktree.json`. A copy you made yourself with
`git worktree add` is never touched, by the hourly sweep, by start, or when
the disk is low.

## A copy nobody uses for a day is put away and removed

The cleaner runs every hour. It removes every copy nobody is using, merged or
not and pushed or not. Before it removes one, it puts everything away:

- Commits stay. They live in the shared repository and the branch is never
  deleted. The copy's last commit is also pinned by a private ref,
  `refs/atris/put-away/<name>`. A commit on no branch survives `git gc`.
  So do commits only the copy's own history still reached, after a reset or
  a finished rebase.
- Changes to files git already tracks go into that ref, as one commit on top
  of the copy's last commit. What was staged is kept as well.
- Every file git does not track, ignored or not, goes into a tar at
  `~/.atris/put-away/<repo>/<name>/ignored.tar` that only you can read.
  Secrets like `.npmrc` or a private key therefore never enter git. A push
  can never send them anywhere. Links and empty folders go in too.
- Two kinds of folder are dropped when git ignores them: `node_modules` and
  `.next`. They come back with the next install or build.
- So are the exact files atris writes on its own, such as the start marker
  and its own logs under `.atris/state/`. Each must also look like what atris
  writes. A file of yours that only shares the name is saved.

The copy is removed only after the ref and the tar were read back and matched
the disk. A fresh check right before the delete must also find nothing
changed and nobody using it. If anything fails, the copy is left exactly as it was and
the sweep says why. One sweep works on a repo at a time; a second one says
`another sweep is already running on this repo` and stops.

## What counts as in use

A copy stays on disk while it is in use:

- git has it locked (`git worktree lock`),
- a merge, rebase, cherry-pick or revert is half done in it,
- a running program stands in it or has a file in it open,
- you are running the command from inside it, or
- a file in it changed in the last 24 hours.

A copy whose branch was merged and that holds nothing but commits goes right
away, unless one of the first four applies.

## Bring a copy back

```bash
atris worktree put-away list
atris worktree restore <name>
```

Restore rebuilds the copy at its old path on its branch. Your tracked changes
come back unstaged. What was staged is staged again. Every untracked file is
unpacked. If a delete stopped halfway and left part of the folder behind,
restore moves that aside and drops it only when the restored copy holds every
byte of it.

A record that holds nothing but commits already in the main branch is
dropped after 30 days. Any other record stays until you drop it by name:

```bash
atris worktree put-away drop <name>
```

Each sweep says how much space the records use.

## Limits at start

`atris worktree start` keeps at most 12 copies per repo and 10 GB of copies
per repo. Over that, it puts away this repo's copies that sat unused for a
day, oldest first. Below 25 GB free on the disk it does the same. It never
reaches into another repo. It never takes a copy someone used today. If
nothing qualifies, it starts anyway with one line saying space is tight.
Below 10 GB free it refuses to start.

A new copy gets `node_modules` as a disk clone of the main copy's install
when the two `package-lock.json` files match. It then needs no install of its
own. `--no-deps` skips that.

## The timer

```bash
atris worktree sweep            # dry run: shows what would go
atris worktree sweep --apply    # does it now
atris worktree sweep --install  # run it every hour
```

The timer runs whichever `atris` is on your PATH. Upgrades reach it that way. If an
older timer points at a frozen copy of atris, `start` and `sweep` print one
line asking you to run `atris worktree sweep --install`. Each run writes one
line to `~/.atris/worktree-sweep/worktree-sweep.log`.

## Every way a file can still be lost

- An ignored `node_modules` or `.next` folder, at any depth. Install or build
  again.
- The files atris writes on its own, listed above. A change you made by hand
  to `.codex-last-message.txt` or a fleet prompt file is lost with them.
- A change to `.atris/state/tasks.projection.json`, which atris rebuilds from
  its task store.
- A write in the last instant, between the final check and the delete.
- A commit only the copy's own history reached, past the newest 500 entries
  of that history or past the first 100 such commits.
- A socket or pipe file inside an ignored folder or a nested repository. These
  hold no data on disk.

Everything else is either saved or keeps the copy on disk with the reason:
more than 2 GB of untracked files, a sparse checkout, a skip-worktree file,
or a checked-out submodule.

## Settings

All optional.

| Setting | Default | What it changes |
|---|---|---|
| `ATRIS_WORKTREE_IDLE_HOURS` | 24 | how long a copy sits unused before it is put away; never less than 1 |
| `ATRIS_WORKTREE_MAX_PER_REPO` | 12 | copies per repo before start makes room |
| `ATRIS_WORKTREE_MAX_GB` | 10 | disk one repo's copies may hold |
| `ATRIS_PUT_AWAY_DIR` | `~/.atris/put-away` | where put-away records and tars live |
