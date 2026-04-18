# _internal-skills

Skills that live in this repo but **DO NOT ship to customers**.

## Why

- Not listed in `package.json` `files` whitelist → excluded from npm publish
- Not under `atris/skills/` → `atris sync` / `syncPackageSkills` never reads from here, so these skills never get synced into a customer workspace
- Ships to us (the repo owners) via git only

## When to put a skill here

Put a skill under `_internal-skills/` when the skill itself is the Atris team's
tool, not the customer's. Examples:

- `tune/` — live Path B RL tuner. Used by Atris engineers during dogfood. Customers access the same capability through the credit-metered `/api/improve` endpoint instead.

## Install for yourself (Atris team)

```bash
ln -s /Users/keshavrao/arena/atris-cli/_internal-skills/<name> ~/.claude/skills/<name>
ln -s /Users/keshavrao/arena/atris-cli/_internal-skills/<name> ~/.codex/skills/<name>
```

Once linked, Claude Code and Codex pick them up in every session.

## How the separation works

| Path | Shipped on npm? | Synced to customer workspaces? | Who uses it |
|---|---|---|---|
| `atris/skills/<name>/` | ✅ yes | ✅ yes (via `atris sync`) | customers + us |
| `_internal-skills/<name>/` | ❌ no | ❌ no | us only |

Customers get the **capability** via credit-metered endpoints (`/api/improve`,
`/aeo/audit`, etc.), not the in-session skill.
