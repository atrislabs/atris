const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// These tests change process globals, so keep command invocations sequential.
async function withCommand(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-errors-command-'));
  const cwd = process.cwd();
  const home = process.env.HOME;
  const argv = process.argv;
  const log = console.log;
  const output = [];
  try {
    process.env.HOME = dir;
    process.chdir(dir);
    console.log = (...args) => output.push(args.join(' '));
    const { errorsCommand } = require('../commands/errors');
    await run(async (args) => {
      output.length = 0;
      process.argv = [process.execPath, 'atris', 'errors', ...args];
      await errorsCommand();
      return output.slice();
    }, dir);
  } finally {
    console.log = log;
    process.argv = argv;
    process.chdir(cwd);
    if (home === undefined) delete process.env.HOME;
    else process.env.HOME = home;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('default local scope reports a missing log without requiring login', async () => {
  await withCommand(async (invoke) => {
    assert.deepStrictEqual(await invoke([]), [
      'No local errors. Pass --account for cloud error events.',
    ]);
    assert.deepStrictEqual(JSON.parse((await invoke(['--local', '--json']))[0]), {
      ok: true,
      scope: 'local',
      total_events: 0,
      groups: [],
      note: 'local scope. pass --account for cloud error events.',
    });
  });
});

test('local logs skip malformed lines, count all events, and display only twenty', async () => {
  await withCommand(async (invoke, dir) => {
    const rows = [
      { message: 'first failure' },
      { error: 'fallback failure' },
      { code: 'E_LOCAL' },
      ...Array.from({ length: 20 }, (_, i) => ({ message: `failure ${i}` })),
    ];
    const state = path.join(dir, '.atris', 'state');
    fs.mkdirSync(state, { recursive: true });
    fs.writeFileSync(path.join(state, 'errors.jsonl'),
      [' ', '{broken json', ...rows.map(row => JSON.stringify(row)), ''].join('\n'));

    const lines = await invoke([]);
    assert.strictEqual(lines[0], 'Local errors (23). Pass --account for cloud error events.\n');
    assert.deepStrictEqual(lines.slice(1), rows.slice(0, 20).map(row =>
      `  ${row.message || row.error || JSON.stringify(row)}`));

    const jsonLines = await invoke(['--hours=72', '-L', '1000', '--json']);
    assert.strictEqual(jsonLines.length, 1);
    assert.deepStrictEqual(JSON.parse(jsonLines[0]), {
      ok: true,
      scope: 'local',
      total_events: 23,
      groups: [],
      note: 'local scope. pass --account for cloud error events.',
    });
  });
});

test('all help aliases describe local defaults and cloud arguments', async () => {
  await withCommand(async (invoke) => {
    const help = await invoke(['--help']);
    assert.match(help.join('\n'), /atris errors\s+Local errors \(default; no cloud dump\)/);
    assert.match(help.join('\n'), /atris errors --account --hours 72/);
    assert.match(help.join('\n'), /atris errors show <full-uuid>/);
    assert.match(help.join('\n'), /Admin role required for cloud reads/);
    assert.deepStrictEqual(await invoke(['-h']), help);
    assert.deepStrictEqual(await invoke(['help']), help);
  });
});
