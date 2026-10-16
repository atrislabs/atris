'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { fold, foldWithPrefixes, compareEvents } = require('../lib/campaign-core');
const { createSqliteStore, getCampaign } = require('../lib/campaign-store');
const { rankCampaignMembers, parseProposals, proposalPrompt } = require('../lib/campaign-loop');
const { captureCodeBaseline, collectCodeProvenance } = require('../lib/mission-code-provenance');

const CLI = path.resolve(__dirname, '..', 'bin', 'atris.js');
const mission = (view, id) => view.missions.find(row => row.id === id);

function history() {
  const events = [];
  const add = (type, data = {}, actor = 'owner') => {
    const seq = events.length + 1;
    events.push({ id: `credit-${seq}`, campaign_id: 'cmp-credit', origin: 'local', seq,
      at: new Date(Date.UTC(2026, 9, 16, 10, 0, seq)).toISOString(), type, actor, data });
    return events.length;
  };
  add('campaign_started', { title: 'Comparable work credit', judge: 'old-check', owner: 'owner',
    seats: ['worker'], budget: 10, standing: true });
  add('judge_ran', { passed: false, reading: 0.1 }, 'judge');
  const work = (id, { steps = 1, outcome = 'failed' } = {}) => {
    add('mission_started', { mission_id: id, member: 'worker' });
    for (let i = 0; i < steps; i++) add('step', { mission_id: id, engine: 'codex', cost_usd: 0 });
    return add('mission_ended', { mission_id: id, outcome, cost_usd: 0,
      ...(outcome === 'fault' ? { reason: 'owned setup failure' } : {}) });
  };
  return { events, add, work };
}

function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}

function prefixes(events) {
  const seen = new Set();
  const ordered = events.filter(event => seen.has(event.id) ? false : seen.add(event.id)).sort(compareEvents);
  const start = ordered.find(event => event.type === 'campaign_started');
  const sequence = [start, ...ordered.filter(event => event !== start)];
  const counts = sequence.map((_, i) => i + 1);
  const inputBytes = JSON.stringify(events);
  const result = foldWithPrefixes(events, [...counts].reverse(), view => view);
  assert.deepEqual(result.view, fold(events));
  for (const count of counts) assert.deepEqual(result.prefixes.get(count), fold(sequence.slice(0, count)));
  assert.equal(JSON.stringify(events), inputBytes);
  return result;
}

for (const actor of ['owner', 'human:operator']) {
  for (const judge of ['old-check', 'new-check']) {
    test(`accepted ${judge === 'old-check' ? 'same-command' : 'replacement'} reset from ${actor} ends pending old-work credit`, () => {
      const h = history();
      const beforeHistoricalPass = h.work('historical');
      h.add('judge_ran', { passed: true, reading: 1 }, 'judge');
      h.add('judge_ran', { passed: false, reading: 0.1 }, 'judge');
      const beforeReset = h.work('pending');
      h.add('judge_set', { judge }, actor);
      h.add('judge_ran', { passed: true, reading: 1 }, 'judge');
      h.add('judge_ran', { passed: false, reading: 0.2 }, 'judge');
      const beforeNewPass = h.work('new-work');
      h.add('judge_ran', { passed: true, reading: 1 }, 'judge');
      for (const input of [h.events, [...h.events].reverse(), [...h.events, h.events[2]]]) {
        const result = prefixes(freeze(input));
        assert.equal(mission(result.view, 'historical').credited, true, 'already judged historical work keeps its credit');
        assert.equal(mission(result.view, 'new-work').credited, true, 'new work can earn the new judge\'s credit');
        assert.equal(mission(result.prefixes.get(beforeHistoricalPass), 'historical').credited, undefined);
        assert.equal(mission(result.prefixes.get(beforeReset), 'pending').credited, undefined);
        assert.equal(mission(result.prefixes.get(beforeNewPass), 'new-work').credited, undefined);
        assert.notStrictEqual(mission(result.prefixes.get(beforeReset), 'pending'), mission(result.view, 'pending'));
        assert.equal(mission(result.view, 'pending').credited, undefined,
          'a passing replacement baseline cannot prove pre-reset stopped-short work');
      }
    });
  }
}

