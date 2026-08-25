const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  buildFirstMinute,
  deskNextCommand,
  folderName,
  personName,
  pickNext,
  renderFresh,
  renderWorkspace,
  shouldAutoInitFresh,
  spokenLineCount,
  taskCommand,
  taskNextCommand,
} = require('../lib/first-minute');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-first-minute-'));
}

function cleanupTempDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function writeAccount(home, account) {
  fs.mkdirSync(path.join(home, '.atris'), { recursive: true });
  fs.writeFileSync(path.join(home, '.atris', 'credentials.json'), JSON.stringify(account, null, 2), 'utf8');
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
  assert.match(text, /I'll set this up when you want\./);
  assert.match(text, /^next: atris init --minimal$/m);
  assert.ok(spokenLineCount(text) <= 4);
  assert.ok(text.length < 200);
});

test('claimed task first-minute names the person or title and one next command', () => {
  const text = renderWorkspace({
    person: 'keshav',
    folder: 'atris',
    task: { title: 'Ship the landing page', status: 'claimed', display_id: 'CLI-9' },
    nextCommand: 'atris task ready CLI-9',
  });
  assert.match(text, /hey keshav, "ship the landing page" is already yours\./);
  assert.match(text, /^next: atris task ready CLI-9$/m);
  assert.equal(text.match(/^next:/mg).length, 1);
  assert.ok(spokenLineCount(text) <= 4);
});

test('ready review task first-minute waits for a human ok', () => {
  const text = renderWorkspace({
    person: 'keshav',
    folder: 'atris',
    task: {
      title: 'Print a human line like 4 words so the count is easy to read.',
      status: 'review',
      display_id: 'UNW-2',
      review: { agent_certified: true, agent_review_pass_count: 2 },
    },
    recap: { title: 'week one loop' },
    nextCommand: 'atris task accept UNW-2',
  });
  assert.match(text, /"print a human line like" is waiting for your ok\./);
  assert.doesNotMatch(text, /you already shipped/);
  assert.doesNotMatch(text, /so the count is easy to read/);
  assert.match(text, /last recap: week one loop/);
  assert.match(text, /^next: atris task accept UNW-2$/m);
  assert.ok(spokenLineCount(text) <= 4);
});

test('desk next command uses first-minute verbs without ready templates', () => {
  assert.equal(deskNextCommand([{
    status: 'review',
    display_id: 'UNW-2',
    review: { agent_certified: true, agent_review_pass_count: 2 },
    updated_at: 10,
  }], 'keshav'), 'atris task accept UNW-2');
  assert.equal(deskNextCommand([{
    status: 'review',
    display_id: 'UNW-8',
    review: { agent_review_pass_count: 2 },
    updated_at: 10,
  }], 'keshav'), 'atris task accept UNW-8');
  assert.equal(deskNextCommand([{
    status: 'claimed',
    display_id: 'CLI-9',
    updated_at: 10,
  }], 'keshav'), 'atris task ready CLI-9');
  assert.doesNotMatch(deskNextCommand([{
    status: 'claimed',
    display_id: 'CLI-9',
    updated_at: 10,
  }], 'keshav'), /<[^>]+>/);
  assert.equal(deskNextCommand([{
    status: 'open',
    display_id: 'CLI-1',
    updated_at: 10,
  }], 'keshav'), 'atris task claim CLI-1 --as keshav');
  assert.equal(deskNextCommand([{ status: 'done', display_id: 'CLI-0' }], 'keshav'), 'atris task next');
  assert.equal(deskNextCommand([], 'keshav'), 'atris task new');
  assert.equal(taskNextCommand([{ status: 'done', display_id: 'CLI-0' }], 'keshav'), 'atris task new');
  assert.equal(taskNextCommand([], 'keshav'), 'atris task new');
  assert.equal(taskCommand({ status: 'claimed', display_id: 'LDY-1' }, 'keshav'), 'atris task ready LDY-1');
  assert.equal(pickNext({
    tasks: [
      { status: 'open', display_id: 'UNW-1', updated_at: 10 },
      { status: 'claimed', display_id: 'LDY-1', updated_at: 20 },
    ],
    person: 'keshav',
  }).command, 'atris task ready LDY-1');
});

test('desk next command prefers certified review over claimed or open work', () => {
  assert.equal(deskNextCommand([
    { status: 'open', display_id: 'CLI-1', updated_at: 40 },
    { status: 'claimed', display_id: 'CLI-9', updated_at: 30 },
    {
      status: 'review',
      display_id: 'UNW-2',
      review: { agent_certified: true, agent_review_pass_count: 2 },
      updated_at: 10,
    },
  ], 'keshav'), 'atris task accept UNW-2');
});

