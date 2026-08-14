'use strict';

// Regression: the fleet writes .atris/fleet-prompt-<TASK>.md into an agent worktree
// before the engine runs. The worktree guard used to count that file as dirt and
// block the engine with the harness's own plumbing ("blocked: checkout is dirty
// untracked=1"). The engine then did nothing while the flight still reported
// "landed" — green receipts over zero code. Guard must ignore conductor artifacts
// and still block genuine dirt.

const { test } = require('node:test');
const assert = require('node:assert');
const {
  isConductorArtifact,
  isConductorStatusLine,
} = require('../lib/conductor-artifacts');

test('conductor plumbing does not count as dirt', () => {
  assert.equal(isConductorArtifact('.atris/fleet-prompt-BCK-1326.md'), true);
  assert.equal(isConductorArtifact('.atris/codex-watchdog-CLI-1269-a1b2c3d4.json'), true);
  assert.equal(isConductorArtifact('.atris/agent-worktree.json'), true);
  assert.equal(isConductorArtifact('.atris/runtime-tmp/scratch/out.txt'), true);
  assert.equal(isConductorArtifact('.atris/state/briefs.jsonl'), true);
});

test('real work still counts as dirt', () => {
  assert.equal(isConductorArtifact('backend/routers/atris2_router.py'), false);
  assert.equal(isConductorArtifact('.atris/salvage/reap.bundle'), false);
  // the prompt glob must not reach across a directory boundary
  assert.equal(isConductorArtifact('.atris/fleet-prompt-a/b.md'), false);
});

test('porcelain status lines are classified by untracked marker', () => {
  assert.equal(isConductorStatusLine('?? .atris/fleet-prompt-BCK-1338.md'), true);
  assert.equal(isConductorStatusLine('?? backend/new_file.py'), false);
  // a tracked-and-modified conductor path is a real change, not plumbing
  assert.equal(isConductorStatusLine(' M .atris/agent-worktree.json'), false);
});

test('a prompt-only worktree reads as no change, so the flight cannot land it', () => {
  // The fabrication path: the fleet writes its prompt into the worktree, the change
  // inspector counts it as dirt, has_change goes true, the no_change pause never
  // fires, and the flight commits the prompt file and reports "landed" for an engine
  // that said "nothing to commit".
  const promptOnly = ['?? .atris/fleet-prompt-BCK-9999.md'];
  assert.equal(promptOnly.filter((l) => !isConductorStatusLine(l)).length, 0);

  const realWork = ['?? .atris/fleet-prompt-BCK-9999.md', '?? backend/new_module.py'];
  assert.equal(realWork.filter((l) => !isConductorStatusLine(l)).length, 1);
});

test('the guard and the sealed-review import read one shared list', () => {
  // Drift between these two call sites is what caused the original incident:
  // lib/fleet.js knew fleet-prompt files were plumbing, commands/worktree.js did not.
  const worktreeSrc = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'commands', 'worktree.js'), 'utf8');
  const fleetSrc = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'lib', 'fleet.js'), 'utf8');
  assert.match(worktreeSrc, /require\('\.\.\/lib\/conductor-artifacts'\)/);
  assert.match(fleetSrc, /require\('\.\/conductor-artifacts'\)/);
  // neither file may carry its own private copy of the pattern
  assert.doesNotMatch(worktreeSrc, /fleet-prompt-\[\^/);
  assert.doesNotMatch(fleetSrc, /fleet-prompt-\[\^/);
});
