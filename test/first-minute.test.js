const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  buildFirstMinute,
  deskNextCommand,
  firstTalkCommand,
  folderName,
  freshMinuteJson,
  personName,
  pickNext,
  renderFirstTalk,
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

function nextLine(stdout) {
  const match = String(stdout || '').match(/^next: (.+)$/m);
  return match ? match[1] : '';
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

test('fresh first-minute copy starts a conversation and stays short', () => {
  const text = renderFresh({ person: 'keshav', folder: 'this folder' });
  assert.match(text, /hey keshav, this folder is empty\./);
  assert.doesNotMatch(text, /I'll set this up when you want/);
  assert.doesNotMatch(text, /atris init --minimal/);
  assert.match(text, /^next: atris "what should this folder be\?"$/m);
  assert.equal(spokenLineCount(text), 2);
  assert.ok(text.length < 200);
  const json = freshMinuteJson();
  assert.equal(json.next_action, 'atris "what should this folder be?"');
  assert.equal(json.reason, 'this folder is empty');
});

test('claimed task first-minute names the person or title and one next command', () => {
  const text = renderWorkspace({
    person: 'keshav',
    folder: 'atris',
    task: { title: 'Ship the landing page', status: 'claimed', display_id: 'CLI-9' },
    nextCommand: 'atris task show CLI-9',
  });
  assert.match(text, /hey keshav, "ship the landing page" is already yours\./);
  assert.match(text, /^next: atris task show CLI-9$/m);
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
  assert.match(text, /one finished thing is waiting for your ok \(UNW-2\)\./);
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
  }], 'keshav'), 'atris task show CLI-9');
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
  assert.equal(taskCommand({ status: 'claimed', display_id: 'LDY-1' }, 'keshav'), 'atris task show LDY-1');
  assert.equal(pickNext({
    tasks: [
      { status: 'open', display_id: 'UNW-1', updated_at: 10 },
      { status: 'claimed', display_id: 'LDY-1', updated_at: 20 },
    ],
    person: 'keshav',
  }).command, 'atris task show LDY-1');
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

