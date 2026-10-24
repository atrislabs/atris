'use strict';
require('./helpers/clean-temp');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('proof lists a null check as not passed', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-null-check-'));
  const previousHome = process.env.HOME;
  const previousCwd = process.cwd();
  process.env.HOME = root;
  process.chdir(root);
  try {
    const { renderProofCard, missionProofPayload } = require('../commands/human-missions');
    const proof = missionProofPayload({
      result: { proof: { checks: [null] } },
    });
    const lines = renderProofCard(proof);
    assert.strictEqual(lines.some((line) => /checks not passed/i.test(line)), true);
  } finally {
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});
