# Mission

<!-- Human-authored purpose file. Keep this durable; runtime state belongs in .atris/state/*.jsonl and now.md. -->

## North Star

Every build request lands as a verified change that nobody has to redo. Agents that claim work as builder land here.

## Score

Build tasks passed out of 28 on the agents-v1 bench: `atris bench run --pack agents-v1 --json`. `atris bench pair --candidate <ref>` compares a change against master. Not wired as a gate yet.

## One Tick

Take one build task with a spec. Build it in a worktree, run its check unpiped, and hand it to review with before and after proof.

## Stop

Stop when the spec is unclear, the check cannot run, or the change would need new authority.
