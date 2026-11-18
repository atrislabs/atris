'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const tasks = require('../lib/task-db');
const snapshots = require('../lib/task-acceptance-episodes');
const cli = path.join(__dirname, '../bin/atris.js');
function fixture(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'atris-accept-episode-'));
  const ws=path.join(fs.realpathSync(dir),'workspace'), home=path.join(dir,'home'), file=path.join(dir,'tasks.db');
  fs.mkdirSync(path.join(ws,'atris'),{recursive:true}); fs.mkdirSync(home);
  const db=tasks.open(file); const row=tasks.addTask(db,{title:'Synthetic task',workspaceRoot:ws});
  tasks.claimTask(db,{id:row.id,claimedBy:'builder'}); tasks.readyTask(db,{id:row.id,actor:'builder',proof:'1 file changed, 2 insertions. Verified with node scripts/verify.js exit 0. The implementation is complete and recorded for human inspection.'});
  t.after(()=>{tasks.close();fs.rmSync(dir,{recursive:true,force:true})});
  return {dir,ws,home,file,db,id:row.id};
}
function accept(f, overrides={}) {return tasks.acceptTask(f.db,{id:f.id,witness:tasks.captureCertifyTask(f.db,f.id).witness,actor:'human',reward:2,lesson:'Lesson',proof:'Proof',...overrides});}
function inspect(f,eventId,override={}) {return tasks.inspectAcceptanceEpisode(f.db,{eventId,taskId:f.id,workspaceRoot:f.ws,...override});}
function rows(f) {return [tasks.getTask(f.db,f.id),tasks.listTaskEvents(f.db,{taskId:f.id})];}
function dropProtection(f) {for(const action of ['delete','replace','update']) f.db.exec(`DROP TRIGGER task_acceptance_episodes_no_${action}`);}
function restoreProtection(f) {for(const action of ['delete','replace','update']) {const when=action==='replace'?'BEFORE INSERT':`BEFORE ${action.toUpperCase()}`;const condition=action==='replace'?' WHEN EXISTS (SELECT 1 FROM task_acceptance_episodes WHERE event_id = NEW.event_id)':'';f.db.exec(`CREATE TRIGGER task_acceptance_episodes_no_${action} ${when} ON task_acceptance_episodes${condition} BEGIN SELECT RAISE(ABORT, 'acceptance episodes are immutable'); END`);}}
for (const version of [2,3,4]) test(`version ${version} captures exact append without changing version`,t=>{
 const f=fixture(t); f.db.exec(`PRAGMA user_version = ${version}`); assert.equal(inspect(f,'missing'),null);
 const result=accept(f); const actual=fs.readFileSync(path.join(f.ws,'.atris','state','task_episodes.jsonl'));
 assert.deepEqual(inspect(f,result.event.event_id),actual); assert.deepEqual(actual,Buffer.from(JSON.stringify(result.episode)+'\n'));
 assert.equal(f.db.prepare('PRAGMA user_version').get().user_version,version);
 assert.equal(inspect(f,result.event.event_id,{workspaceRoot:path.join(f.dir,'other')}),null);
 assert.equal(inspect(f,result.event.event_id,{taskId:'other'}),null);
 f.db.prepare('UPDATE tasks SET title=? WHERE id=?').run('Later edit',f.id);assert.deepEqual(inspect(f,result.event.event_id),actual);
 assert.equal(JSON.stringify(tasks.taskProjection(f.db,{workspaceRoot:f.ws})).includes('episode_bytes'),false);
 assert.equal(JSON.stringify(tasks.listTaskEvents(f.db,{taskId:f.id})).includes('episode_bytes'),false);
 assert.throws(()=>f.db.prepare('UPDATE task_acceptance_episodes SET sha256=?').run('x'),/immutable/);
 assert.throws(()=>f.db.prepare('DELETE FROM task_acceptance_episodes').run(),/immutable/);
 assert.throws(()=>f.db.prepare('INSERT OR REPLACE INTO task_acceptance_episodes SELECT * FROM task_acceptance_episodes').run(),/immutable/);
});
test('process death before append leaves exact original bytes in database',t=>{
 const f=fixture(t), hook=path.join(f.dir,'kill.js');
 fs.writeFileSync(hook,`const fs=require('fs');const old=fs.appendFileSync;fs.appendFileSync=function(p,...args){if(String(p).endsWith('task_episodes.jsonl'))process.kill(process.pid,'SIGKILL');return old.call(this,p,...args)};`);
 const out=spawnSync(process.execPath,[cli,'task','accept',f.id,'--as','human','--accept-unverified','--reason','Manual synthetic check','--json'],{cwd:f.ws,env:{...process.env,HOME:f.home,ATRIS_TASKS_DB:f.file,ATRIS_SKIP_UPDATE_CHECK:'1',NODE_NO_WARNINGS:'1',NODE_OPTIONS:`--require=${hook}`},encoding:'utf8',timeout:20000});
 assert.equal(out.signal,'SIGKILL',JSON.stringify(out)); assert.equal(fs.existsSync(path.join(f.ws,'.atris','state','task_episodes.jsonl')),false);
 const current=rows(f); assert.equal(current[0].status,'done');const event=current[1].at(-1);const bytes=inspect(f,event.event_id);const obj=JSON.parse(bytes);assert.match(obj.proof,/Verified with/);assert.equal(obj.state.title,'Synthetic task');
 f.db.prepare('UPDATE tasks SET title=? WHERE id=?').run('Changed later',f.id); assert.deepEqual(inspect(f,event.event_id),bytes);
});
test('conflicting schema rolls back the entire decision',t=>{
 const f=fixture(t);f.db.exec('CREATE TABLE task_acceptance_episodes (event_id TEXT)');const before=rows(f);assert.throws(()=>accept(f),/schema/);assert.deepEqual(rows(f),before);
});
test('unexpected trigger or index blocks write and read',t=>{
 const f=fixture(t);const r=accept(f);f.db.exec('CREATE INDEX additional_snapshot_index ON task_acceptance_episodes(task_id)');assert.throws(()=>inspect(f,r.event.event_id),/schema/);
});
test('failure inserting the saved episode rolls back decision and events',t=>{
 const f=fixture(t),before=rows(f);const original=f.db;const db={exec:sql=>original.exec(sql),prepare(sql){if(sql.startsWith('INSERT INTO main.task_acceptance_episodes')) throw Error('synthetic insert failure');return original.prepare(sql)}};
 assert.throws(()=>tasks.acceptTask(db,{id:f.id,witness:tasks.captureCertifyTask(f.db,f.id).witness,actor:'human',reward:1,proof:'proof'}),/synthetic insert failure/);assert.deepEqual(rows(f),before);
 assert.equal(f.db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name='task_acceptance_episodes'").get().n,0);
});
test('oversized episode rolls back decision and events',t=>{
 const f=fixture(t),before=rows(f);assert.throws(()=>accept(f,{lesson:'x'.repeat(snapshots.MAX_EPISODE_BYTES)}),/size limit/);assert.deepEqual(rows(f),before);
});
for(const kind of ['bytes','digest','event','task-workspace']) test(`inspector rejects altered ${kind}`,t=>{
 const f=fixture(t),r=accept(f); if(kind==='event') f.db.prepare('UPDATE task_events SET task_id=? WHERE event_id=?').run('different',r.event.event_id);
 else if(kind==='task-workspace') f.db.prepare('UPDATE tasks SET workspace_root=? WHERE id=?').run('/other',f.id);
 else {dropProtection(f);f.db.prepare(kind==='bytes'?"UPDATE task_acceptance_episodes SET episode_bytes=x'80'":"UPDATE task_acceptance_episodes SET sha256='bad'").run();restoreProtection(f);}
 assert.throws(()=>inspect(f,r.event.event_id),/Invalid saved acceptance episode/);
});
test('missing event or missing table is unavailable and invalid input is rejected',t=>{
 const f=fixture(t);assert.equal(inspect(f,'none'),null);assert.throws(()=>tasks.inspectAcceptanceEpisode(f.db,{eventId:'x',taskId:f.id}),/identity/);
 const r=accept(f);f.db.prepare('DELETE FROM task_events WHERE event_id=?').run(r.event.event_id);assert.throws(()=>inspect(f,r.event.event_id),/Invalid saved/);
});
test('inspector rejects ambiguous joined event records',t=>{
 const f=fixture(t),r=accept(f);f.db.exec('ALTER TABLE task_events RENAME TO old_task_events');f.db.exec('CREATE TABLE task_events AS SELECT * FROM old_task_events');f.db.prepare('INSERT INTO task_events SELECT * FROM old_task_events WHERE event_id=?').run(r.event.event_id);
 assert.throws(()=>inspect(f,r.event.event_id),/Invalid saved/);
});
test('inspector rejects oversized and invalid UTF-8 data even with matching digest',t=>{
 const f=fixture(t),r=accept(f);dropProtection(f);let bytes=Buffer.alloc(snapshots.MAX_EPISODE_BYTES+1,65);let hash=require('node:crypto').createHash('sha256').update(bytes).digest('hex');
 f.db.prepare('UPDATE task_acceptance_episodes SET episode_bytes=?, sha256=?').run(bytes,hash);restoreProtection(f);assert.throws(()=>inspect(f,r.event.event_id),/Invalid saved/);
 dropProtection(f);bytes=Buffer.from([0x80,0x0a]);hash=require('node:crypto').createHash('sha256').update(bytes).digest('hex');f.db.prepare('UPDATE task_acceptance_episodes SET episode_bytes=?, sha256=?').run(bytes,hash);restoreProtection(f);assert.throws(()=>inspect(f,r.event.event_id));
});
test('inspector rejects invalid and oversized identity input',t=>{
 const f=fixture(t);for(const eventId of ['x\0y','\ud800','x'.repeat(16385)]) assert.throws(()=>inspect(f,eventId),/identity/);
});
test('mismatched episode cannot be saved even with the matching event',t=>{
 const f=fixture(t),r=accept(f),bytes=Buffer.from(JSON.stringify({...r.episode,task_id:'another'})+'\n');assert.throws(()=>snapshots.save(f.db,r.event,f.ws,bytes),/Invalid saved/);
});
test('corrupt trigger definitions fail closed',t=>{
 const f=fixture(t),r=accept(f);f.db.exec('DROP TRIGGER task_acceptance_episodes_no_update');f.db.exec('CREATE TRIGGER task_acceptance_episodes_no_update BEFORE UPDATE ON task_acceptance_episodes BEGIN SELECT 1; END');assert.throws(()=>inspect(f,r.event.event_id),/schema/);
});
for (const field of ['task_id','workspace_root','event_type']) test(`inspector rejects oversized event ${field}`,t=>{
 const f=fixture(t),r=accept(f);f.db.prepare(`UPDATE task_events SET ${field}=? WHERE event_id=?`).run('x'.repeat(2*1024*1024),r.event.event_id);assert.throws(()=>inspect(f,r.event.event_id),/Invalid saved/);
});
test('inspector rejects oversized task workspace',t=>{
 const f=fixture(t),r=accept(f);f.db.prepare('UPDATE tasks SET workspace_root=? WHERE id=?').run('x'.repeat(2*1024*1024),f.id);assert.throws(()=>inspect(f,r.event.event_id),/Invalid saved/);
});
for (const table of ['task_events','tasks']) test(`inspector rejects a wrong-case ${table} join`,t=>{
 const f=fixture(t),r=accept(f);const idColumn=table==='tasks'?'id':'event_id';
 f.db.exec(`ALTER TABLE ${table} RENAME TO original_${table}`);
 const info=f.db.prepare(`PRAGMA table_info(original_${table})`).all();
 f.db.exec(`CREATE TABLE ${table} (${info.map(c=>`${c.name} ${c.name===idColumn?'TEXT COLLATE NOCASE':c.type}`).join(', ')})`);
 f.db.exec(`INSERT INTO ${table} SELECT * FROM original_${table}`);
 f.db.prepare(`UPDATE ${table} SET ${idColumn}=lower(${idColumn}) WHERE ${idColumn}=?`).run(table==='tasks'?f.id:r.event.event_id);
 assert.throws(()=>inspect(f,r.event.event_id),/Invalid saved/);
});
for(const table of ['task_acceptance_episodes','tasks','task_events']) test(`temporary ${table} shadow cannot bypass the durable decision`,t=>{
 const f=fixture(t);f.db.exec(`CREATE TEMP TABLE ${table} (id TEXT)`);const before=f.db.prepare('SELECT status FROM main.tasks WHERE id=?').get(f.id).status;
 assert.throws(()=>accept(f));assert.equal(f.db.prepare('SELECT status FROM main.tasks WHERE id=?').get(f.id).status,before);
});
test('temporary trigger cannot alter acceptance',t=>{
 const f=fixture(t);f.db.exec("CREATE TEMP TRIGGER shadow_trigger BEFORE UPDATE ON main.tasks BEGIN SELECT 1; END");const before=rows(f);assert.throws(()=>accept(f),/temporary task schema/);assert.deepEqual(rows(f),before);
});
test('oversized schema objects are rejected without returning their SQL to JavaScript',t=>{
 const f=fixture(t),r=accept(f);f.db.exec(`CREATE TRIGGER oversized_snapshot_trigger BEFORE UPDATE ON task_acceptance_episodes BEGIN SELECT '${'x'.repeat(20000)}'; END`);assert.throws(()=>inspect(f,r.event.event_id),/schema/);
});
test('many extra schema objects are rejected',t=>{
 const f=fixture(t),r=accept(f);for(let i=0;i<10;i++) f.db.exec(`CREATE INDEX extra_snapshot_${i} ON task_acceptance_episodes(task_id)`);assert.throws(()=>inspect(f,r.event.event_id),/schema/);
});
test('large temporary trigger is rejected without returning its SQL',t=>{
 const f=fixture(t),r=accept(f);f.db.exec(`CREATE TEMP TRIGGER temporary_large BEFORE UPDATE ON main.tasks BEGIN SELECT '${'x'.repeat(20000)}'; END`);assert.throws(()=>inspect(f,r.event.event_id),/temporary task schema/);
});
