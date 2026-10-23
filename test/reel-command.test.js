const test = require('node:test');
const assert = require('node:assert');
const { run } = require('../commands/reel');

function captureConsole(t) {
  const stdout = [];
  const stderr = [];
  t.mock.method(console, 'log', (...args) => stdout.push(args.join(' ')));
  t.mock.method(console, 'error', (...args) => stderr.push(args.join(' ')));
  return { stdout, stderr };
}

test('help forms print usage and succeed even with invalid rendering options', async (t) => {
  const { stdout, stderr } = captureConsole(t);
  for (const argv of [
    ['help', '--kind', 'invalid'],
    ['--help', '--size', 'invalid'],
  ]) {
    assert.strictEqual(await run(argv), 0);
  }
  assert.strictEqual(stdout.length, 2);
  assert.strictEqual(stdout[0], stdout[1]);
  assert.match(stdout[0], /atris reel "Your headline"/);
  assert.match(stdout[0], /--kind statement\|quote\|stat/);
  assert.match(stdout[0], /--out <file\.mp4>/);
  assert.deepStrictEqual(stderr, []);
});

test('unknown kind is rejected before rendering', async (t) => {
  const { stdout, stderr } = captureConsole(t);
  assert.strictEqual(await run(['Hello', '--kind', 'movie']), 2);
  assert.deepStrictEqual(stderr, [
    '  unknown kind "movie". try: statement, quote, stat',
  ]);
  assert.deepStrictEqual(stdout, []);
});

test('unknown size is rejected before rendering', async (t) => {
  const { stdout, stderr } = captureConsole(t);
  assert.strictEqual(await run(['Hello', '--size', 'tiny']), 2);
  assert.deepStrictEqual(stderr, [
    '  unknown size "tiny". try: og, wide, square, story',
  ]);
  assert.deepStrictEqual(stdout, []);
});

test('missing or whitespace-only text produces the appropriate guidance', async (t) => {
  const { stdout, stderr } = captureConsole(t);
  assert.strictEqual(await run([]), 2);
  assert.strictEqual(await run(['   ', '--kind', 'quote']), 2);
  assert.strictEqual(await run(['--kind', 'stat']), 2);
  assert.deepStrictEqual(stderr, [
    '  give the reel some text: atris reel "Your headline"',
    '  give the reel some text: atris reel "Your headline"',
    '  stat reels need --number',
  ]);
  assert.deepStrictEqual(stdout, []);
});
