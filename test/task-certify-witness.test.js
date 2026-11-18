'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const tasks = require('../lib/task-db');
const cli = path.join(__dirname, '../bin/atris.js');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-cert-witness-'));
  const workspace = path.join(dir, 'workspace'), home = path.join(dir, 'home'), file = path.join(dir, 'tasks.db');
  fs.mkdirSync(path.join(workspace, 'scripts'), { recursive: true });
  const ws = fs.realpathSync(workspace);
  fs.mkdirSync(path.join(ws, 'atris', 'runs'), { recursive: true });
  fs.mkdirSync(home);
  fs.writeFileSync(path.join(ws, 'scripts', 'verify.js'), `const fs = require('node:fs');
fs.appendFileSync('runs', 'run\\n');
if (process.env.CERT_WAIT === '1') {
 fs.writeFileSync('started', 'yes');
 const poll = setInterval(() => { if (fs.existsSync('release')) { clearInterval(poll); process.exit(process.env.CERT_FAIL === '1' ? 1 : 0); } }, 5);
} else if (process.env.CERT_FAIL === '1') process.exit(1);
`);
  fs.writeFileSync(path.join(ws, 'atris', 'runs', 'fixture.json'), JSON.stringify({schema:'atris.mission_receipt.v1',mission_id:'mission-fixture',result:{verifier_result:{passed:true}}}));
  const db = tasks.open(file);
  const env = { ...process.env, HOME:home, XDG_CONFIG_HOME:path.join(home,'.config'), XDG_CACHE_HOME:path.join(home,'.cache'), ATRIS_TASKS_DB:file, ATRIS_SKIP_UPDATE_CHECK:'1', NODE_NO_WARNINGS:'1' };
  t.after(() => { tasks.close(); fs.rmSync(dir, { recursive:true, force:true }); });
  return { dir, ws, home, file, db, env };
}
function setup(f) {
  const item = tasks.addTask(f.db, { title:'Synthetic review', workspaceRoot:f.ws, metadata:{verify:'node scripts/verify.js'} });
  tasks.claimTask(f.db, {id:item.id, claimedBy:'builder'});
  tasks.readyTask(f.db, { id:item.id, actor:'builder', proof:`1 file changed, 2 insertions(+). ${'context '.repeat(30)}Verifier receipt atris/runs/fixture.json shows the verify passed. Checks: receipt atris/runs/fixture.json; node scripts/verify.js passed.` });
  return item;
}
function start(f, extra = {}, args = ['task', 'certify-verified', '--json']) {
  const child = spawn(process.execPath, [cli, ...args], {cwd:f.ws, env:{...f.env,...extra}, stdio:['ignore','pipe','pipe']});
  let stdout='', stderr=''; child.stdout.on('data', b => stdout += b); child.stderr.on('data', b => stderr += b);
  const done = new Promise(resolve => child.on('close', code => resolve({code,stdout,stderr})));
  return {child,done};
}
async function waitStarted(f, child) {
  const deadline = Date.now()+12000;
  while (!fs.existsSync(path.join(f.ws,'started'))) {
    if (child.exitCode !== null) throw new Error(`certify exited before verifier: ${child.exitCode}`);
    if (Date.now() > deadline) { child.kill(); throw new Error('verifier did not start'); }
    await new Promise(resolve => setTimeout(resolve,10));
  }
}
function outcome(f,id) { return {row: tasks.getTask(f.db,id), events:tasks.listTaskEvents(f.db,{taskId:id})}; }

for (const change of ['revision','proof','event','metadata','workspace','failed']) test(`CLI check refuses changed ${change} while verifier waits`, async t => {
  const f=fixture(t), item=setup(f), flight=start(f,{CERT_WAIT:'1',...(change==='failed'?{CERT_FAIL:'1'}:{})});
  t.after(() => { if (flight.child.exitCode === null) flight.child.kill(); });
  await waitStarted(f,flight.child);
  if (change==='revision' || change==='failed') tasks.reviseTask(f.db,{id:item.id,actor:'owner',note:'revise'});
  if (change==='proof') tasks.readyTask(f.db,{id:item.id,actor:'builder',proof:'New proof'});
  if (change==='event') tasks.noteTask(f.db,{id:item.id,actor:'owner',content:'new note'});
  if (change==='metadata') f.db.prepare("UPDATE tasks SET metadata = json_set(metadata, '$.other', 'changed') WHERE id = ?").run(item.id);
  if (change==='workspace') f.db.prepare('UPDATE tasks SET workspace_root = ? WHERE id = ?').run(path.join(f.dir,'other'),item.id);
  const before=outcome(f,item.id);
  fs.writeFileSync(path.join(f.ws,'release'),'yes');
  const result=await flight.done; assert.equal(result.code,0,result.stderr);
  assert.deepEqual(outcome(f,item.id),before);
  assert.equal(before.row.metadata.machine_verified,undefined);
  assert.equal(before.row.metadata.verify_cache,undefined);
});

