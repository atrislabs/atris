# Member shared helper extraction

Moved 16 shared helpers into an independent file so future member commands can reuse them without importing the command handler.

## Change and risk

`commands/member.js` imports the initial helper group from `lib/member-helpers.js`. All 16 function bodies are byte-for-byte identical to the originals, and the command's existing exports stay intact. The new module depends only on fs, path and crypto. The command file is 130 lines shorter. No dependencies were added.

Plan verdict: proceed. The single likely failure was a missing closure dependency after extraction. Safeguards: inspect every moved function, preserve its body, run import integrity and real member creation/upgrade paths, then the frozen fast suite.

Files edited: commands/member.js, lib/member-helpers.js, atris/MAP.md, atris/refs/MAP-NOTES.md, this receipt. Local member memory: atris/team/architect/logs/2026-10-14.md (intentionally untracked).

## Proof

`node --test test/member-create.test.js test/member-frontmatter.test.js test/import-integrity.test.js`

Exit 0. Output:
```
✔ every destructured local import resolves to a real export
✔ member create writes the complete Atris identity bundle
✔ member upgrade preserves MEMBER.md and backfills the complete bundle
ℹ tests 7
ℹ pass 7
ℹ fail 0
```

Real CLI command, run with the repository's absolute entrypoint from a fresh temporary directory:
`node <repo>/bin/atris.js member create helper-proof --role="Proof member" --description="Verify extracted shared helpers"`

Exit 0. Output excerpt:
```
✓ Created team/helper-proof/MEMBER.md
✓ Created team/helper-proof/MISSION.md
✓ Created team/helper-proof/goals.json + goals.md
✓ Created team/helper-proof/logs/2026-10-14.md
```
The generated goals file had member `helper-proof`, an ISO timestamp and an empty goals array. The temporary fixture was removed afterward. `node bin/atris.js member list` also exited 0 and listed the existing team.

`git diff --check`: exit 0, no output.

The initial bare `npm run test:fast` exited 1: 1877 passed, five failed. This session inherited `ATRIS_RUNNER_PROFILE=codex`; the five unrelated runner/lesson tests assume the default Claude command and two of those tests check Claude-specific flags. The lesson tests only intercept the Claude command, so the inherited profile made them invoke a real Codex process instead. The required suite was rerun unchanged after unsetting that variable only in the test shell. No tests, verifier, runner policy or mission fields were changed.

Final required verification, exit 0:
```sh
unset ATRIS_RUNNER_PROFILE
npm run test:fast
```
Exact output excerpt:
```
ℹ tests 1882
ℹ suites 22
ℹ pass 1882
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 51634.463541
```
Reviewer rerun: `env -u ATRIS_RUNNER_PROFILE npm run test:fast`.
Full local outputs: /tmp/member-helpers-fast-tests.log (initial environment failure), /tmp/member-helpers-fast-tests-clean.log (passing run).

## Coordination

The preloaded task reference did not exist in this checkout's task database. The running mission owns its lock, so attaching a task was refused as busy. A local task was created and claimed by architect before editing. The outer mission runner will record its own final check and completion; its lock was left intact.

next_push: Extract member path and runtime-alias resolution into a separate module using these shared helpers.
layer: capabilities
