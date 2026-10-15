'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { judgeReading, judgeRanData, latestJudgeOutput, outputTail } = require('../lib/campaign-reading');

test('node --test counts give the pass share, colored or piped', () => {
  assert.equal(judgeReading('✔ a\n✖ b\nℹ tests 3\nℹ suites 0\nℹ pass 2\nℹ fail 1\nℹ cancelled 0\nℹ duration_ms 117\n✖ failing tests:\n  diff: \'simple\''), 0.6667);
  assert.equal(judgeReading('# tests 4\n# pass 4\n# fail 0\n'), 1);
  assert.equal(judgeReading('\x1b[34mℹ pass 1\x1b[39m\n\x1b[34mℹ fail 3\x1b[39m'), 0.25);
  assert.equal(judgeReading('pass 3, fail 1'), 0.75, 'the summary line the CLI stores reads back');
  assert.equal(judgeReading('ℹ pass 2\nℹ fail 0\nℹ pass 0\nℹ fail 2'), 0.5, 'chained runs are summed');
  assert.equal(judgeReading('ℹ pass 1\nℹ fail 0\nℹ cancelled 1'), 0.5, 'a cancelled test is not a pass');
});

test('jest, vitest, pytest, and mocha counts', () => {
  assert.equal(judgeReading('PASS a\nTests:       1 failed, 4 passed, 5 total\nTime: 1s'), 0.8);
  assert.equal(judgeReading('Tests:       2 skipped, 3 passed, 5 total'), 1, 'skipped tests are left out');
  assert.equal(judgeReading(' Test Files  1 passed (1)\n      Tests  1 failed | 3 passed (4)\n   Start at  10:00'), 0.75);
  assert.equal(judgeReading('collected 5 items\n\n===== 2 failed, 3 passed in 0.12s ====='), 0.6);
  assert.equal(judgeReading('1 passed, 1 error in 0.30s'), 0.5);
  assert.equal(judgeReading('  4 passing (20ms)\n  1 failing\n\n  1) thing:\n     Error: boom'), 0.8);
});

test('a final line like "3 of 5 live" and a stated reading', () => {
  assert.equal(judgeReading('checking hosts\nweb up\n3 of 5 live'), 0.6);
  assert.equal(judgeReading('2/8 pages render'), 0.25);
  assert.equal(judgeReading('ℹ pass 1\nℹ fail 1\nreading: 0.9'), 0.9, 'a judge that states its reading wins');
  assert.equal(judgeReading('reading = 1.7'), 1, 'clamped to 1');
  assert.equal(judgeReading('6 of 5 live'), null, 'more than the total is not a share');
});

test('no counts, no reading: a number is never invented', () => {
  assert.equal(judgeReading(''), null);
  assert.equal(judgeReading('Error: cannot find module ./x'), null);
  assert.equal(judgeReading('ℹ duration_ms 82.6'), null);
  assert.equal(judgeReading('ℹ pass 0\nℹ fail 0'), null);
  assert.equal(judgeReading(undefined), null);
});

test('judge_ran data carries the reading and the output tail only when present', () => {
  assert.deepEqual(judgeRanData({ passed: false, exit: 1, summary: 'pass 2, fail 1', seconds: 3, reading: 0.6667, output_tail: 'ℹ pass 2\nℹ fail 1' }),
    { passed: false, summary: 'pass 2, fail 1', seconds: 3, reading: 0.6667, output_tail: 'ℹ pass 2\nℹ fail 1' });
  assert.deepEqual(judgeRanData({ passed: true, exit: 0, summary: '', seconds: 0, reading: null, output_tail: '' }), { passed: true, summary: 'exit 0', seconds: 0 });
});

