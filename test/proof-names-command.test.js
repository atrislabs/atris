'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { proofNamesUnrunCommand } = require('../commands/task');

test('a proof that names a runnable command is spotted so it can become a verifier', () => {
  const cases = [
    ['Ran: npm run test:alpha-scout and it passed', 'npm run test:alpha-scout'],
    ['node --test test/cloud-mission.test.js -> 9/9', 'node --test test/cloud-mission.test.js'],
    ['checked with node --check bin/atris.js', 'node --check bin/atris.js'],
    ['cd backend && ATRIS_OFFLINE=1 ../venv/bin/pytest tests/test_x.py -q passed',
      'cd backend && ATRIS_OFFLINE=1 ../venv/bin/pytest tests/test_x.py'],
    ['I ran `npx vitest run app/api` green', 'npx vitest run app/api'],
    ['make lint came back clean', 'make lint'],
  ];
  for (const [proof, expected] of cases) {
    assert.equal(proofNamesUnrunCommand(proof), expected, proof);
  }
});

test('prose with no command in it stays quiet', () => {
  const quiet = [
    '',
    '   ',
    'Concrete command, file, receipt, or verifier evidence for the member experiment.',
    'The customer confirmed the report looks right.',
    'Receipt saved in mission history.',
    // The audit found these two accepted as proof; neither names anything runnable.
    'Task proof must name the loop command, guardrail, and receipt before Review.',
    'scoped rg proof; git diff --check on touched docs; live heartbeat status smoke',
    // Real ledger rows. A bare English word after the binary is prose, not a
    // target, and suggesting "node --check plus" as a verifier is worse than
    // staying quiet.
    'node --check plus focused/full task command tests, installed atris smoke',
    'node --test focused task tests plus installed atris smoke and codex review',
  ];
  for (const proof of quiet) {
    assert.equal(proofNamesUnrunCommand(proof), '', proof);
  }
});
