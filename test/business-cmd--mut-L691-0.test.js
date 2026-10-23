'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createCanonicalBusinessWorkspace, onboardBusiness } = require('../commands/business');

test('onboard writes the role given after the role flag into the starter brief', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-mut-role-'));
  const home = path.join(dir, 'home');
  const root = path.join(dir, 'ws');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(root, { recursive: true });

  const origHome = process.env.HOME;
  const origCwd = process.cwd();
  const origLog = console.log;
  const origError = console.error;

  console.log = () => {};
  console.error = () => {};
  process.env.HOME = home;
  process.chdir(root);

  t.after(() => {
    console.log = origLog;
    console.error = origError;
    process.chdir(origCwd);
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  createCanonicalBusinessWorkspace(root, {
    business_id: 'biz-role',
    workspace_id: 'ws-role',
    name: 'Role Co',
    slug: 'role-co',
    owner_email: 'team@role.co',
    workspace_template: 'business',
  }, { here: true });

  await onboardBusiness(
    '--contact', 'Role Person',
    '--role', 'zzzroleprobe',
    '--note', 'seed note'
  );

  const brief = fs.readFileSync(
    path.join(root, 'atris', 'wiki', 'briefs', 'role-co-starter-brief.md'),
    'utf8'
  );
  assert.match(brief, /zzzroleprobe/);
});
