'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const fixedTime = '2025-02-03T12:00:00.000Z';
const RealDate = Date;

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-next-push-'));
  const savedEnv = { ...process.env };
  process.env.HOME = root;
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('ATRIS_')) delete process.env[key];
  }
  t.mock.method(global, 'Date', class extends RealDate {
    constructor(...args) {
      super(...(args.length ? args : [fixedTime]));
    }
    static now() { return RealDate.parse(fixedTime); }
  });
  t.mock.method(Date, 'now', () => RealDate.parse(fixedTime));
  t.after(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) delete process.env[key];
    }
    Object.assign(process.env, savedEnv);
    fs.rmSync(root, { recursive: true, force: true });
  });
  // Load after isolating HOME and inherited Atris settings.
  const { autoQueueMemberNextPush } = require('../commands/mission');
  const dir = path.join(root, 'atris', 'team', 'builder');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'MEMBER.md'), '# Builder\n');
  const goalsPath = path.join(dir, 'goals.json');
  return {
    root, dir, goalsPath,
    autoQueueMemberNextPush,
    read: () => JSON.parse(fs.readFileSync(goalsPath, 'utf8')),
  };
}

test('creates a normalized active goal with the verified parent objective', (t) => {
  const f = fixture(t);
  assert.strictEqual(f.autoQueueMemberNextPush('builder', '  Ship\n the\t next slice  ', 'Improve replies', f.root), f.goalsPath);
  assert.deepStrictEqual(f.read(), {
    schema_version: 1,
    member: 'builder',
    updated_at: fixedTime,
    goals: [{
      id: `goal_${RealDate.parse(fixedTime).toString(36)}`,
      member: 'builder',
      title: 'Ship the next slice',
      why: 'Compounds after verified win on: Improve replies',
      metric: 'verified_slices_shipped',
      target: '1',
      horizon: '7d',
      acceptance: ['Passes test check and cross-model referee'],
      next_push: 'Ship the next slice',
      status: 'active',
      created_at: fixedTime,
      updated_at: fixedTime,
    }],
  });
  assert.ok(fs.readFileSync(f.goalsPath, 'utf8').endsWith('\n'));
});

test('updates only the first active goal and promotes its title only when requested', (t) => {
  const f = fixture(t);
  const completed = { id: 'done', title: 'Earlier work', status: 'complete' };
  const active = { id: 'current', title: 'Current work', status: 'active', custom: 'keep' };
  const later = { id: 'later', title: 'Other work', status: 'active' };
  fs.writeFileSync(f.goalsPath, JSON.stringify({ member: 'builder', custom: 7, goals: [completed, active, later] }));

  assert.strictEqual(f.autoQueueMemberNextPush('builder', ' Next\n work ', '', f.root), f.goalsPath);
  const updated = { ...active, next_push: 'Next work', updated_at: fixedTime };
  assert.deepStrictEqual(f.read(), {
    member: 'builder', custom: 7, updated_at: fixedTime,
    goals: [completed, updated, later],
  });

  assert.strictEqual(f.autoQueueMemberNextPush('builder', 'Promoted work', '', f.root, { promote: true }), f.goalsPath);
  assert.deepStrictEqual(f.read().goals, [
    completed,
    { ...updated, previous_title: 'Current work', title: 'Promoted work', next_push: 'Promoted work' },
    later,
  ]);
});

test('recovers malformed saved goals and supplies a reason without a parent', (t) => {
  const f = fixture(t);
  for (const content of ['{broken json', '{"goals":{}}', 'null']) {
    fs.writeFileSync(f.goalsPath, content);
    assert.strictEqual(f.autoQueueMemberNextPush('builder', 'Try again', '', f.root), f.goalsPath);
    const store = f.read();
    assert.strictEqual(store.schema_version, 1);
    assert.strictEqual(store.member, 'builder');
    assert.strictEqual(store.goals.length, 1);
    assert.strictEqual(store.goals[0].title, 'Try again');
    assert.strictEqual(store.goals[0].status, 'active');
    assert.strictEqual(store.goals[0].why, 'Self-proposed next optimization from verified run.');
  }
});

test('empty pushes and invalid or missing members return null without writing goals', (t) => {
  const f = fixture(t);
  for (const push of ['', ' \n\t ', null, undefined]) {
    assert.strictEqual(f.autoQueueMemberNextPush('builder', push, '', f.root), null);
  }
  for (const owner of ['', null, '../builder', 'missing']) {
    assert.strictEqual(f.autoQueueMemberNextPush(owner, 'Next work', '', f.root), null);
  }
  assert.deepStrictEqual(fs.readdirSync(f.dir), ['MEMBER.md']);
  assert.deepStrictEqual(fs.readdirSync(path.dirname(f.dir)), ['builder']);
});
