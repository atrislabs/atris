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
  firstTalkNext,
  folderName,
  isFirstTalkLine,
  freshMinuteJson,
  freshNextCommand,
  isLeftoverVerbLook,
  isTaskNextLook,
  personName,
  pickNext,
  laterNextCommand,
  laterNotePath,
  renderFirstTalk,
  renderFresh,
  renderLaterRemember,
  renderWorkspace,
  shouldAutoInitFresh,
  spokenLineCount,
  spokenWinReason,
  isKeepWorkingMinute,
  taskCommand,
  taskNextCommand,
  visibleWorkTitle,
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

function assertDeskAcceptsReview(stdout, id = 'CLI-193') {
  assert.match(stdout, /something finished\. waiting on you\./);
  assert.doesNotMatch(stdout, /write a feature map for/i);
  assert.doesNotMatch((String(stdout).split('\n').find((line) => /something finished/.test(line)) || ''), new RegExp(id));
  assert.match(stdout, new RegExp(id));
  assert.match(nextLine(stdout), new RegExp(`^atris task accept ${id}$`));
}

function runCli(args, { cwd, env, timeout = 15000 } = {}) {
  const merged = {
    ...process.env,
    ATRIS_SKIP_UPDATE_CHECK: '1',
    ATRIS_NO_INTERACTIVE: '1',
    ...(env || {}),
  };
  // A host ATRIS_TASKS_DB would let a leftover review steal first-minute.
  if (!env || !Object.prototype.hasOwnProperty.call(env, 'ATRIS_TASKS_DB') || env.ATRIS_TASKS_DB == null) {
    delete merged.ATRIS_TASKS_DB;
  }
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: 'utf8',
    timeout,
    env: merged,
  });
  if (result.error && result.error.code === 'ETIMEDOUT') {
    assert.fail(`cli hung past ${timeout}ms (args: ${args.join(' ') || '(none)'})`);
  }
  if (result.error) throw result.error;
  return result;
}

function gitOk(dir, args, extraEnv = {}) {
  const result = spawnSync('git', args, {
    cwd: dir,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t',
      ...extraEnv,
    },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result;
}

function commitIn(dir, message, files = { 'notes.txt': 'already writing\n' }) {
  for (const [name, body] of Object.entries(files)) {
    const full = path.join(dir, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body, 'utf8');
  }
  gitOk(dir, ['init', '-q']);
  gitOk(dir, ['add', '-A']);
  gitOk(dir, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', message]);
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
  assert.match(text, /^next: atris "what do you want here\?"$/m);
  assert.equal(spokenLineCount(text), 2);
  assert.ok(text.length < 200);
  const json = freshMinuteJson();
  assert.equal(json.next_action, 'atris "what do you want here?"');
  assert.equal(json.reason, 'this folder is empty');
});

test('keep-working minute is next do, and the win line drops the greeting', () => {
  assert.equal(isKeepWorkingMinute({ nextCommand: 'atris do' }), true);
  assert.equal(isKeepWorkingMinute({ nextCommand: 'atris task claim CLI-1 --as keshav' }), false);
  assert.equal(isKeepWorkingMinute(null), false);
  assert.equal(
    spokenWinReason('hey keshav, "notes.md" is already yours.\n\nnext: atris do'),
    '"notes.md" is already yours',
  );
});

test('fresh first-minute names a file already here instead of empty', () => {
  const text = renderFresh({ person: 'keshav', folder: 'this folder', files: ['notes.txt'] });
  assert.equal(text, [
    'hey keshav, notes.txt is already here.',
    '',
    'next: atris do',
  ].join('\n'));
  assert.equal(spokenLineCount(text), 2);
  const json = freshMinuteJson('this folder', ['notes.txt']);
  assert.equal(json.reason, 'notes.txt is already here');
  assert.equal(json.next_action, 'atris do');
});

test('fresh first-minute names a git commit already here instead of files', () => {
  const text = renderFresh({
    person: 'keshav',
    folder: 'this folder',
    files: ['notes.txt', 'draft.md', 'readme.md'],
    commit: 'add notes app',
  });
  assert.equal(text, [
    'hey keshav, add notes app is already here.',
    '',
    'next: atris do',
  ].join('\n'));
  assert.equal(spokenLineCount(text), 2);
  const json = freshMinuteJson('this folder', ['notes.txt', 'draft.md', 'readme.md'], {
    commit: 'add notes app',
  });
  assert.equal(json.reason, 'add notes app is already here');
  assert.equal(json.next_action, 'atris do');
  const long = 'add a notes app that remembers every idea keshav ever wrote down plus backups sharing and a home screen';
  const clipped = renderFresh({
    person: 'keshav',
    folder: 'this folder',
    files: ['notes.txt'],
    commit: long,
  });
  assert.match(clipped, /hey keshav, .+\.\.\. is already here\./);
  assert.doesNotMatch(clipped, /home screen|git log|master|[0-9a-f]{7,}/);
  assert.match(clipped, /^next: atris do$/m);
  const hiddenOnly = renderFresh({
    person: 'keshav',
    folder: 'this folder',
    files: ['.git', '.DS_Store'],
    commit: 'add notes app',
  });
  assert.match(hiddenOnly, /hey keshav, this folder is empty\./);
  assert.match(hiddenOnly, /^next: atris "what do you want here\?"$/m);
});

test('fresh first-minute names dirty git work instead of the last commit', () => {
  const one = renderFresh({
    person: 'keshav',
    folder: 'this folder',
    files: ['notes.txt'],
    commit: 'add notes app',
    dirty: ['notes.txt'],
  });
  assert.equal(one, [
    'hey keshav, notes.txt is still open.',
    '',
    'next: atris do',
  ].join('\n'));
  assert.equal(spokenLineCount(one), 2);
  const json = freshMinuteJson('this folder', ['notes.txt'], {
    commit: 'add notes app',
    dirty: ['notes.txt'],
  });
  assert.equal(json.reason, 'notes.txt is still open');
  assert.equal(json.next_action, 'atris do');
  const two = renderFresh({
    person: 'keshav',
    folder: 'this folder',
    files: ['notes.txt', 'draft.md', 'readme.md'],
    commit: 'add notes app',
    dirty: ['notes.txt', 'draft.md'],
  });
  assert.match(two, /hey keshav, draft.md and notes.txt are still open\./);
  assert.match(two, /^next: atris do$/m);
  assert.doesNotMatch(two, /add notes app|already here|readme\.md|git status|git log/);
  const many = renderFresh({
    person: 'keshav',
    folder: 'this folder',
    files: ['a.txt', 'b.txt', 'c.txt', 'd.txt'],
    commit: 'add notes app',
    dirty: ['a.txt', 'b.txt', 'c.txt'],
  });
  assert.match(many, /hey keshav, this folder still has open work\./);
  assert.match(many, /^next: atris do$/m);
  assert.doesNotMatch(many, /add notes app|already here|a\.txt|b\.txt|c\.txt|git status| M |\?\? /);
  const hiddenDirty = renderFresh({
    person: 'keshav',
    folder: 'this folder',
    files: ['notes.txt'],
    commit: 'add notes app',
    dirty: ['.gitignore', 'tasks.db'],
  });
  assert.match(hiddenDirty, /hey keshav, add notes app is already here\./);
  assert.doesNotMatch(hiddenDirty, /still open|still has open work|\.gitignore|tasks\.db/);
  const clean = renderFresh({
    person: 'keshav',
    folder: 'this folder',
    files: ['notes.txt'],
    commit: 'add notes app',
    dirty: [],
  });
  assert.match(clean, /hey keshav, add notes app is already here\./);
  assert.doesNotMatch(clean, /still open|still has open work/);
});

test('fresh first-minute names a feature branch already here instead of the last commit', () => {
  const text = renderFresh({
    person: 'keshav',
    folder: 'this folder',
    files: ['notes.txt', 'draft.md', 'readme.md'],
    commit: 'tweak readme',
    branch: 'notes-app',
  });
  assert.equal(text, [
    'hey keshav, notes-app is already here.',
    '',
    'next: atris do',
  ].join('\n'));
  assert.equal(spokenLineCount(text), 2);
  const json = freshMinuteJson('this folder', ['notes.txt', 'draft.md', 'readme.md'], {
    commit: 'tweak readme',
    branch: 'notes-app',
  });
  assert.equal(json.reason, 'notes-app is already here');
  assert.equal(json.next_action, 'atris do');
  const long = 'keshav-notes-app-that-remembers-every-idea-plus-backups-sharing-and-a-home-screen-for-later';
  const clipped = renderFresh({
    person: 'keshav',
    folder: 'this folder',
    files: ['notes.txt'],
    commit: 'tweak readme',
    branch: long,
  });
  assert.match(clipped, /hey keshav, .+\.\.\. is already here\./);
  assert.doesNotMatch(clipped, /home-screen-for-later|git log|origin\/|[0-9a-f]{7,}/);
  assert.match(clipped, /^next: atris do$/m);
  const fromOrigin = renderFresh({
    person: 'keshav',
    folder: 'this folder',
    files: ['notes.txt'],
    commit: 'tweak readme',
    branch: 'origin/notes-app',
  });
  assert.match(fromOrigin, /hey keshav, notes-app is already here\./);
  assert.doesNotMatch(fromOrigin, /origin\/|tweak readme/);
  for (const trunk of ['main', 'master', 'HEAD', '', 'd3fb7ced']) {
    const fallback = renderFresh({
      person: 'keshav',
      folder: 'this folder',
      files: ['notes.txt'],
      commit: 'tweak readme',
      branch: trunk,
    });
    assert.match(fallback, /hey keshav, tweak readme is already here\./, trunk || '(empty)');
    assert.doesNotMatch(fallback, /notes-app|still open|origin\//, trunk || '(empty)');
  }
  const dirtyWins = renderFresh({
    person: 'keshav',
    folder: 'this folder',
    files: ['notes.txt'],
    commit: 'tweak readme',
    branch: 'notes-app',
    dirty: ['notes.txt'],
  });
  assert.match(dirtyWins, /hey keshav, notes.txt is still open\./);
  assert.match(dirtyWins, /^next: atris do$/m);
  assert.doesNotMatch(dirtyWins, /notes-app|tweak readme|already here/);
  const hiddenOnly = renderFresh({
    person: 'keshav',
    folder: 'this folder',
    files: ['.git', '.DS_Store'],
    commit: 'tweak readme',
    branch: 'notes-app',
  });
  assert.match(hiddenOnly, /hey keshav, this folder is empty\./);
  assert.match(hiddenOnly, /^next: atris "what do you want here\?"$/m);
});

test('fresh first-minute names one or two files and never dumps a listing', () => {
  const two = renderFresh({
    person: 'keshav',
    folder: 'this folder',
    files: ['notes.txt', 'draft.md'],
  });
  assert.match(two, /hey keshav, draft.md and notes.txt are already here\./);
  assert.match(two, /^next: atris do$/m);
  assert.equal(spokenLineCount(two), 2);
  const many = renderFresh({
    person: 'keshav',
    folder: 'this folder',
    files: ['a.txt', 'b.txt', 'c.txt', 'd.txt'],
  });
  assert.match(many, /hey keshav, this folder already has work\./);
  assert.match(many, /^next: atris do$/m);
  assert.doesNotMatch(many, /a\.txt|b\.txt|c\.txt|d\.txt|what do you want here/);
  assert.equal(spokenLineCount(many), 2);
});

test('later note wins over files, git, branch, and dirty work', () => {
  const later = 'finish the notes app';
  const remembered = renderFresh({
    person: 'keshav',
    folder: 'this folder',
    later,
  });
  assert.equal(remembered, [
    'hey keshav, finish the notes app is still open.',
    '',
    'next: atris do',
  ].join('\n'));
  const withFiles = renderFresh({
    person: 'keshav',
    folder: 'this folder',
    files: ['notes.txt', 'draft.md'],
    commit: 'add notes app',
    branch: 'notes-app',
    dirty: ['notes.txt'],
    later,
  });
  assert.equal(withFiles, [
    'hey keshav, finish the notes app is still open.',
    '',
    'next: atris',
  ].join('\n'));
  assert.doesNotMatch(withFiles, /already here|notes\.txt is still open|notes-app/);
  const json = freshMinuteJson('this folder', ['notes.txt'], { later });
  assert.equal(json.reason, 'finish the notes app is still open');
  assert.equal(json.next_action, 'atris');
  const remember = renderLaterRemember({
    person: 'keshav',
    sentence: later,
    files: [],
  });
  assert.equal(remember, [
    "hey keshav, I'll remember finish the notes app.",
    '',
    'next: atris do',
  ].join('\n'));
});

test('hidden names do not count as work in a fresh folder', () => {
  const text = renderFresh({
    person: 'keshav',
    folder: 'this folder',
    files: ['.DS_Store', '.git', 'notes.txt', 'tasks.db'],
  });
  assert.match(text, /hey keshav, notes.txt is already here\./);
  assert.match(text, /^next: atris do$/m);
  assert.doesNotMatch(text, /this folder is empty|this folder already has work|\.DS_Store|\.git|tasks\.db/);
  const hiddenOnly = renderFresh({
    person: 'keshav',
    folder: 'this folder',
    files: ['.DS_Store', '.git', 'tasks.db', 'tasks.db-wal'],
  });
  assert.match(hiddenOnly, /hey keshav, this folder is empty\./);
  assert.match(hiddenOnly, /^next: atris "what do you want here\?"$/m);
});

test('fresh next is do when files are here and talk when empty', () => {
  assert.equal(freshNextCommand(['notes.txt']), 'atris do');
  assert.equal(freshNextCommand(['draft.md', 'notes.txt']), 'atris do');
  assert.equal(freshNextCommand(['.git', 'tasks.db']), 'atris "what do you want here?"');
  assert.equal(freshNextCommand([]), 'atris "what do you want here?"');
  assert.equal(freshNextCommand([], 'this folder', { later: 'finish the notes app' }), 'atris do');
  assert.equal(freshNextCommand(['notes.txt'], 'this folder', { later: 'finish the notes app' }), 'atris');
  assert.equal(laterNextCommand([]), '');
  assert.equal(laterNextCommand([], { later: 'finish the notes app' }), 'atris do');
  assert.equal(laterNextCommand(['notes.txt'], { later: 'finish the notes app' }), 'atris');
});

test('visible work title names one or two files, or the folder', () => {
  assert.equal(visibleWorkTitle(['notes.txt']), 'notes.txt');
  assert.equal(visibleWorkTitle(['notes.txt', 'draft.md']), 'draft.md and notes.txt');
  assert.equal(visibleWorkTitle(['a.txt', 'b.txt', 'c.txt'], 'this folder'), 'this folder');
  assert.equal(visibleWorkTitle(['.git', 'notes.txt']), 'notes.txt');
});

test('claimed task first-minute names the person or title and one next command', () => {
  const text = renderWorkspace({
    person: 'keshav',
    folder: 'atris',
    task: { title: 'Ship the landing page', status: 'claimed', display_id: 'CLI-9' },
    nextCommand: 'atris do',
  });
  assert.match(text, /hey keshav, "ship the landing page" is already yours\./);
  assert.match(text, /^next: atris do$/m);
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
  assert.match(text, /hey keshav, something finished\. waiting on you\./);
  assert.doesNotMatch(text.split('\n')[0], /UNW-2/);
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
  }], 'keshav'), 'atris do');
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
  assert.equal(taskCommand({ status: 'claimed', display_id: 'LDY-1' }, 'keshav'), 'atris do');
  assert.equal(pickNext({
    tasks: [
      { status: 'open', display_id: 'UNW-1', updated_at: 10 },
      { status: 'claimed', display_id: 'LDY-1', updated_at: 20 },
    ],
    person: 'keshav',
  }).command, 'atris do');
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
  assert.match(text, /hey keshav, something finished\. waiting on you\./);
  assert.doesNotMatch(text.split('\n')[0], /UNW-4/);
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

