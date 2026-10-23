// doAtris runs inside a temp folder and a temp HOME only, so these runs never
// touch the real ~/.atris, the real task database, or an engine. Every path
// tested here stays in prompt mode or stops before the first API call: an empty
// folder, the --json stuck reply, the prompt-only executor paste, and --execute
// with no live task to dispatch.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { doAtris } = require('../commands/workflow');

// Stands in for process.exit so the test can stop where the CLI would exit.
class ExitSignal extends Error {
  constructor(code) {
    super(`exit ${code}`);
    this.code = code;
  }
}

// Makes a temp HOME with a folder named launch-day inside it, and moves into
// that folder. The fixed folder name keeps the greeting text stable, and USER is
// pinned so the greeting does not depend on the machine's login name.
function sandbox(t, { withAtris = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-do-'));
  const folder = path.join(root, 'launch-day');
  fs.mkdirSync(folder);
  if (withAtris) {
    fs.mkdirSync(path.join(folder, 'atris'));
    fs.writeFileSync(path.join(folder, 'atris', 'TODO.md'), '# TODO\n');
  }

  const savedCwd = process.cwd();
  const savedHome = process.env.HOME;
  const savedUser = process.env.USER;
  const savedAtris = {};
  for (const name of Object.keys(process.env)) {
    if (name.startsWith('ATRIS_')) {
      savedAtris[name] = process.env[name];
      delete process.env[name];
    }
  }
  process.env.HOME = root;
  process.env.USER = 'tester';
  process.chdir(folder);

  t.after(() => {
    process.chdir(savedCwd);
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedUser === undefined) delete process.env.USER;
    else process.env.USER = savedUser;
    for (const name of Object.keys(process.env)) {
      if (name.startsWith('ATRIS_')) delete process.env[name];
    }
    Object.assign(process.env, savedAtris);
    fs.rmSync(root, { recursive: true, force: true });
  });

  return folder;
}

// Runs doAtris with the given CLI args and returns what it printed, the exit
// code if it called process.exit, and any error it threw.
async function runDo(args) {
  const savedArgv = process.argv;
  const savedExit = process.exit;
  const savedLog = console.log;
  const savedError = console.error;
  const stdout = [];
  const stderr = [];
  let exitCode = null;
  let thrown = null;

  process.argv = ['node', 'atris', 'do', ...args];
  console.log = (...parts) => stdout.push(parts.join(' '));
  console.error = (...parts) => stderr.push(parts.join(' '));
  process.exit = (code = 0) => {
    exitCode = code;
    throw new ExitSignal(code);
  };

  try {
    await doAtris();
  } catch (error) {
    if (!(error instanceof ExitSignal)) thrown = error;
  } finally {
    process.argv = savedArgv;
    process.exit = savedExit;
    console.log = savedLog;
    console.error = savedError;
  }

  return { stdout: stdout.join('\n'), stderr: stderr.join('\n'), exitCode, thrown };
}

test('doAtris in an empty folder says it is empty and writes nothing', async (t) => {
  const folder = sandbox(t);

  const run = await runDo([]);

  assert.equal(run.thrown, null);
  assert.equal(run.exitCode, null);
  assert.equal(run.stdout.trim(), 'hey tester, launch-day is empty.\n\nnext: atris "what do you want here?"');
  assert.deepStrictEqual(fs.readdirSync(folder), []);
});

test('doAtris --json on an empty folder prints the stuck reply and exits 2', async (t) => {
  sandbox(t);

  const run = await runDo(['--json']);

  assert.equal(run.exitCode, 2);
  assert.deepStrictEqual(JSON.parse(run.stdout), {
    schema: 'atris.one_lap.v1',
    ok: false,
    status: 'stuck',
    reason: 'launch-day is empty',
    next_action: 'atris "what do you want here?"',
  });
});

test('doAtris with atris/ and no live task stays in prompt mode', async (t) => {
  sandbox(t, { withAtris: true });

  const run = await runDo([]);

  assert.equal(run.thrown, null);
  assert.equal(run.stdout.trim(), 'hey tester, launch-day is set up.\n\nnext: atris "help me choose the first useful step for this project"');
  assert.equal(run.stdout.includes('ACTION TAKEN'), false);
  assert.equal(run.stdout.includes('AGENT MODE'), false);
});

test('doAtris --prompt prints the executor paste that reads atris/TODO.md', async (t) => {
  sandbox(t, { withAtris: true });

  const run = await runDo(['--prompt']);

  assert.equal(run.thrown, null);
  assert.ok(run.stdout.startsWith('PROMPT ONLY\n'));
  assert.ok(run.stdout.includes('You are the Executor.\n\nRead these files:\n- atris/TODO.md\n'));
  assert.ok(run.stdout.includes('Expected dispatch: {"taskId":null,"owner":null,"goalId":null,"missionId":null,"objective":null}.'));
  assert.equal(run.stdout.includes('AGENT MODE'), false);
});

test('doAtris --execute refuses to dispatch when there is no live task', async (t) => {
  sandbox(t, { withAtris: true });

  const run = await runDo(['--execute']);

  assert.ok(run.stdout.startsWith('ACTION TAKEN\n'));
  assert.equal(run.thrown && run.thrown.message, 'executor dispatch refused: missing task, owner, or mission in dispatch');
  assert.equal(run.stdout.includes('AGENT MODE'), false);
});
