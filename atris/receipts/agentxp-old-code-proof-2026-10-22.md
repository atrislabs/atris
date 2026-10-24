The unchanged real-job regressions fail against the old runtime and pass against the proposed fix; the bare targeted run exited 0 with 42 passed and zero failed.

## One bounded validation increment

Plan: `real accepted fixture -> unchanged regression -> old runtime fails -> proposed runtime passes`.
No source or fixture changes. The existing sanitized fixture records a real accepted job from this week, with builder and accepting actor equal and a distinct certified machine reviewer. Acceptance-time field shape is preserved; the isolated test uses a fresh date for portable Today assertions.

The brief was missing an executed comparison against old code. An archive of pre-fix commit `e0717bb9` was extracted into `/tmp/atris-agentxp-prefixed-proof-20261023`, then the current test file and fixture were copied unchanged. Absolute symlinks were omitted from the archive after Python's safe extractor refused one; all regular tracked runtime files were extracted. No stash, checkout deletion, or tracked source mutation was used. The archive remains available for inspection. This is additional reproduction evidence, not a new failing-first implementation claim.

## Old runtime results

Run bare from the archive:

```sh
node --test --test-name-pattern='a real second-actor accept updates' test/xp-workspace-root.test.js
```

Exit 1. Exact relevant output:

```text
AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
0 !== 1
at test/xp-workspace-root.test.js:100:12
actual: 0
expected: 1
```

The acceptance command succeeded. The assertion reads the main projection before any subsequent XP read, proving the automatic refresh gap rather than a test import or environment failure.

```sh
node --test --test-name-pattern='local XP recovers a real stranded accept' test/xp-workspace-root.test.js
```

Exit 1. Exact relevant output:

```text
AssertionError [ERR_ASSERTION]: The input did not match the regular expression /AgentXP 1 \| Today 1/.
AgentXP Card
AgentXP 0 | Today 0 | Career Level 1
at test/xp-workspace-root.test.js:234:12
```

The old runtime ran the real XP CLI and overlooked the accepted episode in the registered linked folder.

## Proposed runtime results

Run bare from the proposed checkout:

```sh
node --test test/xp-workspace-root.test.js test/xp.test.js test/xp-command.test.js
```

Exit 0. Exact summary: `tests 42`, `pass 42`, `fail 0`, `cancelled 0`, `skipped 0`, `todo 0`.

Real child CLI output:

```text
real xp --local before: AgentXP 0 | Today 0 | Career Level 1
real xp --local after automatic acceptance: AgentXP 1 | Today 1 | Career Level 1
real xp before recovery: AgentXP 0 | Today 0 | Career Level 1
real xp after recovery: AgentXP 1 | Today 1 | Career Level 1
unverified completed reviews: AgentXP 0 | Today 0 | Career Level 1
independently verified accepted review: AgentXP 1 | Today 1 | Career Level 1
```

Actual operator workspace read, exit 0:

```sh
node bin/atris.js xp --local --workspace /Users/keshavrao/arena/atris-cli
```

```text
AgentXP 1,146 | Today 4 | Career Level 2
Last 365 days: 1,146 AgentXP across 51 active days
```

This increment did not award new XP. The original mission baseline and recovery sequence remain in the pull request. Automatic refresh is proven by the isolated accept command reading the balance before XP runs, not by the existing operator balance.

`git merge-base --is-ancestor d3df9436 origin/master` exited 1 against locally cached origin/master `7f3ceeb4`. This is a cached-ref observation, not a freshly fetched deployment claim. The proposed fix is absent from that ancestry. No installed runtime was changed.

## Boundaries and handoff

Files edited: this receipt and ignored `atris/team/validator/logs/2026-10-22.md`. Existing test and fixture were read and copied only into the isolated archive. No code routes or file references changed, so MAP remains accurate. Generated TODO changes are excluded. No dependencies changed. Independent review gates remain intact; merge-only closes still earn no XP. Removed-folder recovery remains limited by missing acceptance-time evidence.

Reviewer rerun: `node --test test/xp-workspace-root.test.js test/xp.test.js test/xp-command.test.js`.
Frozen verifier: `git diff --check`, exit 0, no output.
Rollback: revert this documentation commit. Existing pull request remains open, without merge or self-acceptance.

next_push: Preserve acceptance-time repository identity and reviewer evidence before temporary folders are removed, so safe recovery no longer depends on surviving folders.

layer: capabilities