test('an ignored stored outsider reset preserves valid same-judge pending credit', () => {
  const h = history();
  h.work('pending');
  h.add('judge_set', { judge: 'outsider-check' }, 'outsider');
  h.add('judge_ran', { passed: true, reading: 1 }, 'judge');
  const result = prefixes(freeze(h.events));
  assert.equal(result.view.judge, 'old-check');
  assert.equal(mission(result.view, 'pending').credited, true);
  assert.ok(result.view.warnings.some(row => row.code === 'judge_set_not_owner'));
});

test('a failing accepted replacement cannot grant old work retroactive credit on a later pass', () => {
  const h = history();
  h.work('pending');
  h.add('judge_set', { judge: 'new-check' });
  h.add('judge_ran', { passed: false, reading: 0.8 }, 'judge');
  h.add('judge_ran', { passed: true, reading: 1 }, 'judge');
  assert.equal(mission(prefixes(freeze(h.events)).view, 'pending').credited, undefined);
});

test('faults and jobs without steps remain outside normal same-judge credit', () => {
  const h = history();
  const beforePass = h.work('worked');
  h.work('no-step', { steps: 0 });
  h.work('fault', { outcome: 'fault' });
  h.add('judge_ran', { passed: true, reading: 1 }, 'judge');
  const result = prefixes(freeze(h.events));
  assert.equal(mission(result.view, 'worked').credited, true);
  assert.equal(mission(result.prefixes.get(beforePass), 'worked').credited, undefined);
  assert.equal(mission(result.view, 'no-step').credited, undefined);
  assert.equal(mission(result.view, 'fault').credited, undefined);
  assert.equal(mission(result.view, 'fault').reason, 'owned setup failure');
});

