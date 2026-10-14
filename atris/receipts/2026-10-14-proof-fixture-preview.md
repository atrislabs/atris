# Preview of leftover cleanup proof fixtures

Before passing runs began cleaning up after themselves, the work-folder cleanup proofs left their temporary Git repositories behind. A new preview lists those leftovers by kind, age, and size so a person can decide whether to clear them. It never deletes anything.

It matches exact fixture folder names only, so overlapping names stay apart. It skips green-landing scratch copies, which production keeps on purpose when they hold Git locks. The default shows folders older than a day; every leftover is from today, so the full list needs the zero-hour view.

## Proof

```
node scripts/preview-proof-fixtures.js --hours 0
proof fixtures older than 0h: 588 folders, 38.5 MB
  atris-land-vanishing: 140 folders, 19.0 MB, oldest 2h
  atris-missing-ordinary: 110 folders, 3.0 MB, oldest 2h
  atris-regression-check: 91 folders, 5.1 MB, oldest 4h
  atris-cleanup-moved: 62 folders, 1.7 MB, oldest 1h
  atris-cleanup-moved-lock: 60 folders, 1.7 MB, oldest 1h
  atris-land-moved-dirty: 57 folders, 1.6 MB, oldest 1h
  atris-cleanup-refused: 21 folders, 0.6 MB, oldest 0h
  atris-tidy-vanishing: 19 folders, 4.7 MB, oldest 2h
  atris-fleet-check: 11 folders, 0.3 MB, oldest 4h
  atris-removal-guard: 10 folders, 0.3 MB, oldest 7h
  atris-green-scratch: 6 folders, 0.4 MB, oldest 0h
  atris-land-missing: 1 folder, 0.0 MB, oldest 2h
nothing was deleted; list paths with --paths
exit 0

node scripts/preview-proof-fixtures.js
proof fixtures older than 24h: 0 folders, 0.0 MB
exit 0

node scripts/preview-proof-fixtures.js --hours x
usage: node scripts/preview-proof-fixtures.js [--hours <n>] [--paths]
exit 2

atris temp folders before: 35774 after: 35774
```

A decision card in the for-you list asks whether to clear them.

## Files

- scripts/preview-proof-fixtures.js: preview only
- atris/refs/MAP-NOTES.md: new ref
- atris/status/for-you.md: decision card
