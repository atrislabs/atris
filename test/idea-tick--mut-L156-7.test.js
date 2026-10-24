'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { runIdeaTick } = require('../lib/idea-tick');
const { addIdea } = require('../lib/idea-inbox');

test('the real built diff refuses destructive added lines in an ordinary file', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'idea-added-lines-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const gitEnv = {
    ...process.env,
    HOME: root,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: path.join(root, 'no-global-config'),
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.invalid',
    GIT_AUTHOR_DATE: '2020-01-01T00:00:00Z',
    GIT_COMMITTER_DATE: '2020-01-01T00:00:00Z',
  };
  function git(...args) {
    const result = spawnSync('git', args, { cwd: root, env: gitEnv, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || String(result.error || ''));
    return result.stdout.trim();
  }
  git('init', '-q');
  fs.writeFileSync(path.join(root, 'search.js'), 'module.exports = "search";\n');
  git('add', 'search.js');
  git('-c', 'commit.gpgsign=false', 'commit', '-qm', 'baseline');
  const target = git('rev-parse', 'HEAD');
  fs.appendFileSync(path.join(root, 'search.js'), 'db.run("DROP TABLE users");\n');
  git('add', 'search.js');
  git('-c', 'commit.gpgsign=false', 'commit', '-qm', 'built change');

  const now = Date.parse('2020-01-02T12:00:00Z');
  const idea = addIdea(root, 'make search faster', { verify: 'node --test', now: new Date(now) });
  let ships = 0;
  const outcome = await runIdeaTick({
    root,
    clock: () => now,
    log: () => {},
    landTarget: () => target,
    runLap: async (_text, options) => options.onResult({
      status: 'done',
      task_id: 'T-7',
      worktree: root,
      result: {
        validator_result: {
          passed: true,
          independent: true,
          engine: 'reviewer',
          executor_engine: 'builder',
        },
      },
    }),
    ship: () => {
      ships += 1;
      return { status: 0, stdout: 'done: worktree shipped\n', stderr: '' };
    },
  });

  assert.deepEqual(outcome, {
    status: 'refused',
    outcome: 'refused',
    stage: 'review',
    idea_id: idea.id,
    reason: 'built and reviewed, but the change touches deleting user data (db.run("DROP TABLE users");), needs owner; it waits in review as T-7',
  });
  assert.equal(ships, 0);
});
