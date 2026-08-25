const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  buildFirstMinute,
  personName,
  renderFresh,
  renderWorkspace,
  shouldAutoInitFresh,
  spokenLineCount,
} = require('../lib/first-minute');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-first-minute-'));
}

function cleanupTempDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function runCli(args, { cwd, env, timeout = 15000 } = {}) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: 'utf8',
    timeout,
    env: {
      ...process.env,
      ATRIS_SKIP_UPDATE_CHECK: '1',
      ATRIS_NO_INTERACTIVE: '1',
      ...(env || {}),
    },
  });
  if (result.error && result.error.code === 'ETIMEDOUT') {
    assert.fail(`cli hung past ${timeout}ms (args: ${args.join(' ') || '(none)'})`);
  }
  if (result.error) throw result.error;
  return result;
}

function writeReadyWorkspace(dir, tasks) {
  fs.mkdirSync(path.join(dir, 'atris', 'reports'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.atris', 'state'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'atris', 'MAP.md'), '# MAP.md\n\n## By-Feature\n- example: bin/atris.js:1\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'atris', 'TODO.md'), '# TODO.md\n\n## Backlog\n\n(Empty)\n', 'utf8');
  fs.writeFileSync(path.join(dir, '.atris', 'state', 'tasks.projection.json'), JSON.stringify({
    schema: 'atris.task_projection.v1',
    tasks,
  }, null, 2), 'utf8');
}

test('fresh first-minute copy names init and stays short', () => {
  const text = renderFresh({ person: 'keshav', folder: 'this folder' });
  assert.match(text, /hey keshav, this folder is a clean start\./);
  assert.match(text, /^next: atris init --minimal$/m);
  assert.ok(spokenLineCount(text) <= 4);
  assert.ok(text.length < 200);
});

test('claimed task first-minute names the person or title and one next command', () => {
  const text = renderWorkspace({
    person: 'keshav',
    folder: 'atris',
    task: { title: 'Ship the landing page', status: 'claimed', display_id: 'CLI-9' },
    nextCommand: 'atris task step CLI-9',
  });
  assert.match(text, /hey keshav, Ship the landing page is already yours\./);
  assert.match(text, /^next: atris task step CLI-9$/m);
  assert.equal(text.match(/^next:/mg).length, 1);
  assert.ok(spokenLineCount(text) <= 4);
});

test('ready review task first-minute leads with a win', () => {
  const text = renderWorkspace({
    person: 'keshav',
    folder: 'atris',
    task: { title: 'Ship the landing page', status: 'review', display_id: 'CLI-9' },
    recap: { title: 'week one loop' },
    nextCommand: 'atris task reviews --limit 5',
  });
  assert.match(text, /you already shipped Ship the landing page/);
  assert.match(text, /last recap: week one loop/);
  assert.match(text, /^next: atris task reviews --limit 5$/m);
  assert.ok(spokenLineCount(text) <= 4);
});

test('headless flags never auto-init without an explicit yes', () => {
  assert.equal(shouldAutoInitFresh([], { ATRIS_NO_INTERACTIVE: '1' }), false);
  assert.equal(shouldAutoInitFresh(['--yes'], { ATRIS_NO_INTERACTIVE: '1' }), false);
  assert.equal(shouldAutoInitFresh(['--json', '--yes'], {}), false);
  assert.equal(shouldAutoInitFresh(['--yes'], {}), true);
});

test('personName prefers the local user', () => {
  assert.equal(personName({ USER: 'keshav' }), 'keshav');
});

test('buildFirstMinute reads a claimed task from the local projection', () => {
  const dir = makeTempDir();
  try {
    writeReadyWorkspace(dir, [{
      id: 'task-1',
      display_id: 'CLI-9',
      title: 'Ship the landing page',
      status: 'claimed',
      claimed_by: 'keshav',
      updated_at: 20,
    }]);
    const screen = buildFirstMinute({
      root: dir,
      person: 'keshav',
      folder: 'atris',
    });
    assert.match(screen.text, /Ship the landing page/);
    assert.equal(screen.nextCommand, 'atris task step CLI-9');
  } finally {
    cleanupTempDir(dir);
  }
});

test('empty dir bare atris names init, stays short, and does not hang', () => {
  const dir = makeTempDir();
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  try {
    const res = runCli([], {
      cwd: dir,
      env: { HOME: home, USER: 'keshav', ATRIS_TASKS_DB: path.join(dir, 'tasks.db') },
    });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.match(res.stdout, /init/);
    assert.match(res.stdout, /atris init --minimal/);
    assert.match(res.stdout, /keshav|this folder|clean start/);
    assert.ok(spokenLineCount(res.stdout) <= 6);
    assert.ok(res.stdout.length < 400);
    assert.doesNotMatch(res.stdout, /operating system|What do you want to build/i);
    assert.equal(fs.existsSync(path.join(dir, 'atris')), false);
  } finally {
    cleanupTempDir(dir);
  }
});

test('empty dir --json and no-interactive --yes never init', () => {
  const dir = makeTempDir();
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  try {
    const json = runCli(['--json'], {
      cwd: dir,
      env: { HOME: home, USER: 'keshav', ATRIS_TASKS_DB: path.join(dir, 'tasks.db') },
    });
    assert.equal(json.status, 2, json.stderr || json.stdout);
    const payload = JSON.parse(json.stdout);
    assert.equal(payload.next_action, 'atris init --minimal --yes');
    assert.equal(fs.existsSync(path.join(dir, 'atris')), false);

    const blocked = runCli(['--yes'], {
      cwd: dir,
      env: {
        HOME: home,
        USER: 'keshav',
        ATRIS_NO_INTERACTIVE: '1',
        ATRIS_TASKS_DB: path.join(dir, 'tasks.db'),
      },
    });
    assert.equal(blocked.status, 0, blocked.stderr || blocked.stdout);
    assert.match(blocked.stdout, /atris init --minimal/);
    assert.equal(fs.existsSync(path.join(dir, 'atris')), false);
  } finally {
    cleanupTempDir(dir);
  }
});

test('workspace with a claimed task names the person or title and one next command', () => {
  const dir = makeTempDir();
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  try {
    writeReadyWorkspace(dir, [{
      id: 'task-1',
      display_id: 'CLI-9',
      title: 'Ship the landing page',
      status: 'claimed',
      claimed_by: 'keshav',
      updated_at: 30,
    }]);
    const res = runCli([], {
      cwd: dir,
      env: {
        HOME: home,
        USER: 'keshav',
        ATRIS_TASKS_DB: path.join(dir, 'claimed.db'),
      },
    });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.match(res.stdout, /keshav|Ship the landing page/);
    assert.match(res.stdout, /^next: atris task step CLI-9$/m);
    assert.equal(res.stdout.match(/^next:/mg).length, 1);
    assert.doesNotMatch(res.stdout, /What do you want to build|context   loaded|Atris Do/);
    assert.ok(spokenLineCount(res.stdout) <= 6);
  } finally {
    cleanupTempDir(dir);
  }
});

test('workspace with a ready task names the win and one next command', () => {
  const dir = makeTempDir();
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  try {
    writeReadyWorkspace(dir, [{
      id: 'task-2',
      display_id: 'CLI-8',
      title: 'Ship the landing page',
      status: 'review',
      claimed_by: 'keshav',
      updated_at: 40,
      review: { agent_certified: true, agent_review_pass_count: 2 },
    }]);
    const res = runCli([], {
      cwd: dir,
      env: {
        HOME: home,
        USER: 'keshav',
        ATRIS_TASKS_DB: path.join(dir, 'ready.db'),
      },
    });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.match(res.stdout, /keshav|Ship the landing page/);
    assert.match(res.stdout, /^next: atris /m);
    assert.equal(res.stdout.match(/^next:/mg).length, 1);
    assert.doesNotMatch(res.stdout, /What do you want to build/);
  } finally {
    cleanupTempDir(dir);
  }
});
