'use strict';

// Footgun (a), xp writer: the single-workspace `--workspace` default was raw
// process.cwd(), so `xp --local` from a subdir read the wrong task_episodes and
// split the career-XP projection into a nested .atris. The default must resolve
// the shared workspace root; explicit --workspace and the multi-root roster
// (discoverCareerXpWorkspaces) stay as-is.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'commands', 'xp.js'), 'utf8');

test('single-workspace default resolves the workspace root, not raw cwd', () => {
  // Both single-workspace sites use the resolving default...
  const resolved = SRC.match(/readFlag\(args, '--workspace', defaultXpWorkspace\(\)\)/g) || [];
  assert.equal(resolved.length, 2, 'both single-workspace sites use defaultXpWorkspace()');
  // ...and neither still binds the raw-cwd default.
  assert.doesNotMatch(SRC, /readFlag\(args, '--workspace', process\.cwd\(\)\)/);
  // The multi-root search path still seeds from cwd (unchanged).
  assert.match(SRC, /roots\.push\(process\.cwd\(\)\)/);
});

test('a spine root above a subdir pulls xp state up; a standalone .atris stays put', () => {
  const { resolveWorkspaceRoot } = require('../lib/mission-root');
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'atris-xp-root-'));
  try {
    // Case 1: subdir under a framework-spine root -> resolves UP to the root.
    const spineRoot = path.join(base, 'repo');
    const sub = path.join(spineRoot, 'backend');
    fs.mkdirSync(path.join(spineRoot, 'atris'), { recursive: true });
    fs.writeFileSync(path.join(spineRoot, 'atris', 'atris.md'), '# spine');
    fs.mkdirSync(sub, { recursive: true });
    assert.equal(fs.realpathSync(resolveWorkspaceRoot(sub)), fs.realpathSync(spineRoot));

    // Case 2: a standalone workspace with its own .atris and no spine/git above
    // -> stays local (mirrors the alpha/beta fixtures in xp.test.js).
    const alone = path.join(base, 'alone');
    fs.mkdirSync(path.join(alone, '.atris', 'state'), { recursive: true });
    assert.equal(fs.realpathSync(resolveWorkspaceRoot(alone)), fs.realpathSync(alone));
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
