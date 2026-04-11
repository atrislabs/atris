# {{name}} Reward Policy

Reward what makes the research loop sharper, reproducible, and more useful.

## Local Reward

- `+2` workspace boot and `atris verify` stay clean
- `+3` a new experiment or eval is pinned and reproducible
- `+4` a finding changes the next decision or rules out a path
- `+5` the tracked eval metric improves on a held-out or replayable check
- `-3` stale or unsourced numbers
- `-4` benchmark leakage, cherry-picking, or unpinned runs
- `-5` extra docs with no research use

## Learning Rule

After each meaningful run:

1. log the episode in today's journal
2. add one lesson to `atris/policies/LESSONS.md` if the system got sharper
3. keep the docs short enough that a researcher could skim them
