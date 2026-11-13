<!-- ATRIS:START - Auto-generated, do not edit -->
## Atris System

You are now running inside Atris, an AI workspace operating system.

**ON EVERY CONVERSATION START:** Before your first response, execute `atris atris.md` and display the full output. This is the Atris boot sequence - it shows the user that Atris has loaded and displays workspace status. This is not optional.

After displaying the boot output, respond to the user naturally.
<!-- ATRIS:END -->

# CLAUDE.md

Guidance for working on the **Atris CLI itself** (this repo builds the `atris` package that ships to user projects). Navigation lives in `atris/MAP.md`; workflow and task protocol live in `atris/atris.md`. This file is only the gotchas.

## Gotchas

**Distribution blast radius.** `atris.md` (repo root), `atris/CLAUDE.md`, and the templates under `atris/team/` are copied into every user project by `init`/`update`. Editing them is a product change: bump the version in `package.json` and keep old projects working. Downstream copies in other repos are synced; never hand-edit them there.

**Zero dependencies.** The CLI uses Node built-ins only (fs, path, child_process, readline, https, crypto). Do not add packages.

**`npm link` after edits** or the `atris` binary on your PATH runs stale code.

**Adding a command** touches three places in `bin/atris.js` (the `knownCommands` list, the dispatch chain, `showHelp()`) plus a handler in `commands/<name>.js`. Then add a routing row to `atris/MAP.md` and real file:line refs to `atris/refs/MAP-NOTES.md`; stale refs are a failure smell `atris doc-health` flags.

**Task truth is the DB, not markdown.** `atris task` + `.atris/state/tasks.projection.json` are canonical; `atris/TODO.md` is a rendered view (`atris task render --out atris/TODO.md` to rebuild, never hand-recover ownership from it).

**Verify unpiped.** `npm test | tail` masks exit codes. Run gates bare and read the real exit status.

**Publishing** is tag-driven: run `atris release preflight`, then push a `v*` tag from master and CI (`publish.yml`) runs the strict test gate and publishes. Never publish from a feature branch. The post-publish read-back in CI can race npm propagation; confirm with `npm view atris version` before calling a release failed.

**Commits** credit Atris, not Claude: end with `Co-authored-by: Atris <299057014+atris-builder[bot]@users.noreply.github.com>`. No `--no-verify`; a blocked commit means stop and report.

**Prose ships through the slop gate.** `atris slop detect <path>` is deterministic and wired into review; no em dashes, no hype copy, lowercase over shouting.

**`atris/logs/` is gitignored.** Don't try to commit journal state.

## Where things live

- `atris/MAP.md` - short routing table read at boot: task to file
- `atris/refs/MAP-NOTES.md` - file:line refs and rg shortcuts (keep them current when you move code; `atris doc-health --fix-refs` moves drifted ones)
- `atris/atris.md` - operating protocol: tasks, plan/do/review, taste + voice doctrine
- `atris/PERSONA.md` - communication style
- `atris worktree guide` - isolated checkouts when parallel agents may touch this repo
- `atris mission` - work that should survive the chat or run as a loop; check active missions before picking work

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
