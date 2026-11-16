# atris worktree

A build copy is a second checkout of a repo where one agent works without
touching anyone else. `atris worktree start` makes one, `atris worktree ship`
lands its work. This page is about how copies go away again.

## A copy nobody uses for a day is put away and removed

The cleaner runs every hour. It removes every copy nobody is using, merged or
not and pushed or not. Removing one loses nothing:

- Commits stay. They live in the shared repository. The branch is never
  deleted.
- Uncommitted work is saved first, as one commit on a private ref named
  `refs/atris/put-away/<name>`. The copy's own branch does not move.
- Ignored files that cannot be rebuilt, like a `.env.local` that differs from
  the main copy, go into `~/.atris/put-away/<repo>/<name>/ignored.tar`, which
  only you can read. They never go into git.
- atris's own state files and rebuildable folders (`node_modules`, `.next`,
  `dist`, `build`, caches, Python bytecode) are dropped. They come back with
  the next install or build.

The copy is removed only after the saved commit and the tar were read back and
matched the disk. If saving fails for any reason, the copy is left exactly as
it was and the sweep says why.

## What counts as in use

A copy stays on disk only when it is in use:

- git has it locked (`git worktree lock`),
- a running program is working inside it,
- you are running the command from inside it, or
- a file in it changed in the last 24 hours.

A copy whose branch was merged goes right away, unless a program is in it.

## Bring a copy back

```bash
atris worktree put-away list
atris worktree restore <name>
```

Restore rebuilds the copy at its old path on its branch, with your
uncommitted changes back as uncommitted changes and your ignored files
unpacked. Records older than 30 days are dropped once their branch is merged,
or when they saved no work.

## Limits at start

`atris worktree start` keeps at most 12 copies per repo and 10 GB of copies
per workspace. Over that, it puts away copies idle for an hour, oldest first.
If the rest are all in use, it starts anyway and names them.

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

## Settings

All optional.

| Setting | Default | What it changes |
|---|---|---|
| `ATRIS_WORKTREE_IDLE_HOURS` | 24 | how long a copy sits unused before it is put away |
| `ATRIS_WORKTREE_MAX_PER_REPO` | 12 | copies per repo before start makes room |
| `ATRIS_WORKTREE_MAX_GB` | 10 | disk all copies in a workspace may hold |
| `ATRIS_PUT_AWAY_DIR` | `~/.atris/put-away` | where put-away records and tars live |
