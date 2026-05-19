# Rebased Pack Co Operator One-Pager

## Current State

- Local-only workspace: no cloud business id or workspace id is attached.
- Starter evidence exists in `atris/context/_ingest/2026-05-19T03-50-onboarding/`.
- The workspace is a packaged CLI onboarding smoke unless the operator replaces the placeholder company/contact evidence.
- Review work is certified but human-gated; use `atris task reviews` for the accept/revise packet.

## First Useful Loop

Prove that a received business workspace can start cleanly:

```bash
atris business start
atris radar
atris task reviews --limit 10
atris business share --write
```

## Next Action

Run the first loop, then record it:

```bash
atris business record atris/reports/2026-05-19-rebased-pack-co-first-loop-recap.md --outcome mixed --metric "starter readiness"
```

## Human Gate

Only the operator should accept Review items or approve external sends.
