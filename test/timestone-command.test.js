'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const {
  timestoneCommand,
  findEngine,
  latestScout,
  NO_ENGINE,
  DEFAULT_MODEL_CMD,
} = require('../commands/timestone');

const ATRIS = path.join(__dirname, '..', 'bin', 'atris.js');

// A fake backend: backend/scripts/timestone.py plus a venv/bin/python that records
// its argv and cwd as JSON and exits with $FAKE_EXIT.
function fakeEngine(root, { venv = true } = {}) {
  fs.mkdirSync(path.join(root, 'backend', 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(root, 'backend', 'scripts', 'timestone.py'), '# fake engine\n');
  if (venv) {
    fs.mkdirSync(path.join(root, 'venv', 'bin'), { recursive: true });
    const python = path.join(root, 'venv', 'bin', 'python');
    fs.writeFileSync(python, [
      `#!${process.execPath}`,
      "require('fs').writeFileSync(process.env.FAKE_ARGS_FILE, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }));",
      'process.exit(Number(process.env.FAKE_EXIT || 0));',
      '',
    ].join('\n'));
    fs.chmodSync(python, 0o755);
  }
  return root;
}

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-timestone-'));
  const home = path.join(dir, 'home');
  fs.mkdirSync(home);
  return { dir, home, argsFile: path.join(dir, 'args.json'), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function run(args, { env, home, cwd, hasClaude = false }) {
  const out = [];
  const errs = [];
  const code = timestoneCommand(args, {
    env, home, cwd: cwd || home, hasClaude, log: (line) => out.push(line), err: (line) => errs.push(line),
  });
  return { code, out, errs };
}

function recorded(argsFile) {
  return JSON.parse(fs.readFileSync(argsFile, 'utf8'));
}

test('arguments reach the engine as an argv array, untouched by any shell', (t) => {
  const box = sandbox();
  t.after(box.cleanup);
  const root = fakeEngine(path.join(box.dir, 'backend-repo'));
  const env = { PATH: process.env.PATH, ATRIS_BACKEND_DIR: root, FAKE_ARGS_FILE: box.argsFile };
  const tricky = 'Do we raise; $(touch pwned) `id` "quoted" & more?';

  const { code } = run(['run', '--question', tricky, '--option', 'a b', '--json'], { env, home: box.home });

  assert.strictEqual(code, 0);
  const seen = recorded(box.argsFile);
  assert.deepStrictEqual(seen.argv, [
    path.join(root, 'backend', 'scripts', 'timestone.py'),
    'run', '--question', tricky, '--option', 'a b', '--json',
  ]);
  assert.strictEqual(seen.cwd, fs.realpathSync(path.join(root, 'backend')));
  assert.ok(!fs.existsSync(path.join(root, 'backend', 'pwned')) && !fs.existsSync(path.join(box.home, 'pwned')));
});

test('scout and run get the default model command only when none is named and claude is here', (t) => {
  const box = sandbox();
  t.after(box.cleanup);
  const root = fakeEngine(path.join(box.dir, 'backend-repo'));
  const env = { PATH: process.env.PATH, ATRIS_BACKEND_DIR: root, FAKE_ARGS_FILE: box.argsFile };

  let result = run([], { env, home: box.home, hasClaude: true });
  assert.deepStrictEqual(recorded(box.argsFile).argv.slice(1), ['scout', '--model-cmd', DEFAULT_MODEL_CMD]);
  assert.strictEqual(result.out[result.out.length - 1], `Model: ${DEFAULT_MODEL_CMD}, the default when you name none.`);

  result = run(['scout', '--model-cmd', 'claude -p'], { env, home: box.home, hasClaude: true });
  assert.deepStrictEqual(recorded(box.argsFile).argv.slice(1), ['scout', '--model-cmd', 'claude -p']);
  assert.strictEqual(result.out[result.out.length - 1], 'Model: claude -p, as you asked.');

  result = run(['scout', '--json'], { env, home: box.home, hasClaude: true });
  assert.deepStrictEqual(result.out, [], 'with --json stdout stays clean JSON');
  assert.strictEqual(result.errs[result.errs.length - 1], `Model: ${DEFAULT_MODEL_CMD}, the default when you name none.`);

  result = run(['scout'], { env, home: box.home, hasClaude: false });
  assert.deepStrictEqual(recorded(box.argsFile).argv.slice(1), ['scout']);
  assert.match(result.out[result.out.length - 1], /claude is not installed here/);

  result = run(['list', '--json'], { env, home: box.home, hasClaude: true });
  assert.deepStrictEqual(recorded(box.argsFile).argv.slice(1), ['list', '--json'], 'no model for verbs that call none');
  assert.deepStrictEqual(result.errs, []);
});

test('the engine is found in order: ATRIS_BACKEND_DIR, this repo, then ~/arena/atrisos-backend', (t) => {
  const box = sandbox();
  t.after(box.cleanup);
  const pinned = fakeEngine(path.join(box.dir, 'pinned'));
  const here = fakeEngine(path.join(box.dir, 'here'));
  const mainCopy = fakeEngine(path.join(box.home, 'arena', 'atrisos-backend'));
  const inside = path.join(here, 'backend', 'services');
  fs.mkdirSync(inside, { recursive: true });

  assert.strictEqual(findEngine({ env: { ATRIS_BACKEND_DIR: pinned }, cwd: inside, home: box.home }).root, pinned);
  assert.strictEqual(findEngine({ env: {}, cwd: inside, home: box.home }).root, here);
  assert.strictEqual(findEngine({ env: {}, cwd: box.dir, home: box.home }).root, mainCopy);

  // A work copy has no venv, so it runs its own engine with the main copy's Python.
  const workCopy = fakeEngine(path.join(box.dir, 'work-copy'), { venv: false });
  const found = findEngine({ env: {}, cwd: workCopy, home: box.home });
  assert.strictEqual(found.root, workCopy);
  assert.strictEqual(found.python, path.join(mainCopy, 'venv', 'bin', 'python'));

  const wrong = findEngine({ env: { ATRIS_BACKEND_DIR: path.join(box.dir, 'nothing') }, cwd: inside, home: box.home });
  assert.match(wrong.error, /ATRIS_BACKEND_DIR is .*nothing, and there is no Timestone engine there\./);
});

test('with no engine it says so in one plain sentence and exits 1', (t) => {
  const box = sandbox();
  t.after(box.cleanup);
  const env = { PATH: process.env.PATH };

  let result = run(['scout'], { env, home: box.home, cwd: box.dir });
  assert.strictEqual(result.code, 1);
  assert.deepStrictEqual(result.errs, [NO_ENGINE]);
  assert.strictEqual(NO_ENGINE, 'Timestone runs on a computer that has the Atris backend, and the hosted version is not switched on yet.');

  result = run(['list', '--json'], { env, home: box.home, cwd: box.dir });
  assert.strictEqual(result.code, 1);
  assert.deepStrictEqual(result.out.map((line) => JSON.parse(line)), [{ ok: false, error: NO_ENGINE }]);

  // A backend from before Timestone gets told to update, not that there is no backend.
  fs.mkdirSync(path.join(box.home, 'arena', 'atrisos-backend', 'backend'), { recursive: true });
  result = run(['list'], { env, home: box.home, cwd: box.dir });
  assert.strictEqual(result.code, 1);
  assert.match(result.errs[0], /^The Atris backend at .*atrisos-backend is older than Timestone; update it/);
});

test('run <n> runs number n from the latest scout', (t) => {
  const box = sandbox();
  t.after(box.cleanup);
  const root = fakeEngine(path.join(box.dir, 'backend-repo'));
  const tsHome = path.join(box.dir, 'ts');
  const env = { PATH: process.env.PATH, ATRIS_BACKEND_DIR: root, FAKE_ARGS_FILE: box.argsFile, TIMESTONE_HOME: tsHome };

  let result = run(['run', '2'], { env, home: box.home });
  assert.strictEqual(result.code, 1);
  assert.match(result.errs[0], /There is no scout yet/);
  assert.ok(!fs.existsSync(box.argsFile), 'nothing runs without a scout');

  fs.mkdirSync(path.join(tsHome, 'scouts'), { recursive: true });
  for (const name of ['sc-20261125-071828-8efebc.json', 'sc-20261125-080708-754b88.json', 'sc-20261124-235959-aaaaaa.json', 'notes.txt']) {
    fs.writeFileSync(path.join(tsHome, 'scouts', name), '{}');
  }
  assert.strictEqual(latestScout({ env, home: box.home }), 'sc-20261125-080708-754b88');

  result = run(['run', '2', '--panel', 'skeptic,buyer'], { env, home: box.home });
  assert.strictEqual(result.code, 0);
  assert.deepStrictEqual(recorded(box.argsFile).argv.slice(1),
    ['run', '--from-scout', 'sc-20261125-080708-754b88', '2', '--panel', 'skeptic,buyer']);

  run(['run', '--from-scout', 'sc-20261125-071828-8efebc', '4'], { env, home: box.home });
  assert.deepStrictEqual(recorded(box.argsFile).argv.slice(1), ['run', '--from-scout', 'sc-20261125-071828-8efebc', '4']);
});

test('the engine exit code comes back through atris timestone', (t) => {
  const box = sandbox();
  t.after(box.cleanup);
  const root = fakeEngine(path.join(box.dir, 'backend-repo'));
  for (const exit of [0, 2, 7]) {
    const env = { PATH: process.env.PATH, ATRIS_BACKEND_DIR: root, FAKE_ARGS_FILE: box.argsFile, FAKE_EXIT: String(exit) };
    assert.strictEqual(run(['show', 'ts-1'], { env, home: box.home }).code, exit);
  }
  // And through the real entry point.
  const child = spawnSync(process.execPath, [ATRIS, 'timestone', 'choose', 'ts-1', 'P2', '--by', 'keshav', '--as', 'campaign'], {
    cwd: box.dir,
    env: { ...process.env, HOME: box.home, ATRIS_BACKEND_DIR: root, FAKE_ARGS_FILE: box.argsFile, FAKE_EXIT: '3' },
    encoding: 'utf8',
    timeout: 30000,
  });
  assert.strictEqual(child.status, 3, child.stderr);
  assert.deepStrictEqual(recorded(box.argsFile).argv.slice(1), ['choose', 'ts-1', 'P2', '--by', 'keshav', '--as', 'campaign']);
});

test('atris timestone --help prints the verbs in plain words', () => {
  const out = [];
  assert.strictEqual(timestoneCommand(['--help'], { log: (line) => out.push(line) }), 0);
  const text = out.join('\n');
  for (const verb of ['scout', 'run <n>', 'show', 'list', 'choose', '--as mission|campaign', 'result', 'outcome']) {
    assert.ok(text.includes(verb), verb);
  }
  assert.ok(!/\bAI\b|agent|automate/i.test(text));
});
