'use strict';

// Evidence-only stress probe. A successful audit can report a runtime failure.
// This does not certify the fix or write into the operator's actual ledger.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const assert = require('node:assert/strict');
const { scrubAgentEnv } = require('../../test/helpers/agent-env');
const accepted = require('../../test/fixtures/xp/accepted-review.json');
const cli = path.resolve(__dirname, '../../bin/atris.js');

async function main() {
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'atris-xp-race-audit-'));
  const results = [];
  const count = 300;
  try {
    for (let round = 0; round < 5; round++) {
      const workspace = path.join(base, `round-${round}`);
      const state = path.join(workspace, '.atris/state');
      fs.mkdirSync(state, { recursive: true });
      const env = {
        ...scrubAgentEnv(), HOME: path.join(base, 'home'),
        ATRIS_HOME: path.join(base, 'home/.atris'),
        ATRIS_TASKS_DB: path.join(base, 'tasks.db'), ATRIS_SKIP_UPDATE_CHECK: '1',
      };
      const episodes = Array.from({ length: count }, (_, index) => ({
        schema: 'atris.task_episode.v1', episode_id: `race-${round}-${index}`,
        task_id: `isolated-fixture-copy-${index}`, workspace_root: workspace,
        created_at: new Date().toISOString(),
        state: { status: 'done', title: accepted.title, claimed_by: accepted.claimed_by, metadata: accepted.metadata },
        action: { event_type: 'reviewed', actor: accepted.actor },
        reward: { value: accepted.reward }, proof: accepted.proof,
        career_xp: { eligible: true, reward: accepted.reward }, rl: { label: 'accepted' },
      }));
      fs.writeFileSync(path.join(state, 'task_episodes.jsonl'), episodes.map(JSON.stringify).join('\n') + '\n');
      const args = [cli, 'xp', 'status', '--local', '--workspace', workspace, '--json'];
      const run = () => new Promise((resolve, reject) => {
        const child = cp.spawn(process.execPath, args, { cwd: workspace, env, timeout: 30000 });
        let stdout = '', stderr = '';
        child.stdout.on('data', chunk => { stdout += chunk; });
        child.stderr.on('data', chunk => { stderr += chunk; });
        child.on('error', reject);
        child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
      });
      const concurrent = await Promise.all([run(), run()]);
      const final = await run();
      const summarize = result => {
        assert.equal(result.signal, null, 'a timeout is not a ledger observation');
        let payload;
        try { payload = JSON.parse(result.stdout); } catch {
          return { exit: result.code, unparseable_output: result.stdout.slice(0, 1000), stderr: result.stderr.slice(0, 1000) };
        }
        return {
          exit: result.code, agent_xp: payload.agent_xp,
          integrity_status: payload.integrity_status || payload.integrity?.status,
          errors: (payload.integrity?.errors || []).slice(0, 5),
          output_excerpt: result.stdout.slice(0, 500),
        };
      };
      const rows = fs.readFileSync(path.join(state, 'career_xp_receipts.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
      const observed = summarize(final);
      results.push({
        round, expected_xp: count, concurrent: concurrent.map(summarize), final: observed,
        raw_receipts: rows.length, unique_receipts: new Set(rows.map(row => row.receipt_id)).size,
        invariant_passed: observed.exit === 0 && observed.agent_xp === count && observed.integrity_status === 'verified',
      });
    }
    const report = {
      command: 'node atris/receipts/agentxp-concurrency-audit-2026-10-22.cjs',
      observed_at: new Date().toISOString(), node: process.version,
      cli_command: 'node bin/atris.js xp status --local --workspace <isolated-folder> --json',
      source: accepted.source, fixture_copies_per_round: count,
      setup: 'Five isolated ledgers, two concurrent actual CLI processes, then one actual CLI read. No runtime instrumentation or live awards.',
      failed_rounds: results.filter(row => !row.invariant_passed).length,
      rounds: results,
    };
    fs.writeFileSync(path.join(__dirname, 'agentxp-concurrency-audit-2026-10-22.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ rounds: results.length, failed_rounds: report.failed_rounds, final: results.map(row => ({ round: row.round, xp: row.final.agent_xp, integrity: row.final.integrity_status, receipts: row.raw_receipts })) }, null, 2));
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
