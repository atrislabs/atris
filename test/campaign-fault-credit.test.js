'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { buildTrace, traceLines } = require('../lib/campaign-trace');
const { fold } = require('../lib/campaign-core');
const { summarizeTrace } = require('../lib/campaign-rsi');
const { createSqliteStore, getCampaign } = require('../lib/campaign-store');
const { proposalPrompt } = require('../lib/campaign-loop');
const { captureCodeBaseline, collectCodeProvenance } = require('../lib/mission-code-provenance');

const CLI = path.resolve(__dirname, '..', 'bin', 'atris.js');

function history() {
  const events = [];
  const add = (type, data, actor = 'owner') => {
    const seq = events.length + 1;
    const event = { id: `fault-event-${seq}`, campaign_id: 'cmp-fault-credit', origin: 'owned', seq,
      at: new Date(Date.UTC(2026, 9, 16, 10, 0, seq)).toISOString(), type, actor, data };
    events.push(event);
    return event;
  };
  add('campaign_started', { title: 'private campaign purpose', judge: 'exec private-check', budget: 100,
    owner: 'owner', standing: true });
  add('judge_ran', { passed: false, reading: 0.2 }, 'judge');
  const job = (id, outcome, { steps = 0, plan = false, cost = 0.25 } = {}) => {
    add('mission_started', { mission_id: id, member: id, objective: 'private work details',
      ...(plan ? { kind: 'plan', engine: 'claude' } : {}) });
    for (let i = 0; i < steps; i++) add('step', { mission_id: id, engine: 'codex', cost_usd: 0,
      ...(plan ? { kind: 'plan' } : {}) });
    return add('mission_ended', { mission_id: id, outcome, cost_usd: cost,
      ...(outcome === 'fault' ? { reason: 'private setup failed before work' } : {}) });
  };
  return { events, add, job };
}

function batch(after, includeFaults = true) {
  const h = history();
  if (includeFaults) {
    h.job('fault-one', 'fault');
    h.job('fault-two', 'fault', { steps: 1 });
  }
  h.job('manual', 'kept');
  h.job('failed-work', 'failed', { steps: 1 });
  h.job('reverted-work', 'reverted', { steps: 1 });
  h.job('planning-work', 'failed', { steps: 1, plan: true });
  h.add('judge_ran', { passed: false, reading: after, summary: 'private judge summary',
    output_tail: 'private diagnostic output' }, 'judge');
  return h;
}

function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}

for (const [after, share] of [[0.8, 0.15], [0, -0.05], [0.2, 0]]) {
  test(`explicit faults receive no reward and cannot dilute the ${after - 0.2 > 0 ? 'positive' : after < 0.2 ? 'negative' : 'zero'} work delta`, () => {
    const events = freeze(batch(after).events);
    const input = JSON.stringify(events);
    const full = buildTrace(events, { redact: false });
    assert.equal(full.error, undefined);
    assert.equal(full.rows.length, 6);
    assert.equal(full.header.final.budget.spent, 1.5);
    for (const row of full.rows) {
      assert.equal(row.batch.size, 6, 'batch size retains every diagnostic ended row');
      assert.equal(row.reading_before, 0.2);
      assert.equal(row.reading_after, after);
      assert.equal(row.judge_passed, false);
      assert.equal(row.cost_usd, 0.25);
      if (row.outcome === 'fault') {
        if (row.action.mission_id === 'fault-two') assert.equal(row.ticks, 1, 'explicit fault controls eligibility even with a recorded step');
        assert.equal(row.reward, null, 'a setup fault cannot gain or lose work credit');
        assert.match(row.credit_note, /fault|never ran|did not run|no work/i);
      } else {
        assert.equal(row.reward, share, 'only the four eligible jobs divide the measured delta');
        assert.match(row.credit_note, /4/);
        assert.match(row.credit_note, /eligible|fault|ran|work/i);
      }
    }
    assert.match(full.header.reward, /fault/i);
    assert.equal(full.rows.find(row => row.action.mission_id === 'manual').ticks, 0);
    assert.equal(full.rows.find(row => row.action.mission_id === 'planning-work').action.kind, 'plan');
    const summary = summarizeTrace(events);
    for (const name of ['fault-one', 'fault-two']) {
      const member = summary.members.find(row => row.member === name);
      assert.equal(member.reward, 0);
      assert.equal(member.judge_passed, 0);
      assert.equal(member.failed, 1, 'the existing failure diagnostic remains');
      assert.equal(member.cost_usd, 0.25);
      assert.equal(member.status, 'unproven');
    }
    const redacted = buildTrace(events);
    assert.deepEqual(redacted.rows.map(row => [row.outcome, row.reward, row.batch, row.cost_usd, row.reading_before, row.reading_after, row.judge_passed]),
      full.rows.map(row => [row.outcome, row.reward, row.batch, row.cost_usd, row.reading_before, row.reading_after, row.judge_passed]));
    assert.doesNotMatch(traceLines(redacted), /private/);
    assert.equal(traceLines(buildTrace([...events].reverse(), { redact: false })), traceLines(full));
    assert.equal(traceLines(buildTrace([...events, events[3]], { redact: false })), traceLines(full));
    assert.equal(JSON.stringify(events), input);
  });
}

