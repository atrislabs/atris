'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { proofCommand } = require('../commands/proof');

function withTempEnv(fn) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-proof-test-'));
  const originalHome = process.env.HOME;
  const originalCwd = process.cwd();
  const originalExitCode = process.exitCode;
  process.env.HOME = tempDir;
  try {
    process.chdir(tempDir);
    return fn(tempDir);
  } finally {
    process.chdir(originalCwd);
    process.env.HOME = originalHome;
    process.exitCode = originalExitCode;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function captureOutput(fn) {
  const originalLog = console.log;
  const originalError = console.error;
  const logs = [];
  const errors = [];
  console.log = (...args) => logs.push(args.join(' '));
  console.error = (...args) => errors.push(args.join(' '));
  try {
    fn();
    return { logs, errors };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

test('proofCommand displays usage for help and handles unknown subcommands', () => {
  withTempEnv(() => {
    const helpOut = captureOutput(() => {
      proofCommand('help');
    });
    assert.strictEqual(
      helpOut.logs.some((line) => line.includes('Usage: atris receipt [doctor|init <slug>|run --dry-run]')),
      true
    );

    const unknownOut = captureOutput(() => {
      proofCommand('unknown-action');
    });
    assert.strictEqual(
      unknownOut.errors.some((line) => line.includes('Unknown receipt command: unknown-action')),
      true
    );
    assert.strictEqual(process.exitCode, 1);
  });
});

test('proofCommand run prints verification commands and supports dry-run', () => {
  withTempEnv(() => {
    const standardOut = captureOutput(() => {
      proofCommand('run');
    });
    assert.strictEqual(
      standardOut.logs.some((line) => line.includes('1. atris computer proof')),
      true
    );
    assert.strictEqual(
      standardOut.logs.some((line) => line.includes('save the receipt under .atris/receipts/')),
      true
    );

    const dryOut = captureOutput(() => {
      proofCommand('run', '--dry-run');
    });
    assert.strictEqual(
      dryOut.logs.some((line) => line.includes('Dry run only; no receipts written.')),
      true
    );
  });
});

test('proofCommand doctor and init manage task template and receipts directory', () => {
  withTempEnv((tempDir) => {
    const docMissing = captureOutput(() => {
      proofCommand('doctor');
    });
    assert.strictEqual(
      docMissing.logs.some((line) => line.includes('business binding: missing')),
      true
    );

    const initFail = captureOutput(() => {
      proofCommand('init', 'smoke-check');
    });
    assert.strictEqual(
      initFail.errors.some((line) => line.includes('No business binding found')),
      true
    );
    assert.strictEqual(process.exitCode, 1);
    process.exitCode = 0;

    const atrisDir = path.join(tempDir, '.atris');
    fs.mkdirSync(atrisDir, { recursive: true });
    fs.writeFileSync(
      path.join(atrisDir, 'business.json'),
      JSON.stringify({
        business_id: 'biz-101',
        name: 'Testing Hub',
        slug: 'test-hub',
      }),
      'utf8'
    );

    const initSuccess = captureOutput(() => {
      proofCommand('init', 'Daily Flow');
    });
    assert.strictEqual(
      initSuccess.logs.some((line) => line.includes('Receipt task ready: daily-flow')),
      true
    );

    const taskFile = path.join(atrisDir, 'tasks', 'daily-flow.json');
    assert.strictEqual(fs.existsSync(taskFile), true);

    const taskData = JSON.parse(fs.readFileSync(taskFile, 'utf8'));
    assert.strictEqual(taskData.schema, 'atris.receipt_task.v1');
    assert.strictEqual(taskData.slug, 'daily-flow');
    assert.strictEqual(taskData.workspace.business_id, 'biz-101');
    assert.strictEqual(taskData.workspace.slug, 'test-hub');
    assert.deepStrictEqual(taskData.verify, [
      'atris computer proof',
      'atris experiments replay endstate',
    ]);

    const docReady = captureOutput(() => {
      proofCommand('doctor');
    });
    assert.strictEqual(
      docReady.logs.some((line) => line.includes('business binding: Testing Hub ready')),
      true
    );
    assert.strictEqual(
      docReady.logs.some((line) => line.includes('receipt folder: ready')),
      true
    );
  });
});
