'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { explanationFieldsFromInput } = require('../lib/task-explanation');

test('reads snake and camel explanation fields and drops every other key', () => {
  const fromSnake = explanationFieldsFromInput({
    what_changes: '  ships   the reply check  ',
    why_it_matters: 'people can trust the answer',
    done_looks_like: 'the check passes',
    title: 'ignored title',
    verify: 'node --test test/task-explanation.test.js',
    goal: 'not an explanation field',
  });
  const fromCamel = explanationFieldsFromInput({
    whatChanges: 'ships the reply check',
    whyItMatters: 'people can trust the answer',
    doneLooksLike: 'the check passes',
    what_happened: 'not a field',
  });

  const expected = {
    what_changes: 'ships the reply check',
    why_it_matters: 'people can trust the answer',
    done_looks_like: 'the check passes',
  };
  assert.deepStrictEqual(fromSnake, expected);
  assert.deepStrictEqual(fromCamel, expected);
});

test('prefers a nested explanation, and a blank nested value does not fall back to the same flat key', () => {
  const fields = explanationFieldsFromInput({
    what_changes: 'flat snake',
    whatChanges: 'flat camel',
    doneLooksLike: 'flat camel done',
    explanation: {
      what_changes: 'nested snake',
      whatChanges: 'nested camel',
      whyItMatters: '  nested   camel reason  ',
      done_looks_like: '   ',
    },
  });

  assert.deepStrictEqual(fields, {
    what_changes: 'nested snake',
    why_it_matters: 'nested camel reason',
    done_looks_like: 'flat camel done',
  });

  assert.deepStrictEqual(explanationFieldsFromInput({
    what_changes: 'flat should not win',
    explanation: { what_changes: '   ' },
  }), {});

  assert.deepStrictEqual(explanationFieldsFromInput({
    what_changes: 'flat snake wins over camel',
    whatChanges: 'flat camel loses',
  }), {
    what_changes: 'flat snake wins over camel',
  });
});

test('returns an empty object for missing, blank, or unusable input', () => {
  const unusable = [
    undefined,
    null,
    '',
    'what_changes',
    0,
    42,
    true,
    false,
    [],
    {},
    { explanation: null },
    { explanation: 'nope' },
    { explanation: [] },
    {
      what_changes: '   ',
      why_it_matters: '',
      done_looks_like: null,
      whatChanges: '\n\t',
    },
  ];

  for (const input of unusable) {
    assert.deepStrictEqual(explanationFieldsFromInput(input), {});
  }
});