test('normal certification is atomic and each candidate runs its own check', async t => {
  const f=fixture(t), a=setup(f), b=setup(f);
  const proc = start(f); const result=await proc.done;
  assert.equal(result.code,0,result.stderr); const payload=JSON.parse(result.stdout);
  assert.equal(payload.certified,2,JSON.stringify(payload.results));
  assert.equal(fs.readFileSync(path.join(f.ws,'runs'),'utf8').trim().split('\n').length,2);
  for (const item of [a,b]) { const current=outcome(f,item.id); assert.equal(current.row.metadata.machine_verified,true); assert.equal(current.row.metadata.verify_cache.ok,true); assert.equal(current.events.at(-1).event_type,'proof_ready'); }
});

test('an unrelated task change does not invalidate the checked task', async t => {
  const f=fixture(t), item=setup(f), other=tasks.addTask(f.db,{title:'Other',workspaceRoot:f.ws});
  const flight=start(f,{CERT_WAIT:'1'}); t.after(() => { if(flight.child.exitCode===null) flight.child.kill(); });
  await waitStarted(f,flight.child); tasks.noteTask(f.db,{id:other.id,actor:'owner',content:'unrelated'});
  fs.writeFileSync(path.join(f.ws,'release'),'yes'); const result=await flight.done;
  assert.equal(result.code,0,result.stderr); assert.equal(tasks.getTask(f.db,item.id).metadata.machine_verified,true);
});

test('a failed recheck replaces a prior green cache only when the task is unchanged', async t => {
  const f=fixture(t), item=setup(f);
  f.db.prepare("UPDATE tasks SET metadata = json_set(metadata, '$.verify_cache', json(?), '$.machine_verified', json('true'), '$.certified_verified_by', 'old') WHERE id = ?")
    .run(JSON.stringify({command:'node scripts/verify.js',ok:true,code_sha:null}),item.id);
  const result=await start(f,{CERT_FAIL:'1'}).done; assert.equal(result.code,0,result.stderr);
  const row=tasks.getTask(f.db,item.id); assert.equal(row.metadata.verify_cache.ok,false);
  assert.equal(row.metadata.machine_verified,undefined); assert.equal(row.metadata.certified_verified_by,undefined);
});

test('revision and reopen remove a previous machine check from the new cycle', t => {
  const f=fixture(t), item=setup(f);
  const old=JSON.stringify({verify:'node scripts/verify.js',verify_cache:{ok:true},machine_verified:true,certified_verified_by:'old'});
  f.db.prepare('UPDATE tasks SET metadata = ? WHERE id = ?').run(old,item.id);
  tasks.reviseTask(f.db,{id:item.id,actor:'owner',note:'changed'});
  let metadata=tasks.getTask(f.db,item.id).metadata; assert.equal(metadata.verify_cache,undefined); assert.equal(metadata.machine_verified,undefined);
  tasks.doneTask(f.db,{id:item.id,actor:'owner'});
  f.db.prepare('UPDATE tasks SET metadata = ? WHERE id = ?').run(old,item.id);
  tasks.reopenTask(f.db,{id:item.id,actor:'owner'});
  metadata=tasks.getTask(f.db,item.id).metadata; assert.equal(metadata.verify_cache,undefined); assert.equal(metadata.machine_verified,undefined);
});

