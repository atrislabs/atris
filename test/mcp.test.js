'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');

// Spawns `atris mcp`, runs a real initialize + tools/list handshake over stdio,
// and returns every parsed response message. Offline: no HTTP calls are made.
function mcpHandshake(extraEnv = {}, timeout = 20000) {
  return new Promise((resolve, reject) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-mcp-'));
    const child = spawn(process.execPath, [cliPath, 'mcp'], {
      env: {
        ...process.env,
        HOME: home,
        ATRIS_SKIP_UPDATE_CHECK: '1',
        ATRIS_NONINTERACTIVE: '1',
        ATRIS_TOKEN: '',
        ATRIS_PROFILE: '',
        ATRIS_API_KEY: 'test-design-key',
        ...extraEnv,
      },
    });
    let stdout = '';
    let stderr = '';
    const finish = () => {
      try { child.stdin.end(); } catch { /* already closed */ }
    };
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      // Close stdin once the tools/list answer lands so the server can exit.
      if (stdout.split('\n').some((line) => {
        try { return JSON.parse(line).id === 2; } catch { return false; }
      })) finish();
    });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`mcp server hung past ${timeout}ms. stderr: ${stderr}`));
    }, timeout);

    const send = (msg) => child.stdin.write(`${JSON.stringify(msg)}\n`);
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'atris-test', version: '0.0.0' },
      },
    });
    send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });

    child.on('error', (error) => {
      clearTimeout(timer);
      fs.rmSync(home, { recursive: true, force: true });
      reject(error);
    });
    child.on('close', () => {
      clearTimeout(timer);
      fs.rmSync(home, { recursive: true, force: true });
      const messages = stdout
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => { try { return JSON.parse(line); } catch { return null; } })
        .filter(Boolean);
      resolve({ messages, stdout, stderr });
    });
  });
}

test('atris mcp lists the three design tools over stdio', async () => {
  const { messages, stderr } = await mcpHandshake();
  const init = messages.find((m) => m.id === 1);
  assert.ok(init && init.result, `no initialize response. stderr: ${stderr}`);
  const list = messages.find((m) => m.id === 2);
  assert.ok(list && list.result && Array.isArray(list.result.tools), `no tools/list response. stderr: ${stderr}`);
  const names = list.result.tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['design_check', 'design_extract', 'design_search']);
  const extract = list.result.tools.find((t) => t.name === 'design_extract');
  assert.deepEqual(extract.inputSchema.required, ['url']);
});
