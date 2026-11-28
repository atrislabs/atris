'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { effectiveEffortForEngine } = require('../effort-router');

const ENGINE_NAMES = Object.freeze([
  'codex',
  'cursor',
  'claude',
  'atris-fast',
  'agy',
  'opencode',
  'devin',
  'null',
  'solution',
]);

const ENGINE_BINS = Object.freeze({
  codex: 'codex',
  cursor: 'cursor-agent',
  claude: 'claude',
  'atris-fast': 'atris',
  agy: 'agy',
  opencode: 'opencode',
  devin: 'devin',
});

const AGY_HEADLESS_NOTE = 'You are running headless with edit permission already granted. Apply changes directly and never ask for confirmation; finish the task fully, then report.';

function normalizeEngineName(name) {
  const normalized = String(name || '').trim();
  if (!normalized) return '';
  if (!ENGINE_NAMES.includes(normalized)) {
    throw new Error(`unknown bench engine: ${normalized}`);
  }
  return normalized;
}

function commandAvailable(command, env = process.env) {
  const result = spawnSync('/bin/sh', ['-c', `command -v ${command}`], {
    encoding: 'utf8',
    env,
  });
  return result.status === 0 && Boolean(String(result.stdout || '').trim());
}

function spawnEngine(command, args, workspaceDir, timeoutMs, options = {}) {
  // Two hermetic-workspace traps (verified live 2026-09-04): engines that
  // read PWD from the environment (opencode) edited the real repo fixture
  // instead of the temp workspace, and engines that read a piped stdin as
  // the prompt (devin) exited 0 in 3s having done nothing. Point PWD at the
  // workspace and close stdin unless the caller supplies input.
  const result = spawnSync(command, args, {
    cwd: workspaceDir,
    input: options.input,
    stdio: options.input === undefined ? ['ignore', 'pipe', 'pipe'] : undefined,
    encoding: 'utf8',
    timeout: Number(timeoutMs || 300000),
    maxBuffer: Number(options.maxBuffer || 16 * 1024 * 1024),
    env: {
      ...process.env,
      PWD: workspaceDir,
      ...(options.env || {}),
    },
  });
  return {
    status: result.status === null ? 1 : result.status,
    stdout: result.stdout || '',
    stderr: result.error ? String(result.error.message || result.error) : (result.stderr || ''),
    timedOut: Boolean(result.error && result.error.code === 'ETIMEDOUT'),
  };
}

function realEngineAdapter(name, bin, runArgs) {
  return {
    name,
    available(workspaceDir, env) {
      if (!commandAvailable(bin, env)) {
        return { available: false, reason: `${bin} not found` };
      }
      if (name === 'atris-fast' && !fs.existsSync(path.join(workspaceDir, 'atris'))) {
        return { available: false, reason: 'workspace root is not an Atris workspace' };
      }
      return { available: true, reason: 'available' };
    },
    run(promptText, workspaceDir, timeoutMs, env) {
      return spawnEngine(bin, runArgs(promptText, workspaceDir), workspaceDir, timeoutMs, { env });
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
    run(_promptText, workspaceDir, timeoutMs, env) {
      return spawnEngine('/bin/sh', [solutionPath], workspaceDir, timeoutMs, { env });
    },
  };
}

function buildEngineArgs(name, { promptText, workspaceDir, model = '', effort = '' } = {}) {
  switch (name) {
    case 'codex': return ['exec', '--dangerously-bypass-approvals-and-sandbox', ...(model ? ['--model', model] : []), ...(effort ? ['-c', `model_reasoning_effort=${effort}`] : []), '-C', workspaceDir, promptText];
    case 'claude': return ['-p', promptText, '--dangerously-skip-permissions', ...(model ? ['--model', model] : []), ...(effort ? ['--effort', effort] : [])];
    case 'cursor': return ['--trust', '-p', promptText];
    case 'agy': return ['--mode', 'accept-edits', '--dangerously-skip-permissions', '--add-dir', workspaceDir, ...(model ? ['--model', model] : []), '-p', `${AGY_HEADLESS_NOTE}\n\n${promptText}`];
    case 'opencode': return ['run', '--auto', ...(model ? ['-m', model] : []), promptText];
    case 'devin': return ['-p', '--permission-mode', 'dangerous', ...(model ? ['--model', model] : []), '--', promptText];
    case 'atris-fast': return ['chat', '--print', promptText];
    default: throw new Error(`unknown bench engine: ${name}`);
  }
}

function getEngineAdapter(name, options = {}) {
  const normalized = normalizeEngineName(name);
  const model = options.model ? String(options.model).trim() : '';
  const effort = options.effort ? (effectiveEffortForEngine(normalized, options.effort) || '') : '';
  if (normalized === 'null') return nullEngineAdapter();
  if (normalized === 'solution') return solutionEngineAdapter(options.solutionPath);
  if (!ENGINE_BINS[normalized]) throw new Error(`unknown bench engine: ${name}`);
  return {
    ...realEngineAdapter(normalized, ENGINE_BINS[normalized], (promptText, workspaceDir) =>
      buildEngineArgs(normalized, { promptText, workspaceDir, model, effort })),
    model: model || null,
    effort: effort || null,
  };
}

module.exports = {
  ENGINE_NAMES,
  buildEngineArgs,
  getEngineAdapter,
  normalizeEngineName,
};
