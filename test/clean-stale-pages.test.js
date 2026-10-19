'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const cliPath = path.join(__dirname, '..', 'bin', 'atris.js');

function git(cwd, ...args) {
  const env = { ...process.env, GIT_AUTHOR_DATE: '1999-06-01T00:00:00Z', GIT_COMMITTER_DATE: '1999-06-01T00:00:00Z' };
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env });
  assert.equal(result.status, 0, result.stderr);
}

function stalePages(cwd) {
  const result = spawnSync(process.execPath, [cliPath, 'clean', '--dry-run', '--json'], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1' },
  });
  const text = result.stdout;
  return JSON.parse(text.slice(text.indexOf('{'))).results.stale_pages.items.map((p) => p.stale_source);
}

test('a source only touched on disk does not make its wiki page stale', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atris-stale-')));
  try {
    git(dir, 'init', '-q');
    git(dir, 'config', 'user.email', 'test@example.com');
    git(dir, 'config', 'user.name', 'test');
    fs.mkdirSync(path.join(dir, 'atris', 'wiki'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'atris', 'source.md'), 'fact\n');
    fs.writeFileSync(
      path.join(dir, 'atris', 'wiki', 'page.md'),
      '---\nsources:\n  - atris/source.md\nlast_compiled: 2000-01-01\n---\n\n# Page\n',
    );
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'seed');

    // The file on disk is newer than the page, but its content was committed
    // in 1999, before the page was compiled in 2000.
    assert.deepEqual(stalePages(dir), []);

    // A real edit counts.
    fs.writeFileSync(path.join(dir, 'atris', 'source.md'), 'new fact\n');
    assert.deepEqual(stalePages(dir), ['atris/source.md']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
