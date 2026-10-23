const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { logAtris } = require('../commands/log');

// logAtris has no date argument. Supply a fixed local calendar day to its
// Date calls so the journal name stays the same in every time zone.
function inWorkspace(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'log-atris-test-'));
  const cwd = process.cwd();
  const argv = process.argv;
  const env = { ...process.env };
  const RealDate = global.Date;
  const log = console.log;
  const tty = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  const output = [];
  try {
    process.env.HOME = root;
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('ATRIS_')) delete process.env[key];
    }
    global.Date = class extends RealDate {
      constructor(...args) {
        if (args.length) super(...args);
        else super(2032, 5, 15, 12, 0, 0);
      }
      static now() { return new RealDate(2032, 5, 15, 12, 0, 0).getTime(); }
    };
    process.chdir(root);
    fs.mkdirSync(path.join(root, 'atris'));
    // --json forces the noninteractive path, without reading host stdin.
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
    console.log = (...args) => output.push(args.join(' '));
    const call = (...args) => {
      output.length = 0;
      process.argv = [process.execPath, 'atris', 'log', ...args];
      logAtris();
      return output.join('\n');
    };
    run({ root, call, journal: path.join(root, 'atris/logs/2032/2032-06-15.md') });
  } finally {
    console.log = log;
    global.Date = RealDate;
    process.argv = argv;
    process.chdir(cwd);
    if (tty) Object.defineProperty(process.stdin, 'isTTY', tty);
    else delete process.stdin.isTTY;
    for (const key of Object.keys(process.env)) {
      if (!(key in env)) delete process.env[key];
    }
    Object.assign(process.env, env);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('logAtris captures a note and reports the real journal and inbox id', () => {
  inWorkspace(({ call, journal }) => {
    assert.deepStrictEqual(JSON.parse(call('write the release notes', '--json')), {
      ok: true,
      action: 'inbox_capture',
      journal: 'atris/logs/2032/2032-06-15.md',
      next_command: 'atris logs',
      id: 'I1',
      note: 'write the release notes',
    });
    const content = fs.readFileSync(journal, 'utf8');
    assert.ok(content.startsWith('# Log, 2032-06-15\n'));
    assert.match(content, /## Inbox\n\n- \*\*I1:\*\* write the release notes\n/);
  });
});

test('logAtris trims positional input, ignores flags, and preserves earlier notes', () => {
  inWorkspace(({ call, journal }) => {
    call('first note', '--json');
    assert.strictEqual(call('--yes', '  second', 'note  '), [
      'captured I2: second note',
      'journal: atris/logs/2032/2032-06-15.md',
      'Next: atris logs',
    ].join('\n'));
    const content = fs.readFileSync(journal, 'utf8');
    assert.match(content, /- \*\*I2:\*\* second note\n- \*\*I1:\*\* first note/);
    assert.strictEqual((content.match(/## Inbox/g) || []).length, 1);
  });
});

test('logAtris reports empty noninteractive input without capturing a note', () => {
  inWorkspace(({ call, journal }) => {
    assert.deepStrictEqual(JSON.parse(call('   ', '--json')), {
      ok: false,
      error: 'Daily log REPL needs a terminal (2032-06-15).',
      journal: 'atris/logs/2032/2032-06-15.md',
      next_command: 'atris log "note"',
    });
    const content = fs.readFileSync(journal, 'utf8');
    assert.match(content, /## Inbox\n/);
    assert.doesNotMatch(content, /- \*\*I\d+:/);
  });
});
