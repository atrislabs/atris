# Save cards the main inbox lacks

Verdict on the proposed next push (keep any folder holding ignored files): stop. On this machine 141 of 150 work folders hold ignored files beyond run receipts, almost all state, caches and logs, so that rule would block put-away for about 94% of folders.

What the count did find: the cards file is ignored by git, so a card filed from inside a folder never reaches the main inbox and is destroyed with the folder. 24 folders held about 80 card titles the main inbox lacks (top: 16, 12, 9, 8).

What changed: before removing a folder, put-away saves every card whose title the main inbox lacks beside the other backups and names the file. If that save fails, the folder is kept and the kept line says why. The main inbox itself is not touched, so old cards do not flood it.

Red check: the new test run on the previous code removed the folder and its card.
```
landing cleanup done: 1 pieces cleared, 1 side copies removed
pass 0, fail 1
```

Real put-away command on a disposable repository, new code:
```
command: node bin/atris.js land --reap --no-remote --base master --ttl 0 (cards save blocked)
landing cleanup done: 0 pieces cleared, 0 side copies removed
  kept, needs a human: <tmp>/engine-wt (salvage incomplete: cards not in the main inbox could not be saved, kept to avoid losing work)
exit: 0
command: node bin/atris.js land --reap --no-remote --base master --ttl 0 (card filed in the folder)
landing cleanup done: 1 pieces cleared, 1 side copies removed
  cards not in your inbox saved: <tmp>/repo/.atris/salvage/2026-10-15/engine-wt.for-you.md (1)
exit: 0
```
The saved file holds only the card the main inbox lacked.

Wider put-away, auto-land and green landing tests: node --test test/land.test.js test/autoland.test.js test/land-green.test.js
pass 106, fail 0, exit=0

Frozen verifier: tests 99, pass 99, fail 0, todo 0; clean, no slop tells in 5 files; exit=0
