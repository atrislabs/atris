const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

for (const [scenario, messages] of [
  ['not-ready', ['Computer did not become ready in time.']],
  ['fallback-fails', ['Failed: chat failed', 'Fallback failed: proxy failed']],
  ['no-business', ['Failed: request failed']],
]) {
  test(`computer exec exits nonzero when ${scenario}`, () => {
    const script = `
      const scenario = process.argv[1];
      require('./utils/auth').loadCredentials = () => ({ token: 'test' });
      const core = require('./lib/computer-core');
      core.resolveComputerCommandContext = async () => scenario === 'no-business' ? null : { businessId: 'b', workspaceId: 'w' };
      core.ensureBusinessAwake = async () => scenario !== 'not-ready';
      core.runBusinessPromptViaRunnerProxy = async () => ({ ok: false, error: 'proxy failed' });
      require('./utils/api').apiRequestJson = async () => scenario === 'no-business'
        ? { ok: false, errorMessage: 'request failed' }
        : { ok: false, error: 'chat failed' };
      require('./commands/computer').runComputer(['exec', 'hello']).catch(err => { console.error(err); process.exitCode = 2; });
    `;
    const result = spawnSync(process.execPath, ['-e', script, scenario], { cwd: root, encoding: 'utf8' });
    assert.equal(result.signal, null);
    for (const message of messages) assert.ok(result.stderr.includes(message), result.stderr);
    assert.equal(result.status, 1, `${scenario} should exit with status 1`);
  });
}
