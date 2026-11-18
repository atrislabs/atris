'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const db = require('../lib/task-db');
const fleet = require('../lib/fleet');
const cliPath = path.resolve(__dirname, '../bin/atris.js');

function fixture(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-guard-')));
  const root = path.join(dir, 'project'); fs.mkdirSync(path.join(root, 'atris'), {recursive:true});
  const env = {...process.env, HOME:dir, ATRIS_TASKS_DB:path.join(dir, 'tasks.db'), ATRIS_SKIP_UPDATE_CHECK:'1', ATRIS_NO_INTERACTIVE:'1', ATRIS_NONINTERACTIVE:'1'};
  for (const key of Object.keys(env)) if (/^(ANTHROPIC|OPENAI|GOOGLE_API|XAI|CLAUDE_CODE_OAUTH)/.test(key)) delete env[key];
  let d = db.open(env.ATRIS_TASKS_DB); const task = db.addTask(d, {title:'Edit lib/example.js. Done: fixture works. Check: node --test test/example.test.js.', workspaceRoot:root}); db.close();
  function cli(args) { return spawnSync(process.execPath, [cliPath, ...args], {cwd:root, env, encoding:'utf8', timeout:20000}); }
  function read() { const d=db.open(env.ATRIS_TASKS_DB); try { return db.getTask(d,task.id); } finally { db.close(); } }
  function sql(sql, ...args) { const d=db.open(env.ATRIS_TASKS_DB); try { d.prepare(sql).run(...args); } finally { db.close(); } }
  const shown=cli(['task','show',task.id,'--json']); assert.equal(shown.status,0,shown.stderr); const projection=JSON.parse(shown.stdout);
  fs.mkdirSync(path.join(root,'.atris','state'), {recursive:true}); fs.writeFileSync(path.join(root,'.atris','state','tasks.projection.json'),JSON.stringify({tasks:[projection]}));
  const worker=path.join(dir,'worker'); fs.mkdirSync(worker);
  t.after(()=>{db.close();fs.rmSync(dir,{recursive:true,force:true});});
  return {dir,root,env,task,projection,worker,cli,read,sql};
}
function run(f, opts={}) {
  const calls=[]; const cli=opts.cli || ((args)=>f.cli(args));
  const ownCli=args=>{calls.push(args);if(args[0]==='worktree' && args[1]==='ship')return opts.ship ? opts.ship(args) : {status:1,stdout:'',stderr:'unexpected ship'};if(args[0]==='worktree')return opts.start ? opts.start(args) : {status:0,stdout:`next: cd ${f.worker}\n`,stderr:''};return cli(args);};
  return fleet.runFleetFlight({root:f.root, engines:opts.engines || ['codex'], checkoutBase:'HEAD', log:opts.log || (()=>{}), ownCli,
    dispatcher:opts.dispatcher || (async()=>({exitCode:0,report:'fixture'})), ...(opts.realLander ? {rebase:()=>({ok:true})} : {lander:opts.lander || (()=>({ok:true,stage:'shipped'}))}),
    guardCliLink:()=>({ok:true,changed:false})}).then(result=>({result,calls}));
}
function command(f,args){const r=f.cli(args);assert.equal(r.status,0,r.stderr);return r;}

