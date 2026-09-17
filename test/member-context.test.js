'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { memberProcessPrompt, MEMBER_PROCESS_PATH, MAX_MEMBER_PROCESS_BYTES } = require('../lib/member-context');
const { buildTickPrompt } = require('../commands/mission');
const { proposalPromptForGoal } = require('../commands/member');

const cliPath = path.resolve(__dirname, '../bin/atris.js');
const mission = { id: 'shared-process', objective: 'Complete the requested artifact', cadence: 'manual', status: 'running' };
const frozen = { lane: 'workspace', verifier: 'node check.js' };

function workspace(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-member-context-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeProcess(dir, body) {
  const file = path.join(dir, MEMBER_PROCESS_PATH);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  return file;
}

function runCli(dir, args, extraEnv = {}) {
  const env = { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1' };
  delete env.ATRIS_RUNNER_PROFILE;
  delete env.ATRIS_RUNNER_COMMAND_TEMPLATE;
  delete env.ATRIS_RUNNER_BIN;
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: dir, encoding: 'utf8', timeout: 20000, env: { ...env, ...extraEnv },
  });
}

test('existing and new members inherit the execution workspace and reload corrections', (t) => {
  const dir = workspace(t);
  writeProcess(dir, 'Use the recorded constraint before recommending the next step.');
  for (const owner of ['navigator', 'new-specialist']) {
    const prompt = buildTickPrompt({ ...mission, owner }, 1, 2, frozen, [
      { at: '2026-09-16', text: 'Only inspect, do not edit.' },
    ], dir);
    assert.match(prompt, /Use the recorded constraint/);
    assert.equal(prompt.split('## Shared member process').length, 2);
    assert.match(prompt, /Only inspect, do not edit\./);
    assert.match(prompt, /\*\*Verifier \(frozen\):\*\* node check\.js/);
    assert.match(prompt, /do not expand role permissions/);
    assert.ok(prompt.indexOf('## Your task') > prompt.indexOf('## Shared member process'));
    assert.ok(prompt.includes(`atris/team/${owner}/MEMBER.md`));
  }
  writeProcess(dir, 'Use the corrected constraint on the next comparable attempt.');
  const next = buildTickPrompt({ ...mission, owner: 'navigator' }, 2, 2, frozen, [], dir);
  assert.match(next, /Use the corrected constraint/);
  assert.doesNotMatch(next, /Use the recorded constraint/);
});

test('absent and blank files preserve compatibility and never inherit a parent workspace', (t) => {
  const parent = workspace(t);
  writeProcess(parent, 'Parent-only private policy.');
  const child = path.join(parent, 'separate-workspace');
  fs.mkdirSync(child);
  assert.equal(memberProcessPrompt(child), '');
  const prompt = buildTickPrompt({ ...mission, owner: 'navigator' }, 1, 1, frozen, [], child);
  assert.doesNotMatch(prompt, /Parent-only|Shared member process/);
  writeProcess(child, ' \n\t');
  assert.equal(memberProcessPrompt(child), '');
});

test('oversized and non-file shared policies fail visibly instead of being truncated or skipped', (t) => {
  const dir = workspace(t);
  const file = writeProcess(dir, 'x'.repeat(MAX_MEMBER_PROCESS_BYTES));
  assert.ok(memberProcessPrompt(dir).includes('x'.repeat(MAX_MEMBER_PROCESS_BYTES)));
  fs.appendFileSync(file, 'x');
  assert.throws(() => memberProcessPrompt(dir), /Cannot load atris\/team\/MEMBER_PROCESS.md: keep/);
  assert.throws(() => proposalPromptForGoal({ title: 'Check the result' }, {}, dir), /Cannot load/);
  fs.unlinkSync(file);
  fs.mkdirSync(file);
  assert.throws(() => memberProcessPrompt(dir), /expected a regular file/);
});

