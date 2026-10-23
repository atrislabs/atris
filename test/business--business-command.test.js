'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { businessCommand } = require('../commands/business');

function setupTestEnv(t) {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-biz-cmd-test-'));
  const origEnv = { ...process.env };
  const origLog = console.log;
  const origError = console.error;
  const origExitCode = process.exitCode;
  const origCwd = process.cwd();

  // Clear any ATRIS_* env vars to ensure a clean environment
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('ATRIS_')) {
      delete process.env[key];
    }
  }

  process.env.HOME = tmpHome;

  const logs = [];
  const errors = [];

  console.log = (...args) => {
    logs.push(args.map(String).join(' '));
  };
  console.error = (...args) => {
    errors.push(args.map(String).join(' '));
  };

  t.after(() => {
    console.log = origLog;
    console.error = origError;
    process.exitCode = origExitCode;
    process.chdir(origCwd);

    for (const key of Object.keys(process.env)) {
      if (!(key in origEnv)) {
        delete process.env[key];
      }
    }
    for (const [key, val] of Object.entries(origEnv)) {
      process.env[key] = val;
    }

    try {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    } catch (_) {}
  });

  return { tmpHome, logs, errors };
}

test('businessCommand("list") prints registered businesses from config', async (t) => {
  const { tmpHome, logs } = setupTestEnv(t);

  const dotAtris = path.join(tmpHome, '.atris');
  fs.mkdirSync(dotAtris, { recursive: true });
  fs.writeFileSync(
    path.join(dotAtris, 'businesses.json'),
    JSON.stringify({
      'widget-co': {
        business_id: 'biz_001',
        name: 'Widget Co',
        slug: 'widget-co',
        added_at: '2026-01-15T00:00:00.000Z',
      },
    }, null, 2),
    'utf8',
  );

  await businessCommand('list');

  const output = logs.join('\n');
  assert.ok(output.includes('Connected businesses:'));
  assert.ok(output.includes('Widget Co (widget-co)'));
  assert.ok(output.includes('ID: biz_001'));
  assert.ok(output.includes('Added: 2026-01-15T00:00:00.000Z'));
});

test('businessCommand("list") prints message when no businesses are connected', async (t) => {
  const { logs } = setupTestEnv(t);

  await businessCommand('list');

  const output = logs.join('\n');
  assert.ok(output.includes('No businesses connected'));
  assert.ok(output.includes('atris business add <slug>'));
});

test('businessCommand() without arguments prints usage help', async (t) => {
  const { logs } = setupTestEnv(t);

  await businessCommand();

  const output = logs.join('\n');
  assert.ok(output.includes('Usage: atris business <command> [args]'));
  assert.ok(output.includes('quickstart'));
  assert.ok(output.includes('init <name>'));
  assert.ok(output.includes('list'));
});

test('businessCommand("--help") prints usage help', async (t) => {
  const { logs } = setupTestEnv(t);

  await businessCommand('--help');

  const output = logs.join('\n');
  assert.ok(output.includes('Usage: atris business <command> [args]'));
  assert.ok(output.includes('quickstart'));
});

test('businessCommand with unknown subcommand sets process.exitCode and logs error', async (t) => {
  const { errors } = setupTestEnv(t);

  await businessCommand('nonexistent-subcommand');

  assert.strictEqual(process.exitCode, 1);
  const errOutput = errors.join('\n');
  assert.ok(errOutput.includes('Unknown subcommand: nonexistent-subcommand'));
});

test('businessCommand("simulate", ..., "--dry-run") outputs simulation preview without side effects', async (t) => {
  const { logs } = setupTestEnv(t);

  await businessCommand('simulate', 'Solar Bakery', '--dry-run');

  const output = logs.join('\n');
  assert.ok(output.includes('dry run: no cloud calls made and no files written.'));
  assert.ok(output.includes('Solar Bakery (solar-bakery)'));
  assert.ok(output.includes('maker (Product and design)'));
});