test('task next is a look, not first talk', () => {
  assert.equal(isTaskNextLook('task next'), true);
  assert.equal(isTaskNextLook('task next --json'), true);
  assert.equal(isTaskNextLook('TASK NEXT --as keshav'), true);
  assert.equal(isTaskNextLook('what do you want here?'), false);
  assert.equal(isTaskNextLook('task new count words'), false);
  assert.equal(isTaskNextLook(''), false);
  assert.equal(isFirstTalkLine('what do you want here?'), true);
  assert.equal(isFirstTalkLine('atris "what do you want here?"'), true);
  assert.equal(isFirstTalkLine('what is atris?'), false);
  assert.equal(isFirstTalkLine('task next'), false);
});

test('leftover words after known verbs are a look, not first talk', () => {
  assert.equal(isLeftoverVerbLook('brainstorm hi'), true);
  assert.equal(isLeftoverVerbLook('wish hi'), true);
  assert.equal(isLeftoverVerbLook('log hi'), true);
  assert.equal(isLeftoverVerbLook('plan hi'), true);
  assert.equal(isLeftoverVerbLook('do hi'), true);
  assert.equal(isLeftoverVerbLook('later hi'), true);
  assert.equal(isLeftoverVerbLook('mission hi'), true);
  assert.equal(isLeftoverVerbLook('next hi'), true);
  assert.equal(isLeftoverVerbLook('BRAINSTORM HI'), true);
  assert.equal(isLeftoverVerbLook('task next'), true);
  assert.equal(isLeftoverVerbLook('task next --json'), true);
  assert.equal(isLeftoverVerbLook('brainstorm'), false);
  assert.equal(isLeftoverVerbLook('wish'), false);
  assert.equal(isLeftoverVerbLook('later'), false);
  assert.equal(isLeftoverVerbLook('next'), false);
  assert.equal(isLeftoverVerbLook('what do you want here?'), false);
  assert.equal(isLeftoverVerbLook('count the words'), false);
  assert.equal(isLeftoverVerbLook('task new count words'), false);
  assert.equal(isLeftoverVerbLook(''), false);
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
  assert.match(text, /^next: atris "what do you want here\?"$/m);
  assert.doesNotMatch(text, /atris init --minimal/);
  assert.equal(spokenLineCount(text), 2);
  assert.equal(firstTalkCommand('launch-day'), 'atris "what do you want here?"');
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
    assert.equal(screen.nextCommand, 'atris do');
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
    assert.match(screen.text, /something finished\. waiting on you\./);
    assert.doesNotMatch(screen.text.split('\n')[0], /UNW-2/);
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
    assert.match(res.stdout, /atris "what do you want here\?"/);
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
    assert.match(res.stdout, /^next: atris "what do you want here\?"$/m);
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
    assert.equal(payload.next_action, 'atris "what do you want here?"');
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
    assert.match(blocked.stdout, /^next: atris "what do you want here\?"$/m);
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
    assert.ok(fs.existsSync(path.join(dir, 'atris', 'lessons.md')));
    assert.equal(fs.existsSync(path.join(dir, 'atris', 'INTUITION.md')), false);
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
    assert.match(res.stdout, /^next: atris do$/m);
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
    assert.match(res.stdout, /something finished\. waiting on you\./);
    assert.doesNotMatch(res.stdout.split('\n').find((line) => line.includes('hey keshav')) || '', /UNW-2/);
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

test('first talk files the user sentence and names it as the win', () => {
  const dir = makeTempDir();
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  const env = { HOME: home, USER: 'keshav', ATRIS_TASKS_DB: path.join(dir, 'tasks.db') };
  try {
    const empty = runCli([], { cwd: dir, env });
    assert.equal(empty.status, 0, empty.stderr || empty.stdout);
    assert.match(empty.stdout, /hey keshav, this folder is empty\./);
    assert.match(empty.stdout, /^next: atris "what do you want here\?"$/m);
    assert.doesNotMatch(empty.stdout, /I saved a first step|first useful step/i);

    for (const leftover of ['brainstorm hi', 'wish hi', 'task next']) {
      const look = runCli([leftover], { cwd: dir, env });
      assert.equal(look.status, 0, look.stderr || look.stdout);
      assert.equal(look.stdout.trim(), empty.stdout.trim(), leftover);
      assert.equal(fs.existsSync(path.join(dir, 'atris')), false, leftover);
      assert.equal(fs.existsSync(laterNotePath(dir)), false, leftover);
    }

    const help = runCli(['--help'], { cwd: dir, env });
    assert.equal(help.status, 0, help.stderr || help.stdout);
    assert.match(help.stdout, /already won\. one next step/);
    assert.doesNotMatch(help.stdout, /this folder is empty|I saved a first step|is ready\./);
    assert.equal(fs.existsSync(path.join(dir, 'atris')), false);

    const talk = runCli(['a notes app for keshav'], { cwd: dir, env, timeout: 60000 });
    assert.equal(talk.status, 0, talk.stderr || talk.stdout);
    assert.match(talk.stdout, /hey keshav, a notes app for keshav is ready\./);
    assert.match(talk.stdout, /^next: atris do$/m);
    assert.doesNotMatch(talk.stdout, /atris task (claim|show) |I saved a first step|first useful step/i);
    assert.doesNotMatch(talk.stdout.split('\n')[0], /[A-Z0-9]+-\d+/);
    assert.equal(spokenLineCount(talk.stdout), 2);

    const todo = fs.readFileSync(path.join(dir, 'atris', 'TODO.md'), 'utf8');
    assert.match(todo, /a notes app for keshav/);
    assert.doesNotMatch(todo, /[Ff]irst useful step/);

    const listed = runCli(['task', 'list', '--json'], { cwd: dir, env });
    assert.equal(listed.status, 0, listed.stderr || listed.stdout);
    const notes = (JSON.parse(listed.stdout).tasks || []).find((row) => (
      /a notes app for keshav/i.test(row.title || '')
    ));
    assert.ok(notes, listed.stdout);
    assert.equal(notes.status, 'claimed');
    assert.equal(notes.claimed_by, 'keshav');

    const after = runCli([], { cwd: dir, env });
    assert.equal(after.status, 0, after.stderr || after.stdout);
    assert.match(after.stdout, /"a notes app for keshav" is already yours/);
    assert.equal(nextLine(after.stdout), 'atris do');
    assert.doesNotMatch(after.stdout, /ready to claim|atris task (claim|show) |first useful step/i);

    const doit = runCli(['do'], { cwd: dir, env });
    assert.equal(doit.status, 0, doit.stderr || doit.stdout);
    assert.match(doit.stdout, /"a notes app for keshav" is already yours/);
    assert.equal(nextLine(doit.stdout), 'atris do');
    assert.equal(spokenLineCount(doit.stdout), 2);
    assert.doesNotMatch(doit.stdout, /atris task (claim|show) |PROMPT ONLY|Atris Do|executor\.md|What do you want to build/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('later remembers words in an unbound folder without minting a room', () => {
  const parent = makeTempDir();
  const dir = path.join(parent, 'notes');
  const home = path.join(parent, 'home');
  fs.mkdirSync(dir);
  fs.mkdirSync(home);
  const env = { HOME: home, USER: 'keshav', ATRIS_TASKS_DB: path.join(dir, 'tasks.db') };
  try {
    const empty = runCli([], { cwd: dir, env });
    assert.equal(empty.status, 0, empty.stderr || empty.stdout);
    assert.match(empty.stdout, /hey keshav, notes is empty\./);
    assert.match(empty.stdout, /^next: atris "what do you want here\?"$/m);
    assert.equal(fs.existsSync(laterNotePath(dir)), false);

    const missing = runCli(['later'], { cwd: dir, env });
    assert.equal(missing.status, 2, missing.stderr || missing.stdout);
    assert.match(missing.stdout, /Usage: atris later/);
    assert.equal(fs.existsSync(path.join(dir, 'atris')), false);
    assert.equal(fs.existsSync(path.join(dir, '.atris')), false);
    assert.equal(fs.existsSync(laterNotePath(dir)), false);

    const help = runCli(['later', '--help'], { cwd: dir, env });
    assert.equal(help.status, 0, help.stderr || help.stdout);
    assert.match(help.stdout, /Usage: atris later/);
    assert.doesNotMatch(help.stdout, /I'll remember|still open|this folder is empty/);
    assert.equal(fs.existsSync(laterNotePath(dir)), false);

    const remembered = runCli(['later', 'finish the notes app'], { cwd: dir, env });
    assert.equal(remembered.status, 0, remembered.stderr || remembered.stdout);
    assert.equal(remembered.stdout.trim(), [
      "hey keshav, I'll remember finish the notes app.",
      '',
      'next: atris do',
    ].join('\n'));
    assert.equal(spokenLineCount(remembered.stdout), 2);
    assert.equal(fs.existsSync(path.join(dir, 'atris')), false);
    assert.equal(fs.existsSync(path.join(dir, '.atris')), false);
    assert.equal(fs.readFileSync(laterNotePath(dir), 'utf8').trim(), 'finish the notes app');

    const minute = runCli([], { cwd: dir, env });
    assert.equal(minute.status, 0, minute.stderr || minute.stdout);
    assert.equal(minute.stdout.trim(), [
      'hey keshav, finish the notes app is still open.',
      '',
      'next: atris do',
    ].join('\n'));
    assert.equal(spokenLineCount(minute.stdout), 2);
    assert.equal(fs.existsSync(path.join(dir, 'atris')), false);
    assert.equal(fs.existsSync(path.join(dir, '.atris')), false);

    for (const leftover of ['brainstorm hi', 'wish hi', 'task next']) {
      const look = runCli([leftover], { cwd: dir, env });
      assert.equal(look.status, 0, look.stderr || look.stdout, leftover);
      assert.equal(look.stdout.trim(), minute.stdout.trim(), leftover);
      assert.equal(fs.existsSync(path.join(dir, 'atris')), false, leftover);
      assert.equal(fs.existsSync(path.join(dir, '.atris')), false, leftover);
      assert.equal(fs.readFileSync(laterNotePath(dir), 'utf8').trim(), 'finish the notes app', leftover);
    }

    fs.writeFileSync(path.join(dir, 'notes.txt'), 'already writing\n', 'utf8');
    const withFiles = runCli([], { cwd: dir, env });
    assert.equal(withFiles.status, 0, withFiles.stderr || withFiles.stdout);
    assert.match(withFiles.stdout, /hey keshav, finish the notes app is still open\./);
    assert.match(withFiles.stdout, /^next: atris$/m);
    assert.doesNotMatch(withFiles.stdout, /notes\.txt is already here|what do you want here/);
    assert.equal(fs.existsSync(path.join(dir, 'atris')), false);

    const leftoverLater = runCli(['later hi'], { cwd: dir, env });
    assert.equal(leftoverLater.status, 0, leftoverLater.stderr || leftoverLater.stdout);
    assert.equal(leftoverLater.stdout.trim(), withFiles.stdout.trim());
    assert.equal(fs.readFileSync(laterNotePath(dir), 'utf8').trim(), 'finish the notes app');
    assert.equal(fs.existsSync(path.join(dir, 'atris')), false);

    const talk = runCli(['a notes app for keshav'], { cwd: dir, env, timeout: 60000 });
    assert.equal(talk.status, 0, talk.stderr || talk.stdout);
    assert.match(talk.stdout, /hey keshav, a notes app for keshav is ready\./);
    assert.match(talk.stdout, /^next: atris do$/m);
    assert.ok(fs.existsSync(path.join(dir, 'atris', 'TODO.md')));
  } finally {
    cleanupTempDir(parent);
  }
});

test('unbound folder with notes.txt names the file and does not mint', () => {
  const dir = makeTempDir();
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'already writing\n', 'utf8');
  fs.writeFileSync(path.join(dir, '.DS_Store'), '', 'utf8');
  fs.mkdirSync(path.join(dir, '.git'));
  const env = { HOME: home, USER: 'keshav', ATRIS_TASKS_DB: path.join(dir, 'tasks.db') };
  try {
    const minute = runCli([], { cwd: dir, env });
    const recap = runCli(['recap'], { cwd: dir, env });
    const planned = runCli(['plan'], { cwd: dir, env });
    assert.equal(minute.status, 0, minute.stderr || minute.stdout);
    assert.equal(recap.status, 0, recap.stderr || recap.stdout);
    assert.equal(planned.status, 0, planned.stderr || planned.stdout);
    assert.match(minute.stdout, /hey keshav, notes.txt is already here\./);
    assert.match(minute.stdout, /^next: atris do$/m);
    assert.doesNotMatch(minute.stdout, /what do you want here/);
    assert.equal(spokenLineCount(minute.stdout), 2);
    assert.doesNotMatch(minute.stdout, /this folder is empty|this folder already has work|\.DS_Store|\.git/);
    assert.equal(recap.stdout.trim(), minute.stdout.trim());
    assert.equal(planned.stdout.trim(), minute.stdout.trim());
    assert.equal(fs.existsSync(path.join(dir, 'atris')), false);
    assert.equal(fs.existsSync(path.join(dir, '.atris')), false);

    for (const leftover of ['brainstorm hi', 'wish hi', 'task next']) {
      const look = runCli([leftover], { cwd: dir, env });
      assert.equal(look.status, 0, look.stderr || look.stdout, leftover);
      assert.equal(look.stdout.trim(), minute.stdout.trim(), leftover);
      assert.equal(fs.existsSync(path.join(dir, 'atris')), false, leftover);
      assert.equal(fs.existsSync(path.join(dir, '.atris')), false, leftover);
      assert.equal(fs.existsSync(laterNotePath(dir)), false, leftover);
    }

    const jsonMinute = runCli(['--json'], { cwd: dir, env });
    const jsonPayload = JSON.parse(jsonMinute.stdout);
    assert.equal(jsonMinute.status, 2);
    assert.equal(jsonPayload.next_action, 'atris do');
    assert.equal(jsonPayload.reason, 'notes.txt is already here');
    assert.equal(fs.existsSync(path.join(dir, 'atris')), false);

    const help = runCli(['--help'], { cwd: dir, env });
    assert.equal(help.status, 0, help.stderr || help.stdout);
    assert.match(help.stdout, /already won\. one next step/);
    assert.doesNotMatch(help.stdout, /notes.txt is already here|this folder is empty/);

    const talk = runCli(['a notes app for keshav'], { cwd: dir, env, timeout: 60000 });
    assert.equal(talk.status, 0, talk.stderr || talk.stdout);
    assert.match(talk.stdout, /hey keshav, a notes app for keshav is ready\./);
    assert.match(talk.stdout, /^next: atris do$/m);
    assert.doesNotMatch(talk.stdout, /atris task (claim|show) /);
    assert.equal(spokenLineCount(talk.stdout), 2);
    assert.ok(fs.existsSync(path.join(dir, 'atris', 'TODO.md')));
  } finally {
    cleanupTempDir(dir);
  }
});

test('unbound folder of only hidden files still says empty', () => {
  const dir = makeTempDir();
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(dir, '.DS_Store'), '', 'utf8');
  fs.mkdirSync(path.join(dir, '.git'));
  const env = { HOME: home, USER: 'keshav', ATRIS_TASKS_DB: path.join(dir, 'tasks.db') };
  try {
    const minute = runCli([], { cwd: dir, env });
    assert.equal(minute.status, 0, minute.stderr || minute.stdout);
    assert.match(minute.stdout, /hey keshav, this folder is empty\./);
    assert.match(minute.stdout, /^next: atris "what do you want here\?"$/m);
    assert.doesNotMatch(minute.stdout, /already here|already has work|still open|\.DS_Store|\.git/);
    assert.equal(fs.existsSync(path.join(dir, 'atris')), false);
  } finally {
    cleanupTempDir(dir);
  }
});

test('unbound folder names a directory that already has work', () => {
  const dir = makeTempDir();
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'app.js'), 'console.log(1)\n', 'utf8');
  const env = { HOME: home, USER: 'keshav', ATRIS_TASKS_DB: path.join(dir, 'tasks.db') };
  try {
    const minute = runCli([], { cwd: dir, env });
    assert.equal(minute.status, 0, minute.stderr || minute.stdout);
    assert.match(minute.stdout, /hey keshav, src is already here\./);
    assert.match(minute.stdout, /^next: atris do$/m);
    assert.doesNotMatch(minute.stdout, /what do you want here/);
    assert.doesNotMatch(minute.stdout, /this folder is empty|home is already here|app\.js/);
    assert.equal(fs.existsSync(path.join(dir, 'atris')), false);
  } finally {
    cleanupTempDir(dir);
  }
});

test('unbound folder with a few files names work without a listing', () => {
  const dir = makeTempDir();
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'one\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'draft.md'), 'two\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'readme.md'), 'three\n', 'utf8');
  const env = { HOME: home, USER: 'keshav', ATRIS_TASKS_DB: path.join(dir, 'tasks.db') };
  try {
    const minute = runCli([], { cwd: dir, env });
    const recap = runCli(['recap'], { cwd: dir, env });
    const planned = runCli(['plan'], { cwd: dir, env });
    assert.equal(minute.status, 0, minute.stderr || minute.stdout);
    assert.match(minute.stdout, /hey keshav, this folder already has work\./);
    assert.match(minute.stdout, /^next: atris do$/m);
    assert.doesNotMatch(minute.stdout, /notes\.txt|draft\.md|readme\.md|this folder is empty|what do you want here/);
    assert.equal(recap.stdout.trim(), minute.stdout.trim());
    assert.equal(planned.stdout.trim(), minute.stdout.trim());
    assert.equal(fs.existsSync(path.join(dir, 'atris')), false);
    assert.equal(fs.existsSync(path.join(dir, '.atris')), false);
  } finally {
    cleanupTempDir(dir);
  }
});

test('unbound git folder names the last commit and does not mint', () => {
  const dir = makeTempDir();
  const homeParent = makeTempDir();
  const home = path.join(homeParent, 'home');
  fs.mkdirSync(home, { recursive: true });
  commitIn(dir, 'add notes app', {
    'notes.txt': 'already writing\n',
    'draft.md': 'two\n',
    'readme.md': 'three\n',
  });
  const env = { HOME: home, USER: 'keshav', ATRIS_TASKS_DB: path.join(home, 'tasks.db') };
  try {
    const minute = runCli([], { cwd: dir, env });
    const recap = runCli(['recap'], { cwd: dir, env });
    const planned = runCli(['plan'], { cwd: dir, env });
    assert.equal(minute.status, 0, minute.stderr || minute.stdout);
    assert.equal(recap.status, 0, recap.stderr || recap.stdout);
    assert.equal(planned.status, 0, planned.stderr || planned.stdout);
    assert.match(minute.stdout, /hey keshav, add notes app is already here\./);
    assert.match(minute.stdout, /^next: atris do$/m);
    assert.equal(spokenLineCount(minute.stdout), 2);
    assert.doesNotMatch(minute.stdout, /this folder already has work|still open|notes\.txt|draft\.md|git log|master|HEAD|what do you want here/);
    assert.doesNotMatch(minute.stdout, /[0-9a-f]{7,}/);
    assert.equal(recap.stdout.trim(), minute.stdout.trim());
    assert.equal(planned.stdout.trim(), minute.stdout.trim());
    assert.equal(fs.existsSync(path.join(dir, 'atris')), false);
    assert.equal(fs.existsSync(path.join(dir, '.atris')), false);

    for (const leftover of ['brainstorm hi', 'wish hi', 'task next']) {
      const look = runCli([leftover], { cwd: dir, env });
      assert.equal(look.status, 0, look.stderr || look.stdout, leftover);
      assert.equal(look.stdout.trim(), minute.stdout.trim(), leftover);
      assert.equal(fs.existsSync(path.join(dir, 'atris')), false, leftover);
      assert.equal(fs.existsSync(path.join(dir, '.atris')), false, leftover);
      assert.equal(fs.existsSync(laterNotePath(dir)), false, leftover);
    }

    const jsonMinute = runCli(['--json'], { cwd: dir, env });
    const jsonPayload = JSON.parse(jsonMinute.stdout);
    assert.equal(jsonMinute.status, 2);
    assert.equal(jsonPayload.next_action, 'atris do');
    assert.equal(jsonPayload.reason, 'add notes app is already here');
    assert.equal(fs.existsSync(path.join(dir, 'atris')), false);

    const help = runCli(['--help'], { cwd: dir, env });
    assert.equal(help.status, 0, help.stderr || help.stdout);
    assert.match(help.stdout, /already won\. one next step/);
    assert.doesNotMatch(help.stdout, /add notes app is already here|this folder is empty/);

    const doit = runCli(['do'], { cwd: dir, env, timeout: 60000 });
    assert.equal(doit.status, 0, doit.stderr || doit.stdout);
    assert.match(doit.stdout, /hey keshav, this folder is ready\./);
    assert.match(doit.stdout, /^next: atris do$/m);
    assert.doesNotMatch(doit.stdout, /already here|atris task (claim|show) |PROMPT ONLY|executor\.md/);
    assert.ok(fs.existsSync(path.join(dir, 'atris', 'TODO.md')));
  } finally {
    cleanupTempDir(dir);
    cleanupTempDir(homeParent);
  }
});

test('unbound dirty git folder names open work and does not mint', () => {
  const parent = makeTempDir();
  const dir = path.join(parent, 'notes');
  const home = path.join(parent, 'home');
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  commitIn(dir, 'add notes app', { 'notes.txt': 'already writing\n' });
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'still writing\n', 'utf8');
  const env = { HOME: home, USER: 'keshav', ATRIS_TASKS_DB: path.join(home, 'tasks.db') };
  try {
    const minute = runCli([], { cwd: dir, env });
    const recap = runCli(['recap'], { cwd: dir, env });
    const planned = runCli(['plan'], { cwd: dir, env });
    assert.equal(minute.status, 0, minute.stderr || minute.stdout);
    assert.equal(recap.status, 0, recap.stderr || recap.stdout);
    assert.equal(planned.status, 0, planned.stderr || planned.stdout);
    assert.match(minute.stdout, /hey keshav, notes.txt is still open\./);
    assert.match(minute.stdout, /^next: atris do$/m);
    assert.equal(spokenLineCount(minute.stdout), 2);
    assert.doesNotMatch(minute.stdout, /add notes app|already here|git status|git log|master|HEAD| M |\?\? |what do you want here/);
    assert.doesNotMatch(minute.stdout, /[0-9a-f]{7,}/);
    assert.equal(recap.stdout.trim(), minute.stdout.trim());
    assert.equal(planned.stdout.trim(), minute.stdout.trim());
    assert.equal(fs.existsSync(path.join(dir, 'atris')), false);
    assert.equal(fs.existsSync(path.join(dir, '.atris')), false);

    for (const leftover of ['brainstorm hi', 'wish hi', 'task next']) {
      const look = runCli([leftover], { cwd: dir, env });
      assert.equal(look.status, 0, look.stderr || look.stdout, leftover);
      assert.equal(look.stdout.trim(), minute.stdout.trim(), leftover);
      assert.equal(fs.existsSync(path.join(dir, 'atris')), false, leftover);
      assert.equal(fs.existsSync(path.join(dir, '.atris')), false, leftover);
      assert.equal(fs.existsSync(laterNotePath(dir)), false, leftover);
    }

    const jsonMinute = runCli(['--json'], { cwd: dir, env });
    const jsonPayload = JSON.parse(jsonMinute.stdout);
    assert.equal(jsonMinute.status, 2);
    assert.equal(jsonPayload.next_action, 'atris do');
    assert.equal(jsonPayload.reason, 'notes.txt is still open');
    assert.equal(fs.existsSync(path.join(dir, 'atris')), false);

    const help = runCli(['--help'], { cwd: dir, env });
    assert.equal(help.status, 0, help.stderr || help.stdout);
    assert.match(help.stdout, /already won\. one next step/);
    assert.doesNotMatch(help.stdout, /notes.txt is still open|add notes app is already here|this folder is empty/);

    const extraParent = makeTempDir();
    const extra = path.join(extraParent, 'notes');
    const extraHome = path.join(extraParent, 'home');
    fs.mkdirSync(extra, { recursive: true });
    fs.mkdirSync(extraHome, { recursive: true });
    commitIn(extra, 'add notes app', { 'notes.txt': 'already writing\n' });
    fs.writeFileSync(path.join(extra, 'extra.txt'), 'untracked leftover\n', 'utf8');
    const extraEnv = { HOME: extraHome, USER: 'keshav', ATRIS_TASKS_DB: path.join(extraHome, 'tasks.db') };
    try {
      const untracked = runCli([], { cwd: extra, env: extraEnv });
      assert.equal(untracked.status, 0, untracked.stderr || untracked.stdout);
      assert.match(untracked.stdout, /hey keshav, extra.txt is still open\./);
      assert.match(untracked.stdout, /^next: atris do$/m);
      assert.doesNotMatch(untracked.stdout, /add notes app|already here|notes\.txt|git status|\?\? /);
      assert.equal(fs.existsSync(path.join(extra, 'atris')), false);
    } finally {
      cleanupTempDir(extraParent);
    }

    const manyParent = makeTempDir();
    const many = path.join(manyParent, 'notes');
    const manyHome = path.join(manyParent, 'home');
    fs.mkdirSync(many, { recursive: true });
    fs.mkdirSync(manyHome, { recursive: true });
    commitIn(many, 'add notes app', {
      'a.txt': 'a\n',
      'b.txt': 'b\n',
      'c.txt': 'c\n',
      'd.txt': 'd\n',
    });
    fs.writeFileSync(path.join(many, 'a.txt'), 'A\n', 'utf8');
    fs.writeFileSync(path.join(many, 'b.txt'), 'B\n', 'utf8');
    fs.writeFileSync(path.join(many, 'c.txt'), 'C\n', 'utf8');
    const manyEnv = { HOME: manyHome, USER: 'keshav', ATRIS_TASKS_DB: path.join(manyHome, 'tasks.db') };
    try {
      const crowded = runCli([], { cwd: many, env: manyEnv });
      assert.equal(crowded.status, 0, crowded.stderr || crowded.stdout);
      assert.match(crowded.stdout, /hey keshav, this folder still has open work\./);
      assert.match(crowded.stdout, /^next: atris do$/m);
      assert.doesNotMatch(crowded.stdout, /add notes app|already here|a\.txt|b\.txt|c\.txt|git status| M /);
      assert.equal(fs.existsSync(path.join(many, 'atris')), false);
    } finally {
      cleanupTempDir(manyParent);
    }

    const talk = runCli(['a notes app for keshav'], { cwd: dir, env, timeout: 60000 });
    assert.equal(talk.status, 0, talk.stderr || talk.stdout);
    assert.match(talk.stdout, /hey keshav, a notes app for keshav is ready\./);
    assert.match(talk.stdout, /^next: atris do$/m);
    assert.doesNotMatch(talk.stdout, /still open|already here|atris task (claim|show) /);
    assert.ok(fs.existsSync(path.join(dir, 'atris', 'TODO.md')));

    const after = runCli([], { cwd: dir, env });
    assert.equal(after.status, 0, after.stderr || after.stdout);
    assert.match(after.stdout, /"a notes app for keshav" is already yours/);
    assert.equal(nextLine(after.stdout), 'atris do');
    assert.doesNotMatch(after.stdout, /still open|notes\.txt is already here/);
  } finally {
    cleanupTempDir(parent);
  }
});

