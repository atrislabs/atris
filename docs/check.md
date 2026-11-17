# atris check

One command, any project: pick the checks a change needs by plain rules, run
the ones that may run on this machine, check the change's own proof, scan it
for keys and write one receipt. `--push` then puts it on GitHub.

No model calls, no learned picker, no cloud. Every pick prints its reason.

```
atris check                 pick, run, prove, scan, write .atris/receipts/check-<sha>.json
atris check --explain       print the plan, run nothing
atris check --verify        does a receipt prove the code here now? (--receipt <file>)
atris check push            update on the default branch, check that code, push or stage it
atris check land <sha>      on a runner with no screen: run the rest, fast-forward
atris check init            write a starter atris/checks.json from what the project has
atris check sweep           remove staged refs that landed over 7 days ago, list the others
atris check fix             hand a failed receipt to CodeOps (--dry-run sends nothing)
```

Other flags: `--base <ref>`, `--files a,b` (a hand-picked list never makes a
receipt that verifies), `--proof "<cmd>"`, `--deep`, `--lane here|no-screen`,
`--allow-paid`, `--gate <name>`, `--parallel N`, `--timeout S`, `--json`.
`atris check <mission-id>` still shows a cloud mission's checks.

## Exit codes

| code | meaning |
|---|---|
| 0 | proven: every picked check passed and the proof passed |
| 3 | partly: what could run here passed, some checks need another lane (or the push was staged) |
| 1 | failed |
| 2 | usage or map error |

Exit 3 always prints `atris check: not proven here; needs a lane`. Task
ready, the hourly lander and `atris worktree ship` read that code and line
together as "not proven here", never as passed.

## The map: atris/checks.json

```json
{
  "checks": {
    "fast-gate": { "run": "bash scripts/test_fast.sh", "always": true, "risk": "sign-in", "seconds": 120 },
    "ui": { "run": "node scripts/test-ui.mjs", "when": ["src/**"], "where": "no-screen" },
    "changed-tests": { "run": "node {file}", "each": ["scripts/test-*.mjs"], "names_changed": { "of": ["src/**"] } }
  },
  "risk": { "low": ["**/*.md"], "high": { "money": ["src/billing/**"], "sign-in": ["src/auth/**"] } },
  "gates": { "release": ["fast-gate", "ui"] },
  "default": ["fast-gate"],
  "importers_except": ["src/App.tsx"],
  "push": { "lane_status": "gh run list --workflow lane.yml --branch main --limit 1 --json conclusion --jq .[0].conclusion" }
}
```

A check: `run` (one command, no `&&`, `||` or `;`), `where` (`here`,
`no-screen`, `paid`), `when` (path globs), `always`, `risk` (`money`,
`sign-in`, `access`, `security`, `release`, `data`), `seconds`,
`timeout_seconds`, `needsElectron` (forces `no-screen`), `port` (a free port
arrives as `PORT`), `each` plus `{file}` in `run` (one run per file),
`names_changed`, `confirm` (a note from init for a person to clear).

