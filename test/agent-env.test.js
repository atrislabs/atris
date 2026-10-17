'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { scrubAgentEnv, AGENT_ENV_MARKERS } = require('./helpers/agent-env');

test('agent environment helper loads without production commands in a fresh process', () => {
  const root = path.join(__dirname, '..');
  const helper = path.join(__dirname, 'helpers', 'agent-env.js');
  const source = `
    const assert = require('node:assert/strict');
    const path = require('node:path');
    const [helper, root] = process.argv.slice(1);
    const before = new Set(Object.keys(require.cache));
    assert.equal(before.has(helper), false);
    assert.equal(before.has(path.join(root, 'commands', 'task.js')), false);
    const nativeBefore = [...process.moduleLoadList];
    require(helper);
    console.log(JSON.stringify({
      addedFiles: Object.keys(require.cache).filter(file => !before.has(file)),
      nativeBefore,
      nativeAfter: [...process.moduleLoadList],
    }));
  `;
  const result = spawnSync(process.execPath, ['-e', source, helper, root], {
    cwd: root,
    env: process.env,
    encoding: 'utf8',
    timeout: 10000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  const graph = JSON.parse(result.stdout);
  assert.deepEqual(graph.addedFiles.filter(file => file.startsWith(root + path.sep)), [helper]);
  assert.ok(graph.nativeAfter.length >= graph.nativeBefore.length);
});

test('agent environment markers match the actual task producer', () => {
  const producer = require('../commands/task');
  assert.deepEqual(AGENT_ENV_MARKERS, producer.AGENT_ENV_MARKERS);
  assert.equal(Object.isFrozen(AGENT_ENV_MARKERS), false);
});

test('agent environment scrubbing removes agent identity and preserves its frozen input', () => {
  const base = Object.freeze({
    CLAUDECODE: '1',
    CLAUDE_CODE_ENTRYPOINT: 'test',
    CODEX_SANDBOX: 'test',
    CURSOR_AGENT: '1',
    DEVIN_SESSION_ID: 'test',
    CODEX_THREAD_ID: 'test',
    CODEX_SESSION_ID: 'test',
    ATRIS_CALLER_RUNTIME: 'test',
    ATRIS_AGENT_PROOF_ONLY: '1',
    ATRIS_PROFILE: 'test',
    ATRIS_PLAYER: 'test',
    ATRIS_USERNAME: 'test',
    ATRIS_AGENT_ID: 'test',
    ATRIS_MISSION_DRIVER_DETACHED: '1',
    ATRIS_MISSION_DRIVER_PARENT_PID: '123',
    HOME: '/kept-home',
    PATH: '/kept-bin',
    NODE_TEST_CONTEXT: 'kept-context',
    KEEP: 'value',
  });
  const before = { ...base };
  const result = scrubAgentEnv(base);
  assert.deepEqual(result, {
    HOME: '/kept-home',
    PATH: '/kept-bin',
    NODE_TEST_CONTEXT: 'kept-context',
    KEEP: 'value',
  });
  assert.notEqual(result, base);
  assert.deepEqual(base, before);
});

test('agent environment scrubbing defaults to the current environment without changing it', () => {
  const before = { ...process.env };
  const implicit = scrubAgentEnv();
  const explicit = scrubAgentEnv(process.env);
  assert.notEqual(implicit, process.env);
  assert.deepEqual(Object.keys(implicit), Object.keys(explicit));
  assert.ok(Object.keys(explicit).every(key => implicit[key] === explicit[key]));
  assert.deepEqual(Object.keys(process.env), Object.keys(before));
  assert.ok(Object.keys(before).every(key => process.env[key] === before[key]));
});
