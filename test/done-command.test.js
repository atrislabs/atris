const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { explainResult } = require('../lib/autoland');
const { classifyVerifier } = require('../lib/verifier-quality');
const {
  buildFirstMinute,
  isWhatsNextLine,
  listBuiltSince,
  mainBuiltFile,
  pickNext,
  spokenBuiltList,
} = require('../lib/first-minute');
const { openCommand, resultSentence, verifierFor } = require('../commands/done');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');
const WANT = 'a landing page for my dog walking business';

function makeRoom() {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-done-'));
  const home = path.join(parent, 'home');
  const dir = path.join(parent, 'happy-trails');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(dir, { recursive: true });
  const env = {
    HOME: home,
    USER: 'keshav',
    ATRIS_TASKS_DB: path.join(home, 'tasks.db'),
    // The human path: no agent proof-only mode inherited from the host shell.
    ATRIS_AGENT_PROOF_ONLY: '0',
  };
  return { parent, home, dir, env };
}

function runCli(args, { cwd, env, timeout = 60000 } = {}) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: 'utf8',
    timeout,
    env: { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1', ATRIS_NO_INTERACTIVE: '1', ...env },
  });
  if (result.error) throw result.error;
  return result;
}

function nextLine(stdout) {
  const match = String(stdout || '').match(/^next: (.+)$/m);
  return match ? match[1] : '';
}

function taskRows(room) {
  const listed = runCli(['task', 'list', '--json'], { cwd: room.dir, env: room.env });
  assert.equal(listed.status, 0, listed.stderr || listed.stdout);
  return JSON.parse(listed.stdout).tasks;
}

function starterOf(room) {
  return taskRows(room).find((task) => task.title === WANT);
}

function buildPage(dir) {
  fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'dist', 'index.html'), [
    '<!doctype html>',
    '<html><head><title>Happy Trails</title></head>',
    '<body><h1>Happy Trails</h1>',
    '<form action="/book"><input name="email"><button>Book a walk</button></form>',
    '</body></html>',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(dir, 'README.md'), '# happy trails\n');
}

function startTalk(room) {
  const talk = runCli([WANT], { cwd: room.dir, env: room.env });
  assert.equal(talk.status, 0, talk.stderr || talk.stdout);
  assert.match(talk.stdout, /is started\. nothing is built yet\./);
  return talk;
}

test('done with nothing new says so, names the builder, and changes nothing', () => {
  const room = makeRoom();
  try {
    startTalk(room);
    const done = runCli(['done'], { cwd: room.dir, env: room.env });
    assert.equal(done.status, 0, done.stderr || done.stdout);
    assert.match(done.stdout, new RegExp(`^nothing new here since you started ${WANT}\\.$`, 'm'));
    assert.equal(nextLine(done.stdout), `claude "${WANT}"`);
    assert.equal(starterOf(room).status, 'claimed');
    assert.equal(fs.existsSync(path.join(room.dir, 'atris', 'runs')), false);

    const json = runCli(['done', '--json'], { cwd: room.dir, env: room.env });
    assert.equal(json.status, 0, json.stderr || json.stdout);
    const payload = JSON.parse(json.stdout);
    assert.equal(payload.status, 'nothing_new');
    assert.deepEqual(payload.built, []);
  } finally {
    fs.rmSync(room.parent, { recursive: true, force: true });
  }
});

test('done lands a non-git folder end to end through ready and accept', () => {
  const room = makeRoom();
  try {
    startTalk(room);
    buildPage(room.dir);

    // Bare atris and atris do both name the new work and point at done.
    for (const args of [[], ['do']]) {
      const look = runCli(args, { cwd: room.dir, env: room.env });
      assert.equal(look.status, 0, look.stderr || look.stdout);
      assert.match(look.stdout, new RegExp(`^hey keshav, ${WANT} has new work: dist/index\\.html, README\\.md\\.$`, 'm'));
      assert.equal(nextLine(look.stdout), 'atris done');
      assert.doesNotMatch(look.stdout, /task ready|git diff --check/);
    }

    const done = runCli(['done'], { cwd: room.dir, env: room.env });
    assert.equal(done.status, 0, done.stderr || done.stdout);
    const lines = done.stdout.split('\n');
    assert.ok(lines.includes(`  ${WANT}`), done.stdout);
    assert.ok(lines.includes('  built     dist/index.html, README.md'), done.stdout);
    assert.ok(lines.includes('  checked   dist/index.html has the form, passed'), done.stdout);
    const signed = lines.find((line) => line.startsWith('  signed    '));
    assert.match(signed, /^ {2}signed {4}atris\/runs\/\S+\.json$/);
    assert.equal(nextLine(done.stdout), openCommand('dist/index.html'));
    assert.ok(lines.filter(Boolean).length <= 7, done.stdout);
    assert.doesNotMatch(done.stdout, /[A-Z]{2,4}-\d+/, 'no task ids on the human lines');

    const starter = starterOf(room);
    assert.equal(starter.status, 'done');
    const receipt = JSON.parse(fs.readFileSync(path.join(room.dir, signed.replace(/^ {2}signed {4}/, '')), 'utf8'));
    assert.equal(receipt.result.passed, true);
    assert.match(receipt.command, /^grep -qi '<form' 'dist\/index\.html'$/);
    assert.equal(receipt.accepted.self_accepted, true);
    assert.equal(receipt.accepted.via, 'atris done');

    // The check is real: it fails once the built page is gone.
    fs.rmSync(path.join(room.dir, 'dist'), { recursive: true, force: true });
    const gone = spawnSync('bash', ['-c', receipt.command], { cwd: room.dir });
    assert.notEqual(gone.status, 0);
  } finally {
    fs.rmSync(room.parent, { recursive: true, force: true });
  }
});

