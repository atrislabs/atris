'use strict';

// Member agents record proof checks inside their temporary copies
// (<arena>/.agent-worktrees/<project>/<name>). The landing pass must rerun
// those checks from the main checkout, and say in plain words when the file
// a check runs only exists on the agent's branch.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { rewriteWorktreeVerify } = require('../lib/verify-worktree-rewrite');
const { evaluateAutoAccept } = require('../lib/auto-accept-certified');
const { plainLandingReason } = require('../lib/voice-gate');

function arenaWithProject() {
  const arena = path.join(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atris-rewrite-'))), 'arena');
  const root = path.join(arena, 'demo-project');
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(root, 'scripts', 'test-ok.mjs'), 'process.exit(0);\n');
  fs.writeFileSync(path.join(root, 'scripts', 'test-red.mjs'), 'process.exit(1);\n');
  return { arena, root, copy: path.join(arena, '.agent-worktrees', 'demo-project', 'builder-operate') };
}

test('worktree checks are rewritten to run from the main checkout', () => {
  const { arena, root, copy } = arenaWithProject();
  const cases = [
    [`cd ${copy} && node scripts/test-ok.mjs`, 'node scripts/test-ok.mjs'],
    [`(cd ${copy} && node scripts/test-ok.mjs)`, 'node scripts/test-ok.mjs'],
    [`cd '${copy}/sub/dir' && npm test`, 'cd sub/dir && npm test'],
    [`node ${copy}/scripts/test-ok.mjs`, 'node scripts/test-ok.mjs'],
    [`npm --prefix '${copy}' run security:audit`, 'npm run security:audit'],
    [`node '${copy}/scripts/a.mjs' '${copy}'`, 'node scripts/a.mjs .'],
    [`node ${arena}/agent-work-trees/demo-project/old-copy/scripts/test-ok.mjs`, 'node scripts/test-ok.mjs'],
    [`cd ${root} && node scripts/test-ok.mjs`, 'node scripts/test-ok.mjs'],
  ];
  for (const [input, expected] of cases) {
    const result = rewriteWorktreeVerify(input, root);
    assert.equal(result.rewritten, true, input);
    assert.equal(result.command, expected, input);
  }
});

test('checks that never named a copy, or name another project, are left alone', () => {
  const { arena, root } = arenaWithProject();
  assert.deepEqual(rewriteWorktreeVerify('npm test', root), { command: 'npm test', rewritten: false, from: null });
  const other = `node ${arena}/.agent-worktrees/other-project/x/scripts/t.mjs`;
  assert.equal(rewriteWorktreeVerify(other, root).rewritten, false);
  // A sibling folder that merely starts with the project name is not the project.
  const sibling = `node ${root}-fork/scripts/t.mjs`;
  assert.equal(rewriteWorktreeVerify(sibling, root).rewritten, false);
});

function reviewTask(root, verify) {
  return {
    id: 'wt-1',
    display_id: 'OBL-WT',
    status: 'review',
    tag: 'self-improve',
    workspace_root: root,
    metadata: { approval_status: 'pending', verify, built_by: 'builder', latest_agent_proof: `\`${verify}\` passed (exit 0)` },
    review: { approval_status: 'pending', proof: `\`${verify}\` passed (exit 0)` },
    events: [{ event_type: 'proof_ready', actor: 'builder' }, { event_type: 'reviewed', actor: 'land-keeper' }],
  };
}

test('the landing pass reruns a worktree check from main instead of refusing it', () => {
  const { root, copy } = arenaWithProject();
  const task = reviewTask(root, `cd ${copy} && node scripts/test-ok.mjs`);
  const status = evaluateAutoAccept(task, { acceptAll: true, executeVerify: false });
  assert.notEqual(status.reason, 'verify_command_not_allowed');
  assert.equal(status.eligible, true);

  const ran = evaluateAutoAccept(task, { acceptAll: true, strictVerify: true, executeVerify: true });
  assert.notEqual(ran.reason, 'verify_command_not_allowed');
  assert.notEqual(ran.reason, 'verify_workdir_missing');
});

test('a worktree check that fails from main says the work is likely still on the agent branch', () => {
  const { root, copy } = arenaWithProject();
  const result = evaluateAutoAccept(reviewTask(root, `cd ${copy} && node scripts/test-red.mjs`), { acceptAll: true, executeVerify: true });
  assert.equal(result.eligible, false);
  assert.equal(result.reason, 'verify_failed_on_main');
  assert.match(plainLandingReason(result.reason), /agent branch/);
});

test('a check whose file only exists on the agent branch is refused in plain words, not silently', () => {
  const { root, copy } = arenaWithProject();
  const result = evaluateAutoAccept(reviewTask(root, `node ${copy}/scripts/test-only-on-branch.mjs`), { acceptAll: true, executeVerify: false });
  assert.equal(result.eligible, false);
  assert.equal(result.reason, 'verify_only_on_agent_branch');
  assert.equal(result.missing_path, path.join('scripts', 'test-only-on-branch.mjs'));
  assert.match(plainLandingReason(result.reason), /only exists on the agent branch/);
});
