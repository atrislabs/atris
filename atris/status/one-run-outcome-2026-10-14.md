# One-run member outcome repair

Saved quoted completion checks now finish correctly, and failed explicit checks return failure. Real CLI regression checks and git diff --check prove this increment.

## Scope

Finished the inherited commands/member.js repair and its real CLI tests. No mission policy or completion gate changed. The larger mission is still unfinished.

## Before and after

| Fresh project case | Before | After | Reason |
|---|---|---|---|
| member-pass | complete, exit 0, ok=True | complete, exit 0, ok=True | Explicit check passed; ignition already completes this case. |
| member-fail | blocked, exit 0, ok=True | blocked, exit 1, ok=False | A work step was mistaken for success even when the check failed. Now exit 1 names the failed command. |
| member-quoted | blocked, exit 0, ok=True | complete, exit 0, ok=True | The member settings parser removed an unmatched closing quote. It now unwraps matching outer quotes only. |
| member-no-check | blocked, exit 0, ok=True | blocked, exit 0, ok=True | No explicit check; the automatic review attempted the installed Codex engine and failed authorization in the temporary home. This diagnostic did not use a fake reviewer and is not a deterministic regression. |
| mission-pass | planning, exit 0, ok=True | planning, exit 0, ok=True | Objective shortcut saves a codex_goal request and returns without running work; even --engine claude does not change that shortcut. |
| mission-fail | planning, exit 0, ok=True | planning, exit 0, ok=True | Same shortcut, so the failing check never runs. |

## Real commands and output excerpts

Each case used a fresh temporary project: git init -q -b master, local test Git identity, node <cli> init, git add -A, git commit -qm baseline. Baseline CLI came from git archive HEAD; after CLI came from this checkout. The fake Claude executable writes hello.txt with hi and returns a successful result. No temporary user files remain.

```sh
node bin/atris.js member run executor 'create hello.txt containing hi' --ignite --verify 'test "$(cat hello.txt)" = "hi"' --json
```
```json
{"state":"complete","ok":true,"error":null,"verifier":"test \"$(cat hello.txt)\" = \"hi\""}
```
Exit: 0.

```sh
node bin/atris.js member run executor 'create hello.txt containing hi' --ignite --verify 'test "" = hi' --json
```
```json
{"state":"blocked","ok":false,"error":"the work ran but its check failed: test \"\" = hi","verifier":"test \"\" = hi"}
```
Exit: 1.

```sh
node bin/atris.js member run executor 'create hello.txt containing hi' --ignite --json
```
```json
{"state":"complete","ok":true,"error":null,"verifier":"test \"$(cat hello.txt)\" = \"hi\""}
```
Exit: 0.

```sh
node bin/atris.js member run executor 'create hello.txt containing hi' --ignite --json
```
```json
{"state":"blocked","ok":true,"error":null,"verifier":""}
```
Exit: 0.

```sh
node bin/atris.js mission run 'create hello.txt containing hi' --engine claude --verify 'test "$(cat hello.txt)" = "hi"' --json
```
```json
{"state":"planning","ok":true,"error":null,"verifier":"test \"$(cat hello.txt)\" = \"hi\""}
```
Exit: 0.

```sh
node bin/atris.js mission run 'create hello.txt containing hi' --engine claude --verify 'test "" = hi' --json
```
```json
{"state":"planning","ok":true,"error":null,"verifier":"test \"\" = hi"}
```
Exit: 0.

For member-quoted, MEMBER.md contains `verify: test "$(cat hello.txt)" = "hi"` before the run. Full stdout, stderr, argument arrays and selected final state are in local artifact `atris/runs/one-run-outcome-2026-10-14.json`.

## Files and rerunnable proof

- Changed: commands/member.js, test/member-run-one-run-outcome.test.js, atris/MAP.md, atris/refs/MAP-NOTES.md, this receipt.
- Member log: atris/team/auto-improver/logs/2026-10-14.md (local, ignored).
- Task created, claimed and noted with atris task; the generated TODO change was restored because this fresh local task database omitted the existing backlog.
- Probe: node /tmp/atris-one-run-probe.cjs (exit 0, twelve before/after invocations).
- Rerun: node --test test/member-run-one-run-outcome.test.js test/member-frontmatter.test.js test/member-run-start.test.js test/member-run-wakes-work.test.js
- Test result: exit 0; tests 25, suites 0, pass 25, fail 0, cancelled 0, skipped 0, todo 0.
- Frozen check: git diff --check, exit 0, no output.
- Brain activation/compile: exit 2, plan-only output; no operating-policy files were rewritten.

Progress: two demonstrated defects fixed; three regression cases cover JSON success, JSON/live failure, and saved quoted checks. Direct mission objective execution and missing-check outcomes remain open. Wall limits and approval-gated ready states were not changed or proven in this slice.

next_push: Make the direct mission objective shortcut execute one headless work step with its supplied check, while preserving native-session handoff and human acceptance gates.

layer: behaviors
