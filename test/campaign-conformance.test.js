'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { diffPath, runJudge, writeManifest } = require('../scripts/campaign-conformance');

const JUDGE = path.resolve(__dirname, '..', 'scripts', 'campaign-conformance.js');

function tempDir(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-campaign-judge-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function fixtures(t) {
  const dir = tempDir(t);
  const view = { id: 'cmp-ship', state: 'resting', budget: { total: 1, spent: 0 } };
  fs.writeFileSync(path.join(dir, 'start.json'), JSON.stringify({ name: 'start', events: [], expected: view }));
  fs.writeFileSync(path.join(dir, 'refused.json'), JSON.stringify({ name: 'refused', events: [], expected: { error: 'no_start' } }));
  fs.writeFileSync(path.join(dir, 'decide-cases.json'), JSON.stringify({ cases: [{ view, expected: { action: 'run_judge' } }] }));
  writeManifest(dir);
  return { dir, view };
}

// A fake surface checkout whose runner prints a fixed answer.
function surface(t, output) {
  const repo = tempDir(t);
  fs.mkdirSync(path.join(repo, 'scripts'));
  const runner = path.join(repo, 'scripts', 'campaign-fold-runner');
  fs.writeFileSync(runner, `#!/bin/sh\ncat <<'JSON'\n${JSON.stringify(output)}\nJSON\n`);
  fs.chmodSync(runner, 0o755);
  return repo;
}

test('values compare by meaning: key order and 1 versus 1.0 do not matter', () => {
  assert.equal(diffPath(JSON.parse('{"a":1.0,"b":[1,{"c":null}]}'), { b: [1, { c: null }], a: 1 }), null);
  assert.equal(diffPath({ a: { b: 1 } }, { a: { b: 2 } }), '.a.b');
  assert.equal(diffPath({ a: [1] }, { a: [1, 2] }), '.a.length');
  assert.equal(diffPath({ a: null }, { a: 0 }), '.a');
});

test('a fold surface and a view surface that agree pass the judge', (t) => {
  const { dir, view } = fixtures(t);
  const fold = surface(t, { kind: 'fold', results: { start: view, refused: { error: 'no_start' } }, decide: [{ action: 'run_judge' }] });
  const screen = surface(t, { kind: 'view', results: { start: JSON.parse(JSON.stringify(view)) } });
  const report = runJudge({ fixtures: dir, only: ['cli', 'terrace'], overrides: { cli: fold, terrace: screen } });
  assert.equal(report.passed, true, JSON.stringify(report, null, 2));
  assert.deepEqual(report.surfaces.map((s) => s.status), ['pass', 'pass']);
});

test('a missing runner and a wrong answer both fail, naming where', (t) => {
  const { dir, view } = fixtures(t);
  const wrong = surface(t, { kind: 'fold', results: { start: { ...view, state: 'running' }, refused: { error: 'no_start' } }, decide: [{ action: 'propose' }] });
  const report = runJudge({ fixtures: dir, only: ['cli', 'backend'], overrides: { cli: wrong, backend: tempDir(t) } });
  assert.equal(report.passed, false);
  const [cli, backend] = report.surfaces;
  assert.equal(cli.status, 'mismatch');
  assert.deepEqual(cli.mismatches.map((m) => `${m.file} ${m.at}`), ['start .state', 'decide-cases[0] .action']);
  assert.equal(backend.status, 'not built');
});

test('an edited golden file stops the judge before any surface runs', (t) => {
  const { dir } = fixtures(t);
  fs.appendFileSync(path.join(dir, 'start.json'), ' ');
  const report = runJudge({ fixtures: dir, only: ['cli'], overrides: {} });
  assert.equal(report.passed, false);
  assert.deepEqual(report.manifest_problems, ['start.json changed since it was pinned']);
  assert.deepEqual(report.surfaces, []);
});

test('the command exits 1 on failure and prints plain lines', (t) => {
  const { dir } = fixtures(t);
  const run = spawnSync(process.execPath, [JUDGE, '--fixtures', dir, '--only', 'backend', '--surface', `backend=${tempDir(t)}`], { encoding: 'utf8' });
  assert.equal(run.status, 1);
  assert.match(run.stdout, /backend +not built/);
  assert.match(run.stdout, /judge fails/);
});

test('a runner that only echoes the answers cannot pass, and checking nothing is not a pass', (t) => {
  const { dir } = fixtures(t);
  const repo = tempDir(t);
  fs.mkdirSync(path.join(repo, 'scripts'));
  const runner = path.join(repo, 'scripts', 'campaign-fold-runner');
  fs.writeFileSync(runner, `#!${process.execPath}
const fs = require('fs'); const path = require('path'); const dir = process.argv[2];
const results = {}; let decide = [];
for (const f of fs.readdirSync(dir)) {
  const g = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  if (f === 'decide-cases.json') decide = g.cases.map((c) => c.expected); else results[g.name] = g.expected;
}
console.log(JSON.stringify({ kind: 'fold', results, decide }));
`);
  fs.chmodSync(runner, 0o755);
  const report = runJudge({ fixtures: dir, only: ['cli'], overrides: { cli: repo } });
  assert.equal(report.surfaces[0].status, 'mismatch');
  assert.throws(() => runJudge({ fixtures: dir, only: ['bogus'], overrides: {} }), /unknown surface/);
});
