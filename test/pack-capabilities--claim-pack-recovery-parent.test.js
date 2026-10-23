const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-claim-recovery-'));
const savedEnv = {};
for (const key of Object.keys(process.env)) {
  if (key.startsWith('ATRIS_')) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
}
savedEnv.HOME = process.env.HOME;
process.env.HOME = tmpRoot;

const { claimPackRecoveryParent } = require('../lib/pack-capabilities');

let caseCount = 0;
function freshDir() {
  caseCount += 1;
  const dir = path.join(tmpRoot, `case-${caseCount}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeReceipt(dir, name) {
  const receiptPath = path.join(dir, name);
  fs.writeFileSync(receiptPath, '{}\n');
  return receiptPath;
}

after(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test('creates a claim file beside the parent receipt with the expected fields', () => {
  const dir = freshDir();
  const receiptPath = writeReceipt(dir, 'run-abc.json');

  const claimPath = claimPackRecoveryParent(receiptPath, 'run-abc');

  assert.strictEqual(claimPath, path.join(dir, 'run-abc.claim.json'));
  assert.ok(fs.existsSync(claimPath));

  const claim = JSON.parse(fs.readFileSync(claimPath, 'utf8'));
  assert.deepStrictEqual(
    Object.keys(claim).sort(),
    ['childReceipt', 'claimedAt', 'parentReceipt', 'parentRunId', 'version'],
  );
  assert.strictEqual(claim.version, 1);
  assert.strictEqual(claim.parentReceipt, path.resolve(receiptPath));
  assert.strictEqual(claim.parentRunId, 'run-abc');
  assert.strictEqual(claim.childReceipt, null);
  assert.match(claim.claimedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.ok(fs.readFileSync(claimPath, 'utf8').endsWith('}\n'));
});

test('leaves the parent receipt untouched', () => {
  const dir = freshDir();
  const receiptPath = writeReceipt(dir, 'parent.json');
  fs.writeFileSync(receiptPath, '{"status":"session-ended"}\n');

  claimPackRecoveryParent(receiptPath, 'parent');

  assert.strictEqual(fs.readFileSync(receiptPath, 'utf8'), '{"status":"session-ended"}\n');
  assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['parent.claim.json', 'parent.json']);
});

test('claim file is private to the owner', { skip: process.platform === 'win32' }, () => {
  const dir = freshDir();
  const claimPath = claimPackRecoveryParent(writeReceipt(dir, 'private.json'), 'private');

  assert.strictEqual(fs.statSync(claimPath).mode & 0o077, 0);
});

test('a second claim on the same receipt is refused and keeps the first claim', () => {
  const dir = freshDir();
  const receiptPath = writeReceipt(dir, 'twice.json');
  const claimPath = claimPackRecoveryParent(receiptPath, 'first-run');
  const before = fs.readFileSync(claimPath, 'utf8');

  assert.throws(
    () => claimPackRecoveryParent(receiptPath, 'second-run'),
    (error) => {
      assert.match(error.message, /a recovery claim is already in progress for this receipt/);
      assert.ok(error.message.includes(claimPath));
      return true;
    },
  );

  assert.strictEqual(fs.readFileSync(claimPath, 'utf8'), before);
  assert.strictEqual(JSON.parse(before).parentRunId, 'first-run');
});

test('a claim that already has a child points at that child', () => {
  const dir = freshDir();
  const receiptPath = writeReceipt(dir, 'done.json');
  const claimPath = claimPackRecoveryParent(receiptPath, 'done');
  const childReceipt = path.join(dir, 'child-run.json');
  const claim = JSON.parse(fs.readFileSync(claimPath, 'utf8'));
  claim.childReceipt = childReceipt;
  fs.writeFileSync(claimPath, `${JSON.stringify(claim, null, 2)}\n`);

  assert.throws(
    () => claimPackRecoveryParent(receiptPath, 'done'),
    (error) => {
      assert.strictEqual(
        error.message,
        `this receipt already recovered as ${childReceipt}; recover from that child instead`,
      );
      return true;
    },
  );
});

test('an unreadable existing claim asks for manual review', () => {
  const bodies = ['not json at all', '', 'null', '"just a string"', '42'];
  for (const body of bodies) {
    const dir = freshDir();
    const receiptPath = writeReceipt(dir, 'broken.json');
    const claimPath = path.join(dir, 'broken.claim.json');
    fs.writeFileSync(claimPath, body);

    assert.throws(
      () => claimPackRecoveryParent(receiptPath, 'broken'),
      (error) => {
        assert.strictEqual(
          error.message,
          `a recovery claim for this receipt is unreadable; manual review needed at ${claimPath}`,
          `body ${JSON.stringify(body)}`,
        );
        return true;
      },
    );
    assert.strictEqual(fs.readFileSync(claimPath, 'utf8'), body);
  }
});

test('a claim with an empty child field is treated as in progress', () => {
  const dir = freshDir();
  const receiptPath = writeReceipt(dir, 'pending.json');
  const claimPath = path.join(dir, 'pending.claim.json');
  fs.writeFileSync(claimPath, JSON.stringify({ version: 1, childReceipt: null }));

  assert.throws(
    () => claimPackRecoveryParent(receiptPath, 'pending'),
    /already in progress for this receipt/,
  );
});

test('different receipts in one folder get independent claims', () => {
  const dir = freshDir();
  const a = claimPackRecoveryParent(writeReceipt(dir, 'a.json'), 'run-a');
  const b = claimPackRecoveryParent(writeReceipt(dir, 'b.json'), 'run-b');

  assert.notStrictEqual(a, b);
  assert.strictEqual(path.basename(a), 'a.claim.json');
  assert.strictEqual(path.basename(b), 'b.claim.json');
  assert.strictEqual(JSON.parse(fs.readFileSync(a, 'utf8')).parentRunId, 'run-a');
  assert.strictEqual(JSON.parse(fs.readFileSync(b, 'utf8')).parentRunId, 'run-b');
});

test('a receipt name without .json keeps its full name in the claim name', () => {
  const dir = freshDir();
  const receiptPath = writeReceipt(dir, 'receipt.txt');

  const claimPath = claimPackRecoveryParent(receiptPath, 'txt-run');

  assert.strictEqual(path.basename(claimPath), 'receipt.txt.claim.json');
  assert.ok(fs.existsSync(claimPath));
});

test('the receipt file itself does not have to exist', () => {
  const dir = freshDir();
  const receiptPath = path.join(dir, 'ghost.json');

  const claimPath = claimPackRecoveryParent(receiptPath, 'ghost');

  assert.strictEqual(claimPath, path.join(dir, 'ghost.claim.json'));
  assert.strictEqual(JSON.parse(fs.readFileSync(claimPath, 'utf8')).parentReceipt, receiptPath);
});

test('a relative receipt path is stored as an absolute path', () => {
  const dir = freshDir();
  const originalCwd = process.cwd();
  process.chdir(dir);
  try {
    const claimPath = claimPackRecoveryParent('./rel.json', 'rel');
    const claim = JSON.parse(fs.readFileSync(claimPath, 'utf8'));

    assert.ok(path.isAbsolute(claimPath));
    assert.strictEqual(path.basename(claimPath), 'rel.claim.json');
    assert.strictEqual(claim.parentReceipt, path.resolve('rel.json'));
    assert.ok(path.isAbsolute(claim.parentReceipt));
    assert.strictEqual(fs.realpathSync(path.dirname(claimPath)), fs.realpathSync(dir));
  } finally {
    process.chdir(originalCwd);
  }
});

test('a missing receipt folder surfaces the filesystem error and writes nothing', () => {
  const dir = freshDir();
  const missingDir = path.join(dir, 'does-not-exist');
  const receiptPath = path.join(missingDir, 'x.json');

  assert.throws(() => claimPackRecoveryParent(receiptPath, 'x'), { code: 'ENOENT' });

  assert.strictEqual(fs.existsSync(missingDir), false);
  assert.deepStrictEqual(fs.readdirSync(dir), []);
});

test('a missing run id is dropped from the claim instead of crashing', () => {
  const dir = freshDir();
  const claimPath = claimPackRecoveryParent(writeReceipt(dir, 'noid.json'), undefined);

  const claim = JSON.parse(fs.readFileSync(claimPath, 'utf8'));
  assert.strictEqual('parentRunId' in claim, false);
  assert.strictEqual(claim.childReceipt, null);
  assert.strictEqual(claim.version, 1);
});
