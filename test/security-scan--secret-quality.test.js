'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { secretQuality, shannonEntropy } = require('../lib/security-scan');

test('secretQuality accepts a high-entropy value and reports its entropy', () => {
  const value = 'k9Xv2LmQ7pRt4WzB8nYc3HdF';
  const result = secretQuality(value);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.reason, 'real-shaped');
  assert.strictEqual(result.entropy, shannonEntropy(value));
  assert.ok(result.entropy > 4.5);
});

test('secretQuality trims surrounding whitespace before judging', () => {
  const bare = secretQuality('k9Xv2LmQ7pRt4WzB8nYc3HdF');
  const padded = secretQuality('   k9Xv2LmQ7pRt4WzB8nYc3HdF  ');
  assert.deepStrictEqual(padded, bare);
});

test('secretQuality rejects empty, nullish and blank input as placeholder', () => {
  for (const input of ['', '   ', null, undefined]) {
    assert.deepStrictEqual(secretQuality(input), { ok: false, reason: 'placeholder' });
  }
});

test('secretQuality rejects well-known placeholder shapes', () => {
  const placeholders = [
    'hunter2',
    'password',
    '<token>',
    '${API_TOKEN}',
    'xxxxxxxxxxxx',
    'your_api_key_value_here',
  ];
  for (const value of placeholders) {
    assert.deepStrictEqual(secretQuality(value), { ok: false, reason: 'placeholder' }, value);
  }
});

test('secretQuality treats a placeholder word on the source line as a placeholder', () => {
  const value = 'k9Xv2LmQ7pRt4WzB8nYc3HdF';
  assert.strictEqual(secretQuality(value, {}, 'KEY=' + value).ok, true);
  assert.deepStrictEqual(
    secretQuality(value, {}, 'KEY=' + value + ' # example'),
    { ok: false, reason: 'placeholder' },
  );
});

test('secretQuality skips the entropy checks for private key markers', () => {
  const marker = '-----BEGIN PRIVATE KEY-----';
  assert.deepStrictEqual(
    secretQuality(marker, { known: true, noEntropy: true }),
    { ok: true, entropy: null, reason: 'private-key-marker' },
  );
  // the placeholder check still runs first
  assert.deepStrictEqual(
    secretQuality(marker, { noEntropy: true }, '# example'),
    { ok: false, reason: 'placeholder' },
  );
});

test('secretQuality enforces a shorter minimum length for known providers', () => {
  const sixteen = 'Qw8Er2Ty5Ui9Op3A';
  assert.strictEqual(secretQuality(sixteen, { known: true }).ok, true);
  assert.strictEqual(secretQuality(sixteen).reason, 'too-short');

  const eighteen = 'Qw8Er2Ty5Ui9Op3AxZ';
  assert.strictEqual(secretQuality(eighteen).ok, true);

  const fifteen = 'Qw8Er2Ty5Ui9Op3';
  assert.strictEqual(secretQuality(fifteen, { known: true }).reason, 'too-short');
});

test('secretQuality strips provider prefixes and separators before measuring length', () => {
  // 16 real characters after the prefix, so it passes the known minimum
  assert.strictEqual(secretQuality('ghp_Qw8Er2Ty5Ui9Op3A', { known: true }).ok, true);
  // 15 real characters after the prefix: the prefix does not count toward length
  assert.strictEqual(secretQuality('ghp_Qw8Er2Ty5Ui9Op3', { known: true }).reason, 'too-short');
  // dashes, dots and underscores are dropped from the core
  const dashed = secretQuality('Qw8E-r2Ty_5Ui9.Op3A', { known: true });
  const plain = secretQuality('Qw8Er2Ty5Ui9Op3A', { known: true });
  assert.deepStrictEqual(dashed, plain);
});

test('secretQuality reports why each weak value was rejected', () => {
  const cases = [
    ['aB3dE5gH7jK9mN', 'too-short'],
    ['aaabbbcccdddeeefff111222333', 'low-variety'],
    ['qzkwxjvbnmplhgfrtysd', 'single-charset'],
    ['48201937560284719305', 'single-charset'],
    ['a1b2c3d4e5f6a1b2c3d4e5f6', 'repeating'],
    ['Zx9abcdefghQw3Rt8Yp', 'sequential'],
    ['Xk9zyxwvutsrqPm2Lb', 'sequential'],
    ['Hd3k0123456789Lp7Qz', 'sequential'],
    ['Rt7qwertyuiopMn4Vb', 'sequential'],
  ];
  for (const [value, reason] of cases) {
    const result = secretQuality(value);
    assert.strictEqual(result.ok, false, value);
    assert.strictEqual(result.reason, reason, value);
    assert.strictEqual(typeof result.entropy, 'number', value);
  }
});

test('secretQuality uses a lower variety bar and an entropy floor for known providers', () => {
  const skewed = 'a'.repeat(30) + 'bcdefgh1';
  // unknown value needs 10 distinct characters, this has 9
  assert.strictEqual(secretQuality(skewed).reason, 'low-variety');
  // known value clears the variety bar (8) but then fails the entropy floor
  const known = secretQuality(skewed, { known: true });
  assert.strictEqual(known.ok, false);
  assert.strictEqual(known.reason, 'low-entropy');
  assert.ok(known.entropy < 3.0);
});

test('secretQuality accepts a value with a few repeated pairs when entropy is high enough', () => {
  const result = secretQuality('aabbccddeeff1122334455');
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.reason, 'real-shaped');
  assert.ok(result.entropy >= 3.35);
});

test('secretQuality coerces non-string values instead of throwing', () => {
  const result = secretQuality(12345678901234567890);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'single-charset');
});
