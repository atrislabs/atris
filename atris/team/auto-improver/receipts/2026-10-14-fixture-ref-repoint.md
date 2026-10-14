The setup notes for sped-up tests now point at the tests they describe: 55 of 57 land on their test line, up from 19. The frozen checks passed 35 of 35, exit 0.

Files edited: atris/refs/MAP-NOTES.md; atris/team/auto-improver/logs/2026-10-14.md; atris/team/auto-improver/receipts/2026-10-14-fixture-ref-repoint.md.

Rerunnable verification command:
`node -e 'const fs=require("fs");const c=fs.readFileSync("test/commands.test.js","utf8").split("\n");let ok=0,n=0;fs.readFileSync("atris/refs/MAP-NOTES.md","utf8").split("\n").forEach((l,i)=>{if(i<2299)return;const m=l.match(/test\/commands\.test\.js:(\d+)/);if(!m)return;n++;if(/^test\(|^function /.test(c[m[1]-1]))ok++;});console.log(ok,"of",n)' && node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js`

Ran bare, exit 0. Actual output excerpt:
```text
before: 19 of 57
fixture notes with main ref on a test or helper start: 55 other: N2507:8568 N2511:8722
frozen_exit=0
ℹ tests 35
ℹ pass 35
ℹ fail 0
```

Method: each drifted note was matched by name to the test it describes. Its main ref moved to that test's first line, and its other refs moved by the same amount. A script refused any main ref that did not land on a test start and any other ref that fell outside that test. The drift came in steady bands (12, 18, 35, 52, 69, 85, 118, 250 and 304 lines), which confirms each note slid as a block. One creation ref landed on a file write and was moved two lines down to the seed comment by hand. The two remaining notes already point at seed lines inside the right test on purpose.

Metric: 37 notes and 68 refs repointed; fixture notes whose main ref names the right line went from 19 of 57 to 55 of 57.

Commands and artifacts: atris atris.md; a ref audit that maps each ref to its enclosing test; the repoint script; atris doc-health (exit 0); atris slop detect atris/refs/MAP-NOTES.md (clean); frozen verifier; task new/claim/ready.

Lesson: doc-health never checks test refs, so every launch cut that adds lines silently drifts every note below it. An audit that maps each test ref to its enclosing test catches this in one pass.

next_push: Add a test ref check to doc-health that flags a note whose main test ref does not land on a test start, so drift is caught the tick it happens.
layer: beliefs
