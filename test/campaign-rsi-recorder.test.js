'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMemoryStore } = require('../lib/campaign-store');
const { writeRsiSnapshot } = require('../lib/campaign-rsi');
const recorder = require('../lib/rsi-record');

// Exercise the installed recorder adapter in real subprocesses. This fixture
// implements only its start/open/finish file protocol, with no campaign logic.
const RECORD_PY = `import json, os, sys
from pathlib import Path
args = sys.argv[1:]
state = Path(os.environ['ATRIS_RSI_STATE'])
state.mkdir(parents=True, exist_ok=True)
file = state / 'attempts.jsonl'
def flag(name): return args[args.index(name) + 1]
def append(row):
    with file.open('a') as out: out.write(json.dumps(row) + '\\n')
if args[0] == 'start-tree': print('x-' + flag('--date'))
elif args[0] == 'open':
    row = {'schema': 'atris.rsi.node.v1', 'id': 'n_campaign_' + str(len(file.read_text().splitlines()) if file.exists() else 0), 'tree_id': flag('--tree'), 'lane': flag('--lane'), 'context': json.loads(flag('--context-json')), 'action': json.loads(flag('--action-json')), 'outcome': {'status': 'running'}}
    append(row)
    print(row['id'])
elif args[0] == 'finish':
    fail_once = state / 'fail_finish_once'
    if fail_once.exists():
        fail_once.unlink()
        sys.exit(1)
    row = next(json.loads(line) for line in reversed(file.read_text().splitlines()) if json.loads(line)['id'] == flag('--node'))
    row['outcome'].update(json.loads(flag('--outcome-json')))
    append(row)
    print(row['id'])
`;

function recorderWorkspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-campaign-recorder-'));
  const saved = Object.fromEntries(['ATRIS_RSI_STATE', recorder.GUARD_ENV].map((key) => [key, process.env[key]]));
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  process.env.ATRIS_RSI_STATE = path.join(root, '.atris', 'state', 'rsi');
  delete process.env[recorder.GUARD_ENV];
  const scripts = path.join(root, 'backend', 'scripts', 'rsi');
  fs.mkdirSync(scripts, { recursive: true });
  fs.writeFileSync(path.join(scripts, 'record.py'), RECORD_PY);
  return root;
}

test('campaign learning waits for its judge, finishes the recorder, and does not duplicate the result', (t) => {
  const root = recorderWorkspace(t);
  const store = createMemoryStore();
  const append = (type, data) => store.append({ campaign_id: 'cmp-record', type, actor: 'builder', data });
  append('campaign_started', { title: 'Learn from measured outcomes', owner: 'builder', judge: 'false', budget: 10 });
  append('judge_ran', { passed: false, reading: 0 });
  append('mission_started', { mission_id: 'm-one', member: 'builder', engine: 'codex' });
  append('mission_ended', { mission_id: 'm-one', outcome: 'kept', cost_usd: 0 });

  writeRsiSnapshot(root, store);
  assert.equal(recorder.latestNodes(root).length, 0, 'do not freeze an unjudged outcome');
  assert.equal(process.env[recorder.GUARD_ENV], undefined);
  append('judge_ran', { passed: true, reading: 1 });
  writeRsiSnapshot(root, store);
  const nodes = recorder.latestNodes(root);
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].outcome.status, 'shipped');
  assert.equal(nodes[0].outcome.verify, 'pass');
  assert.equal(process.env[recorder.GUARD_ENV], undefined, 'finishing must clear the nested-attempt guard');
  writeRsiSnapshot(root, store);
  assert.equal(recorder.latestNodes(root).length, 1);
  assert.equal(fs.readFileSync(recorder.attemptsPath(root), 'utf8').trim().split('\n').length, 2, 'one open and one finish only');
});

