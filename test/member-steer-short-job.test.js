'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { scrubAgentEnv } = require('./helpers/agent-env');
const cli = path.resolve(__dirname, '../bin/atris.js');

// The real CLI, ledger, worker subprocess, steer command and verifier run.
// The local worker records exactly what it receives instead of calling a model.
function shortJob(t, mode = 'deliver') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-short-note-'));
  if (!process.env.ATRIS_KEEP_STEER_PROOF) t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const team = path.join(root, 'atris/team/architect');
  fs.mkdirSync(team, { recursive: true });
  fs.writeFileSync(path.join(team, 'MEMBER.md'), '---\nname: architect\nrole: Architect\n---\n# Architect\n');
  const worker = path.join(root, 'worker.cjs');
  const check = path.join(root, 'check.cjs');
  fs.writeFileSync(check, `const fs=require('fs'); const rows=fs.readFileSync('prompts.jsonl','utf8').trim().split('\\n').map(JSON.parse); if(!rows.some(p=>p.includes('Notes received before this job finished')&&p.includes('read the late note'))) process.exit(1); console.log('late note read before the check');`);
  fs.writeFileSync(worker, `
const fs = require('fs');
const {spawnSync} = require('child_process');
const prompt = fs.readFileSync(process.argv[2], 'utf8');
fs.appendFileSync('prompts.jsonl', JSON.stringify(prompt)+'\\n');
const n = fs.readFileSync('prompts.jsonl','utf8').trim().split('\\n').length;
function steer(text) {
  const sent = spawnSync(process.execPath, [${JSON.stringify(cli)}, 'member', 'steer', 'architect', text, '--json'], {encoding:'utf8', env:process.env});
  if(sent.status!==0) throw new Error(sent.stderr+sent.stdout);
  fs.appendFileSync('steer-output.jsonl', sent.stdout.trim()+'\\n');
  if(JSON.parse(sent.stdout).mode!=='steered_live') throw new Error('note was not sent to the live job');
}
if(n===1 && ${JSON.stringify(mode)}!=='quiet') steer('read the late note');
if(n===2 && ${JSON.stringify(mode)}==='two') steer('read the second late note');
if(n===2 && ${JSON.stringify(mode)}==='fail') {console.error('delivery failed'); process.exit(1);}
console.log('worker read prompt '+n+'\\nlayer: capabilities');
`);
  const env = {
    ...scrubAgentEnv(), ATRIS_SKIP_UPDATE_CHECK: '1',
    ATRIS_TASKS_DB: path.join(root, '.atris/tasks.db'),
    ATRIS_RUNNER_COMMAND_TEMPLATE: `${process.execPath} ${worker} {promptFile}`,
    ATRIS_MACHINE_ROSTER_PATH: path.join(root, 'roster.json'),
    ATRIS_MACHINE_ROSTER_MD_PATH: path.join(root, 'roster.md'),
    ATRIS_ROSTER_SESSIONS_DIR: path.join(root, 'sessions'),
    ATRIS_PROGRESS_DIR: path.join(root, 'progress'),
  };
  delete env.ATRIS_CLAUDE_COMMAND_TEMPLATE;
  delete env.ATRIS_RUNNER_PROFILE;
  const run = (args) => spawnSync(process.execPath, [cli, ...args], { cwd: root, env, encoding: 'utf8', timeout: 30000 });
  const start = run(['mission', 'start', 'read notes on a short job', '--owner', 'architect', '--runner', 'manual', '--verify', `node ${check}`, '--json']);
  assert.equal(start.status, 0, start.stderr || start.stdout);
  const id = JSON.parse(start.stdout).mission.id;
  const command = ['mission', 'run', id, '--max-ticks', '1', '--max-wall', '30', '--json'];
  if (mode === 'quiet') command.push('--no-verify');
  const result = run(command);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const rows = fs.readFileSync(path.join(root, '.atris/state/missions.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const mission = rows.filter(r => r.id === id).at(-1);
  const prompts = fs.readFileSync(path.join(root, 'prompts.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  if (process.env.ATRIS_KEEP_STEER_PROOF) console.log(JSON.stringify({ root, command: [process.execPath, cli, ...command], exit: result.status, output: result.stdout }));
  return { root, mission, prompts, result };
}

test('a note sent by the real steer command is read before a one-step job is checked', t => {
  const { mission, prompts } = shortJob(t);
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /read the late note/);
  assert.ok(mission.pings[0].consumed_at);
  assert.equal(mission.last_tick_index, 1, 'delivery stays in the same work step');
  assert.equal(mission.verifier_result.passed, true);
  assert.match(mission.verifier_result.stdout, /late note read before the check/);
});

test('notes received during final delivery are also read without replaying an earlier batch', t => {
  const { mission, prompts } = shortJob(t, 'two');
  assert.equal(prompts.length, 3);
  assert.match(prompts[2], /read the second late note/);
  assert.ok(mission.pings.every(p => p.consumed_at));
  assert.equal(mission.verifier_result.passed, true);
});

test('failed final delivery leaves the note unread and the job unproven', t => {
  const { mission, prompts } = shortJob(t, 'fail');
  assert.equal(prompts.length, 2);
  assert.equal(mission.pings[0].consumed_at, undefined);
  assert.notEqual(mission.verifier_result?.passed, true);
  assert.equal(mission.last_tick_status, 'errored');
});

test('a short job with no new notes starts no extra worker', t => {
  const { prompts } = shortJob(t, 'quiet');
  assert.equal(prompts.length, 1);
});
