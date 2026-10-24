'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setMemberParked } = require('../lib/member-park');

test('rejects a member path even when it points to an existing card', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'park-name-'));
  try {
    const dir = path.join(root, 'atris', 'team', 'coder');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'MEMBER.md');
    fs.writeFileSync(file, '---\nname: coder\nrole: builder\n---\n');
    const result = setMemberParked(root, 'coder/../coder', {
      parked: true,
      now: new Date('2026-09-27T12:00:00Z'),
    });
    assert.equal(result.ok, false);
    assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /^status: parked$/m);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
