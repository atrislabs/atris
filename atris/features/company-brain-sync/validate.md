# Company Brain Sync Validation

## Validated Now

Focused tests pass:

```bash
node --test --test-name-pattern 'push|business workspace|business sync|manifest records workspace root' test/commands.test.js
```

Company brain sync classifier tests pass:

```bash
node --test test/company-brain-sync.test.js
```

Covered classifier cases:

- clean local creates and updates
- clean remote creates and updates
- both-changed update conflict
- held local delete
- remote delete plus local update conflict
- conflict summary rendering
- conflict review packet generation with local and remote artifacts
- conflict review packet writing to disk
- command-path pull conflict packet builder includes `.base`, `.local`, and `.remote` artifacts
- local `atris sync --status` command works without credentials
- local `atris sync --review` command prints the latest conflict packet without credentials
- local `atris sync --resolve local|cloud|both|merge` applies conflict artifacts into local `atris/` files without credentials
- conflict packets can include `.base` artifacts, and successful pulls cache base content under `.atris/sync/base/`
- safe merge resolution writes non-overlapping local/cloud line edits, can merge different markdown heading sections, and refuses overlapping or same-section edits
- local safety commands route correctly even when business slug detection is unavailable
- safe/unsafe merge-matrix cases are covered: converged same content, cloud delete, deleted both, local delete plus cloud edit, and conflicting created files
- status rendering shows business, brain file count, conflict packets, and watcher heartbeat
- watch failure policy keeps the alive loop retrying on transient failures
- watch failure policy treats conflict exits as review state instead of process death
- watch-mode snapshot detects `atris/` changes
- watch-mode ignores runtime and OS noise
- push planner publishes only scoped local `atris/` creates and updates
- push planner treats scoped local deletes as gated deletes
- push planner ignores parent-folder junk outside `atris/`

Syntax checks pass:

```bash
node -c bin/atris.js
node -c commands/business-sync.js
node -c lib/company-brain-sync.js
node -c commands/pull.js
node -c commands/push.js
```

Fresh Acme-shaped workspace dry-run:

```bash
atris sync doordash --dry-run
```

Observed result:

```text
Syncing doordash knowledge wiki...
scope: atris/
...
Pushing to Acme...
Checking cloud freshness... fresh
Already up to date.
```

Fresh Acme-shaped workspace real command with no local edits:

```bash
atris sync doordash
```

Observed result:

```text
Pulling Acme...
Already up to date.
122 unchanged.
Pushing to Acme...
Checking cloud freshness... fresh
Already up to date.
```

No cloud writes were required in the validation case because the clean workspace had no local changes to publish.

Local edit dry-run in a Acme-shaped workspace:

```bash
printf '# Sync smoke\n\nLocal-only knowledge update.\n' > atris/wiki/smoke/local-edit.md
atris sync doordash --dry-run
```

Observed result:

```text
+ atris/wiki/smoke/local-edit.md  new file  (dry run)
1 would be pushed, 122 unchanged. (--dry-run, nothing sent)
```

Local delete dry-run in a Acme-shaped workspace:

```bash
rm -f atris/wiki/index.md
atris sync doordash --dry-run
```

Observed result:

```text
x atris/wiki/index.md  deleted  (dry run)
Deletes require an explicit real push with --delete.
```

Real delete attempt without `--delete`:

```bash
atris sync doordash
```

Observed result:

```text
Refusing to delete 1 cloud file without --delete.
```

Fresh folder true dry-run:

```bash
atris sync --dry-run
```

Observed result:

```text
122 would be pulled. (--dry-run, nothing written)
Publish preview skipped until the pull preview is applied.
```

File count before and after stayed the same, proving dry-run did not materialize the remote brain locally.

Slug auto-detection:

```bash
atris sync --dry-run
```

Observed result from a Acme-shaped workspace:

```text
Syncing doordash knowledge wiki...
scope: atris/
```

Local status surface:

```bash
atris sync --status
```

Observed shape:

```text
Company brain status
  business: doordash
  brain: atris/ (...)
  conflicts: none
  watcher: ...
```

This command is local-only and does not require credentials.

Local conflict review surface:

```bash
atris sync --review
```

Observed shape:

```text
Latest sync conflict review: .atris/sync/conflicts/.../summary.md
...
Resolve the local file, then run `atris sync --dry-run` before publishing.
```

Local conflict resolution surface:

```bash
atris sync --resolve local
atris sync --resolve cloud
atris sync --resolve both
atris sync --resolve merge
```

Validated behavior:

- reads the latest `.atris/sync/conflicts/...` packet
- writes the chosen `.local` or `.remote` artifact back to the target `atris/...` file
- `both` keeps the local artifact at the original path and writes the cloud artifact as `<file>.cloud`
- `merge` requires `.base`, `.local`, and `.remote`, writes non-overlapping line edits or different markdown sections, and leaves overlapping or same-section edits in review
- does not require credentials or cloud calls
- tells the operator to run `atris sync --dry-run` before publishing

## Still Needed

This feature is safer and usable, but the "perfect sync" bar still requires more command-path fixtures and model-assisted semantic merge support.

Missing validation:

- local-only create pushes cleanly end-to-end
- local-only update pushes cleanly end-to-end
- remote-only create pulls cleanly end-to-end
- remote-only update pulls cleanly end-to-end
- local delete does not delete cloud without `--delete` end-to-end
- remote delete does not destroy local modified work end-to-end
- parent folder junk is ignored by the push planner; still needs a full command fixture
- long-running watcher needs an integration test with a mocked local edit and no real cloud calls
- Pallet shipped-command smoke test from a real Pallet-shaped workspace
- npm publication after refreshing the invalid npm token

## Release Gate

It is fair to call this safer than raw Notion/GitHub-style customer-brain editing for scoped markdown sync after the shipped-command smoke passes.

Do not call the syncs "perfect" until the missing fixture cases and model-assisted semantic-merge conflict resolution flow are complete.
