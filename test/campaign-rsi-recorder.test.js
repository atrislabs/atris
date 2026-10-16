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
