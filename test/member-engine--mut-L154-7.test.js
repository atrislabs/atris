'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveEngineForMember } = require('../lib/member-engine');

test('member resolution preserves the role title from its card', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-member-title-'));
  const previousHome = process.env.HOME;
  process.env.HOME = root;
  try {
    const dir = path.join(root, 'atris', 'team', 'avery');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'MEMBER.md'), '---\nname: Avery\nrole: Release coordinator\ntype: agent\n---\n');
    const result = resolveEngineForMember('avery', root, {
      now: new Date('2026-09-24T12:00:00Z'),
      rosterState: {
        session: { picks: {}, team: [] },
        project: { picks: {}, team: [] },
        machine: { picks: {}, team: [] },
      },
    });
    assert.strictEqual(result.title, 'Release coordinator');
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});