test('later judge evidence finishes a legacy skipped result on its original node only once', (t) => {
  const root = recorderWorkspace(t);
  const store = createMemoryStore();
  const append = (type, data) => store.append({ campaign_id: 'cmp-legacy-gain', type, actor: 'builder', data });
  append('campaign_started', { title: 'Recover late judge evidence', owner: 'builder', judge: 'false', budget: 10 });
  append('judge_ran', { passed: false, reading: 0 });
  append('mission_started', { mission_id: 'm-legacy-gain', member: 'builder', engine: 'codex' });
  append('mission_ended', { mission_id: 'm-legacy-gain', outcome: 'kept', cost_usd: 0 });
  const attempt = recorder.beginAttempt(root, { lane: 'campaign', ground: 'cmp-legacy-gain/m-legacy-gain', engine: 'codex' });
  assert.ok(attempt);
  assert.equal(recorder.finishAttempt(root, attempt, { status: 'shipped', verify: 'skipped', reason: 'the judge had not run yet' }), true);
  const original = recorder.latestNodes(root)[0];
  const originalRows = fs.readFileSync(recorder.attemptsPath(root), 'utf8').trim().split('\n').length;

  append('judge_ran', { passed: false, reading: 0.5 });
  writeRsiSnapshot(root, store);
  const nodes = recorder.latestNodes(root);
  assert.equal(nodes.length, 1, 'late proof must not open another attempt');
  assert.equal(nodes[0].id, original.id);
  assert.equal(nodes[0].tree_id, original.tree_id);
  assert.deepEqual(nodes[0].context, original.context);
  assert.deepEqual(nodes[0].action, original.action);
  assert.equal(nodes[0].outcome.status, 'shipped');
  assert.equal(nodes[0].outcome.verify, 'pass');
  const refreshed = fs.readFileSync(recorder.attemptsPath(root), 'utf8');
  assert.equal(refreshed.trim().split('\n').length, originalRows + 1, 'append only the corrected finish');
  assert.equal(process.env[recorder.GUARD_ENV], undefined);

  writeRsiSnapshot(root, store);
  assert.equal(fs.readFileSync(recorder.attemptsPath(root), 'utf8'), refreshed, 'unchanged proof must not append another finish');
});

test('legacy skipped results stay unchanged without judge evidence or reading gain', (t) => {
  const root = recorderWorkspace(t);
  const store = createMemoryStore();
  for (const campaignId of ['cmp-legacy-unjudged', 'cmp-legacy-neutral']) {
    const append = (type, data) => store.append({ campaign_id: campaignId, type, actor: 'builder', data });
    const missionId = `${campaignId}-mission`;
    append('campaign_started', { title: 'Keep unproven results unproven', owner: 'builder', judge: 'false', budget: 10 });
    append('judge_ran', { passed: false, reading: 0 });
    append('mission_started', { mission_id: missionId, member: 'builder' });
    append('mission_ended', { mission_id: missionId, outcome: 'kept', cost_usd: 0 });
    const attempt = recorder.beginAttempt(root, { lane: 'campaign', ground: `${campaignId}/${missionId}`, engine: 'codex' });
    assert.ok(attempt);
    assert.equal(recorder.finishAttempt(root, attempt, { status: 'shipped', verify: 'skipped', reason: 'the judge had not run yet' }), true);
    if (campaignId === 'cmp-legacy-neutral') append('judge_ran', { passed: false, reading: 0 });
  }
  const original = fs.readFileSync(recorder.attemptsPath(root), 'utf8');
  const nodes = recorder.latestNodes(root);
  assert.equal(nodes.length, 2);
  assert.equal(new Set(nodes.map((node) => node.id)).size, 2, 'the recorder fixture must keep distinct identities');

  writeRsiSnapshot(root, store);
  writeRsiSnapshot(root, store);
  assert.equal(fs.readFileSync(recorder.attemptsPath(root), 'utf8'), original);
  assert.ok(recorder.latestNodes(root).every((node) => node.outcome.verify === 'skipped'));
});


test('a failed recorder finish can be retried on the next snapshot', (t) => {
  const root = recorderWorkspace(t);
  const state = process.env.ATRIS_RSI_STATE;
  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(path.join(state, 'fail_finish_once'), 'fail the next finish');
  const store = createMemoryStore();
  const append = (type, data) => store.append({ campaign_id: 'cmp-retry', type, actor: 'builder', data });
  append('campaign_started', { title: 'Keep measured learning after a recorder error', owner: 'builder', judge: 'false', budget: 10 });
  append('judge_ran', { passed: false, reading: 0 });
  append('mission_started', { mission_id: 'm-one', member: 'builder' });
  append('mission_ended', { mission_id: 'm-one', outcome: 'kept', cost_usd: 0 });
  append('judge_ran', { passed: true, reading: 1 });
  writeRsiSnapshot(root, store);
  assert.equal(recorder.latestNodes(root)[0].outcome.status, 'running');
  assert.equal(process.env[recorder.GUARD_ENV], undefined);
  writeRsiSnapshot(root, store);
  assert.equal(recorder.latestNodes(root).length, 1, 'retry must finish the original node without leaving an orphan');
  assert.equal(recorder.latestNodes(root)[0].outcome.status, 'shipped');
  assert.equal(recorder.latestNodes(root)[0].outcome.verify, 'pass');
  assert.equal(process.env[recorder.GUARD_ENV], undefined);
});
