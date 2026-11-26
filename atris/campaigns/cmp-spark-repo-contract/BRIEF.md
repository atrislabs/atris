# Check a change across repositories

## Situation

A client can expect a field the service no longer supplies. Both projects can pass their own tests while the user flow fails. A shared result must name the exact revisions tested and show whether they agree.

## Playground and action

The lead supplies a manifest with a local path, full commit ID and check for each repository, plus one check that uses both snapshots. The Fleet worker records each result and its exit status. The independent reviewer creates two disposable Git repositories with passing individual checks and an incompatible interface. The reviewer then corrects only the service contract and requests a fresh combined result. No person, hosted repository or cloud machine receives these trial assignments.

## Reward and knowledge

Require a failing combined result for the incompatible pair, a passing combined result for the corrected pair and unchanged receipts when the same request is repeated. Preserve the full commit IDs alongside the individual and combined receipts. Add the same two-repository exercise to future coordination rounds so a false acceptance stays visible.

## Run it locally

Save a manifest like the one below. Replace the revision strings with the full commit IDs printed by `git rev-parse HEAD` in the two repositories. Each path is relative to the manifest file. The check commands come from the person requesting the run and execute on their computer, from temporary copies of the requested commits.

```json
{
  "version": 1,
  "targets": [
    {"name": "client", "repo": "./client", "revision": "<full client commit>", "verify": ["node", "check.js"]},
    {"name": "service", "repo": "./service", "revision": "<full service commit>", "verify": ["node", "check.js"]}
  ],
  "joint": {"cwd": "client", "verify": ["node", "contract-test.js", "{repo:service}"]},
  "timeout_seconds": 60,
  "parallel": 2
}
```

From the same coordinator directory, run `atris fleet verify manifest.json --json`. A repeat returns the saved successful receipts. Use `--retry-failed` to run a check again after it returned a definite failure. Inspect an interrupted check with an uncertain outcome before proceeding. This runner uses local copies and local processes.