test('fleet binds the canonical id and records its landing before the real CLI handoff', async t=>{
  const f=fixture(t);let provisional;
  const state=path.join(f.root,'.atris','state','tasks.projection.json');fs.writeFileSync(state,JSON.stringify({tasks:[{...f.projection,display_id:'OLD-99'}]}));
  const {result,calls}=await run(f,{dispatcher:async entry=>{assert.equal(entry.task.display_id,f.task.id);assert.match(fleet.buildFleetPrompt(entry.task,{worktreePath:f.worker}),new RegExp(f.task.id));assert.doesNotMatch(fleet.buildFleetPrompt(entry.task,{worktreePath:f.worker}),/OLD-99/);return {exitCode:0,report:'fixture'};},cli:args=>{if(args[1]==='ready'){const p=path.join(f.root,'atris','runs',fs.readdirSync(path.join(f.root,'atris','runs')).find(x=>x.endsWith('.json')));provisional=JSON.parse(fs.readFileSync(p,'utf8'));}return f.cli(args);}});
  assert.equal(provisional.landed[0].review_recorded,false);assert.equal(provisional.landed[0].task,f.task.id);assert.equal(result.staffed[0].task,f.task.id);assert.equal(provisional.landed[0].task_id,f.task.id);
  assert.equal(result.landed[0].review_recorded,true);assert.equal(f.read().status,'review');
  assert.ok(calls.some(a=>a[1]==='show' && a[2]===f.task.id && a.includes('--dispatch-snapshot')));
  assert.ok(calls.some(a=>a[1]==='claim' && a[2]===f.task.id && a.includes('--expected-task-snapshot')));
  assert.ok(calls.some(a=>a[1]==='ready' && a[2]===f.task.id && a.includes('--claim-guard')));
  assert.equal(JSON.parse(fs.readFileSync(result.receipt,'utf8')).landed[0].review_recorded,true);
});
for (const mutation of ['title','hold','workspace','missing-id','duplicate-id']) test(`fleet refuses changed ${mutation} before dispatch`,async t=>{
  const f=fixture(t);let dispatched=false;
  if(mutation==='title') f.sql('UPDATE tasks SET title=? WHERE id=?','Edit lib/other.js',f.task.id);
  if(mutation==='hold') f.sql('UPDATE tasks SET tag=? WHERE id=?','needs-human',f.task.id);
  if(mutation==='workspace') f.sql('UPDATE tasks SET workspace_root=? WHERE id=?',path.join(f.dir,'other'),f.task.id);
  if(mutation==='missing-id' || mutation==='duplicate-id') {const p=path.join(f.root,'.atris','state','tasks.projection.json');const row={...f.projection};if(mutation==='missing-id')delete row.id;fs.writeFileSync(p,JSON.stringify({tasks:mutation==='duplicate-id'?[row,row]:[row]}));}
  const {result,calls}=await run(f,{dispatcher:async()=>{dispatched=true;}});assert.equal(dispatched,false);assert.equal(result.paused[0].stage,'task_lookup');assert.equal(calls.some(a=>a[1]==='claim'),false);
});
test('fleet rejects a snapshot changed between show and claim',async t=>{
  const f=fixture(t);let dispatched=false;
  const {result}=await run(f,{cli:args=>{if(args[1]==='claim')f.sql('UPDATE tasks SET title=? WHERE id=?','Updated owner instructions',f.task.id);return f.cli(args);},dispatcher:async()=>{dispatched=true;}});
  assert.equal(dispatched,false);assert.equal(result.paused[0].stage,'claim');assert.equal(f.read().status,'open');
});
for (const mode of ['malformed','lost']) test(`fleet stops after ${mode} committed claim response`,async t=>{
  const f=fixture(t);let dispatched=false;
  const {result,calls}=await run(f,{cli:args=>{const r=f.cli(args);if(args[1]==='claim'){assert.equal(r.status,0,r.stderr);return mode==='malformed'?{status:0,stdout:'{}'}:{status:1,stdout:'',stderr:'lost'};}return r;},dispatcher:async()=>{dispatched=true;}});
  assert.equal(dispatched,false);assert.equal(result.paused[0].stage,'claim');assert.equal(f.read().status,'claimed');assert.equal(calls.some(a=>a[1]==='release'),false);
});
test('old flight cannot hand off a replacement same-actor claim',async t=>{
  const f=fixture(t);const {result,calls}=await run(f,{dispatcher:async()=>{command(f,['task','release',f.task.id,'--as','fleet-codex']);command(f,['task','claim',f.task.id,'--as','fleet-codex']);return {exitCode:0,report:'fixture'};}});
  assert.equal(result.landed[0].review_recorded,false);assert.equal(result.paused[0].stage,'task_ready');assert.equal(f.read().status,'claimed');assert.equal(calls.some(a=>a[1]==='release'),false);
});
for (const committed of [false,true]) test(`fleet preserves landing after ${committed?'committed but lost':'unconfirmed'} handoff`,async t=>{
  const f=fixture(t);let count=0;
  const {result,calls}=await run(f,{cli:args=>{if(args[1]==='ready'){count++;if(committed)command(f,args);throw Error('response lost');}return f.cli(args);}});
  assert.equal(count,1);assert.equal(result.landed[0].review_recorded,false);assert.equal(result.paused[0].stage,'task_ready');assert.equal(result.status,'failed');assert.equal(f.read().status,committed?'review':'claimed');assert.equal(calls.some(a=>a[1]==='release'),false);
  const receipt=JSON.parse(fs.readFileSync(result.receipt,'utf8'));assert.equal(receipt.status,'failed');assert.equal(receipt.landed[0].review_recorded,false);
});
test('fleet leaves a claim alone when worktree start outcome is lost',async t=>{
  const f=fixture(t);const {result,calls}=await run(f,{start:()=>{throw Error('lost');}});assert.equal(result.paused[0].stage,'worktree_start');assert.equal(f.read().status,'claimed');assert.equal(calls.some(a=>a[1]==='release'),false);
});
test('fleet will not hand off a landing when its provisional receipt fails',async t=>{
  const f=fixture(t);let fail=false;const original=fs.renameSync;fs.renameSync=function(a,b){if(fail && String(b).endsWith('.json')) throw Error('fixture disk failure');return original.apply(this,arguments);};
  try {const {result,calls}=await run(f,{lander:()=>{fail=true;return {ok:true,stage:'shipped'};}});assert.equal(result.landed.length,1);assert.equal(result.paused[0].stage,'receipt');assert.equal(result.status,'failed');assert.match(result.receipt_error,/receipt/i);assert.equal(calls.some(a=>a[1]==='ready'||a[1]==='release'),false);assert.equal(f.read().status,'claimed');} finally {fs.renameSync=original;}
});
test('revision invalidates the original fleet handoff',async t=>{
  const f=fixture(t); const {result}=await run(f,{dispatcher:async()=>{
    const d=db.open(f.env.ATRIS_TASKS_DB);try{db.readyTask(d,{id:f.task.id,actor:'fleet-codex',proof:'fixture'});db.reviseTask(d,{id:f.task.id,actor:'human',note:'Please revise'});}finally{db.close();}
    return {exitCode:0,report:'fixture'};}});
  assert.equal(result.paused[0].stage,'task_ready');assert.equal(result.landed[0].review_recorded,false);assert.equal(f.read().metadata.human_revision_note,'Please revise');
});
function setupGit(f){function git(args){const r=spawnSync('git',args,{cwd:f.worker,env:f.env,encoding:'utf8'});assert.equal(r.status,0,r.stderr);}git(['init']);git(['config','user.name','fixture']);git(['config','user.email','fixture@example.test']);git(['commit','--allow-empty','-m','fixture']);}
test('paused fleet cleanup cannot release a replacement claim from the same actor',async t=>{
  const f=fixture(t);setupGit(f);const {result,calls}=await run(f,{dispatcher:async()=>{command(f,['task','release',f.task.id,'--as','fleet-codex']);command(f,['task','claim',f.task.id,'--as','fleet-codex']);return {exitCode:1,stderr:'fixture failure'};}});
  assert.equal(result.paused[0].stage,'build');assert.equal(result.paused[0].claim_released,false);assert.equal(f.read().status,'claimed');assert.ok(calls.some(a=>a[1]==='release' && a.includes('--claim-guard')));
});
test('paused fleet cleanup releases its original claim when no work exists',async t=>{
  const f=fixture(t);setupGit(f);const {result,calls}=await run(f,{dispatcher:async()=>({exitCode:1,stderr:'fixture failure'})});
  assert.equal(result.paused[0].claim_released,true);assert.equal(f.read().status,'open');assert.ok(calls.some(a=>a[1]==='release' && a.includes('--claim-guard')));
});
test('replacement engine is recorded and task handoff waits for inspection',async t=>{
  const f=fixture(t);const engines=[];const {result,calls}=await run(f,{engines:['codex','cursor'],dispatcher:async entry=>{engines.push(entry.engine);return entry.engine==='codex'?{exitCode:1,stderr:'usage limit reached'}:{exitCode:0,report:'fixture replacement'};}});
  assert.deepEqual(engines,['codex','cursor']);assert.equal(result.landed[0].engine,'cursor');assert.equal(result.landed[0].review_recorded,false);assert.equal(result.paused[0].stage,'task_ready');assert.match(result.paused[0].detail,/manually/);assert.equal(f.read().status,'claimed');assert.equal(calls.some(a=>a[1]==='ready'||a[1]==='release'),false);
});
test('uncertain ship keeps its claim and asks for inspection',async t=>{
  const f=fixture(t);setupGit(f);const {result,calls}=await run(f,{lander:()=>{throw Error('response lost');}});assert.equal(result.paused[0].stage,'ship_uncertain');assert.match(result.paused[0].detail,/inspect/i);assert.equal(f.read().status,'claimed');assert.equal(calls.some(a=>a[1]==='release'),false);
});
test('each confirmed handoff is saved before the next landing starts',async t=>{
  const f=fixture(t);const d=db.open(f.env.ATRIS_TASKS_DB);let other;try{other=db.addTask(d,{title:'Edit lib/other.js. Done: fixture works. Check: node --test test/other.test.js.',workspaceRoot:f.root});}finally{db.close();}
  const show=f.cli(['task','show',other.id,'--json']);assert.equal(show.status,0,show.stderr);fs.writeFileSync(path.join(f.root,'.atris','state','tasks.projection.json'),JSON.stringify({tasks:[f.projection,JSON.parse(show.stdout)]}));
  let seen;let lands=0;const {result}=await run(f,{lander:()=>{lands++;if(lands===2){const p=path.join(f.root,'atris','runs',fs.readdirSync(path.join(f.root,'atris','runs')).find(x=>x.endsWith('.json')));seen=JSON.parse(fs.readFileSync(p,'utf8'));}return {ok:true,stage:'shipped'};}});
  assert.equal(lands,2);assert.equal(seen.landed.length,1);assert.equal(seen.landed[0].review_recorded,true);assert.equal(result.landed.length,2);assert.ok(result.landed.every(row=>row.review_recorded));
});
for (const value of [null,{}, {ok:'yes'}, {ok:false}, {ok:true,stage:'unknown'}]) test(`invalid lander response ${JSON.stringify(value)} is uncertain`,async t=>{
  const f=fixture(t);const {result,calls}=await run(f,{lander:()=>value});assert.equal(result.paused[0].stage,'ship_uncertain');assert.equal(f.read().status,'claimed');assert.equal(calls.some(a=>a[1]==='ready'||a[1]==='release'),false);
});
test('fleet never retries an uncertain ship even when it reports MODULE_NOT_FOUND',async t=>{
  const f=fixture(t);let shipCalls=0,simulatedEffects=0;const {result,calls}=await run(f,{realLander:true,ship:()=>{shipCalls++;simulatedEffects++;return {status:1,stdout:'',stderr:"Error: Cannot find module 'fixture' MODULE_NOT_FOUND"};}});
  assert.equal(shipCalls,1);assert.equal(simulatedEffects,1);assert.equal(result.paused[0].stage,'ship');assert.match(result.paused[0].detail,/not confirmed.*inspect/i);assert.equal(f.read().status,'claimed');assert.equal(calls.some(a=>a[1]==='release'),false);
});
test('unknown file surface is never staffed beside known work in either ordering',()=>{
  const unknown={id:'u',status:'open',title:'vague task'};const known={id:'k',status:'open',title:'edit lib/example.js'};
  assert.deepEqual(fleet.staffFlight([unknown,known]).map(x=>x.task.id),['u']);assert.deepEqual(fleet.staffFlight([known,unknown]).map(x=>x.task.id),['k']);
});
for (const flight of [{status:'failed',receipt_error:'receipt write failed',paused:[]},{dry_run:true,paused:[]}]) test(`mission fleet exit reflects receipt outcome ${JSON.stringify(flight)}`,t=>{
  const f=fixture(t);const code=`const p=require.resolve(${JSON.stringify(path.resolve(__dirname,'../lib/fleet'))});require.cache[p]={id:p,filename:p,loaded:true,exports:{runFleetFlight:async()=>(${JSON.stringify(flight)})}};Promise.resolve(require(${JSON.stringify(path.resolve(__dirname,'../commands/mission'))}).missionCommand(['run','--fleet','--json'])).catch(e=>{console.error(e);process.exitCode=3;});`;
  const response=spawnSync(process.execPath,['-e',code],{cwd:f.root,env:f.env,encoding:'utf8',timeout:20000});assert.equal(response.status,flight.receipt_error?1:0,response.stderr);assert.deepEqual(JSON.parse(response.stdout),flight);
});
test('receipt write failure is prominent in the plain flight output',async t=>{
  const f=fixture(t);let fail=false;const lines=[];const original=fs.renameSync;fs.renameSync=function(a,b){if(fail && String(b).endsWith('.json'))throw Error('fixture disk failure');return original.apply(this,arguments);};
  try{await run(f,{log:line=>lines.push(String(line)),lander:()=>{fail=true;return {ok:true,stage:'shipped'};}});assert.ok(lines.some(line=>/alert:.*receipt.*prior receipt may be incomplete/i.test(line)));}finally{fs.renameSync=original;}
});
test('restaffed landing leaves prior certification history untouched for manual inspection',async t=>{
  const f=fixture(t);const prior={built_by:'fleet-cursor',agent_review_pass_count:1,agent_review_actors:['fleet-cursor']};f.sql('UPDATE tasks SET metadata=? WHERE id=?',JSON.stringify(prior),f.task.id);
  const {result,calls}=await run(f,{engines:['codex','cursor'],dispatcher:async entry=>entry.engine==='codex'?{exitCode:1,stderr:'usage limit reached'}:{exitCode:0,report:'replacement'}});
  assert.equal(result.landed[0].engine,'cursor');assert.equal(result.landed[0].review_recorded,false);assert.equal(result.paused[0].stage,'task_ready');assert.equal(f.read().status,'claimed');assert.deepEqual(f.read().metadata,prior);assert.equal(calls.some(a=>a[1]==='ready'||a[1]==='release'),false);
});
test('conflicting replacement engine label still holds the handoff and records both reports',async t=>{
  const f=fixture(t);const {result,calls}=await run(f,{engines:['codex','cursor'],dispatcher:async entry=>entry.engine==='codex'?{exitCode:1,stderr:'usage limit reached'}:{exitCode:0,engine:'codex',report:'replacement completed'}});
  assert.equal(result.landed[0].engine,'cursor');assert.equal(result.landed[0].reported_engine,'codex');assert.equal(result.landed[0].restaffed.to,'cursor');assert.equal(result.landed[0].review_recorded,false);assert.equal(result.paused[0].stage,'task_ready');assert.equal(f.read().status,'claimed');assert.equal(calls.some(a=>a[1]==='ready'||a[1]==='release'),false);
  const receipt=JSON.parse(fs.readFileSync(result.receipt,'utf8'));assert.equal(receipt.landed[0].engine,'cursor');assert.equal(receipt.landed[0].reported_engine,'codex');
});
test('fleet rechecks a stale open projection after self-drive reopens with an inspection hold',async t=>{
  const f=fixture(t); const d=db.open(f.env.ATRIS_TASKS_DB);
  let outcome;
  try {
    d.prepare('UPDATE tasks SET status=?, metadata=? WHERE id=?').run('done',JSON.stringify({mission_id:'fixture',mission_blocker_class:'stopped'}),f.task.id);
    outcome=require('../lib/self-drive').handleMissionBlocker({mission:{id:'fixture',status:'paused',objective:'synthetic'},stopReason:'stopped',workspaceRoot:f.root},{
      taskDb:{...db,open:()=>d},
      resolveEngineForRole:()=>{throw Error('unexpected engine');},
      createAgentWorktree:()=>{throw Error('unexpected worker');},
      dispatchToEngine:()=>{throw Error('unexpected worker');},
      httpPost:()=>{throw Error('unexpected post');},
    });
  } finally { db.close(); }
  assert.equal(outcome.inspection_hold,'needs-human');
  let dispatched=false; const {result,calls}=await run(f,{dispatcher:async()=>{dispatched=true;}});
  assert.equal(dispatched,false);
  assert.equal(result.paused[0].stage,'task_lookup');
  assert.equal(calls.some(args=>args[1]==='claim'),false);
  assert.ok(f.read().metadata.tags.includes('needs-human'));
});
