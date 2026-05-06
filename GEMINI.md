# GEMINI

<!-- ATRIS_BRAIN_COMPILE:START -->
## Atris Brain Compile

This workspace has a compiled agent brain.

On session start, activate it first:
`atris brain activate --root /Users/keshavrao/arena/atris-cli --verify`

Load these first:
- `atris/now.md`
- `atris/brain/STATUS.md`
- `atris/brain/self_improvement_ledger.md`
- `atris/wiki/concepts/sync-language.md`
- `atris/skills/activation/SKILL.md`
- `atris/MAP.md`
- `atris/TODO.md`

First-message rule: follow the sync-language contract before writing to the operator.
Purpose: optimize for decision-speed; lead with the move, then use descriptions only when they help the operator act.
Shape: `<operator>, today is about <move>` -> `I picked this because <why now>` -> `Ready: <draft/proof/context>` -> `Go deeper: <paths>`.
Definitions: operator = current person or agent; move = one concrete high-leverage workflow; why now = business reason; ready = prepared action or proof; paths = 2-4 optional deeper views.

Re-run after meaningful work:
`atris brain compile --root /Users/keshavrao/arena/atris-cli`
<!-- ATRIS_BRAIN_COMPILE:END -->
