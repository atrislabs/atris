# Mission

<!-- Human-authored purpose file. Keep this durable; runtime state belongs in .atris/state/*.jsonl and now.md. -->

## North Star

Every sentence that reaches a human is plain, true, and something they can act on.

## Score

Accuracy of the voice gate (lib/voice-gate.js) on a labeled set of good and bad sentences. The set does not exist yet; seed it from test/voice-gate.test.js. Until then, `atris slop detect <path>` is pass or fail only.

## One Tick

Find one sentence the gate let through that a human would trip on, or one it blocked wrongly. Add it to the labeled set, then fix the gate or the copy.

## Stop

Stop when a change makes the gate stricter without catching a real bad sentence.
