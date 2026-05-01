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
- `atris sync <business> --watch` watches the local `atris/` brain, debounces local edits, and periodically checks cloud using the same safe sync cycle

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

Add a review command:

```bash
atris sync doordash --review
```

This should open or print the conflict summary and let the user choose:

- accept local
- accept cloud
- keep both
- ask Atris to merge semantically

### Watch UX

`atris live doordash` should use the same engine:

- watch `doordash/atris/`
- debounce local edits
- fetch cloud hashes periodically
- sync clean changes
- pause on conflicts with a clear review summary

An initial watch mode now exists on `atris sync --watch`. `atris live` should eventually delegate to the same sync engine instead of carrying a parallel implementation.

## Quality Bar

This lane is production-critical because it touches customer company memory.

Required before broad customer use:

- fixture tests for every change class
- fixture tests for conflict artifact creation
- fixture tests proving parent-folder junk is ignored
- fixture tests proving no cloud deletes without explicit opt-in
- end-to-end dry-run against a real Acme-shaped workspace
- command copy that never recommends `--force` for normal use
