'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { renderFeedbackTriageBrief } = require('../lib/feedback-triage');

function brief(overrides = {}) {
  return {
    feedback_id: 'feedback-example',
    workspace: 'example-workspace',
    verify_command: 'node --test test/example.test.js',
    steps_to_reproduce: ['Open the feedback view.', 'Submit a report.'],
    verdict_contract: {
      'cannot reproduce': 'The reported steps pass.',
      reproduced: 'The reported action fails.',
      'already fixed on master': 'The same steps pass on master.',
      extra: 'This must not appear.',
    },
    ...overrides,
  };
}

test('renders the complete brief with numbered steps and contracts in canonical order', () => {
  const input = brief();
  const before = JSON.stringify(input);

  assert.strictEqual(renderFeedbackTriageBrief(input), [
    'feedback triage feedback-example',
    'workspace: example-workspace',
    'verify: node --test test/example.test.js',
    '',
    'steps to reproduce:',
    '1. Open the feedback view.',
    '2. Submit a report.',
    '',
    'verdict contract:',
    '- reproduced: The reported action fails.',
    '- already fixed on master: The same steps pass on master.',
    '- cannot reproduce: The reported steps pass.',
  ].join('\n'));
  assert.strictEqual(JSON.stringify(input), before);
});

test('renders an empty step list without inventing steps or losing section spacing', () => {
  const output = renderFeedbackTriageBrief(brief({ steps_to_reproduce: [] }));

  assert.strictEqual(output, [
    'feedback triage feedback-example',
    'workspace: example-workspace',
    'verify: node --test test/example.test.js',
    '',
    'steps to reproduce:',
    '',
    'verdict contract:',
    '- reproduced: The reported action fails.',
    '- already fixed on master: The same steps pass on master.',
    '- cannot reproduce: The reported steps pass.',
  ].join('\n'));
});

test('preserves punctuation, unicode, and command text in supplied values', () => {
  const output = renderFeedbackTriageBrief(brief({
    feedback_id: 'report: café',
    workspace: 'workspace with spaces',
    verify_command: 'npm test -- --flag=value',
    steps_to_reproduce: ['Keep  two spaces: café & <text>.'],
  }));

  assert.ok(output.startsWith('feedback triage report: café\nworkspace: workspace with spaces\nverify: npm test -- --flag=value\n'));
  assert.ok(output.includes('\n1. Keep  two spaces: café & <text>.\n'));
});

test('rejects a brief whose required step list is missing', () => {
  const input = brief();
  delete input.steps_to_reproduce;

  assert.throws(() => renderFeedbackTriageBrief(input), TypeError);
});
