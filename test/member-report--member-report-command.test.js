'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { memberReportCommand } = require('../lib/member-report');

function isolatedCommand(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'member-report-command-'));
  const cwd = process.cwd();
  const env = { ...process.env };
  const exitCode = process.exitCode;
  const emit = process.emit;
  const output = [];
  const errors = [];
  t.after(() => {
    // The command caches its real SQLite connection, so close it before cleanup.
    const db = require.cache[require.resolve('../lib/task-db')];
    if (db) db.exports.close();
    process.emit = emit;
    process.chdir(cwd);
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, env);
    process.exitCode = exitCode;
    fs.rmSync(root, { recursive: true, force: true });
  });
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('ATRIS_')) delete process.env[key];
  }
  process.env.HOME = root;
  // An empty directory as PATH prevents gh (and git) from reaching the host.
  const emptyBin = path.join(root, 'bin');
  fs.mkdirSync(emptyBin);
  process.env.PATH = emptyBin;
  process.exitCode = undefined;
  process.chdir(root);
  t.mock.method(console, 'log', (...args) => output.push(args.join(' ')));
  t.mock.method(console, 'error', (...args) => errors.push(args.join(' ')));
  // Local constructors keep diary times and the cutoff identical in every zone.
  t.mock.timers.enable({ apis: ['Date'], now: new Date(2020, 5, 15, 12).getTime() });
  return { root, output, errors };
}

function diary(root, member, text) {
  const logs = path.join(root, 'atris', 'team', member, 'logs');
  fs.mkdirSync(logs, { recursive: true });
  fs.writeFileSync(path.join(logs, '2020-06-15.md'), text);
}

test('memberReportCommand returns and prints JSON from real member diaries', (t) => {
  const { root, output, errors } = isolatedCommand(t);
  diary(root, 'ada', [
    '## 08:00 · Task claimed', '- title: Ship report',
    '## 09:30 · Task completed', '- title: Ship report', '- action: merged',
    '- proof: merged https://example.invalid/pull/7.',
    '## 10:00 · Task accepted', '- title: Update guide',
    '## 11:00 · Task failed', '- title: Retry import', '- reason: Missing input',
  ].join('\n'));

  const report = memberReportCommand('--since', '2020-06-15', '--json');

  assert.deepStrictEqual(report, {
    ok: true, action: 'report', since: '00:00',
    totals: { merged: 1, finished: 1, turned_down: 1, waiting: 0 },
    members: [{
      member: 'ada', total: 3,
      merged: [{ title: 'Ship report', link: 'https://example.invalid/pull/7', took_minutes: 90 }],
      finished: [{ title: 'Update guide' }],
      turned_down: [{ title: 'Retry import', reason: 'Missing input' }],
      waiting: [],
    }],
  });
  assert.strictEqual(output.length, 1);
  assert.deepStrictEqual(JSON.parse(output[0]), report);
  assert.deepStrictEqual(errors, []);
  assert.strictEqual(process.exitCode, undefined);
});

test('memberReportCommand excludes pre-cutoff work and prints the empty report', (t) => {
  const { root, output, errors } = isolatedCommand(t);
  diary(root, 'ada', '## 08:00 · Task completed\n- title: Old work\n');
  fs.mkdirSync(path.join(root, 'atris', 'team', '.hidden'), { recursive: true });

  const report = memberReportCommand('--since=2020-06-15T09:00:00');

  assert.deepStrictEqual(report, {
    ok: true, action: 'report', since: '09:00',
    totals: { merged: 0, finished: 0, turned_down: 0, waiting: 0 }, members: [],
  });
  assert.deepStrictEqual(output, [
    '\nwhat the team did since 09:00\n\n  nothing merged, finished, turned down, or done since then.\n',
  ]);
  assert.deepStrictEqual(errors, []);
  assert.strictEqual(process.exitCode, undefined);
});

test('memberReportCommand reports missing option values without printing a report', (t) => {
  const { output, errors } = isolatedCommand(t);

  assert.strictEqual(memberReportCommand('--since'), null);
  assert.deepStrictEqual(output, []);
  assert.deepStrictEqual(errors, ['--since needs a time, like 2h or yesterday']);
  assert.strictEqual(process.exitCode, 1);
});

test('memberReportCommand reports a missing workspace after parsing valid arguments', (t) => {
  const { output, errors } = isolatedCommand(t);

  assert.strictEqual(memberReportCommand('--since', '2020-06-15', '--json'), null);
  assert.deepStrictEqual(output, []);
  assert.deepStrictEqual(errors, ['no atris/team folder here; run this inside an atris workspace']);
  assert.strictEqual(process.exitCode, 1);
});
