'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const recorder = require('../lib/rsi-record');

// A Python service-boundary fixture, not the production backend. It exposes
// the schema constructors and append protocol so these tests exercise the
// actual subprocess arguments and persisted rows without a backend checkout.
const SCHEMA_PY = `from __future__ import annotations
import json, os, uuid
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
def now(): return datetime.now(timezone.utc).isoformat()
def trace(op):
    with Path(os.environ['OBSERVED_CALLS']).open('a') as out: out.write(op + '\\n')
def ledger():
    state = Path(os.environ['ATRIS_RSI_STATE'])
    state.mkdir(parents=True, exist_ok=True)
    return state / 'attempts.jsonl'
@dataclass
class Context:
    base_commit: str = ''
    ground: str = ''
@dataclass
class Action:
    policy_id: str
    kind: str = 'open'
    ground: str = ''
    engine: str = 'codex'
    model: str | None = None
    cap_s: int = 1800
@dataclass
class Outcome:
    status: str = 'running'
    verify: str = 'skipped'
    files: list[str] = field(default_factory=list)
    commits: int = 0
    cost_usd: float | None = None
    reason: str = ''
    human_revised_within_72h: bool | None = None
    revised_files: list[str] = field(default_factory=list)
    human_verdict: str | None = None
    human_note: str = ''
@dataclass
class Node:
    tree_id: str
    lane: str
    context: Context
    action: Action
    outcome: Outcome
    id: str = field(default_factory=lambda: 'n_' + uuid.uuid4().hex[:12])
    schema: str = 'atris.rsi.node.v1'
    created_at: str = field(default_factory=now)
    opened_at: str | None = None
    recorded_at: str | None = None
    split: str | None = None
def tree_split(tree): return 'train'
def append_node(node):
    trace('append')
    if node.recorded_at is None: node.recorded_at = now()
    with ledger().open('a') as out: out.write(json.dumps(asdict(node)) + '\\n')
`;

const RECORD_PY = `import json, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
from backend.scripts.rsi.schema import Action, Context, Node, Outcome, ledger, trace
def get_node(node_id):
    trace('get')
    if not ledger().exists(): return None
    for line in reversed(ledger().read_text().splitlines()):
        row = json.loads(line)
        if row['id'] == node_id:
            row['context'] = Context(**row['context'])
            row['action'] = Action(**row['action'])
            row['outcome'] = Outcome(**row['outcome'])
            return Node(**row)
    return None
if __name__ == '__main__':
    trace(sys.argv[1])
    if sys.argv[1] != 'start-tree': raise SystemExit('open/finish must not record observed history')
    print('x-' + sys.argv[sys.argv.index('--date') + 1])
`;

function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-observed-'));
  const saved = Object.fromEntries(['ATRIS_RSI_STATE', 'OBSERVED_CALLS', recorder.GUARD_ENV].map((key) => [key, process.env[key]]));
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  process.env.ATRIS_RSI_STATE = path.join(root, 'state');
  process.env.OBSERVED_CALLS = path.join(root, 'calls');
  process.env[recorder.GUARD_ENV] = 'n_parent';
  const scripts = path.join(root, 'backend', 'scripts', 'rsi');
  fs.mkdirSync(scripts, { recursive: true });
  fs.writeFileSync(path.join(scripts, 'schema.py'), SCHEMA_PY);
  fs.writeFileSync(path.join(scripts, 'record.py'), RECORD_PY);
  fs.writeFileSync(path.join(scripts, 'choose.py'), "from pathlib import Path\nimport os\nPath(os.environ['OBSERVED_CALLS']).write_text('choose\\n')\nraise SystemExit(1)\n");
  const rows = () => {
    try { return fs.readFileSync(recorder.attemptsPath(root), 'utf8').trim().split('\n').map(JSON.parse); } catch { return []; }
  };
  return { root, scripts, rows };
}

function observed(patch = {}) {
  return {
    ground: 'cmp-observed/m-one', engine: 'codex', baseCommit: 'a'.repeat(40),
    openedAt: '2025-01-02T03:04:05Z', finishedAt: '2025-01-02T04:04:05Z',
    outcome: { status: 'shipped', verify: 'pass', files: ['lib/real.js', 'test/real.test.js'], commits: 1, cost_usd: 0, reason: 'the actual check passed' },
    ...patch,
  };
}

test('observed history preserves event times and records no policy choice or open/finish run', (t) => {
  const { root, rows } = workspace(t);
  const input = observed();
  const id = recorder.recordObservedAttempt(root, input);
  assert.equal(typeof id, 'string');
  const [row] = rows();
  assert.equal(row.id, id);
  assert.equal(row.opened_at, input.openedAt);
  assert.equal(row.created_at, input.finishedAt);
  assert.ok(Date.parse(row.recorded_at) > Date.parse(input.finishedAt));
  assert.deepEqual(row.context, { base_commit: input.baseCommit, ground: input.ground });
  assert.deepEqual(row.action, { policy_id: 'p-0000', kind: 'open', ground: input.ground, engine: 'codex', model: null, cap_s: 0 });
  assert.deepEqual(row.outcome, { human_revised_within_72h: null, revised_files: [], human_verdict: null, human_note: '', ...input.outcome });
  assert.equal(process.env[recorder.GUARD_ENV], 'n_parent');
  assert.deepEqual(fs.readFileSync(process.env.OBSERVED_CALLS, 'utf8').trim().split('\n'), ['start-tree', 'append']);
  const second = recorder.recordObservedAttempt(root, observed({ ground: 'cmp-observed/m-two' }));
  assert.notEqual(second, id);
  assert.equal(rows()[1].tree_id, row.tree_id, 'observed exports share today\'s existing tree');
});

