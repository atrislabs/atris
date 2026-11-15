'use strict';

// The second check finds a check written as "<command>, exit 0".
//
// 2026-11-15: six atrisos-web jobs, all merged, wrote their check as
// "Verifier result at that commit: node scripts/verify-vitest.mjs ..., exit 0"
// with no --verify on record. No second actor ever found the command, so
// they sat in review for days. The proof below is one of them, word for word
// apart from the commit and pull request numbers.

const test = require('node:test');
const assert = require('node:assert/strict');

const { certifyVerifyCandidate } = require('../commands/task');

const job = (proof) => ({ metadata: {}, review: { proof } });

test('a check named before ", exit 0" is the one the second actor re-runs', () => {
  const proof = 'Merged as commit 1111111 (PR 1000). Changed files: app/dashboard/preview/lanes/OrbOnDemand.tsx, lanes/BusinessLane.tsx, on-demand.ts. '
    + 'Verifier result at that commit: node scripts/verify-vitest.mjs app/dashboard/orb app/dashboard/preview/lanes app/dashboard/preview/on-demand, exit 0, 16 new tests pass. '
    + 'Builder measured the first screen at 376 ms.';
  assert.equal(certifyVerifyCandidate(job(proof)),
    'node scripts/verify-vitest.mjs app/dashboard/orb app/dashboard/preview/lanes app/dashboard/preview/on-demand');
});

test('a comma inside a list of tests is never cut into a smaller check', () => {
  const proof = 'Checks: node --test test/a.test.js, test/b.test.js passed.';
  const found = certifyVerifyCandidate(job(proof));
  assert.notEqual(found, 'node --test test/a.test.js');
});
