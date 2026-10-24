const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { integrationsStatus } = require('../commands/integrations');

function runInTempWorkspace(fn) {
  return async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-integrations-status-'));
    const originalCwd = process.cwd();
    const originalHome = process.env.HOME;
    const savedAtrisEnv = {};
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('ATRIS_')) {
        savedAtrisEnv[key] = process.env[key];
        delete process.env[key];
      }
    }
    process.env.HOME = root;
    process.chdir(root);
    const lines = [];
    const originalLog = console.log;
    console.log = (line) => lines.push(String(line));
    try {
      await fn(fs.realpathSync(root), lines);
    } finally {
      console.log = originalLog;
      process.chdir(originalCwd);
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      for (const [key, value] of Object.entries(savedAtrisEnv)) process.env[key] = value;
    }
  };
}

test('integrations status lists workspace integrations from .atris/integrations.json', runInTempWorkspace(async (root, lines) => {
  fs.mkdirSync(path.join(root, '.atris'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.atris', 'integrations.json'),
    JSON.stringify({ integrations: ['gmail', 'slack'] }),
    'utf8',
  );

  const code = await integrationsStatus([]);

  assert.equal(code, 0);
  assert.ok(lines.includes('Integration Status (workspace)\n'));
  assert.ok(lines.includes('  • gmail'));
  assert.ok(lines.includes('  • slack'));
  assert.ok(lines.some((line) => line.includes('--global')));
}));

test('integrations status treats malformed integrations.json as empty', runInTempWorkspace(async (root, lines) => {
  fs.mkdirSync(path.join(root, '.atris'), { recursive: true });
  fs.writeFileSync(path.join(root, '.atris', 'integrations.json'), '{ not json', 'utf8');

  const code = await integrationsStatus(['--json']);

  assert.equal(code, 0);
  const payload = JSON.parse(lines.join('\n'));
  assert.equal(payload.scope, 'workspace');
  assert.equal(payload.workspace_root, root);
  assert.deepEqual(payload.integrations, []);
}));

test('integrations status prints the empty note when no config exists', runInTempWorkspace(async (root, lines) => {
  const code = await integrationsStatus([]);

  assert.equal(code, 0);
  assert.ok(lines.includes('  (none configured in this workspace)'));
}));
