'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

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

function commandAvailable(command) {
  const result = spawnSync('/bin/sh', ['-c', `command -v ${command}`], {
    encoding: 'utf8',
    env: process.env,
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
  const model = options.model ? String(options.model).trim() : '';
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
  if (normalized === 'agy') {
    // --add-dir is mandatory: without it agy edits its own scratch folder.
    // The headless note is mandatory too: with every auto-approve flag on,
    // gemini still stops to ask "may I edit?" and exits 0 having changed
    // nothing (verified on 3.7 and 3.8, 2026-09-04). One line fixes it.
    return realEngineAdapter('agy', ENGINE_BINS.agy, (promptText, workspaceDir) => [
      '--mode',
      'accept-edits',
      '--dangerously-skip-permissions',
      '--add-dir',
      workspaceDir,
      ...(model ? ['--model', model] : []),
      '-p',
      `${AGY_HEADLESS_NOTE}\n\n${promptText}`,
    ]);
  }
  if (normalized === 'opencode') {
    return realEngineAdapter('opencode', ENGINE_BINS.opencode, (promptText) => [
      'run',
      '--auto',
      ...(model ? ['-m', model] : []),
      promptText,
    ]);
  }
  if (normalized === 'devin') {
    return realEngineAdapter('devin', ENGINE_BINS.devin, (promptText) => [
      '-p',
      '--permission-mode',
      'dangerous',
      ...(model ? ['--model', model] : []),
      '--',
      promptText,
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
  AGY_HEADLESS_NOTE,
  ENGINE_NAMES,
  getEngineAdapter,
  normalizeEngineName,
};
