# Plain mission goals start work

A terminal mission command now starts one worker step and checks the result. The frozen check passed, and a real CLI run created its file and completed successfully.

## Change and decision

Proceed: use the existing caller detection and guarded execution path. The named risk was starting a second worker while a live Codex session owns the goal; live Codex and explicitly selected caller-session runners still return the existing handoff.

```text
terminal goal -> save mission -> one worker step -> check -> receipt
live chat goal -> save mission -> native goal handoff
```

Files edited:
- `commands/mission.js`: choose the terminal default through `lib/default-runner.js`, then execute new worker-backed missions through the existing guarded run path; preserve argument values and default to one step.
- `test/mission-run-plain-goal.test.js`: four real CLI cases, including a configured file-writing command, the built-in drill runner, live Codex, and an explicit caller runner.
- `test/mission-plain-start.test.js`: name the live Codex caller for its existing handoff assertions.
- `atris/MAP.md` and `atris/refs/MAP-NOTES.md`: route the new behavior and regression file.
- `atris/receipts/mission-run-plain-goal.md`: this receipt.
- `atris/team/architect/logs/2026-10-14.md`: local member learning, ignored by git.

## Frozen verification

Rerun from the repository:

```sh
node --test test/mission-run-plain-goal.test.js
```

Exit: 0. Exact output:

```text
✔ a plain terminal goal invokes the configured worker and checks its real output (1540.23975ms)
✔ an explicit executable runner starts from the same goal command (1137.482458ms)
✔ a live Codex caller keeps the native goal handoff (380.911875ms)
✔ an explicit caller runner is preserved from a terminal (389.079625ms)
ℹ tests 4
ℹ suites 0
ℹ pass 4
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 3545.032917
```

## Real surface proof

An isolated scratch folder, `/tmp/atris-plain-goal-proof-FJZGa2`, kept this proof away from the active mission. It was initialized with `git init -q` (exit 0), then the actual CLI was invoked:

```sh
node /Users/keshavrao/arena/.agent-worktrees/atris-cli/architect-a-plain-mission-run-with-a-goal-actu-20261014-122515/bin/atris.js mission run "Save one checked result" --owner mission-lead --runner drill --no-preflight --no-drain --verify 'node -e "require(\"fs\").accessSync(\".atris/state/drill-runner-touch.txt\")"' --complete-on-pass
```

Exit: 0. Output excerpt:

```text
  max_ticks: 1, max_wall: 3600s
  session: drill
[tick 1] status=ran reason=drill-runner verifier=pass -> atris/runs/mission-mission-2026-10-14-save-one-checked-result-dc4b01dd-2026-10-14T12-28-47-636Z.json
Landing:
  Changed: Save one checked result is complete.
```

Artifacts: `.atris/state/drill-runner-touch.txt` plus step and summary JSON receipts under the scratch folder's `atris/runs/`. The configured-worker regression also creates and checks `result.txt`; it invokes a local executable command, so this proof does not claim a remote model provider was exercised.

Progress: four passing regression cases; one real CLI step produced its artifact, passed its check, and completed. No dependencies or mission contract fields changed. `git diff --check` exited 0 with no output.

Startup/state commands: `atris`, `atris mission status mission-2026-10-14-a-plain-mission-run-with-a-g-c3a76862`, `git status --short`, `atris mission goal --json`, and task list/show/new/claim/note. The active mission has an outer-process lock, so attaching a local task returned exit 3; the local task records this slice separately. Brain activation and compilation both returned exit 2, plan-only, and did not change generated policy files.

next_push: Show a short worker outcome on the first terminal screen after the checked result is saved.

layer: behaviors
