const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

const { showVersion } = require('../commands/version');
const packageJson = require('../package.json');

// Swap out process.exit so tests can observe the exit code without stopping
// the runner. The sentinel error unwinds out of the command the same way exit does.
function captureExit(fn) {
  const realExit = process.exit;
  const exits = [];
  process.exit = (code) => {
    exits.push(code);
    throw new Error(`__exit__:${code}`);
  };
  try {
    fn();
  } catch (error) {
    if (!String(error.message).startsWith('__exit__:')) throw error;
  } finally {
    process.exit = realExit;
  }
  return exits;
}

function captureConsole(method, fn) {
  const real = console[method];
  const lines = [];
  console[method] = (...args) => lines.push(args.join(' '));
  try {
    fn();
  } finally {
    console[method] = real;
  }
  return lines;
}

test('showVersion prints the version from package.json', () => {
  const lines = captureConsole('log', () => showVersion(['version']));
  assert.deepStrictEqual(lines, [`atris v${packageJson.version}`]);
});

test('showVersion refuses --json with a JSON error and exit code 2', () => {
  let exits;
  const lines = captureConsole('log', () => {
    exits = captureExit(() => showVersion(['version', '--json']));
  });
  assert.deepStrictEqual(exits, [2]);
  assert.strictEqual(lines.length, 1);
  assert.deepStrictEqual(JSON.parse(lines[0]), {
    ok: false,
    error: 'version does not support --json',
    command: 'version',
    usage: 'atris version',
  });
});

test('showVersion reads process.argv when no args are passed', () => {
  const realArgv = process.argv;
  process.argv = ['node', 'atris', 'version', '--json'];
  let exits;
  try {
    captureConsole('log', () => {
      exits = captureExit(() => showVersion());
    });
  } finally {
    process.argv = realArgv;
  }
  assert.deepStrictEqual(exits, [2]);
});

test('showVersion reports a read failure on stderr and exits 1', () => {
  const realRead = fs.readFileSync;
  fs.readFileSync = (file, ...rest) => {
    if (String(file).endsWith('package.json')) {
      throw new Error('simulated read failure');
    }
    return realRead.call(fs, file, ...rest);
  };
  let exits;
  let errors;
  try {
    errors = captureConsole('error', () => {
      exits = captureExit(() => showVersion(['version']));
    });
  } finally {
    fs.readFileSync = realRead;
  }
  assert.deepStrictEqual(exits, [1]);
  assert.deepStrictEqual(errors, ['✗ Error: Could not read package.json']);
});
