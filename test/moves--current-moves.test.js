'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { currentMoves } = require('../commands/moves');

function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'moves-current-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    root,
    write(file, text) {
      const target = path.join(root, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, text);
    },
  };
}

// No dream records are created: their freshness is the only clock-dependent
// candidate path. All candidates here come from explicit workspace files.
test('currentMoves ranks roadmap before tasks, deduplicates titles, and honors limits', (t) => {
  const { root, write } = workspace(t);
  write('ROADMAP.md', '# Roadmap\n\n## Open loop items\n- [ ] Ship export\n- [x] Already shipped\n\n## Later\n- [ ] Outside the queue\n');
  write('.atris/state/tasks.projection.json', JSON.stringify({ tasks: [
    { id: 'task-a', title: 'ship EXPORT', status: 'open' },
    { id: 'task-b', display_id: '7', title: 'Fix preview', status: 'claimed', claimed_by: 'builder' },
    { id: 'task-c', title: 'Closed task', status: 'done' },
  ] }));
  const moves = currentMoves(root);
  assert.deepStrictEqual(moves.map(({ title, source, weight }) => ({ title, source, weight })), [
    { title: 'Ship export', source: 'roadmap', weight: 100 },
    { title: 'Fix preview', source: 'task', weight: 60 },
  ]);
  assert.strictEqual(moves[0].why, 'open item in ROADMAP.md, the goal the loop pursues');
  assert.match(moves[0].id, /^m_[a-z0-9]+$/);
  assert.strictEqual(moves[1].task_id, 'task-b');
  assert.strictEqual(moves[1].ref, '7');
  assert.strictEqual(moves[1].why, 'task in flight (claimed, builder)');
  assert.deepStrictEqual(currentMoves(root, 1), [moves[0]]);
  assert.deepStrictEqual(currentMoves(root, 0), []);
});

test('currentMoves suppresses decided ideas but retains a matching active task', (t) => {
  const { root, write } = workspace(t);
  write('ROADMAP.md', '## Open loop items\n- [ ] Keep working\n- [ ] Drop idea\n- [ ] Approved idea\n- [ ] Reviewed idea\n');
  write('.atris/state/tasks.projection.json', JSON.stringify({ tasks: [
    { id: 'active', title: 'Keep working', status: 'open' },
    { id: 'reviewed', title: 'Reviewed idea', status: 'review' },
  ] }));
  write('.atris/state/moves.decisions.jsonl', [
    { title: ' KEEP WORKING ', decision: 'kill' },
    { title: 'Drop idea', decision: 'kill' },
    { title: 'Approved idea', decision: 'approve' },
  ].map(JSON.stringify).join('\n'));
  const moves = currentMoves(root);
  assert.strictEqual(moves.length, 1);
  assert.strictEqual(moves[0].title, 'Keep working');
  assert.strictEqual(moves[0].source, 'task');
  assert.strictEqual(moves[0].task_id, 'active');
});

test('currentMoves returns no moves for empty or malformed workspace data', (t) => {
  const { root, write } = workspace(t);
  assert.deepStrictEqual(currentMoves(root), []);
  write('.atris/state/tasks.projection.json', '{broken json');
  write('.atris/state/missions.jsonl', 'not json\n');
  write('.atris/state/moves.decisions.jsonl', '{\n');
  write('ROADMAP.md', '## Open loop items\n- [x] Finished\n- [~] In flight\n');
  assert.deepStrictEqual(currentMoves(root), []);
});