test('uncertified review task first-minute still waits for a human ok', () => {
  const text = renderWorkspace({
    person: 'keshav',
    folder: 'atris',
    task: {
      title: 'Print a human line like 4 words so the count is easy to read.',
      status: 'review',
      display_id: 'UNW-4',
      review: { agent_review_pass_count: 1 },
    },
    nextCommand: 'atris task accept UNW-4',
  });
  assert.match(text, /one finished thing is waiting for your ok \(UNW-4\)\./);
  assert.doesNotMatch(text, /you already shipped/);
  assert.doesNotMatch(text, /review-chat/);
  assert.match(text, /^next: atris task accept UNW-4$/m);
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
  assert.match(text, /hey keshav, launch-day is empty\./);
  assert.doesNotMatch(text, /I'll set this up when you want/);
  assert.match(text, /^next: atris "what should launch-day be\?"$/m);
  assert.doesNotMatch(text, /atris init --minimal/);
  assert.equal(spokenLineCount(text), 2);
  assert.equal(firstTalkCommand('launch-day'), 'atris "what should launch-day be?"');
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
    assert.equal(screen.nextCommand, 'atris task show CLI-9');
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
    assert.match(screen.text, /one finished thing is waiting for your ok \(UNW-2\)/);
    assert.doesNotMatch(screen.text, /you already shipped/);
    assert.doesNotMatch(screen.text, /review-chat/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('empty dir bare atris starts a conversation, stays short, and does not hang', () => {
  const dir = makeTempDir();
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  try {
    const res = runCli([], {
      cwd: dir,
      env: { HOME: home, USER: 'keshav', ATRIS_TASKS_DB: path.join(dir, 'tasks.db') },
    });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.match(res.stdout, /this folder is empty/);
    assert.match(res.stdout, /atris "what should this folder be\?"/);
    assert.match(res.stdout, /hey keshav,/);
    assert.doesNotMatch(res.stdout, /I'll set this up when you want/);
    assert.doesNotMatch(res.stdout, /atris init --minimal/);
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
    assert.match(res.stdout, /hey keshav, launch-day is empty\./);
    assert.doesNotMatch(res.stdout, /I'll set this up when you want/);
    assert.match(res.stdout, /^next: atris "what should launch-day be\?"$/m);
    assert.doesNotMatch(res.stdout, /atris init --minimal/);
    assert.doesNotMatch(res.stdout, /this folder is empty/);
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
    assert.equal(payload.next_action, 'atris "what should this folder be?"');
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
    assert.match(blocked.stdout, /^next: atris "what should this folder be\?"$/m);
    assert.doesNotMatch(blocked.stdout, /atris init --minimal/);
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
    assert.match(res.stdout, /^next: atris task show CLI-9$/m);
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
    assert.match(res.stdout, /one finished thing is waiting for your ok \(UNW-2\)/);
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

test('atris test in an empty folder still names init', () => {
  const dir = makeTempDir();
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  try {
    const res = runCli(['test'], {
      cwd: dir,
      env: { HOME: home, USER: 'keshav', ATRIS_TASKS_DB: path.join(dir, 'tasks.db') },
    });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.match(res.stdout, /this folder is empty/);
    assert.match(res.stdout, /^next: atris "what should this folder be\?"$/m);
    assert.doesNotMatch(res.stdout, /BOOTSTRAP REQUIRED|For an agent|generate a complete `atris\/MAP\.md`/);
    assert.doesNotMatch(res.stdout, /Got it\. I saved your first direction|First useful step: test/);
    assert.equal(fs.existsSync(path.join(dir, 'atris')), false);
  } finally {
    cleanupTempDir(dir);
  }
});

test('atris plan in an empty folder talks like first-minute', () => {
  const dir = makeTempDir();
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  const env = { HOME: home, USER: 'keshav', ATRIS_TASKS_DB: path.join(dir, 'tasks.db') };
  try {
    const minute = runCli([], { cwd: dir, env });
    const planned = runCli(['plan'], { cwd: dir, env });
    assert.equal(minute.status, 0, minute.stderr || minute.stdout);
    assert.equal(planned.status, 0, planned.stderr || planned.stdout);
    assert.equal(planned.stdout.trim(), minute.stdout.trim());
    assert.match(planned.stdout, /this folder is empty/);
    assert.match(planned.stdout, /^next: atris "what should this folder be\?"$/m);
    assert.equal(spokenLineCount(planned.stdout), spokenLineCount(minute.stdout));
    assert.doesNotMatch(planned.stdout, /navigator\.md|Run "atris init"/);
    assert.equal(fs.existsSync(path.join(dir, 'atris')), false);

    const help = runCli(['plan', '--help'], { cwd: dir, env });
    assert.equal(help.status, 0, help.stderr || help.stdout);
    assert.match(help.stdout, /Usage: atris plan/);
    assert.match(help.stdout, /--prompt/);
    assert.doesNotMatch(help.stdout, /clean start|navigator\.md/);
    assert.equal(fs.existsSync(path.join(dir, 'atris')), false);
  } finally {
    cleanupTempDir(dir);
  }
});

test('atris review in an empty folder talks like first-minute', () => {
  const dir = makeTempDir();
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  const env = { HOME: home, USER: 'keshav', ATRIS_TASKS_DB: path.join(dir, 'tasks.db') };
  try {
    const minute = runCli([], { cwd: dir, env });
    const review = runCli(['review'], { cwd: dir, env });
    assert.equal(minute.status, 0, minute.stderr || minute.stdout);
    assert.equal(review.status, 0, review.stderr || review.stdout);
    assert.equal(review.stdout.trim(), minute.stdout.trim());
    assert.match(review.stdout, /this folder is empty/);
    assert.match(review.stdout, /^next: atris "what should this folder be\?"$/m);
    assert.equal(spokenLineCount(review.stdout), spokenLineCount(minute.stdout));
    assert.notEqual(review.stdout.trim(), 'nothing is waiting on you.');
    assert.doesNotMatch(review.stdout, /^nothing is waiting on you\.$/m);
    assert.doesNotMatch(review.stdout, /validator\.md|Run "atris init"/);
    assert.equal(fs.existsSync(path.join(dir, 'atris')), false);

    const help = runCli(['review', '--help'], { cwd: dir, env });
    assert.equal(help.status, 0, help.stderr || help.stdout);
    assert.match(help.stdout, /Usage: atris review/);
    assert.doesNotMatch(help.stdout, /clean start|nothing is waiting on you|validator\.md/);
    assert.equal(fs.existsSync(path.join(dir, 'atris')), false);
  } finally {
    cleanupTempDir(dir);
  }
});

test('atris do in an empty folder talks like first-minute', () => {
  const dir = makeTempDir();
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  const env = { HOME: home, USER: 'keshav', ATRIS_TASKS_DB: path.join(dir, 'tasks.db') };
  try {
    const minute = runCli([], { cwd: dir, env });
    const doit = runCli(['do'], { cwd: dir, env });
    assert.equal(minute.status, 0, minute.stderr || minute.stdout);
    assert.equal(doit.status, 0, doit.stderr || doit.stdout);
    assert.equal(doit.stdout.trim(), minute.stdout.trim());
    assert.match(doit.stdout, /this folder is empty/);
    assert.match(doit.stdout, /^next: atris "what should this folder be\?"$/m);
    assert.equal(spokenLineCount(doit.stdout), spokenLineCount(minute.stdout));
    assert.doesNotMatch(doit.stdout, /executor\.md|Run "atris init"/);
    assert.equal(fs.existsSync(path.join(dir, 'atris')), false);
  } finally {
    cleanupTempDir(dir);
  }
});

test('atris do after init and claim stays in the room', () => {
  const dir = makeTempDir();
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  const env = { HOME: home, USER: 'keshav', ATRIS_OPERATOR: 'keshav', ATRIS_TASKS_DB: path.join(dir, 'tasks.db') };
  try {
    const init = runCli(['init', '--yes', '--minimal'], { cwd: dir, env, timeout: 60000 });
    assert.equal(init.status, 0, init.stderr || init.stdout);
    assert.ok(fs.existsSync(path.join(dir, 'atris', 'MAP.md')));

    const before = runCli([], { cwd: dir, env });
    assert.equal(before.status, 0, before.stderr || before.stdout);
    const claim = nextLine(before.stdout);
    assert.match(claim, /^atris task claim \S+ --as keshav$/);

    const claimed = runCli(claim.replace(/^atris /, '').split(' '), { cwd: dir, env });
    assert.equal(claimed.status, 0, claimed.stderr || claimed.stdout);

    const minute = runCli([], { cwd: dir, env });
    const doit = runCli(['do'], { cwd: dir, env });
    const planned = runCli(['plan'], { cwd: dir, env });
    assert.equal(minute.status, 0, minute.stderr || minute.stdout);
    assert.equal(doit.status, 0, doit.stderr || doit.stdout);
    assert.equal(planned.status, 0, planned.stderr || planned.stdout);
    assert.equal(doit.stdout.trim(), minute.stdout.trim());
    assert.equal(planned.stdout.trim(), minute.stdout.trim());
    assert.match(minute.stdout, /already yours/);
    assert.match(nextLine(doit.stdout), /^atris task show \S+$/);
    assert.equal(nextLine(doit.stdout), nextLine(minute.stdout));
    assert.equal(spokenLineCount(doit.stdout), 2);
    assert.doesNotMatch(doit.stdout + planned.stdout, /executor\.md not found|navigator\.md not found|Run "atris init"/);
    assert.doesNotMatch(doit.stdout + planned.stdout, /PROMPT ONLY|What do you want to build/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('atris task next in an empty folder talks like first-minute', () => {
  const dir = makeTempDir();
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  const env = { HOME: home, USER: 'keshav', ATRIS_TASKS_DB: path.join(dir, 'tasks.db') };
  try {
    const minute = runCli([], { cwd: dir, env });
    const task = runCli(['task'], { cwd: dir, env });
    const next = runCli(['task', 'next'], { cwd: dir, env });
    assert.equal(minute.status, 0, minute.stderr || minute.stdout);
    assert.equal(task.status, 0, task.stderr || task.stdout);
    assert.equal(next.status, 0, next.stderr || next.stdout);
    assert.equal(task.stdout.trim(), minute.stdout.trim());
    assert.equal(next.stdout.trim(), minute.stdout.trim());
    assert.match(next.stdout, /this folder is empty/);
    assert.match(next.stdout, /^next: atris "what should this folder be\?"$/m);
    assert.equal(spokenLineCount(next.stdout), spokenLineCount(minute.stdout));
    assert.doesNotMatch(next.stdout, /No open tasks|atris task new/);
    assert.equal(fs.existsSync(path.join(dir, 'atris')), false);
    assert.equal(fs.existsSync(path.join(dir, '.atris')), false);

    const help = runCli(['task', 'next', '--help'], { cwd: dir, env });
    assert.equal(help.status, 0, help.stderr || help.stdout);
    assert.match(help.stdout, /Usage: atris task next/);
    assert.doesNotMatch(help.stdout, /clean start|No open tasks|atris task new/);
    assert.equal(fs.existsSync(path.join(dir, 'atris')), false);
    assert.equal(fs.existsSync(path.join(dir, '.atris')), false);
  } finally {
    cleanupTempDir(dir);
  }
});

test('atris task new in an empty folder talks like first-minute', () => {
  const dir = makeTempDir();
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  const env = { HOME: home, USER: 'keshav', ATRIS_TASKS_DB: path.join(dir, 'tasks.db') };
  try {
    const minute = runCli([], { cwd: dir, env });
    const created = runCli(['task', 'new', 'count the words'], { cwd: dir, env });
    assert.equal(minute.status, 0, minute.stderr || minute.stdout);
    assert.equal(created.status, 0, created.stderr || created.stdout);
    assert.equal(created.stdout.trim(), minute.stdout.trim());
    assert.match(created.stdout, /this folder is empty/);
    assert.match(created.stdout, /^next: atris "what should this folder be\?"$/m);
    assert.equal(spokenLineCount(created.stdout), spokenLineCount(minute.stdout));
    assert.doesNotMatch(created.stdout, /count the words/);
    assert.doesNotMatch(created.stdout, /TH\d|WRK-|CLI-|Warning: put the why|No open tasks|TASK DESK/);
    assert.doesNotMatch(created.stderr, /Warning: put the why/);
    assert.equal(fs.existsSync(path.join(dir, 'atris')), false);
    assert.equal(fs.existsSync(path.join(dir, '.atris')), false);
    assert.equal(fs.existsSync(path.join(dir, '.atris', 'state', 'tasks.projection.json')), false);

    const help = runCli(['task', 'new', '--help'], { cwd: dir, env });
    assert.equal(help.status, 0, help.stderr || help.stdout);
    assert.match(help.stdout, /atris task new/);
    assert.doesNotMatch(help.stdout, /clean start|count the words/);
    assert.equal(fs.existsSync(path.join(dir, 'atris')), false);
    assert.equal(fs.existsSync(path.join(dir, '.atris')), false);
  } finally {
    cleanupTempDir(dir);
  }
});

test('atris ask and mission in an empty folder talk like first-minute', () => {
  const dir = makeTempDir();
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  const env = { HOME: home, USER: 'keshav', ATRIS_TASKS_DB: path.join(dir, 'tasks.db') };
  try {
    const minute = runCli([], { cwd: dir, env });
    const asked = runCli(['ask'], { cwd: dir, env });
    const askedWant = runCli(['ask', 'make', 'the', 'home', 'page', 'clearer'], { cwd: dir, env });
    const mission = runCli(['mission'], { cwd: dir, env });
    assert.equal(minute.status, 0, minute.stderr || minute.stdout);
    assert.equal(asked.status, 0, asked.stderr || asked.stdout);
    assert.equal(askedWant.status, 0, askedWant.stderr || askedWant.stdout);
    assert.equal(mission.status, 0, mission.stderr || mission.stdout);
    assert.equal(asked.stdout.trim(), minute.stdout.trim());
    assert.equal(askedWant.stdout.trim(), minute.stdout.trim());
    assert.equal(mission.stdout.trim(), minute.stdout.trim());
    assert.match(asked.stdout, /this folder is empty/);
    assert.match(mission.stdout, /this folder is empty/);
    assert.match(asked.stdout, /^next: atris "what should this folder be\?"$/m);
    assert.match(mission.stdout, /^next: atris "what should this folder be\?"$/m);
    assert.equal(spokenLineCount(asked.stdout), spokenLineCount(minute.stdout));
    assert.equal(spokenLineCount(mission.stdout), spokenLineCount(minute.stdout));
    assert.doesNotMatch(asked.stdout, /business\.json|cloud-computer|--mission|Start one with|Atris needs to know what you want/);
    assert.doesNotMatch(mission.stdout, /business\.json|cloud-computer|--mission|Start one with|could not find a running mission/);
    assert.equal(fs.existsSync(path.join(dir, 'atris')), false);
    assert.equal(fs.existsSync(path.join(dir, '.atris')), false);

    const askHelp = runCli(['ask', '--help'], { cwd: dir, env });
    assert.equal(askHelp.status, 0, askHelp.stderr || askHelp.stdout);
    assert.match(askHelp.stdout, /Usage: atris ask/);
    assert.doesNotMatch(askHelp.stdout, /clean start|business\.json|--mission/);
    assert.equal(fs.existsSync(path.join(dir, 'atris')), false);

    const missionHelp = runCli(['mission', '--help'], { cwd: dir, env });
    assert.equal(missionHelp.status, 0, missionHelp.stderr || missionHelp.stdout);
    assert.match(missionHelp.stdout, /Usage: atris mission|atris mission /);
    assert.doesNotMatch(missionHelp.stdout, /clean start|business\.json|Start one with/);
    assert.equal(fs.existsSync(path.join(dir, 'atris')), false);
    assert.equal(fs.existsSync(path.join(dir, '.atris')), false);
  } finally {
    cleanupTempDir(dir);
  }
});

test('atris wish in an empty folder talks like first-minute', () => {
  const dir = makeTempDir();
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  const env = {
    HOME: home,
    USER: 'keshav',
    ATRIS_TASKS_DB: path.join(dir, 'tasks.db'),
    ATRIS_WISH_NO_DRIVER: '1',
  };
  try {
    const minute = runCli([], { cwd: dir, env });
    const wish = runCli(['wish'], { cwd: dir, env });
    assert.equal(minute.status, 0, minute.stderr || minute.stdout);
    assert.equal(wish.status, 0, wish.stderr || wish.stdout);
    assert.equal(wish.stdout.trim(), minute.stdout.trim());
    assert.match(wish.stdout, /this folder is empty/);
    assert.match(wish.stdout, /^next: atris "what should this folder be\?"$/m);
    assert.equal(spokenLineCount(wish.stdout), spokenLineCount(minute.stdout));
    assert.doesNotMatch(wish.stdout, /Usage: atris wish|wish list|wish grant|wish stats|wish board|wish rewards/);
    assert.doesNotMatch(wish.stdout, /Run "atris init"/);
    assert.equal(fs.existsSync(path.join(dir, 'atris')), false);

    const leftover = runCli(['wish', 'count the words'], { cwd: dir, env });
    assert.equal(leftover.status, 0, leftover.stderr || leftover.stdout);
    assert.equal(leftover.stdout.trim(), minute.stdout.trim());
    assert.match(leftover.stdout, /this folder is empty/);
    assert.match(leftover.stdout, /^next: atris "what should this folder be\?"$/m);
    assert.equal(spokenLineCount(leftover.stdout), spokenLineCount(minute.stdout));
    assert.doesNotMatch(leftover.stdout, /Got it/);
    assert.doesNotMatch(leftover.stdout, /Usage: atris wish|wish list|wish grant|waiting on you/);
    assert.equal(fs.existsSync(path.join(dir, 'atris')), false);
    assert.equal(fs.existsSync(path.join(dir, '.atris')), false);
    assert.equal(fs.existsSync(path.join(dir, '.atris', 'state', 'wishes.jsonl')), false);

    const help = runCli(['wish', '--help'], { cwd: dir, env });
    assert.equal(help.status, 0, help.stderr || help.stdout);
    assert.match(help.stdout, /Usage: atris wish/);
    assert.doesNotMatch(help.stdout, /clean start|Got it/);
    assert.equal(fs.existsSync(path.join(dir, 'atris')), false);
    assert.equal(fs.existsSync(path.join(dir, '.atris')), false);
  } finally {
    cleanupTempDir(dir);
  }
});

test('atris log in an empty folder talks like first-minute', () => {
  const dir = makeTempDir();
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  const env = { HOME: home, USER: 'keshav', ATRIS_TASKS_DB: path.join(dir, 'tasks.db') };
  try {
    const minute = runCli([], { cwd: dir, env });
    const logged = runCli(['log'], { cwd: dir, env });
    const leftover = runCli(['log', 'friction'], { cwd: dir, env });
    assert.equal(minute.status, 0, minute.stderr || minute.stdout);
    assert.equal(logged.status, 0, logged.stderr || logged.stdout);
    assert.equal(leftover.status, 0, leftover.stderr || leftover.stdout);
    assert.equal(logged.stdout.trim(), minute.stdout.trim());
    assert.equal(leftover.stdout.trim(), minute.stdout.trim());
    assert.match(leftover.stdout, /this folder is empty/);
    assert.match(leftover.stdout, /^next: atris "what should this folder be\?"$/m);
    assert.equal(spokenLineCount(leftover.stdout), spokenLineCount(minute.stdout));
    assert.doesNotMatch(leftover.stdout + leftover.stderr, /folder not found|Run "atris init"|captured I|journal:/);
    assert.equal(fs.existsSync(path.join(dir, 'atris')), false);
    assert.equal(fs.existsSync(path.join(dir, 'atris', 'logs')), false);

    const jsonMinute = runCli(['--json'], { cwd: dir, env });
    const jsonLog = runCli(['log', '--json'], { cwd: dir, env });
    const jsonNote = runCli(['log', 'friction', '--json'], { cwd: dir, env });
    assert.equal(jsonLog.status, jsonMinute.status);
    assert.equal(jsonNote.status, jsonMinute.status);
    assert.deepEqual(JSON.parse(jsonLog.stdout), JSON.parse(jsonMinute.stdout));
    assert.deepEqual(JSON.parse(jsonNote.stdout), JSON.parse(jsonMinute.stdout));
    assert.doesNotMatch(jsonNote.stdout, /folder not found|inbox_capture|captured I/);
    assert.equal(fs.existsSync(path.join(dir, 'atris')), false);
    assert.equal(fs.existsSync(path.join(dir, 'atris', 'logs')), false);

    const help = runCli(['log', '--help'], { cwd: dir, env });
    assert.equal(help.status, 0, help.stderr || help.stdout);
    assert.match(help.stdout, /Usage: atris log/);
    assert.doesNotMatch(help.stdout, /clean start|folder not found|captured I/);
    assert.equal(fs.existsSync(path.join(dir, 'atris')), false);
    assert.equal(fs.existsSync(path.join(dir, 'atris', 'logs')), false);

    const init = runCli(['init', '--yes', '--minimal'], { cwd: dir, env, timeout: 60000 });
    assert.equal(init.status, 0, init.stderr || init.stdout);
    const captured = runCli(['log', 'friction'], { cwd: dir, env });
    assert.equal(captured.status, 0, captured.stderr || captured.stdout);
    assert.match(captured.stdout, /captured I\d+: friction/);
    assert.doesNotMatch(captured.stdout + captured.stderr, /folder not found|Business not found/i);
    const jsonCapture = runCli(['log', 'later', '--json'], { cwd: dir, env });
    assert.equal(jsonCapture.status, 0, jsonCapture.stderr || jsonCapture.stdout);
    const payload = JSON.parse(jsonCapture.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.action, 'inbox_capture');
    assert.equal(payload.note, 'later');
  } finally {
    cleanupTempDir(dir);
  }
});

test('atris brainstorm in an empty folder talks like first-minute', () => {
  const dir = makeTempDir();
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  const env = { HOME: home, USER: 'keshav', ATRIS_TASKS_DB: path.join(dir, 'tasks.db') };
  try {
    const minute = runCli([], { cwd: dir, env });
    const leftover = runCli(['brainstorm', 'count words'], { cwd: dir, env });
    assert.equal(minute.status, 0, minute.stderr || minute.stdout);
    assert.equal(leftover.status, 0, leftover.stderr || leftover.stdout);
    assert.equal(leftover.stdout.trim(), minute.stdout.trim());
    assert.match(leftover.stdout, /this folder is empty/);
    assert.match(leftover.stdout, /^next: atris "what should this folder be\?"$/m);
    assert.equal(spokenLineCount(leftover.stdout), spokenLineCount(minute.stdout));
    assert.doesNotMatch(leftover.stdout + leftover.stderr, /folder not found|Run "atris init"|captured I|journal:|Describe the desired outcome/);
    assert.equal(fs.existsSync(path.join(dir, 'atris')), false);
    assert.equal(fs.existsSync(path.join(dir, '.atris')), false);

    const jsonMinute = runCli(['--json'], { cwd: dir, env });
    const jsonIdea = runCli(['brainstorm', 'count words', '--json'], { cwd: dir, env });
    assert.equal(jsonIdea.status, jsonMinute.status);
    assert.deepEqual(JSON.parse(jsonIdea.stdout), JSON.parse(jsonMinute.stdout));
    assert.doesNotMatch(jsonIdea.stdout, /folder not found|captured I|inbox_id/);
    assert.equal(fs.existsSync(path.join(dir, 'atris')), false);
    assert.equal(fs.existsSync(path.join(dir, '.atris')), false);

    const help = runCli(['brainstorm', '--help'], { cwd: dir, env });
    assert.equal(help.status, 0, help.stderr || help.stdout);
    assert.match(help.stdout, /Usage: atris brainstorm/);
    assert.doesNotMatch(help.stdout, /clean start|folder not found|captured I/);
    assert.equal(fs.existsSync(path.join(dir, 'atris')), false);
    assert.equal(fs.existsSync(path.join(dir, '.atris')), false);

    const init = runCli(['init', '--yes', '--minimal'], { cwd: dir, env, timeout: 60000 });
    assert.equal(init.status, 0, init.stderr || init.stdout);
    const captured = runCli(['brainstorm', 'count words'], { cwd: dir, env });
    assert.equal(captured.status, 0, captured.stderr || captured.stdout);
    assert.match(captured.stdout, /captured I\d+: count words/);
    assert.doesNotMatch(captured.stdout + captured.stderr, /folder not found|Describe the desired outcome/);
    const jsonCapture = runCli(['brainstorm', 'later', '--json'], { cwd: dir, env });
    assert.equal(jsonCapture.status, 0, jsonCapture.stderr || jsonCapture.stdout);
    const payload = JSON.parse(jsonCapture.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.action, 'captured');
    assert.equal(payload.text, 'later');
  } finally {
    cleanupTempDir(dir);
  }
});

test('atris test after init --minimal talks like first-minute, not bootstrap', () => {
  const dir = makeTempDir();
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  const env = {
    HOME: home,
    USER: 'keshav',
    ATRIS_NO_INTERACTIVE: '1',
    ATRIS_TASKS_DB: path.join(dir, 'tasks.db'),
  };
  try {
    const init = runCli(['init', '--yes', '--minimal'], { cwd: dir, env, timeout: 60000 });
    assert.equal(init.status, 0, init.stderr || init.stdout);
    assert.match(init.stdout, /generate map\.md/i);
    assert.match(init.stdout, /^next: atris task claim /m);

    const minute = runCli([], { cwd: dir, env });
    const verb = runCli(['test'], { cwd: dir, env });
    assert.equal(minute.status, 0, minute.stderr || minute.stdout);
    assert.equal(verb.status, 0, verb.stderr || verb.stdout);
    assert.match(verb.stdout, /generate map\.md/i);
    assert.match(verb.stdout, /ready to claim|already yours/);
    assert.equal(nextLine(verb.stdout), nextLine(minute.stdout));
    assert.match(nextLine(verb.stdout), /^atris task (claim|show|ready) /);
    assert.equal(verb.stdout.match(/^next:/mg).length, 1);
    assert.doesNotMatch(verb.stdout, /BOOTSTRAP REQUIRED|For an agent|generate a complete `atris\/MAP\.md`/);
    assert.doesNotMatch(verb.stdout, /Got it\. I saved your first direction|First useful step: test|next setup: open atris\/MAP\.md/);

    const claim = nextLine(minute.stdout).match(/^atris task claim (\S+) --as (\S+)$/);
    assert.ok(claim, `expected claim next, got: ${nextLine(minute.stdout)}`);
    const claimed = runCli(['task', 'claim', claim[1], '--as', claim[2]], { cwd: dir, env });
    assert.equal(claimed.status, 0, claimed.stderr || claimed.stdout);

    const afterMinute = runCli([], { cwd: dir, env });
    const afterVerb = runCli(['test'], { cwd: dir, env });
    assert.equal(afterMinute.status, 0, afterMinute.stderr || afterMinute.stdout);
    assert.equal(afterVerb.status, 0, afterVerb.stderr || afterVerb.stdout);
    assert.match(afterVerb.stdout, /already yours/);
    assert.equal(nextLine(afterVerb.stdout), nextLine(afterMinute.stdout));
    assert.equal(nextLine(afterVerb.stdout), `atris task show ${claim[1]}`);
    assert.doesNotMatch(afterVerb.stdout, /BOOTSTRAP REQUIRED|For an agent|generate a complete `atris\/MAP\.md`/);
    assert.doesNotMatch(afterVerb.stdout, /Got it\. I saved your first direction|First useful step: test|next setup: open atris\/MAP\.md/);

    fs.rmSync(path.join(dir, 'atris', 'MAP.md'), { force: true });
    const missing = runCli(['test'], { cwd: dir, env });
    assert.equal(missing.status, 0, missing.stderr || missing.stdout);
    assert.equal(nextLine(missing.stdout), `atris task show ${claim[1]}`);
    assert.doesNotMatch(missing.stdout, /BOOTSTRAP REQUIRED|For an agent|generate a complete `atris\/MAP\.md`/);

    const json = runCli(['test', '--json'], { cwd: dir, env });
    assert.equal(json.status, 2, json.stderr || json.stdout);
    const payload = JSON.parse(json.stdout);
    assert.equal(payload.next_action, `atris task show ${claim[1]}`);
    assert.notEqual(payload.next_action, 'atris init --yes');
  } finally {
    cleanupTempDir(dir);
  }
});

test('atris do and plan after init --minimal stay two spoken lines', () => {
  const dir = makeTempDir();
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  const env = {
    HOME: home,
    USER: 'keshav',
    ATRIS_NO_INTERACTIVE: '1',
    ATRIS_TASKS_DB: path.join(dir, 'tasks.db'),
  };
  try {
    const init = runCli(['init', '--yes', '--minimal'], { cwd: dir, env, timeout: 60000 });
    assert.equal(init.status, 0, init.stderr || init.stdout);

    const minute = runCli([], { cwd: dir, env });
    const planned = runCli(['plan'], { cwd: dir, env });
    const doit = runCli(['do'], { cwd: dir, env });
    assert.equal(minute.status, 0, minute.stderr || minute.stdout);
    assert.equal(planned.status, 0, planned.stderr || planned.stdout);
    assert.equal(doit.status, 0, doit.stderr || doit.stdout);
    assert.equal(planned.stdout.trim(), minute.stdout.trim());
    assert.equal(doit.stdout.trim(), minute.stdout.trim());
    assert.equal(spokenLineCount(planned.stdout), 2);
    assert.equal(spokenLineCount(doit.stdout), 2);
    assert.doesNotMatch(planned.stdout, /PROMPT ONLY|Atris Plan|You are the Navigator/);
    assert.doesNotMatch(doit.stdout, /PROMPT ONLY|Atris Do|You are the Executor/);
    assert.doesNotMatch(planned.stdout + doit.stdout, /clean start|Run "atris init"/);

    const planPrompt = runCli(['plan', '--prompt'], { cwd: dir, env });
    const doPrompt = runCli(['do', '--prompt'], { cwd: dir, env });
    assert.equal(planPrompt.status, 0, planPrompt.stderr || planPrompt.stdout);
    assert.equal(doPrompt.status, 0, doPrompt.stderr || doPrompt.stdout);
    assert.match(planPrompt.stdout, /^PROMPT ONLY/m);
    assert.match(planPrompt.stdout, /You are the Navigator\./);
    assert.match(doPrompt.stdout, /^PROMPT ONLY/m);
    assert.match(doPrompt.stdout, /You are the Executor\./);

    const asked = runCli(['plan', 'ship', 'the', 'landing', 'page'], { cwd: dir, env });
    assert.equal(asked.status, 0, asked.stderr || asked.stdout);
    assert.match(asked.stdout, /DIRECT REQUEST/);
    assert.match(asked.stdout, /ship the landing page/);
    assert.doesNotMatch(asked.stdout, /Run "atris init"/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('atris review after init --minimal matches bare atris claim next', () => {
  const dir = makeTempDir();
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  const env = {
    HOME: home,
    USER: 'keshav',
    ATRIS_NO_INTERACTIVE: '1',
    ATRIS_TASKS_DB: path.join(dir, 'tasks.db'),
  };
  try {
    const init = runCli(['init', '--yes', '--minimal'], { cwd: dir, env, timeout: 60000 });
    assert.equal(init.status, 0, init.stderr || init.stdout);
    assert.match(init.stdout, /^next: atris task claim /m);

    const minute = runCli([], { cwd: dir, env });
    const review = runCli(['review'], { cwd: dir, env });
    assert.equal(minute.status, 0, minute.stderr || minute.stdout);
    assert.equal(review.status, 0, review.stderr || review.stdout);
    assert.equal(review.stdout.trim(), minute.stdout.trim());
    assert.match(review.stdout, /ready to claim/);
    assert.match(nextLine(review.stdout), /^atris task claim \S+ --as \S+$/);
    assert.equal(nextLine(review.stdout), nextLine(minute.stdout));
    assert.equal(spokenLineCount(review.stdout), spokenLineCount(minute.stdout));
    assert.equal(spokenLineCount(review.stdout), 2);
    assert.doesNotMatch(review.stdout, /^nothing is waiting on you\.$/m);
    assert.doesNotMatch(review.stdout, /clean start|atris init --minimal|validator\.md not found|Run "atris init"/);
    assert.doesNotMatch(review.stdout, /Atris Review is the human checkpoint|Need the legacy Validator/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('atris task next after init --minimal stays in the room', () => {
  const dir = makeTempDir();
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  const env = {
    HOME: home,
    USER: 'keshav',
    ATRIS_NO_INTERACTIVE: '1',
    ATRIS_TASKS_DB: path.join(dir, 'tasks.db'),
  };
  try {
    const init = runCli(['init', '--yes', '--minimal'], { cwd: dir, env, timeout: 60000 });
    assert.equal(init.status, 0, init.stderr || init.stdout);

    const minute = runCli([], { cwd: dir, env });
    const task = runCli(['task'], { cwd: dir, env });
    const next = runCli(['task', 'next'], { cwd: dir, env });
    assert.equal(minute.status, 0, minute.stderr || minute.stdout);
    assert.equal(task.status, 0, task.stderr || task.stdout);
    assert.equal(next.status, 0, next.stderr || next.stdout);
    assert.equal(task.stdout.trim(), minute.stdout.trim());
    assert.equal(nextLine(next.stdout), nextLine(minute.stdout));
    assert.match(nextLine(next.stdout), /^atris task (claim|show|ready) /);
    assert.doesNotMatch(next.stdout, /clean start|atris init --minimal|atris task new/);
    assert.doesNotMatch(task.stdout, /clean start|atris init --minimal|No open tasks/);
    assert.equal(next.stdout.match(/^next:/mg).length, 1);

    const filed = runCli(['task', 'new', 'count the words'], { cwd: dir, env });
    assert.equal(filed.status, 0, filed.stderr || filed.stdout);
    assert.match(filed.stdout, /count the words/);
    assert.doesNotMatch(filed.stdout, /this folder is empty|atris init --minimal/);
    assert.equal(fs.existsSync(path.join(dir, '.atris', 'state', 'tasks.projection.json')), true);
  } finally {
    cleanupTempDir(dir);
  }
});

test('atris ask and mission after init --minimal stay in the room', () => {
  const dir = makeTempDir();
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  const env = {
    HOME: home,
    USER: 'keshav',
    ATRIS_NO_INTERACTIVE: '1',
    ATRIS_TASKS_DB: path.join(dir, 'tasks.db'),
  };
  try {
    const init = runCli(['init', '--yes', '--minimal'], { cwd: dir, env, timeout: 60000 });
    assert.equal(init.status, 0, init.stderr || init.stdout);

    const minute = runCli([], { cwd: dir, env });
    const asked = runCli(['ask'], { cwd: dir, env });
    const mission = runCli(['mission'], { cwd: dir, env });
    assert.equal(minute.status, 0, minute.stderr || minute.stdout);
    assert.equal(asked.status, 0, asked.stderr || asked.stdout);
    assert.equal(asked.stdout.trim(), minute.stdout.trim());
    assert.match(asked.stdout, /generate map\.md/i);
    assert.match(asked.stdout, /ready to claim|already yours/);
    assert.equal(nextLine(asked.stdout), nextLine(minute.stdout));
    assert.match(nextLine(asked.stdout), /^atris task (claim|show|ready) /);
    assert.equal(asked.stdout.match(/^next:/mg).length, 1);
    assert.doesNotMatch(asked.stdout, /clean start|atris init --minimal|business\.json|--mission|Start one with/);
    assert.doesNotMatch(asked.stdout + asked.stderr, /Atris needs to know what you want/);

    assert.equal(mission.status, 0, mission.stderr || mission.stdout);
    assert.equal(mission.stdout.trim(), minute.stdout.trim());
    assert.match(mission.stdout, /generate map\.md/i);
    assert.match(mission.stdout, /ready to claim|already yours/);
    assert.equal(nextLine(mission.stdout), nextLine(minute.stdout));
    assert.match(nextLine(mission.stdout), /^atris task (claim|show|ready) /);
    assert.equal(mission.stdout.match(/^next:/mg).length, 1);
    assert.doesNotMatch(mission.stdout + mission.stderr, /clean start|atris init --minimal|business\.json|--mission|Start one with|could not find a running mission|not signed in|Atris left your work unchanged/);

    const missionHelp = runCli(['mission', '--help'], { cwd: dir, env });
    assert.equal(missionHelp.status, 0, missionHelp.stderr || missionHelp.stdout);
    assert.match(missionHelp.stdout, /Usage: atris mission|atris mission /);
    assert.doesNotMatch(missionHelp.stdout, /clean start|generate map|business\.json|Start one with/);
    assert.equal(fs.existsSync(path.join(dir, '.atris', 'state', 'missions.jsonl')), false);

    fs.mkdirSync(path.join(dir, '.atris', 'state'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.atris', 'state', 'missions.jsonl'), `${JSON.stringify({
      schema: 'atris.mission.v1',
      id: 'mission-live',
      objective: 'Keep the live mission visible',
      owner: 'executor',
      status: 'running',
      created_at: '2026-08-26T12:00:00Z',
      updated_at: '2026-08-26T12:01:00Z',
    })}\n`);
    const live = runCli(['mission', '--json'], { cwd: dir, env });
    assert.equal(live.status, 0, live.stderr || live.stdout);
    const livePayload = JSON.parse(live.stdout);
    assert.equal(livePayload.action, 'mission_status');
    assert.equal(livePayload.missions[0].id, 'mission-live');
    assert.doesNotMatch(live.stdout, /ready to claim|Start one with|atris ask/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('atris wish after init --minimal stays in the room', () => {
  const dir = makeTempDir();
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  const env = {
    HOME: home,
    USER: 'keshav',
    ATRIS_NO_INTERACTIVE: '1',
    ATRIS_TASKS_DB: path.join(dir, 'tasks.db'),
  };
  try {
    const init = runCli(['init', '--yes', '--minimal'], { cwd: dir, env, timeout: 60000 });
    assert.equal(init.status, 0, init.stderr || init.stdout);

    const minute = runCli([], { cwd: dir, env });
    const wish = runCli(['wish'], { cwd: dir, env });
    assert.equal(minute.status, 0, minute.stderr || minute.stdout);
    assert.equal(wish.status, 0, wish.stderr || wish.stdout);
    assert.equal(wish.stdout.trim(), minute.stdout.trim());
    assert.match(wish.stdout, /generate map\.md/i);
    assert.match(wish.stdout, /ready to claim|already yours/);
    assert.equal(nextLine(wish.stdout), nextLine(minute.stdout));
    assert.match(nextLine(wish.stdout), /^atris task (claim|show|ready) /);
    assert.equal(wish.stdout.match(/^next:/mg).length, 1);
    assert.doesNotMatch(wish.stdout, /Usage: atris wish|wish list|wish grant|wish stats/);
    assert.doesNotMatch(wish.stdout, /clean start|atris init --minimal|Run "atris init"/);
    assert.doesNotMatch(wish.stdout, /BOOTSTRAP REQUIRED|For an agent|generate a complete `atris\/MAP\.md`/);

    const filed = runCli(['wish', 'count the words'], {
      cwd: dir,
      env: { ...env, ATRIS_WISH_NO_DRIVER: '1' },
    });
    assert.notEqual(filed.status, null, filed.stderr || filed.stdout);
    assert.match(filed.stdout, /Got it: "count the words"/);
    assert.doesNotMatch(filed.stdout, /this folder is empty|atris init --minimal/);
    assert.equal(fs.existsSync(path.join(dir, '.atris', 'state', 'wishes.jsonl')), true);
  } finally {
    cleanupTempDir(dir);
  }
});

test('completed history does not say shipped when other work is still live', () => {
  const text = renderWorkspace({
    person: 'keshav',
    folder: 'launch-day',
    completedTitle: '**[CLI-1241]** drill and help smoke',
    nextCommand: 'atris do',
    liveWork: true,
  });
  assert.match(text, /launch-day has work in motion/);
  assert.doesNotMatch(text, /you already shipped/);
  assert.match(text, /^next: atris do$/m);
});

test('completed-only TODO is history even when leftover context still names work', () => {
  const dir = makeTempDir();
  try {
    writeReadyWorkspace(dir, []);
    fs.writeFileSync(path.join(dir, 'atris', 'TODO.md'), [
      '# TODO.md',
      '',
      '## Backlog',
      '',
      '(Empty)',
      '',
      '## In Progress',
      '',
      '(Empty)',
      '',
      '## Completed',
      '',
      '- validate thing',
      '',
    ].join('\n'), 'utf8');
    const screen = buildFirstMinute({
      root: dir,
      person: 'keshav',
      folder: 'launch-day',
      context: {
        backlogTasks: ['**t1:** generate map.md — scan'],
        inProgressTasks: [],
        completedTasks: ['validate thing'],
      },
    });
    assert.match(screen.text, /you already shipped "validate thing"/);
    assert.doesNotMatch(screen.text, /generate map\.md|is waiting/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('TODO backlog is named before completed history', () => {
  const dir = makeTempDir();
  try {
    writeReadyWorkspace(dir, []);
    fs.writeFileSync(path.join(dir, 'atris', 'TODO.md'), [
      '# TODO.md',
      '',
      '## Backlog',
      '',
      '- build the useful thing',
      '',
      '## In Progress',
      '',
      '(Empty)',
      '',
      '## Completed',
      '',
      '- validate old thing',
      '',
    ].join('\n'), 'utf8');
    const screen = buildFirstMinute({
      root: dir,
      person: 'keshav',
      folder: 'launch-day',
      context: {
        backlogTasks: ['build the useful thing'],
        completedTasks: ['validate old thing'],
      },
    });
    assert.match(screen.text, /"build the useful thing" is waiting/);
    assert.doesNotMatch(screen.text, /you already shipped/);
    assert.match(screen.text, /^next: atris do$/m);
  } finally {
    cleanupTempDir(dir);
  }
});

test('named empty folder next command starts a first task when pasted', () => {
  const parent = makeTempDir();
  const dir = path.join(parent, 'launch-day');
  const home = path.join(parent, 'home');
  fs.mkdirSync(dir);
  fs.mkdirSync(home);
  const env = { HOME: home, USER: 'keshav', ATRIS_TASKS_DB: path.join(dir, 'tasks.db') };
  try {
    const first = runCli([], { cwd: dir, env });
    assert.equal(first.status, 0, first.stderr || first.stdout);
    assert.match(first.stdout, /hey keshav, launch-day is empty\./);
    const next = String(first.stdout).match(/^next: (.+)$/m);
    assert.ok(next, first.stdout);
    assert.equal(next[1], 'atris "what should launch-day be?"');
    assert.doesNotMatch(first.stdout, /atris init --minimal/);
    assert.equal(fs.existsSync(path.join(dir, 'atris')), false);

    const pasted = runCli(['what should launch-day be?'], { cwd: dir, env, timeout: 60000 });
    assert.equal(pasted.status, 0, pasted.stderr || pasted.stdout);
    assert.match(pasted.stdout, /I saved a first step for launch-day/);
    assert.doesNotMatch(pasted.stdout, /launch-day is empty/);
    assert.doesNotMatch(pasted.stdout, /atris initialized|What do you want to build|minimal scaffold/i);
    const claimNext = String(pasted.stdout).match(/^next: (.+)$/m);
    assert.ok(claimNext, pasted.stdout);
    assert.match(claimNext[1], /^atris task claim [A-Z0-9]+-\d+ --as keshav$/);
    assert.ok(fs.existsSync(path.join(dir, 'atris', 'MAP.md')));
    assert.ok(fs.existsSync(path.join(dir, '.atris', 'state', 'context_profile.json')));

    const claimArgs = claimNext[1].replace(/^atris\s+/, '').split(/\s+/);
    const claimed = runCli(claimArgs, { cwd: dir, env });
    assert.equal(claimed.status, 0, claimed.stderr || claimed.stdout);
    assert.doesNotMatch(claimed.stdout + claimed.stderr, /No open tasks|id required|unknown/i);

    const afterTask = runCli(['task'], { cwd: dir, env });
    assert.equal(afterTask.status, 0, afterTask.stderr || afterTask.stdout);
    assert.doesNotMatch(afterTask.stdout, /No open tasks/);
    assert.match(afterTask.stdout, /^next: atris task show /m);

    const after = runCli(['task', 'next'], { cwd: dir, env });
    assert.equal(after.status, 0, after.stderr || after.stdout);
    assert.doesNotMatch(after.stdout, /No open tasks/);
    assert.match(after.stdout, /^next: atris task show /m);
    const afterNext = String(after.stdout).match(/^next: (.+)$/m);
    const afterTaskNext = String(afterTask.stdout).match(/^next: (.+)$/m);
    assert.equal(afterNext && afterNext[1], afterTaskNext && afterTaskNext[1]);

    const showArgs = String(after.stdout).match(/^next: atris (.+)$/m)[1].split(/\s+/);
    const shown = runCli(showArgs, { cwd: dir, env });
    assert.equal(shown.status, 0, shown.stderr || shown.stdout);
    assert.doesNotMatch(shown.stdout + shown.stderr, /No open tasks|id required|unknown/i);
    assert.equal(renderFirstTalk({
      person: 'keshav',
      folder: 'launch-day',
      starter: { display_id: 'LDY-1' },
    }), [
      'hey keshav, I saved a first step for launch-day.',
      '',
      'next: atris task claim LDY-1 --as keshav',
    ].join('\n'));
  } finally {
    cleanupTempDir(parent);
  }
});
