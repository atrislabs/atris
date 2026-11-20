'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { experiment, freeze, summarize, digest } = require('../lib/codeops-experiment');

function setup(t, suite = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeops-experiment-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const selection = { proposal: { lesson: 'trace the input', metric: 'correct diagnosis' } };
  const files = new Map(), runs = new Map(), prompts = [];
  const deps = {
    root,
    io: {
      async list(folder) {
        if (!folder) return [{ type: 'dir', name: 'executor' }, { type: 'dir', name: 'improver' }];
        return [...files.keys()].filter(f => path.dirname(f) === folder).map(f => ({ name: path.basename(f) }));
      },
      async read(file) { return files.get(file) || ''; },
      async write(file, content) { files.set(file, content); return null; },
    },
    async start(message) {
      const id = randomUUID();
      prompts.push(message);
      runs.set(id, message.includes('Advice for this job:') ? '"answer"' : '"wrong"');
      return id;
    },
    async observe(id) {
      return { ok: true, status: 'completed', resultText: runs.get(id),
        audit: { execution: id, model: 'pinned-model', tools: 0, resumed: false } };
    },
  };
  const { trial } = freeze(root, digest(selection), selection, { model: 'pinned-model', worker: 'openai',
    cases: [{ id: 'one', kind: 'target', task: 'repair case', expected: 'answer' }], ...suite });
  return { trial, deps, root, files, prompts, runs };
}

test('frozen jobs get independent answers, resume at the next arm, and feed the result back into choice', async t => {
  const { deps, trial, prompts, files, runs } = setup(t);
  assert.equal((await experiment(['run', trial, '--max', '1'], deps)).pending, true);
  const score = await experiment(['run', trial], deps);
  assert.equal(score.observed, 'win');
  assert.equal(score.wins, 1);
  assert.equal(prompts.length, 2);
  assert.ok(prompts.every(p => !p.includes('"answer"')));
  assert.equal((await experiment(['run', trial], deps)).observed, 'win');
  assert.equal(prompts.length, 2);
  files.set('/workspace/atris/team/improver/MEMBER.md', 'Choose measured improvements');
  files.set('/workspace/atris/team/executor/lessons.md', '- 2026-11-17 | atrislabs/atris | failed: tests | next time: inspect input');
  deps.start = async message => {
    const data = JSON.parse(message.split('\n').at(-1));
    assert.equal(data.previous[0].trial, trial);
    const id = randomUUID();
    runs.set(id, JSON.stringify({ hypothesis: 'less repetition', lesson: 'inspect input', metric: 'correct answer',
      applies_when: 'tests fail', evidence: [Object.keys(data.jobs)[0]] }));
    return id;
  };
  const chosen = await experiment(['choose'], deps);
  assert.equal(chosen.lesson, 'inspect input');
  assert.ok(files.has('/workspace/atris/team/improver/choice-' + chosen.choice + '.json'));
});

test('a changed plan, missing arm, failed control and a tie are handled explicitly', async t => {
  const { deps, trial, root } = setup(t);
  const cases = ['target', 'control'].map(kind => ({ kind, order: ['baseline','lesson'] }));
  const rows = (a, b, c, d) => [a,b,c,d].map((pass,i) => ({ index: Math.floor(i/2), arm: i%2 ? 'lesson' : 'baseline', pass }));
  assert.equal(summarize({ cases }, rows(false,true,true,null)).observed, 'inconclusive');
  assert.equal(summarize({ cases }, rows(false,true,true,false)).observed, 'loss');
  assert.equal(summarize({ cases }, rows(true,true,true,true)).observed, 'tie');
  const file = path.join(root, trial, 'plan.json');
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), metric: 'easier target' }));
  await assert.rejects(experiment(['run', trial], deps), /frozen plan changed/);
});

test('a blind reader can score natural language but cannot change a judgment or use a builder execution', async t => {
  const { deps, trial, prompts, runs } = setup(t, { scoring: 'blind', placebo: 'check something else' });
  const read = await experiment(['run', trial], deps);
  assert.equal(read.pending_judgment, true);
  assert.equal(prompts.length, 3);
  assert.equal(prompts.filter(p => p.includes('trace the input')).length, 1);
  assert.equal(prompts.filter(p => p.includes('check something else')).length, 1);
  const packet = await experiment(['packet', trial], deps);
  const batch = packet.packets[0];
  for (const job of batch.jobs) {
    assert.equal(job.task, 'repair case');
    assert.equal(job.rubric, 'answer');
    assert.equal(job.arm, undefined);
    assert.equal(job.execution, undefined);
  }
  const originalStart = deps.start;
  let attempts = 0;
  deps.start = async prompt => {
    attempts++;
    const id = await originalStart(prompt);
    const received = JSON.parse(prompt.split('\n').at(-1));
    assert.equal(received.hash, batch.hash);
    runs.set(id, JSON.stringify({ packet: batch.hash, labels: attempts === 1 ? [] : batch.jobs.map(j => (
      { key: j.key, pass: true, reason: 'matches expected steps' }
    )) }));
    return id;
  };
  const result = await experiment(['judge',trial], deps);
  assert.equal(result.observed, 'tie');
  assert.equal(result.rows.length, 3);
  assert.equal(result.judgments[0].model, 'pinned-model');
  assert.ok(result.rows.every(r => r.input_hash && r.output_hash));
  assert.equal((await experiment(['judge',trial], deps)).packet, result.packet);
  assert.equal(attempts, 2);
  await assert.rejects(experiment(['score',trial,randomUUID()], deps), /experiment choose/);
});

