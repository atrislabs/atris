'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { worktreeBaseRef } = require('../lib/brief-ledger');

function temporaryWorktree(t, sidecar) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brief-base-ref-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, '.atris'));
  fs.writeFileSync(path.join(root, '.atris', 'agent-worktree.json'), JSON.stringify(sidecar));
  return root;
}

// These inputs return before Git is invoked, so no host Git configuration,
// repository discovery, HOME, or environment settings affect the results.
test('worktreeBaseRef prefers sidecar base over checkout_base and fallback', (t) => {
  const root = temporaryWorktree(t, {
    base: 'origin/main',
    checkout_base: 'origin/other',
  });

  assert.strictEqual(worktreeBaseRef(root, 'fallback'), 'origin/main');
  assert.strictEqual(worktreeBaseRef(`  ${root}  `), 'origin/main');
});

test('worktreeBaseRef uses checkout_base when base is empty', (t) => {
  const root = temporaryWorktree(t, { base: '', checkout_base: 'release/stable' });

  assert.strictEqual(worktreeBaseRef(root, 'fallback'), 'release/stable');
});

test('worktreeBaseRef converts a truthy sidecar base to a string', (t) => {
  const root = temporaryWorktree(t, { base: 42, checkout_base: 'ignored' });

  assert.strictEqual(worktreeBaseRef(root), '42');
});

test('worktreeBaseRef returns fallback or empty string for missing input and paths', (t) => {
  const root = temporaryWorktree(t, { base: 'unused' });
  const missing = path.join(root, 'does-not-exist');

  assert.strictEqual(worktreeBaseRef(), '');
  assert.strictEqual(worktreeBaseRef(null, 'fallback'), 'fallback');
  assert.strictEqual(worktreeBaseRef('   ', 'fallback'), 'fallback');
  assert.strictEqual(worktreeBaseRef(missing, 'fallback'), 'fallback');
  assert.strictEqual(worktreeBaseRef(missing), '');
});
