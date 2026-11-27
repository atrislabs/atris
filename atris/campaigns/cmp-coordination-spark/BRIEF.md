# Kaizen Spark

This workspace uses Kaizen Spark to test coordination. The daily run checks handoffs against receiver state and retains reproducible failures. The team roster selects an engine for each job. A claim that one engine is better for a job requires a separate comparison on the same tasks, followed by a repeat on fresh cases.

## Situation

Someone submits a checked result. A timeout makes it unclear whether the recipient got it. Retrying must recover the same outcome. If the person intentionally submits two messages, both must arrive. The initial incidents were duplicate local Element completions and duplicate Swarlo replies and reports. The November handoff already worked, and the managed backend already reserves its own task results.

## Playground

Use two isolated project copies, scratch databases, fake members and loopback HTTP. Exercise the same commands people use. The Element reviewer owns completion and verification. The Swarlo reviewer owns receipt identity, concurrency and restart. The Fleet reviewer grades the combined flow against receiver state. The lead checks integration and decides what to keep. Each assignment names one outcome, an allowed file area and the command that disproves success.

## Action

When a failed check needs investigation, assign the role before the engine. Scout locates the evidence. Replay Lead answers the specific question about what failed. Builder or Executor owns a code change, and the existing check verifies it. The [workspace roster](../../ROSTER.md) chooses the model for each role.

Start with the unchanged projects. Freeze the judge and record the failed cases. Fix the narrowest shared cause. Run the same cases on the candidate and use a different reviewer to challenge an untested boundary. Test durable behavior across process restarts. Count actual verifier invocations and receiver rows. Pass references and summaries between reviewers, keeping detailed logs at the evidence source.

## Reward and review

An extra effect, a changed request accepted under an old key, or a success status after a refused write is a false acceptance. A missing legitimate effect, including the second of two deliberate same-text messages, is a miss. A broken fixture is an evaluation error. Record each separately. Keep a candidate only when both kinds of mistakes fall to zero in the agreed cases, the existing checks still pass and the independent challenge passes. Require two new fixture runs for the final reading.

## Knowledge

Record the baseline, candidate, challenge, rejected hypotheses and limitations in RESULTS.md. A corrected belief needs a reproducible observation. A challenge that changes a fix becomes a regression for the next round. Keep fresh challenges separate from the cases used to build the fix. This is a deterministic software experiment and the case counts describe the tested population.

Run from the Atris CLI checkout with its sibling Swarlo checkout. Use SWARLO_ROOT when Swarlo lives elsewhere.

```sh
python3 -B atris/campaigns/cmp-coordination-spark/judge.py
```

For an actual handoff, use the completion command returned by `atris element claim`. It identifies the exact claim even if the same reviewer later takes the work again. Persist one intent key per destination before sending. Supply it to `swarlo reply`, `swarlo report` or `atris fleet done --global` with `--idempotency-key`. Retry with the same key and the same authenticated identity. Create a new key for a separate message, even if its text matches. An ordinary unkeyed Swarlo call expresses a new send.

If an Element verifier is interrupted and its outcome is unknown, inspect the original check before starting a new claim. An older Swarlo service refuses the keyed delivery at its new endpoint. Changing an operation to unkeyed after refusal would start a new send.

The campaign's additional delivery challenge drops the receiver's acknowledgement after the result has been saved, restarts Swarlo, and retries the same Fleet command.

```sh
python3 -B atris/campaigns/cmp-coordination-spark/challenge.py
```

## Continuing the loop

The standing coordination watch runs daily on the Mac. Each round reruns the fixed cases, the dropped acknowledgement challenge and the claim regressions. It then draws a fresh reproducible ordering of 24 calls, including repeated keys, identical text, two reviewers and two restarts. The oracle reads the final receiver rows and checks every intended author and receipt. The campaign stores each reading. A failed reading keeps its seed and queues one local investigation for Replay Lead. A healthy round spends no model credits.

Replay a seed printed by the standing campaign:

```sh
python3 -B atris/campaigns/cmp-coordination-spark/round.py --seed 20261126
```

Inspect the watch with `atris campaign show cmp-spark-coordination-watch`. Pausing this campaign makes its daily check skip work until resumed.

The watch grows its regression set from evidence. If the receiver stores the wrong message or loses an intended delivery, repeat the same operations against a fresh database. Two observations of the same violation save the full sequence, including the authors, payload, keys and restart positions. A failed setup or a mixed result opens an investigation without adding an unconfirmed belief. Future rounds replay up to three saved sequences before exploring a new one. They keep the sequence after repair so a later change can expose a regression.

The reviewer's command uses `--replay-case` and the saved sequence's identifier. This keeps the original experiment reproducible if the workload generator changes. The receiver's stored author, text and destination are checked independently of its acknowledgement.

The scheduled round also exercises a client and service that pass their own checks while disagreeing on the receipt format. A successful round must reject the incompatible pair and accept the corrected pair at the requested revisions. [Run a two-repository check](../cmp-spark-repo-contract/BRIEF.md)
