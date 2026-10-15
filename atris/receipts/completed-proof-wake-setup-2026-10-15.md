# Completed-task proof wake setup

Completed-task proof wake setup now skips one program launch. The focused test and the required checks passed.

Files: test/commands.test.js, atris/MAP.md, atris/refs/MAP-NOTES.md.

Focused command: node --test --test-name-pattern='member wake reports proof for completed task evidence missing proof' test/commands.test.js
Output: tests 1, pass 1, fail 0; exit 0.

Metric: three program launches become two. Observed case time: 457.6825 ms before, 349.816209 ms after; timing is observational.

Learned: the production member scaffold keeps the completed-task proof wake decision, reason, task ref, and next command checks unchanged.

next_push: replace the proof-ready review wake test member setup launch with the production scaffold.

layer: capabilities
