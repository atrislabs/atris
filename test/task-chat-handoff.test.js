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

for(const firstMode of ['chat','ready']) test(`actual chat and ready serialize ${firstMode} first at the same timestamp`,async t=>{
  const f=fixture(t),tick=f.db.prepare('SELECT updated_at FROM tasks WHERE id=?').get(f.item.id).updated_at;
  const worker=path.join(f.dir,'worker.cjs'),gate=path.join(f.dir,'gate'),started=path.join(f.dir,'started');
  fs.writeFileSync(worker,`
    const fs=require('node:fs'),t=require(${JSON.stringify(path.resolve(__dirname,'../lib/task-db'))});const d=t.open(process.env.FILE),mode=process.env.MODE,first=process.env.FIRST,id=process.env.ID;Date.now=()=>Number(process.env.TICK);
    const wrapped={exec(sql){if(sql==='BEGIN IMMEDIATE'&&mode!==first)fs.writeFileSync(process.env.STARTED,'yes');return d.exec(sql)},prepare(sql){
      if(mode===first&&sql.includes('INSERT INTO task_events')){process.send('holding');while(!fs.existsSync(process.env.GATE))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5)}return d.prepare(sql)}};
    process.send('started');process.on('message',()=>{try{const result=mode==='chat'?t.chatTask(wrapped,{id,actor:'human',goal:'New goal',summary:'New summary'}):t.readyTask(wrapped,{id,actor:'fixture',proof:'fixture proof',claimGuard:JSON.parse(process.env.GUARD)});process.send({result},()=>process.exit(0))}catch(e){process.send({error:String(e)},()=>process.exit(1))}});
  `);
  const {fork}=require('node:child_process');
  const spawn=mode=>{const env={...process.env,FILE:path.join(f.dir,'tasks.db'),MODE:mode,FIRST:firstMode,ID:f.item.id,TICK:String(tick),GUARD:JSON.stringify(f.guard),GATE:gate,STARTED:started,NODE_NO_WARNINGS:'1'};for(const key of Object.keys(env))if(/^(ANTHROPIC|OPENAI|GOOGLE_API|XAI|CLAUDE_CODE_OAUTH)/.test(key))delete env[key];
    const child=fork(worker,[],{env,stdio:['ignore','ignore','pipe','ipc']});let stderr='';child.stderr.on('data',c=>stderr+=c);const q=[],wait=[];child.on('message',x=>wait.length?wait.shift()(x):q.push(x));const next=()=>q.length?Promise.resolve(q.shift()):new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(stderr||'worker timeout')),10000);wait.push(x=>{clearTimeout(timer);resolve(x)})});t.after(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL')});return {child,next}};
  const a=spawn(firstMode),b=spawn(firstMode==='chat'?'ready':'chat');assert.equal(await a.next(),'started');assert.equal(await b.next(),'started');a.child.send('go');assert.equal(await a.next(),'holding');b.child.send('go');
  const deadline=Date.now()+5000;while(!fs.existsSync(started)){if(Date.now()>deadline)throw Error('second writer did not start');await new Promise(r=>setTimeout(r,5))}fs.writeFileSync(gate,'go');
  const [x,y]=await Promise.all([a.next(),b.next()]);assert.ok(!x.error&&!y.error,JSON.stringify([x,y]));const chat=firstMode==='chat'?x.result:y.result,ready=firstMode==='ready'?x.result:y.result;
  assert.equal(chat.chatted,true);assert.equal(ready.ready,firstMode==='ready');if(firstMode==='chat')assert.equal(ready.reason,'stale_claim');
  const row=tasks.getTask(f.db,f.item.id);assert.equal(row.metadata.keep,'value');assert.equal(row.metadata.task_goal,'New goal');assert.equal(row.metadata.task_summary,'New summary');
  if(firstMode==='ready'){assert.equal(row.status,'review');assert.equal(row.metadata.approval_status,'pending');assert.equal(row.metadata.latest_agent_proof,'fixture proof')}
  else assert.equal(row.status,'claimed');
  const events=snapshot(f).events.map(e=>e.event_type);assert.equal(events.filter(e=>e==='task_chat').length,1);assert.equal(events.filter(e=>e==='proof_ready').length,firstMode==='ready'?1:0);
});

