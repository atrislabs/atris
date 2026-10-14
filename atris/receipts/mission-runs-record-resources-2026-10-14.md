Mission engine runs now record starting and final memory and load; the frozen checks passed with 92 tests, exit 0.

Files: commands/mission.js; test/engine-resource.test.js; atris/MAP.md; atris/refs/MAP-NOTES.md; atris/team/executor/logs/2026-10-14.md; this receipt.

Rerun: `node --test test/engine-resource.test.js test/engine-dispatch.test.js`
Output: tests 92; pass 92; fail 0; exit 0. `git diff --check`: no output, exit 0.

Failing first: the new CLI regression against an archived HEAD failed with ENOENT opening engine-resource.jsonl, exit 1.

Real CLI proof used temporary local executable fixtures, not paid model calls. Both paths ran the actual CLI on this computer. Each returned ok true, ran_ticks 1, status ran, reason tick-ok, exit 0. Memory was 78% free and load [3.18, 3.88, 5.62]. Four records pair into two unique runs; elapsed times 15 and 5 ms.

```text
command: /opt/homebrew/bin/node /Users/keshavrao/arena/empire/.agent-worktrees/atris-cli/executor-finish-machine-memory-and-load-recor-20261014-113344/bin/atris.js mission run mission-2026-10-14-codex-resource-proof-c0524730 --max-ticks 1 --max-wall 60 --no-verify --json
exit: 0
command: /opt/homebrew/bin/node /Users/keshavrao/arena/empire/.agent-worktrees/atris-cli/executor-finish-machine-memory-and-load-recor-20261014-113344/bin/atris.js mission run mission-2026-10-14-claude-resource-proof-007cbb73 --max-ticks 1 --max-wall 60 --no-verify --json
exit: 0
resource: {"at": "2026-10-14T14:54:17.247Z", "phase": "start", "engine": "codex", "task": "mission-2026-10-14-codex-resource-proof-c0524730", "free_pct": 78, "swap_used_mb": null, "swap_total_mb": null, "load": [3.18, 3.88, 5.62], "run_id": "16576c32-e00d-4e65-b64f-42f4f2e21872", "pid": 26866, "leaked_ssh_agents": 0}
resource: {"at": "2026-10-14T14:54:17.368Z", "phase": "end", "engine": "codex", "task": "mission-2026-10-14-codex-resource-proof-c0524730", "free_pct": 78, "swap_used_mb": null, "swap_total_mb": null, "load": [3.18, 3.88, 5.62], "run_id": "16576c32-e00d-4e65-b64f-42f4f2e21872", "duration_ms": 15}
resource: {"at": "2026-10-14T14:54:17.935Z", "phase": "start", "engine": "claude", "task": "mission-2026-10-14-claude-resource-proof-007cbb73", "free_pct": 78, "swap_used_mb": null, "swap_total_mb": null, "load": [3.18, 3.88, 5.62], "run_id": "7d371cd5-30fd-42f4-84f7-42dde90806a3", "pid": 27039, "leaked_ssh_agents": 0}
resource: {"at": "2026-10-14T14:54:18.048Z", "phase": "end", "engine": "claude", "task": "mission-2026-10-14-claude-resource-proof-007cbb73", "free_pct": 78, "swap_used_mb": null, "swap_total_mb": null, "load": [3.18, 3.88, 5.62], "run_id": "7d371cd5-30fd-42f4-84f7-42dde90806a3", "duration_ms": 5}
```

Cross-model review: no implementation defect found; inherited dispatch-depth settings now scrubbed from the fixture. Timeout and spawn-error path coverage remains for the next increment.

Brain activation/compile returned plan-only, exit 2; no generated policy files were overwritten. The initial direct proof needed an absolute Node path; corrected before proof passed. Existing unrelated TODO and member-log edits are preserved.

Review gate: login bash selected Node 20.18.0, which this CLI rejects; its rerun failed with 88 pass and 4 fail, exit 1. The task then reached Review using `/opt/homebrew/bin/node --test test/engine-resource.test.js test/engine-dispatch.test.js`, exit 0, receipt `atris/runs/2026-10-14-task-efm-6-2026-10-14T14-56-16-183Z.json`. The mission verifier was not changed. The absolute task command is outside automatic certification, so acceptance remains pending. Code and evidence were committed and pushed to origin.

Progress: two previously unrecorded local mission runner paths now have paired resource evidence, one added runtime regression.
next_push: add mission runner regression coverage for spawn errors and force kills, including the known time limit cause.
layer: capabilities
