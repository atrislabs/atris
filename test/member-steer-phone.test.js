'use strict';

// The phone's steer, through the real CLI: --no-ignite only reaches a live
// run and never starts a member; words after -- are the owner's, never
// options; --detach starts a member in the background and returns at once.
// The local worker records what it receives instead of calling a model.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { scrubAgentEnv } = require('./helpers/agent-env');
const cli = path.resolve(__dirname, '../bin/atris.js');

function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-steer-phone-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'atris/team/builder'), { recursive: true });
  fs.writeFileSync(path.join(root, 'atris/team/builder/MEMBER.md'), '---\nname: builder\nrole: Builder\n---\n# Builder\n');
  const worker = path.join(root, 'worker.cjs');
  fs.writeFileSync(worker, "const fs=require('fs'); fs.appendFileSync('ran.jsonl', JSON.stringify(fs.readFileSync(process.argv[2],'utf8'))+'\\n'); console.log('worker ran\\nlayer: capabilities');\n");
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
  const run = args => spawnSync(process.execPath, [cli, ...args], { cwd: root, env, encoding: 'utf8', timeout: 30000 });
  return { root, run };
}

test('steer --no-ignite: with nothing running it starts nothing, changes nothing, and says so', (t) => {
  const { root, run } = workspace(t);
  const out = run(['member', 'steer', 'builder', '--no-ignite', '--json', '--', 'do the readme first']);
  assert.equal(out.status, 3, out.stderr || out.stdout);
  const payload = JSON.parse(out.stdout.slice(out.stdout.indexOf('{')));
  assert.deepEqual([payload.ok, payload.action, payload.member], [false, 'member_not_running', 'builder']);
  assert.equal(fs.existsSync(path.join(root, 'ran.jsonl')), false, 'no worker ran');
  assert.equal(fs.existsSync(path.join(root, '.atris/state/missions.jsonl')), false, 'no mission was started');
});

test('steer: words after -- are the owner words, never options, even when they start with a dash', (t) => {
  const { run } = workspace(t);
  const out = run(['member', 'steer', 'builder', '--dry-run', '--json', '--', '--verify=printf example']);
  assert.equal(out.status, 0, out.stderr || out.stdout);
  const payload = JSON.parse(out.stdout.slice(out.stdout.indexOf('{')));
  assert.equal(payload.prompt, '--verify=printf example');
  // the next command carries it as the prompt, with no --verify option of its own
  assert.doesNotMatch(payload.command.replace(JSON.stringify(payload.prompt), ''), /--verify/);
});

test('steer --detach: starts the member in the background and returns at once with its pid', (t) => {
  const { root, run } = workspace(t);
  const started = Date.now();
  const out = run(['member', 'steer', 'builder', '--detach', '--json', '--', 'the owner says: write the readme first']);
  assert.equal(out.status, 0, out.stderr || out.stdout);
  assert.ok(Date.now() - started < 15000);
  const payload = JSON.parse(out.stdout.slice(out.stdout.indexOf('{')));
  assert.deepEqual([payload.ok, payload.action, payload.member], [true, 'member_run_detached', 'builder']);
  assert.ok(Number.isInteger(payload.pid) && payload.pid > 0);
  const alive = () => { try { process.kill(payload.pid, 0); return true; } catch { return false; } };
  try {
    // the background run gets the words as its prompt
    const file = path.join(root, 'ran.jsonl');
    const until = Date.now() + 20000;
    while (!fs.existsSync(file) && Date.now() < until) spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},200)']);
    assert.ok(fs.existsSync(file), 'the background run started');
    assert.match(fs.readFileSync(file, 'utf8'), /write the readme first/);
  } finally {
    // the run still writes its files as it ends; deleting the folder under it
    // failed with ENOTEMPTY on a slow runner, so it finishes first
    const until = Date.now() + 20000;
    while (alive() && Date.now() < until) spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},100)']);
    if (alive()) { try { process.kill(-payload.pid, 'SIGKILL'); } catch { try { process.kill(payload.pid, 'SIGKILL'); } catch {} } }
  }
});

test('steer --detach: a member that cannot run is refused before anything starts, with the plain reason', (t) => {
  const { root, run } = workspace(t);
  fs.mkdirSync(path.join(root, 'atris/team/keshav'), { recursive: true });
  fs.writeFileSync(path.join(root, 'atris/team/keshav/MEMBER.md'), '---\nname: keshav\ntype: human\nrole: Founder\n---\n# Keshav\n');
  const out = run(['member', 'steer', 'keshav', '--detach', '--json', '--', 'the owner says: write the readme']);
  assert.equal(out.status, 1, out.stderr || out.stdout);
  const payload = JSON.parse(out.stdout.slice(out.stdout.indexOf('{')));
  assert.deepEqual([payload.ok, payload.action, payload.member], [false, 'member_run_not_started', 'keshav']);
  assert.match(payload.reason, /keshav is a person, not an AI teammate/);
  assert.equal(payload.pid, undefined, 'nothing was spawned');
  assert.equal(fs.existsSync(path.join(root, 'ran.jsonl')), false);
});
