'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { scrubAgentEnv } = require('./helpers/agent-env');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-supervisor-skip-'));
}

function cleanupTempDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function runCli(args, { cwd, env } = {}) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 20000,
    env: {
      ...scrubAgentEnv(),
      ATRIS_SKIP_UPDATE_CHECK: '1',
      ATRIS_NO_INTERACTIVE: '1',
      ...(env || {}),
    },
  });
  if (result.error) throw result.error;
  return result;
}

function writeSupervisorMember(root) {
  const dir = path.join(root, 'atris', 'team', 'supervisor');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'MEMBER.md'), [
    '---',
    'name: supervisor',
    'role: Meta-cognition Layer',
    '---',
    '',
    '# supervisor',
    '',
  ].join('\n'), 'utf8');
  return dir;
}

function supervisorTickReceipts(root) {
  const runsDir = path.join(root, 'atris', 'runs');
  if (!fs.existsSync(runsDir)) return [];
  return fs.readdirSync(runsDir).filter((f) => /^supervisor-tick-.*\.json$/.test(f));
}

test('unconfigured dry supervisor tick skips quietly and writes no receipt', () => {
  const root = makeTempDir();
  try {
    writeSupervisorMember(root);
    const env = { ATRIS_TASKS_DB: path.join(root, 'tasks.db'), NODE_NO_WARNINGS: '1' };
    delete env.ATRIS_SUPERVISOR_LLM;
    delete env.ATRIS_SUPERVISOR_LLM_JSON;

    const before = supervisorTickReceipts(root);
    const res = runCli(['member', 'wake', 'supervisor', '--json'], { cwd: root, env });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    const payload = JSON.parse(res.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.reason, 'skipped_llm_not_configured');
    assert.equal(payload.executed, false);
    assert.equal(payload.receipt_path, null);
    assert.deepEqual(supervisorTickReceipts(root), before);
  } finally {
    cleanupTempDir(root);
  }
});

test('injected json analysis still writes a supervisor receipt', () => {
  const root = makeTempDir();
  try {
    writeSupervisorMember(root);
    const env = {
      ATRIS_TASKS_DB: path.join(root, 'tasks.db'),
      NODE_NO_WARNINGS: '1',
      ATRIS_SUPERVISOR_LLM_JSON: JSON.stringify({
        top_performers: [],
        bottlenecks: [],
        recommendations: [],
      }),
    };

    const res = runCli(['member', 'wake', 'supervisor', '--json'], { cwd: root, env });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    const payload = JSON.parse(res.stdout);
    assert.equal(payload.ok, true);
    assert.notEqual(payload.reason, 'skipped_llm_not_configured');
    assert.ok(supervisorTickReceipts(root).length >= 1, 'expected a supervisor-tick receipt');
  } finally {
    cleanupTempDir(root);
  }
});
