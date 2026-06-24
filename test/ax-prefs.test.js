const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const prefs = require('../lib/ax-prefs');

test('ax prefs default to safe mode with member slug ax', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ax-prefs-'));
  const oldHome = process.env.HOME;
  process.env.HOME = root;
  try {
    const loaded = prefs.loadAxPrefs();
    assert.equal(loaded.member_slug, 'ax');
    assert.equal(loaded.bypass_permissions, false);
    assert.equal(prefs.resolveBypassPermissions({}), false);
  } finally {
    process.env.HOME = oldHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('ax prefs persist bypass toggle', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ax-prefs-save-'));
  const oldHome = process.env.HOME;
  process.env.HOME = root;
  try {
    prefs.setBypassPermissions(true);
    assert.equal(prefs.loadAxPrefs().bypass_permissions, true);
    prefs.setBypassPermissions(false);
    assert.equal(prefs.loadAxPrefs().bypass_permissions, false);
  } finally {
    process.env.HOME = oldHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('ax env and flag overrides beat saved prefs', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ax-prefs-env-'));
  const oldHome = process.env.HOME;
  const oldBypass = process.env.AX_BYPASS_PERMISSIONS;
  process.env.HOME = root;
  try {
    prefs.setBypassPermissions(false);
    process.env.AX_BYPASS_PERMISSIONS = '1';
    assert.equal(prefs.resolveBypassPermissions({}), true);
    assert.equal(prefs.resolveBypassPermissions({ bypassPermissions: false }), false);
  } finally {
    process.env.HOME = oldHome;
    if (oldBypass === undefined) delete process.env.AX_BYPASS_PERMISSIONS;
    else process.env.AX_BYPASS_PERMISSIONS = oldBypass;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
