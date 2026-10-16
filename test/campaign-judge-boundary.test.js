'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { buildTrace, traceLines } = require('../lib/campaign-trace');
const { summarizeTrace } = require('../lib/campaign-rsi');
const { proposalPrompt } = require('../lib/campaign-loop');
const { fold } = require('../lib/campaign-core');

const CLI = path.resolve(__dirname, '..', 'bin', 'atris.js');

function events() {
  const result = [];
  const add = (type, data, actor = 'owner') => {
    result.push({ id: `boundary-${result.length}`, campaign_id: 'cmp-boundary',
      origin: 'local', seq: result.length + 1,
      at: new Date(Date.UTC(2026, 9, 16, 1, 0, result.length)).toISOString(), type, actor, data });
    return result;
  };
  add('campaign_started', { title: 'Improve real work', owner: 'owner', judge: 'old-check', budget: 10 });
  add('judge_ran', { passed: false, reading: 0.1 }, 'judge');
  return { result, add };
}

function job(add, id = 'm1') {
  add('mission_started', { mission_id: id, member: 'worker' });
  add('mission_ended', { mission_id: id, outcome: 'kept', cost_usd: 1 });
}

for (const actor of ['owner', 'human:operator']) {
  test(`a replacement baseline cannot score earlier work when accepted from ${actor}`, () => {
    const { result, add } = events();
    job(add);
    add('judge_set', { judge: 'new-check', from: 'old-check' }, actor);
    add('judge_ran', { passed: false, reading: 0.9 }, 'judge');
    for (const redact of [false, true]) {
      const trace = buildTrace(result, { redact });
      assert.equal(trace.error, undefined);
      assert.equal(trace.rows[0].reward, null);
      assert.equal(trace.rows[0].reading_before, 0.1);
      assert.equal(trace.rows[0].reading_after, null);
      assert.equal(trace.rows[0].judge_passed, null);
      assert.match(trace.rows[0].credit_note, /judge changed/);
      assert.equal(trace.header.final.reading, 0.9, 'the real latest reading still belongs to the campaign');
      assert.equal(trace.rows[0].cost_usd, 1);
      assert.equal(trace.rows[0].outcome, 'kept');
      assert.equal(traceLines(trace), traceLines(buildTrace([...result].reverse(), { redact })));
      assert.equal(traceLines(trace), traceLines(buildTrace([...result, result[4]], { redact })));
    }
    const summary = summarizeTrace(result);
    assert.equal(summary.total_reward, 0);
    assert.equal(summary.members[0].judge_passed, 0);
    assert.equal(summary.members[0].status, 'unproven');
    assert.ok(!summary.lessons.some(line => line.includes('gained +')));
  });
}

test('an explicit same-command reset also starts a fresh comparison', () => {
  const { result, add } = events();
  job(add);
  add('judge_set', { judge: 'old-check', from: 'old-check' });
  add('judge_ran', { passed: false, reading: 0.9 }, 'judge');
  assert.equal(buildTrace(result).rows[0].reward, null);
});

test('stored outsider changes ignored by the fold do not erase genuine progress', () => {
  const { result, add } = events();
  job(add);
  add('judge_set', { judge: 'new-check' }, 'outsider');
  add('judge_ran', { passed: false, reading: 0.3 }, 'judge');
  assert.equal(fold(result).judge, 'old-check');
  assert.equal(buildTrace(result).rows[0].reward, 0.2);
});

test('new-baseline work and already scored historical work keep their own gains', () => {
  const { result, add } = events();
  job(add, 'old');
  add('judge_ran', { passed: false, reading: 0.3 }, 'judge');
  add('judge_set', { judge: 'new-check' });
  add('judge_ran', { passed: false, reading: 0.6 }, 'judge');
  job(add, 'new');
  add('judge_ran', { passed: false, reading: 0.8 }, 'judge');
  assert.deepEqual(buildTrace(result).rows.map(row => row.reward), [0.2, 0.2]);
});

test('an unfinished batch cannot acquire credit from a later replacement or its next run', () => {
  const { result, add } = events();
  job(add, 'old');
  add('judge_set', { judge: 'new-check' });
  add('judge_ran', { passed: false, reading: 0.6 }, 'judge');
  job(add, 'new');
  add('judge_ran', { passed: true, reading: 1 }, 'judge');
  const rows = buildTrace(result).rows;
  assert.equal(rows[0].reward, null);
  assert.equal(rows[1].reward, 0.4);
  assert.equal(rows[1].judge_passed, true);
  assert.deepEqual(rows.map(row => row.batch.size), [1, 1]);
});

