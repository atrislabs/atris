'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { businessOrSay } = require('../lib/business-target');

test('businessOrSay trims an explicit business and skips folder lookup', () => {
  const errors = [];
  const result = businessOrSay({ business: '  sample-shop  ' }, {
    findBusiness() { assert.fail('explicit business must skip folder lookup'); }
  }, message => errors.push(message));

  assert.deepStrictEqual(result, { id: 'sample-shop', name: 'sample-shop' });
  assert.deepStrictEqual(errors, []);
});

test('businessOrSay returns a discovered business with a fallback for an empty name', () => {
  for (const name of ['Sample Shop', '']) {
    const errors = [];
    const result = businessOrSay({}, {
      cwd: 'injected-folder',
      findBusiness(cwd) {
        assert.strictEqual(cwd, 'injected-folder');
        return { businessId: 'sample-shop', name };
      }
    }, message => errors.push(message));

    assert.deepStrictEqual(result, {
      id: 'sample-shop', name: name || 'this business'
    });
    assert.deepStrictEqual(errors, []);
  }
});

test('businessOrSay reports a missing business and returns null', () => {
  for (const found of [null, {}, { name: 'No identifier' }]) {
    const errors = [];
    const result = businessOrSay({}, {
      cwd: 'injected-folder',
      findBusiness() { return found; }
    }, message => errors.push(message));

    assert.strictEqual(result, null);
    assert.deepStrictEqual(errors, [
      'no business here. run this inside a business folder, or add --business <slug>'
    ]);
  }
});

test('businessOrSay rejects empty or non-string explicit businesses without falling back', () => {
  for (const business of ['', ' \t ', true, null, undefined, 42]) {
    const errors = [];
    const result = businessOrSay({ business }, {
      findBusiness() { assert.fail('invalid explicit business must skip folder lookup'); }
    }, message => errors.push(message));

    assert.strictEqual(result, null);
    assert.deepStrictEqual(errors, ['--business needs a business slug or id']);
  }
});
