# core-v1 benchmark pack

## what this is

`core-v1` is the fixed Atris benchmark pack used by `atris bench` and the daily keep/revert experiment loop. Each task is a deterministic Node spec that runs in a hermetic temp workspace and checks behavior through exit codes, files, state transitions, and parsed receipts.

## tasks

- `init-golden-path` - `atris init` creates the canonical workspace skeleton and `atris status` boots.
- `status-boot-panel-counts` - status panel counts match seeded task projection truth.
- `task-lifecycle-roundtrip` - task state moves through create, claim, review, accept, and show.
- `task-proof-gate` - weak or failing proof is rejected, executed proof is accepted.
- `mission-lifecycle` - mission start, tick, receipt, and complete stay parseable.
- `tick-prompt-contract` - mission tick prompt keeps the frozen verifier, pings, and layer receipt contract.
- `experiments-smoke-keep-revert` - the smoke pack keeps a good patch and byte-restores a bad one.
- `operator-ready-gating` - clean operator prose passes, agent jargon fails.
- `lesson-typed-roundtrip` - detector-backed lesson metadata resolves through CLI state.
- `help-no-workspace-safety` - help and read-only bench commands are safe outside an Atris workspace.

## flake policy

Runs are serial. Each task gets a hermetic environment with redirected `HOME`, `ATRIS_SKIP_UPDATE_CHECK`, and blank profile variables. The runner retries once only for infra-class failures such as `ETIMEDOUT`, `EAGAIN`, or spawn errors, never for assertion failures.

## keep rule

The daily loop keeps an experiment only when the candidate passed set is a superset of the baseline passed set and the experiment verify command, when declared, exits 0. Otherwise it restores byte-identical backups. `--keep-if all-pass` is the only override lane.

## how to run

Use `node bin/atris.js bench run --json` to run the pack and append a result. Use `node bin/atris.js bench results --last 5 --json` to inspect recent runs. Use `node bin/atris.js bench tasks --json` to list task metadata.

Use `node bin/atris.js experiments daily --json` to let the daily queue pick one experiment, run baseline and candidate benches, run the experiment verify command, then keep or revert by the fixed rule.
