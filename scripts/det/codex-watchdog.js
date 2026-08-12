#!/usr/bin/env node
'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');

const DEFAULT_STARTUP_DEADLINE_SECONDS = 90;
const DEFAULT_MAX_RUNTIME_SECONDS = 3600;
const USAGE = 'usage: node scripts/det/codex-watchdog.js ' +
  '[--startup-deadline <sec, default 90>] [--max-runtime <sec, default 3600>] -- <command...>';

function positiveSeconds(value, flag) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(`${flag} must be a positive number`);
  }
  return seconds;
}

function parseArgs(argv) {
  let startupDeadlineSeconds = DEFAULT_STARTUP_DEADLINE_SECONDS;
  let maxRuntimeSeconds = DEFAULT_MAX_RUNTIME_SECONDS;
  let index = 0;

  while (index < argv.length && argv[index] !== '--') {
    const flag = argv[index];
    if (flag !== '--startup-deadline' && flag !== '--max-runtime') {
      throw new Error(`unknown option: ${flag}`);
    }
    if (index + 1 >= argv.length || argv[index + 1] === '--') {
      throw new Error(`${flag} needs a value`);
    }
    if (flag === '--startup-deadline') {
      startupDeadlineSeconds = positiveSeconds(argv[index + 1], flag);
    } else {
      maxRuntimeSeconds = positiveSeconds(argv[index + 1], flag);
    }
    index += 2;
  }

  if (argv[index] !== '--' || index + 1 >= argv.length) {
    throw new Error('missing command after --');
  }

  return {
    startupDeadlineSeconds,
    maxRuntimeSeconds,
    command: argv[index + 1],
    commandArgs: argv.slice(index + 2),
  };
}

function killProcessGroup(child) {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch (error) {
    if (error.code === 'ESRCH') return;
    try {
      child.kill('SIGKILL');
    } catch {}
  }
}

function runAttempt(config, remainingRuntimeMs) {
  return new Promise((resolve) => {
    let nullFd;
    let child;
    try {
      nullFd = fs.openSync('/dev/null', 'r');
      child = spawn(config.command, config.commandArgs, {
        detached: true,
        stdio: [nullFd, 'pipe', 'pipe'],
      });
    } catch (error) {
      if (nullFd !== undefined) fs.closeSync(nullFd);
      resolve({ type: 'spawn-error', error });
      return;
    }
    fs.closeSync(nullFd);

    let sawOutput = false;
    let stopReason = null;
    let spawnError = null;

    const markStarted = () => {
      sawOutput = true;
    };
    child.stdout.once('data', markStarted);
    child.stderr.once('data', markStarted);
    child.stdout.pipe(process.stdout, { end: false });
    child.stderr.pipe(process.stderr, { end: false });

    const stop = (reason) => {
      if (stopReason) return;
      stopReason = reason;
      killProcessGroup(child);
    };

    const startupTimer = setTimeout(() => {
      if (!sawOutput) stop('silent-start');
    }, Math.ceil(config.startupDeadlineSeconds * 1000));
    const runtimeTimer = setTimeout(() => {
      stop('max-runtime');
    }, remainingRuntimeMs);

    child.once('error', (error) => {
      spawnError = error;
      if (!stopReason) stopReason = 'spawn-error';
    });
    child.once('close', (code, signal) => {
      clearTimeout(startupTimer);
      clearTimeout(runtimeTimer);
      if (spawnError) {
        resolve({ type: 'spawn-error', error: spawnError });
      } else if (stopReason) {
        resolve({ type: stopReason });
      } else {
        resolve({ type: 'exit', code, signal });
      }
    });
  });
}

async function run(config) {
  const startedAt = Date.now();
  const maxRuntimeMs = Math.ceil(config.maxRuntimeSeconds * 1000);

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const remainingRuntimeMs = maxRuntimeMs - (Date.now() - startedAt);
    if (remainingRuntimeMs <= 0) {
      process.stderr.write(`watchdog: max runtime of ${config.maxRuntimeSeconds}s exceeded\n`);
      return 125;
    }

    const result = await runAttempt(config, remainingRuntimeMs);
    if (result.type === 'silent-start') {
      if (attempt === 1) {
        process.stderr.write(
          `watchdog: silent start after ${config.startupDeadlineSeconds}s, retrying once\n`
        );
        continue;
      }
      process.stderr.write('watchdog: silent start twice, giving up\n');
      return 124;
    }
    if (result.type === 'max-runtime') {
      process.stderr.write(`watchdog: max runtime of ${config.maxRuntimeSeconds}s exceeded\n`);
      return 125;
    }
    if (result.type === 'spawn-error') {
      process.stderr.write(`watchdog: could not start command: ${result.error.message}\n`);
      return 127;
    }
    if (result.code !== null) return result.code;
    if (result.signal) {
      process.kill(process.pid, result.signal);
      return 1;
    }
    return 1;
  }

  return 124;
}

async function main() {
  let config;
  try {
    config = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`watchdog: ${error.message}\n${USAGE}\n`);
    process.exitCode = 2;
    return;
  }
  process.exitCode = await run(config);
}

main();