const quoted = value => "'" + value.replace(/'/g, "'\\''") + "'";
const judge = script => `exec ${quoted(process.execPath)} -e ${quoted(script)}`;

test('actual replacement baseline keeps old work benched, while a real same-judge gain earns credit', t => {
  const home = process.env.HOME;
  const callerPath = process.env.PATH;
  let calls = 0;
  const cases = [];
  for (const genuine of [false, true]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-judge-credit-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
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
      assert.ifError(child.error);
      assert.equal(child.status, 0, child.stderr || child.stdout);
      return child.stdout.trim();
    };
    fs.writeFileSync(path.join(root, '.gitignore'), '.atris/\natris/runs/\natris/campaigns/\n');
    fs.writeFileSync(path.join(root, 'product.txt'), '0.1\n');
    git(['init', '-q']); git(['config', 'user.name', 'Owned Test']); git(['config', 'user.email', 'test@example.invalid']);
    git(['add', '.']); git(['commit', '-qm', 'owned baseline']);
    const product = fs.readFileSync(path.join(root, 'product.txt'));
    const id = genuine ? 'cmp-genuine-credit' : 'cmp-reset-credit';
    const oldJudge = judge("const n=Number(require('fs').readFileSync('product.txt','utf8'));console.log('reading: '+n);process.exit(n===1?0:1)");
    run(['start', 'Require measured evidence', '--judge', oldJudge, '--id', id, '--owner', 'owner',
      '--seat', 'worker', '--budget', '10', '--standing']);
    const event = (type, data) => run(['event', id, type, '--data', JSON.stringify(data)]);
    for (let i = 1; i <= 2; i++) {
      const mission_id = `m-${i}`;
      event('mission_started', { mission_id, member: 'worker' });
      const baseline = captureCodeBaseline(root);
      assert.equal(baseline.status, 'complete');
      const file = `result-${i}.js`;
      fs.writeFileSync(path.join(root, file), `module.exports = ${i};\n`);
      if (genuine && i === 2) fs.writeFileSync(path.join(root, 'product.txt'), '1\n');
      const files = [file, ...(genuine && i === 2 ? ['product.txt'] : [])];
      git(['add', '--', ...files]); git(['commit', '-qm', 'owned source work']);
      const proof = collectCodeProvenance(root, baseline);
      assert.equal(proof.status, 'complete');
      assert.deepEqual(proof.files, files.sort());
      event('step', { mission_id, engine: 'codex', cost_usd: 0 });
      event('mission_ended', { mission_id, outcome: 'failed', cost_usd: 0 });
      if (i === 1) run(['judge', id], 1);
    }
    const read = () => {
      const store = createSqliteStore(env.ATRIS_CAMPAIGN_DB);
      try { return { view: getCampaign(store, id), events: store.read(id) }; }
      finally { store.close(); }
    };
    const proposal = JSON.stringify([{ objective: 'Continue the bounded source change', member: 'worker', verify: 'test -f result-2.js' }]);
    const before = run(['rsi', id, '--next', '--no-write']);
    assert.deepEqual(before.next_campaigns[0].benched_members, ['worker']);
    assert.equal(parseProposals(proposal, read().view, 1, before.rsi)[0].member, 'owner');
    const head = git(['rev-parse', 'HEAD']);
    const tree = git(['rev-parse', 'HEAD^{tree}']);
    if (genuine) run(['judge', id]);
    else run(['set-judge', id, judge("console.log('reading: 1');process.exit(0)")]);
    const snapshot = read();
    const after = run(['rsi', id, '--next', '--no-write']);
    const trace = run(['export', id, '--trace', '--full'], 0, true);
    assert.deepEqual(read().events, snapshot.events, 'read-only consumers preserve every stored event');
    assert.equal(git(['rev-parse', 'HEAD']), head);
    assert.equal(git(['rev-parse', 'HEAD^{tree}']), tree);
    assert.equal(git(['status', '--porcelain']), '');
    if (!genuine) assert.deepEqual(fs.readFileSync(path.join(root, 'product.txt')), product);
    assert.equal(fs.existsSync(path.join(env.ATRIS_RSI_STATE, 'attempts.jsonl')), false);
    assert.equal(fs.existsSync(path.join(env.ATRIS_RSI_STATE, 'dreams.jsonl')), false);
    cases.push({ genuine, snapshot, after, row: trace.find(row => row.action?.mission_id === 'm-2'),
      parsed: parseProposals(proposal, snapshot.view, 1, after.rsi),
      ranked: rankCampaignMembers(snapshot.view, after.rsi),
      prompt: proposalPrompt(snapshot.view, 1, null, after.rsi.lessons.join('\n'), after.rsi) });
  }
  t.diagnostic(`actual campaign CLI calls: ${calls}; no engine dispatched`);
  assert.equal(process.env.HOME, home);
  assert.equal(process.env.PATH, callerPath);
  const genuine = cases.find(row => row.genuine);
  assert.equal(mission(genuine.snapshot.view, 'm-2').credited, true);
  assert.equal(genuine.row.reward, 0.9);
  assert.equal(genuine.parsed[0].member, 'worker');
  const reset = cases.find(row => !row.genuine);
  assert.equal(reset.row.reward, null);
  assert.equal(reset.row.judge_passed, null);
  assert.equal(reset.after.rsi.members[0].judge_passed, 0);
  assert.equal(reset.after.rsi.members[0].status, 'unproven');
  assert.deepEqual(reset.after.next_campaigns[0].benched_members, ['worker'],
    'a passing replacement baseline cannot lift the old-work failure restriction');
  assert.equal(mission(reset.snapshot.view, 'm-2').credited, undefined);
  assert.equal(reset.ranked.find(row => row.member === 'worker').consecutiveFailures, 2);
  assert.equal(reset.parsed[0].member, 'owner');
  assert.match(reset.prompt, /worker \([^\n]*benched after 2 misses/);
});
