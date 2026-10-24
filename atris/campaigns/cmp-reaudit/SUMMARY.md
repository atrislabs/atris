# Re-audit of the 2026-10-23 swarm

Every test and writing fix the swarm landed on 2026-10-23 was checked again
the same night, against the code as it stood then, trusting nothing from the
run that made it.

## What was checked

| check | how | result |
|---|---|---|
| landed | every kept job's commit is an ancestor of master | 184 of 184 sprint, 587 of 587 PR day, 1,225 of 1,225 overnight jobs |
| overnight tests still catch their break | `cmp-overnight/reaudit.js`: put the one-line break back, test must pass on real code in two time zones and fail on the break | 1,016 of 1,017; the last one's line was rewritten after it landed, and breaking the new line by hand still fails it |
| earlier tests still pass | `cmp-thousand/reaudit.js`: empty environment, two time zones a day apart | 579 of 579 |
| earlier tests catch a break in their own function | up to 8 one-line breaks inside the named function | 332 caught one; 237 cover functions with no breakable line (help screens, constants); 10 caught none |
| writing fixes still clean | `atris slop detect` on every file the swarm rewrote | 136 of 139 clean; the other 3 were fixes the reviewers had already rejected and put back |
| tests leave nothing behind | each test run with a private temp folder, then counted | 507 of 1,596 left temp folders (32 percent; older tests: 17 of 146, 12 percent) |
| blind grade | `review.js` on a seeded sample of 90, graded by a different AI family than the writer | 63 keep, 22 weak, 5 remove |

## What was wrong and what changed

- 507 tests left temp folders. Each now loads `test/helpers/clean-temp.js`;
  505 leave nothing, the other 2 leave one reused folder made by Node or the
  product. All 1,017 overnight tests still catch their break after the change.
- One test pinned a bug as correct: `tailLines(text, 0)` returned every line
  (`slice(-0)`). Fixed in `commands/orb.js`; the test now expects no lines.
- One remove grade was the grader's mistake: `stepReferencedPaths` only treats
  tokens with a slash or dot as paths, on purpose.
- 20 of the 22 weak grades are tests that pin exact wording, so a harmless
  rewording fails them. Not changed: they are correct, and rewriting hundreds
  of tests risks losing the breaks they catch.
- The overnight check now refuses a test that leaves temp folders behind.

## Bug sweep: tests that lock in a bug

The sample showed that a test can catch breaks and still lock in a bug, so
all 579 earlier tests got one narrow question (`bug-pin-prompt.txt`): does any
assertion lock in a result a user or caller would not want?

| step | result |
|---|---|
| asked of every test, never by the engine that wrote it | 40 flagged of 579 |
| a third grader tried to refute each flag (`skeptic-prompt.txt`) | 21 confirmed, 19 refuted |
| one Codex worker per bug: corrected test first, then the smallest fix (`fix-lane.sh`) | 21 of 21 fixed |
| `verify-fix.sh`: corrected test fails on master, every test loading the changed module passes with the fix in two time zones | 21 of 21 |
| blind review of all 21 by Claude | ship, with two narrow issues |
| every test loading a changed module, on this Mac, two time zones | 178 of 178 files pass |

The two issues: the soul file count fell to 0 on one dead link (fixed), and
the task-title change would have changed saved task keys, so re-running
business onboarding could add a duplicate task (reverted; the test now says
why). Net: 20 product bugs fixed, about 3.5 percent of the earlier tests.

Ones that mattered: a singular `payment` tag slipped past the money lane
denial; `#needs_human` in a title was cut to `needs`, skipping the human
hold; the autoland cron line broke on a folder with a space; journal
rebuilds glued a section onto the next heading; calendar "today" meant the
next 24 hours.

## Found on the way, not from the swarm

The full suite on this Mac in the evening had 31 failures in 16 files. Most
came from the audit's own setup (a git override the product refuses, HOME
inside TMPDIR). Real ones, fixed:

- Four tests built today's date from UTC while the product now names files by
  the local day, so they failed every evening west of Greenwich and passed in
  CI, which runs on UTC.
- Two youtube notes tests could reach the real Gemini: node's folder (which
  holds claude, codex, and gemini on this Mac) was on PATH, and one kept the
  real home, where agy lives.
- The idea login test only passed when HOME was the real home.

The task board test failed about one run in five: the server drops idle
connections after five seconds and fetch reused a closing socket. Each
request now asks for a fresh connection; 15 of 15 runs pass.

`test/one-lap-runtime.test.js` is slow on this Mac (directory scans), the
same on untouched master, and passes in CI.
