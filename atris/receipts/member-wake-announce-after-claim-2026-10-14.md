Member wake/start messages now wait for a real task claim, verified by the frozen check and real CLI processes.

## Change and proof

Files: `commands/member.js`, `lib/member-up.js`, `test/member-wake-announce-after-claim.test.js`, `test/member-up.test.js`, `test/member-wake-own-lines.test.js`, `atris/MAP.md`, `atris/refs/MAP-NOTES.md`, `atris/team/architect/logs/2026-10-14.md`, and this receipt.

Plan: preview -> launch pending -> child claims -> claim confirmation -> announce actual job once.

Rerun: `node --test test/member-wake-announce-after-claim.test.js`
Result: exit 0; tests 5, pass 5, fail 0. Covers delayed and duplicate confirmation, lost race, late confirmation, failed spawn, and real subprocess claims.

Related command: `node --test test/member-up.test.js test/member-go.test.js test/member-wake-own-lines.test.js test/member-verbs.test.js test/member-wake-other-kind-hint.test.js`
Result: exit 0; tests 45, pass 45, fail 0.

Real CLI command, invoked by the production spawner in isolated temporary projects: `node bin/atris.js member go executor --needs-check --json`
Lost-race exit: 75. Output:
```json
{
  "ok": true,
  "action": "member_go",
  "mode": "idle",
  "member": "executor",
  "reason": "no task with a check"
}
```
Window output: `executor is idle, no task with a check`, without any wake/start announcement.
Replacement-claim output, emitted only after the real database row is claimed by executor:
```text
executor woke up for: replacement job
executor started on: replacement job
```
The replacement child is deliberately stopped by SIGTERM immediately after confirmation; it has no normal exit code and the window reports `executor failed: stopped by sigterm`. This isolates claim ordering without running a model.

`git diff --check`: exit 0, no output.
`atris brain activate --root . --verify` and `atris brain compile --root .`: exit 2, plan-only regeneration previews; no adapter files written.
Mission attachment: refused because the parent driver holds the live lock; no lock was changed. A local task records ownership and proof in Review; parent harness owns mission completion.

Metric: 5 focused checks and 45 related checks passed; no dependencies added.
next_push: Show a plain waiting-for-job message when a launched child takes too long to confirm its claim.
layer: behaviors
