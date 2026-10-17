'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const CLI = path.resolve(__dirname, '..', 'bin', 'atris.js');
const ID = 'cmp-start-fails';
const MISSION = 'm-start-fails';

function workspace(t) {
  const caller = { ...process.env };
  const unsafe = ['NODE_OPTIONS', 'NODE_PATH', 'NODE_EXTRA_CA_CERTS', 'BASH_ENV', 'ENV',
    'ATRIS_CAMPAIGN_TOKEN_FILE', 'ATRIS_CAMPAIGN_HOLDOUT', 'ATRIS_CAMPAIGN_START_COMMIT',
    'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE',
    'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_EXEC_PATH', 'GIT_CONFIG',
    'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_PARAMETERS'];
  for (const key of Object.keys(caller)) {
    if (unsafe.includes(key) || /^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(key) || /^(DYLD_|LD_)/.test(key)) {
      assert.ok(!caller[key], `refuse inherited startup or repository override: ${key}`);
    }
  }
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'crf-'));
  const root = path.join(parent, 'work');
  const home = path.join(parent, 'home');
  const sentinel = path.join(parent, 'foreign.txt');
  t.after(() => {
    try {
      fs.rmSync(root, { recursive: true, force: true });
      assert.equal(fs.readFileSync(sentinel, 'utf8'), 'foreign fixture stays\n');
      assert.deepEqual({ ...process.env }, caller);
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });
  fs.mkdirSync(root);
  fs.mkdirSync(home);
  fs.writeFileSync(sentinel, 'foreign fixture stays\n');
  const db = path.join(root, '.atris', 'state', 'atris.db');
  const env = { ...caller, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, 'config'), ATRIS_CAMPAIGN_DB: db,
    ATRIS_TASKS_DB: path.join(home, 'tasks.db'), ATRIS_TEST_STATE_DIR: path.join(home, 'test-state'),
    ATRIS_SKIP_UPDATE_CHECK: '1' };
  const outsideGit = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: root, env, encoding: 'utf8', timeout: 15000,
  });
  assert.ifError(outsideGit.error);
  assert.equal(outsideGit.signal, null);
  assert.equal(outsideGit.status, 128, 'fixture must be outside every Git checkout before setup');
  const cli = (...args) => {
    const child = spawnSync(process.execPath, [CLI, 'campaign', ...args, '--as', 'auto-improver', '--json'], {
      cwd: root, env, encoding: 'utf8', timeout: 15000, maxBuffer: 4 * 1024 * 1024,
    });
    assert.ifError(child.error);
    assert.equal(child.signal, null);
    return { child, result: JSON.parse(child.stdout) };
  };
  const setup = (...args) => {
    const { child, result } = cli(...args);
    assert.equal(child.status, 0, child.stderr || child.stdout);
    assert.equal(result.ok, true);
    return result;
  };
  setup('start', 'Work must actually start', '--judge', 'false', '--id', ID, '--owner', 'auto-improver');
  setup('event', ID, 'mission_proposed', '--data', JSON.stringify({
    mission_id: MISSION, member: 'auto-improver', objective: 'Make the real result file', verify: 'test -f result.txt',
  }));
  setup('event', ID, 'mission_claimed', '--data', JSON.stringify({ mission_id: MISSION, claim_key: 'real-start' }));
  const events = () => {
    const { DatabaseSync } = require('node:sqlite');
    const reader = new DatabaseSync(db, { readOnly: true });
    try {
      return reader.prepare('SELECT type, actor, data FROM events WHERE campaign_id = ? ORDER BY pos').all(ID)
        .map(row => ({ ...row, data: JSON.parse(row.data) }));
    } finally {
      reader.close();
    }
  };
  return { root, db, home, cli, setup, events };
}

function assertNoWork(fixture, campaign) {
  assert.equal(campaign.budget.spent, 0);
  assert.equal(campaign.budget.reserved, 0);
  assert.equal(campaign.missions.length, 1);
  assert.equal(campaign.missions[0].steps, 0);
  assert.equal(fs.existsSync(path.join(fixture.root, 'result.txt')), false);
  assert.equal(fs.existsSync(path.join(fixture.root, '.atris', 'state', 'missions.jsonl')), false);
  assert.equal(fs.existsSync(path.join(fixture.root, '.atris', 'state', 'campaigns', ID, 'run.lock')), false);
  assert.equal(fs.existsSync(path.join(fixture.home, 'tasks.db')), false, 'a refused runner creates no task ledger');
}

for (const verb of ['run', 'step']) {
  test(`campaign ${verb} reports a real refused mission start as a failure without inventing work`, t => {
    const fixture = workspace(t);
    const args = verb === 'run' ? ['--max-steps', '1'] : [];
    const { child, result } = fixture.cli(verb, ID, ...args, '--runner', 'nonexistent-engine');
    assert.equal(child.status, 1, child.stderr || child.stdout);
    assert.equal(result.ok, false);
    assertNoWork(fixture, result.campaign);
    assert.equal(result.campaign.missions[0].status, 'vetoed');
    const events = fixture.events();
    assert.deepEqual(events.map(event => event.type), [
      'campaign_started', 'judge_ran', 'mission_proposed', 'mission_claimed', 'mission_vetoed',
    ]);
    assert.equal(events[1].data.passed, false, 'only the genuine setup judge ran');
    assert.equal(events[4].actor, 'auto-improver');
    assert.equal(events[4].data.mission_id, MISSION);
    assert.match(events[4].data.reason, /unknown runner.*nonexistent-engine/i);
    assert.match(result.reason, /no claimed mission could start/);
    if (verb === 'run') assert.equal(result.steps, 0);
    else assert.equal(result.stop, true);
  });
}

for (const terminal of ['pause', 'stop']) {
  test(`campaign run treats a genuine ${terminal} as a normal stop without attempting work`, t => {
    const fixture = workspace(t);
    fixture.setup(terminal, ID);
    const before = fixture.events();
    const { child, result } = fixture.cli('run', ID, '--max-steps', '1', '--runner', 'nonexistent-engine');
    assert.equal(child.status, 0, child.stderr || child.stdout);
    assert.equal(result.ok, true);
    assert.equal(result.steps, 0);
    assert.equal(result.reason, terminal === 'pause' ? 'paused' : 'finished');
    assert.equal(result.campaign.state, terminal === 'pause' ? 'paused' : 'done');
    assert.equal(result.campaign.missions[0].status, 'claimed');
    assertNoWork(fixture, result.campaign);
    assert.deepEqual(fixture.events(), before, 'a normal stop runs no judge, engine or mission');
  });
}
