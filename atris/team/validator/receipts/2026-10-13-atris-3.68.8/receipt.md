Atris 3.68.8 passed the fresh-folder release check: every requested command exited 0, nine members have nine named and described Claude agent files, and both JSON outputs parsed successfully.

## Scope and plan

`npm publication -> fresh git folder -> init -> update -> export -> member fields -> JSON outputs`

No source code changed. Only this receipt, captured evidence, and the validator member log were added. The existing map remains accurate because no command routes or code locations changed.

## Commands and verdicts

| Command | Exit | Verdict | Output / evidence |
|---|---:|---|---|
| `npm view atris version` | 0 | PASS | `3.68.8` at 2026-10-14T06:03:08Z |
| `git init` | 0 | PASS | Initialized empty Git repository in /private/var/folders/p2/s2tg3j6n1v9bwsbcqrjxnvnh0000gn/T/atris-3.68.8-validation-ovdm75kx/fresh-project/.git/ |
| `npx -y atris@3.68.8 init` | 0 | PASS | workspace files ready (18) |
| `npx -y atris@3.68.8 update --yes` | 0 | PASS | ✓ Created atris/policies/ folder |
| `npx -y atris@3.68.8 member export` | 0 | PASS | 9 members exported to claude code, cursor, and codex, already up to date |
| `npx -y atris@3.68.8 member board --json` | 0 | PASS | Valid JSON object, parsed with json.loads on the entire stdout. |
| `npx -y atris@3.68.8 scoreboard --json` | 0 | PASS | Valid JSON object, parsed with json.loads on the entire stdout. |

Member file confirmation: PASS. `member list --json` exited 0 and lists nine real members. Their exact name set matches `.claude/agents/*.md`; each file has matching `name` and nonempty `description` frontmatter. The `_template` directory is a blank scaffold and is absent from the actual member list. The initial raw file-count assertion included it and failed; the membership-based assertion corrected that check rather than changing the release.

Frozen check: `git diff --check`, exit 0, empty output.

## Evidence and rerun

Fresh folder: `/var/folders/p2/s2tg3j6n1v9bwsbcqrjxnvnh0000gn/T/atris-3.68.8-validation-ovdm75kx/fresh-project`.

Full command stdout, stderr, and exit codes: `results.json`. Poll timestamps and outputs: `publication.json`. Agent name and description evidence: `agents-check-corrected.json`. Runtime membership: `member-list.json`.

Runnable member check: `python3 /var/folders/p2/s2tg3j6n1v9bwsbcqrjxnvnh0000gn/T/atris-3.68.8-validation-ovdm75kx/verify-agents.py`, exit 0, output: `PASS: 9 listed members, 9 matching agent files, all with name and description`.

Runnable full surface check in another fresh child folder: copy `/var/folders/p2/s2tg3j6n1v9bwsbcqrjxnvnh0000gn/T/atris-3.68.8-validation-ovdm75kx/run-validation.py` and the `published` marker to a new temporary directory, then run that script. It invokes the exact six requested commands, captures their outputs, and parses the complete JSON outputs. Use the membership-based agent assertion above; the original raw directory-count assertion includes the blank template.

## Progress and limits

Publication gate passed after 13 recorded polls, from 2026-10-14T05:59:03Z to 2026-10-14T06:03:08Z. Six of six requested fresh-folder commands passed; two of two JSON outputs passed; nine of nine member files passed. Stop early because the requested proof is complete.

The test uses a fresh project folder on this existing Mac account. The board and scoreboard can read account-wide activity, as the captured outputs show. This proves the requested installation flow and JSON syntax, not isolation from existing home-directory state.

next_push: Validate the same installation flow with an empty home directory to prove first-account behavior.

layer: behaviors
