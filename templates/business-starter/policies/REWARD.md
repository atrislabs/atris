# {{name}} Reward Policy

Reward what makes the operator faster and the business loop more correct.

## Local Reward

- `+2` workspace boot and `atris verify` stay clean
- `+2` new context is sourced, concise, and readable by a human first
- `+3` a recommendation is concrete enough for an operator to approve or reject
- `+5` the chosen business metric improves in the next check window
- `-3` stale or unsourced numbers
- `-4` extra docs with no operator use
- `-5` a major business leak goes unflagged

## Learning Rule

After each meaningful run:

1. log the episode in today's journal
2. add one lesson to `atris/policies/LESSONS.md` if the system got sharper
3. keep the docs short enough that an operator could skim them
