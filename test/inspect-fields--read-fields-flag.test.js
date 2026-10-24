const assert = require('node:assert');
const test = require('node:test');
const { readFieldsFlag } = require('../lib/inspect-fields');

test('readFieldsFlag returns the parsed field list after the default --fields flag', () => {
  assert.deepStrictEqual(
    readFieldsFlag(['task-1', '--fields', 'status,title', '--json']),
    { fields: ['status', 'title'] },
  );
  assert.deepStrictEqual(
    readFieldsFlag(['--fields', 'review']),
    { fields: ['review'] },
  );
});

test('readFieldsFlag trims, lowercases, and drops empty entries from the list', () => {
  assert.deepStrictEqual(
    readFieldsFlag(['--fields', ' Status , ,TITLE,']),
    { fields: ['status', 'title'] },
  );
});

test('readFieldsFlag returns null when the flag is absent', () => {
  assert.strictEqual(readFieldsFlag(['task-1', '--json']), null);
  assert.strictEqual(readFieldsFlag([]), null);
});

test('readFieldsFlag reports an error when the flag has no value', () => {
  assert.deepStrictEqual(
    readFieldsFlag(['task-1', '--fields']),
    { error: '--fields requires a comma-separated field list' },
  );
  assert.deepStrictEqual(
    readFieldsFlag(['--fields', '--json']),
    { error: '--fields requires a comma-separated field list' },
  );
  assert.deepStrictEqual(
    readFieldsFlag(['--fields', '']),
    { error: '--fields requires a comma-separated field list' },
  );
});

test('readFieldsFlag reports an error when the value holds no field names', () => {
  assert.deepStrictEqual(
    readFieldsFlag(['--fields', ' , ,']),
    { error: '--fields requires at least one field' },
  );
});

test('readFieldsFlag uses the flag name it is given in its error messages', () => {
  assert.deepStrictEqual(
    readFieldsFlag(['--only', 'a,b'], '--only'),
    { fields: ['a', 'b'] },
  );
  assert.deepStrictEqual(
    readFieldsFlag(['--only'], '--only'),
    { error: '--only requires a comma-separated field list' },
  );
  assert.strictEqual(readFieldsFlag(['--fields', 'a'], '--only'), null);
});
