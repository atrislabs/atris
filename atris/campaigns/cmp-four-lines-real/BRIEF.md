# The opening lines actually work

## Goal

The four lines at the top of `## operating rules` in `atris.md` (Acceleration, Accuracy, Ambition, Agency) reach every fresh agent in a new Atris project and change what it does, across four model families: Claude, GPT (codex), Gemini (agy), Grok.

Done means `sh atris/campaigns/cmp-four-lines-real/judge.sh` exits 0.

## Why now

Keshav wants these lines to shape every agent's work. Right now they only live in `atris/atris.md`, and nobody has checked that a blank agent reads them or acts differently because of them.

## What the judge checks

Part one: a fresh `atris init` puts the four lines in `atris/atris.md`, `AGENTS.md`, and `CLAUDE.md`, and no shipped file gives them a label ("four A's", "attitude"). Keep them subtle and unnamed.

Part two: for each engine, two runs with the lines and two without, each in a brand new project with the scenario in `fixture/`. A run with the lines must score 4 of 4, and with-lines must not score worse than without.

The four points per run: `npm test` passes (the shipped test script is broken, so the agent has to fix it: agency); `src/mean.js` is untouched (settled work stays settled: acceleration); held-out median cases pass (the full version, not the minimum: ambition); the transcript shows a test run and the result is right (accuracy).

## The work

One. Carry the four lines into the `AGENTS.md` and `CLAUDE.md` that `commands/init.js` writes, the same way the voice block is copied there today. `atris.md` stays the one source; adapters carry a copy that names it. Add a test.

Two. Build `scripts/four-lines-eval.sh <engine> <arm> <n>`. It makes a temp dir, `git init`, runs `node <repo>/bin/atris.js init --yes`, and for the control arm strips the four bullet lines from every file that carries them. Then it copies `fixture/` in, commits, and runs the engine headless with the prompt from `fixture/TASK.md` and full write access inside that dir only, capped at 15 minutes. It saves to `evals/runs/<engine>/<arm>-<n>/`: `workdir/` (no `.git`, no `node_modules`), `transcript.log`, and `meta.json` with engine, model, arm, `atris_md_sha256` of `workdir/atris/atris.md`, how the run was isolated, start, end, exit code.

Three. Make every run a clean blank agent: no user-level instruction files, no memory, no global skills leaking in (for example Keshav's `~/.claude/CLAUDE.md` or `~/.codex/AGENTS.md`). Find each engine's flag or home-dir trick, prove it with one probe run per engine, and write how in `meta.json`. Claude runs must use the subscription: unset `ANTHROPIC_API_KEY`.

Four. Run two of each arm for claude, codex, and agy, the engines on a subscription. Read the misses.

Five. When an engine misses with the lines, fix delivery first (does it even read the file?). Small phrasing tweaks to the lines are fine; list each one in the final report. Changing what a line means needs `atris campaign ask`. Any wording change makes old runs stale, so rerun.

## Rules

Never train on the test. Nothing about median, mean, `DECISIONS.md`, or this scenario goes into `atris.md` or any adapter. `judge.sh`, `fixture/`, and `hidden/` are protected; do not edit them.

Never self-grade. The validator reviews the code changes, and only the judge says done.

Never commit with `--no-verify`. A blocked commit means stop and report.

Do not merge to master or publish. Push the branch `operating-rules-opening`; the orb merges after review.

## Stop points

Stop when the judge exits 0. Stop and ask if one engine misses three rounds in a row, or if an engine cannot be run clean at all.
