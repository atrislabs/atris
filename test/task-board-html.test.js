// The task board page splits into two functions: taskBoardViewModel shapes
// projection state (rows, counts, column groupings) with no markup, and
// taskBoardTemplate turns a view model into the HTML page. This pins the
// shape of the view model and the key markers of the rendered page.

const test = require('node:test');
const assert = require('node:assert/strict');
const { taskBoardViewModel, taskBoardTemplate } = require('../commands/task');

const COLUMN_KEYS = ['backlog', 'open', 'doing', 'review', 'blocked', 'done'];

function fixtureProjection() {
  return {
    tasks: [
      { id: 'task-backlog', status: 'open', tag: 'tasks' },
      { id: 'task-open', status: 'open', tag: 'plan' },
      { id: 'task-doing', status: 'claimed', tag: 'tasks' },
      { id: 'task-review', status: 'review', tag: 'tasks' },
      { id: 'task-done-unreviewed', status: 'done', tag: 'tasks' },
      { id: 'task-done', status: 'done', tag: 'tasks', review: { proof: 'npm test' } },
      { id: 'task-blocked', status: 'failed', tag: 'tasks' },
      { id: 'task-failed-reviewed', status: 'failed', tag: 'tasks', latest_event_type: 'reviewed' },
    ],
  };
}

test('view model groups fixture tasks into the six board columns', () => {
  const model = taskBoardViewModel(fixtureProjection());

  assert.deepEqual(model.columns.map((column) => column.key), COLUMN_KEYS);
  assert.equal(model.total, 8);
  assert.deepEqual(model.counts, {
    backlog: 1,
    open: 1,
    doing: 1,
    review: 2, // unreviewed done tasks come back to review
    blocked: 1,
    done: 2, // reviewed done + reviewed failed
  });

  const columnFor = (id) => model.rows.find((row) => row.id === id).column;
  assert.equal(columnFor('task-backlog'), 'backlog');
  assert.equal(columnFor('task-open'), 'open');
  assert.equal(columnFor('task-doing'), 'doing');
  assert.equal(columnFor('task-done-unreviewed'), 'review');
  assert.equal(columnFor('task-failed-reviewed'), 'done');

  assert.ok(Array.isArray(model.planTags) && model.planTags.includes('plan'));
});

test('view model marks decision rows: reviewed tasks carry decision=true', () => {
  const model = taskBoardViewModel(fixtureProjection());
  const decided = model.rows.filter((row) => row.decision).map((row) => row.id).sort();
  assert.deepEqual(decided, ['task-done', 'task-failed-reviewed']);
  assert.equal(model.rows.find((row) => row.id === 'task-doing').decision, false);
});

test('template renders the view model into the board page', () => {
  const model = taskBoardViewModel(fixtureProjection());
  const html = taskBoardTemplate(model);

  assert.ok(html.startsWith('<!doctype html>'));
  assert.ok(html.includes('<title>Atris Task Factory</title>'));
  assert.ok(html.includes('<div class="grid" id="board">'));
  assert.ok(html.includes(`const planTags = new Set(${JSON.stringify(model.planTags)});`));
  // The page hydrates from the API in the browser; every board column key
  // must appear in the client script so grouped rows have a home.
  for (const key of COLUMN_KEYS) assert.ok(html.includes(`'${key}'`), `column key ${key} missing`);
});

test('empty board renders: no tasks yields empty columns and a full page', () => {
  const model = taskBoardViewModel({});
  assert.equal(model.total, 0);
  assert.deepEqual(model.rows, []);
  assert.deepEqual(model.counts, { backlog: 0, open: 0, doing: 0, review: 0, blocked: 0, done: 0 });

  const html = taskBoardTemplate(model);
  assert.ok(html.includes('</html>'));
  assert.ok(html.includes('id="heartbeat"'));
});
