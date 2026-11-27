# Release and tests

Releases, version checks, publish and the balanced CI test groups. Code refs and search shortcuts. Back to [MAP-NOTES.md](../MAP-NOTES.md).

## Search shortcuts: Modular commands

```bash
rg "releaseAtris|releasePreflight|release preflight" commands/release.js bin/atris.js test/release-preflight.test.js  # Release command plus pre-tag preflight
```

## Choosing CI tests

`scripts/ci-test-plan.js` (`comparisonBase`, `buildMatrix`) finds changes in pull requests and queued commits and divides the selected files among workers. If the target advanced, the planner uses the tested pull request merge's base only when GitHub identifies that exact merge and Git proves the earlier base is its ancestor. If it cannot prove the base it runs all eight groups.

`scripts/ci-impact-check.js` (`plan`) maps changed files to tests and explains when the full suite is needed. `.github/workflows/ci.yml` requires planning, tests and deck lint to pass. Scheduled and manual runs use all eight full-suite groups.

The slow-answer and lost-answer retry checks in `test/gm-phone-hands.test.js` and the team-table, long-name and engine-swap viewport checks in `test/gm-phone.test.js` run at most two independent Chrome sessions at a time per check. Each case still uses its own browser and local test server.

The sleep and lost-look checks in `test/gm-phone-health.test.js` also overlap up to two independent Chrome sessions. The page keeps the same polling and response deadlines.

The connection and navigation checks in `test/gm-phone-hands.test.js` overlap up to two independent sessions. The checks keep the real reconnect, polling and response timers.

The calm-line checks in `test/gm-phone.test.js` overlap motion and reduced motion when closing the team, and sending and clearing a note while an idea waits. Each case keeps its own browser and desk.

The detached mission check in `test/mission-status.test.js` uses a one-second cadence. The real child still runs past its first cycle and exits when its saved budget runs out.

The phone checks for words kept after a failed send, replies that keep the card's action, and returning to the orb in `test/gm-phone.test.js` run up to two card cases together. Each still has its own Chrome session and desk.

`test/gm-phone-health.test.js` shares the identical screen reader capture between announcement and refusal checks, and the identical keyboard capture between focus ring checks. Each check can still run on its own.

`test/gm-phone-cards.test.js` holds nine unchanged browser journeys for card typing, team, and deck actions so CI can run them on a different worker from `test/gm-phone.test.js`.

`test/gm-phone-layout.test.js` measures card line wrapping, footer geometry, contrast, type sizes and team-link visibility in the same Chrome render where the card and viewport match. Each assertion keeps its original cards and screen sizes.

`test/engine-resource.test.js` counts bytes as it fills large log fixtures. The task history and archive checks in `test/commands-4.test.js` and `test/commands-6.test.js` make the first entry through the CLI and add the rest through the task store.

The workspace-free help sweep in `test/commands-7.test.js` runs two CLI processes at a time. Every invocation has its own home and working folder and still checks the exit code, output and absence of local state.

## Feature: Release (`atris release`)

**Purpose:** Tag a release, bump version, create GitHub release, draft /launch post

- **Entry point:** `commands/release.js:16` (releaseAtris function)
- **Preflight:** `commands/release.js` (`releasePreflight`) checks master, a clean tree, local master vs origin/master, no existing `v<version>` tag, then `npm test` with `CI=true`; git failures skip the suite
- **Dispatch/help:** `bin/atris.js:2761` routes `release`, `bin/atris.js:2767` routes `release preflight`, `bin/atris.js` (`showReleaseHelp`) and `bin/atris.js:600` list the preflight command
- **Flags:** `--dry-run` prints the draft without mutating
- **Steps:** git log since last tag → determine bump (minor if scorecard reward≥5, else patch) → run `npm version --no-git-tag-version` so package.json and package-lock.json move together → commit both files → tag → push → `gh release create` → print launch post
- **Helpers:**
  - `determineBumpType()` → `commands/release.js:129`
  - `bumpVersion()` → `commands/release.js:151`
  - `printLaunchPost()` → `commands/release.js:165`
  - `runFullTestSuite()` → `commands/release.js:194`
- **Regression:** `test/commands-7.test.js:2327` covers `release --help` without package version changes; `test/release-preflight.test.js:1` covers help wiring, off-master refusal, dirty/tag/origin failures, CI=true suite pass, and the real suite exit code

**Search:** `rg "showReleaseHelp|releaseAtris|releasePreflight|release --help|bumpVersion" bin/atris.js commands/release.js test/commands-1.test.js test/release-preflight.test.js`

## Feature: Version Check (`atris version`)

**Purpose:** Show installed ATRIS version

- **Entry point:** `commands/version.js:4-16` (showVersion function)
- **Reads:** `package.json` version field
- **Output:** `atris v2.0.20`

**Search:** `rg "showVersion" commands/version.js`

## Entry Point 6: Development/Publish

```bash
npm link              # Local testing
npm run publish:release
```

**Flow:** Development → test with `npm link` → bump version → `.github/workflows/publish.yml` or local `npm run publish:release`; trusted publishing requires npm package settings to name workflow filename `publish.yml`. After publish, `scripts/publish-atris-release.js` waits up to 10 minutes for npm latest (`verifyPublishedVersionWithRetry`) and succeeds early when the exact version is already on the registry.

---

## Revision reports across out-of-order commit dates

Raw temporary-folder test setup: `test/helpers/task-help-fixture.js:43` supplies the unchanged folder functions to version-cmd, confidence-gate, unknowns, console-packet-shape and agent-proof-only tests. Their local no-argument wrappers retain each exact prefix and raw temporary path; CLI helpers, options and behavior checks remain local. Check: `node --test test/version-cmd.test.js test/confidence-gate.test.js test/unknowns.test.js test/console-packet-shape.test.js test/agent-proof-only.test.js`. The same unchanged folder functions also serve agents, config-guard, dream and router-brain tests; their local files, injected callbacks and availability checks stay local. Check: `node --test test/agents.test.js test/config-guard.test.js test/dream.test.js test/router-brain.test.js`.

The task list limit cases in `test/commands-6.test.js` create the first row through the CLI and populate the other rows through the task store. The auto-accept scan, grouped reviews and blocked-task archive checks still run through the CLI at their original row counts.

## Balanced GitHub test groups and review resilience

- `scripts/ci-test-shard.js:15` discovers the Node 24 default test patterns, excluding node_modules. `scripts/ci-test-shard.js:22` assigns every discovered file once, largest measured cost first, to the lightest of eight groups using `test/ci-file-durations.json`. `scripts/ci-ordered-tests.js` runs the assigned files through the Node test API in that order instead of the CLI's alphabetical order. The same file isolation, command-test splitting, and failure status remain. `test/ci-test-shard.test.js` compares eight real child runs with native discovery.
- **Unavailable second review:** `commands/mission.js` records a passed build check followed by an unavailable reviewer as `review unavailable`; `lib/roster-runs.js`, `lib/roster-suggest.js`, `lib/roster-swap.js`, and `lib/router-brain.js` display or exclude it from builder scoring. Regression: `test/mission-review-unavailable.test.js`.
- **Member work prompt:** `commands/mission.js` builds the engine-independent work prompt (`test/mission-tick-prompt.test.js` checks job-first startup and retained boundaries).
