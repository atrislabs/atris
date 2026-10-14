# Faster task lineage check setup

The check that task lineage shows a parent before its child now launches two fewer commands, five down to three; the changed test and all 35 required checks passed, exit 0.

Files: `test/commands.test.js`, `atris/MAP.md`, `atris/refs/MAP-NOTES.md`, `atris/team/auto-improver/logs/2026-10-14.md`, and this receipt.

Plan: real-store parent and linked child creation -> unchanged CLI text, JSON and no-git lineage reads -> link removal probe -> required checks -> review.

Creating a task with a parent link only stores the parent id on the child, so the in-process seed writes that same link. A throwaway copy of the test with the link removed failed, which shows the lineage reads still depend on it. The copy was deleted.

Metric: five CLI launches become three, a 40% reduction. One observed run of the changed test took 658.240083 ms; there is no matched before timing, so no speed claim beyond the launch count.

Commands run:
- `node --test --test-name-pattern='^task lineage$' test/commands.test.js`, exit 0.
- Probe copy without the link: `✖ task lineage`, pass 0, fail 1; copy removed.
- `node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js`, exit 0, run without a pipe.

Changed-surface output:
```
✔ task lineage (658.240083ms)
ℹ tests 1
ℹ pass 1
ℹ fail 0
```

Required-check output excerpt:
```
ℹ tests 35
ℹ pass 35
ℹ fail 0
```

next_push: In the test where task status treats reviewed failures as closed, create the task in process and keep the claim, failed finish and status read on the CLI.

layer: capabilities
