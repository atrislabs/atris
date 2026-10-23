const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { reviewCommand } = require('../commands/review');

// review.js never reads HOME, but it searches process.cwd() and a few parents
// for the engine script, so every run happens inside a scratch workspace.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-review-command-'));
const realCwd = process.cwd();

const probe = spawnSync('python3', ['--version'], { encoding: 'utf8' });
const hasPython = probe.status === 0;

let workspaceCount = 0;

function makeWorkspace({ engine = null, services = null } = {}) {
  workspaceCount += 1;
  const root = path.join(sandbox, `ws-${workspaceCount}`);
  fs.mkdirSync(root, { recursive: true });
  if (engine !== null) fs.writeFileSync(path.join(root, 'review_engine.py'), engine);
  if (services !== null) {
    const dir = path.join(root, 'backend', 'services');
    fs.mkdirSync(dir, { recursive: true });
    for (const [name, body] of Object.entries(services)) {
      fs.writeFileSync(path.join(dir, name), body);
    }
  }
  return root;
}

class ExitSignal extends Error {
  constructor(code) {
    super(`process.exit(${code})`);
    this.code = code;
  }
}

// Runs the command inside `cwd` with console and process.exit captured.
async function run(cwd, args) {
  const logs = [];
  const errors = [];
  const original = {
    log: console.log,
    error: console.error,
    exit: process.exit,
  };
  let exitCode = null;
  console.log = (...parts) => { logs.push(parts.join(' ')); };
  console.error = (...parts) => { errors.push(parts.join(' ')); };
  process.exit = (code) => { throw new ExitSignal(code); };
  process.chdir(cwd);
  try {
    await reviewCommand(...args);
  } catch (err) {
    if (!(err instanceof ExitSignal)) throw err;
    exitCode = err.code;
  } finally {
    process.chdir(realCwd);
    console.log = original.log;
    console.error = original.error;
    process.exit = original.exit;
  }
  return { logs, errors, exitCode };
}

// Fake engine that records the arguments it was called with, then exits.
function argvRecorder(exitCode = 0) {
  return [
    'import json, os, sys',
    "with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'argv.json'), 'w') as f:",
    '    json.dump(sys.argv[1:], f)',
    `sys.exit(${exitCode})`,
    '',
  ].join('\n');
}

// Fake engine that answers per file name, like the real one answers per file.
const AUDIT_ENGINE = [
  'import json, os, sys',
  'args = sys.argv[1:]',
  "name = os.path.basename(args[args.index('--file') + 1])",
  'answers = {',
  "    'bad.py': {'quality_score': 3, 'findings': [",
  "        {'severity': 'high', 'rule': 'sql-injection'},",
  "        {'severity': 'medium', 'rule': 'weak-hash'},",
  "        {'severity': 'low', 'rule': 'naming'}]},",
  "    'meh.py': {'quality_score': 6, 'findings': [{'severity': 'medium', 'rule': 'bare-except'}]},",
  "    'clean.py': {'quality_score': 10, 'findings': [{'severity': 'low', 'rule': 'naming'}]},",
  '}',
  "if name == 'broken.py':",
  "    print('this is not json')",
  'else:',
  '    print(json.dumps(answers[name]))',
  '',
].join('\n');

const AUDIT_SERVICES = {
  'bad.py': '',
  'meh.py': '',
  'clean.py': '',
  'broken.py': '',
  'notes.txt': 'not a service',
};

test.after(() => {
  process.chdir(realCwd);
  fs.rmSync(sandbox, { recursive: true, force: true });
});

test('no arguments prints usage and does not need the engine installed', async () => {
  const root = makeWorkspace();
  const { logs, errors, exitCode } = await run(root, []);

  assert.strictEqual(exitCode, null);
  assert.deepStrictEqual(errors, []);
  assert.strictEqual(logs[0], 'Usage: atris code-review [file] [options]   (alias: atris cr)');
  assert.ok(logs.some((line) => line.includes('atris code-review --diff HEAD~1')));
  assert.ok(logs.some((line) => line.includes('atris code-review --all')));
  assert.ok(logs.some((line) => line.includes('atris code-review --json')));
  assert.ok(logs.includes('6 specialists: Security, Testing, Performance, Maintainability, Database, Async'));
  assert.ok(logs.some((line) => line.includes('distinct from `atris review`')));
});

test('--help and -h print exactly the same usage as no arguments', async () => {
  const root = makeWorkspace();
  const bare = await run(root, []);
  const long = await run(root, ['--help']);
  const short = await run(root, ['-h']);

  assert.ok(bare.logs.length > 5);
  assert.deepStrictEqual(long.logs, bare.logs);
  assert.deepStrictEqual(short.logs, bare.logs);
  assert.strictEqual(long.exitCode, null);
  assert.strictEqual(short.exitCode, null);
});

test('missing engine exits 2 with the install hint on stderr', async () => {
  const root = makeWorkspace();
  const { logs, errors, exitCode } = await run(root, ['app.py']);

  assert.strictEqual(exitCode, 2);
  assert.deepStrictEqual(logs, []);
  assert.deepStrictEqual(errors, ['not installed; atris skill install code-review']);
});

