'use strict';

// The pre-commit map pointer note: drives the real script inside a temp git
// repo whose map points into a file the commit changes.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'precommit-map-refs.js');

function git(args, cwd) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr || res.stdout);
  return res.stdout;
}

function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-precommit-map-refs-'));
  git(['init', '-q'], dir);
  git(['config', 'user.email', 't@example.com'], dir);
  git(['config', 'user.name', 't'], dir);
  fs.mkdirSync(path.join(dir, 'lib'));
  fs.mkdirSync(path.join(dir, 'atris'));
  fs.writeFileSync(path.join(dir, 'lib', 'a.js'), "'use strict';\n\nfunction alpha() {}\n\nmodule.exports = { alpha };\n");
  fs.writeFileSync(path.join(dir, 'lib', 'b.js'), "'use strict';\n\nfunction beta() {}\n\nmodule.exports = { beta };\n");
  fs.writeFileSync(path.join(dir, 'atris', 'MAP.md'), [
    '# MAP.md', '',
    '| Task | Primary path | Notes |', '|------|--------------|-------|',
    '| alpha | `lib/a.js:3` `alpha` | first |',
    '| beta | `lib/b.js:3` `beta` | second |', '',
  ].join('\n'));
  git(['add', '-A'], dir);
  git(['commit', '-q', '-m', 'init'], dir);
  return dir;
}

// Bigger than the checker's tolerance for small shifts.
const SHIFT = 60;

const run = cwd => spawnSync(process.execPath, [SCRIPT], { cwd, encoding: 'utf8' });

test('warns about drifted pointers into staged files and exits 0', () => {
  const dir = repo();
  try {
    fs.writeFileSync(path.join(dir, 'lib', 'a.js'), "'use strict';\n\n" + "// new line\n".repeat(SHIFT) + "function alpha() {}\n\nmodule.exports = { alpha };\n");
    fs.writeFileSync(path.join(dir, 'lib', 'b.js'), "'use strict';\n\n" + "// unstaged\n".repeat(SHIFT) + "function beta() {}\n\nmodule.exports = { beta };\n");
    git(['add', 'lib/a.js'], dir);
    const result = run(dir);
    assert.equal(result.status, 0);
    assert.match(result.stderr, /note: 1 map pointer into files you changed drifted \(1 moved, 0 unclear, 0 gone\)/);
    assert.match(result.stderr, new RegExp(`atris/MAP\\.md line 5: lib/a\\.js:3 \\(alpha\\) moved to line ${SHIFT + 3}`));
    assert.doesNotMatch(result.stderr, /lib\/b\.js/);
    assert.match(result.stderr, /atris doc-health --fix-refs/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('stays quiet when staged files have no drifted pointers', () => {
  const dir = repo();
  try {
    fs.writeFileSync(path.join(dir, 'lib', 'a.js'), "'use strict';\n\nfunction alpha() {}\n\nmodule.exports = { alpha };\n// tail\n");
    git(['add', 'lib/a.js'], dir);
    const result = run(dir);
    assert.equal(result.status, 0);
    assert.equal(result.stderr, '');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('stays quiet and exits 0 outside a git repo', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-precommit-map-refs-nogit-'));
  try {
    const result = run(dir);
    assert.equal(result.status, 0);
    assert.equal(result.stderr, '');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
