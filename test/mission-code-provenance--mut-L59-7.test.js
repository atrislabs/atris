'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { captureCodeBaseline } = require('../lib/mission-code-provenance');

test('git status entries must separate status code and path with a space', (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-status-check-'));
  const repo = path.join(tempDir, 'repo');
  const bin = path.join(tempDir, 'bin');
  fs.mkdirSync(repo);
  fs.mkdirSync(bin);

  const realGit = ['/opt/homebrew/bin/git', '/usr/local/bin/git', '/usr/bin/git', '/bin/git'].find((p) => fs.existsSync(p));
  const wrapper = path.join(bin, 'git');
  const script = `#!/bin/sh
for arg in "$@"; do
  if [ "$arg" = "status" ]; then
    printf "abcd\\0"
    exit 0
  fi
done
exec "${realGit}" "$@"
`;
  fs.writeFileSync(wrapper, script, { mode: 0o755 });

  spawnSync(realGit, ['init', '-q'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'file.txt'), 'content');
  spawnSync(realGit, ['add', '.'], { cwd: repo });
  spawnSync(realGit, ['commit', '-m', 'init'], {
    cwd: repo,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'A',
      GIT_AUTHOR_EMAIL: 'a@example.com',
      GIT_COMMITTER_NAME: 'A',
      GIT_COMMITTER_EMAIL: 'a@example.com',
    },
  });

  const oldPath = process.env.PATH;
  const oldHome = process.env.HOME;
  process.env.HOME = tempDir;
  process.env.PATH = bin + (oldPath ? ':' + oldPath : ':/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin');

  t.after(() => {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const result = captureCodeBaseline(repo);
  assert.strictEqual(result.reason, 'git_status_unreadable');
});
