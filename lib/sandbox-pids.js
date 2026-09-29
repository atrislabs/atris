'use strict';

// Find every process a sealed run may have left behind: members of its
// process group, holders of its lease file, and anything whose cwd sits in its
// worktree. Each lsof scan walks the whole process table (about 300 to 500ms on
// a busy mac), and the reaper repeats the sweep six times per sealed run, so
// the three scans run side by side instead of one after another. They run from
// "/" so a scan never finds its own siblings through the worktree cwd.

const { spawn, spawnSync } = require('node:child_process');

function sandboxPidQueries({ pgid, leaseFile, cwd }) {
  const queries = [];
  const group = Number(pgid);
  if (Number.isInteger(group) && group > 0) queries.push(['/usr/bin/pgrep', ['-g', String(group)]]);
  queries.push(['/usr/sbin/lsof', ['-t', String(leaseFile)]]);
  if (cwd) queries.push(['/usr/sbin/lsof', ['-a', '-d', 'cwd', '+D', String(cwd), '-t']]);
  return queries;
}

function collectPids(outputs, excluded) {
  const pids = new Set();
  for (const output of outputs) {
    for (const value of String(output || '').trim().split(/\s+/)) {
      const pid = Number(value);
      if (Number.isInteger(pid) && pid > 0) pids.add(pid);
    }
  }
  for (const pid of excluded) pids.delete(pid);
  return [...pids];
}

// pgrep and lsof both exit 1 when nothing matches. Anything else (another
// status, a signal, a spawn error, no stdout pipe) means the scan did not run,
// which is not the same as finding nothing.
function runScan(bin, argv) {
  return new Promise((resolve) => {
    let stdout = '';
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      resolve({ ok, stdout: ok ? stdout : '' });
    };
    let child;
    try {
      child = spawn(bin, argv, { cwd: '/', stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      finish(false);
      return;
    }
    child.once('error', () => finish(false));
    if (!child.stdout) {
      finish(false);
      return;
    }
    child.stdout.on('error', () => finish(false));
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.once('close', (status, signal) => finish(!signal && (status === 0 || status === 1)));
  });
}

function sequentialOutputs(query) {
  return sandboxPidQueries(query).map(([bin, argv]) => {
    try {
      return spawnSync(bin, argv, { cwd: '/', encoding: 'utf8' }).stdout;
    } catch {
      return '';
    }
  });
}

// If any side-by-side scan fails, run the whole sweep again one by one and
// keep every pid either pass saw.
async function trackedSandboxPids(query, { excluded = [process.pid], scan = runScan } = {}) {
  const scans = await Promise.all(sandboxPidQueries(query).map(([bin, argv]) => scan(bin, argv)));
  const outputs = scans.map((result) => result.stdout);
  if (scans.some((result) => !result.ok)) outputs.push(...sequentialOutputs(query));
  return collectPids(outputs, excluded);
}

// Synchronous callers get the same parallel sweep through one short node
// helper. If the helper cannot answer, fall back to the one-by-one sweep so
// the reaper never runs blind.
function trackedSandboxPidsSync(query) {
  const excluded = [process.pid];
  const helper = spawnSync(process.execPath, [__filename, JSON.stringify(query)], {
    cwd: '/',
    encoding: 'utf8',
  });
  if (helper.status === 0) {
    try {
      const parsed = JSON.parse(helper.stdout);
      if (Array.isArray(parsed)) {
        return collectPids([parsed.join(' ')], [...excluded, helper.pid]);
      }
    } catch {}
  }
  return collectPids(sequentialOutputs(query), excluded);
}

if (require.main === module) {
  trackedSandboxPids(JSON.parse(process.argv[2] || '{}'))
    .then((pids) => { process.stdout.write(JSON.stringify(pids) + '\n'); })
    .catch(() => { process.exitCode = 1; });
}

module.exports = {
  runScan,
  trackedSandboxPids,
  trackedSandboxPidsSync,
};
