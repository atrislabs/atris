'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const { planMemberUpLaunch } = require('../lib/member-up-launch');

// Explicit opt-in: this integration test briefly registers a private launchd job.
test('launchd restarts a crashed team supervisor and honors sleep and immediate resume', { skip: process.platform !== 'darwin' || process.env.ATRIS_TEST_LAUNCHD !== '1', timeout: 120000 }, async (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-member-live-check-'));
  const home = path.join(temp, 'home'), root = path.join(temp, 'workspace');
  fs.mkdirSync(path.join(root, 'atris'), { recursive: true });
  fs.writeFileSync(path.join(root, 'atris', 'atris.md'), '# isolated test workspace\n');
  fs.mkdirSync(home, { recursive: true });
  const member = path.join(root, 'atris', 'team', 'tester');
  fs.mkdirSync(member, { recursive: true });
  fs.writeFileSync(path.join(member, 'MEMBER.md'), '---\nname: tester\nrole: Tester\n---\n');
  const badParent = path.join(temp, 'not-a-directory'); fs.writeFileSync(badParent, 'x');
  const cli = path.resolve(__dirname, '../bin/atris.js'), taskDb = path.join(badParent, 'tasks.db');
  const plan = planMemberUpLaunch({ root, cliPath: cli, stateHome: path.join(home, '.atris'), homeDir: home, taskDb, envPath: process.env.PATH });
  fs.mkdirSync(plan.dir, { recursive: true });
  fs.mkdirSync(path.dirname(plan.file), { recursive: true });
  fs.writeFileSync(plan.file, plan.contents);
  const domain = `gui/${process.getuid()}`;
  const env = { ...process.env, HOME: home, ATRIS_TASKS_DB: taskDb, ATRIS_SKIP_UPDATE_CHECK: '1' };
  const pidfile = path.join(root, '.atris', 'state', 'member-up.json');
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function readPid(previous = 0) {
    for (let i = 0; i < 50; i++) {
      try {
        const pid = JSON.parse(fs.readFileSync(pidfile, 'utf8')).pid;
        if (pid !== previous && cp.spawnSync('kill', ['-0', String(pid)]).status === 0) return pid;
      } catch {}
      await wait(1000);
    }
    return null;
  }
  t.after(() => { cp.spawnSync('launchctl', ['bootout', `${domain}/${plan.label}`]); for (const file of [plan.stdout, plan.stderr]) { if (fs.existsSync(file)) t.diagnostic(`${path.basename(file)}: ${fs.readFileSync(file, 'utf8').slice(-2000)}`); } fs.rmSync(temp, { recursive: true, force: true }); });
  const boot = cp.spawnSync('launchctl', ['bootstrap', domain, plan.file], { encoding: 'utf8' });
  assert.equal(boot.status, 0, boot.stderr);
  const first = await readPid(); assert.ok(first, 'first supervisor starts');
  let recorded = false;
  for (let i = 0; i < 10; i++) {
    if (fs.existsSync(plan.stderr) && fs.readFileSync(plan.stderr, 'utf8').includes('could not read the task queue')) { recorded = true; break; }
    await wait(500);
  }
  assert.ok(recorded, 'the injected queue error reaches the durable error log');
  process.kill(first, 'SIGKILL');
  const second = await readPid(first); assert.ok(second, 'supervisor restarts after a crash');
  const stop = cp.spawnSync(process.execPath, [cli, 'member', 'sleep', '--all', '--json'], { cwd: root, env, encoding: 'utf8' });
  assert.equal(stop.status, 0, stop.stderr); assert.ok(fs.existsSync(plan.stop));
  assert.notEqual(cp.spawnSync('kill', ['-0', String(second)]).status, 0, 'sleep waits until the previous supervisor exits');
  const resume = cp.spawnSync(process.execPath, [cli, 'member', 'up', '--resume'], { cwd: root, env, encoding: 'utf8' });
  assert.equal(resume.status, 0, `${resume.stdout}\n${resume.stderr}`);
  const third = await readPid(second); assert.ok(third, 'immediate resume starts a new supervisor');
  process.kill(third, 'SIGTERM');
  const fourth = await readPid(third); assert.ok(fourth, 'unexpected SIGTERM restarts the supervisor');
  assert.ok(fs.existsSync(plan.stdout)); assert.ok(fs.existsSync(plan.stderr));
  assert.match(fs.readFileSync(plan.stderr, 'utf8'), /stopped without a sleep request/);
});