test('after done, bare atris does not push the person onto the init seed task', () => {
  const room = makeRoom();
  try {
    startTalk(room);
    buildPage(room.dir);
    const done = runCli(['done'], { cwd: room.dir, env: room.env });
    assert.equal(done.status, 0, done.stderr || done.stdout);

    for (const args of [[], ['do'], ['done']]) {
      const home = runCli(args, { cwd: room.dir, env: room.env });
      assert.equal(home.status, 0, home.stderr || home.stdout);
      assert.match(home.stdout, new RegExp(`you already shipped ${WANT}\\.`));
      assert.equal(nextLine(home.stdout), 'atris "what\'s next?"');
      assert.doesNotMatch(home.stdout, /Generate MAP|map\.md|task claim/i);
    }

    // The seed still exists for agents; it is only off the human screen.
    const seed = taskRows(room).find((task) => /Generate MAP\.md/.test(task.title));
    assert.equal(seed && seed.status, 'open');

    const ask = runCli(['what\'s next?'], { cwd: room.dir, env: room.env });
    assert.equal(ask.status, 0, ask.stderr || ask.stdout);
    assert.match(ask.stdout, /is shipped\. say the next thing you want here/);
    assert.equal(taskRows(room).length, 2, 'asking what is next mints nothing');

    const want = runCli(['add a pricing section'], { cwd: room.dir, env: room.env });
    assert.equal(want.status, 0, want.stderr || want.stdout);
    assert.match(want.stdout, /add a pricing section is started\. nothing is built yet\./);
    const second = taskRows(room).find((task) => task.title === 'add a pricing section');
    assert.equal(second && second.status, 'claimed');
  } finally {
    fs.rmSync(room.parent, { recursive: true, force: true });
  }
});

test('claimed starter with no new files: next is the builder when one is known', () => {
  const room = makeRoom();
  const saved = { db: process.env.ATRIS_TASKS_DB, home: process.env.HOME };
  try {
    startTalk(room);
    process.env.ATRIS_TASKS_DB = room.env.ATRIS_TASKS_DB;
    process.env.HOME = room.home;
    const withCodex = buildFirstMinute({ root: room.dir, person: 'keshav', builder: 'codex' });
    assert.equal(withCodex.nextCommand, `codex "${WANT}"`);
    assert.match(withCodex.text, /is already yours\./);
    const none = buildFirstMinute({ root: room.dir, person: 'keshav', builder: null });
    assert.equal(none.nextCommand, 'npm install -g @anthropic-ai/claude-code');

    buildPage(room.dir);
    const built = buildFirstMinute({ root: room.dir, person: 'keshav', builder: 'codex' });
    assert.equal(built.nextCommand, 'atris done');
    assert.equal(built.text.split('\n')[0], `hey keshav, ${WANT} has new work: dist/index.html, README.md.`);
  } finally {
    if (saved.db == null) delete process.env.ATRIS_TASKS_DB; else process.env.ATRIS_TASKS_DB = saved.db;
    if (saved.home == null) delete process.env.HOME; else process.env.HOME = saved.home;
    fs.rmSync(room.parent, { recursive: true, force: true });
  }
});

test('pickNext skips the open init seed only in a room a person started by talking', () => {
  const seed = { id: 's', title: 'Generate MAP.md, scan codebase', status: 'open', metadata: { source: 'init_seed' }, display_id: 'X-1' };
  const starter = { id: 'h', title: WANT, status: 'done', tag: 'onboarding', metadata: { source: 'context_gatherer' } };
  assert.equal(pickNext({ tasks: [seed, starter], person: 'keshav' }).task, undefined);
  assert.equal(pickNext({ tasks: [seed], person: 'keshav' }).task, seed);
});

test('built-file helpers ignore atris state and dotfiles and lead with the page', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-done-files-'));
  try {
    const since = Date.now() - 1000;
    for (const rel of ['atris/TODO.md', '.atris/state/x.json', '.env', 'node_modules/a/index.js', 'README.md', 'dist/index.html', 'happy-trails.zip']) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), 'x');
    }
    const built = listBuiltSince(dir, since);
    assert.deepEqual(built, ['dist/index.html', 'happy-trails.zip', 'README.md']);
    assert.equal(mainBuiltFile(built), 'dist/index.html');
    assert.equal(spokenBuiltList(built), 'dist/index.html, happy-trails.zip, README.md');
    assert.equal(spokenBuiltList([...built, 'a.css']), 'dist/index.html, happy-trails.zip, README.md and 1 more');
    assert.deepEqual(listBuiltSince(dir, Date.now() + 60000), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('done composes a result and a check the existing gates accept', () => {
  for (const title of [WANT, 'fix src/app.js so login works', 'ship CLI-12 now', 'a site. with two sentences!']) {
    const sentence = resultSentence({ title });
    assert.equal(explainResult(sentence, { allowCommandMention: true }).ok, true, sentence);
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-done-verify-'));
  try {
    fs.writeFileSync(path.join(dir, 'notes.md'), '# Walks\nweekday mornings\n');
    const check = verifierFor(dir, ['notes.md']);
    assert.equal(check.command, "grep -qF 'Walks' 'notes.md'");
    assert.equal(classifyVerifier(check.command).ok, true);
    assert.equal(spawnSync('bash', ['-c', check.command], { cwd: dir }).status, 0);
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-done-empty-'));
    assert.notEqual(spawnSync('bash', ['-c', check.command], { cwd: empty }).status, 0);
    fs.rmSync(empty, { recursive: true, force: true });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(isWhatsNextLine('what\'s next?'), true);
  assert.equal(isWhatsNextLine('atris "what is next"'), true);
  assert.equal(isWhatsNextLine('add a pricing section'), false);
});