test('only well-formed content-only chat allows guarded ready; cleanup remains possible',t=>{
  for(const args of [{content:'A normal message'},{goal:'New goal'},{summary:'New summary'}]){
    const f=fixture(t),result=tasks.chatTask(f.db,{id:f.item.id,actor:'human',...args});assert.equal(result.chatted,true);
    const ready=tasks.readyTask(f.db,{id:f.item.id,actor:'fixture',proof:'fixture proof',claimGuard:f.guard});
    if(args.content)assert.equal(ready.ready,true);else {assert.equal(ready.reason,'stale_claim');assert.equal(tasks.releaseTask(f.db,{id:f.item.id,actor:'fixture',claimGuard:f.guard}).released,true)}
    tasks.close();
  }
});

for(const payload of [null,'{','[]','{}',JSON.stringify({goal:null,summary:null,content:'hello'}),
  JSON.stringify({goal:null,summary:null,content:'hello',previous_goal:'old',chat_packet:'TASK_CHAT_UPDATE\nmessage: hello'}),
  JSON.stringify({goal:null,summary:null,content:'hello',previous_goal:null,chat_packet:'TASK_CHAT_UPDATE\ngoal: changed'}),
  JSON.stringify({goal:null,summary:null,content:'hello',previous_goal:null,chat_packet:'TASK_CHAT_UPDATE\nmessage: hello',extra:'changed'}),
  '{"goal":"changed","goal":null,"summary":null,"content":"hello","previous_goal":null,"chat_packet":"TASK_CHAT_UPDATE\\ncontent: hello"}'])
  test(`ambiguous chat evidence blocks guarded ready and permits cleanup: ${String(payload).slice(0,30)}`,t=>{
    const f=fixture(t);const event=tasks.chatTask(f.db,{id:f.item.id,actor:'human',content:'hello'}).event;
    f.db.prepare('UPDATE task_events SET payload=? WHERE event_id=?').run(payload,event.event_id);
    const before=snapshot(f),ready=tasks.readyTask(f.db,{id:f.item.id,actor:'fixture',proof:'fixture proof',claimGuard:f.guard});
    assert.equal(ready.reason,'stale_claim');assert.deepEqual(snapshot(f),before);
    assert.equal(tasks.releaseTask(f.db,{id:f.item.id,actor:'fixture',claimGuard:f.guard}).released,true);
  });

test('chat event failure rolls back the task metadata and event',t=>{
  const f=fixture(t),before=snapshot(f);f.db.exec("CREATE TRIGGER reject_chat BEFORE INSERT ON task_events WHEN NEW.event_type='task_chat' BEGIN SELECT RAISE(ABORT,'reject chat'); END");
  assert.throws(()=>tasks.chatTask(f.db,{id:f.item.id,goal:'New goal'}),/reject chat/);assert.deepEqual(snapshot(f),before);
});

test('nested chat leaves the caller transaction intact',t=>{
  const f=fixture(t);f.db.exec('BEGIN IMMEDIATE');f.db.prepare('UPDATE tasks SET title=? WHERE id=?').run('caller edit',f.item.id);
  assert.throws(()=>tasks.chatTask(f.db,{id:f.item.id,content:'hello'}),/transaction/i);assert.equal(tasks.getTask(f.db,f.item.id).title,'caller edit');f.db.exec('ROLLBACK');
});

test('chat commit failure reports uncertainty before and after commit',t=>{
  const f=fixture(t),before=snapshot(f);for(const commitFirst of [false,true]){
    const wrapped={prepare:sql=>f.db.prepare(sql),exec(sql){if(sql==='COMMIT'){if(commitFirst)f.db.exec(sql);throw Error('lost response')}return f.db.exec(sql)}};
    assert.throws(()=>tasks.chatTask(wrapped,{id:f.item.id,goal:'New goal'}),e=>e.code==='TASK_CHAT_COMMIT_UNCERTAIN');
    if(!commitFirst)assert.deepEqual(snapshot(f),before);else {const after=snapshot(f);assert.equal(JSON.parse(after.row.metadata).task_goal,'New goal');assert.equal(after.events.at(-1).event_type,'task_chat');}
  }
});

test('chat keeps existing empty-input and missing-task outcomes without writes',t=>{
  const f=fixture(t),before=snapshot(f);
  assert.deepEqual(tasks.chatTask(f.db,{id:f.item.id}),{chatted:false,reason:'content_required'});
  assert.deepEqual(tasks.chatTask(f.db,{id:'missing',content:'hello'}),{chatted:false,reason:'not_found'});
  assert.deepEqual(snapshot(f),before);
});