test('unbound git folder on a feature branch names the branch and does not mint', () => {
  const parent = makeTempDir();
  const dir = path.join(parent, 'notes');
  const home = path.join(parent, 'home');
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  commitIn(dir, 'tweak readme', {
    'notes.txt': 'already writing\n',
    'draft.md': 'two\n',
    'readme.md': 'three\n',
  });
  gitOk(dir, ['checkout', '-q', '-b', 'notes-app']);
  const env = { HOME: home, USER: 'keshav', ATRIS_TASKS_DB: path.join(home, 'tasks.db') };
  try {
    const minute = runCli([], { cwd: dir, env });
    const recap = runCli(['recap'], { cwd: dir, env });
    const planned = runCli(['plan'], { cwd: dir, env });
    assert.equal(minute.status, 0, minute.stderr || minute.stdout);
    assert.equal(recap.status, 0, recap.stderr || recap.stdout);
    assert.equal(planned.status, 0, planned.stderr || planned.stdout);
    assert.match(minute.stdout, /hey keshav, notes-app is already here\./);
    assert.match(minute.stdout, /^next: atris do$/m);
    assert.equal(spokenLineCount(minute.stdout), 2);
    assert.doesNotMatch(minute.stdout, /tweak readme|this folder already has work|still open|notes\.txt|draft\.md|git log|master|HEAD|origin\/|what do you want here/);
    assert.doesNotMatch(minute.stdout, /[0-9a-f]{7,}/);
    assert.equal(recap.stdout.trim(), minute.stdout.trim());
    assert.equal(planned.stdout.trim(), minute.stdout.trim());
    assert.equal(fs.existsSync(path.join(dir, 'atris')), false);
    assert.equal(fs.existsSync(path.join(dir, '.atris')), false);

    for (const leftover of ['brainstorm hi', 'wish hi', 'task next']) {
      const look = runCli([leftover], { cwd: dir, env });
      assert.equal(look.status, 0, look.stderr || look.stdout, leftover);
      assert.equal(look.stdout.trim(), minute.stdout.trim(), leftover);
      assert.equal(fs.existsSync(path.join(dir, 'atris')), false, leftover);
      assert.equal(fs.existsSync(path.join(dir, '.atris')), false, leftover);
      assert.equal(fs.existsSync(laterNotePath(dir)), false, leftover);
    }

    const jsonMinute = runCli(['--json'], { cwd: dir, env });
    const jsonPayload = JSON.parse(jsonMinute.stdout);
    assert.equal(jsonMinute.status, 2);
    assert.equal(jsonPayload.next_action, 'atris do');
    assert.equal(jsonPayload.reason, 'notes-app is already here');
    assert.equal(fs.existsSync(path.join(dir, 'atris')), false);

    const help = runCli(['--help'], { cwd: dir, env });
    assert.equal(help.status, 0, help.stderr || help.stdout);
    assert.match(help.stdout, /already won\. one next step/);
    assert.doesNotMatch(help.stdout, /notes-app is already here|tweak readme is already here|this folder is empty/);

    fs.writeFileSync(path.join(dir, 'notes.txt'), 'still writing\n', 'utf8');
    const dirty = runCli([], { cwd: dir, env });
    assert.equal(dirty.status, 0, dirty.stderr || dirty.stdout);
    assert.match(dirty.stdout, /hey keshav, notes.txt is still open\./);
    assert.match(dirty.stdout, /^next: atris do$/m);
    assert.doesNotMatch(dirty.stdout, /notes-app|tweak readme|already here|git status|origin\//);
    assert.equal(fs.existsSync(path.join(dir, 'atris')), false);
    gitOk(dir, ['checkout', '-q', '--', 'notes.txt']);

    gitOk(dir, ['checkout', '-q', '--detach']);
    const detached = runCli([], { cwd: dir, env });
    assert.equal(detached.status, 0, detached.stderr || detached.stdout);
    assert.match(detached.stdout, /hey keshav, tweak readme is already here\./);
    assert.match(detached.stdout, /^next: atris do$/m);
    assert.doesNotMatch(detached.stdout, /notes-app|still open|origin\/|HEAD|what do you want here/);
    assert.doesNotMatch(detached.stdout, /[0-9a-f]{7,}/);
    assert.equal(fs.existsSync(path.join(dir, 'atris')), false);

    gitOk(dir, ['checkout', '-q', '-B', 'master']);
    const trunk = runCli([], { cwd: dir, env });
    assert.equal(trunk.status, 0, trunk.stderr || trunk.stdout);
    assert.match(trunk.stdout, /hey keshav, tweak readme is already here\./);
    assert.match(trunk.stdout, /^next: atris do$/m);
    assert.doesNotMatch(trunk.stdout, /notes-app|still open|origin\//);
    assert.equal(fs.existsSync(path.join(dir, 'atris')), false);

    gitOk(dir, ['checkout', '-q', '-b', 'keshav-notes-app-that-remembers-every-idea-plus-backups-sharing-and-a-home-screen-for-later']);
    const long = runCli([], { cwd: dir, env });
    assert.equal(long.status, 0, long.stderr || long.stdout);
    assert.match(long.stdout, /hey keshav, .+\.\.\. is already here\./);
    assert.match(long.stdout, /^next: atris do$/m);
    assert.doesNotMatch(long.stdout, /home-screen-for-later|tweak readme|origin\//);
    assert.equal(fs.existsSync(path.join(dir, 'atris')), false);

    gitOk(dir, ['checkout', '-q', 'notes-app']);
    const talk = runCli(['a notes app for keshav'], { cwd: dir, env, timeout: 60000 });
    assert.equal(talk.status, 0, talk.stderr || talk.stdout);
    assert.match(talk.stdout, /hey keshav, a notes app for keshav is ready\./);
    assert.match(talk.stdout, /^next: atris do$/m);
    assert.doesNotMatch(talk.stdout, /notes-app is already here|still open|atris task (claim|show) /);
    assert.ok(fs.existsSync(path.join(dir, 'atris', 'TODO.md')));

    const after = runCli([], { cwd: dir, env });
    assert.equal(after.status, 0, after.stderr || after.stdout);
    assert.match(after.stdout, /"a notes app for keshav" is already yours/);
    assert.equal(nextLine(after.stdout), 'atris do');
    assert.doesNotMatch(after.stdout, /notes-app is already here|notes\.txt is already here/);
  } finally {
    cleanupTempDir(parent);
  }
});

test('unbound git folder with no commits still names files and does not mint', () => {
  const parent = makeTempDir();
  const dir = path.join(parent, 'notes');
  const child = path.join(dir, 'inbox');
  const home = path.join(parent, 'home');
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  const env = { HOME: home, USER: 'keshav', ATRIS_TASKS_DB: path.join(dir, 'tasks.db') };
  try {
    gitOk(dir, ['init', '-q']);
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'already writing\n', 'utf8');
    const noCommit = runCli([], { cwd: dir, env });
    assert.equal(noCommit.status, 0, noCommit.stderr || noCommit.stdout);
    assert.match(noCommit.stdout, /hey keshav, notes.txt is already here\./);
    assert.match(noCommit.stdout, /^next: atris do$/m);
    assert.doesNotMatch(noCommit.stdout, /add notes app|this folder already has work|git log/);
    assert.equal(fs.existsSync(path.join(dir, 'atris')), false);

    const emptyGit = makeTempDir();
    const emptyHome = path.join(emptyGit, 'home');
    fs.mkdirSync(emptyHome, { recursive: true });
    gitOk(emptyGit, ['init', '-q']);
    const emptyEnv = { HOME: emptyHome, USER: 'keshav', ATRIS_TASKS_DB: path.join(emptyGit, 'tasks.db') };
    try {
      const empty = runCli([], { cwd: emptyGit, env: emptyEnv });
      assert.equal(empty.status, 0, empty.stderr || empty.stdout);
      assert.match(empty.stdout, /hey keshav, this folder is empty\./);
      assert.match(empty.stdout, /^next: atris "what do you want here\?"$/m);
      assert.equal(fs.existsSync(path.join(emptyGit, 'atris')), false);
    } finally {
      cleanupTempDir(emptyGit);
    }

    commitIn(dir, 'parent win', { 'notes.txt': 'already writing\n' });
    fs.mkdirSync(child, { recursive: true });
    fs.writeFileSync(path.join(child, 'notes.txt'), 'child notes\n', 'utf8');
    const nested = runCli([], {
      cwd: child,
      env: { HOME: home, USER: 'keshav', ATRIS_TASKS_DB: path.join(child, 'tasks.db') },
    });
    assert.equal(nested.status, 0, nested.stderr || nested.stdout);
    assert.match(nested.stdout, /hey keshav, notes.txt is already here\./);
    assert.doesNotMatch(nested.stdout, /parent win|add notes app|this folder already has work/);
    assert.equal(fs.existsSync(path.join(child, 'atris')), false);
  } finally {
    cleanupTempDir(parent);
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
    assert.match(res.stdout, /^next: atris "what do you want here\?"$/m);
    assert.doesNotMatch(res.stdout, /BOOTSTRAP REQUIRED|For an agent|generate a complete `atris\/MAP\.md`/);
    assert.doesNotMatch(res.stdout, /Got it\. I saved your first direction|First useful step: test/);
    assert.equal(fs.existsSync(path.join(dir, 'atris')), false);
  } finally {
    cleanupTempDir(dir);
  }
});

test('atris recap in an empty folder talks like first-minute', () => {
  const dir = makeTempDir();
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  const env = { HOME: home, USER: 'keshav', ATRIS_TASKS_DB: path.join(dir, 'tasks.db') };
  try {
    const minute = runCli([], { cwd: dir, env });
    const recap = runCli(['recap'], { cwd: dir, env });
    assert.equal(minute.status, 0, minute.stderr || minute.stdout);
    assert.equal(recap.status, 0, recap.stderr || recap.stdout);
    assert.equal(recap.stdout.trim(), minute.stdout.trim());
    assert.match(recap.stdout, /this folder is empty/);
    assert.match(recap.stdout, /^next: atris "what do you want here\?"$/m);
    assert.doesNotMatch(recap.stdout, /atris init --minimal|no task history yet/);
    assert.equal(fs.existsSync(path.join(dir, 'atris')), false);

    const jsonMinute = runCli(['--json'], { cwd: dir, env });
    const jsonRecap = runCli(['recap', '--json'], { cwd: dir, env });
    assert.equal(jsonRecap.status, jsonMinute.status);
    assert.deepEqual(JSON.parse(jsonRecap.stdout), JSON.parse(jsonMinute.stdout));

    const help = runCli(['recap', '--help'], { cwd: dir, env });
    assert.equal(help.status, 0, help.stderr || help.stdout);
    assert.match(help.stdout, /spoken lines/);
    assert.doesNotMatch(help.stdout, /this folder is empty|atris init --minimal/);
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
    assert.match(planned.stdout, /^next: atris "what do you want here\?"$/m);
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
    assert.match(review.stdout, /^next: atris "what do you want here\?"$/m);
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

test('atris do in an unbound folder starts from files already here', () => {
  const dir = makeTempDir();
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'already writing\n', 'utf8');
  fs.writeFileSync(path.join(dir, '.DS_Store'), '', 'utf8');
  const env = { HOME: home, USER: 'keshav', ATRIS_TASKS_DB: path.join(dir, 'tasks.db') };
  try {
    const minute = runCli([], { cwd: dir, env });
    assert.equal(minute.status, 0, minute.stderr || minute.stdout);
    assert.match(minute.stdout, /hey keshav, notes.txt is already here\./);
    assert.match(minute.stdout, /^next: atris do$/m);

    const doit = runCli(['do'], { cwd: dir, env, timeout: 60000 });
    assert.equal(doit.status, 0, doit.stderr || doit.stdout);
    assert.match(doit.stdout, /hey keshav, notes.txt is ready\./);
    assert.match(doit.stdout, /^next: atris do$/m);
    assert.doesNotMatch(doit.stdout, /already here|this folder is empty|atris task (claim|show) /);
    assert.doesNotMatch(doit.stdout, /PROMPT ONLY|Atris Do|What do you want to build|executor\.md|Run "atris init"/);
    assert.equal(spokenLineCount(doit.stdout), 2);
    assert.ok(fs.existsSync(path.join(dir, 'atris', 'TODO.md')));
    assert.match(fs.readFileSync(path.join(dir, 'atris', 'TODO.md'), 'utf8'), /notes\.txt/);

    const listed = runCli(['task', 'list', '--json'], { cwd: dir, env });
    assert.equal(listed.status, 0, listed.stderr || listed.stdout);
    const notes = (JSON.parse(listed.stdout).tasks || []).find((row) => /notes\.txt/i.test(row.title || ''));
    assert.ok(notes, listed.stdout);
    assert.equal(notes.status, 'claimed');
    assert.equal(notes.claimed_by, 'keshav');

    const again = runCli(['do'], { cwd: dir, env });
    const after = runCli([], { cwd: dir, env });
    assert.equal(again.status, 0, again.stderr || again.stdout);
    assert.equal(after.status, 0, after.stderr || after.stdout);
    assert.equal(again.stdout.trim(), after.stdout.trim());
    assert.match(after.stdout, /"notes\.txt" is already yours/);
    assert.equal(nextLine(after.stdout), 'atris do');
    assert.doesNotMatch(after.stdout, /notes\.txt is already here|this folder is empty|atris task (claim|show) |ready to claim/);
    assert.equal(nextLine(again.stdout), nextLine(doit.stdout));
  } finally {
    cleanupTempDir(dir);
  }
});

test('atris do in an unbound folder starts from a few files with one title', () => {
  const dir = makeTempDir();
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'one\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'draft.md'), 'two\n', 'utf8');
  const env = { HOME: home, USER: 'keshav', ATRIS_TASKS_DB: path.join(dir, 'tasks.db') };
  try {
    const minute = runCli([], { cwd: dir, env });
    assert.match(minute.stdout, /hey keshav, draft.md and notes.txt are already here\./);
    assert.match(minute.stdout, /^next: atris do$/m);

    const doit = runCli(['do'], { cwd: dir, env, timeout: 60000 });
    assert.equal(doit.status, 0, doit.stderr || doit.stdout);
    assert.match(doit.stdout, /hey keshav, draft.md and notes.txt is ready\./);
    assert.match(doit.stdout, /^next: atris do$/m);
    assert.doesNotMatch(doit.stdout, /already here|PROMPT ONLY|executor\.md|atris task (claim|show) /);
    assert.equal(spokenLineCount(doit.stdout), 2);

    const manyDir = makeTempDir();
    const manyHome = path.join(manyDir, 'home');
    fs.mkdirSync(manyHome, { recursive: true });
    fs.writeFileSync(path.join(manyDir, 'a.txt'), 'a\n', 'utf8');
    fs.writeFileSync(path.join(manyDir, 'b.txt'), 'b\n', 'utf8');
    fs.writeFileSync(path.join(manyDir, 'c.txt'), 'c\n', 'utf8');
    const manyEnv = { HOME: manyHome, USER: 'keshav', ATRIS_TASKS_DB: path.join(manyDir, 'tasks.db') };
    try {
      const manyDo = runCli(['do'], { cwd: manyDir, env: manyEnv, timeout: 60000 });
      assert.equal(manyDo.status, 0, manyDo.stderr || manyDo.stdout);
      assert.match(manyDo.stdout, /hey keshav, this folder is ready\./);
      assert.match(manyDo.stdout, /^next: atris do$/m);
      assert.doesNotMatch(manyDo.stdout, /already here|a\.txt|PROMPT ONLY|atris task (claim|show) /);
    } finally {
      cleanupTempDir(manyDir);
    }
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
    assert.match(doit.stdout, /^next: atris "what do you want here\?"$/m);
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
    assert.equal(nextLine(doit.stdout), 'atris do');
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
    assert.match(next.stdout, /^next: atris "what do you want here\?"$/m);
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
    assert.match(created.stdout, /^next: atris "what do you want here\?"$/m);
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
    const missionStatus = runCli(['mission', 'status'], { cwd: dir, env });
    const missionList = runCli(['mission', 'list'], { cwd: dir, env });
    assert.equal(minute.status, 0, minute.stderr || minute.stdout);
    assert.equal(asked.status, 0, asked.stderr || asked.stdout);
    assert.equal(askedWant.status, 0, askedWant.stderr || askedWant.stdout);
    assert.equal(mission.status, 0, mission.stderr || mission.stdout);
    assert.equal(asked.stdout.trim(), minute.stdout.trim());
    assert.equal(askedWant.stdout.trim(), minute.stdout.trim());
    assert.equal(mission.stdout.trim(), minute.stdout.trim());
    assert.equal(missionStatus.stdout.trim(), minute.stdout.trim());
    assert.equal(missionList.stdout.trim(), minute.stdout.trim());
    assert.match(asked.stdout, /this folder is empty/);
    assert.match(mission.stdout, /this folder is empty/);
    assert.match(asked.stdout, /^next: atris "what do you want here\?"$/m);
    assert.match(mission.stdout, /^next: atris "what do you want here\?"$/m);
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

test('atris stop in an empty folder talks first-talk, not cloud-computer', () => {
  const dir = makeTempDir();
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  const env = { HOME: home, USER: 'keshav', ATRIS_TASKS_DB: path.join(dir, 'tasks.db') };
  try {
    const minute = runCli([], { cwd: dir, env });
    const stopped = runCli(['stop'], { cwd: dir, env });
    assert.equal(minute.status, 0, minute.stderr || minute.stdout);
    assert.equal(stopped.status, 0, stopped.stderr || stopped.stdout);
    assert.match(stopped.stdout, /^hey keshav, nothing is running\.$/m);
    assert.match(stopped.stdout, /^next: atris "what do you want here\?"$/m);
    assert.equal(nextLine(stopped.stdout), nextLine(minute.stdout));
    assert.equal(spokenLineCount(stopped.stdout), spokenLineCount(minute.stdout));
    assert.doesNotMatch(stopped.stdout + stopped.stderr, /cloud-computer|business\.json|init|Pass --mission|Atris left your work unchanged/);
    assert.equal(fs.existsSync(path.join(dir, 'atris')), false);
    assert.equal(fs.existsSync(path.join(dir, '.atris')), false);

    const jsonStop = runCli(['stop', '--json'], { cwd: dir, env });
    const jsonMinute = runCli(['--json'], { cwd: dir, env });
    assert.equal(jsonStop.status, jsonMinute.status);
    const payload = JSON.parse(jsonStop.stdout);
    assert.equal(payload.reason, 'nothing is running');
    assert.equal(payload.next_action, 'atris "what do you want here?"');
    assert.doesNotMatch(jsonStop.stdout, /cloud-computer|business\.json|init|Pass --mission/);
    assert.equal(fs.existsSync(path.join(dir, 'atris')), false);
    assert.equal(fs.existsSync(path.join(dir, '.atris')), false);

    const help = runCli(['stop', '--help'], { cwd: dir, env });
    assert.equal(help.status, 0, help.stderr || help.stdout);
    assert.match(help.stdout, /Usage: atris stop/);
    assert.doesNotMatch(help.stdout, /nothing is running|cloud-computer|business\.json|clean start/);
    assert.equal(fs.existsSync(path.join(dir, 'atris')), false);
    assert.equal(fs.existsSync(path.join(dir, '.atris')), false);
  } finally {
    cleanupTempDir(dir);
  }
});

test('atris status in an empty folder talks first-talk, not init', () => {
  const dir = makeTempDir();
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  const env = { HOME: home, USER: 'keshav', ATRIS_TASKS_DB: path.join(dir, 'tasks.db') };
  try {
    const minute = runCli([], { cwd: dir, env });
    const status = runCli(['status'], { cwd: dir, env });
    assert.equal(minute.status, 0, minute.stderr || minute.stdout);
    assert.equal(status.status, 0, status.stderr || status.stdout);
    assert.match(status.stdout, /^hey keshav, nothing is running\.$/m);
    assert.match(status.stdout, /^next: atris "what do you want here\?"$/m);
    assert.equal(nextLine(status.stdout), nextLine(minute.stdout));
    assert.equal(spokenLineCount(status.stdout), spokenLineCount(minute.stdout));
    assert.doesNotMatch(status.stdout + status.stderr, /Run "atris init"|folder not found|init --minimal|claim|cloud-computer|business\.json|Where we are|TASK BOARD/);
    assert.equal(fs.existsSync(path.join(dir, 'atris')), false);
    assert.equal(fs.existsSync(path.join(dir, '.atris')), false);

    const jsonStatus = runCli(['status', '--json'], { cwd: dir, env });
    const jsonMinute = runCli(['--json'], { cwd: dir, env });
    assert.equal(jsonStatus.status, jsonMinute.status);
    const payload = JSON.parse(jsonStatus.stdout);
    assert.equal(payload.reason, 'nothing is running');
    assert.equal(payload.next_action, 'atris "what do you want here?"');
    assert.doesNotMatch(jsonStatus.stdout, /folder not found|init|claim/);
    assert.equal(fs.existsSync(path.join(dir, 'atris')), false);
    assert.equal(fs.existsSync(path.join(dir, '.atris')), false);

    const quick = runCli(['status', '--quick'], { cwd: dir, env });
    assert.equal(quick.status, 0, quick.stderr || quick.stdout);
    assert.match(quick.stdout, /^hey keshav, nothing is running\.$/m);
    assert.match(quick.stdout, /^next: atris "what do you want here\?"$/m);
    assert.doesNotMatch(quick.stdout + quick.stderr, /Run "atris init"|folder not found|📋/);
    assert.equal(fs.existsSync(path.join(dir, 'atris')), false);
    assert.equal(fs.existsSync(path.join(dir, '.atris')), false);

    const help = runCli(['status', '--help'], { cwd: dir, env });
    assert.equal(help.status, 0, help.stderr || help.stdout);
    assert.match(help.stdout, /Usage: atris status/);
    assert.doesNotMatch(help.stdout, /nothing is running|this folder is empty|Run "atris init"|clean start/);
    assert.equal(fs.existsSync(path.join(dir, 'atris')), false);
    assert.equal(fs.existsSync(path.join(dir, '.atris')), false);

    const now = runCli(['now'], { cwd: dir, env });
    assert.equal(now.status, 0, now.stderr || now.stdout);
    assert.equal(now.stdout.trim(), minute.stdout.trim());
    assert.match(now.stdout, /^hey keshav, this folder is empty\.$/m);
    assert.match(now.stdout, /^next: atris "what do you want here\?"$/m);
    assert.doesNotMatch(now.stdout + now.stderr, /Run "atris init"|folder not found|init --minimal|claim|# now|Current operating truth/);
    assert.equal(fs.existsSync(path.join(dir, 'atris')), false);
    assert.equal(fs.existsSync(path.join(dir, '.atris')), false);
  } finally {
    cleanupTempDir(dir);
  }
});

test('atris now in an empty folder talks first-talk, not init', () => {
  const dir = makeTempDir();
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  const env = { HOME: home, USER: 'keshav', ATRIS_TASKS_DB: path.join(dir, 'tasks.db') };
  try {
    const minute = runCli([], { cwd: dir, env });
    const now = runCli(['now'], { cwd: dir, env });
    assert.equal(minute.status, 0, minute.stderr || minute.stdout);
    assert.equal(now.status, 0, now.stderr || now.stdout);
    assert.equal(now.stdout.trim(), minute.stdout.trim());
    assert.match(now.stdout, /^hey keshav, this folder is empty\.$/m);
    assert.match(now.stdout, /^next: atris "what do you want here\?"$/m);
    assert.equal(spokenLineCount(now.stdout), spokenLineCount(minute.stdout));
    assert.doesNotMatch(now.stdout + now.stderr, /Run "atris init"|folder not found|init --minimal|claim|# now|Current operating truth|Generate MAP\.md/);
    assert.equal(fs.existsSync(path.join(dir, 'atris')), false);
    assert.equal(fs.existsSync(path.join(dir, '.atris')), false);

    const jsonNow = runCli(['now', '--json'], { cwd: dir, env });
    const jsonMinute = runCli(['--json'], { cwd: dir, env });
    assert.equal(jsonNow.status, jsonMinute.status);
    const payload = JSON.parse(jsonNow.stdout);
    assert.equal(payload.ok, false);
    assert.equal(payload.current, 'this folder is empty');
    assert.equal(payload.next, 'atris "what do you want here?"');
    assert.doesNotMatch(jsonNow.stdout, /folder not found|init|claim|# now/);
    assert.equal(fs.existsSync(path.join(dir, 'atris')), false);
    assert.equal(fs.existsSync(path.join(dir, '.atris')), false);

    const help = runCli(['now', '--help'], { cwd: dir, env });
    assert.equal(help.status, 0, help.stderr || help.stdout);
    assert.match(help.stdout, /Usage: atris now/);
    assert.doesNotMatch(help.stdout, /this folder is empty|Run "atris init"|# now|Current operating truth/);
    assert.equal(fs.existsSync(path.join(dir, 'atris')), false);
    assert.equal(fs.existsSync(path.join(dir, '.atris')), false);
  } finally {
    cleanupTempDir(dir);
  }
});

test('atris status and stop in a folder with a file name the file, not empty first-talk', () => {
  const dir = makeTempDir();
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'already writing\n', 'utf8');
  const env = { HOME: home, USER: 'keshav', ATRIS_TASKS_DB: path.join(dir, 'tasks.db') };
  try {
    const minute = runCli([], { cwd: dir, env });
    const status = runCli(['status'], { cwd: dir, env });
    const stopped = runCli(['stop'], { cwd: dir, env });
    assert.equal(minute.status, 0, minute.stderr || minute.stdout);
    assert.equal(status.status, 0, status.stderr || status.stdout);
    assert.equal(stopped.status, 0, stopped.stderr || stopped.stdout);
    assert.equal(status.stdout.trim(), minute.stdout.trim());
    assert.equal(stopped.stdout.trim(), minute.stdout.trim());
    assert.match(status.stdout, /^hey keshav, notes.txt is already here\.$/m);
    assert.match(status.stdout, /^next: atris do$/m);
    assert.match(stopped.stdout, /^hey keshav, notes.txt is already here\.$/m);
    assert.match(stopped.stdout, /^next: atris do$/m);
    assert.doesNotMatch(status.stdout + stopped.stdout, /nothing is running|what do you want here|this folder is empty|Run "atris init"|cloud-computer|business\.json/);
    assert.equal(spokenLineCount(status.stdout), spokenLineCount(minute.stdout));
    assert.equal(fs.existsSync(path.join(dir, 'atris')), false);
    assert.equal(fs.existsSync(path.join(dir, '.atris')), false);

    const jsonStatus = runCli(['status', '--json'], { cwd: dir, env });
    const jsonStop = runCli(['stop', '--json'], { cwd: dir, env });
    const jsonMinute = runCli(['--json'], { cwd: dir, env });
    assert.equal(jsonStatus.status, jsonMinute.status);
    assert.equal(jsonStop.status, jsonMinute.status);
    const statusPayload = JSON.parse(jsonStatus.stdout);
    const stopPayload = JSON.parse(jsonStop.stdout);
    assert.equal(statusPayload.reason, 'notes.txt is already here');
    assert.equal(statusPayload.next_action, 'atris do');
    assert.equal(stopPayload.reason, 'notes.txt is already here');
    assert.equal(stopPayload.next_action, 'atris do');
    assert.doesNotMatch(jsonStatus.stdout + jsonStop.stdout, /nothing is running|what do you want here|init|claim/);
    assert.equal(fs.existsSync(path.join(dir, 'atris')), false);
    assert.equal(fs.existsSync(path.join(dir, '.atris')), false);

    const quick = runCli(['status', '--quick'], { cwd: dir, env });
    assert.equal(quick.status, 0, quick.stderr || quick.stdout);
    assert.equal(quick.stdout.trim(), minute.stdout.trim());
    assert.doesNotMatch(quick.stdout + quick.stderr, /nothing is running|what do you want here|Run "atris init"|📋/);
    assert.equal(fs.existsSync(path.join(dir, 'atris')), false);
    assert.equal(fs.existsSync(path.join(dir, '.atris')), false);

    const help = runCli(['status', '--help'], { cwd: dir, env });
    assert.equal(help.status, 0, help.stderr || help.stdout);
    assert.match(help.stdout, /Usage: atris status/);
    assert.doesNotMatch(help.stdout, /notes.txt is already here|nothing is running|this folder is empty|Run "atris init"/);
    assert.equal(fs.existsSync(path.join(dir, 'atris')), false);

    const now = runCli(['now'], { cwd: dir, env });
    assert.equal(now.status, 0, now.stderr || now.stdout);
    assert.equal(now.stdout.trim(), minute.stdout.trim());
    assert.match(now.stdout, /^hey keshav, notes.txt is already here\.$/m);
    assert.match(now.stdout, /^next: atris do$/m);
    assert.doesNotMatch(now.stdout + now.stderr, /Run "atris init"|folder not found|# now|Current operating truth|Generate MAP\.md/);
    assert.equal(fs.existsSync(path.join(dir, 'atris')), false);
    assert.equal(fs.existsSync(path.join(dir, '.atris')), false);
  } finally {
    cleanupTempDir(dir);
  }
});

test('atris now in a folder with a file names the file, not init', () => {
  const dir = makeTempDir();
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(dir, 'notes.md'), 'already writing\n', 'utf8');
  const env = { HOME: home, USER: 'keshav', ATRIS_TASKS_DB: path.join(dir, 'tasks.db') };
  try {
    const minute = runCli([], { cwd: dir, env });
    const now = runCli(['now'], { cwd: dir, env });
    const status = runCli(['status'], { cwd: dir, env });
    assert.equal(minute.status, 0, minute.stderr || minute.stdout);
    assert.equal(now.status, 0, now.stderr || now.stdout);
    assert.equal(status.status, 0, status.stderr || status.stdout);
    assert.equal(now.stdout.trim(), minute.stdout.trim());
    assert.equal(now.stdout.trim(), status.stdout.trim());
    assert.match(now.stdout, /^hey keshav, notes.md is already here\.$/m);
    assert.match(now.stdout, /^next: atris do$/m);
    assert.equal(spokenLineCount(now.stdout), spokenLineCount(minute.stdout));
    assert.doesNotMatch(now.stdout + now.stderr, /Run "atris init"|folder not found|init --minimal|claim|# now|Current operating truth|Generate MAP\.md|nothing is running|what do you want here/);
    assert.equal(fs.existsSync(path.join(dir, 'atris')), false);
    assert.equal(fs.existsSync(path.join(dir, '.atris')), false);

    const jsonNow = runCli(['now', '--json'], { cwd: dir, env });
    const jsonMinute = runCli(['--json'], { cwd: dir, env });
    assert.equal(jsonNow.status, jsonMinute.status);
    const payload = JSON.parse(jsonNow.stdout);
    assert.equal(payload.ok, false);
    assert.equal(payload.current, 'notes.md is already here');
    assert.equal(payload.next, 'atris do');
    assert.doesNotMatch(jsonNow.stdout, /folder not found|init|claim|# now/);
    assert.equal(fs.existsSync(path.join(dir, 'atris')), false);
    assert.equal(fs.existsSync(path.join(dir, '.atris')), false);

    const help = runCli(['now', '--help'], { cwd: dir, env });
    assert.equal(help.status, 0, help.stderr || help.stdout);
    assert.match(help.stdout, /Usage: atris now/);
    assert.doesNotMatch(help.stdout, /notes.md is already here|Run "atris init"|# now/);
    assert.equal(fs.existsSync(path.join(dir, 'atris')), false);
  } finally {
    cleanupTempDir(dir);
  }
});

test('atris now after init --yes --minimal talks the claim, not factory now.md', () => {
  const dir = makeTempDir();
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'already writing\n', 'utf8');
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
    const now = runCli(['now'], { cwd: dir, env });
    assert.equal(minute.status, 0, minute.stderr || minute.stdout);
    assert.equal(now.status, 0, now.stderr || now.stdout);
    assert.equal(now.stdout.trim(), minute.stdout.trim());
    assert.match(now.stdout, /generate map\.md/i);
    assert.match(now.stdout, /ready to claim/);
    assert.match(now.stdout, /^next: atris task claim /m);
    assert.equal(nextLine(now.stdout), nextLine(minute.stdout));
    assert.match(nextLine(now.stdout), /^atris task claim \S+ --as \S+$/);
    assert.equal(spokenLineCount(now.stdout), spokenLineCount(minute.stdout));
    assert.equal(spokenLineCount(now.stdout), 2);
    assert.doesNotMatch(
      now.stdout + now.stderr,
      /# now|Current operating truth|What Matters Now|While You Were Away|Current Priority|## Signals|Open TODO items|Generate MAP\.md|this folder is empty|notes\.txt is already here|already yours/,
    );
    assert.ok(fs.existsSync(path.join(dir, 'atris', 'MAP.md')));
    assert.equal(fs.existsSync(path.join(dir, '.atris', 'business.json')), false);

    const jsonNow = runCli(['now', '--json'], { cwd: dir, env });
    assert.equal(jsonNow.status, 0, jsonNow.stderr || jsonNow.stdout);
    const payload = JSON.parse(jsonNow.stdout);
    assert.equal(payload.ok, true);
    assert.match(String(payload.current || ''), /ready to claim/);
    assert.match(String(payload.next || ''), /^atris task claim \S+ --as \S+$/);
    assert.equal(payload.next, nextLine(now.stdout));
    assert.doesNotMatch(jsonNow.stdout, /# now|Current operating truth|What Matters Now|Open TODO items/);

    const help = runCli(['now', '--help'], { cwd: dir, env });
    assert.equal(help.status, 0, help.stderr || help.stdout);
    assert.match(help.stdout, /Usage: atris now/);
    assert.doesNotMatch(help.stdout, /ready to claim|# now|Current operating truth/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('atris status and stop in a git folder name the last commit, not empty first-talk', () => {
  const dir = makeTempDir();
  const homeParent = makeTempDir();
  const home = path.join(homeParent, 'home');
  fs.mkdirSync(home, { recursive: true });
  commitIn(dir, 'add notes app', {
    'notes.txt': 'already writing\n',
    'draft.md': 'two\n',
  });
  const env = { HOME: home, USER: 'keshav', ATRIS_TASKS_DB: path.join(home, 'tasks.db') };
  try {
    const minute = runCli([], { cwd: dir, env });
    const status = runCli(['status'], { cwd: dir, env });
    const stopped = runCli(['stop'], { cwd: dir, env });
    assert.equal(minute.status, 0, minute.stderr || minute.stdout);
    assert.equal(status.status, 0, status.stderr || status.stdout);
    assert.equal(stopped.status, 0, stopped.stderr || stopped.stdout);
    assert.equal(status.stdout.trim(), minute.stdout.trim());
    assert.equal(stopped.stdout.trim(), minute.stdout.trim());
    assert.match(status.stdout, /^hey keshav, add notes app is already here\.$/m);
    assert.match(status.stdout, /^next: atris do$/m);
    assert.match(stopped.stdout, /^hey keshav, add notes app is already here\.$/m);
    assert.match(stopped.stdout, /^next: atris do$/m);
    assert.doesNotMatch(status.stdout + stopped.stdout, /nothing is running|what do you want here|notes\.txt|draft\.md|this folder is empty/);
    assert.equal(fs.existsSync(path.join(dir, 'atris')), false);
    assert.equal(fs.existsSync(path.join(dir, '.atris')), false);

    const jsonStatus = runCli(['status', '--json'], { cwd: dir, env });
    const jsonStop = runCli(['stop', '--json'], { cwd: dir, env });
    assert.equal(JSON.parse(jsonStatus.stdout).reason, 'add notes app is already here');
    assert.equal(JSON.parse(jsonStatus.stdout).next_action, 'atris do');
    assert.equal(JSON.parse(jsonStop.stdout).reason, 'add notes app is already here');
    assert.equal(JSON.parse(jsonStop.stdout).next_action, 'atris do');
    assert.equal(fs.existsSync(path.join(dir, 'atris')), false);
    assert.equal(fs.existsSync(path.join(dir, '.atris')), false);
  } finally {
    cleanupTempDir(dir);
    cleanupTempDir(homeParent);
  }
});

test('atris status after minting a file folder talks keep-working, not factory let-it-run', () => {
  const dir = makeTempDir();
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(dir, 'notes.md'), 'already writing\n', 'utf8');
  const env = {
    HOME: home,
    USER: 'keshav',
    ATRIS_NO_INTERACTIVE: '1',
    ATRIS_TASKS_DB: path.join(dir, 'tasks.db'),
  };
  try {
    const firstDo = runCli(['do'], { cwd: dir, env, timeout: 60000 });
    assert.equal(firstDo.status, 0, firstDo.stderr || firstDo.stdout);
    assert.match(firstDo.stdout, /hey keshav, notes.md is ready\./);
    assert.match(firstDo.stdout, /^next: atris do$/m);
    assert.ok(fs.existsSync(path.join(dir, 'atris', 'TODO.md')));
    assert.equal(fs.existsSync(path.join(dir, '.atris', 'business.json')), false);

    const listed = runCli(['mission', 'list'], { cwd: dir, env });
    assert.equal(listed.status, 0, listed.stderr || listed.stdout);
    assert.match(listed.stdout, /No missions yet/i);

    const minute = runCli([], { cwd: dir, env });
    const again = runCli(['do'], { cwd: dir, env });
    const status = runCli(['status'], { cwd: dir, env });
    const recap = runCli(['recap'], { cwd: dir, env });
    const now = runCli(['now'], { cwd: dir, env });
    assert.equal(minute.status, 0, minute.stderr || minute.stdout);
    assert.equal(again.status, 0, again.stderr || again.stdout);
    assert.equal(status.status, 0, status.stderr || status.stdout);
    assert.equal(recap.status, 0, recap.stderr || recap.stdout);
    assert.equal(now.status, 0, now.stderr || now.stdout);
    assert.equal(status.stdout.trim(), again.stdout.trim());
    assert.equal(status.stdout.trim(), minute.stdout.trim());
    assert.equal(recap.stdout.trim(), status.stdout.trim());
    assert.equal(now.stdout.trim(), status.stdout.trim());
    assert.match(status.stdout, /^hey keshav, "notes\.md" is already yours\.$/m);
    assert.match(status.stdout, /^next: atris do$/m);
    assert.match(recap.stdout, /^hey keshav, "notes\.md" is already yours\.$/m);
    assert.match(recap.stdout, /^next: atris do$/m);
    assert.match(now.stdout, /^hey keshav, "notes\.md" is already yours\.$/m);
    assert.match(now.stdout, /^next: atris do$/m);
    assert.equal(spokenLineCount(status.stdout), 2);
    assert.doesNotMatch(
      status.stdout + status.stderr + recap.stdout + recap.stderr + now.stdout + now.stderr,
      /Where we are|Decision: let it run|Generate MAP\.md|TASK BOARD|nothing is running|what do you want here|ready to claim|# now|Current operating truth/,
    );

    const jsonStatus = runCli(['status', '--json'], { cwd: dir, env });
    assert.equal(jsonStatus.status, 0, jsonStatus.stderr || jsonStatus.stdout);
    const payload = JSON.parse(jsonStatus.stdout);
    assert.equal(payload.next_action, 'atris do');
    assert.equal(payload.reason, '"notes.md" is already yours');
    assert.doesNotMatch(jsonStatus.stdout, /Where we are|let it run|Generate MAP/);

    const jsonRecap = runCli(['recap', '--json'], { cwd: dir, env });
    assert.equal(jsonRecap.status, 0, jsonRecap.stderr || jsonRecap.stdout);
    const recapPayload = JSON.parse(jsonRecap.stdout);
    assert.equal(recapPayload.next_action, 'atris do');
    assert.equal(recapPayload.reason, '"notes.md" is already yours');
    assert.doesNotMatch(jsonRecap.stdout, /Where we are|let it run|Generate MAP|ready to claim/);

    const jsonNow = runCli(['now', '--json'], { cwd: dir, env });
    assert.equal(jsonNow.status, 0, jsonNow.stderr || jsonNow.stdout);
    const nowPayload = JSON.parse(jsonNow.stdout);
    assert.equal(nowPayload.ok, true);
    assert.equal(nowPayload.next, 'atris do');
    assert.equal(nowPayload.current, '"notes.md" is already yours');
    assert.doesNotMatch(jsonNow.stdout, /Where we are|let it run|Generate MAP|# now/);

    const quick = runCli(['status', '--quick'], { cwd: dir, env });
    assert.equal(quick.status, 0, quick.stderr || quick.stdout);
    assert.equal(quick.stdout.trim(), status.stdout.trim());
    assert.doesNotMatch(quick.stdout + quick.stderr, /Where we are|Decision: let it run|📋/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('atris status after mint still tells the truth when a live mission is running', () => {
  const dir = makeTempDir();
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(dir, 'notes.md'), 'already writing\n', 'utf8');
  const env = {
    HOME: home,
    USER: 'keshav',
    ATRIS_NO_INTERACTIVE: '1',
    ATRIS_TASKS_DB: path.join(dir, 'tasks.db'),
  };
  try {
    const firstDo = runCli(['do'], { cwd: dir, env, timeout: 60000 });
    assert.equal(firstDo.status, 0, firstDo.stderr || firstDo.stdout);
    assert.ok(fs.existsSync(path.join(dir, 'atris', 'TODO.md')));

    fs.mkdirSync(path.join(dir, '.atris', 'state'), { recursive: true });
    const now = new Date().toISOString();
    fs.writeFileSync(path.join(dir, '.atris', 'state', 'missions.jsonl'), `${JSON.stringify({
      schema: 'atris.mission.v1',
      id: 'mission-live',
      objective: 'Keep the live mission visible',
      owner: 'executor',
      status: 'running',
      created_at: now,
      updated_at: now,
    })}\n`);

    const status = runCli(['status'], { cwd: dir, env });
    assert.equal(status.status, 0, status.stderr || status.stdout);
    assert.match(status.stdout, /Where we are:/);
    assert.match(status.stdout, /Decision: let it run/);
    assert.doesNotMatch(status.stdout, /"notes\.md" is already yours/);
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
    assert.match(wish.stdout, /^next: atris "what do you want here\?"$/m);
    assert.equal(spokenLineCount(wish.stdout), spokenLineCount(minute.stdout));
    assert.doesNotMatch(wish.stdout, /Usage: atris wish|wish list|wish grant|wish stats|wish board|wish rewards/);
    assert.doesNotMatch(wish.stdout, /Run "atris init"/);
    assert.equal(fs.existsSync(path.join(dir, 'atris')), false);

    const leftover = runCli(['wish', 'count the words'], { cwd: dir, env });
    assert.equal(leftover.status, 0, leftover.stderr || leftover.stdout);
    assert.equal(leftover.stdout.trim(), minute.stdout.trim());
    assert.match(leftover.stdout, /this folder is empty/);
    assert.match(leftover.stdout, /^next: atris "what do you want here\?"$/m);
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
    assert.match(leftover.stdout, /^next: atris "what do you want here\?"$/m);
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
    assert.match(leftover.stdout, /^next: atris "what do you want here\?"$/m);
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
    assert.match(nextLine(verb.stdout), /^atris task (claim|show|ready) |^atris do$/);
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
    assert.equal(nextLine(afterVerb.stdout), 'atris do');
    assert.doesNotMatch(afterVerb.stdout, /BOOTSTRAP REQUIRED|For an agent|generate a complete `atris\/MAP\.md`/);
    assert.doesNotMatch(afterVerb.stdout, /Got it\. I saved your first direction|First useful step: test|next setup: open atris\/MAP\.md/);

    fs.rmSync(path.join(dir, 'atris', 'MAP.md'), { force: true });
    const missing = runCli(['test'], { cwd: dir, env });
    assert.equal(missing.status, 0, missing.stderr || missing.stdout);
    assert.equal(nextLine(missing.stdout), 'atris do');
    assert.doesNotMatch(missing.stdout, /BOOTSTRAP REQUIRED|For an agent|generate a complete `atris\/MAP\.md`/);

    const json = runCli(['test', '--json'], { cwd: dir, env });
    assert.equal(json.status, 2, json.stderr || json.stdout);
    const payload = JSON.parse(json.stdout);
    assert.equal(payload.next_action, 'atris do');
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

test('bare mission in a live room speaks the desk next, not the archive', () => {
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
    writeReadyWorkspace(dir, [{
      id: 'task-map',
      display_id: 'CLI-193',
      title: 'write a feature map for the live room',
      status: 'review',
      review: { agent_certified: true, agent_review_pass_count: 2 },
      created_at: 1,
      updated_at: 2,
    }]);
    fs.writeFileSync(
      path.join(dir, 'atris', 'reports', 'rebased-pack-co-first-loop-recap.md'),
      '# Rebased Pack Co First Loop Recap\n',
    );
    const old = '2026-01-01T00:00:00Z';
    const archiveRows = [
      {
        schema: 'atris.mission.v1',
        id: 'mission-done',
        objective: 'Ship the old pack',
        owner: 'executor',
        status: 'complete',
        created_at: old,
        updated_at: old,
      },
      {
        schema: 'atris.mission.v1',
        id: 'mission-stopped',
        objective: 'Stop the stale loop',
        owner: 'executor',
        status: 'stopped',
        created_at: old,
        updated_at: old,
      },
      {
        schema: 'atris.mission.v1',
        id: 'mission-ready-old',
        objective: 'Ready for a hundred days',
        owner: 'executor',
        status: 'ready',
        created_at: old,
        updated_at: old,
        last_tick_at: old,
      },
    ];
    fs.writeFileSync(
      path.join(dir, '.atris', 'state', 'missions.jsonl'),
      `${archiveRows.map((row) => JSON.stringify(row)).join('\n')}\n`,
    );

    const minute = runCli([], { cwd: dir, env });
    const mission = runCli(['mission'], { cwd: dir, env });
    const missionStatus = runCli(['mission', 'status'], { cwd: dir, env });
    assert.equal(minute.status, 0, minute.stderr || minute.stdout);
    assert.equal(mission.status, 0, mission.stderr || mission.stdout);
    assert.equal(mission.stdout.trim(), minute.stdout.trim());
    assert.equal(missionStatus.stdout.trim(), minute.stdout.trim());
    assertDeskAcceptsReview(mission.stdout);
    assert.equal(nextLine(mission.stdout), nextLine(minute.stdout));
    assert.equal((mission.stdout.match(/^Mission:/mg) || []).length, 0, mission.stdout);
    assert.doesNotMatch(mission.stdout, /Ship the old pack|Stop the stale loop|Ready for a hundred days|mission-done|mission-stopped|mission-ready-old/);

    const archive = runCli(['mission', '--all'], { cwd: dir, env });
    assert.equal(archive.status, 0, archive.stderr || archive.stdout);
    assert.ok((archive.stdout.match(/^Mission:/mg) || []).length >= 3, archive.stdout);
    assert.match(archive.stdout, /Ship the old pack|mission-done/);

    const listed = runCli(['mission', 'list'], { cwd: dir, env });
    assert.equal(listed.status, 0, listed.stderr || listed.stdout);
    assert.ok((listed.stdout.match(/^Mission:/mg) || []).length >= 3, listed.stdout);

    const helpBefore = fs.readFileSync(path.join(dir, '.atris', 'state', 'missions.jsonl'), 'utf8');
    const help = runCli(['mission', '--help'], { cwd: dir, env });
    assert.equal(help.status, 0, help.stderr || help.stdout);
    assert.match(help.stdout, /Usage: atris mission|atris mission /);
    assert.doesNotMatch(help.stdout, /waiting for your ok|write a feature map|Ship the old pack/);
    assert.equal(fs.readFileSync(path.join(dir, '.atris', 'state', 'missions.jsonl'), 'utf8'), helpBefore);

    const now = new Date().toISOString();
    fs.appendFileSync(path.join(dir, '.atris', 'state', 'missions.jsonl'), `${JSON.stringify({
      schema: 'atris.mission.v1',
      id: 'mission-live',
      objective: 'Keep the live mission visible',
      owner: 'executor',
      status: 'running',
      created_at: now,
      updated_at: now,
      last_tick_at: now,
    })}\n`);
    const live = runCli(['mission'], { cwd: dir, env });
    assert.equal(live.status, 0, live.stderr || live.stdout);
    assert.equal((live.stdout.match(/^Mission:/mg) || []).length, 1, live.stdout);
    assert.match(live.stdout, /mission-live|Keep the live mission visible/);
    assert.doesNotMatch(live.stdout, /waiting for your ok|Ship the old pack|Stop the stale loop|Ready for a hundred days/);

    const liveJson = runCli(['mission', '--json'], { cwd: dir, env });
    assert.equal(liveJson.status, 0, liveJson.stderr || liveJson.stdout);
    const livePayload = JSON.parse(liveJson.stdout);
    assert.equal(livePayload.action, 'mission_status');
    assert.equal(livePayload.missions.length, 1);
    assert.equal(livePayload.missions[0].id, 'mission-live');
  } finally {
    cleanupTempDir(dir);
  }
});

test('bare mission yields the desk next when a ready mission is stalled', () => {
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
    writeReadyWorkspace(dir, [{
      id: 'task-map',
      display_id: 'CLI-193',
      title: 'write a feature map for the live room',
      status: 'review',
      review: { agent_certified: true, agent_review_pass_count: 2 },
      created_at: 1,
      updated_at: 2,
    }]);
    const lastTick = new Date(Date.now() - (13 * 60 * 60 * 1000)).toISOString();
    fs.writeFileSync(
      path.join(dir, '.atris', 'state', 'missions.jsonl'),
      `${JSON.stringify({
        schema: 'atris.mission.v1',
        id: 'mission-80',
        n: 80,
        objective: 'Keep the overnight loop warm',
        owner: 'executor',
        status: 'ready',
        created_at: lastTick,
        updated_at: lastTick,
        last_tick_at: lastTick,
      })}\n`,
    );

    const minute = runCli([], { cwd: dir, env });
    const mission = runCli(['mission'], { cwd: dir, env });
    assert.equal(minute.status, 0, minute.stderr || minute.stdout);
    assert.equal(mission.status, 0, mission.stderr || mission.stdout);
    assert.equal(mission.stdout.trim(), minute.stdout.trim());
    assertDeskAcceptsReview(mission.stdout);
    assert.equal(nextLine(mission.stdout), nextLine(minute.stdout));
    assert.equal((mission.stdout.match(/^Mission:/mg) || []).length, 0, mission.stdout);
    assert.doesNotMatch(mission.stdout, /Keep the overnight loop warm|mission-80|no live driver|atris mission run 80/);

    const listed = runCli(['mission', 'list'], { cwd: dir, env });
    assert.equal(listed.status, 0, listed.stderr || listed.stdout);
    assert.match(listed.stdout, /mission-80|Keep the overnight loop warm/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('leftover review in a shared db does not hijack a git room first-minute', () => {
  const parent = makeTempDir();
  const home = path.join(parent, 'home');
  const leftover = path.join(parent, 'leftover-room');
  const room = path.join(parent, 'fresh-room');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(leftover, { recursive: true });
  const dbPath = path.join(parent, 'shared.db');
  const env = {
    HOME: home,
    USER: 'keshav',
    ATRIS_NO_INTERACTIVE: '1',
    ATRIS_TASKS_DB: dbPath,
  };
  const taskDb = require('../lib/task-db');
  try {
    writeReadyWorkspace(leftover, [{
      id: 'task-map',
      display_id: 'CLI-193',
      title: 'write a feature map for the live room',
      status: 'review',
      review: { agent_certified: true, agent_review_pass_count: 2 },
      created_at: 1,
      updated_at: 2,
    }]);
    fs.writeFileSync(
      path.join(leftover, 'atris', 'reports', 'rebased-pack-co-first-loop-recap.md'),
      '# Rebased Pack Co First Loop Recap\n',
    );
    taskDb.close();
    const db = taskDb.open(dbPath);
    const added = taskDb.addTask(db, {
      title: 'write a feature map for the live room',
      workspaceRoot: leftover,
      status: 'review',
      claimedBy: 'executor',
      metadata: { review: { agent_certified: true, agent_review_pass_count: 2 } },
    });
    assert.equal(added.inserted, true, 'leftover review must land in the shared db');
    taskDb.close();

    const leftoverMinute = runCli([], { cwd: leftover, env });
    assert.equal(leftoverMinute.status, 0, leftoverMinute.stderr || leftoverMinute.stdout);
    assert.match(leftoverMinute.stdout, /something finished\. waiting on you\.|waiting for your ok/);
    assert.match(nextLine(leftoverMinute.stdout), /^atris task accept /);

    commitIn(room, 'initial toy repo', { 'README.md': '# Toy repo\n' });
    const minute = runCli([], { cwd: room, env });
    assert.equal(minute.status, 0, minute.stderr || minute.stdout);
    assert.match(minute.stdout, /initial toy repo is already here/);
    assert.match(minute.stdout, /^next: atris do$/m);
    assert.doesNotMatch(minute.stdout, /waiting for your ok|waiting on you|write a feature map|atris task accept|Rebased Pack Co|CLI-193/);
  } finally {
    try { taskDb.close(); } catch { /* already closed */ }
    cleanupTempDir(parent);
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
    assert.equal(next[1], 'atris "what do you want here?"');
    assert.doesNotMatch(first.stdout, /atris init --minimal/);
    assert.equal(fs.existsSync(path.join(dir, 'atris')), false);

    const pasted = runCli(['what do you want here?'], { cwd: dir, env, timeout: 60000 });
    assert.equal(pasted.status, 0, pasted.stderr || pasted.stdout);
    assert.match(pasted.stdout, /hey keshav, launch-day is ready\./);
    assert.doesNotMatch(pasted.stdout, /I saved a first step|first useful step/i);
    assert.doesNotMatch(pasted.stdout, /launch-day is empty/);
    assert.doesNotMatch(pasted.stdout, /atris initialized|What do you want to build|minimal scaffold/i);
    const showNext = String(pasted.stdout).match(/^next: (.+)$/m);
    assert.ok(showNext, pasted.stdout);
    assert.equal(showNext[1], 'atris do');
    assert.doesNotMatch(pasted.stdout, /atris task (claim|show) /);
    const todo = fs.readFileSync(path.join(dir, 'atris', 'TODO.md'), 'utf8');
    assert.match(todo, /launch-day/);
    assert.doesNotMatch(todo, /[Ff]irst useful step|what do you want here/);
    assert.ok(fs.existsSync(path.join(dir, 'atris', 'MAP.md')));
    assert.ok(fs.existsSync(path.join(dir, '.atris', 'state', 'context_profile.json')));

    const showArgs = showNext[1].replace(/^atris\s+/, '').split(/\s+/);
    const shown = runCli(showArgs, { cwd: dir, env });
    assert.equal(shown.status, 0, shown.stderr || shown.stdout);
    assert.doesNotMatch(shown.stdout + shown.stderr, /No open tasks|id required|unknown/i);
    assert.doesNotMatch(shown.stdout, /PROMPT ONLY|Atris Do|executor\.md/);

    const afterTask = runCli(['task'], { cwd: dir, env });
    assert.equal(afterTask.status, 0, afterTask.stderr || afterTask.stdout);
    assert.doesNotMatch(afterTask.stdout, /No open tasks/);
    assert.match(afterTask.stdout, /^next: atris do$/m);
    assert.equal(nextLine(afterTask.stdout), showNext[1]);

    const after = runCli(['task', 'next'], { cwd: dir, env });
    assert.equal(after.status, 0, after.stderr || after.stdout);
    assert.doesNotMatch(after.stdout, /No open tasks/);
    assert.match(after.stdout, /^next: atris do$/m);
    const afterNext = String(after.stdout).match(/^next: (.+)$/m);
    const afterTaskNext = String(afterTask.stdout).match(/^next: (.+)$/m);
    assert.equal(afterNext && afterNext[1], afterTaskNext && afterTaskNext[1]);
    assert.equal(afterNext && afterNext[1], showNext[1]);
    assert.equal(firstTalkNext({
      starter: { display_id: 'LDY-1', title: 'launch-day', status: 'claimed' },
      person: 'keshav',
      folder: 'launch-day',
    }), 'atris do');
    assert.equal(renderFirstTalk({
      person: 'keshav',
      folder: 'launch-day',
      starter: { display_id: 'LDY-1', title: 'launch-day', status: 'claimed' },
    }), [
      'hey keshav, launch-day is ready.',
      '',
      'next: atris do',
    ].join('\n'));
  } finally {
    cleanupTempDir(parent);
  }
});
