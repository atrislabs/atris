const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const now = '2025-04-20T12:00:00.000Z';

function fixture(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'close-scan-state-'));
  const saved = Object.fromEntries(Object.entries(process.env)
    .filter(([key]) => key === 'HOME' || key.startsWith('ATRIS_')));
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('ATRIS_')) delete process.env[key];
  }
  process.env.HOME = cwd;
  t.after(() => {
    delete process.env.HOME;
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('ATRIS_')) delete process.env[key];
    }
    Object.assign(process.env, saved);
    fs.rmSync(cwd, { recursive: true, force: true });
  });
  const { scanState } = require('../commands/close');
  function write(relative, value) {
    const file = path.join(cwd, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, value);
  }
  return {
    cwd,
    scan: () => scanState(cwd, { now }),
    tasks: (tasks) => write('.atris/state/tasks.projection.json', JSON.stringify({ tasks })),
    write,
  };
}

test('scanState opens a stale review reminder once and closes it when accepted', (t) => {
  const f = fixture(t);
  const task = {
    id: 'review-one', display_id: 'R1', status: 'review',
    review: { approval_status: 'pending' }, updated_at: '2025-04-14T12:00:00.000Z',
  };
  f.tasks([task]);
  const first = f.scan();
  assert.strictEqual(first.opened.length, 1);
  const opened = first.opened[0];
  assert.deepStrictEqual({
    what: opened.what, source: opened.source, lane: opened.lane,
    ttl_days: opened.ttl_days, opened_at: opened.opened_at,
  }, {
    what: 'task R1 has waited in review too long, accept it or send it back',
    source: 'task:review-one', lane: 'code', ttl_days: 3, opened_at: now,
  });
  assert.deepStrictEqual(first.auto_closed, []);
  assert.deepStrictEqual(f.scan(), { opened: [], auto_closed: [], skipped: { missions: 0 } });
  f.tasks([{ ...task, status: 'done' }]);
  const resolved = f.scan();
  assert.deepStrictEqual(resolved.opened, []);
  assert.strictEqual(resolved.auto_closed.length, 1);
  assert.strictEqual(resolved.auto_closed[0].flag.source, 'task:review-one');
  assert.deepStrictEqual(resolved.auto_closed[0].event, {
    kind: 'closed', at: now, id: opened.id, proof: 'resolved in source store',
  });
  const ledger = fs.readFileSync(path.join(f.cwd, '.atris/state/closure.jsonl'), 'utf8')
    .trim().split('\n').map((line) => JSON.parse(line));
  assert.deepStrictEqual(ledger, [opened, resolved.auto_closed[0].event]);
});

test('scanState requires more than five days and ignores invalid review dates', (t) => {
  const f = fixture(t);
  f.tasks([
    { id: 'boundary', status: 'review', review: {}, updated_at: '2025-04-15T12:00:00.000Z' },
    { id: 'invalid', status: 'review', review: {}, updated_at: 'not-a-date' },
    { id: 'older', status: 'review', review: {}, updated_at: '2025-04-15T11:59:59.999Z' },
  ]);
  assert.deepStrictEqual(f.scan().opened.map((event) => event.source), ['task:older']);
});

test('scanState returns empty results without creating a ledger for empty state', (t) => {
  const f = fixture(t);
  assert.deepStrictEqual(f.scan(), { opened: [], auto_closed: [], skipped: { missions: 0 } });
  assert.strictEqual(fs.existsSync(path.join(f.cwd, '.atris/state/closure.jsonl')), false);
});

test('scanState rejects malformed closure ledger JSON without changing it', (t) => {
  const f = fixture(t);
  const content = '{broken json}\n';
  f.write('.atris/state/closure.jsonl', content);
  assert.throws(() => f.scan(), /invalid closure ledger json on line 1/);
  assert.strictEqual(fs.readFileSync(path.join(f.cwd, '.atris/state/closure.jsonl'), 'utf8'), content);
});
