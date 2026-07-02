---
name: golden-path
description: >-
  Zero-knowledge consumer walk for Atris CLI: simulate a fresh laptop, follow
  only printed instructions, log papercuts, delegate fixes. Use when the user
  says golden path, zero-knowledge walk, fresh install simulation, papercut hunt,
  or consumer onboarding QA for atris-cli.
---

# Golden Path — Zero-Knowledge Consumer Walk

Walk like a stranger who just installed Atris. **Only do what the CLI prints.** No insider knowledge, no reading source, no assuming sibling workspaces.

## When to use

- Shipping or reviewing CLI UX
- Before a release (`npm pack` smoke)
- After papercut fixes land (pass 2 rerun)
- Any time someone says "would a new user know what to do?"

## Core rule

```
If the CLI didn't print it → you don't know it.
If you needed to know it → papercut + delegate a fix task.
```

Forbidden without CLI saying so: repo paths, mission ids from other workspaces, `npx` vs global, worktrees, env markers, task ordering, reading `package.json` or source.

## Mission spine (atris-cli)

```bash
cd /path/to/atris-cli
atris mission status <mission-id>
atris task list --tag golden-path
atris task claim <next-open-id> --as onboarding
```

Pass order (claim in sequence):

| Pass | Task pattern | What you simulate |
|------|--------------|-------------------|
| 1a | fresh install | clean HOME, `npm pack`, install tarball in empty dir |
| 1b | init | brand-new toy repo, `atris init`, first `atris status` |
| 1c | first mission | start/run one mission from CLI hints only |
| 1d | self-land | task proof → certify → autoland, one policy flip max |
| 1e | papercut sweep | every line in papercuts file → tagged fix task |
| 2 | pass 2 | full walk again after fixes land |

## Pass 1a — fresh install (template)

```bash
TMPROOT=$(mktemp -d)
FRESH_HOME="$TMPROOT/home"
EMPTY="$TMPROOT/install"
mkdir -p "$FRESH_HOME" "$EMPTY"

cd /path/to/atris-cli && npm pack
cd "$EMPTY" && HOME="$FRESH_HOME" npm install /path/to/atris-*.tgz

# Only follow what prints next:
HOME="$FRESH_HOME" npx atris
HOME="$FRESH_HOME" npx atris --help
HOME="$FRESH_HOME" npx atris version
```

Done when install works **or** every failure is a logged papercut.

## Papercut protocol

Log in `atris/GOLDEN_PATH_PAPERCUTS.md`:

```markdown
### Papercut: <short title>

- Command: `<exact command>`
- CLI output: `<what printed>`
- Why it blocks a fresh operator: <one sentence>
- Repair task: `CLI-XXX` - <title>
```

Delegate immediately:

```bash
atris task add "Golden path papercut: <title>" --tag golden-path
```

## Close a pass

```bash
atris task ready <id> --as onboarding \
  --verify '<command that proves the step>' \
  --proof "<what happened; artifact path if any>"

atris mission tick <mission-id> --summary "<plain: what changed, why it helps>"
```

Use `node bin/atris.js` in the dev checkout if the globally installed binary diverges from master.

## Mindset

- **Archaeology, not checklist.** You're finding moments that require tribal knowledge.
- **One pass, one papercut file.** Fixes get tasks; pass 2 proves zero papercuts.
- **Ship blockers ≠ papercuts.** Crashes and silent failures are papercuts with high urgency.

## What else to try with this flow

| Surface | Walk |
|---------|------|
| `atris-cli` | install → init → mission → autoland (this skill) |
| `atrisos-web` | signup → first agent chat → first block, zero docs |
| `atrisos-backend` | harness-only API path a new integrator would hit |
| Any skill | run skill with zero prior context; log every "you should know" |
| Release gate | pass 2 must be clean before `npm publish` |
| Regression | re-run pass 1a after every papercut fix batch |

Trigger in Cursor: *"golden path pass 1b"* or *"zero-knowledge walk atris init"*.
