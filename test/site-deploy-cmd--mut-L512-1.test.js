'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { run } = require('../commands/site-deploy');

test('fullstack publishing replaces old files while preserving the git repository', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'site-deploy-replacement-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  const seed = path.join(root, 'seed');
  const remote = path.join(root, 'remote.git');
  fs.mkdirSync(source);
  fs.mkdirSync(seed);
  const env = {
    PATH: '/usr/bin:/bin',
    HOME: root,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z',
    GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z',
  };
  function git(args, cwd) {
    return spawnSync('/usr/bin/git', args, { cwd, env, encoding: 'utf8' });
  }
  function checkedGit(args, cwd) {
    const result = git(args, cwd);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  }
  checkedGit(['init', '--bare', remote], root);
  checkedGit(['init'], seed);
  checkedGit(['checkout', '-b', 'main'], seed);
  checkedGit(['config', 'user.name', 'Test'], seed);
  checkedGit(['config', 'user.email', 'test@example.invalid'], seed);
  checkedGit(['config', 'commit.gpgsign', 'false'], seed);
  fs.writeFileSync(path.join(seed, 'obsolete.txt'), 'remove this file\n');
  checkedGit(['add', '--all'], seed);
  checkedGit(['commit', '-m', 'initial files'], seed);
  checkedGit(['push', remote, 'main'], seed);

  const packageJson = '{"scripts":{"start":"node server.js"}}\n';
  const server = 'console.log("replacement");\n';
  fs.writeFileSync(path.join(source, 'package.json'), packageJson);
  fs.writeFileSync(path.join(source, 'server.js'), server);
  const errors = [];
  const code = await run([source, '--fullstack', '--name', 'replacement-test', '--yes'], {
    renderApiKey: 'test-render-key',
    loadCredentials: () => ({ token: 'test-token' }),
    log: () => {},
    error: (message) => errors.push(message),
    // Keep all scratch writes inside this test's temporary directory.
    fs: {
      ...fs,
      mkdtempSync: () => fs.mkdtempSync(path.join(root, 'publish-')),
    },
    spawnSync(command, args, options) {
      if (command === 'gh') {
        assert.ok(args[0] === 'auth' || (args[0] === 'repo' && args[1] === 'view'));
        return { status: 0, stdout: '{"visibility":"PRIVATE"}', stderr: '' };
      }
      assert.equal(command, 'git');
      if (args[0] === 'remote' && args[1] === 'add') {
        return git(['remote', 'add', 'origin', remote], options.cwd);
      }
      return git(args, options.cwd);
    },
    // Publishing is complete before Render is contacted. Stop at that boundary.
    httpRequest: async () => { throw new Error('local publishing complete'); },
  });

  assert.equal(code, 1);
  assert.deepEqual(errors, ['  fullstack deploy failed: local publishing complete']);
  assert.equal(checkedGit(['ls-tree', '-r', '--name-only', 'main'], remote),
    'package.json\nserver.js\n');
  assert.equal(checkedGit(['show', 'main:package.json'], remote), packageJson);
  assert.equal(checkedGit(['show', 'main:server.js'], remote), server);
});