const quoted = value => "'" + value.replace(/'/g, "'\\''") + "'";
const judge = script => `exec ${quoted(process.execPath)} -e ${quoted(script)}`;

function actualCampaign(t, standing = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-judge-boundary-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'product.txt'), '0.1\n');
  const env = { ...process.env, ATRIS_TEST_STATE_DIR: path.join(root, 'owned-user-state'),
    ATRIS_CAMPAIGN_DB: path.join(root, '.atris', 'state', 'atris.db'), ATRIS_SKIP_UPDATE_CHECK: '1' };
  delete env.NODE_TEST_CONTEXT;
  const run = (args, status = 0, actor = 'owner', lines = false) => {
    const child = spawnSync(process.execPath, [CLI, 'campaign', ...args, '--as', actor, '--json'], {
      cwd: root, env, encoding: 'utf8', timeout: 15000, maxBuffer: 4 * 1024 * 1024,
    });
    assert.ifError(child.error);
    assert.equal(child.status, status, child.stderr || child.stdout);
    return lines ? child.stdout.trim().split('\n').map(JSON.parse) : JSON.parse(child.stdout);
  };
  const id = 'cmp-runtime-boundary';
  const oldJudge = judge("console.log('reading: '+require('fs').readFileSync('product.txt','utf8').trim()); process.exit(1)");
  run(['start', 'Improve actual product', '--judge', oldJudge, '--owner', 'owner', '--seat', 'worker', '--budget', '10', '--id', id,
    ...(standing ? ['--standing'] : [])]);
  const start = mission_id => run(['event', id, 'mission_started', '--data', JSON.stringify({ mission_id, member: 'worker' })]);
  const end = mission_id => run(['event', id, 'mission_ended', '--data', JSON.stringify({ mission_id, outcome: 'kept', cost_usd: 1 })]);
  return { root, id, oldJudge, run, start, end };
}

for (const standing of [false, true]) {
  test(`actual judge replacement stays unproven through export and the next planner (${standing ? 'standing' : 'ordinary'})`, t => {
    const c = actualCampaign(t, standing);
    const original = fs.readFileSync(path.join(c.root, 'product.txt'));
    c.start('m-old'); c.end('m-old');
    const newJudge = judge(`console.log('reading: ${standing ? '1' : '0.9'}'); process.exit(${standing ? '0' : '1'})`);
    c.run(['set-judge', c.id, newJudge]);
    c.run(['judge', c.id], standing ? 0 : 1);
    const trace = c.run(['export', c.id, '--trace', '--full'], 0, 'owner', true);
    assert.equal(trace[1].reward, null);
    assert.equal(trace[1].reading_after, null, 'a replacement pass cannot become fallback proof');
    const report = c.run(['rsi', c.id, '--next', '--no-write']);
    assert.equal(report.rsi.total_reward, 0);
    assert.equal(report.rsi.members[0].judge_passed, 0);
    assert.equal(report.rsi.members[0].status, 'unproven');
    assert.equal(report.next_campaigns[0].lead_member, 'owner', 'replacement credit cannot promote the worker');
    const view = c.run(['show', c.id]).campaign;
    const prompt = proposalPrompt(view, 1, null, report.rsi.lessons.join('\n'), report.rsi);
    assert.doesNotMatch(prompt, /worker gained \+/);
    assert.match(prompt, /worker \(75 ovr/);
    assert.deepEqual(fs.readFileSync(path.join(c.root, 'product.txt')), original);
  });
}

test('actual unchanged runs and refused replacements preserve zero credit; real product gain still counts', t => {
  const c = actualCampaign(t);
  c.start('m-unchanged'); c.end('m-unchanged');
  c.run(['set-judge', c.id, judge("console.log('reading: 0.9'); process.exit(1)")], 2, 'outsider');
  c.run(['set-judge', c.id, judge("console.log('reading: 1'); process.exit(0)")], 1);
  c.run(['judge', c.id], 1);
  let trace = c.run(['export', c.id, '--trace', '--full'], 0, 'owner', true);
  assert.equal(trace[1].reward, 0);
  c.start('m-real');
  fs.writeFileSync(path.join(c.root, 'product.txt'), '0.3\n');
  c.end('m-real'); c.run(['judge', c.id], 1);
  trace = c.run(['export', c.id, '--trace', '--full'], 0, 'owner', true);
  assert.deepEqual(trace.slice(1).map(row => row.reward), [0, 0.2]);
  const report = c.run(['rsi', c.id, '--next', '--no-write']);
  assert.equal(report.rsi.total_reward, 0.2);
  assert.equal(report.rsi.members[0].judge_passed, 1);
  assert.ok(report.rsi.lessons.some(line => line.includes('worker gained +0.2')));
});