test('new ordinary proof invalidates the old check and rollback preserves it', t => {
  const f=fixture(t), item=setup(f);
  const old=JSON.stringify({verify:'node scripts/verify.js',verify_cache:{ok:true},machine_verified:true,certified_verified_by:'old',keep:'yes'});
  f.db.prepare('UPDATE tasks SET metadata = ? WHERE id = ?').run(old,item.id);
  f.db.exec("CREATE TRIGGER reject_fixture BEFORE INSERT ON task_events WHEN NEW.event_type = 'proof_ready' BEGIN SELECT RAISE(ABORT, 'reject fixture'); END");
  assert.throws(()=>tasks.readyTask(f.db,{id:item.id,actor:'builder',proof:'New proof'}),/reject fixture/);
  assert.equal(tasks.getTask(f.db,item.id).metadata.verify_cache.ok,true);
  f.db.exec('DROP TRIGGER reject_fixture');
  tasks.readyTask(f.db,{id:item.id,actor:'builder',proof:'New proof'});
  const metadata=tasks.getTask(f.db,item.id).metadata;
  assert.equal(metadata.verify,'node scripts/verify.js'); assert.equal(metadata.keep,'yes');
  assert.equal(metadata.verify_cache,undefined); assert.equal(metadata.machine_verified,undefined);
});

test('a changed checkout HEAD during a check does not acquire a verification stamp', async t => {
  const f=fixture(t), item=setup(f), fake=path.join(f.dir,'fake-bin'); fs.mkdirSync(fake);
  f.db.prepare("UPDATE tasks SET metadata = json_set(metadata, '$.verify_cache', json(?), '$.machine_verified', json('true')) WHERE id = ?")
    .run(JSON.stringify({command:'node scripts/verify.js',ok:true,code_sha:null}),item.id);
  fs.writeFileSync(path.join(f.ws,'head.txt'),'aaa\n');
  fs.writeFileSync(path.join(fake,'git'),"#!/bin/sh\nif [ \"$1\" = rev-parse ] && [ \"$2\" = HEAD ]; then /bin/cat head.txt; exit 0; fi\nexit 1\n");
  fs.chmodSync(path.join(fake,'git'),0o755);
  const flight=start(f,{CERT_WAIT:'1',PATH:`${fake}:${process.env.PATH}`});
  t.after(() => { if(flight.child.exitCode===null) flight.child.kill(); });
  await waitStarted(f,flight.child); const before=outcome(f,item.id);
  fs.writeFileSync(path.join(f.ws,'head.txt'),'bbb\n'); fs.writeFileSync(path.join(f.ws,'release'),'yes');
  const result=await flight.done; assert.equal(result.code,0,result.stderr);
  const after=outcome(f,item.id); assert.deepEqual(after.events,before.events);
  assert.equal(after.row.metadata.verify_cache,undefined); assert.equal(after.row.metadata.machine_verified,undefined);
  assert.equal(JSON.parse(result.stdout).results[0].reason,'checkout_head_changed');
});

test('certify-first executes each candidate even when the caller supplies a shared cache', async t => {
  const f=fixture(t); setup(f); setup(f);
  const flight=start(f,{ATRIS_AGENT_PROOF_ONLY:'0'},['task','auto-accept-certified','--certify-first','--confirm-human-accept','--as','fixture-human','--json']);
  const result=await flight.done; assert.equal(result.code,0,result.stderr);
  assert.ok(fs.readFileSync(path.join(f.ws,'runs'),'utf8').trim().split('\n').length>=2);
});

for (const detectorExit of [0,1]) test(`a changed task while a policy detector waits cannot be certified or cleared (exit ${detectorExit})`, async t => {
  const f=fixture(t), item=setup(f);
  fs.mkdirSync(path.join(f.ws,'docs'),{recursive:true});
  fs.writeFileSync(path.join(f.ws,'docs','sample.md'),'# Sample\n');
  fs.writeFileSync(path.join(f.ws,'scripts','detector.js'),`const fs=require('node:fs'); fs.writeFileSync('started','yes'); const timer=setInterval(()=>{if(fs.existsSync('release')) {clearInterval(timer); process.exit(${detectorExit});}},5);`);
  fs.writeFileSync(path.join(f.ws,'atris','lessons.json'),JSON.stringify({fixture:{applies_to:['docs/sample.md'],detector:'node scripts/detector.js',status:'resolved'}}));
  f.db.prepare("UPDATE tasks SET metadata = json_set(metadata, '$.changed_files', json('[\"docs/sample.md\"]')) WHERE id = ?").run(item.id);
  const flight=start(f); t.after(() => { if(flight.child.exitCode===null) flight.child.kill(); });
  await waitStarted(f,flight.child); tasks.noteTask(f.db,{id:item.id,actor:'owner',content:'policy race'});
  const before=outcome(f,item.id); fs.writeFileSync(path.join(f.ws,'release'),'yes');
  const result=await flight.done; assert.equal(result.code,0,result.stderr); assert.deepEqual(outcome(f,item.id),before);
  assert.equal(JSON.parse(result.stdout).results[0].reason,'stale_task_state');
});