test('observed corrections keep the original identity, timing, context, and action', (t) => {
  const { root, rows } = workspace(t);
  const id = recorder.recordObservedAttempt(root, observed({ outcome: { status: 'shipped', verify: 'skipped', files: ['lib/real.js'] } }));
  const first = rows()[0];
  // A recorded-time marker makes a reused timestamp visible even on fast runs.
  first.recorded_at = '2025-01-03T00:00:00Z';
  first.outcome.human_revised_within_72h = true;
  first.outcome.revised_files = ['lib/real.js'];
  first.outcome.human_verdict = 'fix';
  first.outcome.human_note = 'a person found a later issue';
  fs.appendFileSync(recorder.attemptsPath(root), JSON.stringify(first) + '\n');
  const outcome = observed().outcome;
  assert.equal(recorder.recordObservedAttempt(root, observed({ nodeId: id, openedAt: '2025-01-01T19:04:05-08:00', finishedAt: '2025-01-01T20:04:05-08:00', outcome })), id, 'equivalent instants are the same historical provenance');
  const last = rows().at(-1);
  for (const key of ['id', 'tree_id', 'lane', 'context', 'action', 'created_at', 'opened_at', 'split']) assert.deepEqual(last[key], first[key], key);
  assert.deepEqual(last.outcome, { ...first.outcome, ...outcome });
  assert.ok(Date.parse(last.recorded_at) > Date.parse(first.recorded_at));
  assert.equal(process.env[recorder.GUARD_ENV], 'n_parent');
});

test('observed corrections refuse a foreign identity or an action attributed to a policy', (t) => {
  const { root, rows } = workspace(t);
  const id = recorder.recordObservedAttempt(root, observed());
  const file = recorder.attemptsPath(root);
  for (const patch of [
    { nodeId: 'n_missing' }, { nodeId: id, lane: 'landing' }, { nodeId: id, ground: 'cmp-other/m-one' },
    { nodeId: id, engine: 'claude' }, { nodeId: id, baseCommit: 'b'.repeat(40) },
    { nodeId: id, openedAt: '2025-01-02T03:04:06Z' }, { nodeId: id, finishedAt: '2025-01-02T04:04:06Z' },
  ]) {
    const before = fs.readFileSync(file, 'utf8');
    assert.equal(recorder.recordObservedAttempt(root, observed(patch)), null);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
  }
  const legacy = rows()[0];
  legacy.action.policy_id = 'p-0001';
  fs.appendFileSync(file, JSON.stringify(legacy) + '\n');
  const before = fs.readFileSync(file, 'utf8');
  assert.equal(recorder.recordObservedAttempt(root, observed({ nodeId: id })), null);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  legacy.action.policy_id = 'p-0000';
  legacy.outcome.status = 'running';
  fs.appendFileSync(file, JSON.stringify(legacy) + '\n');
  const running = fs.readFileSync(file, 'utf8');
  assert.equal(recorder.recordObservedAttempt(root, observed({ nodeId: id })), null);
  assert.equal(fs.readFileSync(file, 'utf8'), running);
  assert.equal(process.env[recorder.GUARD_ENV], 'n_parent');
});

test('unknown engines, bases, incomplete files, and invalid event times record nothing', (t) => {
  const { root, rows } = workspace(t);
  const invalid = [
    { engine: 'Codex' }, { engine: 'auto' }, { engine: null }, { baseCommit: '' }, { baseCommit: 'unknown' },
    { ground: '' }, { outcome: { status: 'shipped', verify: 'pass', files: [] } },
    { outcome: { status: 'shipped', verify: 'pass', files: ['lib/real.js', null] } },
    { outcome: { status: 'shipped', verify: 'pass', files: new Array(1) } },
    { outcome: { status: 'shipped', verify: 'pass', files: [' '] } },
    { outcome: { status: 'running', verify: 'pass', files: ['lib/real.js'] } },
    { outcome: { status: 'shipped', verify: 'invented', files: ['lib/real.js'] } },
    { openedAt: '2025-01-02' }, { openedAt: '2025-02-30T00:00:00Z' },
    { openedAt: 'not a date' }, { finishedAt: '2025-01-01T00:00:00Z' },
    { finishedAt: '2999-01-01T00:00:00Z' },
  ];
  for (const patch of invalid) assert.equal(recorder.recordObservedAttempt(root, observed(patch)), null, JSON.stringify(patch));
  assert.deepEqual(rows(), []);
  assert.equal(fs.existsSync(process.env.OBSERVED_CALLS), false, 'bad provenance must fail before a subprocess');
  assert.equal(process.env[recorder.GUARD_ENV], 'n_parent');
});

test('a missing backend schema API defers recording without changing the active guard', (t) => {
  const { root, scripts, rows } = workspace(t);
  fs.rmSync(path.join(scripts, 'schema.py'));
  const messages = [];
  assert.equal(recorder.recordObservedAttempt(root, observed(), { log: (message) => messages.push(message) }), null);
  assert.deepEqual(rows(), []);
  assert.equal(process.env[recorder.GUARD_ENV], 'n_parent');
  fs.rmSync(path.join(scripts, 'record.py'));
  assert.equal(recorder.recordObservedAttempt(root, observed()), null);
});
