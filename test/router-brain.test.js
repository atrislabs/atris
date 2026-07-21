'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  loadRouterHistory,
  computeEngineTaskStats,
  rankEngines,
} = require('../lib/router-brain');
const { resolveEngineForRole } = require('../lib/engine-registry');

const NOW = Date.parse('2026-07-21T12:00:00.000Z');

function makeRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-router-brain-'));
}

function cleanup(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

function writeTaskReceipt(root, name, row) {
  const dir = path.join(root, 'atris', 'runs');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}-task-result.json`), `${JSON.stringify(row)}\n`, 'utf8');
}

function writeMissionEvents(root, rows) {
  const file = path.join(root, '.atris', 'state', 'mission_events.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
}

function writeDispatchReceipt(root, name, results) {
  const dir = path.join(root, 'atris', 'runs');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `dispatch-${name}.json`), `${JSON.stringify({
    schema: 'atris.dispatch_receipt.v1',
    results,
  })}\n`, 'utf8');
}

function taskReceipt(engine, taskType, passed, durationMs, at) {
  return {
    schema: 'atris.task_receipt.v1',
    engine,
    task_type: taskType,
    at,
    result: { passed, duration_ms: durationMs },
  };
}

function missionEvent(engine, taskType, passed, durationMs, at) {
  return {
    schema: 'atris.mission_event.v1',
    type: 'mission_tick',
    at,
    payload: {
      engine_id: engine,
      task_type: taskType,
      duration_ms: durationMs,
      verifier_result: { passed },
    },
  };
}

function candidates() {
  return [
    { id: 'codex', fallback_order: 10 },
    { id: 'cursor', fallback_order: 30 },
  ];
}

test('scorer combines task receipts and mission events with pass rate, median duration, and recency', () => {
  const root = makeRoot();
  try {
    writeTaskReceipt(root, 'codex-old', taskReceipt(
      'codex', 'backend', true, 100, '2026-06-21T12:00:00.000Z',
    ));
    writeMissionEvents(root, [
      missionEvent('codex', 'backend', false, 300, '2026-07-21T12:00:00.000Z'),
      missionEvent('cursor', 'backend', false, 100, '2026-06-21T12:00:00.000Z'),
      missionEvent('cursor', 'backend', true, 300, '2026-07-21T12:00:00.000Z'),
    ]);

    const history = loadRouterHistory(root);
    assert.equal(history.length, 4);
    const stats = computeEngineTaskStats(history, { now: NOW });
    const codex = stats.find((row) => row.engine === 'codex' && row.task_type === 'backend');
    const cursor = stats.find((row) => row.engine === 'cursor' && row.task_type === 'backend');
    assert.equal(codex.receipt_count, 2);
    assert.equal(codex.verified_pass_rate, 0.5);
    assert.equal(codex.median_duration_ms, 200);
    assert.equal(cursor.verified_pass_rate, codex.verified_pass_rate);
    assert.equal(cursor.median_duration_ms, codex.median_duration_ms);
    assert.ok(cursor.recency_weighted_score > codex.recency_weighted_score);
  } finally {
    cleanup(root);
  }
});

test('dispatch receipt ingestion counts enriched entries and skips thin or malformed fixtures', () => {
  const root = makeRoot();
  try {
    writeDispatchReceipt(root, 'enriched', [{
      task: 'CLI-900',
      engine: 'cursor',
      task_type: 'executor',
      verified_passed: true,
      duration_ms: 1250,
      at: '2026-07-21T12:00:00.000Z',
      exitCode: 0,
    }]);
    writeDispatchReceipt(root, 'legacy-thin', [{
      task: 'CLI-899',
      engine: 'codex',
      exitCode: 0,
    }]);
    const runsDir = path.join(root, 'atris', 'runs');
    fs.writeFileSync(path.join(runsDir, 'dispatch-malformed.json'), '{not json\n', 'utf8');

    assert.deepEqual(loadRouterHistory(root), [{
      engine: 'cursor',
      task_type: 'executor',
      verified_passed: true,
      duration_ms: 1250,
      at_ms: NOW,
      source: 'atris/runs/dispatch-enriched.json#results[0]',
    }]);
  } finally {
    cleanup(root);
  }
});

test('data-rich history reorders ready candidates and fallback order breaks score ties', () => {
  const root = makeRoot();
  try {
    for (let index = 0; index < 3; index += 1) {
      writeTaskReceipt(root, `codex-${index}`, taskReceipt(
        'codex', 'executor', index === 0, 4000, `2026-07-${18 + index}T12:00:00.000Z`,
      ));
    }
    writeMissionEvents(root, [0, 1, 2].map((index) => missionEvent(
      'cursor', 'executor', true, 1000, `2026-07-${18 + index}T12:00:00.000Z`,
    )));

    assert.deepEqual(
      rankEngines(candidates(), { root, taskType: 'executor', now: NOW }).map((row) => row.id),
      ['cursor', 'codex'],
    );

    const tied = [];
    for (const engine of ['codex', 'cursor']) {
      for (let index = 0; index < 3; index += 1) {
        tied.push({
          engine,
          task_type: 'review',
          verified_passed: true,
          duration_ms: 500,
          at_ms: NOW - index,
        });
      }
    }
    assert.deepEqual(
      rankEngines(candidates(), { observations: tied, taskType: 'review', now: NOW }).map((row) => row.id),
      ['codex', 'cursor'],
    );
  } finally {
    cleanup(root);
  }
});

test('one thin engine makes the whole decision use legacy fallback order', () => {
  const root = makeRoot();
  try {
    for (let index = 0; index < 3; index += 1) {
      writeTaskReceipt(root, `codex-${index}`, taskReceipt(
        'codex', 'executor', false, 5000, `2026-07-${18 + index}T12:00:00.000Z`,
      ));
    }
    writeMissionEvents(root, [0, 1].map((index) => missionEvent(
      'cursor', 'executor', true, 100, `2026-07-${20 + index}T12:00:00.000Z`,
    )));
    assert.deepEqual(
      rankEngines(candidates(), { root, taskType: 'executor', now: NOW }).map((row) => row.id),
      ['codex', 'cursor'],
    );
  } finally {
    cleanup(root);
  }
});

test('missing and malformed history is ignored without changing legacy routing', () => {
  const root = makeRoot();
  try {
    assert.deepEqual(
      rankEngines(candidates(), { root, taskType: 'executor', now: NOW }).map((row) => row.id),
      ['codex', 'cursor'],
    );
    const runsDir = path.join(root, 'atris', 'runs');
    const eventsFile = path.join(root, '.atris', 'state', 'mission_events.jsonl');
    fs.mkdirSync(runsDir, { recursive: true });
    fs.mkdirSync(path.dirname(eventsFile), { recursive: true });
    fs.writeFileSync(path.join(runsDir, 'broken-task-receipt.json'), '{not json\n', 'utf8');
    fs.writeFileSync(eventsFile, '{bad line\n{"type":"mission_tick","payload":null}\n', 'utf8');
    assert.deepEqual(loadRouterHistory(root), []);
    assert.deepEqual(
      rankEngines(candidates(), { root, taskType: 'executor', now: NOW }).map((row) => row.id),
      ['codex', 'cursor'],
    );
  } finally {
    cleanup(root);
  }
});

test('role resolution uses rich history and explains exactly one lowercase pick only when enabled', () => {
  const root = makeRoot();
  const previousPath = process.env.PATH;
  const previousExplain = process.env.ATRIS_ROUTER_EXPLAIN;
  const previousError = console.error;
  try {
    const binDir = path.join(root, 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    for (const bin of ['codex', 'cursor-agent']) {
      const file = path.join(binDir, bin);
      fs.writeFileSync(file, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    }
    process.env.PATH = `${binDir}${path.delimiter}/bin${path.delimiter}/usr/bin`;
    for (let index = 0; index < 3; index += 1) {
      writeTaskReceipt(root, `codex-${index}`, taskReceipt(
        'codex', 'executor', false, 5000, `2026-07-${18 + index}T12:00:00.000Z`,
      ));
      writeTaskReceipt(root, `cursor-${index}`, taskReceipt(
        'cursor', 'executor', true, 500, `2026-07-${18 + index}T12:00:00.000Z`,
      ));
    }

    const lines = [];
    console.error = (line) => lines.push(String(line));
    delete process.env.ATRIS_ROUTER_EXPLAIN;
    assert.equal(resolveEngineForRole('executor', root).id, 'cursor');
    assert.deepEqual(lines, []);

    process.env.ATRIS_ROUTER_EXPLAIN = '1';
    assert.equal(resolveEngineForRole('executor', root).id, 'cursor');
    assert.equal(lines.length, 1);
    assert.equal(lines[0], lines[0].toLowerCase());
    assert.match(lines[0], /^router picked cursor because .*\.$/);
  } finally {
    console.error = previousError;
    process.env.PATH = previousPath;
    if (previousExplain === undefined) delete process.env.ATRIS_ROUTER_EXPLAIN;
    else process.env.ATRIS_ROUTER_EXPLAIN = previousExplain;
    cleanup(root);
  }
});
