const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { writeRuntimeReceipt } = require('../lib/runtime-bootstrap');

const FIXED_UPDATED_AT = '2026-01-15T09:30:00.000Z';

function makeWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-runtime-receipt-'));
}

function readReceiptFile(workspaceRoot) {
  return JSON.parse(fs.readFileSync(path.join(workspaceRoot, '.atris', 'state', 'runtime.json'), 'utf8'));
}

test('writeRuntimeReceipt writes runtime.json with defaults and returns the same receipt', () => {
  const root = makeWorkspace();
  try {
    const packageVersion = require('../package.json').version;
    const { filePath, receipt } = writeRuntimeReceipt(root, { updated_at: FIXED_UPDATED_AT });

    assert.strictEqual(filePath, path.join(root, '.atris', 'state', 'runtime.json'));
    assert.deepStrictEqual(receipt, {
      schema: 'atris.runtime.v1',
      scope: 'local',
      boundary: 'manual',
      atris_version: packageVersion,
      install_status: 'recorded',
      sync_status: 'recorded',
      updated_at: FIXED_UPDATED_AT,
    });

    const raw = fs.readFileSync(filePath, 'utf8');
    assert.strictEqual(raw, `${JSON.stringify(receipt, null, 2)}\n`);
    assert.deepStrictEqual(readReceiptFile(root), receipt);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('writeRuntimeReceipt keeps caller fields and passes extra fields through', () => {
  const root = makeWorkspace();
  try {
    const { receipt } = writeRuntimeReceipt(root, {
      scope: 'remote-business-computer',
      boundary: 'computer-wake',
      atris_version: '9.9.9',
      install_status: 'installed_latest',
      sync_status: 'synced',
      updated_at: FIXED_UPDATED_AT,
      business_slug: 'example-co',
      workspace_id: 'ws-1',
    });

    assert.strictEqual(receipt.scope, 'remote-business-computer');
    assert.strictEqual(receipt.boundary, 'computer-wake');
    assert.strictEqual(receipt.atris_version, '9.9.9');
    assert.strictEqual(receipt.install_status, 'installed_latest');
    assert.strictEqual(receipt.sync_status, 'synced');
    assert.strictEqual(receipt.business_slug, 'example-co');
    assert.strictEqual(receipt.workspace_id, 'ws-1');
    assert.deepStrictEqual(readReceiptFile(root), receipt);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('writeRuntimeReceipt creates a missing workspace root and stamps updated_at when none is given', () => {
  const base = makeWorkspace();
  const root = path.join(base, 'not', 'yet', 'there');
  try {
    const { filePath, receipt } = writeRuntimeReceipt(root);

    assert.strictEqual(fs.existsSync(filePath), true);
    assert.match(receipt.updated_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.deepStrictEqual(readReceiptFile(root), receipt);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('writeRuntimeReceipt replaces the previous receipt on a second call', () => {
  const root = makeWorkspace();
  try {
    writeRuntimeReceipt(root, { updated_at: FIXED_UPDATED_AT, install_status: 'failed' });
    const { receipt } = writeRuntimeReceipt(root, {
      updated_at: '2026-01-16T09:30:00.000Z',
      install_status: 'installed_latest',
    });

    const onDisk = readReceiptFile(root);
    assert.strictEqual(onDisk.install_status, 'installed_latest');
    assert.strictEqual(onDisk.updated_at, '2026-01-16T09:30:00.000Z');
    assert.deepStrictEqual(onDisk, receipt);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('writeRuntimeReceipt throws and writes nothing when .atris is a file, not a folder', () => {
  const root = makeWorkspace();
  try {
    fs.writeFileSync(path.join(root, '.atris'), 'not a folder', 'utf8');

    assert.throws(() => writeRuntimeReceipt(root, { updated_at: FIXED_UPDATED_AT }), /ENOTDIR|EEXIST/);
    assert.strictEqual(fs.readFileSync(path.join(root, '.atris'), 'utf8'), 'not a folder');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
