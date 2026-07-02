# ctop orphan session audit - 2026-05-19

Task: CLI-155 refresh after CLI-152

## Verdict

No sessions were killed, closed, reassigned, or accepted.

The next five-hour lane is still owner/human gated:

1. BCK-292 has seven active sessions blocked on GitHub Actions billing/spend owner action.
2. CLI and backend have certified review work waiting for human accept/revise, starting with CLI-154 and BCK-323.
3. The four unmapped sessions below are cleanup candidates, not agent-executable product work.
4. The useful patch from the dirty `ac29` backend worktree was recovered and shipped as BCK-323 / PR #491.

## Live cockpit

Command: `atris ctop --json`

Generated: `2026-05-19T14:57:49.012Z`

Summary:

- 14 total active agent sessions.
- 4 untasked sessions.
- 2 task pileups.
- `next_action`: owner gate blocks 7 sessions on BCK-292; wait for owner action or close idle sessions.

Task load:

| Task | Sessions | Status | Owner | Meaning |
| --- | ---: | --- | --- | --- |
| BCK-292 | 7 | claimed | keshavrao | Owner action required. |
| CLI-154 | 2 | review | codex | Certified review; handoff complete. |
| OBL-529 | 1 | claimed | claude | Human microphone signoff lane. |

## Untasked sessions

| PID | CWD | Process age | ctop reason | Probe result | Recommended action |
| --- | --- | --- | --- | --- | --- |
| 5843 | `/` | 3d 19h | no task projection | `/` is not a git repo and has no Atris task plane. Process is Codex app-server. | Operator may close if idle. No agent task to resume. |
| 97169 | `~/.codex/worktrees/ac29/atrisos-backend` | 1d 21h | empty task projection | Detached backend worktree, dirty files in `backend/routers/business/workspace.py` and `backend/tests/test_ai_computer_auth_scoping.py`; task status reports 0 total tasks. The useful dirty diff was ported to current `origin/master` and merged as BCK-323 / PR #491 at `6b53d0f63`. | Operator may close/remove after confirming no local process state is needed. Do not hand-edit or reset from an agent session without explicit cleanup approval. |
| 57239 | `~/arena/personal_context` | 12h | no active task | Task status: 10 done, 0 active/backlog/review; `atris task next --as codex` returns none. Worktree is heavily dirty. | Operator may close if idle; do not mutate without a new personal-context task. |
| 38261 | `~/arena/atrisos-web` | 3d 19h | no active task | Task status: 46 done, 0 active/backlog/review; `atris task next --as codex` returns none. Worktree is dirty on `agent/claude/aeo-ui-pass-20260516`. | Operator may close if idle or create a fresh web task before continuing. |

## Evidence commands

- `ps -p 5843,97169,57239,38261 -o pid,ppid,etime,stat,%cpu,%mem,command`
- `git -C ~/.codex/worktrees/ac29/atrisos-backend status --short --branch`
- `git -C ~/.codex/worktrees/ac29/atrisos-backend diff -- backend/routers/business/workspace.py backend/tests/test_ai_computer_auth_scoping.py`
- `gh pr view 491 --repo atrislabs/atrisos-backend --json number,state,mergedAt,mergeCommit,url,title`
- `atris task status --json` in `~/.codex/worktrees/ac29/atrisos-backend`
- `atris task next --as codex --json` in `~/.codex/worktrees/ac29/atrisos-backend`
- `git -C ~/arena/personal_context status --short --branch`
- `atris task status --json` in `~/arena/personal_context`
- `atris task next --as codex --json` in `~/arena/personal_context`
- `git -C ~/arena/atrisos-web status --short --branch`
- `atris task status --json` in `~/arena/atrisos-web`
- `atris task next --as codex --json` in `~/arena/atrisos-web`
- `git -C / rev-parse --show-toplevel`

## Operator handoff

Do not spend the next five hours starting unrelated work from these orphan sessions.

The useful next action is still:

1. Owner clears the GitHub Actions billing/spend gate for BCK-292.
2. Human accepts or revises the certified queues, starting with CLI-154 and BCK-323.
3. Agents then rerun the backend CI/Witness gates and continue deploy/live business-computer proof from the refreshed task plane.
