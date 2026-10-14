Fifteen test line ranges in the map notes ran backwards and pointed at the wrong tests; each now starts on the test its sentence names, the docs check exited 0 and the 35 required checks passed, exit 0.

Files edited: atris/refs/MAP-NOTES.md; atris/team/auto-improver/logs/2026-10-14.md; atris/team/auto-improver/receipts/2026-10-14-backwards-test-ranges.md.

Rerunnable verification command:
`node -e 'const n=require("fs").readFileSync("atris/refs/MAP-NOTES.md","utf8");let b=0;for(const m of n.matchAll(/:(\d+)-(\d+)/g))if(+m[2]<+m[1])b++;console.log("backwards",b);process.exit(b?1:0)' && node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js`

Ran bare, exit 0. Actual output excerpt:
```text
747 | test('brain --help prints usage without workspace state', () => { | end: });
958 | test('clean --json reports missing atris folder without text chrome', () => { | end: });
1479 | test('search help flags print usage without workspace state', () => { | end: });
1629 | test('account and integrations --help print usage without session side effects', () = | end: });
backwards ranges left: 0
doc-health exit=0
verifier exit=0
ℹ tests 35
ℹ pass 35
ℹ fail 0
```

Metric: backwards test ranges in the map notes went from 15 to 0. Last tick counted ten; a line limit on the listing hid five.

How each one was matched: the sentence names a command (brain, serve, brainstorm, clean, loop, verify, analytics, auth and account, setup, upgrade, help cache writes, activate, search, soul, integrations), and the new range covers the help test for that command from its first line to its closing line. The clean note covers three tests in a row, and the auth note covers the auth test plus the account test, because those sentences describe both.

Why the docs check missed them: a line ref with no named code beside it only gets a bounds check, so a range whose end comes before its start counts as fine. The current fixer keeps a range's width when it moves one, so these likely broke under an older version or a hand shift.

Commands and artifacts: atris mission status; git status; listing every test with its first and last line; a repoint script that refuses to edit a line unless the old range is on it; a Node check printing the test name at each new start; atris doc-health (exit 0); atris slop detect on the notes (clean); frozen verifier.

next_push: Make the docs check flag any line range whose end comes before its start, with a test, so a broken range fails the check instead of passing silently.
layer: beliefs