test('policy refusal clears prior green cache so the reader does not see it', async t => {
  const f=fixture(t), item=setup(f);
  fs.mkdirSync(path.join(f.ws,'docs'),{recursive:true}); fs.writeFileSync(path.join(f.ws,'docs','sample.md'),'# Sample\n');
  fs.writeFileSync(path.join(f.ws,'scripts','detector.js'),'process.exit(1);\n');
  fs.writeFileSync(path.join(f.ws,'atris','lessons.json'),JSON.stringify({fixture:{applies_to:['docs/sample.md'],detector:'node scripts/detector.js',status:'resolved'}}));
  f.db.prepare("UPDATE tasks SET metadata = json_set(metadata, '$.changed_files', json(?), '$.verify_cache', json(?), '$.machine_verified', json('true')) WHERE id = ?")
    .run(JSON.stringify(['docs/sample.md']),JSON.stringify({command:'node scripts/verify.js',ok:true,code_sha:null}),item.id);
  const certification=await start(f).done; assert.equal(certification.code,0,certification.stderr);
  assert.equal(JSON.parse(certification.stdout).results[0].reason,'lesson_gate');
  const metadata=tasks.getTask(f.db,item.id).metadata;
  assert.equal(metadata.verify_cache,undefined); assert.equal(metadata.machine_verified,undefined);
  const read=await start(f,{},['task','reviews','--json']).done; assert.equal(read.code,0,read.stderr);
  assert.ok(!read.stdout.includes('"verify_cache": {'));
});

test('raw malformed, duplicate, truncated, missing, workspace and reversed-time histories fail closed', t => {
  const f=fixture(t), item=setup(f), original=tasks.captureCertifyTask(f.db,item.id);
  assert.ok(original?.witness);
  const base = f.db.prepare('SELECT * FROM task_events WHERE task_id = ? ORDER BY version').all(item.id);
  const restore = () => { f.db.prepare('DELETE FROM task_events WHERE task_id = ?').run(item.id); for(const e of base) f.db.prepare('INSERT INTO task_events VALUES (?,?,?,?,?,?,?,?)').run(e.event_id,e.task_id,e.version,e.workspace_root,e.actor,e.event_type,e.payload,e.created_at); };
  f.db.prepare('UPDATE tasks SET metadata = ? WHERE id = ?').run('{',item.id); assert.equal(tasks.captureCertifyTask(f.db,item.id),null);
  f.db.prepare('UPDATE tasks SET metadata = NULL WHERE id = ?').run(item.id); assert.ok(tasks.captureCertifyTask(f.db,item.id));
  f.db.prepare('UPDATE task_events SET payload = ? WHERE event_id = ?').run('{',base[0].event_id); assert.equal(tasks.captureCertifyTask(f.db,item.id),null); restore();
  f.db.prepare('UPDATE task_events SET payload = NULL WHERE event_id = ?').run(base[0].event_id); assert.ok(tasks.captureCertifyTask(f.db,item.id)); restore();
  f.db.prepare('UPDATE task_events SET version = 1 WHERE event_id = ?').run(base[1].event_id); assert.equal(tasks.captureCertifyTask(f.db,item.id),null); restore();
  f.db.prepare('UPDATE task_events SET workspace_root = ? WHERE event_id = ?').run('/other',base[1].event_id); assert.equal(tasks.captureCertifyTask(f.db,item.id),null); restore();
  f.db.prepare('UPDATE task_events SET created_at = 0 WHERE event_id = ?').run(base[1].event_id); assert.equal(tasks.captureCertifyTask(f.db,item.id),null); restore();
  f.db.prepare('UPDATE task_events SET payload = ? WHERE event_id = ?').run(JSON.stringify({data:'x'.repeat(8*1024*1024)}),base[1].event_id); assert.equal(tasks.captureCertifyTask(f.db,item.id),null); restore();
  f.db.prepare('UPDATE task_events SET version = ? WHERE event_id = ?').run('x'.repeat(8*1024*1024),base[1].event_id); assert.equal(tasks.captureCertifyTask(f.db,item.id),null); restore();
  f.db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run('x'.repeat(8*1024*1024),item.id); assert.equal(tasks.captureCertifyTask(f.db,item.id),null);
  f.db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run('review',item.id);
  f.db.prepare('DELETE FROM task_events WHERE task_id = ?').run(item.id); assert.equal(tasks.captureCertifyTask(f.db,item.id),null); restore();
  const insert=f.db.prepare('INSERT INTO task_events VALUES (?,?,?,?,?,?,?,?)');
  f.db.exec('BEGIN'); for(let i=base.length+1;i<=5001;i++) insert.run(`extra-${i}`,item.id,i,f.ws,null,'message',null,base.at(-1).created_at); f.db.exec('COMMIT');
  assert.equal(tasks.captureCertifyTask(f.db,item.id),null);
});

