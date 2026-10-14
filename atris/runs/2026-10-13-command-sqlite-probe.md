# Command test capability probe

Change: test/commands.test.js caches the real Node SQLite capability result lazily in its test process. The 111 database test guards, all assertions, and the child executable/environment stay intact. Both true and false results are cached. No production code changed.

Plan: measure -> cache -> rerun -> record.

Files: test/commands.test.js; atris/MAP.md; atris/refs/MAP-NOTES.md; atris/TODO.md (generated); atris/team/auto-improver/logs/2026-10-13.md; atris/status/for-you.md; this receipt. Task is held for review, never self-accepted.

Verify command: `node --test test/commands.test.js`
Frozen verifier: `git diff --check`

Focused command: `node --test --test-name-pattern '^task lineage$' test/commands.test.js`, three before and three after runs, all exit 0, pass 1 / fail 0. This reproduces the real database and CLI behavior. Logs follow below.

Capability measurement: extract hasNodeSqlite from the committed baseline and modified file, invoke it 112 times in each fresh closure, count spawnSync calls while forwarding them to the real runtime. Three repetitions with SQLite available and three with NODE_OPTIONS=--no-experimental-sqlite, which makes the real Node child reject SQLite. All capability results matched expectations. Measurement deliberately isolates probe overhead and is not a whole-file speedup claim. Full-file runs overlap and other work is active on this computer.

Available median: 2664.605ms -> 27.287ms, 99.0% less probe overhead. Unavailable median: 3422.836ms -> 30.880ms, 99.1% less probe overhead. Probes: 112 -> 1 in both cases.

```jsonl
{"version":"before","available":true,"round":1,"calls":112,"probes":112,"ms":2751.730666}
{"version":"before","available":true,"round":2,"calls":112,"probes":112,"ms":2664.604625}
{"version":"before","available":true,"round":3,"calls":112,"probes":112,"ms":2599.6895409999997}
{"version":"before","available":false,"round":1,"calls":112,"probes":112,"ms":2960.4320829999997}
{"version":"before","available":false,"round":2,"calls":112,"probes":112,"ms":3422.8363750000008}
{"version":"before","available":false,"round":3,"calls":112,"probes":112,"ms":3569.024375000001}
{"version":"after","available":true,"round":1,"calls":112,"probes":1,"ms":29.749707999999373}
{"version":"after","available":true,"round":2,"calls":112,"probes":1,"ms":27.287333000000217}
{"version":"after","available":true,"round":3,"calls":112,"probes":1,"ms":27.186250000002474}
{"version":"after","available":false,"round":1,"calls":112,"probes":1,"ms":30.88024999999834}
{"version":"after","available":false,"round":2,"calls":112,"probes":1,"ms":31.91912500000035}
{"version":"after","available":false,"round":3,"calls":112,"probes":1,"ms":27.726166999997076}
```

## Focused before 1, exit 0

```text
✔ task lineage (522.885125ms)
ℹ tests 1
ℹ suites 0
ℹ pass 1
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 634.730667
```

## Focused before 2, exit 0

```text
✔ task lineage (572.509458ms)
ℹ tests 1
ℹ suites 0
ℹ pass 1
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 715.404333
```

## Focused before 3, exit 0

```text
✔ task lineage (607.111875ms)
ℹ tests 1
ℹ suites 0
ℹ pass 1
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 711.270958
```

## Focused after 1, exit 0

```text
✔ task lineage (457.028416ms)
ℹ tests 1
ℹ suites 0
ℹ pass 1
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 547.089542
```

## Focused after 2, exit 0

```text
✔ task lineage (471.693833ms)
ℹ tests 1
ℹ suites 0
ℹ pass 1
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 565.361
```

## Focused after 3, exit 0

```text
✔ task lineage (491.8155ms)
ℹ tests 1
ℹ suites 0
ℹ pass 1
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 586.131125
```

## Full baseline, exit 0

Command: `node --test test/commands.test.js`

```text
✔ scoreEndgameCandidates returns fallback when scoring fails (137.608667ms)
✔ writeLesson appends a lesson line to existing lessons.md (0.727208ms)
✔ writeLesson creates lessons.md if it does not exist (0.474708ms)
✔ task lineage (443.977375ms)
ℹ tests 437
ℹ suites 0
ℹ pass 437
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 174188.836416
```

## Reproduce the isolated measurement

Run from this checkout. The baseline revision is the parent present before this change.

```sh
node - <<'JS'
const fs = require('node:fs');
const child = require('node:child_process');
const { performance } = require('node:perf_hooks');
const sources = {
  before: child.execFileSync('git', ['show', '37a8801a:test/commands.test.js'], { encoding: 'utf8' }),
  after: fs.readFileSync('test/commands.test.js', 'utf8'),
};
for (const [version, source] of Object.entries(sources)) {
  const body = source.match(/(?:let nodeSqliteAvailable;\n)?function hasNodeSqlite\(\) \{[\s\S]*?\n\}/)[0];
  for (const available of [true, false]) for (let round = 1; round <= 3; round++) {
    let probes = 0;
    const countedSpawn = (...args) => { probes++; return child.spawnSync(...args); };
    const runtime = { ...process, env: { ...process.env, ...(available ? {} : { NODE_OPTIONS: '--no-experimental-sqlite' }) } };
    const check = new Function('spawnSync', 'process', body + '\nreturn hasNodeSqlite;')(countedSpawn, runtime);
    const start = performance.now();
    for (let i = 0; i < 112; i++) if (check() !== available) throw Error('wrong capability result');
    if (probes !== (version === 'before' ? 112 : 1)) throw Error('unexpected probe count');
    console.log(JSON.stringify({ version, available, round, calls: 112, probes, ms: performance.now() - start }));
  }
}
JS
```

Measurement command exit: 0. Raw artifact: /tmp/atris-tick5-probe-benchmark.jsonl, reproduced above in full. Full-file logs: /tmp/atris-tick5-before-1.tap and /tmp/atris-tick5-after-1.tap. Focused logs: /tmp/atris-tick5-focused-{before,after}-{1,2,3}.log.

Boot/compile note: `atris brain activate --root . --verify` and `atris brain compile --root .` exited 2 with a plan-only response; no generated policy files were written. These are separate from the passing test and frozen checks.

## Full after, exit 0

Command: `node --test test/commands.test.js`

```text
✔ scoreEndgameCandidates returns fallback when scoring fails (122.255875ms)
✔ writeLesson appends a lesson line to existing lessons.md (0.911125ms)
✔ writeLesson creates lessons.md if it does not exist (0.567833ms)
✔ task lineage (372.595125ms)
ℹ tests 437
ℹ suites 0
ℹ pass 437
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 162044.249667
```

Whole-file observation: 174188.836ms before and 162044.250ms after, both pass 437 / fail 0, with no skipped checks. The 7.0% whole-file difference is noisy and not attributed entirely to this change. The repeatable isolated overhead reduction above is the causal metric.

Frozen check: `git diff --check`, exit 0, no output.

next_push: isolate the slow proof-command extraction test's repeated setup while preserving its real CLI parsing checks.
layer: capabilities