test('non-fault failed, reverted, manual zero-step and planning work keep existing eligibility', () => {
  const h = batch(0.8, false);
  const trace = buildTrace(h.events, { redact: false });
  assert.deepEqual(trace.rows.map(row => [row.outcome, row.reward, row.batch.size]),
    [['kept', 0.15, 4], ['failed', 0.15, 4], ['reverted', 0.15, 4], ['failed', 0.15, 4]]);
});

test('an all-fault batch stays visible with actual passing judge fields and no work reward', () => {
  const h = history();
  h.job('fault-one', 'fault', { cost: 0.1 });
  h.job('fault-two', 'fault', { cost: 0.2 });
  h.add('judge_ran', { passed: true, reading: 1 }, 'judge');
  const trace = buildTrace(h.events, { redact: false });
  assert.equal(trace.header.rows, 2);
  assert.equal(trace.header.final.budget.spent, 0.3);
  for (const row of trace.rows) {
    assert.equal(row.batch.size, 2);
    assert.equal(row.reward, null, 'no eligible divisor means no reward');
    assert.equal(row.reading_before, 0.2);
    assert.equal(row.reading_after, 1);
    assert.equal(row.judge_passed, true, 'the actual judge result remains diagnostic evidence');
  }
  const summary = summarizeTrace(h.events);
  assert.equal(summary.total_reward, 0);
  assert.ok(summary.members.every(member => member.judge_passed === 0 && member.status === 'unproven'));
  assert.ok(!summary.lessons.some(line => line.includes('gained +')));
});

for (const [first, effective, reward] of [['fault', 'kept', 0.3], ['kept', 'fault', null]]) {
  test(`fault exclusion follows the existing effective ${effective} outcome after a distinct later end`, () => {
    const h = history();
    h.job('changed-outcome', first);
    h.job('other-work', 'kept');
    h.add('mission_ended', { mission_id: 'changed-outcome', outcome: effective, cost_usd: 0.5 });
    h.add('judge_ran', { passed: false, reading: 0.8 }, 'judge');
    const trace = buildTrace(h.events, { redact: false });
    const row = trace.rows.find(row => row.action.mission_id === 'changed-outcome');
    assert.equal(row.outcome, fold(h.events).missions.find(row => row.id === 'changed-outcome').outcome);
    assert.equal(row.outcome, effective);
    assert.equal(row.cost_usd, 0.5);
    assert.equal(row.reward, reward);
    assert.equal(trace.rows.find(row => row.action.mission_id === 'other-work').reward, effective === 'fault' ? 0.6 : 0.3);
  });
}

