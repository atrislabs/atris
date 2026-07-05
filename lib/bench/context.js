'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const PROFILE_ENV_KEYS = [
  'ATRIS_PROFILE',
  'ATRIS_PROFILE_EMAIL',
  'ATRIS_AUTH_PROFILE',
  'ATRIS_ACTIVE_PROFILE',
  'ATRIS_ACCOUNT',
  'ATRIS_ACCOUNT_ID',
  'ATRIS_BUSINESS_ID',
  'ATRIS_BUSINESS_SLUG',
  'ATRIS_OWNER_ID',
  'ATRIS_OWNER_SLUG',
  'AX_PROFILE',
  'AX_ACCOUNT',
];

function defaultRepoRoot() {
  return path.resolve(__dirname, '..', '..');
}

function hermeticEnv(home, extra = {}) {
  const env = { ...process.env };
  for (const key of PROFILE_ENV_KEYS) env[key] = '';
  env.HOME = home;
  env.USERPROFILE = home;
  env.XDG_CONFIG_HOME = path.join(home, '.config');
  env.XDG_CACHE_HOME = path.join(home, '.cache');
  env.XDG_DATA_HOME = path.join(home, '.local', 'share');
  env.ATRIS_SKIP_UPDATE_CHECK = '1';
  env.NO_UPDATE_NOTIFIER = '1';
  env.NODE_NO_WARNINGS = '1';
  env.ATRIS_AGENT_PROOF_ONLY = '0';
  env.ATRIS_TASKS_DB = path.join(home, '.atris', 'tasks.db');
  env.ATRIS_AGENT_ID = env.ATRIS_AGENT_ID || 'bench';
  return { ...env, ...extra };
}

function spawnErrorFromResult(result, command) {
  const source = result && result.error ? result.error : new Error(`failed to spawn ${command}`);
  const err = new Error(source.message || `failed to spawn ${command}`);
  err.name = source.name || err.name;
  err.code = source.code || 'SPAWN_ERROR';
  err.errno = source.errno;
  err.syscall = source.syscall || `spawn ${command}`;
  err.path = source.path || command;
  err.spawnError = true;
  err.result = result;
  return err;
}

function createBenchContext(options = {}) {
  const repoRoot = path.resolve(options.repoRoot || defaultRepoRoot());
  const cliPath = options.cliPath || path.join(repoRoot, 'bin', 'atris.js');
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), `atris-bench-${options.taskId || 'task'}-`));
  const home = path.join(tempRoot, 'home');
  const workspace = path.join(tempRoot, 'workspace');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  const env = hermeticEnv(home, options.env || {});
  const defaultTimeout = Number(options.timeoutMs || 30000);

  const ctx = {
    repoRoot,
    cliPath,
    workspace,
    runCli(args = [], runOptions = {}) {
      const result = spawnSync(process.execPath, [cliPath, ...args], {
        cwd: workspace,
        input: runOptions.input,
        encoding: 'utf8',
        timeout: Number(runOptions.timeoutMs || runOptions.timeout || defaultTimeout),
        maxBuffer: Number(runOptions.maxBuffer || 16 * 1024 * 1024),
        env: {
          ...env,
          ...(runOptions.env || {}),
        },
      });
      if (result.error) throw spawnErrorFromResult(result, process.execPath);
      return result;
    },
    requireCmd(command, args = ['--version']) {
      const result = spawnSync(command, args, {
        cwd: workspace,
        encoding: 'utf8',
        timeout: 5000,
        env,
      });
      if (result.error || result.status !== 0) {
        const err = result.error
          ? spawnErrorFromResult(result, command)
          : new Error(`${command} exited ${result.status}`);
        err.code = err.code || 'COMMAND_UNAVAILABLE';
        err.command = command;
        throw err;
      }
      return command;
    },
  };

  return {
    ctx,
    teardown() {
      fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    },
  };
}

async function withBenchContext(options, fn) {
  const { ctx, teardown } = createBenchContext(options);
  try {
    return await fn(ctx);
  } finally {
    teardown();
  }
}

module.exports = {
  PROFILE_ENV_KEYS,
  createBenchContext,
  hermeticEnv,
  withBenchContext,
};