test('missing engine with --json prints a machine-readable error and exits 2', async () => {
  const root = makeWorkspace();
  const { logs, errors, exitCode } = await run(root, ['--json', 'app.py']);

  assert.strictEqual(exitCode, 2);
  assert.deepStrictEqual(errors, []);
  assert.strictEqual(logs.length, 1);
  const payload = JSON.parse(logs[0]);
  assert.strictEqual(payload.ok, false);
  assert.strictEqual(payload.error, 'not installed');
  assert.strictEqual(payload.expected, 'atris/business/claude-code-review/workspace/review_engine.py');
  assert.strictEqual(payload.install, 'atris skill install code-review');
  assert.deepStrictEqual(payload.specialists, [
    'Security', 'Testing', 'Performance', 'Maintainability', 'Database', 'Async',
  ]);
});

test('--all without backend/services reports the missing directory and exits 1', async () => {
  const root = makeWorkspace({ engine: argvRecorder() });
  const { logs, errors, exitCode } = await run(root, ['--all']);

  assert.strictEqual(exitCode, 1);
  assert.deepStrictEqual(logs, ['Auditing all Python services...\n']);
  assert.deepStrictEqual(errors, ['No backend/services/ directory found.']);
});

test('--all --json without backend/services stays quiet on the banner and returns an error object', async () => {
  const root = makeWorkspace({ engine: argvRecorder() });
  const { logs, errors, exitCode } = await run(root, ['--all', '--json']);

  assert.strictEqual(exitCode, 1);
  assert.deepStrictEqual(errors, []);
  assert.strictEqual(logs.length, 1);
  assert.deepStrictEqual(JSON.parse(logs[0]), {
    ok: false,
    error: 'No backend/services/ directory found.',
    expected: 'backend/services/',
  });
});

test('--all --json totals findings, ranks worst score first, and skips non-python files', { skip: !hasPython && 'python3 not available' }, async () => {
  const root = makeWorkspace({ engine: AUDIT_ENGINE, services: AUDIT_SERVICES });
  const { logs, errors, exitCode } = await run(root, ['--all', '--json']);

  assert.strictEqual(exitCode, null);
  assert.deepStrictEqual(errors, []);
  assert.strictEqual(logs.length, 1);
  assert.deepStrictEqual(JSON.parse(logs[0]), {
    ok: true,
    action: 'code_review_all',
    services: 4,
    clean: 1,
    with_findings: 2,
    total_findings: 3,
    issues: [
      { file: 'bad.py', score: 3, count: 2, top: 'sql-injection' },
      { file: 'meh.py', score: 6, count: 1, top: 'bare-except' },
    ],
  });
});

test('--all prints the audit table with one aligned row per service that has findings', { skip: !hasPython && 'python3 not available' }, async () => {
  const root = makeWorkspace({ engine: AUDIT_ENGINE, services: AUDIT_SERVICES });
  const { logs, errors, exitCode } = await run(root, ['--all']);

  assert.strictEqual(exitCode, null);
  assert.deepStrictEqual(errors, []);
  assert.strictEqual(logs[0], 'Auditing all Python services...\n');
  assert.strictEqual(logs[1], 'AUDIT: 4 services | 1 clean | 2 with findings\n');
  assert.strictEqual(logs[2], `${'Service'.padEnd(40)} ${'Score'.padStart(6)} ${'Findings'.padStart(8)}  Top Issue`);
  assert.strictEqual(logs[4], `${'bad.py'.padEnd(40)} ${'3/10'.padStart(6)} ${'2'.padStart(8)}  sql-injection`);
  assert.strictEqual(logs[5], `${'meh.py'.padEnd(40)} ${'6/10'.padStart(6)} ${'1'.padStart(8)}  bare-except`);
  assert.strictEqual(logs[6], '');
  assert.strictEqual(logs.length, 7);
});

test('a file argument is passed to the engine as --file and wins over --diff', { skip: !hasPython && 'python3 not available' }, async () => {
  const root = makeWorkspace({ engine: argvRecorder() });
  const { exitCode } = await run(root, ['app.py', '--diff', 'HEAD~1']);

  assert.strictEqual(exitCode, 0);
  const argv = JSON.parse(fs.readFileSync(path.join(root, 'argv.json'), 'utf8'));
  assert.deepStrictEqual(argv, ['--file', 'app.py']);
});

test('--diff takes its ref as a value, not as a file, and --json is forwarded', { skip: !hasPython && 'python3 not available' }, async () => {
  const root = makeWorkspace({ engine: argvRecorder() });
  const { exitCode } = await run(root, ['--diff', 'HEAD~1', '--json']);

  assert.strictEqual(exitCode, 0);
  const argv = JSON.parse(fs.readFileSync(path.join(root, 'argv.json'), 'utf8'));
  assert.deepStrictEqual(argv, ['--diff', 'HEAD~1', '--json']);
});

test('the engine exit status becomes the command exit status', { skip: !hasPython && 'python3 not available' }, async () => {
  const root = makeWorkspace({ engine: argvRecorder(3) });
  const { exitCode } = await run(root, ['app.py']);

  assert.strictEqual(exitCode, 3);
});
