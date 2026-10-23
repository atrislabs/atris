'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createSqliteStore } = require('../lib/campaign-store');
const { computeMemberOverall } = require('../lib/campaign-rsi');

const CLI = path.resolve(__dirname, '..', 'bin', 'atris.js');

test('the real planner favors measured gains over completed volume without progress', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-rsi-evidence-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const db = path.join(root, 'campaign.db');
  const store = createSqliteStore(db);
  const append = (campaign_id, type, data) => store.append({ campaign_id, type, actor: 'auto-improver', data });
  for (const [id, member, count, measured] of [
    ['cmp-volume', 'busy-worker', 5, true],
    ['cmp-real', 'effective-worker', 1, true],
    ['cmp-unmeasured', 'unmeasured-worker', 8, false],
  ]) {
    append(id, 'campaign_started', { title: 'Improve a real result', owner: member, judge: 'false', budget: 10 });
    append(id, 'judge_ran', { passed: false, reading: 0 });
    for (let i = 0; i < count; i += 1) {
      const mission_id = `${id}-m-${i}`;
      append(id, 'mission_started', { mission_id, member });
      append(id, 'mission_ended', { mission_id, outcome: 'kept', cost_usd: 0 });
      if (measured) append(id, 'judge_ran', { passed: false, reading: member === 'effective-worker' ? 0.2 : 0 });
    }
  }
  append('cmp-next', 'campaign_started', { title: 'Pick the next worker from evidence', owner: 'chooser', judge: 'false', budget: 10 });
  append('cmp-next', 'judge_ran', { passed: false, reading: 0 });
  for (const member of ['busy-worker', 'effective-worker', 'unmeasured-worker']) append('cmp-next', 'seat_filled', { member, role: 'cli' });
  store.close();

  const run = spawnSync(process.execPath, [CLI, 'campaign', 'rsi', '--next', '--no-write', '--json'], {
    cwd: root, env: { ...process.env, ATRIS_CAMPAIGN_DB: db, ATRIS_SKIP_UPDATE_CHECK: '1' },
    encoding: 'utf8', timeout: 15000,
  });
  assert.equal(run.status, 0, run.stderr);
  const report = JSON.parse(run.stdout);
  const members = new Map(report.rsi.members.map((m) => [m.member, m]));
  const effective = members.get('effective-worker');
  for (const name of ['busy-worker', 'unmeasured-worker']) {
    const unproven = members.get(name);
    assert.ok(effective.overall > unproven.overall, `${name} must not outrank measured progress`);
    assert.equal(unproven.status, 'unproven');
    assert.match(unproven.note, /no judge progress/);
  }
  assert.equal(report.next_campaigns.find((c) => c.id === 'cmp-next').lead_member, 'effective-worker');
});

test('missing measurements never stand in for judge evidence', () => {
  const result = computeMemberOverall({ missions: 8, kept: 8 });
  assert.equal(result.status, 'unproven');
  assert.ok(result.overall <= 75);
});
