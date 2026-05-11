# STEERING — opus-overnight

<!-- Operator drops one-line directives here while the autonomous loop runs.
     Each tick reads this file FIRST, applies any unapplied directive as
     bias for that tick's artifact choice, then moves it to ## Applied. -->

## Pending

<!-- Drop one-line directives below. Format: `- YYYY-MM-DD: <directive>`.
     Examples and usage live in rl-exp2/notes/operator-steering.md.
     Do NOT put examples here — every `- ` line under `## Pending` is read
     as a real directive on the next tick. -->

## Applied

<!-- Tick log. Format: `- tick N (YYYY-MM-DD): <directive> → <how applied>` -->

## How this works

1. Operator opens this file any time, drops a one-line directive under `## Pending`.
2. Next mission tick reads STEERING.md FIRST, before picking the artifact.
3. If a pending directive exists: apply it as bias for that tick's choice. Then move the line to `## Applied` with the tick number and a short note on how it was applied.
4. If no pending directives: tick proceeds normally (mission domains in order from MISSION.md).

## Why

The autonomous loop runs without the operator present. They can't redirect mid-tick by talking. STEERING.md is a zero-friction asynchronous channel: drop a line, walk away, the next tick respects it. No CLI, no skill invocation, no halt.

This is the lightest layer of the four-tier feedback design:
- **Layer 1 (this file):** taste tweaks, one-line drops
- **Layer 2:** `atris brain edit <tick> "..."` — thumbs-up/down on past ticks
- **Layer 3:** `atris mission steer <id> --note "..."` — directives attached to mission state (not yet implemented)
- **Layer 4:** edit MISSION.md / MEMBER.md — durable contract changes

Use the lightest tier that fits. Most steering belongs in Layer 1.
