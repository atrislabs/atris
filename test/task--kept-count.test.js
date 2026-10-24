const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kept-count-home-'));
process.env.HOME = tmpHome;
for (const key of Object.keys(process.env)) {
  if (key.startsWith('ATRIS_')) delete process.env[key];
}

const { keptCount } = require('../commands/task');

test('counts put_away and reaped items together', () => {
  const result = {
    put_away: [{ id: 'a' }, { id: 'b' }],
    reaped: [{ id: 'c' }],
  };
  assert.strictEqual(keptCount(result), 3);
});

test('missing list keys count as zero', () => {
  assert.strictEqual(keptCount({ put_away: [{ id: 'a' }] }), 1);
  assert.strictEqual(keptCount({ reaped: [{ id: 'a' }, { id: 'b' }] }), 2);
  assert.strictEqual(keptCount({}), 0);
});

test('null, undefined, and empty lists all return zero', () => {
  assert.strictEqual(keptCount(null), 0);
  assert.strictEqual(keptCount(undefined), 0);
  assert.strictEqual(keptCount({ put_away: [], reaped: [] }), 0);
});
