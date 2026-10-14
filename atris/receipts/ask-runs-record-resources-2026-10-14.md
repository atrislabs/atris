# Read-only ask runs record machine memory and load

Asking an engine a read-only question now writes a start and an end reading to the same run log a dispatch writes: free memory, swap, load, the leaked ssh-agent count at start, and on the end line the signal, whether the ask passed its time limit, and how long it ran. Before this, only dispatches were recorded, so a force-killed ask left nothing behind and the landing status and sweep could not count it.

- test first: the new test failed because a real ask with a stand-in engine wrote no run log
- verifier: `node --test test/engine-resource.test.js test/engine-dispatch.test.js`, 91 pass, 0 fail, exit 0
- ask tests: `node --test test/ask-and-fleet-json.test.js test/engine-ask.test.js test/engine-validate.test.js`, 37 pass, exit 0
- real run on this machine in a scratch project: `atris engine ask "Reply with only the word ready." --engine haiku --timeout 120` answered, exit 0, and the run log held one start and one end with the same run id: 76% memory free, load 8.92, 405 leaked ssh-agents at start, 4065 ms
- cost: each ask now reads the machine twice, the same reads a dispatch already pays

next_push: record start and end readings for member and mission tick runs too, the last engine runs that still leave no trace when killed.
