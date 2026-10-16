'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createMemoryStore } = require('../lib/campaign-store');
const { writeRsiSnapshot } = require('../lib/campaign-rsi');
const recorder = require('../lib/rsi-record');

// Exercise the installed recorder adapter in real subprocesses. This fixture
// implements only its start/open/finish file protocol, with no campaign logic.
const RECORD_PY = `import json, os, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
from backend.scripts.rsi.schema import Action, Context, Node, Outcome
def get_node(node_id):
    file = Path(os.environ['ATRIS_RSI_STATE']) / 'attempts.jsonl'
    if not file.exists(): return None
    for line in reversed(file.read_text().splitlines()):
        row = json.loads(line)
        if row['id'] == node_id:
            row.pop('schema', None)
            row['action'] = Action(**row['action'])
            row['context'] = Context(**row['context'])
            row['outcome'] = Outcome(**row['outcome'])
            return Node(**row)
    return None
args = sys.argv[1:]
state = Path(os.environ['ATRIS_RSI_STATE'])
state.mkdir(parents=True, exist_ok=True)
file = state / 'attempts.jsonl'
def flag(name): return args[args.index(name) + 1]
def append(row):
    with file.open('a') as out: out.write(json.dumps(row) + '\\n')
if __name__ == '__main__' and args[0] == 'start-tree': print('x-' + flag('--date'))
elif __name__ == '__main__' and args[0] == 'open':
    row = {'schema': 'atris.rsi.node.v1', 'id': 'n_campaign_' + str(len(file.read_text().splitlines()) if file.exists() else 0), 'tree_id': flag('--tree'), 'lane': flag('--lane'), 'context': json.loads(flag('--context-json')), 'action': json.loads(flag('--action-json')), 'outcome': {'status': 'running'}}
    append(row)
    print(row['id'])
elif __name__ == '__main__' and args[0] == 'finish':
    fail_once = state / 'fail_finish_once'
    if fail_once.exists():
        fail_once.unlink()
        sys.exit(1)
    row = next(json.loads(line) for line in reversed(file.read_text().splitlines()) if json.loads(line)['id'] == flag('--node'))
    row['outcome'].update(json.loads(flag('--outcome-json')))
    append(row)
    print(row['id'])
`;

