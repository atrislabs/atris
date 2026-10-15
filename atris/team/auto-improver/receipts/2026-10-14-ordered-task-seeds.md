# Ordered task fixture setup

Task setup now preserves creation order across 29 direct insert sites. The real command tests passed 29 of 29, including all 28 affected tests and one incidental context-refresh test, exit 0. The frozen checks passed 35 of 35, exit 0.

Files: test/commands.test.js, atris/MAP.md, atris/refs/MAP-NOTES.md, atris/team/auto-improver/logs/2026-10-14.md, this receipt. Task commands regenerate atris/TODO.md.

Plan: recover interrupted edits -> inspect task creation and ordering -> check all affected command tests and frozen checks -> save proof -> review and push.

Change: finish the inherited shared addSeedTask helper and its call sites. It polls past the previous seed completion time before creating the next row through the real SQLite store. Distinct creation timestamps keep task display references and queue order from falling back to random IDs. The queue test now uses this shared helper instead of its local poll. Existing command assertions remain unchanged. Map references move with the added lines, including both endpoints of ranges.

Metric: 29 direct insert sites across 28 tests now share ordered setup. No additional command launches. This is a stability improvement; no speedup benchmark is claimed.

Affected-surface command actually run:

```sh
node --test '--test-name-pattern=^(?:healthy\ claude\ sessions\ rotate\ for\ context\ refresh\ after\ N\ ran\ ticks|task\ review\-lane\-loop\ runs\ bounded\ safe\ actions\ and\ stops\ before\ human\ accept|task\ review\-lane\-run\ writes\ bounded\ receipts\ and\ stops\ before\ human\ accept|task\ review\-lane\-run\ does\ not\ repeat\ the\ same\ review_chat\ task\ across\ inner\ loops|task\ review\-lane\-drain\ skips\ continue\-work\ rows\ with\ existing\ follow\-up\ children|task\ events\ defaults\ to\ a\ recent\ compact\ view|task\ note,\ show,\ and\ export\ expose\ a\ dialogue\ projection\ for\ UI\ surfaces|task\ review\ writes\ a\ reviewed\ event\ and\ RSI\ episode\ jsonl|task\ done\ with\ proof\ writes\ a\ reviewed\ proof\ event|task\ plan\ and\ do\ record\ an\ explicit\ headless\ stage\ contract|task\ chat\ refines\ a\ durable\ goal\ before\ plan|task\ page\ exposes\ one\-task\ goal\ chat\ stage\ and\ review\ actions|task\ step\ advances\ one\ safe\ headless\ action\ and\ never\ human\-accepts|task\ current\-step\ advances\ the\ scoped\ current\ task\ one\ safe\ action|task\ current\ returns\ read\-only\ selected\ page\ and\ queue\ lanes|task\ ready\ holds\ work\ in\ review\ until\ human\ accept|task\ review\-chat\ emits\ proof\-specific\ verifier\ packet|task\ review\-chat\ extracts\ only\ proof\-derived\ verifier\ commands|task\ auto\-accept\-certified\ \-\-all\ sweeps\ past\ the\ old\ 12\-row\ cap|claiming\ an\ already\-done\ task\ suggests\ the\ next\ open\ task\ from\ the\ same\ tag,\ in\ JSON\ and\ human\ output|task\ status\ stream\ tasks\ use\ latest\ agent\ proof\ fallback|task\ status\ separates\ review\ continue\-work\ from\ human\ accept\ waiting|task\ reviews\ gives\ a\ compact\ certified\ accept\ queue|task\ review\ groups\ are\ capped\ by\ default\ for\ human\ scan|task\ render\ archives\ old\ completed\ records\ from\ TODO\ view|task\ render\ archives\ old\ blocked\ records\ from\ TODO\ view|task\ serve\ exposes\ review\-lane\-drain\ API|task\ serve\ exposes\ a\ local\ task\ factory\ API|status\ counts\ completed\ tasks\ from\ db\ without\ task\ db\ todo\ shim\ flag)$' test/commands.test.js
```

Actual output, exit 0:

```text
✔ healthy claude sessions rotate for context refresh after N ran ticks (864.406375ms)
✔ task review-lane-loop runs bounded safe actions and stops before human accept (1776.83575ms)
✔ task review-lane-run writes bounded receipts and stops before human accept (1002.023791ms)
✔ task review-lane-run does not repeat the same review_chat task across inner loops (797.187833ms)
✔ task review-lane-drain skips continue-work rows with existing follow-up children (1424.570208ms)
✔ task events defaults to a recent compact view (572.484375ms)
✔ task note, show, and export expose a dialogue projection for UI surfaces (772.977416ms)
✔ task review writes a reviewed event and RSI episode jsonl (476.378042ms)
✔ task done with proof writes a reviewed proof event (319.617375ms)
✔ task plan and do record an explicit headless stage contract (2104.635833ms)
✔ task chat refines a durable goal before plan (586.425292ms)
✔ task page exposes one-task goal chat stage and review actions (1841.354417ms)
✔ task step advances one safe headless action and never human-accepts (1276.418458ms)
✔ task current-step advances the scoped current task one safe action (2587.883959ms)
✔ task current returns read-only selected page and queue lanes (1602.917791ms)
✔ task ready holds work in review until human accept (2544.939583ms)
✔ task review-chat emits proof-specific verifier packet (1195.067917ms)
✔ task review-chat extracts only proof-derived verifier commands (3399.394416ms)
✔ task auto-accept-certified --all sweeps past the old 12-row cap (994.903125ms)
✔ claiming an already-done task suggests the next open task from the same tag, in JSON and human output (1241.975959ms)
✔ task status stream tasks use latest agent proof fallback (162.171625ms)
✔ task status separates review continue-work from human accept waiting (885.412042ms)
✔ task reviews gives a compact certified accept queue (1150.963666ms)
✔ task review groups are capped by default for human scan (999.94225ms)
✔ task render archives old completed records from TODO view (502.208667ms)
✔ task render archives old blocked records from TODO view (263.749084ms)
✔ task serve exposes review-lane-drain API (1898.451584ms)
✔ task serve exposes a local task factory API (2409.638625ms)
✔ status counts completed tasks from db without task db todo shim flag (164.378334ms)
ℹ tests 29
ℹ suites 0
ℹ pass 29
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 35950.588916

```

Frozen command actually run:

```sh
node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js
```

Actual output excerpt, exit 0:

```text
✔ a real task failure leaves the engine ready and still resolvable as the roster pick (42.014709ms)
✔ an engine benched at error routes again once the window passes, and with no stamp at once (44.406583ms)
ℹ tests 35
ℹ suites 0
ℹ pass 35
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 10539.084625
```

Other commands: atris mission status mission-2026-10-14-continue-fixing-slow-or-flak-d594378f; atris mission goal --json (no candidate); atris task list --status open; git status --short; git diff --check (exit 0, no output); atris task new/claim/note/ready; git add/commit/push. Brain activation and compilation both returned exit 2 with a plan-only message; missing generated brain files were not created because this increment is confined to test fixtures.

Review proof: atris task ready AIC-33 --verify reran the frozen command, exited 0, saved atris/runs/2026-10-14-task-aic-33-2026-10-14T18-30-07-960Z.json, and moved the task to review. No acceptance was performed.

Lesson: use the same real-clock ordering guard for every fast seed, because display references can be computed before later inserts. A local guard in only the queue test leaves earlier fixtures exposed to the same timestamp tie.

next_push: Replace repeated setup launches in the next slow task test while keeping its behavior checks on the real CLI.
layer: capabilities