test('wake proposals inherit the same process while keeping the bounded JSON contract', (t) => {
  const dir = workspace(t);
  writeProcess(dir, 'Compare the next result with the previous attempt.');
  const prompt = proposalPromptForGoal({ title: 'Reduce repeat corrections' }, {}, dir);
  assert.match(prompt, /Compare the next result/);
  assert.match(prompt, /return only JSON with keys: title, proof_target, next_step, verifier, stop_rule/);
  assert.match(prompt, /Reduce repeat corrections/);
  assert.ok(prompt.indexOf('You generate the next bounded') > prompt.indexOf('## Shared member process'));
});

test('real member activation names the shared process before the member and retains legacy paths', (t) => {
  const dir = workspace(t);
  const processFile = writeProcess(dir, 'Carry the situation and check the result.');
  const memberDir = path.join(dir, 'atris/team/navigator');
  fs.mkdirSync(memberDir);
  fs.writeFileSync(path.join(memberDir, 'MEMBER.md'), '---\nname: navigator\nrole: Navigator\n---\nRead only.\n');
  let result = runCli(dir, ['member', 'activate', 'navigator']);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Read atris\/team\/MEMBER_PROCESS.md, then atris\/team\/navigator\/MEMBER.md/);
  assert.match(result.stdout, /Stay inside this member's permissions/);
  fs.unlinkSync(processFile);
  fs.writeFileSync(path.join(dir, 'atris/team/legacy.md'), '---\nname: legacy\n---\nRead only.\n');
  result = runCli(dir, ['member', 'activate', 'legacy']);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Read atris\/team\/legacy.md/);
  assert.doesNotMatch(result.stdout, /MEMBER_PROCESS.md/);
});

test('a real CLI retry delivers the shared process and preserves operator direction after a load error', (t) => {
  const dir = workspace(t);
  writeProcess(dir, 'Shared execution marker: use the last correction before acting.');
  const runner = path.join(dir, 'capture-runner.js');
  fs.writeFileSync(runner, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('--output-format --permission-mode --resume --session-id --include-partial-messages');
} else {
  fs.writeFileSync('captured-prompt.txt', args[args.indexOf('-p') + 1]);
  console.log(JSON.stringify({ type: 'result', result: 'Captured the local prompt.\\nlayer: capabilities', is_error: false, num_turns: 1 }));
}
`);
  fs.chmodSync(runner, 0o755);
  const env = { ATRIS_RUNNER_BIN: runner };
  const started = runCli(dir, ['mission', 'start', 'Capture inherited team context', '--owner', 'navigator', '--runner', 'claude', '--no-verify', '--json'], env);
  assert.equal(started.status, 0, started.stderr || started.stdout);
  const id = JSON.parse(started.stdout).mission.id;
  const ping = runCli(dir, ['member', 'ping', 'navigator', 'Only inspect; do not edit or send.', '--json'], env);
  assert.equal(ping.status, 0, ping.stderr || ping.stdout);
  writeProcess(dir, 'x'.repeat(MAX_MEMBER_PROCESS_BYTES + 1));
  const failed = runCli(dir, ['mission', 'run', id, '--max-ticks', '1', '--max-wall', '20', '--no-verify', '--json'], env);
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr + failed.stdout, /Cannot load atris\/team\/MEMBER_PROCESS.md/);
  assert.equal(fs.existsSync(path.join(dir, 'captured-prompt.txt')), false);
  const records = fs.readFileSync(path.join(dir, '.atris/state/missions.jsonl'), 'utf8')
    .trim().split('\n').map((line) => JSON.parse(line)).filter((row) => row.id === id);
  const queued = records.at(-1).pings.find((row) => row.text === 'Only inspect; do not edit or send.');
  assert.ok(queued && !queued.consumed_at, 'a failed policy load must leave the operator instruction unread');
  writeProcess(dir, 'Shared execution marker: use the last correction before acting.');
  const result = runCli(dir, ['mission', 'run', id, '--max-ticks', '1', '--max-wall', '20', '--no-verify', '--json'], env);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const captured = fs.readFileSync(path.join(dir, 'captured-prompt.txt'), 'utf8');
  assert.match(captured, /Shared execution marker: use the last correction before acting\./);
  assert.match(captured, /atris\/team\/navigator\/MEMBER.md/);
  assert.match(captured, /Only inspect; do not edit or send\./);
});
