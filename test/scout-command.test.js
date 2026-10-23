'use strict';

// Argument and help checks only. A real question that gets past the headless
// guard launches an engine, so every case here returns before that.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-command-'));
const previousHome = process.env.HOME;
const previousNonInteractive = process.env.ATRIS_NONINTERACTIVE;
process.env.HOME = scratch;
process.env.ATRIS_NONINTERACTIVE = '1';

const { scoutCommand } = require('../commands/scout');

const HELP_BITS = [
  'cheap read-only subagents for search & context questions',
  'parallel scouts, one per question',
  'upgrade the model (default: haiku)',
  'engine: claude | cursor | devin | fast',
  'seconds per scout (default: 180)',
  'claude -p with a read-only tool allowlist',
  'cursor-agent --trust -p',
  'devin -p (read-only by default)',
  'answer in ≤30 lines with file:line citations.',
];

async function capture(argv) {
  const logs = [];
  const errs = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...args) => logs.push(args.map(String).join(' '));
  console.error = (...args) => errs.push(args.map(String).join(' '));
  try {
    const code = await scoutCommand(argv);
    return { code, out: logs.join('\n'), err: errs.join('\n') };
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
}

function assertHelp(out) {
  for (const bit of HELP_BITS) {
    assert.ok(out.includes(bit), `missing help text: ${bit}`);
  }
}

test.after(() => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  if (previousNonInteractive === undefined) delete process.env.ATRIS_NONINTERACTIVE;
  else process.env.ATRIS_NONINTERACTIVE = previousNonInteractive;
  fs.rmSync(scratch, { recursive: true, force: true });
});

test('help prints the scout usage and exits 0', async () => {
  const cases = [
    ['--help'],
    ['-h'],
    ['help'],
    ['where is credit deduction wired?', '--help'],
    ['--dir', scratch, '-h'],
  ];
  for (const argv of cases) {
    const { code, out, err } = await capture(argv);
    assert.strictEqual(code, 0, argv.join(' '));
    assert.strictEqual(err, '', argv.join(' '));
    assert.ok(!out.includes('scouting with'), argv.join(' '));
    assertHelp(out);
  }
});

test('headless scout without --yes exits 2 and does not print a report', async () => {
  const expected = [
    'Usage: atris scout [--yes] "<question>"',
    'Headless scout needs --yes.',
    'Pass --yes to run headless.',
  ].join('\n');
  for (const argv of [[], ['where is the proxy middleware?']]) {
    const { code, out, err } = await capture(argv);
    assert.strictEqual(code, 2, argv.join(' ') || '(no args)');
    assert.strictEqual(out, '', argv.join(' ') || '(no args)');
    assert.strictEqual(err, expected, argv.join(' ') || '(no args)');
  }
});

test('an unknown engine exits 1 before any scout starts', async () => {
  const { code, out, err } = await capture([
    '--yes',
    '--engine',
    'nope',
    'where is the proxy middleware?',
  ]);
  assert.strictEqual(code, 1);
  assert.strictEqual(out, '');
  assert.ok(err.includes('unknown engine "nope" (claude|cursor|devin|fast)'));
  assert.ok(!err.includes('scouting with'));
});

test('flags without a question print help and exit 1', async () => {
  const { code, out, err } = await capture([
    '--yes',
    '--dir',
    scratch,
    '--model',
    'sonnet',
    '--timeout',
    '30',
    '-y',
  ]);
  assert.strictEqual(code, 1);
  assert.strictEqual(err, '');
  assert.ok(!out.includes('scouting with'));
  assertHelp(out);
});
