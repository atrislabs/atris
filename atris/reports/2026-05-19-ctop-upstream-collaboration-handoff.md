# ctop upstream collaboration handoff

Date: 2026-05-19
Task: CLI-141
Local upstream clone: `~/arena/ctop-upstream-dogfood`
Branch: `atris/plugin-autoload`

## What this is for

ctop is useful to Atris as the live process radar: it shows which Claude/agent
processes are running, where they are running, and how much machine resource
they are using.

Atris/Swarlo add the missing coordination layer: task ownership, proof state,
review state, mission state, and whether a process is mapped to real work.

Together:

```text
ctop     = what agents/processes are alive on the machine
Atris    = what work is canonical, claimed, reviewed, or blocked
Swarlo   = how work claims and handoffs coordinate across people/agents
```

The dogfood result is a local Atris ctop plugin plus an upstream patch that makes
ctop's documented plugin system load reliably from the normal bin entrypoint.

## Local dogfood result

Installed locally:

- `~/.ctop/plugins/atris-task.js`
- `~/.ctop/ctop-atris.js`
- `~/.local/bin/ctop-atris`

Current proof:

```bash
ctop-atris --plugins-check
```

Expected:

```json
{ "ok": true, "plugins": ["Atris"] }
```

## Upstream branch

Commits on top of `origin/main`:

```text
b605ad2 Stabilize ctop test suite around config and logs
9dbdb7d Load plugins when ctop starts from bin wrapper
```

Portable patches:

- `atris/reports/ctop-upstream-patches/0001-Load-plugins-when-ctop-starts-from-bin-wrapper.patch`
- `atris/reports/ctop-upstream-patches/0002-Stabilize-ctop-test-suite-around-config-and-logs.patch`

Patch checksums:

```text
283210cfac3da7c4eaeb907c59974ba8e964672bbf6e0079c20e85693dbcfa2a  0001-Load-plugins-when-ctop-starts-from-bin-wrapper.patch
d74e940e52d1e946267a72fbf1e24906d065b50fa8f4901c0d6807a347932be7  0002-Stabilize-ctop-test-suite-around-config-and-logs.patch
```

## PR draft

Title:

```text
Load plugins when ctop starts from the bin wrapper
```

Body:

```markdown
## Summary

- load `~/.ctop/plugins` from `core.main()` so plugins work through the normal package bin entrypoint
- add a regression test for plugin loading through the startup path
- make config/log helper tests deterministic by avoiding real `~/.ctoprc`, preserving home-path display semantics, and restoring the documented session-log tail default

## Why

The README documents JavaScript plugins in `~/.ctop/plugins`, but the published bin wrapper imports `_core.js` and calls `main()`. Plugin loading previously lived behind `if (require.main === module)`, so plugins did not load through the normal bin path.

I hit this while dogfooding a local Atris task plugin for ctop. The fix keeps the public plugin contract intact and adds coverage so the bin startup path stays extensible.

## Verification

- `node --check src/_core.js`
- `node --test test/plugins.test.js`
- `node --test test/boot.test.js test/config.test.js test/grouping.test.js test/log-tailing.test.js test/plugins.test.js`
- `npm test` -> 454/454 passing
```

## Collaboration options

1. Push this branch to a fork and open the PR with the draft above.
2. Send the two patch files directly if upstream collaboration should stay low-friction.
3. Keep the local `ctop-atris` wrapper only if we do not want to touch upstream yet.

Boundary: no direct upstream push was performed.

Opened draft PR:

- https://github.com/aakashadesara/ctop/pull/82
- head: `keshav55:atris/plugin-autoload`
- base: `aakashadesara/ctop:main`
- state at open: open draft

## Verified current state

```text
ctop-atris --plugins-check
=> { "ok": true, "plugins": ["Atris"] }

npm test
=> 454/454 passing

git am patch check from origin/main
=> both patch files apply cleanly

gh pr view 82 --repo aakashadesara/ctop
=> open draft PR from keshav55:atris/plugin-autoload
```
