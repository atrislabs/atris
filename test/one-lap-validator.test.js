'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildOneLapValidatorPrompt,
  parseOneLapValidatorVerdict,
} = require('../lib/one-lap-validator');

test('one-lap validator prompt requires an independent read-only diff and verifier pass', () => {
  const prompt = buildOneLapValidatorPrompt({ display_id: 'CLI-939', title: 'fix the auth bug' }, {
    executorEngine: 'codex',
    verifierCommand: 'node --test',
  });
  assert.match(prompt, /independent validator/);
  assert.match(prompt, /git diff origin\/master\.\.\.HEAD/);
  assert.match(prompt, /git diff HEAD/);
  assert.match(prompt, /Required verifier: node --test/);
  assert.match(prompt, /Do not edit files/);
  assert.match(prompt, /SIGNOFF: <specific evidence> or REJECT:/);
});

test('one-lap validator parser accepts only one final signoff line', () => {
  assert.deepEqual(parseOneLapValidatorVerdict('reviewed diff\nSIGNOFF: auth regression passed'), {
    passed: true,
    verdict: 'signoff',
    reason: 'auth regression passed',
  });
  assert.deepEqual(parseOneLapValidatorVerdict('REJECT: unrelated file changed'), {
    passed: false,
    verdict: 'reject',
    reason: 'unrelated file changed',
  });
  assert.equal(parseOneLapValidatorVerdict('SIGNOFF: early\nmore text').passed, false);
  assert.equal(parseOneLapValidatorVerdict('SIGNOFF: yes\nREJECT: no').passed, false);
  assert.equal(parseOneLapValidatorVerdict('looks good').passed, false);
});