test('first duplicate identity and whole-input schema validation remain unchanged', () => {
  const h = history();
  const end = h.job('fault', 'fault');
  h.job('real-work', 'kept');
  h.add('judge_ran', { passed: false, reading: 0.8 }, 'judge');
  const invalid = { ...end, data: { ...end.data, outcome: 'invalid' } };
  assert.deepEqual(buildTrace([...h.events, invalid]), { error: 'invalid_event' });
  const conflicting = { ...end, data: { ...end.data, outcome: 'kept' } };
  const trace = buildTrace([...h.events, conflicting], { redact: false });
  assert.equal(traceLines(trace), traceLines(buildTrace(h.events, { redact: false })));
  assert.equal(trace.rows[0].outcome, 'fault');
  assert.equal(trace.rows[0].reward, null);
  assert.equal(trace.rows[1].reward, 0.6);
});

test('reset uncertainty stays unknown for both real work and fault diagnostics', () => {
  const h = history();
  h.job('fault', 'fault');
  h.job('real-work', 'kept', { steps: 1 });
  h.add('judge_set', { judge: 'replacement-check' });
  h.add('judge_ran', { passed: true, reading: 1 }, 'judge');
  const trace = buildTrace(h.events, { redact: false });
  assert.ok(trace.rows.every(row => row.reward === null && row.reading_after === null && row.judge_passed === null));
  assert.equal(trace.rows[0].reading_before, 0.2);
  assert.equal(trace.header.final.reading, 1);
});

