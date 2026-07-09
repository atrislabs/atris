# cloud sync simplicity

**One-liner:** sync is powerful but the happy path hides behind force flags. Make `sync --review` the default conflict handler, `--changed`/positional paths the default push path, and one command to see and clean cloud orphans.

**Source:** live operator feedback (Derrick, 2026-07-09). Wish: `wish-2026-07-09-make-cloud-sync-safe-and-simple-sync-a7d24b4b`.

**Theme:** simplicity is the ultimate sophistication. The default path is safe and narrow; power flags are hidden, not advertised.

## Code map (verified 2026-07-09)

| Surface | Where |
|---------|-------|
| push entry + safety | commands/push.js — analyzePushSafety lines 136-184, renderPushSafetyBlock 186-218 ("Refusing unsafe workspace push"), drift gate 468-481 ("Cloud has changed since your last pull"), --only parsing 298-313, sync POST 620, DELETE file 749-760 |
| pull | commands/pull.js — --keep-local 216-223 (writes `.remote` files at 718), smart hash-then-batch pull 414-484, force mirror sweep 750-819 |
| sync | commands/sync.js syncAtris 424-670; commands/business-sync.js (--status, --watch) |
| live loop | commands/live.js |
| local manifest | lib/manifest.js load/save/build 18-57 |
| activate / brief | commands/activate.js:144, commands/brief.js:277 |
| router | bin/atris.js (knownCommands) |
| existing tests | test/push-delete-safety.test.js, test/sync-all.test.js, test/company-brain-sync.test.js |

## Slices (each = one commit + one new test file, run bare, never piped)

**S1 push safety UX.** On drift, lead with the safe path: `N files conflict. run atris sync --review to pick local/cloud/merge, or atris push --only <path> to ship just what changed.` The `--force --allow-broad-workspace` combo additionally requires an interactive y/N confirm (skippable only with `--yes`).
Verify: `node --test test/push-safety-ux.test.js`

**S2 atris sync --review.** List each conflicting file; per-file choice local / cloud / merge (interactive prompt; non-interactive via `--take local|cloud`). Merge writes standard conflict markers into the file. No more `.remote` dumps on this path.
Verify: `node --test test/sync-review.test.js` (mocked snapshot API)

**S3 orphans.** `atris sync --status --show-orphans` lists cloud files absent locally. New `atris cloud clean --dry-run` previews and `--yes` deletes them via the existing DELETE endpoint, reusing the mass-delete guard from push-delete-safety. Register `cloud` in knownCommands (lesson: dispatch-branches-must-be-known-commands).
Verify: `node --test test/cloud-clean.test.js`

**S4 scoped push.** `atris push <file...>` positional paths and `atris push --changed` (files whose hash differs from the lib/manifest.js manifest).
Verify: `node --test test/push-scoped.test.js`

**S5 speed + watch alias.** Skip unchanged files by manifest hash before upload; batch small uploads into one sync POST. Add `atris watch` as an alias for `sync --watch` (knownCommands too).
Verify: `node --test test/watch-alias.test.js`

**S6 one boot command.** `atris activate` output ends with the one-line brief (brief.js:277 shape) plus one sync-status line: `in sync` / `N files drifted` / `offline`.
Verify: `node --test test/activate-boot.test.js`

## Constraints

- node built-ins only, zero new dependencies
- lowercase CLI output, no em dash character in any new output, plain operator sentences
- every existing test stays green (`npm test`, bare, own exit code)
- update the MAP.md sections you touch
- production = all six verifiers pass + full suite green + landed on master through CI
