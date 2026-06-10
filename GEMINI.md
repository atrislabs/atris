# GEMINI

## Mission Autonomy

Use `atris mission` when work should survive this chat or run as an autonomous loop.

```
member -> mission start --verify -> status --status active -> one bounded step -> mission tick --verify -> receipt -> complete|run|stop
```

- Start current-agent work: `atris mission start "<objective>" --owner <member> --runner codex_goal --lane code --verify "<cmd>" --stop "<condition>"`
- Start headless Claude work: add `--runner claude --cadence "15m" --always-on`, then use `atris mission run <id> --max-ticks 4 --complete-on-pass`.
- Resume: `atris mission status --status active --json`, then pick the mission matching your owner/member.
- Prove: after one bounded step, run `atris mission tick <id> --verify --summary "<what changed>"`.
- Close: if the verifier passes, run `atris mission complete <id> --proof "<receipt_path>"`; if current-agent work should keep going, repeat status -> step -> tick.

<!-- ATRIS_BRAIN_COMPILE:START -->
## Atris Brain Compile

This workspace has a compiled agent brain.

On session start, activate it first:
`atris brain activate --root /Users/keshavrao/arena/atris-cli --verify`

If the prompt is vague or empty, run `atris 0-shot --all` to inspect the route menu before choosing work; use `atris 0-shot --prompt` for a copy-paste handoff. If you know your tier or horizon, run `atris 0-shot --model fast|pro|validator|human --prompt` or `atris 0-shot --horizon now|review|long|blocked|orient --prompt`. Use `atris 0-shot --json` when you need structured route metadata.
Ambient agents may read `.atris/state/zero-shot.prompt.txt`, `.atris/state/zero-shot.menu.txt`, a tier prompt (`.atris/state/zero-shot.fast.prompt.txt`, `.atris/state/zero-shot.pro.prompt.txt`, `.atris/state/zero-shot.validator.prompt.txt`, `.atris/state/zero-shot.human.prompt.txt`), or a horizon prompt (`.atris/state/zero-shot.now.prompt.txt`, `.atris/state/zero-shot.review.prompt.txt`, `.atris/state/zero-shot.long.prompt.txt`, `.atris/state/zero-shot.blocked.prompt.txt`, `.atris/state/zero-shot.orient.prompt.txt`) only after `atris 0-shot --check` reports `fresh`; if it is stale or missing, run `atris 0-shot --write` or `atris 0-shot --all`.

Load these first:
- `atris/now.md`
- `atris/brain/STATUS.md`
- `atris/brain/self_improvement_ledger.md`
- `atris/wiki/concepts/agent-activation-contract.md`
- `atris/skills/atris/SKILL.md`
- `atris/PERSONA.md`
- `atris/MAP.md`
- `atris/TODO.md`
- `atris/wiki/index.md`

First-message rule: lead with the move before writing to the operator.
Purpose: optimize for decision-speed; lead with the move, then use descriptions only when they help the operator act.
Shape: `<operator>, today is about <move>` -> `I picked this because <why now>` -> `Ready: <draft/proof/context>` -> `Go deeper: <paths>`.
Definitions: operator = current person or agent; move = one concrete high-leverage workflow; why now = business reason; ready = prepared action or proof; paths = 2-4 optional deeper views.

Re-run after meaningful work:
`atris brain compile --root /Users/keshavrao/arena/atris-cli`
<!-- ATRIS_BRAIN_COMPILE:END -->
