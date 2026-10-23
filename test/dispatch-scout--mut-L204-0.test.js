'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { buildVerifiedScoutPack, SCOUT_PACK_SCHEMA } = require('../lib/dispatch-scout');

test('extracts and verifies a scout JSON object surrounded by prose', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-scout-json-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: path.join(root, 'no-global-config'),
      GIT_AUTHOR_NAME: 'Scout Test',
      GIT_AUTHOR_EMAIL: 'scout@example.invalid',
      GIT_COMMITTER_NAME: 'Scout Test',
      GIT_COMMITTER_EMAIL: 'scout@example.invalid',
      GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z',
      GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();

  fs.writeFileSync(path.join(root, 'widget.js'), 'function widget() { return 1; }\n');
  fs.writeFileSync(path.join(root, 'widget-helper.js'), 'function widgetHelper() { return 2; }\n');
  git('init', '--quiet');
  git('add', 'widget.js', 'widget-helper.js');
  git('-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'fixture');
  const commit = git('rev-parse', 'HEAD');
  const task = { id: 'scout-json', title: 'Improve widget behavior' };
  const expected = {
    schema: SCOUT_PACK_SCHEMA,
    task_id: task.id,
    checkout_commit: commit,
    hits: [
      { path: 'widget.js', line: 1, excerpt: 'function widget() { return 1; }', why: 'Defines the widget.' },
      { path: 'widget-helper.js', line: 1, excerpt: 'function widgetHelper() { return 2; }', why: 'Defines the widget helper.' },
    ],
    map_gotchas: [],
    not_checked: ['Widget integration'],
  };

  const actual = await buildVerifiedScoutPack({
    task,
    worktreePath: root,
    ask: async () => ({
      ok: true,
      stdout: `Here are the starting points:\n${JSON.stringify(expected)}\nEnd of report.`,
    }),
  });
  assert.deepStrictEqual(actual, expected);
});
