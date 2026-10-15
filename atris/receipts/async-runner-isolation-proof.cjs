'use strict';

// Advisory reproduction only: builds command strings, never executes them.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '../..');
const source = fs.readFileSync(path.join(root, 'test/runner-command.test.js'), 'utf8');
const start = source.indexOf('const RUNNER_ENV_KEYS = [');
const end = source.indexOf('\nfunction withEnv(', start);
assert.ok(start >= 0 && end > start, 'expected existing environment helper');
const { buildRunnerCommand } = require(path.join(root, 'lib/runner-command'));
const keys = ['ATRIS_RUNNER_PROFILE', 'ATRIS_RUNNER_MODEL', 'ATRIS_RUNNER_BIN',
  'ATRIS_RUNNER_COMMAND_TEMPLATE', 'ATRIS_CLAUDE_MODEL', 'ATRIS_CLAUDE_BIN',
  'ATRIS_CLAUDE_COMMAND_TEMPLATE'];

async function main() {
  const saved = new Map(keys.map(key => [key, process.env[key]]));
  try {
    for (const key of keys) delete process.env[key];
    process.env.ATRIS_RUNNER_PROFILE = 'codex';
    const context = vm.createContext({ process });
    vm.runInContext(source.slice(start, end), context);
    let pending;
    const result = context.withRunnerEnv({ ATRIS_RUNNER_PROFILE: 'claude' }, () => {
      pending = (async () => {
        const before = buildRunnerCommand({ promptFile: '/tmp/advisory-prompt.txt' });
        await Promise.resolve();
        const after = buildRunnerCommand({ promptFile: '/tmp/advisory-prompt.txt' });
        return { before, after };
      })();
      return pending;
    });
    const { before, after } = await pending;
    assert.equal(result, undefined, 'current helper discards the callback promise');
    assert.match(before, /^claude -p /);
    assert.match(after, /^codex exec /);
    console.log('before await: claude command');
    console.log('after await: inherited codex command');
    console.log('helper returned no promise; no model command executed');
  } finally {
    for (const key of keys) {
      if (saved.get(key) === undefined) delete process.env[key];
      else process.env[key] = saved.get(key);
    }
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
