'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { fleetZen } = require('../lib/zen-fleet');

if (!process.env.PATH) {
  process.env.PATH = '/usr/local/bin:/usr/bin:/bin';
}

test('fleetZen includes workspace actions in the done description', (t) => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-zen-fleet-mut-'));
  const fakeHome = path.join(sandbox, 'home');
  fs.mkdirSync(fakeHome, { recursive: true });

  const savedHome = process.env.HOME;
  process.env.HOME = fakeHome;

  t.after(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  function git(cwd, ...args) {
    const res = spawnSync('git', args, {
      cwd,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'test',
        GIT_AUTHOR_EMAIL: 'test@example.com',
        GIT_COMMITTER_NAME: 'test',
        GIT_COMMITTER_EMAIL: 'test@example.com',
      },
    });
    if (res.error) throw res.error;
    assert.strictEqual(res.status, 0, res.stderr);
    return res.stdout.trim();
  }

  const origin = path.join(sandbox, 'origin.git');
  const seed = path.join(sandbox, 'seed');
  const checkout = path.join(sandbox, 'checkout');

  fs.mkdirSync(seed, { recursive: true });
  git(sandbox, 'init', '-q', '--bare', '--initial-branch=master', origin);
  git(seed, 'init', '-q', '--initial-branch=master');
  git(seed, 'config', 'user.email', 'test@example.com');
  git(seed, 'config', 'user.name', 'test');

  fs.mkdirSync(path.join(seed, 'atris'), { recursive: true });
  fs.writeFileSync(path.join(seed, 'atris', 'TODO.md'), '# Tasks\n\n### Backlog\n(empty)\n');
  fs.writeFileSync(path.join(seed, 'README.md'), 'hello\n');
  git(seed, 'add', '.');
  git(seed, 'commit', '-q', '-m', 'init');
  git(seed, 'remote', 'add', 'origin', origin);
  git(seed, 'push', '-q', '-u', 'origin', 'master');

  git(sandbox, 'clone', '-q', origin, checkout);
  git(checkout, 'config', 'user.email', 'test@example.com');
  git(checkout, 'config', 'user.name', 'test');

  const [result] = fleetZen({ repos: [checkout], fetch: false });

  assert.strictEqual(result.state, 'zen');
  assert.strictEqual(result.text, 'cleared 1 empty task section');
});
