'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildMissionRoom } = require('../lib/mission-room');

test('routing alternatives include real members and exclude the member template', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-room-roster-'));
  const previousHome = process.env.HOME;
  process.env.HOME = root;
  try {
    for (const name of ['onboarding-lead', '_template']) {
      const directory = path.join(root, 'atris', 'team', name);
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(path.join(directory, 'MEMBER.md'), `# ${name}\n\nRole: customer onboarding\n`);
    }
    const room = buildMissionRoom('prepare customer onboarding', { root });
    assert.equal(room.member_route.alternatives.includes('onboarding-lead'), true);
    assert.equal(room.member_route.alternatives.includes('_template'), false);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