test('the output tail keeps the last 40 lines, at most 4 KB, without color', () => {
  const lines = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`);
  const tail = outputTail(`${lines.join('\n')}\n\n\n`);
  assert.equal(tail.split('\n').length, 40);
  assert.equal(tail.split('\n')[0], 'line 61');
  assert.equal(tail.split('\n').pop(), 'line 100');
  assert.equal(outputTail('\x1b[31mred\x1b[39m\r\nok'), 'red\nok');
  const wide = outputTail(`start\n${'é'.repeat(5000)}\nend`);
  assert.ok(Buffer.byteLength(wide) <= 4096);
  assert.ok(wide.endsWith('\nend'));
  assert.ok(!wide.includes('�'), 'never cuts a character in half');
  assert.equal(outputTail(''), '');
});

test('latest judge output is the last judge run in fold order', () => {
  const run = (id, at, data) => ({ id, campaign_id: 'cmp-x', type: 'judge_ran', at, origin: 'o', seq: Number(id.slice(1)), actor: 'judge', data });
  assert.equal(latestJudgeOutput([
    run('e2', '2026-10-15T10:05:00Z', { passed: false, output_tail: 'later' }),
    run('e1', '2026-10-15T10:00:00Z', { passed: false, output_tail: 'earlier' }),
  ]), 'later');
  assert.equal(latestJudgeOutput([run('e1', '2026-10-15T10:00:00Z', { passed: false })]), null);
  assert.equal(latestJudgeOutput([]), null);
});

test('the real judge runner returns the reading and the output tail', async () => {
  const { runJudgeCommand } = require('../commands/campaign');
  const result = await runJudgeCommand("printf 'detail one\\nℹ pass 2\\nℹ fail 1\\n'; exit 1", require('node:os').tmpdir(), 30);
  assert.equal(result.passed, false);
  assert.equal(result.summary, 'pass 2, fail 1');
  assert.equal(result.reading, 0.6667);
  assert.equal(result.output_tail, 'detail one\nℹ pass 2\nℹ fail 1');
});

test('atris campaign judge records the reading and output tail on judge_ran', async () => {
  const { campaignCommand } = require('../commands/campaign');
  const { createMemoryStore } = require('../lib/campaign-store');
  const store = createMemoryStore({ origin: 'laptop' });
  store.append({ campaign_id: 'cmp-read', type: 'campaign_started', actor: 'human:k', data: { title: 'Read', judge: 'npm test', budget: 5 } });
  const saved = { log: console.log, error: console.error };
  console.log = () => {};
  console.error = () => {};
  try {
    await campaignCommand(['judge', 'cmp-read'], { store, actor: 'human:k', runJudge: () => ({ passed: false, exit: 1, summary: 'pass 3, fail 1', seconds: 2, reading: 0.75, output_tail: 'why it failed\npass 3, fail 1' }) });
  } finally {
    console.log = saved.log;
    console.error = saved.error;
  }
  const judged = store.read('cmp-read').filter((e) => e.type === 'judge_ran');
  assert.deepEqual(judged[0].data, { passed: false, summary: 'pass 3, fail 1', seconds: 2, reading: 0.75, output_tail: 'why it failed\npass 3, fail 1' });
});

test('the planner sees the last judge output, fenced, and the graded reading', async () => {
  const { makeLoop, proposalPrompt } = require('../lib/campaign-loop');
  const { createMemoryStore, getCampaign } = require('../lib/campaign-store');
  const store = createMemoryStore({ origin: 'laptop' });
  store.append({ campaign_id: 'cmp-plan', type: 'campaign_started', actor: 'human:k', data: { title: 'Plan', judge: 'npm test', budget: 5, owner: 'mission-lead' } });
  store.append({ campaign_id: 'cmp-plan', type: 'judge_ran', actor: 'judge', data: { passed: false, summary: 'pass 1, fail 1', reading: 0.5, output_tail: 'expected 2, got 3\nat parse (lib/x.js:9)\n```oops```' } });
  let seen = '';
  const loop = makeLoop('/nowhere', {}, { store, log: () => {}, skipReconcile: true, ask: async (root, view, prompt) => { seen = prompt; return { text: '[]', engine: 'fake' }; } });
  await loop.propose('cmp-plan', 1);
  assert.match(seen, /Last judge reading: failed \(0\.5 of 1\): pass 1, fail 1/);
  assert.match(seen, /Last judge output:\n```\nexpected 2, got 3\nat parse \(lib\/x\.js:9\)\n'''oops'''\n```/);
  const view = getCampaign(store, 'cmp-plan');
  assert.doesNotMatch(proposalPrompt(view, 1), /Last judge output/, 'no tail, no section');
});

test('the loop records a graded judge run', async () => {
  const { makeLoop } = require('../lib/campaign-loop');
  const { createMemoryStore } = require('../lib/campaign-store');
  const store = createMemoryStore({ origin: 'laptop' });
  store.append({ campaign_id: 'cmp-loopread', type: 'campaign_started', actor: 'human:k', data: { title: 'L', judge: 'npm test', budget: 5 } });
  const loop = makeLoop('/nowhere', {}, { store, log: () => {}, skipReconcile: true, judge: async () => ({ passed: false, exit: 1, summary: 'pass 1, fail 3', seconds: 1, reading: 0.25, output_tail: 'tail' }) });
  assert.deepEqual(await loop.step('cmp-loopread'), { stop: false, did: 'judge' });
  const run = store.read('cmp-loopread').find((e) => e.type === 'judge_ran');
  assert.equal(run.data.reading, 0.25);
  assert.equal(run.data.output_tail, 'tail');
});
