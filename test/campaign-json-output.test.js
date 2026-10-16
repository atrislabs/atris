'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createSqliteStore } = require('../lib/campaign-store');

const CLI = path.resolve(__dirname, '..', 'bin', 'atris.js');

test('a large campaign learning report reaches a real pipe in full', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-campaign-json-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const db = path.join(root, 'campaign.db');
  const store = createSqliteStore(db);
  const campaign_id = 'cmp-large-report';
  const append = (type, data) => store.append({ campaign_id, type, actor: 'builder', data });
  append('campaign_started', { title: 'Complete results for the next planner', owner: 'builder', judge: 'false', budget: 10 });
  append('judge_ran', { passed: false, reading: 0, summary: 'not started' });
  for (let i = 0; i < 100; i += 1) {
    const mission_id = `m-check-${i}`;
    append('mission_started', { mission_id, member: 'builder', objective: `Improve real behavior ${i}: ${'check the complete runtime result. '.repeat(16)}` });
    append('mission_ended', { mission_id, outcome: 'kept', cost_usd: 0 });
    append('judge_ran', { passed: false, reading: (i + 1) / 101, summary: `reading ${i + 1} of 101` });
  }
  store.close();
  const result = spawnSync(process.execPath, [CLI, 'campaign', 'rsi', '--no-write', '--json'], {
    cwd: root,
    env: { ...process.env, ATRIS_CAMPAIGN_DB: db, ATRIS_SKIP_UPDATE_CHECK: '1' },
    encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: 15000,
  });
  assert.equal(result.status, 0, result.stderr);
  let report;
  assert.doesNotThrow(() => { report = JSON.parse(result.stdout); }, `incomplete JSON after ${Buffer.byteLength(result.stdout)} bytes`);
  assert.ok(Buffer.byteLength(result.stdout) > 128 * 1024, 'the report must exceed the pipe buffer');
  assert.equal(report.rsi.missions.length, 100);
  assert.equal(report.rsi.missions.at(-1).mission_id, 'm-check-99');
  assert.equal(report.rsi.campaigns[0].missions.length, 100);
});
