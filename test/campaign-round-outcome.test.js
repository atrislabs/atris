'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SOURCE = path.resolve(__dirname, '..');
const ID = 'cmp-round-outcome';
const DRIVER = String.raw`
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const [source, mode, verb, rounds] = process.argv.slice(2);
const { campaignCommand } = require(path.join(source, 'commands/campaign'));
const { createSqliteStore, getCampaign } = require(path.join(source, 'lib/campaign-store'));
const id = 'cmp-round-outcome';
const output = console.log;
(async () => {
  const store = createSqliteStore(process.env.ATRIS_CAMPAIGN_DB);
  let messages = [];
  const asks = { plan: 0, review: 0 };
  console.log = value => messages.push(String(value));
  try {
    const call = async (args, ask) => {
      messages = [];
      const code = await campaignCommand([...args, '--json'], {
        store, actor: 'auto-improver', ...(ask ? { loopDeps: { ask } } : {}),
      });
      assert.equal(messages.length, 1);
      return { code, data: JSON.parse(messages[0]) };
    };
    const setup = async args => {
      const result = await call(args);
      assert.equal(result.code, 0);
      assert.equal(result.data.ok, true);
    };
    const judge = mode === 'finish' || mode === 'wait' ? 'test -f ready.txt' : 'false';
    await setup(['start', 'Report the actual round outcome', '--id', id,
      '--owner', 'auto-improver', '--judge', judge]);
    if (mode === 'refusal') {
      await setup(['event', id, 'mission_proposed', '--data', JSON.stringify({
        mission_id: 'm-refused', member: 'auto-improver', objective: 'Make the real result file', verify: 'test -f result.txt',
      })]);
      await setup(['event', id, 'mission_claimed', '--data', JSON.stringify({ mission_id: 'm-refused', claim_key: 'one-owned-start' })]);
    }
    if (mode === 'pause' || mode === 'stop') await setup([mode, id]);
    if (mode === 'finish') fs.writeFileSync('ready.txt', 'actual local completion\n');
    const ask = async (root, view, prompt) => {
      assert.equal(root, process.cwd());
      assert.equal(view.id, id);
      if (prompt.startsWith('You review')) {
        asks.review++;
        return { ok: true, text: '- retain the actual result before another round' };
      }
      assert.ok(mode === 'finish' || mode === 'wait', 'no planning engine is allowed for a refused or terminal campaign');
      assert.match(prompt, /^You plan/);
      asks.plan++;
      return { ok: true, text: '[]' };
    };
    const options = verb === 'plain' ? ['--max-steps', '2']
      : ['--work', '50m', '--break', '0s', '--rounds', rounds];
    const result = await call(['run', id, ...options, '--runner', 'nonexistent-engine'], ask);
    const report = { ...result, asks, events: store.read(id), view: getCampaign(store, id) };
    store.close();
    report.closed = true;
    console.log = output;
    output(JSON.stringify(report));
    process.exitCode = result.code;
  } finally {
    if (console.log !== output) { store.close(); console.log = output; }
  }
})().catch(error => { console.error(error); process.exitCode = 2; });
`;

function run(t, mode, verb = 'cadence', rounds = 1) {
  const caller = { ...process.env };
  const cwd = process.cwd();
  const unsafe = ['NODE_OPTIONS', 'NODE_PATH', 'NODE_EXTRA_CA_CERTS', 'BASH_ENV', 'ENV',
    'ATRIS_CAMPAIGN_TOKEN_FILE', 'ATRIS_CAMPAIGN_HOLDOUT', 'ATRIS_CAMPAIGN_START_COMMIT',
    'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_EXEC_PATH', 'GIT_CONFIG', 'GIT_CONFIG_SYSTEM',
    'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_PARAMETERS'];
  for (const key of Object.keys(caller)) {
    if (unsafe.includes(key) || /^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(key) || /^(DYLD_|LD_)/.test(key)) {
      assert.ok(!caller[key], `refuse inherited startup or repository override: ${key}`);
    }
  }
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'cro-'));
  const root = path.join(parent, 'work');
  const home = path.join(parent, 'home');
  const sentinel = path.join(parent, 'foreign.txt');
  t.after(() => {
    try {
      fs.rmSync(root, { recursive: true, force: true });
      assert.equal(fs.readFileSync(sentinel, 'utf8'), 'foreign fixture stays\n');
      assert.deepEqual({ ...process.env }, caller);
      assert.equal(process.cwd(), cwd);
    } finally { fs.rmSync(parent, { recursive: true, force: true }); }
  });
  fs.mkdirSync(root);
  fs.mkdirSync(home);
  fs.writeFileSync(sentinel, 'foreign fixture stays\n');
  const env = { ...caller, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, 'config'),
    ATRIS_CAMPAIGN_DB: path.join(root, '.atris', 'state', 'atris.db'),
    ATRIS_TASKS_DB: path.join(home, 'tasks.db'), ATRIS_TEST_STATE_DIR: path.join(home, 'test-state'),
    ATRIS_RSI_STATE: path.join(root, '.atris', 'state', 'owned-rsi'), ATRIS_SKIP_UPDATE_CHECK: '1' };
  const options = { cwd: root, env, encoding: 'utf8', timeout: 15000, maxBuffer: 4 * 1024 * 1024 };
  const git = spawnSync('git', ['rev-parse', 'HEAD'], options);
  assert.ifError(git.error);
  assert.equal(git.signal, null);
  assert.equal(git.status, 128, 'fixture must be outside every Git checkout');
  const driver = path.join(parent, 'driver.cjs');
  fs.writeFileSync(driver, DRIVER);
  const child = spawnSync(process.execPath, [driver, SOURCE, mode, verb, String(rounds)], options);
  assert.ifError(child.error);
  assert.equal(child.signal, null);
  assert.ok(child.stdout.trim(), child.stderr);
  const report = JSON.parse(child.stdout);
  assert.equal(report.closed, true);
  assert.equal(child.status, report.code, child.stderr || child.stdout);
  assert.equal(report.view.budget.spent, 0);
  assert.equal(report.view.budget.reserved, 0);
  assert.equal(fs.existsSync(path.join(root, '.atris', 'state', 'missions.jsonl')), false);
  assert.equal(fs.existsSync(path.join(root, '.atris', 'state', 'campaigns', ID, 'run.lock')), false);
  assert.equal(fs.existsSync(path.join(home, 'tasks.db')), false);
  assert.equal(fs.existsSync(path.join(env.ATRIS_RSI_STATE, 'attempts.jsonl')), false, 'no work supplies recorder candidates');
  return { ...report, root };
}

