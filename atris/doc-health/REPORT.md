# Document health build report

## What landed

Implemented `atris doc-health [--json] [--questions <path>]` on the supplied branch, following `atris/doc-health/build.md`.

| File | Change |
| --- | --- |
| `commands/doc-health.js` | Boot sizes and token estimates, map coverage, lookup hops, feature/member staleness, similar feature names, weighted score, text and JSON output. |
| `test/doc-health.test.js` | Temporary-workspace CLI checks and deterministic age-boundary checks. |
| `atris/doc-health/questions.jsonl` | Ten real CLI questions; every expected path exists. |
| `bin/atris.js` | Command dispatch and help entry beside doctor. |
| `lib/known-commands.js` | Command registration; this is where the current router keeps its command list. |
| `commands/brain.js` | Export the existing `readText` helper for reuse. |
| `README.md` | Short doctor and document-health sections. |
| `atris/MAP.md` | One routing row for implementation, tests, questions, and brief. |
| `atris/doc-health/REPORT.md` | This report. |

The command reuses `resolveWorkspaceRoot`, works from workspace subfolders, and adds no dependencies. Missing workspace folders exit 1 with a plain message. Unhealthy scores, missing inputs, and malformed question lines do not fail the command.

## Verification

Command: `node --test test/doc-health.test.js`

Exit: 0

Exact output:

```text
✔ missing atris folder exits 1 with a plain message and JSON error (82.963708ms)
✔ boot load reports all files, missing files, and oversized files (83.177792ms)
✔ map coverage counts routing rows, unique paths, line references, and exact folder mentions (50.555208ms)
✔ real CLI reports one-hop, two-hop, and unresolved questions with JSON score parts (86.45825ms)
✔ one hop requires a keyword on the same line and drops stop words and short words (45.2365ms)
✔ missing and empty question files skip scoring and explain how to add questions (125.214ms)
✔ custom questions resolve from the workspace root even when invoked in a subfolder (84.590666ms)
✔ staleness flags old active features and members with no logs or old nested logs (90.763792ms)
✔ freshness thresholds are strictly older than 60 and 30 days and oldest lists stop at ten (6.015917ms)
✔ near duplicate feature groups require at least five shared prefix characters (42.948083ms)
✔ boot scoring is linear between 60,000 and 200,000 chars and clamps outside (174.781042ms)
✔ help works outside a workspace and the repository ships ten questions with existing paths (43.0125ms)
ℹ tests 12
ℹ suites 0
ℹ pass 12
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 962.780958
```

Command: `node --test test/brain-command.test.js test/dogfood-p1.test.js`

Exit: 0

Exact output:

```text
✔ brain compile writes STATUS.md, ledger, and state.json from a seeded workspace (81.052125ms)
✔ brain compile --json returns ok true with state and written artifact paths (75.086916ms)
✔ recompile with unchanged inputs is idempotent: same artifacts, one boot block, no growth (146.879167ms)
✔ recompile preserves operator prose around the generated block (72.827584ms)
✔ brain activate --verify on a ready member exits 0 with an executable card (80.848666ms)
✔ brain activate --verify on a missing member exits nonzero with a plain message, no stack trace (75.522166ms)
✔ flag handling: --root= equals form and the status alias both compile from a foreign cwd (74.477958ms)
✔ brain help exits 0 with usage; an unknown subcommand exits 1 with usage on stderr (87.536ms)
✔ verifyActivationCard passes ready cards and rejects missing or not-ready operators with plain messages (0.379083ms)
✔ verifyActivationGallery names every not-ready member across cards (0.122584ms)
✔ collectState reads the seeded workspace shape: name, todo counts, endgame, load flags (12.142458ms)
✔ public bin shim is tiny and points at atris.js (0.63975ms)
✔ doctor --json reports node and task-support (154.568584ms)
✔ radar/fleet/engine/integrations/accounts default to workspace scope (471.604458ms)
✔ verify exits 1 when MAP issues exist (58.836375ms)
✔ land in empty repo prints one-line error without stack (63.525583ms)
✔ recap does not claim tests passed for a file-exists verifier (12.01475ms)
ℹ tests 17
ℹ suites 0
ℹ pass 17
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 796.641375
```

Command: `git diff --check`

Exit: 0. Output: empty.

The task's own verification also ran `node --test test/doc-health.test.js` successfully and moved the work to Review. Its local receipt is `atris/runs/2026-09-15-task-dh2-1-2026-09-15T19-55-05-971Z.json`.

## Repository run

`node bin/atris.js doc-health` and `node bin/atris.js doc-health --json` both exited 0. The final JSON run reported:

| Measure | Value |
| --- | --- |
| Overall | 70.65/100 |
| Boot load | 428547 chars; 107136.75 approximate tokens |
| Routing rows | 1 |
| Existing routing paths | 4/4 |
| Feature folders mentioned | 5/20 |
| Member folders mentioned | 3/32 |
| Questions resolved in one hop | 10/10 |
| Stale feature ideas | 0/16 |
| Stale members | 29/31 |

Coverage measures routing-table references, as specified. Other prose references still participate in lookup hops and folder mentions.

## Assumptions and limits

- The brief requires a shared prefix of at least five characters, but its `aeo` and `rl-` examples share only three. The implementation and tests follow the explicit five-character threshold.
- Map paths are deduplicated and strip line numbers and heading anchors. Prose and fenced examples are excluded from routing-row coverage.
- Missing or empty questions have a null lookup score and earn zero lookup points. No routing paths earns zero coverage points. Empty feature/member sets earn full freshness points.
- Features without a parseable date are reported with a null age and are not flagged. Member ages use recursive log-file modification times, so copying or checking out logs can change their measured age.
- Custom question paths are relative to the resolved workspace root. Invalid JSONL records are reported by line number and excluded from the question denominator.

No requested implementation remains unfinished. Work was committed incrementally on the supplied branch; no pull request was opened.

