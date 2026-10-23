'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { inboxMapEdits } = require('../lib/member-map-inbox');

test('holds when map inbox commit returns non-sha output', (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'map-inbox-mut-'));
  const previousHome = process.env.HOME;
  const previousPath = process.env.PATH;
  process.env.HOME = base;

  t.after(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    fs.rmSync(base, { recursive: true, force: true });
  });

  const gitEnv = {
    ...process.env,
    HOME: base,
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
  };

  function git(args) {
    const res = spawnSync('git', args, { cwd: base, encoding: 'utf8', env: gitEnv });
    assert.strictEqual(res.status, 0, res.stderr);
    return res.stdout.trim();
  }

  git(['init', '-q', '-b', 'master']);
  fs.mkdirSync(path.join(base, 'atris', 'refs'), { recursive: true });
  fs.writeFileSync(path.join(base, 'atris', 'MAP.md'), 'initial map\n');
  fs.writeFileSync(path.join(base, 'atris', 'refs', 'MAP-NOTES.md'), 'initial notes\n');
  git(['add', '.']);
  git(['commit', '-q', '-m', 'initial']);
  const baseSha = git(['rev-parse', 'HEAD']);

  fs.writeFileSync(path.join(base, 'atris', 'MAP.md'), 'updated map\n');
  git(['add', '.']);
  git(['commit', '-q', '-m', 'update map']);
  const headSha = git(['rev-parse', 'HEAD']);

  const realGit = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
  const bin = path.join(base, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'git'), [
    `#!${process.execPath}`,
    "const { spawnSync } = require('node:child_process');",
    'const args = process.argv.slice(2);',
    "if (args[0] === 'commit-tree') {",
    "  console.log('not-a-sha');",
    '  process.exit(0);',
    '}',
    `const res = spawnSync(${JSON.stringify(realGit)}, args, { stdio: 'inherit' });`,
    'process.exit(res.status === null ? 1 : res.status);',
    '',
  ].join('\n'), { mode: 0o755 });

  process.env.PATH = `${bin}${path.delimiter}${previousPath || ''}`;

  const out = inboxMapEdits({ headSha, baseSha, branch: 'test-branch', cwd: base });
  assert.strictEqual(out.hold, 'the map inbox commit could not be saved');
});
