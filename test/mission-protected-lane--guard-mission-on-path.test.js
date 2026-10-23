'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { GUARD_DIR_PREFIX, guardMissionOnPath } = require('../lib/mission-protected-lane');

function makeGuardDir(t, missionJson) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), GUARD_DIR_PREFIX));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  if (missionJson !== undefined) {
    fs.writeFileSync(path.join(dir, 'mission.json'), missionJson, 'utf8');
  }
  return dir;
}

function makePlainDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-test-plain-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('returns the mission id from the guard directory on PATH', (t) => {
  const guardDir = makeGuardDir(t, JSON.stringify({ mission_id: 'msn_abc123' }));
  const plainDir = makePlainDir(t);
  const pathValue = ['/usr/bin', guardDir, plainDir, '/bin'].join(path.delimiter);

  assert.equal(guardMissionOnPath(pathValue), 'msn_abc123');
});

test('returns null when PATH has no guard directory', (t) => {
  const plainDir = makePlainDir(t);
  fs.writeFileSync(path.join(plainDir, 'mission.json'), JSON.stringify({ mission_id: 'msn_hidden' }), 'utf8');

  assert.equal(guardMissionOnPath(['/usr/bin', plainDir].join(path.delimiter)), null);
});

test('skips a guard directory without a readable mission file and finds a later one', (t) => {
  const emptyGuard = makeGuardDir(t);
  const brokenGuard = makeGuardDir(t, '{not json');
  const realGuard = makeGuardDir(t, JSON.stringify({ mission_id: 'msn_later' }));
  const pathValue = [emptyGuard, brokenGuard, realGuard].join(path.delimiter);

  assert.equal(guardMissionOnPath(pathValue), 'msn_later');
});

test('returns null when mission.json has no mission_id', (t) => {
  const nullGuard = makeGuardDir(t, JSON.stringify({ mission_id: null }));
  const missingGuard = makeGuardDir(t, JSON.stringify({ other: 'field' }));

  assert.equal(guardMissionOnPath([nullGuard, missingGuard].join(path.delimiter)), null);
});

test('returns null for an empty PATH value', () => {
  assert.equal(guardMissionOnPath(''), null);
});
