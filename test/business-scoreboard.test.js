'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { scoreboardCommand, scoreboardText } = require('../commands/business-scoreboard');

const board = {
  business: { id: 'b1', name: 'Sunset Ink', slug: 'sunset-ink' },
  days: 30,
  units: [
    { id: 'revenue', label: 'Revenue', kind: 'money', value: 58, period: '30d', source: 'payments', block: 'chart', builtin: true },
    { id: 'orders', label: 'Orders', kind: 'count', value: 2, period: '30d', source: 'store', block: 'chart', builtin: true },
    { id: 'credits', label: 'Credits left', kind: 'count', value: 489, period: 'now', source: 'credits', block: 'metric', builtin: true },
    { id: 'store', label: 'Store', kind: 'count', value: null, period: 'now', source: 'store', block: 'metric', note: 'could not read this source', builtin: true },
    { id: 'shirts_printed', label: 'Shirts printed', kind: 'count', value: 12, target: 100, period: 'now', source: 'custom', block: 'gauge', builtin: false },
  ],
};

async function run(args, { result, token = 'tok', slug = 'sunset-ink' } = {}) {
  const out = [];
  const err = [];
  const calls = [];
  const files = [];
  const code = await scoreboardCommand(args, {
    log: (line) => out.push(line),
    err: (line) => err.push(line),
    loadCredentials: () => (token ? { token } : null),
    detectBusinessSlug: (explicit) => explicit || slug,
    writeFile: (path, body) => files.push({ path, body }),
    apiRequestJson: async (path, options) => {
      calls.push({ path, options });
      return result || { ok: true, status: 200, data: board, text: JSON.stringify(board) };
    },
  });
  return { code, out: out.join('\n'), err: err.join('\n'), calls, files };
}

test('the board reads as aligned lines with periods and targets', () => {
  const text = scoreboardText(board);
  assert.match(text, /^Sunset Ink, 30 day window/);
  assert.match(text, /Revenue +\$58\.00  last 30 days/);
  assert.match(text, /Credits left +489  now/);
  assert.match(text, /Store +no data  now  \(could not read this source\)/);
  assert.match(text, /Shirts printed +12  now, target 100/);
  assert.match(text, /record one: atris business scoreboard set shirts_printed <value>/);
});

test('reads the board for the named business with the chosen window', async () => {
  const { code, calls, out } = await run(['sunset-ink', '--days', '7']);
  assert.strictEqual(code, 0);
  assert.strictEqual(calls[0].path, '/business/sunset-ink/scoreboard?days=7');
  assert.match(out, /Sunset Ink/);
});

test('the business comes from the folder when the first word is an action', async () => {
  const { calls } = await run(['add', 'Shirts printed', '--kind', 'count', '--target', '100'], { slug: 'from-folder',
    result: { ok: true, status: 201, data: { id: 'shirts_printed', label: 'Shirts printed' } } });
  assert.strictEqual(calls[0].path, '/business/from-folder/scoreboard/units');
  assert.deepStrictEqual(calls[0].options.body, { label: 'Shirts printed', kind: 'count', target: 100 });
  assert.strictEqual(calls[0].options.retries, 0);
});

test('set records one value for one day', async () => {
  const { code, calls, out } = await run(['sunset-ink', 'set', 'shirts_printed', '12', '--day', '2026-11-10'],
    { result: { ok: true, status: 201, data: { value: 12, day: '2026-11-10' } } });
  assert.strictEqual(code, 0);
  assert.strictEqual(calls[0].path, '/business/sunset-ink/scoreboard/units/shirts_printed/values');
  assert.deepStrictEqual(calls[0].options.body, { value: 12, day: '2026-11-10' });
  assert.match(out, /shirts_printed is 12 for 2026-11-10/);
});

test('bad numbers and days never reach the api', async () => {
  for (const args of [['sunset-ink', 'set', 'leads', 'lots'], ['sunset-ink', 'set', 'leads', '3', '--day', 'today'], ['sunset-ink', '--days', '0']]) {
    const { code, calls } = await run(args);
    assert.strictEqual(code, 1, args.join(' '));
    assert.strictEqual(calls.length, 0, args.join(' '));
  }
});

test('layout and remove hit their routes', async () => {
  const layout = await run(['sunset-ink', 'layout', 'revenue,orders', 'leads'], { result: { ok: true, status: 200, data: { layout: ['revenue', 'orders', 'leads'] } } });
  assert.strictEqual(layout.calls[0].options.method, 'PUT');
  assert.deepStrictEqual(layout.calls[0].options.body, { units: ['revenue', 'orders', 'leads'] });
  const removed = await run(['sunset-ink', 'remove', 'leads'], { result: { ok: true, status: 200, data: { removed: 'leads' } } });
  assert.strictEqual(removed.calls[0].options.method, 'DELETE');
  assert.strictEqual(removed.calls[0].path, '/business/sunset-ink/scoreboard/units/leads');
});

test('--doc prints the atris doc, or writes it with --out', async () => {
  const doc = '# Sunset Ink scoreboard\n\n```metric\n{"label":"Revenue","value":"$58.00"}\n```\n';
  const printed = await run(['sunset-ink', '--doc'], { result: { ok: true, status: 200, data: null, text: doc } });
  assert.strictEqual(printed.out, doc);
  const written = await run(['sunset-ink', '--doc', '--out', 'board.md'], { result: { ok: true, status: 200, data: null, text: doc } });
  assert.deepStrictEqual(written.files, [{ path: 'board.md', body: doc }]);
  assert.match(written.out, /wrote board.md/);
});

test('plain words when signed out, not allowed, or the business is unknown', async () => {
  assert.match((await run(['sunset-ink'], { token: null })).err, /atris login/);
  assert.match((await run(['sunset-ink', 'add', 'Leads'], { result: { ok: false, status: 403 } })).err, /owner or an admin/);
  assert.match((await run(['nope'], { result: { ok: false, status: 404 } })).err, /atris business list/);
});

test('--json prints the whole board once', async () => {
  const { out } = await run(['sunset-ink', '--json']);
  const parsed = JSON.parse(out);
  assert.strictEqual(parsed.ok, true);
  assert.strictEqual(parsed.units.length, 5);
});
