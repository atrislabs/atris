# Landing status says how fast leaked ssh-agents are growing

The leaked ssh-agent line in the landing status now compares the live count with the oldest count an engine run start recorded in the last day. When the pile grew, it adds when that reading was taken and about how many more leak each hour. When the count held or fell, or no reading is younger than a day, the line stays as it was.

- test first: the new test failed because the line printed only the live count
- verifier: `node --test test/engine-resource.test.js test/engine-dispatch.test.js`, 88 pass, 0 fail, exit 0
- real run on this machine in a scratch project whose log holds one start line carrying the 213 count this mission saw at 13:25 UTC: the real `atris autoland status` printed "leaked ssh-agents on this machine: 373, up from 213 at 2026-10-14 13:25 UTC, about 164 more an hour; stop them now: atris engine sweep --apply", exit 0
- the main checkout has no run log yet, so the real status there shows the count alone until engine runs start writing readings
- map: refs below the new lines moved by the exact count added; older drift left alone

next_push: have `atris engine sweep` print the same growth note from the same reading, so the sweep and the landing status agree.
