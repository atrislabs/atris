# Sweep apply closes runs lost with their parent

Running the sweep with apply now writes an end line with cause "parent gone" for each unfinished run whose parent process is gone, so the log stops listing it as open. The line carries no machine readings, since those would describe the sweep, not the moment the run was lost. A plain sweep still writes nothing.

- test first: the new test failed (no close line printed) before the change
- verifier: `node --test test/engine-resource.test.js test/engine-dispatch.test.js`, 78 pass, 0 fail, exit 0
- real run: one real parent got SIGKILL after recording a start, one stayed alive. Before: "2 runs started with no end recorded: 1 whose parent is gone, 1 still running". The sweep command code with apply printed "closed 1 run whose parent is gone", exit 0. After, the real `atris engine sweep`, exit 0: "1 run started with no end recorded: 1 still running".
- the apply step in the proof used an empty ssh-agent list so it would not stop the real leaked agents on this machine; the lost-run close ran against real processes

next_push: have the hourly landing pass close lost runs the same way it already stops leaked ssh-agents.
