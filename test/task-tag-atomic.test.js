'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tasks = require('../lib/task-db');

function fixture(t) {
  const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'atris-tag-atomic-')));
  const db=tasks.open(path.join(dir,'tasks.db'));
  t.after(()=>{tasks.close();fs.rmSync(dir,{recursive:true,force:true});});
  const item=tasks.addTask(db,{title:'Synthetic task',workspaceRoot:dir,metadata:{keep:'value'}});
  const claim=tasks.claimTask(db,{id:item.id,claimedBy:'fixture'});
  const guard={id:item.id,workspace_root:claim.row.workspace_root,claimed_by:claim.row.claimed_by,claimed_at:claim.row.claimed_at,created_at:claim.row.created_at,event_id:claim.event.event_id,event_version:claim.event.version};
  return {dir,db,item,guard};
}
function snapshot(f) {return {row:f.db.prepare('SELECT * FROM tasks WHERE id=?').get(f.item.id),events:f.db.prepare('SELECT * FROM task_events WHERE task_id=? ORDER BY version').all(f.item.id)}}

test('tag writer cannot overwrite ready metadata after reading the same timestamp', t=>{
  const f=fixture(t),tick=f.db.prepare('SELECT updated_at FROM tasks WHERE id=?').get(f.item.id).updated_at;
  const original=Date.now;Date.now=()=>tick;t.after(()=>Date.now=original);
  let locked=false,interleaved=false;
  const wrapped={exec(sql){if(sql==='BEGIN IMMEDIATE')locked=true;return f.db.exec(sql)},prepare(sql){const stmt=f.db.prepare(sql);if(!sql.includes('SELECT id, title, status, tag, workspace_root'))return stmt;return {get(...args){const value=stmt.get(...args);if(!locked&&!interleaved){interleaved=true;const done=tasks.readyTask(f.db,{id:f.item.id,actor:'fixture',proof:'fixture proof',claimGuard:f.guard});assert.equal(done.ready,true)}return value}}}};
  const tag=tasks.tagTask(wrapped,{id:f.item.id,actor:'human',add:['needs-human']});assert.equal(tag.tagged,true);
  const row=tasks.getTask(f.db,f.item.id);
  if(interleaved){assert.equal(row.status,'review');assert.equal(row.metadata.latest_agent_proof,'fixture proof');assert.equal(row.metadata.approval_status,'pending')}
  else {assert.equal(row.status,'claimed');assert.equal(row.metadata.tags[0],'needs-human');assert.equal(tasks.readyTask(f.db,{id:f.item.id,actor:'fixture',proof:'fixture proof',claimGuard:f.guard}).reason,'human_decision_required')}
  assert.equal(row.metadata.keep,'value');
});

test('tag no-ops, missing tasks and duplicates preserve existing outcomes without events', t=>{
  const f=fixture(t),before=snapshot(f);
  assert.deepEqual(tasks.tagTask(f.db,{id:f.item.id,add:[]}),{tagged:false,reason:'no_tags'});
  assert.deepEqual(tasks.tagTask(f.db,{id:'missing',add:['x']}),{tagged:false,reason:'not_found'});
  assert.deepEqual(tasks.tagTask(f.db,{id:f.item.id,remove:['absent']}),{tagged:false,reason:'no_changes',tags:[]});
  assert.deepEqual(snapshot(f),before);
  const first=tasks.tagTask(f.db,{id:f.item.id,add:[' Foo ','foo','bar'],remove:['bar']});
  assert.deepEqual(first.tags,['foo']);assert.deepEqual(first.added,['foo']);
  const after=snapshot(f);assert.deepEqual(tasks.tagTask(f.db,{id:f.item.id,add:['foo']}),{tagged:false,reason:'no_changes',tags:['foo']});assert.deepEqual(snapshot(f),after);
});

test('tag event failure rolls back both the changed row and its history', t=>{
  const f=fixture(t),before=snapshot(f);
  f.db.exec("CREATE TRIGGER reject_tag BEFORE INSERT ON task_events WHEN NEW.event_type='task_tags_updated' BEGIN SELECT RAISE(ABORT,'reject tag'); END");
  assert.throws(()=>tasks.tagTask(f.db,{id:f.item.id,add:['needs-human']}),/reject tag/);assert.deepEqual(snapshot(f),before);
  f.db.exec('BEGIN IMMEDIATE');f.db.exec('ROLLBACK');
});

test('nested tag call does not roll back the caller transaction', t=>{
  const f=fixture(t);f.db.exec('BEGIN IMMEDIATE');f.db.prepare('UPDATE tasks SET title=? WHERE id=?').run('caller edit',f.item.id);
  assert.throws(()=>tasks.tagTask(f.db,{id:f.item.id,add:['needs-human']}),/transaction/i);
  assert.equal(tasks.getTask(f.db,f.item.id).title,'caller edit');f.db.exec('ROLLBACK');assert.equal(tasks.getTask(f.db,f.item.id).title,'Synthetic task');
});

