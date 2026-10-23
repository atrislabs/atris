const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tidyMemberCopies } = require('../lib/member-tidy');

test('tidy rejects a revision command that prints a hash but exits unsuccessfully', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'tidy-revision-error-'));
  const originalHome = process.env.HOME;
  const originalPath = process.env.PATH;
  const gitPath = spawnSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
  process.env.HOME = base;
  try {
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com',
      GIT_AUTHOR_DATE: '2024-01-01T12:00:00Z',
      GIT_COMMITTER_DATE: '2024-01-01T12:00:00Z',
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(base, 'no-config'),
    };
    function git(args, cwd = base) {
      const result = spawnSync(gitPath, args, { cwd, env, encoding: 'utf8' });
      if (result.status !== 0) throw new Error(result.stderr);
    }
    const remote = path.join(base, 'remote');
    const repo = path.join(base, 'repo');
    git(['init', '--bare', '-b', 'main', remote]);
    git(['clone', remote, repo]);
    git(['commit', '--allow-empty', '-m', 'initial'], repo);
    git(['push', 'origin', 'main'], repo);
    const copies = path.join(base, 'copies');
    fs.mkdirSync(copies);
    const bin = path.join(base, 'bin');
    fs.mkdirSync(bin);
    const quotedGit = "'" + gitPath.replace(/'/g, "'\\''") + "'";
    // Model a git launcher reporting failure after the revision was printed.
    fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh\n${quotedGit} "$@"\nstatus=$?\nif [ "$1" = rev-parse ] && [ "$status" = 0 ]; then\n  echo 'revision launcher failed after output' >&2\n  exit 1\nfi\nexit "$status"\n`, { mode: 0o755 });
    const scan = path.join(bin, 'scan');
    fs.writeFileSync(scan, '#!/bin/sh\necho "scan unavailable" >&2\nexit 1\n', { mode: 0o755 });
    process.env.PATH = bin + path.delimiter + (originalPath || '/usr/bin:/bin');
    const result = tidyMemberCopies({ repoRoot: repo, worktreesDir: copies, now: 1704110400000, lsofBin: scan });
    assert.match(result.aborted, /fetched main branch/);
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
  }
});
