'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-atris-'));
process.env.HOME = home;
for (const key of Object.keys(process.env)) {
  if (key.startsWith('ATRIS_')) delete process.env[key];
}

const { cloudAtris } = require('../commands/cloud');

const HELP = [
  'Usage: atris cloud clean [business] [--dry-run] [--yes] [--delete-all]',
  '',
  'List or delete cloud files that are not present locally.',
  '',
  '  --dry-run     Preview which cloud files would be deleted',
  '  --yes         Delete the listed cloud files',
  '  --delete-all  Confirm a mass delete (required with --yes for large cleanups)',
  '',
].join('\n') + '\n';

const NO_BUSINESS = '\n✗ Error: No business workspace found. Run inside a business workspace or pass a business slug.\n';

let chain = Promise.resolve();
function exclusive(fn) {
  const run = chain.then(fn, fn);
  chain = run.then(() => {}, () => {});
  return run;
}

function captureWrite(chunks) {
  return (chunk, encoding, cb) => {
    const text = Buffer.isBuffer(chunk)
      ? chunk.toString(typeof encoding === 'string' ? encoding : 'utf8')
      : String(chunk);
    chunks.push(text);
    if (typeof encoding === 'function') encoding();
    else if (typeof cb === 'function') cb();
    return true;
  };
}

// process.exit must record the code and return. Throwing would be caught by
// cloudAtris and reported as a failure even when the command succeeded.
function runCloudAtris(argv, cwd) {
  return exclusive(async () => {
    const prevArgv = process.argv;
    const prevExit = process.exit;
    const prevCwd = process.cwd();
    const prevStdout = process.stdout.write;
    const prevStderr = process.stderr.write;
    const stdout = [];
    const stderr = [];
    let exitCode = null;
    let resolveExit;
    const exited = new Promise((resolve) => {
      resolveExit = resolve;
    });
    process.argv = argv;
    process.stdout.write = captureWrite(stdout);
    process.stderr.write = captureWrite(stderr);
    process.exit = (code) => {
      exitCode = code === undefined ? 0 : code;
      resolveExit();
    };
    process.chdir(cwd);
    try {
      cloudAtris();
      await exited;
    } finally {
      process.stdout.write = prevStdout;
      process.stderr.write = prevStderr;
      process.exit = prevExit;
      process.argv = prevArgv;
      try { process.chdir(prevCwd); } catch { /* the previous directory is gone */ }
    }
    return {
      exitCode,
      stdout: stdout.join(''),
      stderr: stderr.join(''),
    };
  });
}

function makeDir(name) {
  return fs.mkdtempSync(path.join(home, name));
}

test('cloud --help prints the clean usage and exits cleanly', async () => {
  const dir = makeDir('help-');
  fs.mkdirSync(path.join(dir, '.atris'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.atris', 'business.json'),
    JSON.stringify({ slug: 'example-co', name: 'Example Co' })
  );

  const result = await runCloudAtris(['node', 'atris', 'cloud', '--help'], dir);

  assert.strictEqual(result.exitCode, 0);
  assert.strictEqual(result.stdout, HELP);
  assert.strictEqual(result.stderr, '');
});

test('help flags win over clean, even with a broken business file', async () => {
  const dir = makeDir('edge-');
  fs.mkdirSync(path.join(dir, '.atris'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.atris', 'business.json'), '{');

  const argvs = [
    ['node', 'atris', 'cloud', '-h'],
    ['node', 'atris', 'cloud', 'help'],
    ['node', 'atris', 'cloud', 'clean', '--help'],
    ['node', 'atris', 'cloud', 'clean', 'example-co', '--yes', '--help'],
  ];
  for (const argv of argvs) {
    const result = await runCloudAtris(argv, dir);
    const label = JSON.stringify(argv);
    assert.strictEqual(result.exitCode, 0, label);
    assert.strictEqual(result.stdout, HELP, label);
    assert.strictEqual(result.stderr, '', label);
  }
});

test('an unknown command and a folder with no business both fail before any cleanup', async () => {
  const unknownDir = makeDir('unknown-');
  const unknown = await runCloudAtris(['node', 'atris', 'cloud', 'nope'], unknownDir);
  assert.strictEqual(unknown.exitCode, 1);
  assert.strictEqual(unknown.stdout, '');
  assert.strictEqual(
    unknown.stderr,
    '\n✗ Error: Unknown cloud subcommand: nope. Try: atris cloud clean --help\n'
  );

  const cases = [];

  const missing = makeDir('missing-');
  cases.push(['node', 'atris', 'cloud', missing]);
  cases.push(['node', 'atris', 'cloud', 'clean', '--dry-run', missing]);

  const emptyFile = makeDir('empty-file-');
  fs.mkdirSync(path.join(emptyFile, '.atris'), { recursive: true });
  fs.writeFileSync(path.join(emptyFile, '.atris', 'business.json'), '{}\n');
  cases.push(['node', 'atris', 'cloud', 'clean', emptyFile]);

  const broken = makeDir('broken-');
  fs.mkdirSync(path.join(broken, '.atris'), { recursive: true });
  fs.writeFileSync(path.join(broken, '.atris', 'business.json'), '{');
  cases.push(['node', 'atris', 'cloud', '', '--dry-run', broken]);

  for (const [node, script, command, ...rest] of cases) {
    const cwd = rest.pop();
    const result = await runCloudAtris([node, script, command, ...rest], cwd);
    const label = JSON.stringify([node, script, command, ...rest]);
    assert.strictEqual(result.exitCode, 1, label);
    assert.strictEqual(result.stdout, '', label);
    assert.strictEqual(result.stderr, NO_BUSINESS, label);
  }
});
