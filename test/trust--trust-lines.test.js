const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// trustLines is pure, but the module pulls in auth and api helpers. Point HOME
// at a temp dir and clear ATRIS_* first so nothing can read this machine.
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-trust-lines-'));
const savedEnv = { ...process.env };
for (const key of Object.keys(process.env)) {
  if (key.startsWith('ATRIS_')) delete process.env[key];
}
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;

const { trustLines } = require('../commands/trust');

for (const key of ['HOME', 'USERPROFILE']) {
  if (savedEnv[key] === undefined) delete process.env[key];
  else process.env[key] = savedEnv[key];
}
for (const [key, value] of Object.entries(savedEnv)) {
  if (key.startsWith('ATRIS_')) process.env[key] = value;
}

test.after(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

test('own account: handle, score, plural friends, and the (you) tag', () => {
  const lines = trustLines({ handle: 'alice', trust_score: 5, friends: 5 }, true);
  assert.deepStrictEqual(lines, [
    '@alice (you)',
    '  Trust score 5, from 5 friends',
  ]);
});

test('someone else: no (you) tag, and trusted and shared lines appear', () => {
  const lines = trustLines(
    { handle: 'bob', trust_score: 2, friends: 2, trusted_with_me: true, shared_friends: 1 },
    false
  );
  assert.deepStrictEqual(lines, [
    '@bob',
    '  Trust score 2, from 2 friends',
    '  Trusted with you: yes',
    '  Friends you share: 1',
  ]);
});

test('exactly one friend uses the singular word', () => {
  const lines = trustLines({ handle: 'carol', trust_score: 1, friends: 1 }, false);
  assert.strictEqual(lines[1], '  Trust score 1, from 1 friend');
});

test('zero friends uses the plural word', () => {
  const lines = trustLines({ handle: 'dan', trust_score: 0, friends: 0 }, true);
  assert.strictEqual(lines[1], '  Trust score 0, from 0 friends');
});

test('leading @ characters in the handle are stripped before one is added', () => {
  assert.strictEqual(trustLines({ handle: '@erin' }, false)[0], '@erin');
  assert.strictEqual(trustLines({ handle: '@@@erin' }, false)[0], '@erin');
  // only a leading @ is removed, an @ inside the handle stays
  assert.strictEqual(trustLines({ handle: 'er@in' }, false)[0], '@er@in');
});

test('name falls back to user_id, then to "this account"', () => {
  assert.strictEqual(trustLines({ user_id: 'u_123' }, false)[0], 'u_123');
  assert.strictEqual(trustLines({ user_id: 'u_123' }, true)[0], 'u_123 (you)');
  assert.strictEqual(trustLines({}, false)[0], 'this account');
  assert.strictEqual(trustLines({}, true)[0], 'this account (you)');
  // an empty handle counts as missing
  assert.strictEqual(trustLines({ handle: '', user_id: 'u_9' }, false)[0], 'u_9');
});

test('handle wins over user_id when both are present', () => {
  const lines = trustLines({ handle: 'frank', user_id: 'u_77' }, false);
  assert.strictEqual(lines[0], '@frank');
});

test('empty, null, and undefined views give a safe default card', () => {
  const expected = ['this account', '  Trust score 0, from 0 friends'];
  assert.deepStrictEqual(trustLines(undefined, false), expected);
  assert.deepStrictEqual(trustLines(null, false), expected);
  assert.deepStrictEqual(trustLines({}, false), expected);
  assert.deepStrictEqual(trustLines(null, true), [
    'this account (you)',
    '  Trust score 0, from 0 friends',
  ]);
});

test('trusted_with_me: true is yes, false is no, anything else is left out', () => {
  const base = { handle: 'gina', trust_score: 1, friends: 1 };
  assert.ok(trustLines({ ...base, trusted_with_me: true }, false).includes('  Trusted with you: yes'));
  assert.ok(trustLines({ ...base, trusted_with_me: false }, false).includes('  Trusted with you: no'));
  for (const odd of [null, undefined, 'true', 1, 0]) {
    const lines = trustLines({ ...base, trusted_with_me: odd }, false);
    assert.ok(
      !lines.some((l) => l.includes('Trusted with you')),
      `trusted_with_me=${String(odd)} should print no trusted line`
    );
  }
});

test('shared_friends: zero is shown, null and undefined are left out', () => {
  const base = { handle: 'hank', trust_score: 3, friends: 3 };
  const zero = trustLines({ ...base, shared_friends: 0 }, false);
  assert.strictEqual(zero[zero.length - 1], '  Friends you share: 0');

  for (const missing of [null, undefined]) {
    const lines = trustLines({ ...base, shared_friends: missing }, false);
    assert.ok(!lines.some((l) => l.includes('Friends you share')));
  }
});

test('trust_score keeps a real zero but turns null into 0', () => {
  assert.strictEqual(trustLines({ trust_score: 0, friends: 4 }, false)[1], '  Trust score 0, from 4 friends');
  assert.strictEqual(trustLines({ trust_score: null, friends: 4 }, false)[1], '  Trust score 0, from 4 friends');
  assert.strictEqual(trustLines({ friends: 4 }, false)[1], '  Trust score 0, from 4 friends');
});

test('friends is coerced to a number, junk becomes 0', () => {
  assert.strictEqual(trustLines({ friends: '3' }, false)[1], '  Trust score 0, from 3 friends');
  assert.strictEqual(trustLines({ friends: '1' }, false)[1], '  Trust score 0, from 1 friend');
  assert.strictEqual(trustLines({ friends: 'many' }, false)[1], '  Trust score 0, from 0 friends');
  assert.strictEqual(trustLines({ friends: null }, false)[1], '  Trust score 0, from 0 friends');
  assert.strictEqual(trustLines({ friends: NaN }, false)[1], '  Trust score 0, from 0 friends');
});

test('isMe is only a display flag: the other lines match either way', () => {
  const view = { handle: 'ivy', trust_score: 4, friends: 4, trusted_with_me: false, shared_friends: 2 };
  const mine = trustLines(view, true);
  const theirs = trustLines(view, false);
  assert.strictEqual(mine[0], '@ivy (you)');
  assert.strictEqual(theirs[0], '@ivy');
  assert.deepStrictEqual(mine.slice(1), theirs.slice(1));
});

test('does not change the view it is given', () => {
  const view = { handle: '@@jo', trust_score: 2, friends: 2, trusted_with_me: true, shared_friends: 0 };
  const copy = JSON.parse(JSON.stringify(view));
  trustLines(view, false);
  assert.deepStrictEqual(view, copy);
});