test('tag commit failure is uncertain both before and after commit', t=>{
  const f=fixture(t),before=snapshot(f);
  for(const commitFirst of [false,true]){
    const wrapped={prepare:sql=>f.db.prepare(sql),exec(sql){if(sql==='COMMIT'){if(commitFirst)f.db.exec(sql);throw Error('lost response')}return f.db.exec(sql)}};
    assert.throws(()=>tasks.tagTask(wrapped,{id:f.item.id,actor:'human',add:['needs-human']}),e=>e.code==='TASK_TAG_COMMIT_UNCERTAIN');
    if(!commitFirst)assert.deepEqual(snapshot(f),before);
    else {const after=snapshot(f);assert.deepEqual(JSON.parse(after.row.metadata).tags,['needs-human']);assert.equal(after.events.at(-1).event_type,'task_tags_updated');}
  }
});

for(const firstMode of ['tag','ready']) test(`actual tag and ready serialize ${firstMode} first at the same timestamp`,async t=>{
  const f=fixture(t),tick=f.db.prepare('SELECT updated_at FROM tasks WHERE id=?').get(f.item.id).updated_at;
  const worker=path.join(f.dir,'worker.cjs'),gate=path.join(f.dir,'gate'),started=path.join(f.dir,'started');
  fs.writeFileSync(worker,`
    const fs=require('node:fs'),t=require(${JSON.stringify(path.resolve(__dirname,'../lib/task-db'))});const d=t.open(process.env.FILE),mode=process.env.MODE,first=process.env.FIRST,id=process.env.ID;Date.now=()=>Number(process.env.TICK);
    const wrapped={exec(sql){if(sql==='BEGIN IMMEDIATE'&&mode!==first)fs.writeFileSync(process.env.STARTED,'yes');return d.exec(sql)},prepare(sql){
      if(mode===first&&sql.includes('INSERT INTO task_events')){process.send('holding');while(!fs.existsSync(process.env.GATE))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5)}return d.prepare(sql)}};
    process.send('started');process.on('message',()=>{try{const result=mode==='tag'?t.tagTask(wrapped,{id,actor:'human',add:['needs-human']}):t.readyTask(wrapped,{id,actor:'fixture',proof:'fixture proof',claimGuard:JSON.parse(process.env.GUARD)});process.send({result},()=>process.exit(0))}catch(e){process.send({error:String(e)},()=>process.exit(1))}});
  `);
  const {fork}=require('node:child_process');
  const spawn=mode=>{const env={...process.env,FILE:path.join(f.dir,'tasks.db'),MODE:mode,FIRST:firstMode,ID:f.item.id,TICK:String(tick),GUARD:JSON.stringify(f.guard),GATE:gate,STARTED:started,NODE_NO_WARNINGS:'1'};for(const key of Object.keys(env))if(/^(ANTHROPIC|OPENAI|GOOGLE_API|XAI|CLAUDE_CODE_OAUTH)/.test(key))delete env[key];
    const child=fork(worker,[],{env,stdio:['ignore','ignore','pipe','ipc']});let stderr='';child.stderr.on('data',c=>stderr+=c);const q=[],wait=[];child.on('message',x=>wait.length?wait.shift()(x):q.push(x));const next=()=>q.length?Promise.resolve(q.shift()):new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(stderr||'worker timeout')),10000);wait.push(x=>{clearTimeout(timer);resolve(x)})});t.after(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL')});return {child,next}};
  const a=spawn(firstMode),b=spawn(firstMode==='tag'?'ready':'tag');assert.equal(await a.next(),'started');assert.equal(await b.next(),'started');a.child.send('go');assert.equal(await a.next(),'holding');b.child.send('go');
  const deadline=Date.now()+5000;while(!fs.existsSync(started)){if(Date.now()>deadline)throw Error('second writer did not start');await new Promise(r=>setTimeout(r,5))}fs.writeFileSync(gate,'go');
  const [x,y]=await Promise.all([a.next(),b.next()]);assert.ok(!x.error&&!y.error,JSON.stringify([x,y]));const tag=firstMode==='tag'?x.result:y.result,ready=firstMode==='ready'?x.result:y.result;
  assert.equal(tag.tagged,true);assert.equal(ready.ready,firstMode==='ready');if(firstMode==='tag')assert.equal(ready.reason,'human_decision_required');
  const row=tasks.getTask(f.db,f.item.id);assert.equal(row.metadata.keep,'value');assert.ok(row.metadata.tags.includes('needs-human'));
  if(firstMode==='ready'){assert.equal(row.status,'review');assert.equal(row.metadata.approval_status,'pending');assert.equal(row.metadata.latest_agent_proof,'fixture proof')}
  else assert.equal(row.status,'claimed');
  const events=snapshot(f).events.map(e=>e.event_type);assert.equal(events.filter(e=>e==='task_tags_updated').length,1);assert.equal(events.filter(e=>e==='proof_ready').length,firstMode==='ready'?1:0);
});
