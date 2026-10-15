---
name: auto-learned
description: Verified patterns crystallized from passing runs for executor. Bounded to 5 newest patterns so context never bloats.
---

# Auto-Learned Verified Patterns

- **2026-10-14 (capabilities)**: The scan of the real code now prints the file and line of each engine launch it traces, grouped by how the launch was traced. The required t -> Verify: `node --test test/engine-resource.test.js test/engine-dispatch.test.js` -> Next push: **Next:** next_push: compare the traced places against a saved list. Then a failure names the exact launch that went mis
- **2026-10-14 (capabilities)**: The scan of the real code now counts each engine launch by how the check traced it, and it fails if any of those counts drops. The required  -> Verify: `node --test test/engine-resource.test.js test/engine-dispatch.test.js` -> Next push: **Next:** next_push: name the file and line behind each real route count in the printed breakdown. A launch that drops o
- **2026-10-14 (capabilities)**: The launch check now reads an array written across several lines when the array is spread into a launch call. The required tests pass: 148 o -> Verify: `node --test test/engine-resource.test.js test/engine-dispatch.test.js` -> Next push: **Next:** next_push: have the scan of the real code report how many runner launches it traced through options or spreads
- **2026-10-14 (capabilities)**: The launch check now reads an options object written across several lines. The required tests pass: 148 of 148, exit 0. -> Verify: `node --test test/engine-resource.test.js test/engine-dispatch.test.js` -> Next push: **Next:** next_push: read multi-line array declarations the same way. A spread of an array written over several lines st
- **2026-10-14 (capabilities)**: The launch check now reads an options object that was put in a variable before the call. The required tests pass: 148 of 148, exit 0. -> Verify: `node --test test/engine-resource.test.js test/engine-dispatch.test.js` -> Next push: **Next:** next_push: read an options object declared across several lines. The declaration reader stops at the first lin