test('capture rejects a nested transaction without rolling back its owner', t => {
  const f=fixture(t), item=setup(f); f.db.exec('BEGIN');
  f.db.prepare('UPDATE tasks SET title = ? WHERE id = ?').run('inside',item.id);
  assert.throws(()=>tasks.captureCertifyTask(f.db,item.id),/transaction/i);
  assert.equal(tasks.getTask(f.db,item.id).title,'inside'); f.db.exec('ROLLBACK');
  assert.notEqual(tasks.getTask(f.db,item.id).title,'inside');
});

test('guarded ready rollback and ambiguous commit never split its cache from its event', t => {
  const f=fixture(t), item=setup(f), snap=tasks.captureCertifyTask(f.db,item.id);
  const args={id:item.id,actor:'reviewer',proof:'Checked',certification:{witness:snap.witness,verify:'node scripts/verify.js',checkedAt:'2026-01-01T00:00:00.000Z',verifyCache:{command:'node scripts/verify.js',ok:true}}};
  const before=outcome(f,item.id);
  f.db.exec("CREATE TRIGGER reject_fixture BEFORE INSERT ON task_events WHEN NEW.event_type = 'proof_ready' BEGIN SELECT RAISE(ABORT, 'reject fixture'); END");
  assert.throws(()=>tasks.readyTask(f.db,args),/reject fixture/); assert.deepEqual(outcome(f,item.id),before);
  f.db.exec('DROP TRIGGER reject_fixture');
  const rollbackConnection={prepare:sql=>f.db.prepare(sql),exec(sql){ if(sql==='COMMIT') throw new Error('no response'); return f.db.exec(sql); }};
  assert.throws(()=>tasks.readyTask(rollbackConnection,args),error=>error.code==='TASK_READY_COMMIT_UNCERTAIN');
  assert.deepEqual(outcome(f,item.id),before);
  const connection={prepare:sql=>f.db.prepare(sql),exec(sql){ if(sql==='COMMIT') { f.db.exec(sql); throw new Error('lost response'); } return f.db.exec(sql); }};
  assert.throws(()=>tasks.readyTask(connection,args),error=>error.code==='TASK_READY_COMMIT_UNCERTAIN');
  const after=outcome(f,item.id); assert.equal(after.row.metadata.machine_verified,true); assert.equal(after.events.at(-1).event_type,'proof_ready');
  assert.equal(tasks.readyTask(f.db,args).reason,'stale_task_state');
});

test('negative cache reports uncertainty and cannot overwrite a changed observation', t => {
  const f=fixture(t), item=setup(f), snapshot=tasks.captureCertifyTask(f.db,item.id);
  const args={id:item.id,witness:snapshot.witness,verifyCache:{command:'node scripts/verify.js',ok:false}};
  const before=outcome(f,item.id);
  const rollbackConnection={prepare:sql=>f.db.prepare(sql),exec(sql){ if(sql==='COMMIT') throw new Error('no response'); return f.db.exec(sql); }};
  assert.throws(()=>tasks.recordCertifyFailure(rollbackConnection,args),error=>error.code==='TASK_VERIFY_COMMIT_UNCERTAIN');
  assert.deepEqual(outcome(f,item.id),before);
  const commitConnection={prepare:sql=>f.db.prepare(sql),exec(sql){ if(sql==='COMMIT') { f.db.exec(sql); throw new Error('lost response'); } return f.db.exec(sql); }};
  assert.throws(()=>tasks.recordCertifyFailure(commitConnection,args),error=>error.code==='TASK_VERIFY_COMMIT_UNCERTAIN');
  assert.equal(tasks.getTask(f.db,item.id).metadata.verify_cache.ok,false);
  assert.equal(tasks.recordCertifyFailure(f.db,args).reason,'stale_task_state');
});
