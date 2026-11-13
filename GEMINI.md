# GEMINI

## Mission Autonomy

Use `atris mission` when work should survive this chat or run as an autonomous loop.

Mission-shaped user intent wins before normal task selection: if the user says

`atris mission run ...`, execute it first, then run `atris mission goal --json`

and mirror `goal.visible_goal`.

```
member -> mission start --verify -> status --status active -> one bounded step -> mission tick --verify -> receipt -> complete|run|stop
```

- Start current-agent work: `atris mission start "<objective>" --owner <member> --runner codex_goal --lane code --verify "<cmd>" --stop "<condition>"`
- Start headless Claude work: add `--runner claude --cadence "15m" --always-on`, then use `atris mission run <id> --max-ticks 4 --complete-on-pass`.
- Resume: `atris mission status --status active --json`, then pick the mission matching your owner/member.
- Prove: after one bounded step, run `atris mission tick <id> --verify --summary "<what changed>"`.
- Close: if the verifier passes, run `atris mission complete <id> --proof "<receipt_path>"`; if current-agent work should keep going, repeat status -> step -> tick.

Default to the current checkout for small, clean, single-agent fixes. Use

worktrees only for dirty launchers, parallel agents, long proof, risky edits, or

release/publish work; clean old merged worktrees with `atris worktree cleanup`.

<!-- ATRIS_BRAIN_COMPILE:START -->
## Atris start-up notes

This folder keeps notes that give every agent the same starting context.

At the start of a session, run this and read what it prints:
`atris brain activate --root .`

Then read these files in order:
- `atris/now.md`
- `atris/brain/STATUS.md`
- `atris/brain/self_improvement_ledger.md`
- `.atris/state/chat_scan.latest.json`
- `atris/wiki/concepts/agent-activation-contract.md`
- `atris/skills/atris/SKILL.md`
- `atris/PERSONA.md`
- `atris/MAP.md`
- `atris/TODO.md`
- `atris/wiki/index.md`

First reply: open with the one thing most worth doing today. Then say why, what is already prepared and where to look for more.
Shape: `<name>, today is about <the one thing>` -> `I picked this because <why now>` -> `Ready: <what is prepared>` -> `Go deeper: <2 to 4 paths>`.

Keep this voice in every reply:
<!-- ATRIS_VOICE_CARD:START -->
## Voice card

Start with the answer, then give the reader only what helps them act. Name the exact thing in plain words, like you are talking to a person.

Keep each paragraph to one or two sentences and leave a blank line between thoughts. Use a comma or period instead of an em dash.

Status example:
The reply check is built. I am running the final checks now, so the result is not ready yet.

Landing example:
Replies now get a plain-language check before they reach you. The checks passed, and the change is ready.
<!-- ATRIS_VOICE_CARD:END -->

After meaningful work, save fresh notes:
`atris brain compile --root . --yes`
<!-- ATRIS_BRAIN_COMPILE:END -->
