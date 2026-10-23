const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { collectOrbContext } = require('../lib/orb-context');

const now = Date.parse('2025-02-12T12:00:00Z');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orb-context-collect-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    root,
    write(name, content) {
      const target = path.join(root, name);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content);
    },
  };
}

test('collectOrbContext combines project notes, tasks, loops and caller threads', async (t) => {
  const { root, write } = fixture(t);
  write('now.md', '# 2025-02-12\nShipped the first pass.\n');
  write('.atris/state/tasks.projection.json', JSON.stringify({
    schema: 'atris.task_projection.v1',
    tasks: [
      { id: 'review-one', title: 'Check the release', status: 'review' },
      { id: 'next-one', title: 'Write the guide', status: 'open', lane: 'docs' },
    ],
  }));
  write('.atris/state/member-loops/alex.latest.json', JSON.stringify({ member: 'alex', mode: 'active' }));
  write('.atris/state/member-loops/ignored.json', JSON.stringify({ member: 'ignored' }));

  const result = await collectOrbContext(root, {
    now,
    threads: [{ id: 'conversation', title: 'Explore the dashboard', updatedAt: now - 3600000 }],
  });

  assert.strictEqual(result.schema, 'obelisk.orb_context.v1');
  assert.deepStrictEqual(result.greeting_facts, {
    threadCount: 1, warmThreadCount: 1, reviewCount: 1, doingCount: 0,
    certifiedReviewCount: 0, stalledDoingCount: 0, failedCount: 0,
    loopCount: 1, hasNow: true, hasJournalToday: true,
  });
  assert.deepStrictEqual(result.suggestions.map((s) => s.id), [
    'review:review-one', 'resume:conversation', 'start:next-one',
    'status', 'plan-today', 'look-around',
  ]);
  assert.strictEqual(result.suggestions[2].label, 'start: Write the guide');
  assert.strictEqual(result.suggestions[2].side, 'docs');
  assert.deepStrictEqual(result.beats, ['One thread is warm. One task waits for review.', 'Tap the next move.']);
});

test('collectOrbContext tolerates malformed files and rejects unsupported projections', async (t) => {
  const { root, write } = fixture(t);
  write('.atris/state/tasks.projection.json', '{broken');
  write('.atris/state/member-loops/broken.latest.json', '{broken');
  write('.atris/state/member-loops/empty.latest.json', JSON.stringify({}));
  const malformed = await collectOrbContext(root, { now });
  assert.strictEqual(malformed.greeting_facts.reviewCount, 0);
  assert.strictEqual(malformed.greeting_facts.loopCount, 0);
  assert.deepStrictEqual(malformed.suggestions.map((s) => s.id), [
    'log-today', 'status', 'plan-today', 'look-around',
  ]);
  assert.strictEqual(malformed.suggestions[0].side, '2025-02-12');

  write('.atris/state/tasks.projection.json', JSON.stringify({
    schema: 'unsupported', tasks: [{ id: 'ignored', title: 'Ignore this', status: 'review' }],
  }));
  assert.deepStrictEqual(await collectOrbContext(root, { now }), malformed);
  write('.atris/state/tasks.projection.json', JSON.stringify({
    schema: 'atris.task_projection.v1', tasks: {},
  }));
  assert.deepStrictEqual(await collectOrbContext(root, { now }), malformed);
});

test('collectOrbContext leaves an empty folder untouched and handles invalid roots', async (t) => {
  const { root } = fixture(t);
  const result = await collectOrbContext(root, { now });
  assert.deepStrictEqual(fs.readdirSync(root), []);
  assert.strictEqual(result.greeting_facts.hasNow, false);
  assert.strictEqual(result.greeting_facts.hasJournalToday, false);
  assert.strictEqual(result.greeting_facts.threadCount, 0);
  assert.deepStrictEqual(result.beats, [
    'Quiet workspace. Nothing is mid-flight.',
    'Tap a starting move, or say it your way.',
  ]);
  assert.strictEqual(result.suggestions.find((s) => s.id === 'plan-today').side, 'fresh');
  for (const invalidRoot of [null, '', 42]) {
    assert.deepStrictEqual(await collectOrbContext(invalidRoot, { now }), result);
  }
});
