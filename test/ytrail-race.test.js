'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  runRace,
  parseEvalLine,
} = require('../scripts/det/ytrail-race');

function evalLine({ engine, seconds, pass, quotesVerified, quotesTotal }) {
  return `ytrail ${pass ? 'pass' : 'fail'} ${engine} ${seconds}s words=1200 quotes=${quotesVerified}/${quotesTotal} heading=yes`;
}

function stubFromRows(rows) {
  const byEngine = new Map(rows.map((row) => [row.engine, row]));
  const calls = [];
  const runner = ({ engine }) => {
    calls.push(engine);
    const row = byEngine.get(engine);
    if (!row) throw new Error(`unexpected engine ${engine}`);
    if (row.crash) throw new Error(`crash ${engine}`);
    if (row.timedOut) return { timedOut: true, stdout: '' };
    return { stdout: evalLine(row), status: row.pass ? 0 : 1 };
  };
  return { runner, calls };
}

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ytrail-race-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function latestPath(root) {
  return path.join(root, 'atris', 'benchmarks', 'ytrail-race-latest.json');
}

test('parseEvalLine reads the graded stdout contract', () => {
  const parsed = parseEvalLine('ytrail pass grok 8.1s words=2100 quotes=4/6 heading=yes');
  assert.deepEqual(parsed, {
    engine: 'grok',
    seconds: 8.1,
    pass: true,
    quotesVerified: 4,
    quotesTotal: 6,
  });
});

test('winner is the fastest passing engine; failed engines are excluded', (t) => {
  const root = tempRoot(t);
  const logs = [];
  const { runner, calls } = stubFromRows([
    { engine: 'haiku', seconds: 12.4, pass: true, quotesVerified: 4, quotesTotal: 6 },
    { engine: 'grok', seconds: 8.1, pass: true, quotesVerified: 3, quotesTotal: 4 },
    { engine: 'cursor', seconds: 5.0, pass: false, quotesVerified: 1, quotesTotal: 2 },
  ]);

  const report = runRace({
    url: 'https://www.youtube.com/watch?v=Z3JyAqh4ixg',
    engines: ['haiku', 'grok', 'cursor'],
    runner,
    root,
    ts: '2026-08-15T18:00:00.000Z',
    log: (line) => logs.push(line),
  });

  assert.deepEqual(calls, ['haiku', 'grok', 'cursor']);
  assert.equal(report.exitCode, 0);
  assert.equal(report.winner.engine, 'grok');
  assert.equal(report.winner.seconds, 8.1);
  assert.equal(report.winner.quotesVerified, 3);
  assert.equal(report.winner.quotesTotal, 4);
  assert.equal(report.results[2].pass, false);
  assert.match(logs.join('\n'), /race winner: grok \(8\.1s, quotes 3\/4\)/);

  const latest = JSON.parse(fs.readFileSync(latestPath(root), 'utf8'));
  assert.equal(latest.ts, '2026-08-15T18:00:00.000Z');
  assert.equal(latest.url, 'https://www.youtube.com/watch?v=Z3JyAqh4ixg');
  assert.equal(latest.results.length, 3);
  assert.equal(latest.winner.engine, 'grok');
});

test('all-fail exits 1 and still writes latest.json', (t) => {
  const root = tempRoot(t);
  const { runner } = stubFromRows([
    { engine: 'haiku', seconds: 11, pass: false, quotesVerified: 0, quotesTotal: 2 },
    { engine: 'grok', seconds: 9, pass: false, quotesVerified: 1, quotesTotal: 3 },
  ]);

  const report = runRace({
    engines: ['haiku', 'grok'],
    runner,
    root,
    ts: '2026-08-15T18:01:00.000Z',
    log: () => {},
  });

  assert.equal(report.exitCode, 1);
  assert.equal(report.winner, null);

  const latest = JSON.parse(fs.readFileSync(latestPath(root), 'utf8'));
  assert.equal(latest.winner, null);
  assert.equal(latest.results.every((row) => row.pass === false), true);
});

test('timed-out or crashed engines record fail and the race continues', (t) => {
  const root = tempRoot(t);
  const { runner, calls } = stubFromRows([
    { engine: 'haiku', timedOut: true },
    { engine: 'grok', crash: true },
    { engine: 'cursor', seconds: 14.2, pass: true, quotesVerified: 5, quotesTotal: 5 },
  ]);

  const report = runRace({
    engines: ['haiku', 'grok', 'cursor'],
    runner,
    root,
    timeoutMs: 300000,
    log: () => {},
  });

  assert.deepEqual(calls, ['haiku', 'grok', 'cursor']);
  assert.equal(report.exitCode, 0);
  assert.equal(report.results[0].pass, false);
  assert.equal(report.results[0].seconds, 300);
  assert.equal(report.results[1].pass, false);
  assert.equal(report.winner.engine, 'cursor');
});
