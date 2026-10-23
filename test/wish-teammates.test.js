'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runWishCli, readJsonl, makeFakeEngines } = require('./helpers/wish-fixture');

function makeWorkspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-wish-teammates-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const memberDir = path.join(root, 'atris', 'team', 'builder');
  fs.mkdirSync(memberDir, { recursive: true });
  fs.writeFileSync(path.join(memberDir, 'MEMBER.md'), '---\nname: "Hugo"\nid: member-seven\nrole: builder\n---\n');
  fs.writeFileSync(path.join(root, 'atris', 'team', 'legacy.md'), '---\nname: Iris\ntype: member\n---\n');
  return {
    cwd: root,
    env: {
      PATH: `${makeFakeEngines(root)}:/usr/bin:/bin:/usr/sbin:/sbin`,
      ATRIS_TASKS_DB: path.join(root, 'tasks.db'),
    },
  };
}

test('wish recognizes teammate display names, then member ids and slugs, ignoring case', (t) => {
  const workspace = makeWorkspace(t);
  for (const name of ['Hugo', 'hUgO', 'MEMBER-SEVEN', 'BuIlDeR', 'IrIs', 'LeGaCy']) {
    const result = runWishCli(['wish', `improve member ${name} output for operators`, '--no-mission'], workspace);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.doesNotMatch(result.stdout, /Which workspace, repo, file, or team member/);
  }
  const records = readJsonl(path.join(workspace.cwd, '.atris', 'state', 'wishes.jsonl'));
  assert.equal(records.some((record) => record.status === 'needs_input'), false);
  assert.equal(records.filter((record) => record.status === 'captured_no_mission').length, 6);
});

test('wish still asks when a named teammate is unknown', (t) => {
  const workspace = makeWorkspace(t);
  const result = runWishCli(['wish', 'improve member Hugh output for operators', '--no-mission'], workspace);
  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.match(result.stdout, /Which workspace, repo, file, or team member did you mean by Hugh\?/);
  const records = readJsonl(path.join(workspace.cwd, '.atris', 'state', 'wishes.jsonl'));
  const asked = records.find((record) => record.status === 'needs_input');
  assert.deepEqual(asked.questions, ['Which workspace, repo, file, or team member did you mean by Hugh?']);
  assert.equal(records.some((record) => record.status === 'captured_no_mission'), false);
});
