# Simultaneous AgentXP collection audit

Changed: replaced an untested concurrency hypothesis with a bounded real-process observation. The audit command exited 0: five rounds, zero observed invariant failures, each ending at 300 XP with verified integrity and exactly 300 receipts.

Task: VAS-9. Existing review: https://github.com/atrislabs/atris/pull/1488, open and unmerged. No runtime code, live acceptance state, or operator balance changed. This is validation evidence, not a second fix or a certification of the author's own patch.

## Reproduce

```sh
node atris/receipts/agentxp-concurrency-audit-2026-10-22.cjs
```

Exit 0. Exact output:

```json
{
  "rounds": 5,
  "failed_rounds": 0,
  "final": [
    { "round": 0, "xp": 300, "integrity": "verified", "receipts": 300 },
    { "round": 1, "xp": 300, "integrity": "verified", "receipts": 300 },
    { "round": 2, "xp": 300, "integrity": "verified", "receipts": 300 },
    { "round": 3, "xp": 300, "integrity": "verified", "receipts": 300 },
    { "round": 4, "xp": 300, "integrity": "verified", "receipts": 300 }
  ]
}
```

Whitespace aside, the values above are the complete command output. The adjacent JSON records actual CLI output excerpts, exit codes, unique receipt counts, and the observation timestamp.

Each round creates a separate temporary ledger with 300 distinctly identified copies of the existing sanitized accepted-job fixture, preserving its independent reviewer and proof. These are synthetic load copies of one real job, not evidence of 300 different live accepted jobs. Two Node processes launch the actual submitted CLI concurrently with an isolated home and database, followed by a third CLI read:

```sh
node bin/atris.js xp status --local --workspace <isolated-folder> --json
```

All fifteen CLI invocations exited 0. Each final read reported `agent_xp: 300` and `integrity.status: verified`; all five ledgers contained 300 unique receipts. Temporary folders are removed in a finally block. No test hooks, artificial waits, replacement filesystem calls, or runtime instrumentation are used.

```text
real accepted fixture -> 300 isolated copies -> two CLI readers
                                            -> third read: exact credit, valid chain
```

## Limits

Concurrent process launch does not establish that both collectors read the same receipt head before either writes. This is a stress observation, not a deterministic regression or proof of concurrent-writer safety. The audit returns success when it successfully measures the result, even if `failed_rounds` is positive; reviewers must inspect that field. Timeout, malformed receipt data, or launch errors fail the audit command.

No source changes are justified by this run. A stronger follow-up should exercise an accepted event arriving between two collections and verify saved balance and cursor consistency without weakening independent review. Removed-folder recovery also remains limited by missing historical evidence. Other-actor review is still required before merge.

Files: this receipt, adjacent `.cjs` and `.json`, `atris/MAP.md`, and `atris/team/validator/logs/2026-10-22.md`. The pre-existing generated `atris/TODO.md` modification is excluded from staging. No runtime routes or source line references changed. Rollback: revert the evidence-only commit.

Frozen check: `git diff --check`, exit 0, no output, run after writing the evidence and before commit.

next_push: Reproduce an accepted event arriving during simultaneous collection and check saved balance and cursor consistency.
layer: capabilities
