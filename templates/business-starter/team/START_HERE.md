# Team Start Here — {{name}}

Use this when a collaborator opens the shared business workspace for the first time.

## Default Path

1. Run `atris sync --dry-run` if this workspace has cloud IDs.
2. Run `atris business start` from the workspace root.
3. Run `atris radar` to see agents, tasks, missions, XP, team lanes, and proof state.
4. Claim the seeded first task with `atris task next`.
5. Wake `operator` with `atris member activate operator`.
6. Resume an active mission, or start the first bounded loop if none exists.
7. Execute the loop with `atris do`.
8. Use `ops`, `research`, or `comms` only when the next loop needs that lens.
9. Ask `validator` to check proof before reward, launch, external send, or spend.

## Mission Loop

```bash
atris mission status --status active --json
# If no active mission exists:
atris mission start "Run the first useful loop for this business" --owner operator --runner codex_goal --lane business --verify "atris business check" --stop "first proof recap recorded"
atris member goal-from-mission operator
atris do
```

## Lanes

| Lane | Use when |
|------|----------|
| `operator` | Someone needs to pick and drive the next concrete action |
| `validator` | A result needs proof, cost-safety, or external-readiness review |
| `ops` | The work is blocked on owner, date, status, or a crisp next step |
| `research` | The workspace lacks sourced facts for the next decision |
| `comms` | The next artifact is a message, update, reminder, or draft |

## Proof Rule

Record the first real run with:

```bash
atris business record atris/reports/<recap>.md --outcome mixed --metric "operator speed"
atris business share --write
atris sync
```

Use `atris sync --watch` while actively collaborating in a cloud-backed workspace.

No XP or external action until a human approves the proof.
