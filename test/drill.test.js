const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');

function hasNodeSqlite() {
  const result = spawnSync(process.execPath, ['-e', 'require("node:sqlite")'], {
    encoding: 'utf8',
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
  });
  return result.status === 0;
}

function runCli(args, { timeout = 60000 } = {}) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout,
    env: {
      ...process.env,
      ATRIS_SKIP_UPDATE_CHECK: '1',
      NODE_NO_WARNINGS: '1',
    },
  });
  if (result.error) throw result.error;
  return result;
}

test('drill command passes on a healthy checkout', () => {
  if (!hasNodeSqlite()) return;
  const result = runCli(['drill']);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /wish captured/);
  assert.match(result.stdout, /task claimed/);
  assert.match(result.stdout, /mission started/);
  assert.match(result.stdout, /tick verified/);
  assert.match(result.stdout, /landing shipped \(local mode\)/);
  assert.match(result.stdout, /ledger checked/);
  assert.match(result.stdout, /PASS \d+ms/);
});

test('drill json shape is stable', () => {
  if (!hasNodeSqlite()) return;
  const result = runCli(['drill', '--json']);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.pass, true);
  assert.ok(Array.isArray(payload.stages));
  assert.ok(payload.stages.length >= 7);
  for (const stage of payload.stages) {
    assert.equal(typeof stage.name, 'string');
    assert.equal(stage.ok, true);
    assert.equal(typeof stage.ms, 'number');
    assert.ok(!Object.prototype.hasOwnProperty.call(stage, 'error'));
  }
});

test('drill sabotage fails at the next corrupted stage', async () => {
  if (!hasNodeSqlite()) return;
  const { runDrill } = require('../commands/drill');
  const result = await runDrill({
    reporter: () => {},
    afterStage: (name, ctx) => {
      if (name === 'mission started') {
        fs.writeFileSync(path.join(ctx.sandboxPath, '.atris', 'state', 'missions.jsonl'), '{not json\n', 'utf8');
      }
    },
  });
  assert.equal(result.pass, false);
  const failed = result.stages.find((stage) => !stage.ok);
  assert.equal(failed.name, 'tick verified');
  assert.match(failed.error, /mission|No mission|not found|Unexpected token/i);
});

test('drill removes the sandbox unless keep is set', async () => {
  if (!hasNodeSqlite()) return;
  const { runDrill } = require('../commands/drill');
  const result = await runDrill({ reporter: () => {} });
  assert.equal(result.pass, true);
  assert.ok(result.sandbox_path);
  assert.equal(fs.existsSync(result.sandbox_path), false);
  assert.equal(fs.existsSync(result.tmp_root), false);
});
