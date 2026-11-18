'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tasks = require('../lib/task-db');
const { recordTaskEpisodeScorecards, verifyTaskEpisodeScorecards } = require('../commands/brain');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-scorecard-order-'));
  const state = path.join(root, '.atris', 'state'); fs.mkdirSync(state, { recursive: true });
  t.after(() => { tasks.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, state, episodes: path.join(state, 'task_episodes.jsonl'), cards: path.join(state, 'scorecards.jsonl') };
}
function episode({ id, workspace = '/fixture/a', task = 'one', version, proof = id }) {
  return { schema: 'atris.task_episode.v1', episode_id: id, workspace_root: workspace, task_id: task,
    action: version === undefined ? {} : { version }, proof, reward: { value: 0 } };
}
function seed(f, rows) { fs.writeFileSync(f.episodes, rows.map(row => JSON.stringify(row)).join('\n') + '\n'); }
function cards(f) { return fs.readFileSync(f.cards, 'utf8').trim().split('\n').map(JSON.parse); }

test('actual concurrent-shaped review appends select and verify the newer committed event', t => {
  const f = fixture(t); const ws = path.join(f.root, 'work'); fs.mkdirSync(ws);
  const db = tasks.open(path.join(f.root, 'tasks.db'));
  const { id } = tasks.addTask(db, { title: 'Synthetic', workspaceRoot: ws, status: 'review', metadata: { approval_status: 'pending' } });
  const original = fs.appendFileSync; let secondRan = false;
  fs.appendFileSync = function (file, ...args) {
    if (String(file).endsWith('task_episodes.jsonl') && !secondRan) {
      secondRan = true; tasks.reviewTask(db, { id, actor: 'second', reward: 0, proof: 'newer proof' });
    }
    return original.call(this, file, ...args);
  };
  try { tasks.reviewTask(db, { id, actor: 'first', reward: 0, proof: 'older proof' }); }
  finally { fs.appendFileSync = original; }
  const rows = fs.readFileSync(path.join(ws, '.atris/state/task_episodes.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(rows.map(row => row.proof), ['newer proof', 'older proof']);
  seed(f, rows); const result = recordTaskEpisodeScorecards({ root: f.root });
  assert.equal(result.written, 1); assert.equal(result.scorecards[0].proof, 'newer proof');
  assert.equal(result.scorecards[0].source_episode_id, rows[0].episode_id);
  verifyTaskEpisodeScorecards(f.root);
  assert.equal(recordTaskEpisodeScorecards({ root: f.root }).written, 0);
});

test('conflicting, missing and invalid versions retain the previous last-file behavior', t => {
  const f = fixture(t);
  for (const [a, b] of [[3, 3], [5, undefined], [5, '4'], [5, 0], [5, 1.5], [5, Number.MAX_SAFE_INTEGER + 1]]) {
    seed(f, [episode({ id: `first-${String(b)}`, version: a }), episode({ id: `last-${String(b)}`, version: b })]);
    const result = recordTaskEpisodeScorecards({ root: f.root });
    assert.equal(result.scorecards[0].source_episode_id, `last-${String(b)}`);
    verifyTaskEpisodeScorecards(f.root);
  }
});

test('unknown source identity retains file order even when versions look ordered', t => {
  const f = fixture(t);
  const unknown = episode({ id: 'unknown-new', version: 8 }); unknown.workspace_root = null;
  const unknownLast = episode({ id: 'unknown-last', version: 1 }); unknownLast.workspace_root = null;
  seed(f, [unknown, unknownLast]);
  assert.equal(recordTaskEpisodeScorecards({ root: f.root }).scorecards[0].source_episode_id, 'unknown-last');
  const noId = episode({ id: 'unused', version: 8 }); delete noId.episode_id;
  seed(f, [noId, episode({ id: 'identified-last', version: 1 })]);
  assert.equal(recordTaskEpisodeScorecards({ root: f.root }).scorecards[0].source_episode_id, 'identified-last');
});

test('same task IDs in separate workspaces select independent versions', t => {
  const f = fixture(t);
  seed(f, [episode({ id: 'a-high', workspace: '/fixture/a', version: 8 }), episode({ id: 'b-low', workspace: '/fixture/b', version: 1 }),
    episode({ id: 'b-high', workspace: '/fixture/b', version: 2 }), episode({ id: 'a-low', workspace: '/fixture/a', version: 2 })]);
  const result = recordTaskEpisodeScorecards({ root: f.root });
  assert.deepEqual(result.scorecards.map(row => row.source_episode_id).sort(), ['a-high', 'b-high']);
  assert.deepEqual(result.scorecards.map(row => row.source_workspace_root).sort(), ['/fixture/a', '/fixture/b']);
  verifyTaskEpisodeScorecards(f.root);
  assert.equal(recordTaskEpisodeScorecards({ root: f.root }).written, 0);
});

test('colliding episode IDs across workspaces require a scorecard for each workspace', t => {
  const f = fixture(t);
  seed(f, [episode({ id: 'shared', workspace: '/fixture/a', version: 1 }), episode({ id: 'shared', workspace: '/fixture/b', version: 1 })]);
  fs.writeFileSync(f.cards, JSON.stringify({ source_episode_id: 'shared' }) + '\n');
  assert.throws(() => verifyTaskEpisodeScorecards(f.root), /missing/);
  const result = recordTaskEpisodeScorecards({ root: f.root });
  assert.equal(result.written, 2); assert.equal(cards(f).length, 3);
  verifyTaskEpisodeScorecards(f.root);
  assert.equal(recordTaskEpisodeScorecards({ root: f.root }).written, 0);
});

test('colliding episode IDs across tasks in one workspace require separate scorecards', t => {
  const f = fixture(t);
  seed(f, [episode({ id: 'shared', task: 'one', version: 1 }), episode({ id: 'shared', task: 'two', version: 1 })]);
  fs.writeFileSync(f.cards, JSON.stringify({ source_episode_id: 'shared' }) + '\n');
  assert.throws(() => verifyTaskEpisodeScorecards(f.root), /missing/);
  assert.equal(recordTaskEpisodeScorecards({ root: f.root }).written, 2);
  assert.deepEqual(cards(f).slice(1).map(row => row.task_id).sort(), ['one', 'two']);
  verifyTaskEpisodeScorecards(f.root);
  assert.equal(recordTaskEpisodeScorecards({ root: f.root }).written, 0);
});

test('an unselected older collision still makes an unscoped legacy scorecard ambiguous', t => {
  const f = fixture(t);
  seed(f, [episode({ id: 'shared', workspace: '/fixture/a', version: 1 }),
    episode({ id: 'newer', workspace: '/fixture/a', version: 2 }),
    episode({ id: 'shared', workspace: '/fixture/b', version: 1 })]);
  fs.writeFileSync(f.cards, JSON.stringify({ source_episode_id: 'shared' }) + '\n');
  assert.throws(() => verifyTaskEpisodeScorecards(f.root), /missing/);
  const result = recordTaskEpisodeScorecards({ root: f.root });
  assert.deepEqual(result.scorecards.map(row => row.source_episode_id).sort(), ['newer', 'shared']);
  verifyTaskEpisodeScorecards(f.root);
});

test('projection enrichment requires a matching explicit source workspace', t => {
  const f = fixture(t);
  const landing = { happened: 'Only in this workspace' };
  const projection = rows => fs.writeFileSync(path.join(f.state, 'tasks.projection.json'), JSON.stringify({ tasks: rows }));
  for (const [index, source, projected, shouldEnrich] of [
    [0, '/fixture/a', '/fixture/a', true], [1, '/fixture/a', '/fixture/b', false],
    [2, '/fixture/a', undefined, false], [3, undefined, '/fixture/a', false],
  ]) {
    const row = episode({ id: `projection-${index}`, version: 1 });
    row.workspace_root = source;
    seed(f, [row]); projection([{ id: 'one', workspace_root: projected, review: { landing } }]);
    const result = recordTaskEpisodeScorecards({ root: f.root });
    assert.equal(Boolean(result.scorecards[0].review_landing), shouldEnrich);
  }
});

test('an existing legacy scorecard still satisfies a uniquely scoped episode', t => {
  const f = fixture(t); seed(f, [episode({ id: 'legacy', version: undefined })]);
  fs.writeFileSync(f.cards, JSON.stringify({ source_episode_id: 'legacy' }) + '\n');
  assert.equal(recordTaskEpisodeScorecards({ root: f.root }).written, 0);
  verifyTaskEpisodeScorecards(f.root);
});

test('verification fails when only the earlier episode was scored', t => {
  const f = fixture(t); seed(f, [episode({ id: 'new', version: 3 }), episode({ id: 'old', version: 2 })]);
  fs.writeFileSync(f.cards, JSON.stringify({ source_episode_id: 'old' }) + '\n');
  assert.throws(() => verifyTaskEpisodeScorecards(f.root), /missing: new/);
  assert.equal(recordTaskEpisodeScorecards({ root: f.root }).scorecards[0].source_episode_id, 'new');
  verifyTaskEpisodeScorecards(f.root);
});