test('ambiguous start reuses the previous cloud execution even after observation failure', async t => {
  const { deps, trial, runs } = setup(t);
  let count = 0;
  const sessionToId = new Map();
  deps.start = async (prompt, worker, model, session) => {
    count++;
    const id = randomUUID();
    runs.set(id, '"answer"');
    sessionToId.set(session, id);
    if (count === 1) throw Error('connection lost');
    return id;
  };
  deps.findSession = async session => sessionToId.get(session);
  await assert.rejects(experiment(['run',trial], deps), /connection lost/);
  assert.equal((await experiment(['run',trial], deps)).observed, 'tie');
  assert.equal(count, 2);
});

test('multiple blind batches retain distinct grades and do not accept a missing batch', async t => {
  const { deps, trial, runs } = setup(t, { scoring: 'blind', cases: [
    { id: 'a', task: 'a'.repeat(23000), kind: 'target', expected: 'A' },
    { id: 'b', task: 'b'.repeat(23000), kind: 'control', expected: 'B' },
  ] });
  await experiment(['run',trial], deps);
  const { packets } = await experiment(['packet',trial], deps);
  assert.equal(packets.length, 4);
  deps.start = async prompt => {
    const batch = JSON.parse(prompt.split('\n').at(-1));
    const id = randomUUID();
    runs.set(id, JSON.stringify({ packet: batch.hash, labels: batch.jobs.map(j => ({ key: j.key, pass: false, reason: 'wrong answer' })) }));
    return id;
  };
  assert.equal((await experiment(['judge',trial], deps)).judgments.length, 4);
});

test('expired provider events use contemporaneous capture; missing or tool-contaminated evidence cannot win', async t => {
  const { deps, trial, root, runs } = setup(t, { scoring: 'blind' });
  await experiment(['run',trial], deps);
  const originalObserve = deps.observe;
  const armIds = new Set(runs.keys());
  deps.observe = async id => {
    assert.ok(!armIds.has(id), 'older builder events expire and must not be required for grading');
    return originalObserve(id);
  };
  const armFile = path.join(root,trial,'0-baseline.json');
  const arm = JSON.parse(fs.readFileSync(armFile, 'utf8'));
  arm.audit.tools = 1;
  fs.writeFileSync(armFile, JSON.stringify(arm));
  const pkt = await experiment(['packet',trial], deps);
  assert.equal(pkt.packets[0].jobs.length, 1);
  deps.start = async prompt => {
    const batch = JSON.parse(prompt.split('\n').at(-1));
    const id = randomUUID();
    runs.set(id, JSON.stringify({ packet: batch.hash, labels: batch.jobs.map(j => ({ key: j.key, pass: true, reason: 'matches rubric' })) }));
    return id;
  };
  const result = await experiment(['judge',trial], deps);
  assert.equal(result.observed,'inconclusive');
  assert.equal(result.missing,1);
  assert.equal(result.rows.find(r => r.arm === 'baseline').issue, 'tool use or reused context');
});

test('external observations are descriptive, checked against the exact blind packet and protected against replacement', async t => {
  const { deps, trial, root, files } = setup(t, { scoring: 'blind' });
  await experiment(['run',trial], deps);
  const pkt = await experiment(['packet',trial], deps);
  const labels = pkt.packets.flatMap(b => b.jobs.map(j => ({ key: j.key, pass: j.output === '"answer"', reason: 'checks required result' })));
  const report = { packet: pkt.hash, reader: 'independent reader', labels, repo_by_case: { one: 'owner/repo' } };
  const file = path.join(root, 'observation.json');
  fs.writeFileSync(file, JSON.stringify(report));
  const result = await experiment(['observation',trial,file], deps);
  assert.equal(result.observed, 'inconclusive');
  assert.equal(result.descriptive,'win');
  assert.equal(result.by_repo['owner/repo'].target.lesson.passed,1);
  assert.ok([...files.keys()].some(k => k.includes('/observation-')));
  report.labels[0].pass = !report.labels[0].pass;
  fs.writeFileSync(file,JSON.stringify(report));
  await assert.rejects(experiment(['observation',trial,file], deps), /observation is frozen/);
});

