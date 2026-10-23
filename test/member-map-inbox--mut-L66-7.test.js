const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { inboxMapEdits } = require('../lib/member-map-inbox');

test('git diagnostic output cannot be used as a saved object identifier', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'map-object-format-'));
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: {
      ...process.env, HOME: cwd,
      GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com',
      GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z',
    } });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  };
  try {
    git('init', '-b', 'master');
    fs.mkdirSync(path.join(cwd, 'atris'));
    fs.writeFileSync(path.join(cwd, 'atris/MAP.md'), '# map\n');
    git('add', '.');
    git('commit', '-m', 'base');
    const baseSha = git('rev-parse', 'HEAD');
    fs.appendFileSync(path.join(cwd, 'atris/MAP.md'), 'new route\n');
    git('add', '.');
    git('commit', '-m', 'map edit');
    const headSha = git('rev-parse', 'HEAD');
    const realGit = spawnSync('/bin/sh', ['-c', 'command -v git'], {
      encoding: 'utf8', env: { PATH: process.env.PATH || '/usr/bin:/bin' },
    }).stdout.trim();
    const bin = path.join(cwd, 'bin');
    fs.mkdirSync(bin);
    // A tracing launcher keeps Git's diagnostics with its object-write output.
    fs.writeFileSync(path.join(bin, 'git'), [
      '#!/bin/sh',
      'if [ "$1" = "hash-object" ]; then',
      `  GIT_TRACE=1 exec "${realGit}" "$@" 2>&1`,
      'fi',
      `exec "${realGit}" "$@"`,
      '',
    ].join('\n'), { mode: 0o755 });
    const savedPath = process.env.PATH;
    const savedHome = process.env.HOME;
    let result;
    try {
      process.env.PATH = bin + path.delimiter + (savedPath || '/usr/bin:/bin');
      process.env.HOME = cwd;
      result = inboxMapEdits({ cwd, baseSha, headSha, branch: 'member/edit' });
    } finally {
      if (savedPath === undefined) delete process.env.PATH;
      else process.env.PATH = savedPath;
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
    }
    assert.match(result.hold, /could not be saved/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