test('cadence reports an actual refused native mission start and still writes its review', t => {
  const result = run(t, 'refusal');
  assert.equal(result.data.rounds, 1);
  assert.match(result.data.reason, /no claimed mission could start/);
  assert.deepEqual(result.asks, { plan: 0, review: 1 });
  assert.deepEqual(result.events.map(event => event.type), [
    'campaign_started', 'judge_ran', 'mission_proposed', 'mission_claimed', 'mission_vetoed',
  ]);
  assert.match(result.events[4].data.reason, /unknown runner.*nonexistent-engine/i);
  assert.equal(result.view.missions[0].status, 'vetoed');
  assert.equal(result.view.missions[0].steps, 0);
  assert.match(fs.readFileSync(path.join(result.root, 'atris', 'campaigns', ID, 'lessons.md'), 'utf8'),
    /- retain the actual result before another round/);
  assert.equal(result.code, 1);
  assert.equal(result.data.ok, false);
});

for (const verb of ['plain', 'cadence']) {
  test(`${verb} succeeds when the actual empty-plan judge recheck passes`, t => {
    const result = run(t, 'finish', verb);
    assert.equal(result.view.state, 'done');
    assert.equal(result.view.stop_reason, 'judge_passed');
    assert.equal(result.view.next_move, undefined);
    assert.deepEqual(result.events.map(event => event.type), ['campaign_started', 'judge_ran', 'judge_ran']);
    assert.deepEqual(result.events.filter(event => event.type === 'judge_ran').map(event => event.data.passed), [false, true]);
    assert.deepEqual(result.asks, { plan: 1, review: verb === 'cadence' ? 1 : 0 });
    assert.deepEqual(result.view.missions, []);
    const snapshot = JSON.parse(fs.readFileSync(path.join(result.root, '.atris', 'state', 'campaign-rsi.json'), 'utf8'));
    assert.equal(snapshot.completed_count, 1);
    assert.deepEqual(snapshot.missions, []);
    assert.equal(result.code, 0);
    assert.equal(result.data.ok, true);
  });
}

for (const terminal of ['pause', 'stop']) {
  test(`cadence retains a genuine ${terminal} as a normal terminal result`, t => {
    const result = run(t, terminal);
    assert.equal(result.code, 0);
    assert.equal(result.data.ok, true);
    assert.equal(result.data.rounds, 1);
    assert.equal(result.view.state, terminal === 'pause' ? 'paused' : 'done');
    assert.deepEqual(result.asks, { plan: 0, review: 0 });
    assert.deepEqual(result.events.map(event => event.type), ['campaign_started', 'judge_ran', terminal === 'pause' ? 'paused' : 'stopped']);
  });
}

test('a final round-limit empty-plan failure remains a failed result', t => {
  const result = run(t, 'wait');
  assert.equal(result.data.rounds, 1);
  assert.match(result.data.reason, /proposed nothing usable/);
  assert.deepEqual(result.asks, { plan: 1, review: 0 });
  assert.equal(result.view.judge_runs, 2);
  assert.equal(result.view.next_move.wait_ms, 600000);
  assert.equal(result.code, 1);
  assert.equal(result.data.ok, false);
});

test('a later normal saved wait clears the previous round failure without another judge or plan', t => {
  const result = run(t, 'wait', 'cadence', 2);
  assert.equal(result.code, 0);
  assert.equal(result.data.ok, true);
  assert.equal(result.data.rounds, 2);
  assert.match(result.data.reason, /waiting on the world/);
  assert.deepEqual(result.asks, { plan: 1, review: 0 });
  assert.equal(result.view.judge_runs, 2);
  assert.equal(result.view.next_move.wait_ms, 600000);
  const lessons = fs.readFileSync(path.join(result.root, 'atris', 'campaigns', ID, 'lessons.md'), 'utf8');
  assert.equal((lessons.match(/^## /gm) || []).length, 2);
});
