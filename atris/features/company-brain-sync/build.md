# Company Brain Sync Build Plan

## Current Patch

The immediate Acme lane now follows the correct company-brain model:

- `atris push` keeps the business root as the path root so `doordash/atris/MAP.md` maps to cloud `/atris/MAP.md`
- business `pull` and `push` default to the `atris/` scope
- root-level duplicates such as `MAP.md`, `TODO.md`, and `security-report.md` are ignored by default
- manifests record the local workspace root to prevent a manifest from one folder authorizing pushes from another folder
- real cloud deletes require `--delete`
- `atris sync <business>` runs the safe operator sequence as one command
- `atris sync` auto-detects the business slug inside a pulled business workspace
- `lib/company-brain-sync.js` contains the pure classification core for Notion/Drive/GitHub-style sync decisions
- conflict review packet generation exists as a pure artifact builder
- `pull --fail-on-conflict` writes the conflict review packet before `atris sync` stops
- `atris sync --watch` watches the local `atris/` brain, debounces local edits, periodically checks cloud using the same safe sync cycle, and keeps retrying after transient failures
- `atris sync --status` gives a local, nonengineer-readable status card: detected business, brain file count, manifest health, conflict packets, and watcher heartbeat
- `atris sync --review` prints the latest local conflict review packet without credentials or cloud calls
- `atris sync --resolve local|cloud|both|merge` applies the latest conflict packet's chosen side or a safe deterministic merge back into local `atris/` files, then tells the operator to dry-run before publishing
- local safety commands (`--status`, `--review`, `--resolve`) route to company-brain sync even if business slug detection is missing or broken
- successful pulls cache base content under `.atris/sync/base/` so future conflict packets can include `.base` files for safe merge resolution
- real sync/watch cycles write `.atris/sync/status.json` as the local heartbeat; `--dry-run` still writes nothing

## Desired Sync Engine

Move from command sequencing to a single sync engine with explicit state.

### State Model

For each cloud path under `/atris/`, track:

- base hash: last version both local and cloud agreed on
- local hash: current local file
- remote hash: current cloud file
- local mtime: local edit signal
- remote version or commit: cloud edit signal
- actor metadata when available

### Change Classes

The engine should classify every path as:

- unchanged
- local created
- local updated
- local deleted
- remote created
- remote updated
- remote deleted
- both changed same content
- both changed conflicting content

Initial classifier coverage exists in `test/company-brain-sync.test.js`.

### Actions

Default actions:

- pull remote-only changes
- push local-only creates/updates
- preserve local work on conflicts
- never delete cloud by default
- never delete local untracked files by default
- write a sync report for review

### Conflict UX

A conflict should create a review artifact, not a scary merge state.

Recommended local artifact:

```text
.atris/sync/conflicts/<timestamp>/<path>.local
.atris/sync/conflicts/<timestamp>/<path>.remote
.atris/sync/conflicts/<timestamp>/summary.md
```

The packet shape is implemented in `buildConflictReviewPacket`, and `pull --fail-on-conflict` materializes it before stopping sync.

Recommended summary language:

```text
3 files need review before publishing:
- atris/wiki/concepts/weekly-business-review.md
- atris/TODO.md
- atris/reports/wbr-panel-2026-04-23.md
```

### Publish UX

The first local review command exists:

```bash
atris sync --review
```

It prints the latest conflict summary and tells the operator to resolve locally, then run `atris sync --dry-run`.

The first resolution command exists:

```bash
atris sync --resolve local
atris sync --resolve cloud
atris sync --resolve both
atris sync --resolve merge
```

It applies the selected side into local `atris/` files and keeps the conflict packet as the audit trail. `both` keeps the local version at the original path and writes the cloud version beside it as `<file>.cloud`. `merge` requires `.base`, `.local`, and `.remote` artifacts and only writes a merged file when local and cloud edits are safe: non-overlapping line ranges, or different markdown heading sections. Same-section markdown edits stay in review.

Later it should also let the user ask Atris to merge semantically with model assistance when the conservative line merge refuses.

### Watch UX

`atris sync --watch` is the current always-on lane:

- watch `doordash/atris/`
- debounce local edits
- fetch cloud hashes periodically
- sync clean changes
- pause on conflicts with a clear review summary
- keep the process alive on transient network/API failures and retry on the next cycle
- record a heartbeat under `.atris/sync/status.json`

`atris live` should eventually delegate to the same sync engine instead of carrying a parallel implementation.

## Quality Bar

This lane is production-critical because it touches customer company memory.

Required before broad customer use:

- fixture tests for every change class
- fixture tests for conflict artifact creation
- status/heartbeat tests for the nonengineer "am I current?" surface
- retry-policy tests proving watch failures do not kill the alive loop
- fixture tests proving parent-folder junk is ignored
- fixture tests proving no cloud deletes without explicit opt-in
- end-to-end dry-run against a real Acme-shaped workspace
- command copy that never recommends `--force` for normal use