// A narrow installed-package protocol fixture, not the campaign logic or
// revision labeler. Real backend schema and consumer probes accompany this.
const SCHEMA_PY = `import json, os, uuid
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from pathlib import Path
@dataclass
class Action:
    policy_id: str
    kind: str = 'open'
    ground: str = ''
    engine: str = 'codex'
    model: object = None
    cap_s: int = 1800
    prompt_variant: str = 'v1'
    parent_id: object = None
@dataclass
class Context:
    base_commit: str = ''
    ground: str = ''
    queue_items: int = 0
@dataclass
class Outcome:
    status: str = 'running'
    verify: str = 'skipped'
    files: list = field(default_factory=list)
    reason: str = ''
    cost_usd: object = None
@dataclass
class Node:
    tree_id: str
    lane: str
    context: Context
    action: Action
    outcome: Outcome = field(default_factory=Outcome)
    parent_id: object = None
    id: str = field(default_factory=lambda: 'n_' + uuid.uuid4().hex[:12])
    created_at: object = None
    opened_at: object = None
    recorded_at: object = None
    split: str = 'train'
def tree_split(tree_id): return 'train'
def append_node(node):
    state = Path(os.environ['ATRIS_RSI_STATE'])
    state.mkdir(parents=True, exist_ok=True)
    fail = state / 'fail_finish_once'
    if fail.exists():
        fail.unlink()
        raise RuntimeError('write interrupted')
    node.recorded_at = node.recorded_at or datetime.now(timezone.utc).isoformat()
    with (state / 'attempts.jsonl').open('a') as out:
        out.write(json.dumps({'schema': 'atris.rsi.node.v1', **asdict(node)}) + '\\n')
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
  fs.writeFileSync(path.join(scripts, 'schema.py'), SCHEMA_PY);
  git(root, ['init', '-q']);
  git(root, ['config', 'user.email', 'test@example.com']);
  git(root, ['config', 'user.name', 'Test User']);
  fs.writeFileSync(path.join(root, '.gitignore'), '.atris/\natris/runs/\natris/campaigns/\nbackend/\n');
  fs.writeFileSync(path.join(root, 'base.txt'), 'baseline\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'baseline']);
  return root;
}

function git(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function codeReceipt(root, missionId, files = ['lib/result.js']) {
  const { captureCodeBaseline, collectCodeProvenance } = require('../lib/mission-code-provenance');
  const baseline = captureCodeBaseline(root);
  for (const file of files) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), 'real committed work\n');
  }
  git(root, ['add', '--', ...files]);
  git(root, ['commit', '-qm', 'mission work']);
  const code_provenance = collectCodeProvenance(root, baseline);
  assert.equal(code_provenance.status, 'complete');
  const receipt_path = `atris/runs/${missionId}.json`;
  fs.mkdirSync(path.join(root, 'atris', 'runs'), { recursive: true });
  fs.writeFileSync(path.join(root, receipt_path), JSON.stringify({
    schema: 'atris.mission_receipt.v1', mission_id: missionId, at: new Date().toISOString(), code_provenance,
  }));
  return receipt_path;
}

function seedObservedSkipped(root, store, missionId, ground, engine = 'codex') {
  const receipt = JSON.parse(fs.readFileSync(path.join(root, 'atris', 'runs', missionId + '.json'), 'utf8'));
  const startedAt = store.read(ground.split('/')[0]).find((event) => event.type === 'mission_started' && event.data.mission_id === missionId).at;
  const node = recorder.recordObservedAttempt(root, {
    lane: 'campaign', ground, engine, baseCommit: receipt.code_provenance.base_commit,
    openedAt: startedAt, finishedAt: receipt.at,
    outcome: { status: 'shipped', verify: 'skipped', files: receipt.code_provenance.files, reason: 'the judge had not run yet' },
  });
  assert.ok(node);
  return node;
}

test('campaign learning waits for its judge, finishes the recorder, and does not duplicate the result', (t) => {
  const root = recorderWorkspace(t);
  const store = createMemoryStore();
  const append = (type, data) => store.append({ campaign_id: 'cmp-record', type, actor: 'builder', data });
  append('campaign_started', { title: 'Learn from measured outcomes', owner: 'builder', judge: 'false', budget: 10 });
  append('judge_ran', { passed: false, reading: 0 });
  append('mission_started', { mission_id: 'm-one', member: 'builder', engine: 'codex' });
  append('step', { mission_id: 'm-one', engine: 'codex', cost_usd: 0 });
  append('mission_ended', { mission_id: 'm-one', outcome: 'kept', cost_usd: 0, receipt_path: codeReceipt(root, 'm-one') });

  writeRsiSnapshot(root, store);
  assert.equal(recorder.latestNodes(root).length, 0, 'do not freeze an unjudged outcome');
  assert.equal(process.env[recorder.GUARD_ENV], undefined);
  append('judge_ran', { passed: true, reading: 1 });
  writeRsiSnapshot(root, store);
  const nodes = recorder.latestNodes(root);
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].outcome.status, 'shipped');
  assert.equal(nodes[0].outcome.verify, 'pass');
  assert.equal(nodes[0].action.engine, 'codex');
  assert.deepEqual(nodes[0].outcome.files, ['lib/result.js']);
  assert.equal(process.env[recorder.GUARD_ENV], undefined, 'finishing must clear the nested-attempt guard');
  writeRsiSnapshot(root, store);
  assert.equal(recorder.latestNodes(root).length, 1);
  assert.equal(fs.readFileSync(recorder.attemptsPath(root), 'utf8').trim().split('\n').length, 1, 'one observed result only');
});

test('later judge evidence finishes a legacy skipped result on its original node only once', (t) => {
  const root = recorderWorkspace(t);
  const store = createMemoryStore();
  const append = (type, data) => store.append({ campaign_id: 'cmp-legacy-gain', type, actor: 'builder', data });
  append('campaign_started', { title: 'Recover late judge evidence', owner: 'builder', judge: 'false', budget: 10 });
  append('judge_ran', { passed: false, reading: 0 });
  append('mission_started', { mission_id: 'm-legacy-gain', member: 'builder', engine: 'codex' });
  append('step', { mission_id: 'm-legacy-gain', engine: 'codex', cost_usd: 0 });
  append('mission_ended', { mission_id: 'm-legacy-gain', outcome: 'kept', cost_usd: 0, receipt_path: codeReceipt(root, 'm-legacy-gain') });
  seedObservedSkipped(root, store, 'm-legacy-gain', 'cmp-legacy-gain/m-legacy-gain');
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
  append('mission_started', { mission_id: 'm-one', member: 'builder', engine: 'auto' });
  append('step', { mission_id: 'm-one', engine: 'codex', cost_usd: 0 });
  append('mission_ended', { mission_id: 'm-one', outcome: 'kept', cost_usd: 0, receipt_path: codeReceipt(root, 'm-one') });
  append('judge_ran', { passed: true, reading: 1 });
  writeRsiSnapshot(root, store);
  assert.equal(recorder.latestNodes(root).length, 0, 'a failed observed write leaves no open orphan');
  assert.equal(process.env[recorder.GUARD_ENV], undefined);
  writeRsiSnapshot(root, store);
  assert.equal(recorder.latestNodes(root).length, 1, 'retry must finish the original node without leaving an orphan');
  assert.equal(recorder.latestNodes(root)[0].outcome.status, 'shipped');
  assert.equal(recorder.latestNodes(root)[0].outcome.verify, 'pass');
  assert.equal(process.env[recorder.GUARD_ENV], undefined);
});

for (const engine of [null, 'mercury', 'codex']) {
  test(`measured campaign gains with ${engine || 'unknown'} engine and no code receipt do not invent code learning`, (t) => {
    const root = recorderWorkspace(t);
    const store = createMemoryStore();
    const append = (type, data) => store.append({ campaign_id: 'cmp-no-proof', type, actor: 'builder', data });
    append('campaign_started', { title: 'Measure useful work honestly', owner: 'builder', judge: 'false', budget: 10 });
    append('judge_ran', { passed: false, reading: 0 });
    append('mission_started', { mission_id: 'm-no-proof', member: 'builder', ...(engine ? { engine } : {}) });
    append('step', { mission_id: 'm-no-proof', cost_usd: 0, ...(engine ? { engine } : {}) });
    append('mission_ended', { mission_id: 'm-no-proof', outcome: 'kept', cost_usd: 0 });
    append('judge_ran', { passed: true, reading: 1 });
    const report = writeRsiSnapshot(root, store);
    assert.equal(recorder.latestNodes(root).length, 0, 'missing code provenance cannot become a clean code attempt');
    assert.equal(report.members[0].reward, 1, 'measured campaign learning remains available');
  });
}

for (const problem of ['unknown engine', 'unsupported engine', 'mixed engines', 'partly unknown engines', 'missing file', 'wrong mission', 'outside receipt', 'legacy engine mismatch', 'legacy policy mismatch']) {
  test(`code learning defers ${problem} even when the campaign judge improves`, (t) => {
    const root = recorderWorkspace(t);
    const store = createMemoryStore();
    const missionId = 'm-provenance';
    const append = (type, data) => store.append({ campaign_id: 'cmp-provenance', type, actor: 'builder', data });
    append('campaign_started', { title: 'Only export supported code evidence', owner: 'builder', judge: 'false', budget: 10 });
    append('judge_ran', { passed: false, reading: 0 });
    append('mission_started', { mission_id: missionId, member: 'builder', engine: 'codex_goal' });
    const receiptPath = codeReceipt(root, missionId);
    let receipt_path = receiptPath;
    if (problem === 'missing file' || problem === 'wrong mission') {
      const file = path.join(root, receiptPath);
      const receipt = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (problem === 'missing file') receipt.code_provenance.files = [];
      else receipt.mission_id = 'some-other-mission';
      fs.writeFileSync(file, JSON.stringify(receipt));
    }
    if (problem === 'outside receipt') {
      fs.copyFileSync(path.join(root, receiptPath), path.join(root, 'foreign.json'));
      receipt_path = 'foreign.json';
    }
    if (problem !== 'unknown engine') append('step', { mission_id: missionId, engine: problem === 'unsupported engine' ? 'mercury' : 'codex', cost_usd: 0 });
    if (problem === 'mixed engines') append('step', { mission_id: missionId, engine: 'claude', cost_usd: 0 });
    if (problem === 'partly unknown engines') append('step', { mission_id: missionId, cost_usd: 0 });
    append('mission_ended', { mission_id: missionId, outcome: 'kept', cost_usd: 0, receipt_path });
    append('judge_ran', { passed: true, reading: 1 });
    if (problem === 'legacy engine mismatch') {
      seedObservedSkipped(root, store, missionId, `cmp-provenance/${missionId}`, 'claude');
    }
    if (problem === 'legacy policy mismatch') {
      const attempt = recorder.beginAttempt(root, { lane: 'campaign', ground: `cmp-provenance/${missionId}`, engine: 'codex' });
      assert.ok(attempt);
      assert.equal(recorder.finishAttempt(root, attempt, { status: 'shipped', verify: 'skipped', reason: 'old unsupported attribution' }), true);
    }
    const before = fs.existsSync(recorder.attemptsPath(root)) ? fs.readFileSync(recorder.attemptsPath(root), 'utf8') : '';
    writeRsiSnapshot(root, store);
    const after = fs.existsSync(recorder.attemptsPath(root)) ? fs.readFileSync(recorder.attemptsPath(root), 'utf8') : '';
    assert.equal(after, before, 'uncertain evidence must not open or promote a code attempt');
    assert.equal(process.env[recorder.GUARD_ENV], undefined);
  });
}
