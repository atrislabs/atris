# atris check

One command, any project: pick the checks a change needs by plain rules, run
the ones that may run on this machine, check the change's own proof, scan it
for keys and write one receipt. `--push` then puts it on GitHub.

No model calls, no learned picker, no cloud. Every pick prints its reason and
how long it should take.

Three commands are the whole path for an agent:

```
atris check            check the change here and write a receipt
atris check --push     check it on the latest default branch, then push it or stage it with its receipt
atris check --verify   work the plan out again and see whether the receipt still proves the code
```

The hourly lander accepts a change only with a receipt it can work out again
(below). A receipt is a plain file. Nothing takes its word for it.

The aim is speed you can feel: a wording change checks in a second or two, an
ordinary change runs the few tests that cover it and only a risky change
waits for the whole gate.

```
atris check                 pick, run, prove, scan, write .atris/receipts/check-<sha>.json
atris check --explain       print the plan, run nothing
atris check --verify        work the plan out again; does the receipt prove the code here now? (--receipt <file>)
atris check push            update on the default branch, check that code, push or stage it
atris check land <sha>      on a runner with no screen: run the rest, fast-forward
atris check init            write a starter atris/checks.json from what the project has
atris check sweep           remove staged refs that landed over 7 days ago, list the others
atris check fix             hand a failed receipt to CodeOps (--dry-run sends nothing)
atris check --lint-map      check the map itself (every check does this first)
atris check replay --last N the plan each of the last N commits would get; runs nothing
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

## Three risk tiers

Every change gets one tier and the tier decides how wide the check goes.

| tier | what makes it | what runs | target |
|---|---|---|---|
| low | docs, wording, styles, tests or code whose diff is only comments and whitespace | only checks marked `"tier": "low"`, the changed tests themselves and the key scan. Never the gate. No proof needed. | 5s |
| normal | any other change | fast `always` checks, checks whose `when` matches and the tests a selector picks. The full gate does not run here. | 20s |
| high | money, sign-in, access, security, migrations, lockfiles, the map itself, release paths or a file that imports one of those | the selected tests first, for fast feedback, then the whole `release` gate. If the first stage fails the gate does not start; its checks read `not-run`, which is never a pass. | 300s |

Comments only: both versions of the file are reduced to their code (comments
out, spaces squashed, line breaks and Python indentation kept) and compared
and every changed line must look like a comment or differ only in spaces. Any
doubt (a trailing comment after code, an unreadable file, a language it does
not know) counts as code. A high risk path stays high whatever its diff.

A check can say which tiers it runs in: `"tier": "low"` runs in every tier,
no tier means normal and high, `"tier": "high"` only for high risk and gates.
A map can make normal changes wait for a lane with `"normal_needs_lane":
["<check>"]`; by default nothing does.

`always` is only for checks of 5 seconds or less and the check must say its
`seconds`. A slower always is refused by `atris check --lint-map` and at the
start of every check, with the fix: give it `when` globs, put it in the
release gate or make it a selector.

## Selectors: the few tests that cover a change

A check can pick tests instead of running one fixed command:

```json
"tests": {
  "select": "pytest",
  "roots": ["backend/tests"],
  "when": ["backend/**"],
  "cwd": "backend",
  "python": "venv/bin/python",
  "run": "{python} -m pytest -q {parallel} {files}",
  "env": { "PYTHONPATH": "." },
  "max": 40,
  "fallback": "fast-gate"
}
```

`select` is `pytest` (files named `test_*.py` or `*_test.py`) or `node-test`
(`test-*.mjs`, `*.test.ts`, `*.spec.tsx` and so on). `roots` are the folders
or globs the tests live in. `run` takes `{files}` (one run for all picked
tests; vitest and jest work this way) or `{file}` (one run per test, a few at
a time). Paths are relative to `cwd`. `{python}` is the map's `python` from
this copy, else from the main checkout, else `python3`. `{parallel}` becomes
`-n <workers>` when pytest-xdist is installed and at least `parallel_min` (4)
tests were picked.

A test is picked, with its reason printed, when it:

- `changed`: is itself part of the change;
- `imports: x`: imports the changed file x directly or one hop away (it
  imports a file that imports x). A file in between that more than
  `hub_tests` (8) tests import is a hub and the hop does not go through it;
  the plan names the hubs it skipped;
- `named-for: x`: is named for x (`test_x.py`, `x.test.ts`, `test-x.mjs`,
  kebab-case too) or its text mentions x by path, by Python module path or
  (JS) by a name x exports. A name more than 12 tests mention is too common to
  say anything and is not used;
- `owner: <glob>`: is listed for x's path in the map's `owners` table,
  `{"src/billing/**": ["tests/test_billing.py"]}`.

Imports are read with plain patterns: JS and TS `import`, `require`, `export
from`, plus aliases from `tsconfig.json` or `jsconfig.json` `paths` and
`baseUrl`; Python `import a.b`, `from a.b import c` (also in parentheses over
several lines), relative imports and `from pkg import mod` as an import of
`pkg/mod.py`. A split module that loads a part by a string,
`feature_parts.run(globals(), "<stem>_features/x/x.py")`, counts as importing
that part (only inside its own `<stem>_features` folder). Its tests run the
part: the module is never a hub in front of it.

A map can list `broad` files (an app's main file that hundreds of tests
name). For those the selector looks for the names the change touches instead
of the file name: the function each changed hunk sits in and the names
declared on changed lines, `named-for: main.js (changes normalizeClaudeEvent)`.

Two rules widen, never narrow:

- A changed source file no picked test covers is a finding: the plan prints
  `no test covers <file>` and the selector runs its `fallback` instead. This
  is how gaps get seen.
- More than `max` picked tests means a big blast radius: the fallback runs.

`fallback` names a gate, another check or one command. It stands in for the
tests the selector could not pick. It must be the whole suite: a gate name
(every check in it runs), a check in the `release` gate, a check marked
`"full": true` or a check that runs in a lane. Anything else runs part of
the tests. It still runs for fast feedback. Its row reads `needs full gate`
and the change is never proven; `--lint-map` notes such a map.
Same rule as before: a selected test marked `launches: app` goes to the
no-screen lane and one marked `spends:` is paid.

## Time you can see

Every plan prints the expected seconds of each check, the total and the
tier's target. A map can change the targets with `"budget": {"low": 5,
"normal": 20, "high": 300}`. Every run records what each check really took in
`.atris/cache/check-durations.json` (9 runs per check, 2,000 checks, 512 KB at
most) and the next estimate is the median of those runs. A selector's
estimate is its `seconds` (the start-up) plus `per_test_seconds` for each
picked test, spread over its workers, learned the same way.

When a run takes longer than its target the summary says which check blew it
and the receipt keeps it in `over_budget` so slow checks get fixed or moved
to the lane. The receipt also keeps `tier_target_seconds`,
`expected_seconds`, `actual_seconds`, each check's `expected_seconds` and
`seconds`, the picked tests with their reasons and `uncovered`.

## Replay

`atris check replay --last 100` plans each of the last 100 commits on the
default branch as if it were the change and runs nothing. Commits are walked
first-parent so a merged pull request counts once with its whole diff and
docs-only commits are skipped and counted. Each row shows the tier, how many
tests were picked (or that it fell back), the expected seconds and whether it
would push straight or be staged. The summary gives each tier's share and its
median and 90th percentile seconds, how often a changed file had no covering
test and the files most often uncovered. A `times:` line says how many check
times were measured on this machine and how many are the map's own seconds,
so a replay on a fresh machine is not read as measured. Everything is read from git
objects; the checkout is not touched. `--json` for the rows, `--map <file>` to
try a map before it lands.

## The map: atris/checks.json

```json
{
  "checks": {
    "parses": { "run": "node --check main.js", "always": true, "seconds": 1 },
    "fast-gate": { "run": "bash scripts/test_fast.sh", "tier": "high", "risk": "sign-in", "seconds": 120 },
    "ui": { "run": "node scripts/test-ui.mjs", "when": ["src/**"], "where": "no-screen" },
    "tests": { "select": "node-test", "roots": ["scripts"], "run": "node {file}", "fallback": "fast-gate", "seconds": 3 }
  },
  "risk": { "low": ["**/*.md"], "high": { "money": ["src/billing/**"], "sign-in": ["src/auth/**"] } },
  "gates": { "release": ["fast-gate", "ui"] },
  "default": ["tests"],
  "importers_except": ["src/App.tsx"],
  "broad": ["main.js"],
  "owners": { "src/billing/**": ["scripts/test-billing.mjs"] },
  "push": { "lane_status": "gh run list --workflow lane.yml --branch main --limit 1 --json conclusion --jq .[0].conclusion" }
}
```

A check: `run` (one command, no `&&`, `||` or `;`), `where` (`here`,
`no-screen`, `paid`), `when` (path globs), `always` (5s or less), `tier`,
`env`, `cwd`, a selector's fields (above), `risk` (`money`,
`sign-in`, `access`, `security`, `release`, `data`), `seconds`,
`timeout_seconds`, `needsElectron` (forces `no-screen`), `port` (a free port
arrives as `PORT`), `each` plus `{file}` in `run` (one run per file),
`names_changed`, `confirm` (a note from init for a person to clear).

Map level: `risk`, `gates`, `default`, `importers_except`, `broad`, `owners`,
`budget`, `normal_needs_lane`, `skip_lines`, `waiting_limit` (a whole number, 10 when unset),
`secret_scan` (the project's own scan command), `parallel`,
`proof.coverage_floor` and `push` (`update`: rebase or merge, `via`,
`lane_status`, `low_risk_ahead_of_lane`, `max_files` 5, `max_lines` 200).

Globs match the whole path from the repo root: `*` stays in one folder, `**/`
spans folders, `{a,b}` is either, a trailing `/` means everything under it.

## Which map decides

The map that picks the checks is the default branch's, as of the merge base
with the change (else the default branch now). A change that edits
`atris/checks.json` is checked by the map it would replace. That map's
settings decide too (skip lines, the key scan, push limits, `push.via`). Only
when the default branch has no map yet does the change's own map count. The
map file is high risk in every project: such a change runs the release
gate. Every receipt names the map it used: `map_blob` and `map_from`.

## The rules

0. The change gets its tier (above); a check runs only in the tiers it allows.
1. Each changed file, plus the files that import it directly (one hop), is
   matched against every check's `when`. A low risk file's importers are not
   counted: nothing they run changed.
2. Every `always` check runs.
3. A high risk file (in the change or importing it) adds every check that
   guards that risk, plus the whole `release` gate (a selector in the gate
   runs whole: its fallback).
4. A changed file no glob knows adds the `default` set and is listed as
   unmapped. A changed code file whose imports cannot be read (Go, Rust and
   others) counts as unmapped too. Unknown widens, never narrows.
5. `each` checks run once per file: a candidate that changed, or (with
   `names_changed`) one whose text names a changed file. A file that says
   `launches: app` in its first 20 lines goes to `no-screen`; one that says
   `spends:` (anything but nothing) goes to `paid`. A `!glob` entry leaves
   files out: `["a/*.sh", "!a/net.sh"]` never plans `a/net.sh`.

High risk in every project, whatever the map says: `atris/checks.json`
itself, lockfiles and `migrations/` folders. `importers_except` can quiet an
entry file, never a high risk one: a change a money or sign-in file imports
stays high risk. A test's `launches: app` or `spends:` line counts as it stood
on the base too. Deleting it in the same change does not move the test onto
this machine.

Imports are read with plain patterns (JS and TS `import`, `require`,
`export from`; Python `import` and `from`) and cached by git blob id under
`.atris/cache`.

## Where checks run

`here` checks run now, a few at a time, each in its own process group with a
hard timeout that kills the whole group. `no-screen` and `paid` checks never
run on a person's machine; they are recorded as `needs-lane`. `--lane
no-screen` runs them on a runner and is refused on a person's machine.
`--allow-paid` is the only way a paid check runs.

Cheapest first: a defect is caught where it costs least. The key scan,
then the quick checks (one command of 5 seconds or less: lint, types), then
the tests the change needs, then the full gate (a selector's fallback, the
release gate, the checks that guard a high risk). Checks inside one stage run
side by side. The first failure stops the rest: each later check and the
proof read `not run because <check> failed`, which is never a pass. The map
itself is checked before all of it.

Every check is told which change it checks: `ATRIS_CHECK_BASE` is the merge
base the plan was made against (empty for `--files`) and `ATRIS_CHECK_FILES`
names a temp file listing the changed files, one per line, removed after the
run.

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

## --verify works the plan out again

`atris check --verify`, `atris worktree ship` and the hourly lander never
trust what a receipt says it ran. They work the plan out again from the
diff and the default branch's map, then refuse the receipt, naming the check
or field, when:

- it names a different commit or tree than the code being checked;
- it was made from a `--files` list or is a whole gate run;
- it leaves out a check the plan picks, or marks one skipped by rule;
- a picked check ran a different command, or is called `here` when the map
  says `no-screen` or `paid`;
- a row counted as passed exited non-zero, says it skipped itself, or is a
  no-screen check that "passed" on a person's machine;
- its verdict is better than its own rows make it, or its proof is marked
  passed without a command that exited 0 and is about this change;
- it claims a lower risk tier than the change has;
- it was made with a different map than the default branch's, or names none.

There is no cryptography: a receipt can still lie that a check it lists
passed. That is why the lander runs the checks itself for high risk changes.

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

A staged push (or one through `push.via`) also keeps its receipt on origin as
`refs/atris/receipts/<sha>`: a commit with no parent holding one file,
`receipt.json`. It sits outside `refs/heads`: it is no branch and starts no
workflow. Work copies share refs with their main checkout. A lander on the
same machine reads it with no network; one elsewhere fetches it. When the ref
cannot be pushed the line says so. The lander then checks the change itself.

The push is compare and swap (`--force-with-lease` on the base it was checked
against). If the default branch moved, it updates, also checks the files the
new commits changed and tries again, three times at most.

`push.via` hands the final push to the project's own command (like `npm run
ship`) instead.

After the push result it prints one line, like `6 finished changes are waiting
to land here, 4 clash with master.`: the branches the hourly lander would pick
up and how many of them conflict with the default branch. The lander's run
prints the same line. `atris worktree start` prints `12 changes are waiting to
land here. Clear those first.` only when the count is over the map's
`waiting_limit` (10 when unset). None of these lines blocks anything or
changes an exit code.

`atris check land <sha> --lane no-screen`, on a runner: fetch the staged ref,
run everything (skipping checks a receipt for the same code already passed),
fast-forward the default branch on green and delete the ref; on red leave the
ref and name what failed. Nothing reverts the default branch in v1.

## The hourly lander

For a project whose default branch has `atris/checks.json`, the lander
(`atris autoland`, `atris land --auto`) lands a change only with a receipt it
can work out again. In its scratch copy at the candidate's commit it reads
the receipt from `refs/atris/receipts/<sha>` or from the branch's own work
copy, then runs the same compare as `--verify`, with one difference: a check
that passed in some lane still counts as needing that lane.

- A refused receipt holds the change with the reason. Nothing lands on trust.
- High risk: the lander runs `atris check` itself, whatever the receipt says.
- No receipt (every branch from before receipts): the lander runs `atris
  check` itself, with the proof from the branch's commit `Proof:` line or its
  open task's `--verify`. It uses the receipt it just made. All of its checks
  in one run share `green_landing_check_seconds` (600). A change whose checks
  would not fit waits for the next run, untried.
- Its checks run with `ATRIS_CHECK_PERSON=1`: no-screen and paid checks never
  run from the lander. A change that needs them waits for a runner
  (`atris check land`). Needing a lane is never a pass.
- The usual 5 per run still holds; a run of the lander's own check counts.

A project without a map lands exactly as before. Off switch, one line:
`ATRIS_LAND_RECEIPTS=0` in the lander's environment, or
`"green_landing_receipts": false` in `.atris/policy/autoland.json`.

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
- Receipt refs: `atris check sweep` removes one once its commit has been on
  the default branch over 7 days. Any over 30 days old goes too (a receipt can
  be made again).
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

A big bug gets the strongest model: when the failed receipt is high risk, or
a changed file matches the map's optional `"big"` globs, the job goes with
`--think`, its task starts with "big bug" and one plain line goes to the
owner notice channel (`"owner_notice"`: `"feed"`, the default, or `"none"`).
A suggested `big` list: sign-in, payment, data loss and migrations, plus the
paths that keep the app from opening. This covers red checks only: live
production errors are not wired to `atris check fix` today.

The job runs with `ATRIS_RUNNER=atris check fix` and `ATRIS_FIX_RECEIPT`
(the receipt file). Its task names the receipt. When it ends, the
receipt gains `fix_job`: the exit code, the pull request link, the run id
and the job record (each one only when `computer pr` printed it).

v1: CodeOps fixes red. Next: the lane itself runs on the CodeOps computer,
once it can return a receipt and run the app with no screen.

## What the selectors do not see yet

- Tests that reach code only through a string the selector cannot read (a
  path built at run time, a plugin loaded by name).
- Python changed-line coverage for the proof.
- A hub's own callers: a change to a service imported by a router many tests
  mount runs the service's tests, not the router's. The release gate runs
  those for high risk.

## Next

- Warm slots: a small pool of headless work copies per repo, booted ahead.
  An agent leases one instead of making a work copy: patch, check in about a
  second, preview, push, reset.
- The train: several staged changes share one lane run, split in half on red.
- The check budget: a check retires when it has not caught a real break.
- Signed receipts: the lander could then trust a high risk receipt it did not
  write instead of running the checks again.
- Python changed-line coverage, when `coverage` is already installed.
