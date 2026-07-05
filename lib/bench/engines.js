'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ENGINE_NAMES = Object.freeze([
  'codex',
  'cursor',
  'claude',
  'atris-fast',
  'null',
  'solution',
]);

const ENGINE_BINS = Object.freeze({
  codex: 'codex',
  cursor: 'cursor-agent',
  claude: 'claude',
  'atris-fast': 'atris',
});

function normalizeEngineName(name) {
  const normalized = String(name || '').trim();
  if (!normalized) return '';
  if (!ENGINE_NAMES.includes(normalized)) {
    throw new Error(`unknown bench engine: ${normalized}`);
  }
  return normalized;
}

function commandAvailable(command) {
  const result = spawnSync('/bin/sh', ['-c', `command -v ${command}`], {
    encoding: 'utf8',
    env: process.env,
  });
  return result.status === 0 && Boolean(String(result.stdout || '').trim());
}

function spawnEngine(command, args, workspaceDir, timeoutMs, options = {}) {
  const result = spawnSync(command, args, {
    cwd: workspaceDir,
    input: options.input,
    encoding: 'utf8',
    timeout: Number(timeoutMs || 300000),
    maxBuffer: Number(options.maxBuffer || 16 * 1024 * 1024),
    env: {
      ...process.env,
      ...(options.env || {}),
    },
  });
  return {
    status: result.status === null ? 1 : result.status,
    stdout: result.stdout || '',
    stderr: result.error ? String(result.error.message || result.error) : (result.stderr || ''),
  };
}

function realEngineAdapter(name, bin, runArgs) {
  return {
    name,
    available(workspaceDir) {
      if (!commandAvailable(bin)) {
        return { available: false, reason: `${bin} not found` };
      }
      if (name === 'atris-fast' && !fs.existsSync(path.join(workspaceDir, 'atris'))) {
        return { available: false, reason: 'workspace root is not an Atris workspace' };
      }
      return { available: true, reason: 'available' };
    },
    run(promptText, workspaceDir, timeoutMs) {
      return spawnEngine(bin, runArgs(promptText, workspaceDir), workspaceDir, timeoutMs);
    },
  };
}

function nullEngineAdapter() {
  return {
    name: 'null',
    available() {
      return { available: true, reason: 'available' };
    },
    run() {
      return { status: 0, stdout: '', stderr: '' };
    },
  };
}

function solutionEngineAdapter(solutionPath) {
  return {
    name: 'solution',
    available() {
      if (!solutionPath || !fs.existsSync(solutionPath)) {
        return { available: false, reason: 'solution.sh not found' };
      }
      return { available: true, reason: 'available' };
    },
    run(_promptText, workspaceDir, timeoutMs) {
      return spawnEngine('/bin/sh', [solutionPath], workspaceDir, timeoutMs);
    },
  };
}

function getEngineAdapter(name, options = {}) {
  const normalized = normalizeEngineName(name);
  if (normalized === 'null') return nullEngineAdapter();
  if (normalized === 'solution') return solutionEngineAdapter(options.solutionPath);
  if (normalized === 'codex') {
    return realEngineAdapter('codex', ENGINE_BINS.codex, (promptText, workspaceDir) => [
      'exec',
      '--dangerously-bypass-approvals-and-sandbox',
      '-C',
      workspaceDir,
      promptText,
    ]);
  }
  if (normalized === 'cursor') {
    return realEngineAdapter('cursor', ENGINE_BINS.cursor, (promptText) => ['--trust', '-p', promptText]);
  }
  if (normalized === 'claude') {
    return realEngineAdapter('claude', ENGINE_BINS.claude, (promptText) => [
      '-p',
      promptText,
      '--dangerously-skip-permissions',
    ]);
  }
  if (normalized === 'atris-fast') {
    return realEngineAdapter('atris-fast', ENGINE_BINS['atris-fast'], (promptText) => [
      'chat',
      '--print',
      promptText,
    ]);
  }
  throw new Error(`unknown bench engine: ${name}`);
}

module.exports = {
  ENGINE_NAMES,
  getEngineAdapter,
  normalizeEngineName,
};