test('adopting an existing selection requires exact excerpts from one completed execution', async t => {
  const { deps, root, runs } = setup(t);
  const id = randomUUID();
  runs.set(id, 'I choose precise input tracing. Score accurate fixes.');
  const file = path.join(root,'choice.json');
  fs.writeFileSync(file, JSON.stringify({ lesson: 'precise input tracing', metric: 'accurate fixes' }));
  assert.equal((await experiment(['adopt',id,file], deps)).execution,id);
  runs.set(id,'something else');
  await assert.rejects(experiment(['adopt',id,file], deps),/exact excerpt/);
});

test('choice reads one trial once with independent disagreements and recent observations sorted by trial time', async t => {
  const { deps, trial, files, runs } = setup(t);
  const dir = '/workspace/atris/team/improver/';
  const second = 'a'.repeat(64);
  files.set(dir + 'observation-1000000000002-' + second + '.json', JSON.stringify({ trial: second, observed: 'inconclusive' }));
  files.set(dir + 'result-1000000000001-' + trial + '.json', JSON.stringify({ trial, observed: 'tie' }));
  files.set(dir + 'observation-1000000000001-' + trial + '.json', JSON.stringify({ trial, observed: 'inconclusive' }));
  const list = await experiment(['show'],deps);
  assert.deepEqual(list.map(g => [g.trial,g.reviews.length]),[[second,1],[trial,2]]);
  files.set(dir + 'MEMBER.md', 'Select evidence-backed experiments');
  files.set('/workspace/atris/team/executor/lessons.md', '- 2026-11-17 | owner/repo | failed | next time: reconsider');
  deps.start = async prompt => {
    const {previous, jobs} = JSON.parse(prompt.split('\n').at(-1));
    assert.deepEqual(previous[1].reviews.map(r => r.observed).sort(),['inconclusive','tie']);
    const id = randomUUID();
    runs.set(id, JSON.stringify({hypothesis:'fewer retries', lesson:'reconsider', metric:'correct fix', applies_when:'retrying', evidence:[Object.keys(jobs)[0]]}));
    return id;
  };
  await experiment(['choose'], deps);
});

test('an executed workflow comparison binds to the existing cloud choice and stays distinct from chat trials', async t => {
  const { deps, root, files, runs } = setup(t);
  const choice = { execution: 'cloud-choice', proposal: { lesson: 'test the base', metric: 'diagnosis correctness' } };
  const id = digest(choice);
  const folder = '/workspace/atris/team/improver/';
  files.set(folder + 'choice-' + id + '.json', JSON.stringify(choice));
  for (const source of ['baseline', 'candidate', 'results']) fs.writeFileSync(path.join(root, source), source);
  const manifest = { scope: 'paired executed repairs', metric: 'correct diagnosis', measured_at: '2026-11-18T04:30:00Z', measured_by: 'independent runner',
    sources: { baseline:'baseline', candidate:'candidate', results:'results' },
    cases: [{ id:'red',repo:'owner/backend',baseline:false,candidate:true,gate_before:false,gate_after:false },
      { id:'green',repo:'owner/cli',baseline:true,candidate:true,gate_before:true,gate_after:true }] };
  const input = path.join(root, 'report.json');
  fs.writeFileSync(input, JSON.stringify(manifest));
  const result = await experiment(['implementation',id,input], deps);
  assert.equal(result.wins,1);
  assert.equal(result.gate_changes,0);
  assert.equal(result.by_repo['owner/backend'].target.baseline.passed,0);
  assert.equal(result.by_repo['owner/backend'].target.candidate.passed,1);
  assert.equal(result.sources.candidate,require('node:crypto').createHash('sha256').update('candidate').digest('hex'));
  assert.equal((await experiment(['implementation',id,input], deps)).implementation,result.implementation);
  const [entry] = await experiment(['show'],deps);
  assert.equal(entry.implementation,result.implementation);
  assert.equal(entry.trial,undefined);
  assert.equal(entry.reviews.length,1);
  assert.equal(entry.reviews[0].choice,id);
  files.set(folder + 'MEMBER.md','Improve work');
  files.set('/workspace/atris/team/executor/lessons.md','- 2026-11-17 | owner/cli | failed | next time: inspect baseline');
  deps.start = async message => {
    const { previous,jobs } = JSON.parse(message.split('\n').at(-1));
    assert.equal(previous[0].implementation,result.implementation);
    assert.equal(previous[0].reviews[0].choice,id);
    assert.equal(previous[0].reviews[0].evidence,'independently reported executed code comparison');
    assert.equal(previous[0].reviews[0].scope,'paired executed repairs');
    const exec = randomUUID();
    runs.set(exec,JSON.stringify({hypothesis:'preserve gains',lesson:'compare',metric:'pass',applies_when:'changing code',evidence:[Object.keys(jobs)[0]]}));
    return exec;
  };
  await experiment(['choose'],deps);
  manifest.cases.push(manifest.cases[0]);
  fs.writeFileSync(input,JSON.stringify(manifest));
  await assert.rejects(experiment(['implementation',id,input],deps),/distinct cases/);
});
