'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const NOW = new Date('2026-06-15T12:00:00.000Z');

function withRecord(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-suggestion-count-'));
  const saved = new Map(Object.entries(process.env)
    .filter(([key]) => key === 'HOME' || key.startsWith('ATRIS_')));
  for (const key of saved.keys()) delete process.env[key];
  process.env.HOME = root;
  try {
    const { suggestionCount } = require('../lib/roster-suggest');
    const file = path.join(root, '.atris', 'state', 'roster_runs.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const write = (runs) => fs.writeFileSync(file, runs.map(JSON.stringify).join('\n') + '\n');
    fn({ root, write, suggestionCount });
  } finally {
    for (const key of Object.keys(process.env)) {
      if (key === 'HOME' || key.startsWith('ATRIS_')) delete process.env[key];
    }
    for (const [key, value] of saved) process.env[key] = value;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function job(name) {
  return {
    job: name,
    pick: true,
    workers: [{ engine: 'codex' }, { engine: 'claude' }, { engine: 'cursor' }],
  };
}

function runs(job, at = '2026-06-14T12:00:00.000Z') {
  return [
    ...['failed', 'stalled', 'failed'].map((outcome) => ({ job, at, engine: 'codex', outcome })),
    ...['claude', 'cursor'].flatMap((engine) => [
      { job, at, engine, outcome: 'landed' },
      { job, at, engine, outcome: 'landed' },
    ]),
  ];
}

test('counts qualifying jobs once even when multiple challengers qualify', () => {
  withRecord(({ root, write, suggestionCount }) => {
    write([...runs('build'), ...runs('review')]);
    const jobs = [job('build'), job('review'), job('search')];
    const before = JSON.stringify(jobs);
    assert.strictEqual(suggestionCount(jobs, root, { now: NOW }), 2);
    assert.strictEqual(JSON.stringify(jobs), before);
  });
});

test('includes the seven-day boundary and excludes records just before it', () => {
  withRecord(({ root, write, suggestionCount }) => {
    write(runs('build', '2026-06-08T12:00:00.000Z'));
    assert.strictEqual(suggestionCount([job('build')], root, { now: NOW }), 1);
    write(runs('build', '2026-06-08T11:59:59.999Z'));
    assert.strictEqual(suggestionCount([job('build')], root, { now: NOW }), 0);
  });
});

test('does not suggest skipped challengers or a lead with too few judged runs', () => {
  withRecord(({ root, write, suggestionCount }) => {
    write(runs('build'));
    const row = job('build');
    row.workers.slice(1).forEach((worker) => { worker.status = 'skipped'; });
    assert.strictEqual(suggestionCount([row], root, { now: NOW }), 0);
    const record = runs('build');
    record[0].outcome = 'credit out';
    write(record);
    assert.strictEqual(suggestionCount([job('build')], root, { now: NOW }), 0);
  });
});

test('returns zero for missing history, empty jobs, and invalid jobs input', () => {
  withRecord(({ root, write, suggestionCount }) => {
    assert.strictEqual(suggestionCount([job('build')], root, { now: NOW }), 0);
    write(runs('build'));
    assert.strictEqual(suggestionCount([], root, { now: NOW }), 0);
    assert.strictEqual(suggestionCount(null, root, { now: NOW }), 0);
    assert.strictEqual(suggestionCount({}, root, { now: NOW }), 0);
  });
});
