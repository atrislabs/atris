# Company Brain Sync

## Problem

Atris business workspaces are company brains, not plain folders. The canonical knowledge surface is the `atris/` folder inside each business workspace, for example `doordash/atris/`.

Raw push/pull is the wrong abstraction for this surface. It makes a shared knowledge base feel like file mirroring, which creates merge anxiety and makes users responsible for sync safety.

The product bar is closer to Notion, Google Drive, and GitHub:

- local edits should be detected automatically
- cloud updates should arrive without users thinking about manifests
- conflicts should become reviewable knowledge decisions, not overwrite prompts
- publishing should be explicit, auditable, and reversible

## Principle

Cloud Atris is canonical. Local Atris is a working copy. Sync publishes proposed knowledge updates into the company brain.

## User Model

Jonathan should be able to work inside `doordash/atris/` and run one command:

```bash
atris sync
```

He should not need to know about `--force`, `--from`, manifests, root folders, business slugs, or cloud path prefixes.

## Product Shape

`atris sync <business>` is the primary operator command.

When run inside a pulled business workspace, `atris sync` auto-detects the business from `.atris/business.json`.

It should:

- scope to `atris/` by default for business workspaces
- pull cloud truth first without destroying local work
- detect local changes since the last known base
- push only clean non-conflicting changes
- block destructive deletes unless explicitly approved
- produce a human-readable sync summary

Longer term, `atris live <business>` should watch file changes and run the same sync engine continuously, similar to Google Drive local sync plus GitHub-style conflict review.

## Non-Goals

- Do not mirror the parent business folder by default.
- Do not use `--force` as a normal collaboration path.
- Do not treat conflicts as "local wins" or "cloud wins" without review.
- Do not expose manifest internals to nontechnical customer operators.
