# The board stays inside a pane narrower than 3 columns

A terminal pane dragged down to 1 or 2 columns made every board line print three dots, so each line wrapped. Shortened text now gets only the dots that fit: one dot in 1 column, two in 2. From 3 columns up nothing changes. The randomized size test now starts at 1 column instead of 3, so it covers this.

A throwaway probe drew random boards (wide-character names and jobs, live, failed, and finished rows, 0, 3, or 120 hidden older runs) at every width from 1 to 120 and seven heights. Before the fix, every overflow it found was at 1 or 2 columns. After the fix it found none.

Files edited: lib/member-board.js; test/member-board.test.js; atris/MAP.md and atris/refs/MAP-NOTES.md (36 refs into the board code moved down 2 lines); atris/team/builder/logs/2026-10-14.md; this receipt.

Real board command in a pseudo-terminal, `node bin/atris.js member board` with one failed and one working member:

```
before the fix, 2 columns: ['...', '...'] widest 3 exit 0
after,          1 columns: ['.', '.'] widest 1 exit 0
after,          2 columns: ['..', '..'] widest 2 exit 0
after,          3 columns: ['...', '...'] widest 3 exit 0
```

Teeth: `node --test --test-name-pattern="seeded random boards" test/member-board.test.js` failed on the old code (exit 1) at 1x2 with two lines of three dots, and passes on the new code (exit 0).

Verify command: `node --test test/member-board.test.js test/member-result.test.js`, run last, after every file was written and staged.

next_push: the randomized size test still measures lines in characters, not screen cells, and uses only plain names. Give it wide-character member names and jobs and measure by cells, as the probe did.