Map level: `risk`, `gates`, `default`, `importers_except`, `skip_lines`,
`secret_scan` (the project's own scan command), `parallel`,
`proof.coverage_floor` and `push` (`update`: rebase or merge, `via`,
`lane_status`, `low_risk_ahead_of_lane`, `max_files` 5, `max_lines` 200).

Globs match the whole path from the repo root: `*` stays in one folder, `**/`
spans folders, `{a,b}` is either, a trailing `/` means everything under it.

## The rules

1. Each changed file, plus the files that import it directly (one hop), is
   matched against every check's `when`.
2. Every `always` check runs.
3. A high risk file (in the change or importing it) adds every check that
   guards that risk, plus the whole `release` gate.
4. A changed file no glob knows adds the `default` set and is listed as
   unmapped. A changed code file whose imports cannot be read (Go, Rust and
   others) counts as unmapped too. Unknown widens, never narrows.
5. `each` checks run once per file: a candidate that changed, or (with
   `names_changed`) one whose text names a changed file. A file that says
   `launches: app` in its first 20 lines goes to `no-screen`; one that says
   `spends:` (anything but nothing) goes to `paid`.

High risk in every project, whatever the map says: `atris/checks.json`
itself, lockfiles and `migrations/` folders.

Imports are read with plain patterns (JS and TS `import`, `require`,
`export from`; Python `import` and `from`) and cached by git blob id under
`.atris/cache`.

## Where checks run

`here` checks run now, a few at a time, each in its own process group with a
hard timeout that kills the whole group. `no-screen` and `paid` checks never
run on a person's machine; they are recorded as `needs-lane`. `--lane
no-screen` runs them on a runner and is refused on a person's machine.
`--allow-paid` is the only way a paid check runs.

A person's machine: macOS (someone logged in at the screen) or Windows, with
no `CI=true`. `ATRIS_CHECK_PERSON=1` or `0` overrides.

The cage: every check gets `CI=1`, `BROWSER=none`. On a person's machine
the desktop app's launch opt-in (`OBELISK_ALLOW_APP_LAUNCH`) is removed and
`ELECTRON_RUN_AS_NODE=1` is set. That last one changes how Electron starts (as
plain node, no window). A check that truly needs the app does not belong
here: mark it `needsElectron` and it goes to the lane.

A check whose output carries a skip line (default: the desktop app's
`skipped on this Mac: opens the app; runs in the no-screen lane`) did not run
here, whatever it exited: `needs-lane`.

## The proof

A normal or high risk change must carry its own proof, one command:
`--proof "<cmd>"`, a `Proof: <cmd>` line in a commit message of the change
(it travels with the commit), or the `--verify` of the open task on this
branch. Without one the verdict is never proven: `no proof for this change`.
Low risk changes (wording, docs, styles) need none.

The proof is checked on this code only:

1. It is about this change: it runs a changed file, or names one, or runs a
   file that names one.
2. It passes when run once.
3. For node proofs, coverage is free (`NODE_V8_COVERAGE`): it must run at
   least one changed line outside tests. The count is always reported; a floor
   is enforced only if the map sets `proof.coverage_floor`.
4. A proof test with no assertion, or one that mocks the very file it claims
   to prove, is flagged.

`--deep` adds the strong form: the proof must fail on the base code (a plain
export in a temp folder, with this change's test files copied in) and pass
here. The temp folder is removed afterwards. It has no installed packages.
It suits a lane more than a laptop.

## Keys

Every run scans the lines the change adds for key-shaped strings (or runs the
map's `secret_scan`). It names file, line and kind, never the text. A high
risk change prints the one command for the full audit, `atris security-review
audit <paths> --quick`; `atris check` never calls a paid engine.

## The receipt

`.atris/receipts/check-<sha>.json` (the folder ignores itself in git). It
names the code by the git tree of the working copy, uncommitted files
included. A receipt never vouches for different code; committing the same
code keeps it valid. Fields: repo, base, head sha, tree, uncommitted hash,
pushable (false with uncommitted files), risk tier, changed files, unmapped,
each check with `passed | failed | needs-lane | skipped-by-rule`, why, seconds
and exit code, the proof, the key scan and the verdict. A skip is never a pass.

## Push

`atris check push` (or `--push`), from a clean committed tree:

1. fetch, then rebase (or merge, per `push.update`) onto the latest default branch;
2. pick and run checks on that exact code;
3. push it straight to the default branch only when all five hold, each printed yes or no:
   no high risk path in the change or its importers; every check that may run
   here passed, none skipped itself, the proof passed, no keys; small (5 files,
   200 lines, nothing unmapped); the default branch's lane is not red (read by
   `push.lane_status`; unknown when it cannot be read; a project with no
   no-screen checks has no lane to be red); no check waits for another lane
   (or the map lets low risk land ahead of it).
4. Otherwise stage it on `atris/ready/<sha>` and exit 3: `staged: waits for the no-screen lane`.

The push is compare and swap (`--force-with-lease` on the base it was checked
against). If the default branch moved, it updates, also checks the files the
new commits changed and tries again, three times at most.

`push.via` hands the final push to the project's own command (like `npm run
ship`) instead.

`atris check land <sha> --lane no-screen`, on a runner: fetch the staged ref,
run everything (skipping checks a receipt for the same code already passed),
fast-forward the default branch on green and delete the ref; on red leave the
ref and name what failed. Nothing reverts the default branch in v1.

## Storage

Nothing to prune by hand.

- The default path makes no work copy and no clone. Only `--deep` makes one:
  a detached worktree in the OS temp folder, packages cloned the way work
  copies get them, removed in a finally block. One a crash left behind goes
  on the next run once it is an hour old.
- Receipts: the newest 200 per repo, none older than 14 days, pruned on every
  write. A receipt whose commit waits on a staged ref is kept. A receipt holds
  no logs: the last 40 lines of a failed check, nothing for one that passed.
- The import cache is one file, at most 5 MB; past that it is rebuilt.
- Staged refs go when they land. `atris check sweep` removes ones older than
  7 days whose commit is already on the default branch and lists the ones
  that are not, without deleting them.
- Every run ends with one line: `storage: receipts 212 KB, cache 1.1 MB`.
- `init` adds `.atris/receipts/` and `.atris/cache/` to `.gitignore` when git
  does not ignore them already. Both folders also ignore themselves.

## CodeOps is the crew; the map is the rulebook

`atris check fix` turns a failed receipt (from here or from the lane) into one
tight task: the repo, the branch, each failing check with its exact command,
the last 40 lines of each failure (with this machine's folders taken out),
and the rule: fix the cause, never weaken or skip a check, reply with COMMIT
and PUSHED. It hands that to the cloud engineering computer with `atris
computer pr <owner/repo> "<task>" --business atris-codeops --base <branch>`,
pushing the branch first when GitHub does not have that commit yet. A
dispatch wakes a cloud computer, which costs a little. One job per receipt,
and checking the same code again does not open a second one. The fix comes
back as a branch. `atris check push` on it is the same path as any change.

v1: CodeOps fixes red. Next: the lane itself runs on the CodeOps computer,
once it can return a receipt and run the app with no screen.

## Next

- Warm slots: a small pool of headless work copies per repo, booted ahead.
  An agent leases one instead of making a work copy: patch, check in about a
  second, preview, push, reset.
- The train: several staged changes share one lane run, split in half on red.
- The check budget: a check retires when it has not caught a real break.
- Signed receipts: a lane could then trust a receipt it did not write.
- Python changed-line coverage, when `coverage` is already installed.
