'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const pulse = require('../lib/pulse');

test('verify_pass counts only ticks whose verify actually passed', () => {
  const receipts = [
    pulse.buildPulseReceipt({ tickIndex: 1, phase: 'started' }),
    pulse.buildPulseReceipt({ tickIndex: 1, phase: 'finished', verifyPassed: true, reward: 1 }),
    pulse.buildPulseReceipt({ tickIndex: 2, phase: 'started' }),
    pulse.buildPulseReceipt({ tickIndex: 2, phase: 'finished', verifyPassed: true, reward: 1 }),
    pulse.buildPulseReceipt({ tickIndex: 3, phase: 'started' }),
    pulse.buildPulseReceipt({ tickIndex: 3, phase: 'finished', verifyPassed: null, reward: 0 }),
  ];
  const s = pulse.summarizePulse(receipts);
  assert.strictEqual(s.verify_pass, 2);
});
