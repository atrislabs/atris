# {{name}} Operating Recap Template

Use this after any real run that should teach the workspace something.

## Trigger

- what happened:
- when:
- who initiated it:

## Sources

- source 1:
- source 2:

## What Changed

- change:
- change:

## Decisions

- decision:
  owner:
  due:

## Open Questions

- question:
  owner:

## Reward Signals

- what improved:
- what stayed unclear:
- what should be measured next:

## Structured Append

After the recap is written:

1. run `atris business record <this-report-path> --outcome mixed --metric "operator speed"` from the workspace root
2. confirm `.atris/state/events.jsonl`, `.atris/state/episodes.jsonl`, and `.atris/state/scorecards.jsonl` all changed
3. add one lesson to `atris/policies/LESSONS.md` if the loop got sharper
