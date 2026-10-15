# Shared member helpers, current proof

The shared helpers already live in a small independent file. This increment checks that existing extraction rather than changing another part of the command.

Plan: existing extraction -> compare bodies -> real member creation -> required suite -> record and stop.

Verdict: proceed with proof only. The risk is accidentally changing helper behavior during extraction. Comparing the original source confirms all 16 helper bodies are identical; the helper module imports only Node built-ins and has no dependency on command handlers.

## Exact scope

Implementation inspected, unchanged: `lib/member-helpers.js`, `commands/member.js`.
Navigation inspected, already accurate: `atris/MAP.md:87`, `atris/refs/MAP-NOTES.md:2371`.
Edited: this receipt and the ignored `atris/team/architect/logs/2026-10-14.md`.
No new dependencies, implementation edits, mission settings, or tool policy changes.

## Real command

In disposable workspace `/var/folders/p2/s2tg3j6n1v9bwsbcqrjxnvnh0000gn/T/atris-member-helper-proof-hcDVQt`, using this checkout's CLI:

```sh
node bin/atris.js member create helper-proof --role="Helper proof" --description="Check shared member helpers"
```

Exit 0. Output excerpt:

```text
✓ Created team/helper-proof/MEMBER.md
✓ Created team/helper-proof/SOUL.md
✓ Created team/helper-proof/MISSION.md
✓ Created team/helper-proof/goals.json + goals.md
✓ Created team/helper-proof/logs/2026-10-14.md
```

The resulting log exists and goals are an empty array.

`node --test test/member-create.test.js test/member-business-binding.test.js` exited 0:

```text
ℹ tests 8
ℹ suites 0
ℹ pass 8
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 2939.456125
```

## Required verification

The first bare `npm run test:fast` exited 1 with the inherited `ATRIS_RUNNER_PROFILE=codex`. It reproduced the previously documented lesson-gate and runner-command failures: those fixtures expect the default Claude launch shape, but the session setting selects Codex. No code was changed to accommodate the environment.

The unchanged required command was rerun after removing that variable only from the test shell:

```sh
unset ATRIS_RUNNER_PROFILE
npm run test:fast
```

Exit 0, exact final output:

```text
ℹ tests 1882
ℹ suites 22
ℹ pass 1882
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 37191.594417
```

`git diff --check` exited 0 with no output.

Full rerun output: `/tmp/member-helper-proof-fast-20261014.log`.
Reviewer rerun: `env -u ATRIS_RUNNER_PROFILE npm run test:fast`.

## Coordination

The supplied task is absent from this checkout's task database. Attaching the mission task returned exit 3 because its outer runner holds the mission lock. The live owner was confirmed and the lock was left intact. A local proof task was created and claimed before writing this receipt. The outer runner records the mission outcome after this increment returns.

Brain activation and compilation returned plan-only output, exit 2. Generated instructions were not rewritten for this proof-only change. Task commands regenerated TODO.md; that generated local view was restored to its initial content so it does not replace the shared backlog.

Progress: 16 unchanged extracted helpers, 8 focused checks passed, one real creation passed. No second implementation slice started.
next_push: Extract member path and runtime-alias resolution into a separate module using the shared helpers.
layer: capabilities
