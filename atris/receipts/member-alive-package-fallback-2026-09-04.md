# Installed member dispatcher proof

Owned by: backend-feature-owner. Executed by: Codex. Independent review and landing: parent agent, pending.

Task: MAP-1, internal id `01M1Q0Z682EG537ETVMWEG537E`, marked ready for review through `atris task ready`.

## Change

`lib/member-alive.js:64` now checks the packaged `scripts/member-operate.mjs` after the two workspace overrides. The dispatcher continues to execute in the member's workspace. No engine selection, authorization, billing, release, or live state changed.

## Verification

Command: `node --test test/member-alive.test.js`

Exit: 0. Tests: 6. Passed: 6. Failed: 0. Skipped: 0.

The regression copies the real library and packaged dispatcher into an installed-package layout. A fixture CLI records the dispatched command and current directory without calling a model. It proves package dispatch, workspace directory preservation, relative receipt propagation, `.mjs` precedence over `.js`, and either workspace override taking precedence over the package. Existing dry-run, wait, and missing-goal tests also pass.

Removing only the fallback and running `node --test --test-name-pattern='installed alive dispatches' test/member-alive.test.js` exits 1, with `missing_member_operate_script`. Restoring the fallback and running the full focused file through task verification exits 0.

Local task verification receipt: `atris/runs/2026-09-04-task-map-1-2026-09-04T20-16-27-153Z.json`.

`git diff --check` exits 0. Brain activation and compile commands were invoked; this checkout's CLI reported plan-only mode and requested `--yes` for generated brain writes. Missing compiled brain sources were not generated for this bounded code change.

## Limits

This is local process-level proof with a fixture CLI at the final work boundary. It does not prove a cloud engine login, real member work, billing, or unattended operation. The package already includes the dispatcher in its files list. Publishing and deployment remain with the parent; nothing was published or deployed.
