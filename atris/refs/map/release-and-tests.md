# Release and tests

Releases, version checks, publish and the balanced CI test groups. Exact `file:line` refs and search shortcuts. Back to [MAP-NOTES.md](../MAP-NOTES.md).

## Search shortcuts: Modular commands

```bash
rg "releaseAtris|releasePreflight|release preflight" commands/release.js bin/atris.js test/release-preflight.test.js  # Release command plus pre-tag preflight
```

## Feature: Release (`atris release`)

**Purpose:** Tag a release, bump version, create GitHub release, draft /launch post

- **Entry point:** `commands/release.js:16` (releaseAtris function)
- **Preflight:** `commands/release.js:244` (`releasePreflight`) checks master, a clean tree, local master vs origin/master, no existing `v<version>` tag, then `npm test` with `CI=true`; git failures skip the suite
- **Dispatch/help:** `bin/atris.js:2797` routes `release`, `bin/atris.js:2803` routes `release preflight`, `bin/atris.js:1017` (`showReleaseHelp`) and `bin/atris.js:614` list the preflight command
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

## Balanced GitHub test groups and review resilience

- `scripts/ci-test-shard.js:15` discovers the Node 24 default test patterns, excluding node_modules. `scripts/ci-test-shard.js:22` assigns every discovered file once, largest measured cost first, to the lightest of eight groups using `test/ci-file-durations.json`. `scripts/ci-test-shard.js:47` invokes the real Node runner, keeps command-test splitting enabled, and returns failure when the child fails. `test/ci-test-shard.test.js:22` compares eight real child runs with native discovery.
- **Unavailable second review:** `commands/mission.js` records a passed build check followed by an unavailable reviewer as `review unavailable`; `lib/roster-runs.js`, `lib/roster-suggest.js`, `lib/roster-swap.js`, and `lib/router-brain.js` display or exclude it from builder scoring. Regression: `test/mission-review-unavailable.test.js`.
- **Member work prompt:** `commands/mission.js` builds the engine-independent work prompt (`test/mission-tick-prompt.test.js` checks job-first startup and retained boundaries).
