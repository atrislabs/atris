const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  parseSpawnArgs,
  createSpawnRequest,
  commandForEngine,
  agentDogfoodCommand,
  agentSpawnCommand,
  agentSpawnListCommand,
  agentSpawnStatusCommand,
} = require('../commands/agent-spawn');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-agent-spawn-'));
}

test('parseSpawnArgs accepts role, task, engine, and json flags', () => {
  const options = parseSpawnArgs(['worker', '--task', 'Fix the thing', '--engine', 'droid', '--json']);
  assert.equal(options.role, 'worker');
  assert.equal(options.task, 'Fix the thing');
  assert.equal(options.engine, 'droid');
  assert.equal(options.json, true);
});

test('createSpawnRequest builds a concrete next command for codex', () => {
  const request = createSpawnRequest('/workspace/project', {
    role: 'explorer',
    task: 'Find the auth route',
    engine: 'codex',
  });
  assert.equal(request.schema, 'atris.agent_spawn.v1');
  assert.equal(request.status, 'requested');
  assert.equal(request.role, 'explorer');
  assert.equal(request.cwd, '/workspace/project');
  assert.match(request.command, /^codex exec /);
  assert.match(request.command, /Find the auth route/);
  assert.match(commandForEngine({ ...request, engine: 'manual' }) || '', /^$/);
});

test('createSpawnRequest builds GLM 5.2 commands for Devin and Droid', () => {
  const devin = createSpawnRequest('/workspace/project', {
    role: 'tester',
    task: 'Run cheap dogfood',
    engine: 'devin',
  });
  assert.match(devin.command, /^devin --model glm-5\.2 --permission-mode auto -p /);

  const droid = createSpawnRequest('/workspace/project', {
    role: 'tester',
    task: 'Run cheap dogfood',
    engine: 'droid',
  });
  assert.match(droid.command, /^droid exec --model glm-5\.2 --reasoning-effort off /);
});

test('agentDogfoodCommand dry-runs Devin and Droid without live prompts', () => {
  const dir = tempDir();
  const calls = [];
  try {
    const result = agentDogfoodCommand(['--engine', 'all', '--json'], {
      root: dir,
      output: () => {},
      commandOnPath: (name) => `/usr/bin/${name}`,
      spawnSync: (cmd, args = []) => {
        calls.push([cmd, ...args]);
        const joined = [cmd, ...args].join(' ');
        if (joined === 'devin version') return { status: 0, stdout: 'devin 2026.7.23\n', stderr: '' };
        if (joined === 'devin --help') return { status: 0, stdout: 'Usage: devin --model <MODEL> -p <PROMPT>\n', stderr: '' };
        if (joined === 'droid --version') return { status: 0, stdout: '0.156.2\n', stderr: '' };
        if (joined === 'droid exec --help') return { status: 0, stdout: 'Available Models:\n  glm-5.2 Droid Core\n', stderr: '' };
        return { status: 1, stdout: '', stderr: `unexpected ${joined}` };
      },
    });
    assert.equal(result.ok, true);
    assert.equal(result.live, false);
    assert.equal(result.engines.length, 2);
    assert.equal(calls.some(call => call.join(' ').includes('ATRIS_DEVIN_GLM52_OK')), false);
    assert.ok(fs.existsSync(result.receipt_path));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('agentDogfoodCommand live mode verifies sentinel responses', () => {
  const dir = tempDir();
  try {
    const result = agentDogfoodCommand(['--engine', 'all', '--model', 'glm-5.2', '--live', '--no-write', '--json'], {
      root: dir,
      output: () => {},
      commandOnPath: (name) => `/usr/bin/${name}`,
      spawnSync: (cmd, args = []) => {
        const joined = [cmd, ...args].join(' ');
        if (joined === 'devin version') return { status: 0, stdout: 'devin 2026.7.23\n', stderr: '' };
        if (joined === 'devin --help') return { status: 0, stdout: 'Usage: devin --model <MODEL> -p <PROMPT>\n', stderr: '' };
        if (joined === 'droid --version') return { status: 0, stdout: '0.156.2\n', stderr: '' };
        if (joined === 'droid exec --help') return { status: 0, stdout: 'Available Models:\n  glm-5.2 Droid Core\n', stderr: '' };
        if (joined.includes('ATRIS_DEVIN_GLM52_OK')) return { status: 0, stdout: 'ATRIS_DEVIN_GLM52_OK\n', stderr: '' };
        if (joined.includes('ATRIS_DROID_GLM52_OK')) return { status: 0, stdout: 'ATRIS_DROID_GLM52_OK\n', stderr: '' };
        return { status: 1, stdout: '', stderr: `unexpected ${joined}` };
      },
    });
    assert.equal(result.ok, true);
    assert.equal(result.live, true);
    assert.equal(result.engines.every(engine => engine.checks.some(check => check.name === 'live_sentinel_prompt')), true);
    assert.equal(result.receipt_path, undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('agentSpawnCommand writes and lists durable spawn requests', () => {
  const dir = tempDir();
  const output = [];
  try {
    const created = agentSpawnCommand(['worker', '--task', 'Run focused proof', '--engine', 'manual'], {
      root: dir,
      output: (line) => output.push(line),
    });
    assert.equal(created.action, 'spawn_created');
    assert.ok(fs.existsSync(path.join(dir, '.atris', 'state', 'agent_spawns.jsonl')));

    const listedOutput = [];
    const listed = agentSpawnListCommand([], {
      root: dir,
      output: (line) => listedOutput.push(line),
    });
    assert.equal(listed.requests.length, 1);
    assert.match(listedOutput.join('\n'), /Run focused proof/);

    const statusOutput = [];
    const status = agentSpawnStatusCommand([created.request.id], {
      root: dir,
      output: (line) => statusOutput.push(line),
    });
    assert.equal(status.request.id, created.request.id);
    assert.match(statusOutput.join('\n'), /spawned/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
