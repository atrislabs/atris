'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { fleetZen } = require('../lib/zen-fleet');

test('archiving a stash names the saved action in the fleet summary', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-stash-summary-'));
  const home = process.env.HOME;
  process.env.HOME = root;
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid',
    GIT_AUTHOR_DATE: '2020-01-02T12:00:00Z',
    GIT_COMMITTER_DATE: '2020-01-02T12:00:00Z',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(root, 'no-config'),
  };
  const git = (...args) => execFileSync('git', args, { cwd: root, env, stdio: 'pipe' });
  try {
    git('init', '-q');
    fs.writeFileSync(path.join(root, 'app.js'), 'original\n');
    git('add', 'app.js');
    git('commit', '-qm', 'initial');
    fs.writeFileSync(path.join(root, 'app.js'), 'unfinished\n');
    git('stash', 'push', '-qm', 'unfinished edit');

    const [result] = fleetZen({ repos: [root], fetch: false });
    assert.match(result.text, /saved 1 old stash away/);
  } finally {
    if (home === undefined) delete process.env.HOME;
    else process.env.HOME = home;
  }
});
