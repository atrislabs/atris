'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { renderVitalsHtml } = require('../lib/improve-vitals-html');

test('renders a successfully collected shipped commit', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vitals-commit-'));
  const previousHome = process.env.HOME;
  process.env.HOME = root;
  t.after(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  });
  const env = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: path.join(root, 'no-config'),
    GIT_AUTHOR_NAME: 'Test Author',
    GIT_AUTHOR_EMAIL: 'author@example.invalid',
    GIT_COMMITTER_NAME: 'Test Author',
    GIT_COMMITTER_EMAIL: 'author@example.invalid',
    GIT_AUTHOR_DATE: '2099-01-15T12:00:00Z',
    GIT_COMMITTER_DATE: '2099-01-15T12:00:00Z',
  };
  const git = (...args) => execFileSync('git', args, { cwd: root, env, stdio: 'pipe' });
  git('init');
  git('-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'delivered orchard search');
  const html = renderVitalsHtml(root, {
    now: '2099-01-15T12:00:00Z',
    collectImproveVitals: () => ({}),
  });
  assert.ok(html.includes('delivered orchard search'));
});
