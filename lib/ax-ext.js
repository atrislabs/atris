'use strict';

// Zero-dependency MCP stdio client and Claude-Code-compatible lifecycle hooks for ax.
// Config discovery:
//   MCP:   <cwd>/.mcp.json, <cwd>/.atris/mcp.json, ~/.atris/mcp.json
//   Hooks: <cwd>/.atris/hooks.json, ~/.atris/hooks.json

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { stateHome } = require('./state-home');

function readJsonSafe(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function loadMcpServerConfigs(cwd = process.cwd()) {
  const root = path.resolve(String(cwd || process.cwd()));
  const candidates = [
    path.join(stateHome(), '.atris', 'mcp.json'),
    path.join(root, '.atris', 'mcp.json'),
    path.join(root, '.mcp.json'),
  ];
  const merged = {};
  for (const file of candidates) {
    const parsed = readJsonSafe(file);
    const map = parsed && (parsed.mcpServers || parsed.servers);
    if (!map || typeof map !== 'object') continue;
    for (const [name, cfg] of Object.entries(map)) {
      if (cfg && typeof cfg.command === 'string' && cfg.command.trim()) {
        merged[name] = {
          name,
          command: cfg.command.trim(),
          args: Array.isArray(cfg.args) ? cfg.args.map(String) : [],
          env: cfg.env && typeof cfg.env === 'object' ? cfg.env : {},
          source: file,
        };
      }
    }
  }
  return Object.values(merged);
}

function sendStdioMcpRpc(serverConfig, requests, { timeoutMs = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const responses = new Map();
    let buffer = '';
    const child = spawn(serverConfig.command, serverConfig.args || [], {
      env: { ...process.env, ...(serverConfig.env || {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill('SIGTERM'); } catch {}
      if (err) reject(err);
      else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error(`MCP server "${serverConfig.name}" timed out`)), timeoutMs);

    const expectedIds = requests.filter((r) => r.id != null).map((r) => r.id);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let nl = buffer.indexOf('\n');
      while (nl !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line.startsWith('{')) {
          try {
            const msg = JSON.parse(line);
            if (msg && msg.id != null) {
              responses.set(msg.id, msg);
              if (expectedIds.every((id) => responses.has(id))) {
                finish(null, responses);
                return;
              }
            }
          } catch {}
        }
        nl = buffer.indexOf('\n');
      }
    });
    child.on('error', (err) => finish(err));
    child.on('close', (code) => {
      if (!settled) {
        if (expectedIds.every((id) => responses.has(id))) finish(null, responses);
        else finish(new Error(`MCP server "${serverConfig.name}" exited (${code}) before replying`));
      }
    });

    for (const req of requests) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...req })}\n`);
    }
    child.stdin.end();
  });
}

async function listMcpServerTools(serverConfig, options = {}) {
  const responses = await sendStdioMcpRpc(serverConfig, [
    {
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'atris-ax', version: '1.0.0' },
      },
    },
    { method: 'notifications/initialized', params: {} },
    { id: 2, method: 'tools/list', params: {} },
  ], options);
  const listResp = responses.get(2);
  const tools = listResp && listResp.result && Array.isArray(listResp.result.tools)
    ? listResp.result.tools
    : [];
  return tools.map((tool) => ({
    server: serverConfig.name,
    name: String(tool.name || ''),
    qualifiedName: `mcp__${serverConfig.name}__${String(tool.name || '')}`,
    description: String(tool.description || ''),
    inputSchema: tool.inputSchema || { type: 'object', properties: {} },
  }));
}

async function callMcpServerTool(serverConfig, toolName, args = {}, options = {}) {
  const responses = await sendStdioMcpRpc(serverConfig, [
    {
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'atris-ax', version: '1.0.0' },
      },
    },
    { method: 'notifications/initialized', params: {} },
    {
      id: 2,
      method: 'tools/call',
      params: { name: toolName, arguments: args || {} },
    },
  ], options);
  const callResp = responses.get(2);
  if (!callResp) return { status: 'error', error: 'No MCP tool response' };
  if (callResp.error) {
    return { status: 'error', error: String(callResp.error.message || 'MCP error') };
  }
  return { status: 'ok', result: callResp.result || {} };
}

function loadHooksConfig(cwd = process.cwd()) {
  const root = path.resolve(String(cwd || process.cwd()));
  const candidates = [
    path.join(stateHome(), '.atris', 'hooks.json'),
    path.join(root, '.atris', 'hooks.json'),
  ];
  const merged = {};
  for (const file of candidates) {
    const parsed = readJsonSafe(file);
    const hooks = parsed && (parsed.hooks || parsed);
    if (!hooks || typeof hooks !== 'object') continue;
    for (const [eventName, entries] of Object.entries(hooks)) {
      if (!Array.isArray(entries)) continue;
      if (!merged[eventName]) merged[eventName] = [];
      for (const item of entries) {
        if (typeof item === 'string' && item.trim()) {
          merged[eventName].push({ matcher: '*', command: item.trim() });
        } else if (item && typeof item.command === 'string' && item.command.trim()) {
          merged[eventName].push({
            matcher: String(item.matcher || '*'),
            command: item.command.trim(),
          });
        }
      }
    }
  }
  return merged;
}

function runLifecycleHooks(eventName, payload = {}, { cwd = process.cwd(), timeoutMs = 8000 } = {}) {
  const hooks = loadHooksConfig(cwd)[eventName];
  if (!Array.isArray(hooks) || hooks.length === 0) {
    return Promise.resolve({ blocked: false, outputs: [] });
  }
  const targets = [payload && payload.op, payload && payload.tool].filter(Boolean).map(String);
  const matching = hooks.filter((h) => {
    if (!h.matcher || h.matcher === '*') return true;
    try {
      const re = new RegExp(h.matcher, 'i');
      return targets.some((t) => re.test(t));
    } catch {
      const needle = h.matcher.toLowerCase();
      return targets.some((t) => t.toLowerCase() === needle);
    }
  });
  if (!matching.length) return Promise.resolve({ blocked: false, outputs: [] });

  return matching.reduce(async (chainPromise, hook) => {
    const acc = await chainPromise;
    if (acc.blocked) return acc;
    const result = await new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let settled = false;
      const child = spawn(process.env.SHELL || '/bin/sh', ['-lc', hook.command], {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const finish = (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ code: typeof code === 'number' ? code : 1, stdout: stdout.trim(), stderr: stderr.trim() });
      };
      const timer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch {}
        finish(124);
      }, timeoutMs);
      child.stdout.on('data', (d) => { stdout += d.toString('utf8'); });
      child.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
      child.on('error', (err) => { stderr += String((err && err.message) || err); finish(1); });
      child.on('close', finish);
      child.stdin.write(JSON.stringify({ event: eventName, cwd, ...payload }));
      child.stdin.end();
    });

    if (result.stdout) acc.outputs.push(result.stdout);
    // Claude Code hook convention: exit code 2 blocks the action with stderr reason.
    if (result.code === 2) {
      acc.blocked = true;
      acc.reason = result.stderr || result.stdout || `Blocked by ${eventName} hook`;
    }
    return acc;
  }, Promise.resolve({ blocked: false, outputs: [] }));
}

module.exports = {
  loadMcpServerConfigs,
  listMcpServerTools,
  callMcpServerTool,
  loadHooksConfig,
  runLifecycleHooks,
};