test('uncertified review task first-minute is ready to look at', () => {
  const text = renderWorkspace({
    person: 'keshav',
    folder: 'atris',
    task: {
      title: 'Print a human line like 4 words so the count is easy to read.',
      status: 'review',
      display_id: 'UNW-4',
      review: { agent_review_pass_count: 1 },
    },
    nextCommand: 'atris task review-chat UNW-4 --as codex-review',
  });
  assert.match(text, /"print a human line like" is ready to look at\./);
  assert.doesNotMatch(text, /you already shipped/);
  assert.match(text, /^next: atris task review-chat UNW-4 --as codex-review$/m);
});

test('headless flags never auto-init without an explicit yes', () => {
  assert.equal(shouldAutoInitFresh([], { ATRIS_NO_INTERACTIVE: '1' }), false);
  assert.equal(shouldAutoInitFresh(['--yes'], { ATRIS_NO_INTERACTIVE: '1' }), true);
  assert.equal(shouldAutoInitFresh(['-y'], { ATRIS_NO_INTERACTIVE: '1' }), true);
  assert.equal(shouldAutoInitFresh(['--json', '--yes'], {}), false);
  assert.equal(shouldAutoInitFresh(['--yes'], {}), true);
});

test('personName prefers a given name from the saved account', () => {
  assert.equal(personName({ USER: 'keshavrao' }, { email: 'keshav@atrislabs.com' }), 'keshav');
  assert.equal(personName({ USER: 'keshavrao' }, { name: 'Keshav Rao' }), 'keshav');
  assert.equal(personName({ USER: 'keshavrao' }, null), 'keshavrao');
  assert.equal(personName({ ATRIS_OPERATOR: 'keshav', USER: 'keshavrao' }, null), 'keshav');
  assert.equal(personName({ USER: 'keshav' }, null), 'keshav');
});

test('scratch folders stay this folder and real names stay', () => {
  assert.equal(folderName('/tmp/atris-use-now'), 'this folder');
  assert.equal(folderName('/tmp/atris-first-min-try'), 'this folder');
  assert.equal(folderName('/tmp/tmp'), 'this folder');
  assert.equal(folderName('/tmp/temp'), 'this folder');
  assert.equal(folderName('/tmp/a1b2c3d4e5f67890'), 'this folder');
  assert.equal(folderName('/tmp/550e8400-e29b-41d4-a716-446655440000'), 'this folder');
  assert.equal(folderName('/var/folders/xx/yy/T/launch'), 'launch');
  assert.equal(folderName('/tmp/launch-day'), 'launch-day');
  assert.equal(folderName('/Users/keshav/launch-day'), 'launch-day');
  assert.equal(folderName('/Users/keshav/atris'), 'atris');
});

test('named empty folder under tmp keeps the room name', () => {
  const text = renderFresh({ person: 'keshav', folder: folderName('/tmp/launch-day') });
  assert.match(text, /hey keshav, launch-day is a clean start\./);
  assert.match(text, /I'll set this up when you want\./);
  assert.match(text, /^next: atris init --minimal$/m);
  assert.ok(spokenLineCount(text) <= 4);
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
    assert.match(screen.text, /"ship the landing page"/);
    assert.equal(screen.nextCommand, 'atris task ready CLI-9');
  } finally {
    cleanupTempDir(dir);
  }
});

test('buildFirstMinute prefers a certified review over a newer uncertified one', () => {
  const dir = makeTempDir();
  try {
    writeReadyWorkspace(dir, [
      {
        id: 'task-1',
        display_id: 'UNW-1',
        title: 'Open follow-up',
        status: 'open',
        updated_at: 10,
      },
      {
        id: 'task-2',
        display_id: 'UNW-2',
        title: 'Print a human line like 4 words so the count is easy to read.',
        status: 'review',
        updated_at: 20,
        review: { agent_certified: true, agent_review_pass_count: 2 },
      },
      {
        id: 'task-3',
        display_id: 'UNW-3',
        title: 'Second check still open',
        status: 'review',
        updated_at: 30,
        review: { agent_review_pass_count: 1 },
      },
      {
        id: 'task-4',
        display_id: 'UNW-4',
        title: 'Newer review still waiting',
        status: 'review',
        updated_at: 40,
        review: { agent_review_pass_count: 1 },
      },
    ]);
    const screen = buildFirstMinute({
      root: dir,
      person: 'keshav',
      folder: 'this folder',
    });
    assert.equal(screen.nextCommand, 'atris task accept UNW-2');
    assert.match(screen.text, /waiting for your ok/);
    assert.doesNotMatch(screen.text, /you already shipped/);
    assert.doesNotMatch(screen.text, /review-chat/);
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
    assert.match(res.stdout, /this folder is a clean start/);
    assert.match(res.stdout, /atris init --minimal/);
    assert.match(res.stdout, /hey keshav,/);
    assert.ok(spokenLineCount(res.stdout) <= 6);
    assert.ok(res.stdout.length < 400);
    assert.doesNotMatch(res.stdout, /operating system|What do you want to build/i);
    assert.doesNotMatch(res.stdout, /mission run|help me choose the first useful step/i);
    assert.equal(fs.existsSync(path.join(dir, 'atris')), false);
  } finally {
    cleanupTempDir(dir);
  }
});

