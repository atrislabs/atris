'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const tasks = require('../lib/task-db');
const cli = path.join(__dirname, '../bin/atris.js');
function fixture(t, verify = 'node scripts/verify.js') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-accept-atomic-'));
  const ws = path.join(fs.realpathSync(dir), 'workspace'), home = path.join(dir, 'home'), file = path.join(dir, 'tasks.db');
  fs.mkdirSync(path.join(ws, 'scripts'), {recursive:true}); fs.mkdirSync(path.join(ws, 'atris'), {recursive:true}); fs.mkdirSync(home);
  fs.writeFileSync(path.join(ws, 'scripts/verify.js'), `const fs=require('fs'); if(process.env.ACCEPT_WAIT){fs.writeFileSync('started','yes'); const i=setInterval(()=>{if(fs.existsSync('release')){clearInterval(i);process.exit(0)}},5)}`);
  const db=tasks.open(file); const row=tasks.addTask(db,{title:'Synthetic review',workspaceRoot:ws,metadata:{verify}});
  tasks.claimTask(db,{id:row.id,claimedBy:'builder'});
  tasks.readyTask(db,{id:row.id,actor:'builder',proof:'1 file changed, 2 insertions. Verified with node scripts/verify.js exit 0. The implementation is complete and recorded for human inspection.',lesson:'Existing lesson',nextTask:'Follow-up'});
  const env={...process.env,HOME:home,XDG_CONFIG_HOME:path.join(home,'.config'),XDG_CACHE_HOME:path.join(home,'.cache'),ATRIS_TASKS_DB:file,ATRIS_SKIP_UPDATE_CHECK:'1',NODE_NO_WARNINGS:'1'};
  t.after(()=>{tasks.close();fs.rmSync(dir,{recursive:true,force:true})}); return {dir,ws,db,id:row.id,env};
}
function start(f, extra={}, args=[]) {
  const child=spawn(process.execPath,[cli,'task','accept',f.id,'--as','human','--json',...args],{cwd:f.ws,env:{...f.env,...extra},stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
  const done=new Promise(resolve=>child.on('close',code=>resolve({code,stdout,stderr}))); return {child,done};
}
async function waitStarted(f, flight) {
  const limit=Date.now()+12000;while(!fs.existsSync(path.join(f.ws,'started'))) {if(flight.child.exitCode!==null) throw new Error('exited before check: '+JSON.stringify(await flight.done));if(Date.now()>limit) throw new Error('check did not start');await new Promise(r=>setTimeout(r,10));}
}
function state(f) { return {row:tasks.getTask(f.db,f.id),events:tasks.listTaskEvents(f.db,{taskId:f.id})}; }
function decide(f, db=f.db, witness=tasks.captureCertifyTask(f.db,f.id).witness) {return tasks.acceptTask(db,{id:f.id,witness,actor:'human',reward:2,lesson:'Lesson',nextTask:'Next',proof:'Recorded proof'});}
for(const change of ['revision','proof','event','metadata','workspace']) test(`human acceptance rejects ${change} during a running check`,async t=>{
  const f=fixture(t), flight=start(f,{ACCEPT_WAIT:'1'});t.after(()=>{if(flight.child.exitCode===null) flight.child.kill()}); await waitStarted(f,flight);
  if(change==='revision') tasks.reviseTask(f.db,{id:f.id,actor:'human',note:'change'});
  if(change==='proof') tasks.readyTask(f.db,{id:f.id,actor:'builder',proof:'New proof'});
  if(change==='event') tasks.noteTask(f.db,{id:f.id,actor:'human',content:'new note'});
  if(change==='metadata') f.db.prepare("UPDATE tasks SET metadata=json_set(metadata,'$.extra','changed') WHERE id=?").run(f.id);
  if(change==='workspace') f.db.prepare('UPDATE tasks SET workspace_root=? WHERE id=?').run(path.join(f.dir,'elsewhere'),f.id);
  const before=state(f);fs.writeFileSync(path.join(f.ws,'release'),'go');const out=await flight.done;
  assert.notEqual(out.code,0,JSON.stringify(out));assert.match(out.stdout+out.stderr,/changed|incomplete/i);assert.deepEqual(state(f),before);
});
test('success preserves recorded review, reward, lesson and next',async t=>{
 const f=fixture(t), out=await start(f,{},['--reward','3','--lesson','Useful lesson','--next','Next step']).done;assert.equal(out.code,0,out.stderr);
 const result=JSON.parse(out.stdout), current=state(f);assert.equal(current.row.status,'done');assert.equal(current.row.metadata.approval_status,'accepted');assert.equal(result.episode.reward.value,3);
 assert.deepEqual(current.events.slice(-2).map(e=>e.event_type),['completed','reviewed']); const payload=current.events.at(-1).payload;assert.equal(payload.lesson,'Useful lesson');assert.equal(payload.next_task,'Next step');assert.equal(payload.career_xp_eligible,true);
 const episode=JSON.parse(fs.readFileSync(path.join(f.ws,'.atris','state','task_episodes.jsonl'),'utf8').trim());assert.equal(episode.episode_id,current.events.at(-1).event_id);
});
test('deliberate unverified override preserves acceptance',async t=>{
 const f=fixture(t,'true'), blocked=await start(f).done;assert.notEqual(blocked.code,0);const out=await start(f,{},['--accept-unverified','--reason','Manual inspection']).done;assert.equal(out.code,0,out.stderr);assert.equal(state(f).row.status,'done');
});
test('competing decisions cannot both commit',async t=>{
 const f=fixture(t), flight=start(f,{ACCEPT_WAIT:'1'});t.after(()=>{if(flight.child.exitCode===null)flight.child.kill()});await waitStarted(f,flight);assert.equal(decide(f).accepted,true);const before=state(f);fs.writeFileSync(path.join(f.ws,'release'),'go');const result=await flight.done;assert.notEqual(result.code,0);assert.deepEqual(state(f),before);assert.equal(before.events.filter(e=>e.event_type==='reviewed').length,1);
 const event=before.events.find(e=>e.event_type==='reviewed');const snapshots=f.db.prepare('SELECT event_id FROM main.task_acceptance_episodes').all();assert.equal(snapshots.length,1);assert.equal(snapshots[0].event_id,event.event_id);assert.deepEqual(tasks.inspectAcceptanceEpisode(f.db,{eventId:event.event_id,taskId:f.id,workspaceRoot:f.ws}),fs.readFileSync(path.join(f.ws,'.atris','state','task_episodes.jsonl')));
});
for(const name of ['completed','reviewed']) test(`${name} failure rolls back acceptance`,t=>{
 const f=fixture(t), before=state(f);f.db.exec(`CREATE TRIGGER reject_event BEFORE INSERT ON task_events WHEN NEW.event_type = '${name}' BEGIN SELECT RAISE(ABORT, 'event failed'); END`);assert.throws(()=>decide(f),/event failed/);assert.deepEqual(state(f),before);
});
for(const committed of [false,true]) test(`unknown commit outcome is reported ${committed?'after':'before'} commit`,t=>{
 const f=fixture(t), witness=tasks.captureCertifyTask(f.db,f.id).witness;const db={prepare:sql=>f.db.prepare(sql),exec(sql){if(sql==='COMMIT'){if(committed)f.db.exec(sql);throw Error('lost response')}return f.db.exec(sql)}};
 assert.throws(()=>decide(f,db,witness),e=>e.code==='TASK_ACCEPTANCE_COMMIT_UNCERTAIN' && /unknown/.test(e.message));const current=state(f);assert.equal(current.row.status,committed?'done':'review');assert.equal(current.events.filter(e=>e.event_type==='reviewed').length,committed?1:0);
 const exists=f.db.prepare("SELECT count(*) AS n FROM main.sqlite_schema WHERE name='task_acceptance_episodes'").get().n;assert.equal(exists,committed?1:0);if(committed){const event=current.events.find(e=>e.event_type==='reviewed');const bytes=tasks.inspectAcceptanceEpisode(f.db,{eventId:event.event_id,taskId:f.id,workspaceRoot:f.ws});assert.ok(bytes);assert.equal(fs.existsSync(path.join(f.ws,'.atris','state','task_episodes.jsonl')),false);}
});
for(const effect of ['logs','episode']) test(`${effect} failure reports committed decision`,t=>{
 const f=fixture(t);if(effect==='logs')fs.writeFileSync(path.join(f.ws,'atris','logs'),'blocked');else fs.mkdirSync(path.join(f.ws,'.atris','state'),{recursive:true});
 if(effect==='episode'){fs.mkdirSync(path.join(f.ws,'.atris','state','task_episodes.jsonl'));}
 assert.throws(()=>decide(f),e=>e.code==='TASK_ACCEPTANCE_EFFECTS_UNCERTAIN'&&e.acceptanceCommitted&&/do not accept again blindly/i.test(e.message));assert.equal(state(f).row.status,'done');assert.deepEqual(state(f).events.slice(-2).map(e=>e.event_type),['completed','reviewed']);
});
test('malformed and incomplete histories are refused without writes',t=>{
 const f=fixture(t);f.db.prepare("UPDATE task_events SET payload = '{' WHERE task_id=? AND version=1").run(f.id);const before=state(f);assert.equal(tasks.captureCertifyTask(f.db,f.id),null);assert.equal(decide(f,f.db,'invalid').accepted,false);assert.deepEqual(state(f),before);
});
test('exact foreign task is refused before running its verifier',async t=>{
 const f=fixture(t), other=path.join(f.dir,'other');fs.mkdirSync(path.join(other,'atris'),{recursive:true});fs.mkdirSync(path.join(other,'scripts'));fs.writeFileSync(path.join(other,'scripts','verify.js'),"require('fs').writeFileSync('wrong-check','ran')");
 const before=state(f),out=await new Promise(resolve=>{const c=spawn(process.execPath,[cli,'task','accept',f.id,'--as','human','--json'],{cwd:other,env:f.env,stdio:['ignore','pipe','pipe']});let stdout='',stderr='';c.stdout.on('data',x=>stdout+=x);c.stderr.on('data',x=>stderr+=x);c.on('close',code=>resolve({code,stdout,stderr}));});assert.notEqual(out.code,0);assert.match(out.stdout+out.stderr,/workspace/i);assert.equal(fs.existsSync(path.join(other,'wrong-check')),false);assert.deepEqual(state(f),before);
});
test('direct acceptance refuses invalid reward and empty proof',t=>{
 const f=fixture(t),before=state(f),witness=tasks.captureCertifyTask(f.db,f.id).witness;
 for(const [reward,proof] of [[0,'proof'],[-1,'proof'],[Infinity,'proof'],[1,'']]) assert.equal(tasks.acceptTask(f.db,{id:f.id,witness,actor:'human',reward,proof}).accepted,false);
 assert.deepEqual(state(f),before);
});
test('nullable legacy payloads are supported and excessive task content is rejected',t=>{
 const f=fixture(t);f.db.prepare('UPDATE task_events SET payload=NULL WHERE task_id=? AND version=1').run(f.id);assert.ok(tasks.captureCertifyTask(f.db,f.id));
 f.db.prepare('UPDATE tasks SET title=? WHERE id=?').run('x'.repeat(8*1024*1024+1),f.id);assert.equal(tasks.captureCertifyTask(f.db,f.id),null);
});
test('CLI reports post-commit failure as a committed acceptance',async t=>{
 const f=fixture(t);fs.writeFileSync(path.join(f.ws,'atris','logs'),'blocked');const out=await start(f).done;assert.notEqual(out.code,0);assert.match(out.stdout+out.stderr,/acceptance committed/i);assert.match(out.stdout+out.stderr,/do not accept again blindly/i);assert.equal(state(f).row.status,'done');assert.deepEqual(state(f).events.slice(-2).map(e=>e.event_type),['completed','reviewed']);
});

test('malformed raw actor and row fields cannot authorize acceptance',t=>{
 const f=fixture(t);const before=state(f);
 f.db.exec("UPDATE task_events SET actor=x'80' WHERE version=1");assert.equal(tasks.captureCertifyTask(f.db,f.id),null);
 f.db.prepare('UPDATE task_events SET actor=NULL WHERE task_id=? AND version=1').run(f.id);assert.ok(tasks.captureCertifyTask(f.db,f.id));
 f.db.prepare("UPDATE tasks SET claimed_by=x'80' WHERE id=?").run(f.id);assert.equal(tasks.captureCertifyTask(f.db,f.id),null);
 assert.equal(tasks.acceptTask(f.db,{id:f.id,witness:'bad',actor:'human',reward:1,proof:'proof'}).accepted,false);assert.equal(tasks.getTask(f.db,f.id).status,before.row.status);
});

test('invalid UTF-8 stored as text cannot collide in the witness',t=>{
 const f=fixture(t);f.db.exec("UPDATE task_events SET actor=CAST(x'80' AS TEXT) WHERE version=1");assert.equal(tasks.captureCertifyTask(f.db,f.id),null);
 f.db.exec("UPDATE task_events SET actor=CAST(x'81' AS TEXT) WHERE version=1");assert.equal(tasks.captureCertifyTask(f.db,f.id),null);
});

for(const json of [false,true]) test(`CLI reports XP failure after committed acceptance (${json?'json':'text'})`,async t=>{
 const f=fixture(t),hook=path.join(f.dir,'hook.js');fs.writeFileSync(hook,`const Module=require('module');const old=Module._load;Module._load=function(request,...args){if(request==='../commands/xp')return {collectLocalXpProjection(){throw Error('synthetic xp failure')}};return old.call(this,request,...args)};`);
 const args=['task','accept',f.id,'--as','human',...(json?['--json']:[])];const out=await new Promise(resolve=>{const c=spawn(process.execPath,[cli,...args],{cwd:f.ws,env:{...f.env,NODE_OPTIONS:'--require='+hook},stdio:['ignore','pipe','pipe']});let stdout='',stderr='';c.stdout.on('data',x=>stdout+=x);c.stderr.on('data',x=>stderr+=x);c.on('close',code=>resolve({code,stdout,stderr}));});
 assert.equal(out.code,1);assert.match(out.stderr,/acceptance committed.*XP refresh failed/i);assert.match(out.stderr,/do not accept again blindly/i);if(json){const result=JSON.parse(out.stdout);assert.equal(result.ok,true);assert.equal(result.xp_projection.ok,false);}else assert.match(out.stdout,/XP refresh failed/i);assert.equal(state(f).row.status,'done');
});

for(const table of ['tasks','task_events']) test(`unexpected ${table} columns fail closed`,t=>{
 const f=fixture(t);f.db.exec(`ALTER TABLE ${table} ADD COLUMN extra TEXT`);assert.equal(tasks.captureCertifyTask(f.db,f.id),null);
});
