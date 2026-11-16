'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// lib/self-drive.js resolves ~/.swarlo from os.homedir() at call time, so
// HOME points at a scratch dir before the require below.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-self-drive-id-'));
const fakeHome = path.join(sandbox, 'home');
fs.mkdirSync(path.join(fakeHome, '.swarlo'), { recursive: true });

const SWARLO_ENV = [
  'SWARLO_SERVER', 'SWARLO_HUB', 'SWARLO_HUB_ID', 'SWARLO_HUB_URL',
  'SWARLO_CONFIG', 'SWARLO_TOKEN', 'SWARLO_API_KEY', 'SWARLO_MEMBER_ID',
];
const realEnv = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
for (const key of SWARLO_ENV) realEnv[key] = process.env[key];
for (const key of SWARLO_ENV) delete process.env[key];
process.env.HOME = fakeHome;
process.env.USERPROFILE = fakeHome;

const { handleMissionBlocker, loadSwarloApiKey } = require('../lib/self-drive');
const swarlo = require('../lib/swarlo-members');

function resetHome() {
  fs.rmSync(path.join(fakeHome, '.swarlo'), { recursive: true, force: true });
  fs.mkdirSync(path.join(fakeHome, '.swarlo'), { recursive: true });
}

function writeMemberKey(name, token, { server = 'http://localhost:8090', hub = 'atris' } = {}) {
  const dir = swarlo.identityDirFor({ server, hub, member: name });
  swarlo.saveIdentity(dir, { server, hub, member_id: name, member_name: name, member_type: 'agent', token });
  return dir;
}

// Raw .key files like the hub mints; mtime decides which is "newest".
function writeSharedKey(name, token, mtimeMs, { memberId = 'someone-else' } = {}) {
  const file = path.join(fakeHome, '.swarlo', name);
  fs.writeFileSync(file, token);
  const when = new Date(mtimeMs);
  fs.utimesSync(file, when, when);
  if (memberId) {
    fs.writeFileSync(path.join(fakeHome, '.swarlo', 'config.json'), JSON.stringify({
      server: 'http://localhost:8090', hub: 'atris', member_id: memberId, api_key: 'shared-config-key',
    }));
  }
}

test.after(() => {
  for (const [key, value] of Object.entries(realEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(sandbox, { recursive: true, force: true });
});

test('a named member resolves its own identity dir token, never the newest shared key', () => {
  resetHome();
  writeMemberKey('builder', 'member-builder-key');
  writeSharedKey('aaa.key', 'old-shared-key', Date.now() - 10000);
  writeSharedKey('zzz.key', 'newest-shared-key', Date.now());
  assert.equal(loadSwarloApiKey('builder'), 'member-builder-key');
  // A member with no identity gets nothing rather than borrowing the
  // newest shared key that belongs to somebody else.
  assert.equal(loadSwarloApiKey('ghost'), null);
  // With no member named, the original newest-.key fallback still applies.
  assert.equal(loadSwarloApiKey(), 'newest-shared-key');
  assert.equal(loadSwarloApiKey(''), 'newest-shared-key');
});

test('SWARLO_TOKEN and SWARLO_CONFIG env identity win over everything', () => {
  resetHome();
  writeMemberKey('builder', 'member-builder-key');
  process.env.SWARLO_TOKEN = 'env-token';
  try {
    assert.equal(loadSwarloApiKey('builder'), 'env-token');
  } finally {
    delete process.env.SWARLO_TOKEN;
  }
  const configFile = path.join(sandbox, 'custom-config.json');
  fs.writeFileSync(configFile, JSON.stringify({ server: 'http://x', hub: 'h', member_id: 'builder', token: 'config-file-key' }));
  process.env.SWARLO_CONFIG = configFile;
  try {
    assert.equal(loadSwarloApiKey('builder'), 'config-file-key');
    // An unreadable SWARLO_CONFIG loses to the member's own identity dir.
    process.env.SWARLO_CONFIG = path.join(sandbox, 'missing.json');
    assert.equal(loadSwarloApiKey('builder'), 'member-builder-key');
  } finally {
    delete process.env.SWARLO_CONFIG;
  }
});

test('SWARLO_MEMBER_ID names the member for the identity lookup', () => {
  resetHome();
  writeMemberKey('scout', 'member-scout-key');
  process.env.SWARLO_MEMBER_ID = 'scout';
  try {
    assert.equal(loadSwarloApiKey(), 'member-scout-key');
  } finally {
    delete process.env.SWARLO_MEMBER_ID;
  }
});

test('the shared config.json counts only when it names the requested member', () => {
  resetHome();
  fs.writeFileSync(path.join(fakeHome, '.swarlo', 'config.json'), JSON.stringify({
    server: 'http://localhost:8090', hub: 'atris', member_id: 'builder', api_key: 'shared-builder-key',
  }));
  assert.equal(loadSwarloApiKey('builder'), 'shared-builder-key');
  assert.equal(loadSwarloApiKey('scout'), null);
});

// Minimal harness mirroring test/self-drive.test.js: engine null forces the
// fleet-escalation path, taskDb is stubbed, httpPost captures the post.
function blockerHarness({ mission, httpPost }) {
  const rows = [];
  const taskDb = {
    open: () => ({}),
    workspaceRoot: (root) => root,
    listTasks: () => rows,
    withTaskDisplayRefs: (tasks) => tasks.map((task, index) => ({ ...task, display_id: `CLI-${index + 1}` })),
    addTask: (_db, input) => {
      const now = Date.now();
      const task = { id: `task-${rows.length + 1}`, status: 'open', created_at: now, updated_at: now, ...input };
      rows.push(task);
      return { id: task.id, inserted: true };
    },
    getTask: (_db, id) => rows.find((row) => row.id === id),
    noteTask: () => ({ noted: true }),
  };
  return {
    rows,
    run: () => handleMissionBlocker({
      mission,
      stopReason: 'repeated-error:runner-failed',
      workspaceRoot: sandbox,
      appendEvent: () => {},
    }, {
      taskDb,
      resolveEngineForRole: () => null,
      httpPost,
      // loadSwarloApiKey deliberately NOT injected: the real resolver runs.
    }),
  };
}

test('a blocked mission posts the escalation as the owner member, not the shared key', () => {
  resetHome();
  writeMemberKey('builder', 'member-builder-key');
  writeSharedKey('zzz.key', 'newest-shared-key', Date.now());
  let seen = null;
  const h = blockerHarness({
    mission: { id: 'm-1', objective: 'ship it', status: 'paused', owner: 'builder' },
    httpPost: (url, opts) => {
      seen = { url, opts };
      return { ok: true, status: 201, body: '{"post_id":"p1"}' };
    },
  });
  const result = h.run();
  assert.equal(result.fleet_posted, true);
  assert.equal(seen.opts.headers.Authorization, 'Bearer member-builder-key');
});

test('a blocked mission owned by a member with no identity does not borrow the shared key', () => {
  resetHome();
  writeSharedKey('zzz.key', 'newest-shared-key', Date.now());
  let called = false;
  const h = blockerHarness({
    mission: { id: 'm-2', objective: 'ship it', status: 'paused', owner: 'ghost' },
    httpPost: () => { called = true; return { ok: true, status: 201, body: '{}' }; },
  });
  const result = h.run();
  assert.equal(result.fleet_posted, false);
  assert.equal(called, false, 'no post without the member’s own identity');
});
