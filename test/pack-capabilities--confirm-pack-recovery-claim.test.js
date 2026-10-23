const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  claimPackRecoveryParent,
  confirmPackRecoveryClaim,
} = require('../lib/pack-capabilities');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-recovery-claim-test-'));
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

test('confirmPackRecoveryClaim records the child receipt on a real claim', () => {
  const dir = makeTempDir();
  try {
    const parentReceipt = path.join(dir, 'parent.json');
    const childReceipt = path.join(dir, 'child.json');
    const claimPath = claimPackRecoveryParent(parentReceipt, 'run-parent-1');
    const before = readJson(claimPath);
    assert.strictEqual(before.childReceipt, null);

    confirmPackRecoveryClaim(claimPath, childReceipt);

    const after = readJson(claimPath);
    assert.strictEqual(after.childReceipt, path.resolve(childReceipt));
    // Only childReceipt changes. The rest of the claim is kept as written.
    assert.deepStrictEqual(
      { ...after, childReceipt: null },
      before,
    );
    assert.strictEqual(after.version, 1);
    assert.strictEqual(after.parentRunId, 'run-parent-1');
    assert.strictEqual(after.parentReceipt, path.resolve(parentReceipt));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('confirmPackRecoveryClaim resolves a relative child path and writes pretty JSON', () => {
  const dir = makeTempDir();
  try {
    const claimPath = path.join(dir, 'parent.claim.json');
    const claim = {
      version: 1,
      parentReceipt: path.join(dir, 'parent.json'),
      parentRunId: 'run-parent-2',
      claimedAt: '2026-01-01T00:00:00.000Z',
      childReceipt: null,
    };
    fs.writeFileSync(claimPath, JSON.stringify(claim));

    const relativeChild = path.join('receipts', 'child.json');
    confirmPackRecoveryClaim(claimPath, relativeChild);

    const text = fs.readFileSync(claimPath, 'utf8');
    assert.ok(text.endsWith('\n'), 'claim file should end with a newline');
    assert.strictEqual(text, `${JSON.stringify({ ...claim, childReceipt: path.resolve(relativeChild) }, null, 2)}\n`);

    // The call site in commands/pack.js confirms twice with the same child.
    // Confirming again must leave the same bytes behind.
    confirmPackRecoveryClaim(claimPath, relativeChild);
    assert.strictEqual(fs.readFileSync(claimPath, 'utf8'), text);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('confirmPackRecoveryClaim throws and creates nothing when the claim is missing or unreadable', () => {
  const dir = makeTempDir();
  try {
    const missingClaim = path.join(dir, 'never-claimed.claim.json');
    assert.throws(
      () => confirmPackRecoveryClaim(missingClaim, path.join(dir, 'child.json')),
      { code: 'ENOENT' },
    );
    assert.strictEqual(fs.existsSync(missingClaim), false, 'a missing claim must not be created');

    const brokenClaim = path.join(dir, 'broken.claim.json');
    fs.writeFileSync(brokenClaim, '{not json');
    assert.throws(
      () => confirmPackRecoveryClaim(brokenClaim, path.join(dir, 'child.json')),
      SyntaxError,
    );
    assert.strictEqual(fs.readFileSync(brokenClaim, 'utf8'), '{not json', 'a broken claim must be left untouched');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
