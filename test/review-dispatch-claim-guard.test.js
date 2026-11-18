'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const dbmod = require('../lib/task-db');
const fleet = require('../lib/fleet');
const cliPath = path.resolve(__dirname, '../bin/atris.js');

function fixture(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atris-run-guard-')));
  const root = path.join(dir, 'project'); fs.mkdirSync(path.join(root, 'atris'), { recursive: true });
  const dbPath = path.join(dir, 'task.db');
  const env = { ...process.env, HOME: dir, ATRIS_TASKS_DB: dbPath, ATRIS_SKIP_UPDATE_CHECK: '1', ATRIS_NO_INTERACTIVE: '1', ATRIS_NONINTERACTIVE: '1', NODE_NO_WARNINGS: '1' };
  for (const key of Object.keys(env)) if (/^(ANTHROPIC|OPENAI|GOOGLE_API|XAI|CLAUDE_CODE_OAUTH)/.test(key)) delete env[key];
  const d = dbmod.open(dbPath); const task = dbmod.addTask(d, { title: 'Synthetic review task', workspaceRoot: root }); dbmod.close();
  function cli(args) { return spawnSync(process.execPath, [cliPath, ...args], { cwd: root, env, encoding: 'utf8', timeout: 20000 }); }
  function dbRun(body) {
    const code = `const t=require(${JSON.stringify(path.resolve(__dirname, '../lib/task-db'))});const d=t.open(process.env.ATRIS_TASKS_DB);const id=process.argv[1];${body};t.close();`;
    const r = spawnSync(process.execPath, ['-e', code, task.id], { cwd: root, env, encoding: 'utf8', timeout: 20000 }); assert.equal(r.status, 0, r.stderr); return r.stdout;
  }
  function row() { return JSON.parse(dbRun('console.log(JSON.stringify(t.getTask(d,id)))')); }
  t.after(() => { dbmod.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, root, task, env, cli, dbRun, row };
}
function claim(f) {
  const r = f.cli(['task', 'claim', f.task.id, '--as', 'codex', '--json']); assert.equal(r.status, 0, r.stderr);
  const obj = JSON.parse(r.stdout); assert.equal(obj.task_id, f.task.id); assert.ok(obj.claim_guard);
  return Buffer.from(JSON.stringify(obj.claim_guard)).toString('base64url');
}
function ready(f, guard, extra = []) {
  return f.cli(['task', 'ready', f.task.id, '--as', 'codex', '--proof', 'Synthetic change verified with exit 0. Receipt saved at atris/runs/fixture.json.', '--result', 'Operators can review a completed, verified change before it lands, reducing the risk of unreviewed changes reaching users.', '--claim-guard', guard, ...extra]);
}
function release(f, guard) { return f.cli(['task', 'release', f.task.id, '--as', 'codex', '--claim-guard', guard]); }

test('claim evidence crosses real CLI processes and permits one ready', t => {
  const f = fixture(t); const guard = claim(f); const result = ready(f, guard);
  assert.equal(result.status, 0, result.stderr); assert.equal(f.row().status, 'review');
  assert.notEqual(ready(f, guard).status, 0); assert.notEqual(release(f, guard).status, 0);
});

test('revision invalidates a running claim without changing its claimant', t => {
  const f = fixture(t); const guard = claim(f);
  f.dbRun("t.readyTask(d,{id,actor:'codex',proof:'Fixture evidence'});t.reviseTask(d,{id,actor:'human',note:'Please revise'})");
  const before = f.row(); assert.equal(before.status, 'claimed');
  assert.notEqual(ready(f, guard).status, 0); assert.notEqual(release(f, guard).status, 0); assert.deepEqual(f.row(), before);
});

test('same-actor release and reclaim cannot authorize or release an older run', t => {
  const f = fixture(t); const old = claim(f); assert.equal(release(f, old).status, 0); const fresh = claim(f);
  assert.notEqual(ready(f, old).status, 0); assert.notEqual(release(f, old).status, 0); assert.equal(f.row().status, 'claimed');
  assert.equal(ready(f, fresh).status, 0);
});

test('workspace and incarnation substitutions, missing and ambiguous history fail closed', t => {
  for (const change of ['workspace', 'created', 'missing', 'duplicate']) {
    const f = fixture(t); const guard = claim(f);
    if (change === 'workspace') f.dbRun("d.prepare('UPDATE tasks SET workspace_root = ? WHERE id = ?').run('/another', id)");
    if (change === 'created') f.dbRun("d.prepare('UPDATE tasks SET created_at = created_at + 1 WHERE id = ?').run(id)");
    if (change === 'missing') f.dbRun("d.prepare('DELETE FROM task_events WHERE task_id = ? AND version = 1').run(id)");
    if (change === 'duplicate') f.dbRun("d.prepare(\"INSERT INTO task_events SELECT 'duplicate',task_id,version,workspace_root,actor,event_type,payload,created_at FROM task_events WHERE task_id = ? AND version = 1\").run(id)");
    const before = f.row(); assert.notEqual(ready(f, guard).status, 0, change); assert.notEqual(release(f, guard).status, 0, change); assert.deepEqual(f.row(), before);
  }
});

test('guarded verifier is rejected before it can run', t => {
  const f = fixture(t); const guard = claim(f); const marker = path.join(f.dir, 'should-not-exist');
  const result = ready(f, guard, ['--verify', `touch ${marker}`]); assert.notEqual(result.status, 0); assert.equal(fs.existsSync(marker), false); assert.equal(f.row().status, 'claimed');
});

async function flight(f, dispatcher, extra = {}) {
  const calls = []; const responses = []; const worker = path.join(f.dir, 'worker'); fs.mkdirSync(worker, { recursive: true });
  const ownCli = args => { calls.push(args); if (args[0] === 'worktree') return { status: 0, stdout: `next: cd ${worker}\n`, stderr: '' }; const response = f.cli(args); responses.push({args, response}); return response; };
  const result = await fleet.runDispatchFlight({ root: f.root, taskIds: [f.task.id], engine: 'codex', reviewOnly: true,
    verifierCommand: 'git diff --check', ownCli, dispatcher, log: () => {},
    lander: () => { const verify = spawnSync(process.execPath, ['-e', 'process.exit(0)'], { env: f.env }); assert.equal(verify.status, 0); return { ok: true, check: 'git diff --check', verifyOutput: 'fixture check passed', verifier_result: { passed: true, status: 0 }, change: { has_change: true, commit: 'synthetic' } }; }, ...extra });
  return { result, calls, responses };
}

test('actual review-only flight carries claim across its worker and CLI handoff', async t => {
  const f = fixture(t); const { result, calls } = await flight(f, async entry => { assert.equal(entry.task.display_id, f.task.id); return { exitCode: 0, report: 'fixture worker' }; });
  assert.equal(result.ready.length, 1, JSON.stringify(result.paused)); assert.equal(f.row().status, 'review');
  assert.ok(calls.some(a => a[1] === 'claim' && a.includes('--json'))); assert.ok(calls.some(a => a[1] === 'ready' && a.includes('--claim-guard')));
});

test('actual review-only flight refuses a revision made while its worker runs', async t => {
  const f = fixture(t); const { result } = await flight(f, async () => {
    f.dbRun("t.readyTask(d,{id,actor:'codex',proof:'Fixture evidence'});t.reviseTask(d,{id,actor:'human',note:'Please revise'})");
    return { exitCode: 0, report: 'fixture worker' };
  });
  assert.equal(result.ready.length, 0); assert.equal(result.paused[0].stage, 'task_ready'); assert.equal(f.row().metadata.human_revision_note, 'Please revise');
});

test('review-only flight refuses self-landing and uncertain claim output', async t => {
  const f = fixture(t); await assert.rejects(flight(f, async () => ({}), { yolo: true }), /cannot self-land/);
  let called = false;
  const ownCli = args => { if (args[1] === 'claim') { const claimed = f.cli(args); assert.equal(claimed.status, 0, claimed.stderr); return { status: 0, stdout: '', stderr: '' }; } return f.cli(args); };
  const result = await fleet.runDispatchFlight({ root: f.root, taskIds: [f.task.id], engine: 'codex', reviewOnly: true, verifierCommand: 'git diff --check', ownCli, dispatcher: async () => { called = true; }, log: () => {} });
  assert.equal(called, false); assert.equal(result.paused[0].stage, 'claim'); assert.equal(f.row().status, 'claimed');
});


test('failed preparation cannot release a newer claim by the same actor', async t => {
  const f = fixture(t); let calls = 0;
  const ownCli = args => {
    if (args[0] === 'worktree') {
      const released = f.cli(['task', 'release', f.task.id, '--as', 'fleet-codex']); assert.equal(released.status, 0, released.stderr);
      const reclaimed = f.cli(['task', 'claim', f.task.id, '--as', 'fleet-codex', '--json']); assert.equal(reclaimed.status, 0, reclaimed.stderr);
      throw new Error('fixture preparation failure');
    }
    if (args[1] === 'release') calls++;
    return f.cli(args);
  };
  const result = await fleet.runDispatchFlight({ root: f.root, taskIds: [f.task.id], engine: 'codex', reviewOnly: true, verifierCommand: 'git diff --check', ownCli, dispatcher: async () => { throw new Error('must not start'); }, log: () => {} });
  assert.equal(calls, 1); assert.equal(result.paused[0].claim_released, false); assert.equal(f.row().status, 'claimed'); assert.equal(f.row().claimed_by, 'fleet-codex');
});

test('waiting ready sees a release committed by another WAL writer', async t => {
  const f = fixture(t); const encoded = claim(f); const guard = JSON.parse(Buffer.from(encoded, 'base64url').toString());
  const workerPath = path.join(f.dir, 'worker.cjs'); const gate = path.join(f.dir, 'gate'); const started = path.join(f.dir, 'started');
  fs.writeFileSync(workerPath, `
    const fs=require('node:fs');const t=require(${JSON.stringify(path.resolve(__dirname, '../lib/task-db'))});
    const d=t.open(process.env.ATRIS_TASKS_DB);const id=process.env.GUARD_TEST_ID;const mode=process.env.GUARD_TEST_MODE;
    const wrapped={exec(sql){if(sql==='BEGIN IMMEDIATE' && mode==='ready') fs.writeFileSync(process.env.GUARD_TEST_STARTED,'yes'); return d.exec(sql);},
      prepare(sql){if(mode==='release' && sql.includes('INSERT INTO task_events')) {process.send('release-holds-lock'); while(!fs.existsSync(process.env.GUARD_TEST_GATE)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);} return d.prepare(sql);}};
    process.send('started');process.on('message',()=>{try{const result=mode==='release'?t.releaseTask(wrapped,{id,actor:'codex'}):t.readyTask(wrapped,{id,actor:'codex',proof:'fixture',claimGuard:JSON.parse(process.env.GUARD_TEST_GUARD)});process.send({result},()=>process.exit(0));}catch(e){process.send({error:String(e)},()=>process.exit(1));}});
  `);
  const { fork } = require('node:child_process');
  const spawn = mode => {
    const child = fork(workerPath, [], { env: { ...f.env, GUARD_TEST_ID: f.task.id, GUARD_TEST_MODE: mode, GUARD_TEST_STARTED: started, GUARD_TEST_GATE: gate, GUARD_TEST_GUARD: JSON.stringify(guard) }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    const queue = [], waiting = []; let stderr=''; child.stderr.on('data', c => { stderr += c; });
    child.on('message', value => waiting.length ? waiting.shift()(value) : queue.push(value));
    const next = () => queue.length ? Promise.resolve(queue.shift()) : new Promise((resolve, reject) => { const timeout=setTimeout(()=>reject(new Error(`worker timed out: ${stderr}`)),10000); waiting.push(value=>{clearTimeout(timeout);resolve(value);}); });
    t.after(()=>{if(child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');}); return { child, next };
  };
  const first=spawn('release'), second=spawn('ready'); assert.equal(await first.next(),'started'); assert.equal(await second.next(),'started');
  first.child.send('go'); assert.equal(await first.next(),'release-holds-lock'); second.child.send('go');
  const deadline=Date.now()+5000; while(!fs.existsSync(started)) { if(Date.now()>deadline) throw Error('ready did not attempt transaction'); await new Promise(r=>setTimeout(r,5)); }
  fs.writeFileSync(gate,'go'); const [a,b]=await Promise.all([first.next(),second.next()]);
  assert.equal(a.result.released,true,JSON.stringify(a)); assert.equal(b.result.ready,false,JSON.stringify(b)); assert.equal(b.result.reason,'stale_claim'); assert.equal(f.row().status,'open');
});

test('review-only flight cannot claim an exact task ID from another workspace', async t => {
  const f = fixture(t); f.dbRun("d.prepare('UPDATE tasks SET workspace_root = ? WHERE id = ?').run('/another-workspace', id)");
  let launched = false; const before = f.row();
  const result = await fleet.runDispatchFlight({ root: f.root, taskIds: [f.task.id], engine: 'codex', reviewOnly: true, verifierCommand: 'git diff --check', ownCli: args => f.cli(args), dispatcher: async () => { launched = true; }, log: () => {} });
  assert.equal(result.paused[0].stage, 'task_lookup'); assert.equal(launched, false); assert.deepEqual(f.row(), before);
  const scoped = f.cli(['task', 'claim', f.task.id, '--as', 'codex', '--json', '--scoped-claim']); assert.notEqual(scoped.status, 0); assert.deepEqual(f.row(), before);
  const eventTypes = f.dbRun("console.log(JSON.stringify(d.prepare('SELECT event_type FROM task_events WHERE task_id=?').all(id)))"); assert.deepEqual(JSON.parse(eventTypes).map(x => x.event_type), ['created']);
});

test('paused no-work cleanup cannot release a newer same-actor claim', async t => {
  const f = fixture(t); const { result, calls } = await flight(f, async entry => {
    function git(args) { const r=spawnSync('git',args,{cwd:entry.worktreePath,env:f.env,encoding:'utf8'}); assert.equal(r.status,0,r.stderr); }
    git(['init']); git(['config','user.name','fixture']); git(['config','user.email','fixture@example.test']); git(['commit','--allow-empty','-m','fixture']);
    const released=f.cli(['task','release',f.task.id,'--as','fleet-codex']); assert.equal(released.status,0,released.stderr);
    const reclaimed=f.cli(['task','claim',f.task.id,'--as','fleet-codex','--json']); assert.equal(reclaimed.status,0,reclaimed.stderr);
    return {exitCode:1, stderr:'fixture failure'};
  }, { checkoutBase: 'HEAD' });
  assert.equal(result.paused[0].claim_released, false); assert.equal(f.row().status,'claimed');
  assert.ok(calls.some(a=>a[1]==='release' && a.includes('--claim-guard')));
});

test('malformed original claim evidence cannot mutate a task', t => {
  const f = fixture(t); claim(f); const before=f.row();
  for (const bad of ['not-base64-json', '%%%']) {
    const a=ready(f,bad); const b=release(f,bad);
    assert.notEqual(a.status,0); assert.notEqual(b.status,0); assert.deepEqual(f.row(),before);
  }
});


test('a changed task between the read and the claim is never dispatched', async t => {
  const f=fixture(t); let launched=false, mutated=false;
  const ownCli=args=>{ if(args[1]==='claim') { mutated=true; f.dbRun("d.prepare('UPDATE tasks SET title=? WHERE id=?').run('Human changed this task',id)"); } return f.cli(args); };
  const result=await fleet.runDispatchFlight({root:f.root,taskIds:[f.task.id],engine:'codex',reviewOnly:true,verifierCommand:'git diff --check',ownCli,dispatcher:async()=>{launched=true;},log:()=>{}});
  assert.equal(mutated,true); assert.equal(launched,false); assert.equal(result.paused[0].stage,'claim'); assert.equal(f.row().status,'open'); assert.equal(f.row().title,'Human changed this task');
  const events=JSON.parse(f.dbRun("console.log(JSON.stringify(d.prepare('SELECT event_type FROM task_events WHERE task_id=?').all(id)))")); assert.deepEqual(events.map(x=>x.event_type),['created']);
});


test('nonzero exit after a committed claim reports an uncertain outcome and does not clean it up', async t => {
  const f = fixture(t); let launched=false; const calls=[];
  const ownCli=args=>{ calls.push(args); if(args[1]==='claim') { const claimed=f.cli(args); assert.equal(claimed.status,0,claimed.stderr); return {status:1,stdout:'',stderr:'fixture output failed'}; } return f.cli(args); };
  const result=await fleet.runDispatchFlight({root:f.root,taskIds:[f.task.id],engine:'codex',reviewOnly:true,verifierCommand:'git diff --check',ownCli,dispatcher:async()=>{launched=true;},log:()=>{}});
  assert.equal(launched,false); assert.equal(result.paused[0].stage,'claim'); assert.match(result.paused[0].detail,/uncertain.*inspect/i);
  assert.equal(f.row().status,'claimed'); assert.equal(calls.some(a=>a[1]==='release'),false);
});

test('normal dispatch carries the exact scoped claim through the landed task handoff', async t => {
  const f = fixture(t);
  const { result, calls, responses } = await flight(f, async () => ({ exitCode: 0, report: 'fixture worker' }), { reviewOnly: false, verifierCommand: '' });
  assert.equal(result.landed.length, 1, JSON.stringify(result.paused));
  assert.equal(result.landed[0].review_recorded, true, JSON.stringify(responses.find(x=>x.args[1]==='ready')?.response));
  assert.equal(result.paused.length, 0); assert.equal(result.status, 'completed'); assert.equal(f.row().status, 'review');
  assert.ok(calls.some(a => a[1] === 'show' && a.includes('--dispatch-snapshot')));
  assert.ok(calls.some(a => a[1] === 'claim' && a.includes('--scoped-claim') && a.includes('--expected-task-snapshot')));
  assert.ok(calls.some(a => a[1] === 'ready' && a.includes('--claim-guard')));
});

test('normal dispatch preserves landed result while refusing a revised task handoff', async t => {
  const f = fixture(t);
  const { result, calls } = await flight(f, async () => {
    f.dbRun("t.readyTask(d,{id,actor:'fleet-codex',proof:'Fixture evidence'});t.reviseTask(d,{id,actor:'human',note:'Please revise'})");
    return { exitCode: 0, report: 'fixture worker' };
  }, { reviewOnly: false, verifierCommand: '' });
  assert.equal(result.landed.length, 1); assert.equal(result.landed[0].review_recorded, false);
  assert.equal(result.paused[0].stage, 'task_ready'); assert.match(result.paused[0].detail, /landed.*not confirmed/i);
  assert.equal(result.status, 'failed'); assert.equal(result.result.passed, false);
  assert.equal(f.row().metadata.human_revision_note, 'Please revise');
  assert.equal(calls.filter(a => a[1] === 'ready').length, 1); assert.equal(calls.some(a => a[1] === 'release'), false);
});

test('normal dispatch rejects a same-actor replacement claim after its worker starts', async t => {
  const f = fixture(t);
  const { result, calls } = await flight(f, async () => {
    assert.equal(f.cli(['task','release',f.task.id,'--as','fleet-codex']).status, 0);
    assert.equal(f.cli(['task','claim',f.task.id,'--as','fleet-codex','--json']).status, 0);
    return { exitCode: 0, report: 'fixture worker' };
  }, { reviewOnly: false, verifierCommand: '' });
  assert.equal(result.landed.length, 1); assert.equal(result.paused[0].stage, 'task_ready');
  assert.equal(f.row().status, 'claimed'); assert.equal(calls.some(a => a[1] === 'release'), false);
});

test('normal dispatch does not launch or clean up after uncertain committed claim', async t => {
  const f = fixture(t); let launched = false; const calls = [];
  const ownCli = args => { calls.push(args); if (args[1] === 'claim') { const r=f.cli(args); assert.equal(r.status,0,r.stderr); return {status:1,stdout:'',stderr:'fixture lost response'}; } return f.cli(args); };
  const result = await fleet.runDispatchFlight({ root:f.root, taskIds:[f.task.id], engine:'codex', ownCli, dispatcher:async()=>{launched=true;}, log:()=>{} });
  assert.equal(launched,false); assert.equal(result.paused[0].stage,'claim'); assert.match(result.paused[0].detail,/uncertain.*inspect/i);
  assert.equal(f.row().status,'claimed'); assert.equal(calls.some(a=>a[1]==='release'),false);
});

test('normal dispatch refuses malformed committed claim evidence', async t => {
  const f=fixture(t); let launched=false; const calls=[];
  const ownCli=args=>{calls.push(args);if(args[1]==='claim'){const r=f.cli(args);assert.equal(r.status,0,r.stderr);return {status:0,stdout:'{}',stderr:''};}return f.cli(args);};
  const result=await fleet.runDispatchFlight({root:f.root,taskIds:[f.task.id],engine:'codex',ownCli,dispatcher:async()=>{launched=true;},log:()=>{}});
  assert.equal(launched,false);assert.equal(result.paused[0].stage,'claim');assert.equal(f.row().status,'claimed');
  assert.equal(calls.some(a=>a[1]==='release'),false);
});

test('normal dispatch reports a landed change after a committed but lost handoff response', async t => {
  const f=fixture(t);const calls=[];let provisional;const worker=path.join(f.dir,'worker');fs.mkdirSync(worker);
  const ownCli=args=>{calls.push(args);if(args[0]==='worktree')return {status:0,stdout:`next: cd ${worker}\n`,stderr:''};
    if(args[1]==='ready'){provisional=JSON.parse(fs.readFileSync(path.join(f.root,'atris','runs',fs.readdirSync(path.join(f.root,'atris','runs')).find(n=>n.endsWith('.json'))),'utf8'));
      const r=f.cli(args);assert.equal(r.status,0,r.stderr);throw new Error('fixture response lost');}return f.cli(args);};
  const result=await fleet.runDispatchFlight({root:f.root,taskIds:[f.task.id],engine:'codex',ownCli,dispatcher:async()=>({exitCode:0,report:'fixture'}),
    lander:()=>({ok:true,check:'fixture check',verifyOutput:'passed',verifier_result:{passed:true,status:0}}),log:()=>{}});
  assert.equal(provisional.landed[0].review_recorded,false);assert.equal(provisional.result.passed,false);
  assert.equal(f.row().status,'review');assert.equal(result.landed[0].review_recorded,false);
  assert.equal(result.paused[0].stage,'task_ready');assert.equal(result.paused[0].landed,true);assert.equal(result.result.passed,false);
  assert.equal(calls.filter(a=>a[1]==='ready').length,1);assert.equal(calls.some(a=>a[1]==='release'),false);
  const receipt=JSON.parse(fs.readFileSync(result.receipt,'utf8'));assert.equal(receipt.status,'failed');assert.equal(receipt.landed[0].review_recorded,false);
});

test('normal dispatch refuses a task in another workspace', async t => {
  const f=fixture(t);f.dbRun("d.prepare('UPDATE tasks SET workspace_root=? WHERE id=?').run('/another-workspace',id)");const before=f.row();let launched=false;
  const result=await fleet.runDispatchFlight({root:f.root,taskIds:[f.task.id],engine:'codex',ownCli:args=>f.cli(args),dispatcher:async()=>{launched=true;},log:()=>{}});
  assert.equal(launched,false);assert.equal(result.paused[0].stage,'task_lookup');assert.deepEqual(f.row(),before);
});

test('normal dispatch rejects changed instructions before claiming', async t => {
  const f = fixture(t); let launched = false;
  const ownCli = args => { if(args[1] === 'claim') f.dbRun("d.prepare('UPDATE tasks SET title=? WHERE id=?').run('Changed by owner',id)"); return f.cli(args); };
  const result = await fleet.runDispatchFlight({ root:f.root, taskIds:[f.task.id], engine:'codex', ownCli, dispatcher:async()=>{launched=true;}, log:()=>{} });
  assert.equal(launched,false); assert.equal(result.paused[0].stage,'claim'); assert.equal(f.row().status,'open');
  assert.equal(f.row().title,'Changed by owner');
});

test('normal dispatch cannot release a newer same-actor claim when preparation fails', async t => {
  const f = fixture(t); const calls=[];
  const ownCli = args => { calls.push(args); if(args[0] === 'worktree') {
    assert.equal(f.cli(['task','release',f.task.id,'--as','fleet-codex']).status,0);
    assert.equal(f.cli(['task','claim',f.task.id,'--as','fleet-codex','--json']).status,0);
    return {status:1, stdout:'', stderr:'fixture preparation failed'};
  } return f.cli(args); };
  const result = await fleet.runDispatchFlight({root:f.root,taskIds:[f.task.id],engine:'codex',ownCli,dispatcher:async()=>{throw Error('must not launch');},log:()=>{}});
  assert.equal(result.paused[0].claim_released,false); assert.equal(f.row().status,'claimed');
  assert.ok(calls.some(a=>a[1]==='release' && a.includes('--claim-guard')));
});

test('normal dispatch cannot clean up a newer same-actor claim after a no-work pause', async t => {
  const f=fixture(t); const {result,calls}=await flight(f,async entry=>{
    const git=args=>{const r=spawnSync('git',args,{cwd:entry.worktreePath,env:f.env,encoding:'utf8'});assert.equal(r.status,0,r.stderr);};
    git(['init']);git(['config','user.name','fixture']);git(['config','user.email','fixture@example.test']);git(['commit','--allow-empty','-m','fixture']);
    assert.equal(f.cli(['task','release',f.task.id,'--as','fleet-codex']).status,0);
    assert.equal(f.cli(['task','claim',f.task.id,'--as','fleet-codex','--json']).status,0);
    return {exitCode:1,stderr:'fixture failure'};
  },{reviewOnly:false,verifierCommand:'',checkoutBase:'HEAD'});
  assert.equal(result.paused[0].claim_released,false);assert.equal(f.row().status,'claimed');
  assert.ok(calls.some(a=>a[1]==='release' && a.includes('--claim-guard')));
});

for (const outcome of ['throw','nonzero']) for (const committed of [false,true]) test(`unstarted release ${outcome} ${committed ? 'after' : 'before'} commit is uncertain and never retried`, async t => {
  const f=fixture(t);let releases=0;
  const ownCli=args=>{
    if(args[0]==='worktree')return {status:1,stdout:'',stderr:'fixture preparation failed'};
    if(args[1]==='release'){releases++;if(committed){const r=f.cli(args);assert.equal(r.status,0,r.stderr);}if(outcome==='throw')throw Error('fixture lost release response');return {status:1,stdout:'',stderr:'fixture lost response'};}
    return f.cli(args);
  };
  const result=await fleet.runDispatchFlight({root:f.root,taskIds:[f.task.id],engine:'codex',ownCli,dispatcher:async()=>{throw Error('must not launch');},log:()=>{}});
  assert.equal(releases,1);assert.equal(result.paused[0].stage,'worktree_start');assert.equal(result.paused[0].claim_released,false);assert.equal(result.paused[0].claim_release_uncertain,true);
  assert.match(result.paused[0].detail,/release outcome is uncertain.*inspect/i);assert.equal(f.row().status,committed?'open':'claimed');
  const receipt=JSON.parse(fs.readFileSync(result.receipt,'utf8'));assert.equal(receipt.status,'failed');assert.match(receipt.paused[0].detail,/uncertain/i);
});

for (const outcome of ['throw','nonzero']) for (const committed of [false,true]) test(`paused release ${outcome} ${committed ? 'after' : 'before'} commit is uncertain and never retried`, async t => {
  const f=fixture(t);let releases=0;const worker=path.join(f.dir,'worker');fs.mkdirSync(worker);
  function git(args){const r=spawnSync('git',args,{cwd:worker,env:f.env,encoding:'utf8'});assert.equal(r.status,0,r.stderr);}
  git(['init']);git(['config','user.name','fixture']);git(['config','user.email','fixture@example.test']);git(['commit','--allow-empty','-m','fixture']);
  const ownCli=args=>{
    if(args[0]==='worktree')return {status:0,stdout:`next: cd ${worker}\n`,stderr:''};
    if(args[1]==='release'){releases++;if(committed){const r=f.cli(args);assert.equal(r.status,0,r.stderr);}if(outcome==='throw')throw Error('fixture lost release response');return {status:1,stdout:'',stderr:'fixture lost response'};}
    return f.cli(args);
  };
  const result=await fleet.runDispatchFlight({root:f.root,taskIds:[f.task.id],engine:'codex',ownCli,checkoutBase:'HEAD',dispatcher:async()=>({exitCode:1,stderr:'fixture failure'}),log:()=>{}});
  assert.equal(releases,1);assert.equal(result.paused[0].claim_released,false);assert.equal(result.paused[0].claim_release_uncertain,true);
  assert.match(result.paused[0].release_detail,/uncertain.*inspect/i);assert.equal(f.row().status,committed?'open':'claimed');
  const receipt=JSON.parse(fs.readFileSync(result.receipt,'utf8'));assert.equal(receipt.status,'failed');assert.equal(receipt.paused[0].claim_release_uncertain,true);
});

for (const committed of [false,true]) test(`review-only handoff exception ${committed ? 'after' : 'before'} commit is uncertain and never retried`, async t => {
  const f=fixture(t);let readyCalls=0,releases=0,provisional;const worker=path.join(f.dir,'worker');fs.mkdirSync(worker);
  const ownCli=args=>{
    if(args[0]==='worktree')return {status:0,stdout:`next: cd ${worker}\n`,stderr:''};
    if(args[1]==='release')releases++;
    if(args[1]==='ready'){readyCalls++;
      const receiptPath=path.join(f.root,'atris','runs',fs.readdirSync(path.join(f.root,'atris','runs')).find(n=>n.endsWith('.json')));
      provisional=JSON.parse(fs.readFileSync(receiptPath,'utf8'));
      if(committed){const r=f.cli(args);assert.equal(r.status,0,r.stderr);}throw Error('fixture lost ready response');}
    return f.cli(args);
  };
  const result=await fleet.runDispatchFlight({root:f.root,taskIds:[f.task.id],engine:'codex',reviewOnly:true,verifierCommand:'git diff --check',ownCli,
    dispatcher:async()=>({exitCode:0,report:'fixture'}),lander:()=>({ok:true,check:'fixture check',verifyOutput:'passed',verifier_result:{passed:true,status:0},change:{has_change:true,commit:'synthetic'}}),log:()=>{}});
  assert.equal(provisional.ready[0].review_recorded,false);assert.equal(provisional.result.passed,false);
  assert.equal(readyCalls,1);assert.equal(releases,0);assert.equal(result.ready.length,0);assert.equal(result.paused[0].stage,'task_ready');
  assert.match(result.paused[0].detail,/not confirmed.*inspect/i);assert.equal(f.row().status,committed?'review':'claimed');
  const receipt=JSON.parse(fs.readFileSync(result.receipt,'utf8'));assert.equal(receipt.status,'failed');assert.equal(receipt.result.passed,false);
});

for (const [label, statement, expected] of [
  ['title marker', "d.prepare('UPDATE tasks SET title=? WHERE id=?').run('Please #decision',id)", 'human_decision_required'],
  ['primary alias', "d.prepare('UPDATE tasks SET tag=? WHERE id=?').run('Needs_Human',id)", 'human_decision_required'],
  ['metadata alias', "d.prepare('UPDATE tasks SET metadata=? WHERE id=?').run(JSON.stringify({tags:['NEEDSHUMAN']}),id)", 'human_decision_required'],
  ['malformed metadata', "d.prepare('UPDATE tasks SET metadata=? WHERE id=?').run('{broken',id)", 'human_decision_unknown'],
  ['invalid tags', "d.prepare('UPDATE tasks SET metadata=? WHERE id=?').run(JSON.stringify({tags:['normal',null]}),id)", 'human_decision_unknown'],
  ['duplicate tags', `d.prepare('UPDATE tasks SET metadata=? WHERE id=?').run('{"tags":["decision"],"tags":[]}',id)`, 'human_decision_unknown'],
]) test(`guarded ready refuses a current ${label} without writes`, t => {
  const f=fixture(t);const guard=claim(f);f.dbRun(statement);
  const before=f.dbRun("console.log(JSON.stringify({row:d.prepare('SELECT * FROM tasks WHERE id=?').get(id),events:d.prepare('SELECT * FROM task_events WHERE task_id=? ORDER BY version').all(id)}))");
  const result=ready(f,guard);assert.notEqual(result.status,0);assert.match(result.stderr,new RegExp(expected));
  const after=f.dbRun("console.log(JSON.stringify({row:d.prepare('SELECT * FROM tasks WHERE id=?').get(id),events:d.prepare('SELECT * FROM task_events WHERE task_id=? ORDER BY version').all(id)}))");
  assert.equal(after,before); assert.equal(release(f,guard).status,0, 'guarded cleanup remains available');
});

test('unrelated tag updates allow guarded handoff and manual ready remains compatible', t => {
  const f=fixture(t);const guard=claim(f);
  assert.equal(f.cli(['task','tag',f.task.id,'--add','other','--as','human','--json']).status,0);
  assert.equal(ready(f,guard).status,0);
  const g=fixture(t);claim(g);assert.equal(g.cli(['task','tag',g.task.id,'--add','needs-human','--as','human','--json']).status,0);
  const manual=g.cli(['task','ready',g.task.id,'--as','human','--proof','Synthetic change verified with exit 0. Receipt saved at atris/runs/fixture.json.','--result','Operators can review a completed change before it lands, reducing the risk of unreviewed changes reaching users.']);
  assert.equal(manual.status,0,manual.stderr);assert.equal(g.row().status,'review');
});

for (const reviewOnly of [true,false]) test(`${reviewOnly ? 'review' : 'landed'} handoff respects a marker added while work runs`, async t => {
  const f=fixture(t);const {result,calls,responses}=await flight(f,async()=>{
    const tag=f.cli(['task','tag',f.task.id,'--add','needs-human','--as','human','--json']);assert.equal(tag.status,0,tag.stderr);
    return {exitCode:0,report:'fixture worker'};
  },{reviewOnly,verifierCommand:reviewOnly?'git diff --check':''});
  assert.equal(result.paused[0].stage,'task_ready');assert.equal(f.row().status,'claimed');
  assert.match(responses.find(x=>x.args[1]==='ready').response.stderr,/human_decision_required/);
  assert.equal(calls.filter(a=>a[1]==='ready').length,1);assert.equal(calls.some(a=>a[1]==='release'),false);
  if(!reviewOnly){assert.equal(result.landed.length,1);assert.equal(result.landed[0].review_recorded,false);assert.equal(result.paused[0].landed,true);}
});

test('marker classification matches current picker rules and fails closed on malformed observations', () => {
  const {isDecisionTask,decisionStateForRawTask}=require('../lib/task-decision');
  for(const item of [
    {title:'plain',tag:null,metadata:null}, {title:'work #decision',tag:'ordinary',metadata:'{}'},
    {title:'work #needs-human',tag:null,metadata:'{}'}, {title:'work #needs_human',tag:null,metadata:'{}'},
    {title:'work',tag:' NEEDS_HUMAN ',metadata:'{}'}, {title:'work',tag:null,metadata:'{"tags":["normal","decision"]}'},
    {title:'work',tag:'human',metadata:'{"tags":[]}'},
  ]) {
    const parsed={...item,metadata:item.metadata===null?null:JSON.parse(item.metadata)};
    assert.equal(decisionStateForRawTask(item),isDecisionTask(parsed)?'marked':'clear',JSON.stringify(item));
  }
  for(const item of [
    {tag:null,metadata:null}, {title:'x',metadata:null}, {title:'x',tag:null},
    {title:'x',tag:3,metadata:null}, {title:'x',tag:null,metadata:'null'},
    {title:'x',tag:null,metadata:'{"tags":null}'}, {title:'x',tag:null,metadata:'{"tags":[2]}'},
    {title:'x',tag:null,metadata:'{"tags":[],"ta\\u0067s":[]}'},
    {title:'x',tag:null,metadata:' '.repeat(1048577)}, {title:'x',tag:null,metadata:JSON.stringify({tags:Array(1025).fill('x')})},
  ]) assert.equal(decisionStateForRawTask(item),'unknown');
  assert.equal(decisionStateForRawTask({title:'x #decision',tag:null,metadata:'broken'}),'marked');
});

test('guarded handoff rolls back on event failure and reports lost commit responses honestly', t => {
  const f=fixture(t), guard=JSON.parse(Buffer.from(claim(f),'base64url').toString());
  const code=`const a={id,actor:'codex',proof:'fixture',claimGuard:${JSON.stringify(guard)}};
  const snap=()=>JSON.stringify({row:d.prepare('SELECT * FROM tasks WHERE id=?').get(id),events:d.prepare('SELECT * FROM task_events WHERE task_id=? ORDER BY version').all(id)});
  const before=snap();d.exec("CREATE TRIGGER fixture_fail BEFORE INSERT ON task_events WHEN NEW.event_type='proof_ready' BEGIN SELECT RAISE(ABORT,'fixture fail'); END");
  let first;try{t.readyTask(d,a)}catch(e){first=e.message}if(!first.includes('fixture fail')||snap()!==before)throw Error('bad rollback');d.exec('DROP TRIGGER fixture_fail');
  const wrap=commit=>({prepare:s=>d.prepare(s),exec(s){if(s==='COMMIT'){if(commit)d.exec(s);throw Error('lost')}return d.exec(s)}});
  for(const commit of [false,true]){let code;try{t.readyTask(wrap(commit),a)}catch(e){code=e.code}if(code!=='TASK_READY_COMMIT_UNCERTAIN')throw Error('missing uncertainty');if(!commit&&snap()!==before)throw Error('partial write');}
  if(t.getTask(d,id).status!=='review')throw Error('committed handoff missing');console.log('ok')`;
  assert.match(f.dbRun(code),/ok/);
});

for(const firstMode of ['tag','ready']) test(`guarded ready observes the first committed ${firstMode} WAL writer`, async t => {
  const f=fixture(t), encoded=claim(f), guard=JSON.parse(Buffer.from(encoded,'base64url').toString());
  const workerPath=path.join(f.dir,'decision-worker.cjs'),gate=path.join(f.dir,'gate'),started=path.join(f.dir,'started');
  fs.writeFileSync(workerPath,`
    const fs=require('node:fs');const t=require(${JSON.stringify(path.resolve(__dirname,'../lib/task-db'))});const d=t.open(process.env.ATRIS_TASKS_DB);
    const mode=process.env.MODE,id=process.env.ID,first=process.env.FIRST;
    const wrapped={exec(sql){if(sql==='BEGIN IMMEDIATE'&&mode!==first)fs.writeFileSync(process.env.STARTED,'yes');return d.exec(sql)},prepare(sql){
      if(mode==='ready'&&mode===first&&sql.includes('INSERT INTO task_events')) {process.send('holding');while(!fs.existsSync(process.env.GATE))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5);}return d.prepare(sql)}};
    process.send('started');process.on('message',()=>{try{let result;if(mode==='ready')result=t.readyTask(wrapped,{id,actor:'codex',proof:'fixture',claimGuard:JSON.parse(process.env.GUARD)});
      else {wrapped.exec('BEGIN IMMEDIATE');d.prepare('UPDATE tasks SET metadata=? WHERE id=?').run(JSON.stringify({tags:['needs-human']}),id);t.appendTaskEvent(d,{taskId:id,workspaceRoot:process.env.ROOT,actor:'human',eventType:'task_tags_updated',payload:{tags:['needs-human']}});
        if(mode===first){process.send('holding');while(!fs.existsSync(process.env.GATE))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5)}wrapped.exec('COMMIT');result={tagged:true};}
      process.send({result},()=>process.exit(0));}catch(e){process.send({error:String(e)},()=>process.exit(1));}});
  `);
  const {fork}=require('node:child_process');
  const spawn=mode=>{const child=fork(workerPath,[],{env:{...f.env,MODE:mode,FIRST:firstMode,ID:f.task.id,ROOT:f.root,GUARD:JSON.stringify(guard),GATE:gate,STARTED:started},stdio:['ignore','ignore','pipe','ipc']});let stderr='';child.stderr.on('data',c=>stderr+=c);const q=[],wait=[];child.on('message',x=>wait.length?wait.shift()(x):q.push(x));const next=()=>q.length?Promise.resolve(q.shift()):new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(stderr||'worker timeout')),10000);wait.push(x=>{clearTimeout(timer);resolve(x)})});t.after(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL')});return {child,next}};
  const a=spawn(firstMode),b=spawn(firstMode==='tag'?'ready':'tag');assert.equal(await a.next(),'started');assert.equal(await b.next(),'started');a.child.send('go');assert.equal(await a.next(),'holding');b.child.send('go');
  const deadline=Date.now()+5000;while(!fs.existsSync(started)){if(Date.now()>deadline)throw Error('second writer did not start');await new Promise(r=>setTimeout(r,5))}fs.writeFileSync(gate,'go');
  const [x,y]=await Promise.all([a.next(),b.next()]);assert.ok(!x.error&&!y.error,JSON.stringify([x,y]));const readyResult=firstMode==='ready'?x.result:y.result;
  assert.equal(readyResult.ready,firstMode==='ready');if(firstMode==='tag')assert.equal(readyResult.reason,'human_decision_required');
  assert.equal(f.row().status,firstMode==='ready'?'review':'claimed');
});

test('a committed marker is respected even before its delayed history event', t => {
  const f=fixture(t), guard=claim(f);
  f.dbRun("d.prepare('UPDATE tasks SET metadata=? WHERE id=?').run(JSON.stringify({tags:['needs-human']}),id)");
  const refused=ready(f,guard);assert.notEqual(refused.status,0);assert.match(refused.stderr,/human_decision_required/);assert.equal(f.row().status,'claimed');
  f.dbRun("t.appendTaskEvent(d,{taskId:id,workspaceRoot:process.cwd(),actor:'human',eventType:'task_tags_updated',payload:{tags:['needs-human']}})");
  assert.notEqual(ready(f,guard).status,0);assert.equal(f.row().status,'claimed');
});

test('a marker committed after the handoff cannot undo that handoff', t => {
  const f=fixture(t), guard=claim(f);assert.equal(ready(f,guard).status,0);
  const tagged=f.cli(['task','tag',f.task.id,'--add','needs-human','--as','human','--json']);assert.equal(tagged.status,0,tagged.stderr);
  assert.equal(f.row().status,'review');assert.ok(f.row().metadata.tags.includes('needs-human'));
});

test('guarded handoff observes a marker removed before the handoff', t => {
  const f=fixture(t),guard=claim(f);
  assert.equal(f.cli(['task','tag',f.task.id,'--add','needs-human','--as','human','--json']).status,0);
  assert.equal(f.cli(['task','tag',f.task.id,'--remove','needs-human','--as','human','--json']).status,0);
  const result=ready(f,guard);assert.equal(result.status,0,result.stderr);assert.equal(f.row().status,'review');
});

for(const [label,args,shouldReady] of [
  ['message',['A note for the team'],true],
  ['goal',['--goal','A revised goal'],false],
  ['summary',['--summary','A revised summary'],false],
]) test(`actual chat command ${label} ${shouldReady?'preserves':'stops'} guarded handoff`,t=>{
  const f=fixture(t),guard=claim(f);const chat=f.cli(['task','chat',f.task.id,...args,'--as','human','--json']);assert.equal(chat.status,0,chat.stderr);
  const result=ready(f,guard);assert.equal(result.status===0,shouldReady,result.stderr);
  if(!shouldReady){assert.match(result.stderr,/stale_claim/);assert.equal(release(f,guard).status,0)}
});

test('manual ready remains available after a brief change',t=>{
  const f=fixture(t);claim(f);assert.equal(f.cli(['task','chat',f.task.id,'--goal','A revised goal','--as','human','--json']).status,0);
  const manual=f.cli(['task','ready',f.task.id,'--as','human','--proof','Synthetic change verified with exit 0. Receipt saved at atris/runs/fixture.json.','--result','Operators can review a completed change before it lands, reducing the risk of unreviewed changes reaching users.']);
  assert.equal(manual.status,0,manual.stderr);assert.equal(f.row().status,'review');
});

for(const reviewOnly of [true,false]) test(`${reviewOnly?'review':'landed'} handoff rejects a changed task brief`,async t=>{
  const f=fixture(t),{result,calls,responses}=await flight(f,async()=>{
    const chat=f.cli(['task','chat',f.task.id,'--goal','A revised goal','--as','human','--json']);assert.equal(chat.status,0,chat.stderr);
    return {exitCode:0,report:'fixture worker'};
  },{reviewOnly,verifierCommand:reviewOnly?'git diff --check':''});
  assert.equal(result.paused[0].stage,'task_ready');assert.equal(f.row().status,'claimed');assert.equal(f.row().metadata.task_goal,'A revised goal');
  assert.match(responses.find(x=>x.args[1]==='ready').response.stderr,/stale_claim/);
  assert.equal(calls.filter(a=>a[1]==='ready').length,1);assert.equal(calls.some(a=>a[1]==='release'),false);
  if(!reviewOnly){assert.equal(result.landed.length,1);assert.equal(result.landed[0].review_recorded,false);assert.equal(result.paused[0].landed,true)}
});