test('empty named folder under tmp greets with the room name', () => {
  const parent = makeTempDir();
  const dir = path.join(parent, 'launch-day');
  const home = path.join(parent, 'home');
  fs.mkdirSync(dir);
  fs.mkdirSync(home);
  try {
    const res = runCli([], {
      cwd: dir,
      env: { HOME: home, USER: 'keshav', ATRIS_TASKS_DB: path.join(dir, 'tasks.db') },
    });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.match(res.stdout, /hey keshav, launch-day is a clean start\./);
    assert.match(res.stdout, /I'll set this up when you want\./);
    assert.match(res.stdout, /^next: atris init --minimal$/m);
    assert.doesNotMatch(res.stdout, /this folder is a clean start/);
    assert.equal(fs.existsSync(path.join(dir, 'atris')), false);
  } finally {
    cleanupTempDir(parent);
  }
});

test('empty dir --json does not init', () => {
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
  } finally {
    cleanupTempDir(dir);
  }
});

test('empty dir no-interactive without --yes does not init', () => {
  const dir = makeTempDir();
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  try {
    const blocked = runCli([], {
      cwd: dir,
      env: {
        HOME: home,
        USER: 'keshav',
        ATRIS_NO_INTERACTIVE: '1',
        ATRIS_TASKS_DB: path.join(dir, 'tasks.db'),
      },
    });
    assert.equal(blocked.status, 0, blocked.stderr || blocked.stdout);
    assert.match(blocked.stdout, /^next: atris init --minimal$/m);
    assert.equal(fs.existsSync(path.join(dir, 'atris')), false);
  } finally {
    cleanupTempDir(dir);
  }
});

test('empty dir --yes inits even under no-interactive', () => {
  const dir = makeTempDir();
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  try {
    const started = runCli(['--yes'], {
      cwd: dir,
      timeout: 60000,
      env: {
        HOME: home,
        USER: 'keshav',
        ATRIS_NO_INTERACTIVE: '1',
        ATRIS_TASKS_DB: path.join(dir, 'tasks.db'),
      },
    });
    assert.equal(started.status, 0, started.stderr || started.stdout);
    assert.ok(fs.existsSync(path.join(dir, 'atris', 'MAP.md')));
    assert.match(started.stdout, /atris initialized/);
    assert.match(started.stdout, /^next: atris task claim /m);
    assert.doesNotMatch(started.stdout, /I'll set this up when you want/);
    assert.doesNotMatch(started.stdout, /What do you want to build/);
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
    assert.match(res.stdout, /keshav|ship the landing page/i);
    assert.match(res.stdout, /^next: atris task ready CLI-9$/m);
    assert.equal(res.stdout.match(/^next:/mg).length, 1);
    assert.doesNotMatch(res.stdout, /What do you want to build|context   loaded|Atris Do/);
    assert.ok(spokenLineCount(res.stdout) <= 6);
  } finally {
    cleanupTempDir(dir);
  }
});

test('workspace with a ready task names the win and points at accept', () => {
  const dir = makeTempDir();
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  writeAccount(home, {
    token: 'test-token',
    email: 'keshav@atrislabs.com',
    name: 'Keshav Rao',
    user_id: 'u-1',
  });
  try {
    writeReadyWorkspace(dir, [
      {
        id: 'task-1',
        display_id: 'UNW-1',
        title: 'Open follow-up',
        status: 'open',
        updated_at: 10,
      },
      {
        id: 'task-2',
        display_id: 'UNW-2',
        title: 'Print a human line like 4 words so the count is easy to read.',
        status: 'review',
        claimed_by: 'keshav',
        updated_at: 20,
        review: { agent_certified: true, agent_review_pass_count: 2 },
      },
      {
        id: 'task-3',
        display_id: 'UNW-3',
        title: 'Second check still open',
        status: 'review',
        updated_at: 30,
        review: { agent_review_pass_count: 1 },
      },
      {
        id: 'task-4',
        display_id: 'UNW-4',
        title: 'Newer review still waiting',
        status: 'review',
        updated_at: 40,
        review: { agent_review_pass_count: 1 },
      },
    ]);
    const res = runCli([], {
      cwd: dir,
      env: {
        HOME: home,
        USER: 'keshavrao',
        ATRIS_TASKS_DB: path.join(dir, 'ready.db'),
      },
    });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.match(res.stdout, /hey keshav,/);
    assert.doesNotMatch(res.stdout, /keshavrao/);
    assert.match(res.stdout, /"print a human line like"/);
    assert.match(res.stdout, /waiting for your ok/);
    assert.match(res.stdout, /^next: atris task accept UNW-2$/m);
    assert.equal(res.stdout.match(/^next:/mg).length, 1);
    assert.doesNotMatch(res.stdout, /you already shipped/);
    assert.doesNotMatch(res.stdout, /review-chat/);
    assert.doesNotMatch(res.stdout, /What do you want to build/);
    assert.ok(spokenLineCount(res.stdout) <= 6);
  } finally {
    cleanupTempDir(dir);
  }
});
