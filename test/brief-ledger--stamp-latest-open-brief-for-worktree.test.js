'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  ledgerPath,
  readBriefLedger,
  stampLatestOpenBriefForWorktree,
} = require('../lib/brief-ledger');

const FIXED_NOW = new Date('2026-01-02T03:04:05.000Z');
const NO_OPEN = { ok: false, error: 'no open brief for this worktree' };

const savedEnv = {};
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-stamp-brief-test-'));

test.before(() => {
  savedEnv.HOME = process.env.HOME;
  process.env.HOME = sandbox;
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('ATRIS_')) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  }
});

test.after(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(sandbox, { recursive: true, force: true });
});

let dirCounter = 0;

function makeDir(name) {
  dirCounter += 1;
  const dir = path.join(sandbox, `${name}-${dirCounter}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function brief(id, ts, worktree, extra = {}) {
  return {
    brief_id: id,
    ts,
    author: 'tester',
    engine: 'codex',
    prompt_text: `prompt for ${id}`,
    context: { worktree, base_ref: 'master' },
    outcome: null,
    ...extra,
  };
}

function writeLedger(root, records, rawLines = []) {
  const file = ledgerPath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lines = [...rawLines, ...records.map((record) => JSON.stringify(record))];
  fs.writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');
}

test('stamps the newest open brief for the root worktree and appends one record', () => {
  const root = makeDir('root');
  writeLedger(root, [
    brief('brief-old', '2026-01-01T00:00:00.000Z', root),
    brief('brief-new', '2026-01-01T09:00:00.000Z', root),
  ]);

  const result = stampLatestOpenBriefForWorktree(root, {
    result: 'pass',
    note: 'shipped it',
    ts: '2026-01-01T10:00:00.000Z',
  });

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.record.brief_id, 'brief-new');
  assert.deepStrictEqual(result.record.outcome, {
    result: 'pass',
    note: 'shipped it',
    ts: '2026-01-01T10:00:00.000Z',
  });

  const ledger = readBriefLedger(root);
  assert.strictEqual(ledger.length, 3);
  assert.deepStrictEqual(ledger[2], result.record);
  assert.strictEqual(ledger[0].outcome, null);
  assert.strictEqual(ledger[1].outcome, null);

  // The older brief is now the only open one, so a second stamp lands on it.
  const second = stampLatestOpenBriefForWorktree(root, { result: 'fail' }, { now: FIXED_NOW });
  assert.strictEqual(second.ok, true);
  assert.strictEqual(second.record.brief_id, 'brief-old');
  assert.strictEqual(second.record.outcome.result, 'fail');
});

test('options.worktree picks the brief for that worktree and leaves others open', () => {
  const root = makeDir('root');
  const wtA = makeDir('wt-a');
  const wtB = makeDir('wt-b');
  writeLedger(root, [
    brief('brief-a', '2026-01-01T05:00:00.000Z', wtA),
    brief('brief-b', '2026-01-01T06:00:00.000Z', wtB),
  ]);

  const result = stampLatestOpenBriefForWorktree(root, { result: 'partial', note: 'half done' }, {
    worktree: wtA,
    now: FIXED_NOW,
  });

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.record.brief_id, 'brief-a');
  assert.strictEqual(result.record.outcome.result, 'partial');

  const ledger = readBriefLedger(root);
  assert.strictEqual(ledger.length, 3);
  assert.strictEqual(ledger.filter((r) => r.brief_id === 'brief-b').length, 1);
  assert.strictEqual(ledger.find((r) => r.brief_id === 'brief-b').outcome, null);

  // root itself has no brief, so default targeting reports nothing open.
  assert.deepStrictEqual(stampLatestOpenBriefForWorktree(root, { result: 'pass' }), NO_OPEN);
});

test('returns the no-open-brief error when the ledger is missing or empty', () => {
  const missing = makeDir('missing');
  assert.deepStrictEqual(stampLatestOpenBriefForWorktree(missing, { result: 'pass' }), NO_OPEN);
  assert.strictEqual(fs.existsSync(ledgerPath(missing)), false);

  const empty = makeDir('empty');
  writeLedger(empty, []);
  const before = fs.readFileSync(ledgerPath(empty), 'utf8');
  assert.deepStrictEqual(stampLatestOpenBriefForWorktree(empty, { result: 'pass' }), NO_OPEN);
  assert.strictEqual(fs.readFileSync(ledgerPath(empty), 'utf8'), before);
});

test('skips briefs that already have an outcome and ignores malformed or contextless lines', () => {
  const root = makeDir('root');
  writeLedger(
    root,
    [
      brief('brief-open', '2026-01-01T01:00:00.000Z', root),
      brief('brief-closed', '2026-01-01T02:00:00.000Z', root, {
        outcome: { result: 'pass', note: '', ts: '2026-01-01T02:30:00.000Z' },
      }),
      { brief_id: 'brief-no-context', ts: '2026-01-01T03:00:00.000Z', outcome: null },
    ],
    ['not json at all', '{"broken":']
  );

  const result = stampLatestOpenBriefForWorktree(root, { result: 'pass' }, { now: FIXED_NOW });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.record.brief_id, 'brief-open');

  // Everything with a matching worktree is now closed.
  assert.deepStrictEqual(stampLatestOpenBriefForWorktree(root, { result: 'pass' }), NO_OPEN);
});

test('a later outcome row for the same brief id closes it', () => {
  const root = makeDir('root');
  writeLedger(root, [
    brief('brief-1', '2026-01-01T01:00:00.000Z', root),
    brief('brief-1', '2026-01-01T01:00:00.000Z', root, {
      outcome: { result: 'fail', note: 'bad', ts: '2026-01-01T02:00:00.000Z' },
    }),
  ]);
  assert.deepStrictEqual(stampLatestOpenBriefForWorktree(root, { result: 'pass' }), NO_OPEN);
});

test('normalizes the outcome: case, whitespace, and injected clock', () => {
  const root = makeDir('root');
  writeLedger(root, [brief('brief-1', '2026-01-01T00:00:00.000Z', root)]);

  const result = stampLatestOpenBriefForWorktree(
    root,
    { result: '  PASS ', note: '  landed\n  clean\t ok  ' },
    { now: FIXED_NOW }
  );

  assert.strictEqual(result.ok, true);
  assert.deepStrictEqual(result.record.outcome, {
    result: 'pass',
    note: 'landed clean ok',
    ts: '2026-01-02T03:04:05.000Z',
  });
});

test('throws on an invalid outcome and leaves the ledger untouched', () => {
  const root = makeDir('root');
  writeLedger(root, [brief('brief-1', '2026-01-01T00:00:00.000Z', root)]);
  const before = fs.readFileSync(ledgerPath(root), 'utf8');

  assert.throws(
    () => stampLatestOpenBriefForWorktree(root, { result: 'maybe' }),
    /brief outcome result must be one of pass, fail, partial/
  );
  assert.throws(
    () => stampLatestOpenBriefForWorktree(root),
    /brief outcome result must be one of pass, fail, partial/
  );
  assert.strictEqual(fs.readFileSync(ledgerPath(root), 'utf8'), before);
});

test('matches a worktree path through a symlink', (t) => {
  const root = makeDir('root');
  const real = makeDir('real-wt');
  const link = path.join(sandbox, 'link-wt');
  try {
    fs.symlinkSync(real, link, 'dir');
  } catch {
    t.skip('symlinks not available here');
    return;
  }
  writeLedger(root, [brief('brief-real', '2026-01-01T00:00:00.000Z', real)]);

  const result = stampLatestOpenBriefForWorktree(root, { result: 'pass' }, {
    worktree: link,
    now: FIXED_NOW,
  });

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.record.brief_id, 'brief-real');
});

test('falls back to resolved path comparison when the worktree no longer exists', () => {
  const root = makeDir('root');
  const gone = path.join(sandbox, 'gone-wt');
  const detour = `${sandbox}${path.sep}elsewhere${path.sep}..${path.sep}gone-wt`;
  assert.strictEqual(fs.existsSync(gone), false);
  writeLedger(root, [brief('brief-gone', '2026-01-01T00:00:00.000Z', gone)]);

  const miss = stampLatestOpenBriefForWorktree(root, { result: 'pass' }, {
    worktree: path.join(sandbox, 'other-gone-wt'),
  });
  assert.deepStrictEqual(miss, NO_OPEN);

  const hit = stampLatestOpenBriefForWorktree(root, { result: 'pass' }, {
    worktree: detour,
    now: FIXED_NOW,
  });
  assert.strictEqual(hit.ok, true);
  assert.strictEqual(hit.record.brief_id, 'brief-gone');
});
