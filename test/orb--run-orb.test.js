'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runOrb } = require('../commands/orb');

function withIsolatedEnv(fn) {
  const origHome = process.env.HOME;
  const origCwd = process.cwd();
  const origEnv = { ...process.env };
  const tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atris-orb-test-')));
  process.env.HOME = tmpDir;

  for (const key of Object.keys(process.env)) {
    if (key.startsWith('ATRIS_')) {
      delete process.env[key];
    }
  }

  process.chdir(tmpDir);

  const logs = [];
  const errors = [];
  const origLog = console.log;
  const origError = console.error;
  console.log = (...args) => logs.push(args.join(' '));
  console.error = (...args) => errors.push(args.join(' '));

  return Promise.resolve()
    .then(() => fn({ tmpDir, logs, errors }))
    .finally(() => {
      console.log = origLog;
      console.error = origError;
      process.chdir(origCwd);
      process.env.HOME = origHome;
      for (const key of Object.keys(process.env)) {
        if (!Object.prototype.hasOwnProperty.call(origEnv, key)) {
          delete process.env[key];
        }
      }
      for (const [key, val] of Object.entries(origEnv)) {
        process.env[key] = val;
      }
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {}
    });
}

test('runOrb --json emits structured move suggestions from projection without engine spawn', async () => {
  await withIsolatedEnv(async ({ tmpDir, logs, errors }) => {
    const stateDir = path.join(tmpDir, '.atris', 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'atris.md'), '# atris\n');
    fs.writeFileSync(
      path.join(stateDir, 'tasks.projection.json'),
      JSON.stringify({
        schema: 'atris.task_projection.v1',
        tasks: [
          {
            display_id: 'CLI-100',
            title: 'Audit orb command flow',
            status: 'review',
          },
        ],
      })
    );

    const code = await runOrb(['--json']);
    assert.strictEqual(code, 0);
    assert.strictEqual(errors.length, 0);

    const parsed = JSON.parse(logs.join('\n'));
    assert.ok(Array.isArray(parsed.moves), 'output should contain moves array');
    assert.ok(parsed.moves.length > 0, 'moves array should not be empty');

    const firstMove = parsed.moves[0];
    assert.strictEqual(firstMove.n, 1);
    assert.strictEqual(firstMove.label, 'review: Audit orb command flow');
    assert.strictEqual(firstMove.command, 'atris orb --pick 1');
  });
});

test('runOrb --json on an empty workspace produces fallback moves and exits 0', async () => {
  await withIsolatedEnv(async ({ tmpDir, logs, errors }) => {
    fs.mkdirSync(path.join(tmpDir, '.atris'), { recursive: true });

    const code = await runOrb(['--json']);
    assert.strictEqual(code, 0);
    assert.strictEqual(errors.length, 0);

    const parsed = JSON.parse(logs.join('\n'));
    assert.ok(Array.isArray(parsed.moves));
    assert.ok(parsed.moves.length > 0);

    const labels = parsed.moves.map((m) => m.label);
    assert.ok(labels.includes("what's moving"));
  });
});

test('runOrb --help and -h print usage information and exit 0 without accessing disk', async () => {
  await withIsolatedEnv(async ({ logs, errors }) => {
    const codeHelp = await runOrb(['--help']);
    assert.strictEqual(codeHelp, 0);
    assert.strictEqual(errors.length, 0);
    assert.match(logs.join('\n'), /Usage: atris orb/);
  });

  await withIsolatedEnv(async ({ logs, errors }) => {
    const codeShort = await runOrb(['-h']);
    assert.strictEqual(codeShort, 0);
    assert.strictEqual(errors.length, 0);
    assert.match(logs.join('\n'), /Usage: atris orb/);
  });
});

test('runOrb rejects unknown flags, invalid engines, and bad scorecard days with exit code 2', async () => {
  await withIsolatedEnv(async ({ errors }) => {
    const code = await runOrb(['--invalid-flag']);
    assert.strictEqual(code, 2);
    assert.match(errors.join('\n'), /unknown orb option: --invalid-flag/);
  });

  await withIsolatedEnv(async ({ errors }) => {
    const code = await runOrb(['--engine', 'unsupported-engine']);
    assert.strictEqual(code, 2);
    assert.match(errors.join('\n'), /Unknown orb engine: unsupported-engine/);
  });

  await withIsolatedEnv(async ({ errors }) => {
    const code = await runOrb(['scorecard', '--days', 'invalid']);
    assert.strictEqual(code, 2);
    assert.match(errors.join('\n'), /orb scorecard: invalid --days value: invalid/);
  });
});
