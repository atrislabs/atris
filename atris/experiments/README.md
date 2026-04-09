# experiments

Karpathy-style experiment framework for Atris workspaces.

This folder defines the schema, validation rules, and benchmark harness for self-improvement loops.
Live experiment packs belong directly inside `atris/experiments/`.

## What This Is

An experiment is not "the agent rewrote its prompt and said it improved."

An experiment is:

1. one bounded target
2. one external metric
3. one keep/revert loop
4. one append-only log

If the metric goes up, keep the change.
If it does not, revert it.

## Schema

```text
atris/experiments/
├── README.md
├── validate.py
├── benchmark_validate.py
├── benchmark_runtime.py
├── _template/           # packaged scaffolds
├── _examples/           # packaged smoke examples
├── _fixtures/           # validator benchmark cases
└── <experiment-slug>/
    ├── program.md
    ├── measure.py
    ├── loop.py
    ├── results.tsv
    ├── reset.py            # preferred
    ├── proposals/          # optional
    └── <bounded-target>    # candidate.py, system_prompt.txt, etc.
```

## Rules

1. One bounded mutation target per experiment.
2. `measure.py` must use an external metric the agent cannot fake.
3. `loop.py` must keep only improvements and revert regressions.
4. `program.md` stays short and task-specific.
5. `results.tsv` stays append-only.

## Repo Contents

- `_template/pack/` - starter files for a new experiment
- `validate.py` - structural and bloat checks
- `benchmark_validate.py` - validator benchmark on fixed good/bad fixtures
- `benchmark_runtime.py` - runtime benchmark on packaged example packs
- `_examples/` - tiny reference implementation

## Example

Start with the smallest honest pack:

```text
_examples/smoke-keep-revert/
├── candidate.py
├── measure.py
├── loop.py
├── reset.py
├── results.tsv
└── proposals/
    ├── bad_patch.py
    └── fix_patch.py
```

What it does:

- `candidate.py` starts broken on purpose
- `measure.py` scores it on a fixed word-count test
- `bad_patch.py` makes it worse
- `fix_patch.py` actually fixes it
- `loop.py` keeps only the fix

Run it:

```bash
python _examples/smoke-keep-revert/reset.py
python _examples/smoke-keep-revert/loop.py \
  --proposal _examples/smoke-keep-revert/proposals/bad_patch.py \
  --proposal _examples/smoke-keep-revert/proposals/fix_patch.py
```

Visual:

```text
broken target
   ↓
score = 0.2
   ↓
bad patch
   ↓
score = 0.0
   ↓
REVERT
   ↓
good patch
   ↓
score = 1.0
   ↓
KEEP
```

## Commands

```bash
python validate.py .
python benchmark_validate.py
python benchmark_runtime.py
```

## Public Benchmark Flow

The checked-in benchmark packs live at:

- `atris/experiments/endstate-baseline/`
- `atris/experiments/endstate-stack/`

Validate and dry-run them from the repo root:

```bash
node bin/atris.js experiments validate endstate-baseline
node bin/atris.js experiments validate endstate-stack
node bin/atris.js experiments run endstate-baseline --dry-run
node bin/atris.js experiments run endstate-stack --dry-run
node bin/atris.js experiments compare endstate
```

Or run the same rehearsal in one step:

```bash
node bin/atris.js experiments replay endstate
```

The contract is `atris/features/endstate/contract.md`.
The validation log is `atris/features/endstate/validate.md`.
Each dry run writes a receipt JSON under that pack's `artifacts/` directory and
appends one score row to `results.tsv`.
The compare command reads the latest receipt from each pack and prints the
current decision using the Level 1 win rule.
The replay command runs validate, both dry runs, and compare in sequence.
