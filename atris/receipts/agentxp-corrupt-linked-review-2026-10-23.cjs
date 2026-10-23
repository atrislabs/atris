'use strict';
// Read-only review of the implementation using disposable real repositories.
// Run: node atris/receipts/agentxp-corrupt-linked-review-2026-10-23.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const repo = path.resolve(__dirname, '../..');
const { scrubAgentEnv } = require(path.join(repo, 'test/helpers/agent-env'));
const acceptedReview = require(path.join(repo, 'test/fixtures/xp/accepted-review.json'));
function git(cwd, ...args) {
  const result = cp.spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}
function reviewEpisode(id, workspace) {
  return {
    schema: 'atris.task_episode.v1', episode_id: id, task_id: id,
    workspace_root: workspace, created_at: new Date().toISOString(),
    state: { status: 'done', title: acceptedReview.title, claimed_by: acceptedReview.claimed_by, metadata: acceptedReview.metadata },
    action: { event_type: 'reviewed', actor: acceptedReview.actor },
    reward: { value: acceptedReview.reward }, proof: acceptedReview.proof,
    career_xp: { eligible: true, reward: acceptedReview.reward }, rl: { label: 'accepted' },
  };
}

for (const kind of ['receipts', 'episodes']) {
    const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'atris-xp-corrupt-'));
    const main = path.join(base, 'main');
    const good = path.join(base, 'good');
    const bad = path.join(base, 'bad');
    const scratch = path.join(base, 'scratch');
    const cli = path.join(repo, 'bin', 'atris.js');
    const env = { ...scrubAgentEnv(), HOME: path.join(base, 'home'), ATRIS_SKIP_UPDATE_CHECK: '1' };
    const state = root => path.join(root, '.atris', 'state');
    const run = cwd => cp.spawnSync(process.execPath, [cli, 'xp', '--local', '--json'], {
      cwd, env, encoding: 'utf8', timeout: 30000,
    });
    const seed = (root, id) => {
      fs.mkdirSync(state(root), { recursive: true });
      fs.writeFileSync(path.join(state(root), 'task_episodes.jsonl'), JSON.stringify(reviewEpisode(id, root)) + '\n');
      const result = run(root);
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.equal(JSON.parse(result.stdout).agent_xp, 1);
      return fs.readFileSync(path.join(state(root), 'career_xp_receipts.jsonl'), 'utf8');
    };
    try {
      fs.mkdirSync(main);
      git(main, 'init', '-b', 'main');
      git(main, '-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-m', 'initial');
      seed(main, 'main-review');
      const goodReceipt = seed(scratch, 'good-review');
      fs.rmSync(scratch, { recursive: true });
      const badReceipt = seed(scratch, 'bad-review');
      fs.rmSync(scratch, { recursive: true });
      git(main, 'worktree', 'add', '-b', 'good', good);
      git(main, 'worktree', 'add', '-b', 'bad', bad);
      fs.mkdirSync(state(good), { recursive: true });
      fs.mkdirSync(state(bad), { recursive: true });
      fs.writeFileSync(path.join(state(good), 'career_xp_receipts.jsonl'), goodReceipt);
      const badFile = path.join(state(bad), kind === 'receipts' ? 'career_xp_receipts.jsonl' : 'task_episodes.jsonl');
      const valid = kind === 'receipts' ? badReceipt : JSON.stringify(reviewEpisode('bad-review', bad)) + '\n';
      const corrupt = valid + '{broken json}\n' + valid;
      fs.writeFileSync(badFile, corrupt);
      for (const args of [
        ['status', '--all', '--root', base, '--workspace', main, '--workspace', good, '--workspace', bad, '--json'],
        ['--local', '--workspace', main, '--json'],
      ]) {
        const result = cp.spawnSync(process.execPath, [cli, 'xp', ...args], {
          cwd: main, env, encoding: 'utf8', timeout: 30000,
        });
        console.log(`command: node bin/atris.js xp ${args.join(' ')}`);
        console.log(`exit: ${result.status}`);
        const payload = JSON.parse(result.stdout);
        console.log(`stdout excerpt: ${JSON.stringify({ agent_xp: payload.agent_xp, integrity: payload.integrity.status, workspace_count: payload.workspace_count })}`);
        console.log(`stderr: ${result.stderr.trim()}`);
        assert.equal(result.status, 0, result.stderr || result.stdout);
        assert.equal(payload.agent_xp, 2);
        assert.equal(payload.integrity.status, 'verified');
        const warnings = result.stderr.trim().split('\n');
        assert.equal(warnings.length, 1, 'one warning per bad file across all selected folders');
        assert.equal(warnings[0], `warning: skipped unreadable linked xp file at ${badFile}`);
        if (args[0] === 'status') assert.equal(payload.workspaces.length, 1);
        assert.equal(fs.readFileSync(badFile, 'utf8'), corrupt);
      }
      console.log(`passed: corrupt linked ${kind}; balance 2; one warning per command; source unchanged`);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
}
