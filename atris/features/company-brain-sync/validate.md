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
- watch-mode snapshot detects `atris/` changes
- watch-mode ignores runtime and OS noise

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

## Still Needed

This feature is not complete until the dedicated sync engine exists.

Missing validation:

- local-only create pushes cleanly end-to-end
- local-only update pushes cleanly end-to-end
- remote-only create pulls cleanly end-to-end
- remote-only update pulls cleanly end-to-end
- local delete does not delete cloud without `--delete` end-to-end
- remote delete does not destroy local modified work end-to-end
- command-path conflict artifact behavior needs an end-to-end fixture with mocked pull state
- parent folder junk is ignored under normal business sync
- long-running watcher needs an integration test with a mocked local edit and no real cloud calls

## Release Gate

Do not call this Notion/Drive/GitHub-grade until the above cases are fixture-tested and the conflict review flow exists.
