# agents-v1

a 25-task benchmark for coding agents. every task runs in a hermetic temp
workspace, one attempt per task per engine, checked by a deterministic
`check.js` (exit codes, files, hashes, git state) instead of prose matching.
the subject under test is the agent, not atris.

## what this measures

the tasks look like coding exercises, but they are chosen to isolate five
kinds of knowledge work that show up in any agent doing real production
work, not just toy problems:

- **comprehension under ambiguity** (navigate) - can the agent read
  unfamiliar code and answer a precise question about it, without being
  told where to look.
- **faithful bounded execution** (edit) - can the agent make exactly the
  change asked for and prove it with the fixture's own tests, without
  drifting into unrelated cleanup.
- **constraint-following and knowing when to stop** (contract) - this is
  the separator. every task in this category states a constraint in plain
  english (do not commit, only touch this file, leave this bug alone). the
  check verifies the constraint was honored, not just that the bug is
  fixed. agents that "helpfully" ignore instructions fail here even when
  their code is correct.
- **building to spec** (build) - can the agent add a small feature from a
  written spec and get the behavior right on the first try.
- **diagnosis under broken state** (recover) - can the agent find and
  repair a broken workspace (merge conflicts, syntax errors, bad imports,
  a bad commit, a flaky test) without being told what's wrong.

a company running this on their agent is buying a yardstick for knowledge
work, not a coding quiz.

## the 25 tasks

### navigate - read code, answer a precise question

1. `count-cli-commands` - count the reachable CLI command registrations
2. `find-the-bug-line` - find the off-by-one bug line
3. `config-precedence` - trace which of three config sources wins at runtime
4. `dead-code-hunt` - name the unused export among near-identical decoys
5. `import-chain` - find which entry module transitively imports the target

### edit - bounded change, proven by the fixture's own tests

6. `fix-failing-test` - fix a failing node:test without editing the test
7. `rename-symbol` - rename a function across source and tests
8. `off-by-one-repair` - repair an off-by-one pagination bug
9. `null-guard` - guard a crash on heading-less input
10. `format-change` - change an output format and update the one legit test

### contract - negative-space compliance, the separator

11. `no-commit-rule` - fix a bug without committing
12. `one-file-only` - fix a bug in exactly one allowed file
13. `receipt-format` - fix a bug and produce a structured receipt
14. `deny-list` - fix a bug without editing the forbidden module
15. `stop-at-boundary` - fix the in-scope bug and leave the out-of-scope bug alone

### build - small feature, checked by running the result

16. `add-json-flag` - add a JSON output flag to a toy CLI
17. `wire-subcommand` - wire a stats subcommand into a toy CLI
18. `implement-from-test` - implement behavior to satisfy a provided failing test
19. `input-validation` - reject invalid CLI input with exit code 2
20. `tiny-parser` - parse a tiny key=value format

### recover - repair a broken workspace

21. `merge-conflict` - resolve a real merge conflict
22. `syntax-triage` - repair three syntax errors across a small VM
23. `broken-imports` - repair broken and circular import paths in a CSV splitter
24. `revert-bad-change` - recover from a bad HEAD commit
25. `flaky-quarantine` - quarantine a Date.now flake without changing the assertion

## the honesty rule

every task must clear two bars before it counts as part of the pack:

1. run the task with `engine=null` (the agent does nothing) - the check
   must FAIL. there are no free passes.
2. run the task with `engine=solution` (the task's own reference fix,
   `solution.sh`) - the check must PASS. every task is solvable.

`test/bench-agents.test.js` enforces this over every task in the pack and
must stay green in CI. it uses no real engine, so it never depends on an
API key or a rate limit.

## running an engine sweep

run every task against one engine:

```
atris bench run --pack agents-v1 --engine codex
atris bench run --pack agents-v1 --engine cursor
atris bench run --pack agents-v1 --engine claude
atris bench run --pack agents-v1 --engine atris-fast
```

run a subset while iterating on the pack itself:

```
atris bench run --pack agents-v1 --engine claude --task find-the-bug-line --task merge-conflict
```

`--engine null` and `--engine solution` are the harness self-check engines,
not agents under test. an engine that is not installed skips every task
symmetrically (`skipped: true`) instead of failing the run.

every run appends one record to `.atris/state/bench/results.jsonl`
(`schema: atris.bench.run.v1`), tagged with `pack` and `engine`. nothing
is overwritten, so a sweep across engines and days accumulates in one file.

## reading the report

```
atris bench report --pack agents-v1
atris bench report --pack agents-v1 --json
```

the report reads `results.jsonl`, groups records by engine, and keeps each
engine's latest full run (a run over all 25 tasks). if an engine never
completed a full run, partial runs are merged instead, with the most
recent result winning per task id. this is the artifact shown to a company
after running their agent: N/25 passed, a passed count per category, mean
task duration, and the failed task ids by name.

## calibration

before showing a score to anyone, the pack itself should be sanity-checked:
run two independent sessions of a known-strong agent over all 25 tasks. if
both pass everything in under 30 seconds, the task is too easy and should
be tightened. if both fail, read the transcripts - a failure caused by an
ambiguous prompt means the task is wrong, not the agent. a split
pass/fail is the target: it means the task actually discriminates.
across the full 25, a frontier agent should land 70-90 percent and a weak
agent under 50. if every engine clusters within a couple of points, the
pack needs harder contract/recover items, not a different scoring method.
