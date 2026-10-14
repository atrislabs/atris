# Sweep says how fast leaked ssh-agents are growing

The sweep's leaked count line now carries the same growth note as the landing status: the oldest count an engine run start recorded in the last day, and about how many more leak each hour. Both views build the note from one shared piece of code, so they cannot drift apart. The sweep reads the run history once instead of twice.

- test first: the new test failed because the sweep printed only the live count
- verifier: `node --test test/engine-resource.test.js test/engine-dispatch.test.js`, 89 pass, 0 fail, exit 0
- real run on this machine, read only, in a scratch project whose log holds one start line carrying the 213 count this mission saw at 13:25 UTC:
  - `atris engine sweep`: "414 ssh-agents running, 382 look leaked, up from 213 at 2026-10-14 13:25 UTC, about 161 more an hour (no parent, older than 10 min, not in use by any live shell)", exit 0
  - `atris autoland status`: "leaked ssh-agents on this machine: 382, up from 213 at 2026-10-14 13:25 UTC, about 161 more an hour; stop them now: atris engine sweep --apply", exit 0
- map: refs below the moved lines shifted by the exact count; drift in files this slice did not touch left alone

next_push: write the leaked ssh-agent count onto each sweep line in the run log too, so a stop can be compared with the count right before it and the growth note can say what the last sweep cleared.