const quoted = value => "'" + value.replace(/'/g, "'\\''") + "'";

test('real product improvement cannot give a never-ran fault a gain lesson or proven status', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-fault-credit-'));
  const home = process.env.HOME;
  const callerPath = process.env.PATH;
  let calls = 0;
  t.after(() => {
    try { assert.equal(process.env.HOME, home); assert.equal(process.env.PATH, callerPath); }
    finally { fs.rmSync(root, { recursive: true, force: true }); }
    t.diagnostic(`actual campaign CLI calls: ${calls}; lifecycle/steps are synthetic, no engine dispatched`);
  });
  const env = { ...process.env, ATRIS_TEST_STATE_DIR: path.join(root, '.atris', 'owned-user-state'),
    ATRIS_CAMPAIGN_DB: path.join(root, '.atris', 'state', 'atris.db'),
    ATRIS_RSI_STATE: path.join(root, '.atris', 'state', 'rsi'), ATRIS_SKIP_UPDATE_CHECK: '1' };
  delete env.NODE_TEST_CONTEXT;
  delete env.ATRIS_RSI_ATTEMPT_NODE;
  const run = (args, expected = 0, lines = false) => {
    const child = spawnSync(process.execPath, [CLI, 'campaign', ...args, '--as', 'owner', '--json'], {
      cwd: root, env, encoding: 'utf8', timeout: 15000, maxBuffer: 4 * 1024 * 1024,
    });
    calls++;
    assert.ifError(child.error);
    assert.equal(child.status, expected, child.stderr || child.stdout);
    return lines ? child.stdout.trim().split('\n').map(JSON.parse) : JSON.parse(child.stdout);
  };
  const git = args => {
    const child = spawnSync('git', args, { cwd: root, env, encoding: 'utf8', timeout: 15000 });
    assert.ifError(child.error); assert.equal(child.status, 0, child.stderr || child.stdout);
    return child.stdout.trim();
  };
  fs.writeFileSync(path.join(root, '.gitignore'), '.atris/\natris/runs/\natris/campaigns/\n');
  fs.writeFileSync(path.join(root, 'product.txt'), '0.1\n');
  git(['init', '-q']); git(['config', 'user.name', 'Owned Test']); git(['config', 'user.email', 'test@example.invalid']);
  git(['add', '.']); git(['commit', '-qm', 'owned baseline']);
  const id = 'cmp-real-fault-credit';
  const command = `exec ${quoted(process.execPath)} -e ${quoted("console.log('reading: '+require('fs').readFileSync('product.txt','utf8').trim());process.exit(1)")}`;
  run(['start', 'Credit work that ran', '--id', id, '--owner', 'owner', '--seat', 'fault-worker',
    '--seat', 'real-worker', '--budget', '10', '--judge', command]);
  const baseline = captureCodeBaseline(root);
  assert.equal(baseline.status, 'complete');
  const event = (type, data) => run(['event', id, type, '--data', JSON.stringify(data)]);
  event('mission_started', { mission_id: 'm-fault', member: 'fault-worker' });
  event('mission_ended', { mission_id: 'm-fault', outcome: 'fault', reason: 'owned setup fault before any work', cost_usd: 0 });
  assert.deepEqual(collectCodeProvenance(root, baseline).files, [], 'the explicit fault changed no source');
  event('mission_started', { mission_id: 'm-real', member: 'real-worker' });
  fs.writeFileSync(path.join(root, 'product.txt'), '0.9\n');
  fs.writeFileSync(path.join(root, 'result.js'), "module.exports = () => 'real owned change';\n");
  git(['add', '--', 'product.txt', 'result.js']); git(['commit', '-qm', 'real source improves the checked product']);
  const proof = collectCodeProvenance(root, baseline);
  assert.equal(proof.status, 'complete');
  assert.deepEqual(proof.files, ['product.txt', 'result.js']);
  event('step', { mission_id: 'm-real', engine: 'codex', cost_usd: 0 });
  event('mission_ended', { mission_id: 'm-real', outcome: 'kept', cost_usd: 0 });
  const head = git(['rev-parse', 'HEAD']); const tree = git(['rev-parse', 'HEAD^{tree}']);
  const judged = run(['judge', id], 1);
  assert.equal(judged.reading.reading, 0.9);
  const read = () => {
    const store = createSqliteStore(env.ATRIS_CAMPAIGN_DB);
    try { return { events: store.read(id), view: getCampaign(store, id) }; }
    finally { store.close(); }
  };
  const before = read();
  const report = run(['rsi', id, '--next', '--no-write']);
  const rows = run(['export', id, '--trace', '--full'], 0, true);
  assert.deepEqual(read().events, before.events);
  assert.equal(git(['rev-parse', 'HEAD']), head); assert.equal(git(['rev-parse', 'HEAD^{tree}']), tree);
  assert.equal(git(['status', '--porcelain']), '');
  assert.equal(fs.existsSync(path.join(env.ATRIS_RSI_STATE, 'attempts.jsonl')), false);
  assert.equal(fs.existsSync(path.join(env.ATRIS_RSI_STATE, 'dreams.jsonl')), false);
  const fault = report.rsi.members.find(member => member.member === 'fault-worker');
  const prompt = proposalPrompt(before.view, 1, null, report.rsi.lessons.join('\n'), report.rsi);
  assert.equal(rows[1].outcome, 'fault'); assert.equal(rows[1].ticks, 0);
  assert.equal(rows[1].batch.size, 2);
  assert.equal(rows[1].reading_before, 0.1); assert.equal(rows[1].reading_after, 0.9);
  assert.equal(rows[1].judge_passed, false);
  assert.equal(rows[1].reward, null, 'the never-ran fault cannot share another mission\'s measured improvement');
  assert.equal(rows[2].reward, 0.8, 'actual work keeps the full measured gain');
  assert.equal(fault.reward, 0); assert.equal(fault.judge_passed, 0); assert.equal(fault.status, 'unproven');
  assert.equal(fault.failed, 1, 'diagnostic failure history is retained');
  assert.ok(!report.rsi.lessons.some(line => line.includes('fault-worker gained +')));
  assert.doesNotMatch(prompt, /fault-worker gained \+/);
  assert.match(prompt, /real-worker gained \+0\.8/);
  assert.equal(report.next_campaigns[0].lead_member, 'real-worker');
});
