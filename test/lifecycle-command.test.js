const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

async function captureHelp(command, args, expectedLines) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-lifecycle-command-'));
  const previous = {
    cwd: process.cwd(),
    home: process.env.HOME,
    argv: process.argv,
    log: console.log,
    exit: process.exit,
  };
  const lines = [];
  const exits = [];
  const stopped = new Error('captured process exit');
  try {
    process.env.HOME = root;
    process.chdir(root);
    fs.mkdirSync(path.join(root, '.atris'));
    const binding = JSON.stringify({ slug: 'bound-workspace' });
    fs.writeFileSync(path.join(root, '.atris', 'business.json'), binding);
    process.argv = ['node', 'atris', command, ...args];
    console.log = (...values) => lines.push(values.join(' '));
    process.exit = (code) => {
      exits.push(code);
      throw stopped;
    };
    const lifecycle = require('../commands/lifecycle');
    await assert.rejects(lifecycle[`${command}Atris`](), (error) => error === stopped);
    assert.deepStrictEqual(exits, [0]);
    assert.deepStrictEqual(lines, expectedLines);
    assert.strictEqual(fs.readFileSync(path.join(root, '.atris', 'business.json'), 'utf8'), binding);
    assert.deepStrictEqual(fs.readdirSync(path.join(root, '.atris')), ['business.json']);
  } finally {
    console.log = previous.log;
    process.exit = previous.exit;
    process.argv = previous.argv;
    process.chdir(previous.cwd);
    if (previous.home === undefined) delete process.env.HOME;
    else process.env.HOME = previous.home;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('sleep help aliases print usage and exit successfully in a bound workspace', async () => {
  for (const alias of ['--help', '-h', 'help']) {
    await captureHelp('sleep', [alias], [
      'Usage: atris sleep [business|member] [--loop <loop-id>]',
      '',
      '  Pause a workspace to save compute. Storage only.',
      '  Or flip a local member / member-loop switch asleep.',
    ]);
  }
});

test('wake help overrides an explicit business argument and prints wake guidance', async () => {
  for (const alias of ['--help', '-h', 'help']) {
    await captureHelp('wake', ['explicit-workspace', alias], [
      'Usage: atris wake [business|member] [--loop <loop-id>]',
      '',
      '  Wake a sleeping workspace. Wake signal sent; loops pick it up on their next pass.',
      '  Or flip a local member / member-loop switch awake.',
    ]);
  }
});
