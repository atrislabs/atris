'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const TASK_NODE_MAJOR = 22;

function parseNodeVersion(raw = process.version) {
  const match = String(raw || '').match(/v?(\d+)\.(\d+)\.(\d+)/);
  if (!match) return { raw: String(raw || ''), major: 0, minor: 0, patch: 0 };
  return {
    raw: String(raw || ''),
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

function detectWorkspaceRoot(cwd = process.cwd()) {
  let current = path.resolve(cwd);
  for (;;) {
    if (fs.existsSync(path.join(current, 'atris', 'atris.md'))
      || fs.existsSync(path.join(current, '.atris'))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(cwd);
    current = parent;
  }
}

function authState() {
  try {
    const { loadCredentials } = require('../utils/auth');
    const creds = loadCredentials();
    if (!creds) return { signed_in: false, email: null, source: null };
    return {
      signed_in: true,
      email: creds.email || null,
      source: process.env.ATRIS_TOKEN ? 'env' : (process.env.ATRIS_PROFILE ? 'profile' : 'credentials'),
    };
  } catch {
    return { signed_in: false, email: null, source: null };
  }
}

function publicBinInfo() {
  const shimPath = path.join(__dirname, '..', 'bin', 'atris');
  const entryPath = path.join(__dirname, '..', 'bin', 'atris.js');
  let shimBytes = null;
  try { shimBytes = fs.statSync(shimPath).size; } catch { shimBytes = null; }
  let entryBytes = null;
  try { entryBytes = fs.statSync(entryPath).size; } catch { entryBytes = null; }
  return {
    public_bin: 'bin/atris',
    shim: Boolean(shimBytes != null && shimBytes < 2048),
    shim_bytes: shimBytes,
    entry: 'bin/atris.js',
    entry_bytes: entryBytes,
    note: 'public bin is a tiny POSIX shim that execs node on bin/atris.js',
  };
}

function collectDoctor(options = {}) {
  const node = parseNodeVersion(options.nodeVersion || process.version);
  const workspace_root = detectWorkspaceRoot(options.cwd || process.cwd());
  const task_support = node.major >= TASK_NODE_MAJOR;
  const auth = authState();
  const bin = publicBinInfo();
  const cli_runnable = Boolean(process.execPath) && fs.existsSync(path.join(__dirname, '..', 'bin', 'atris.js'));
  return {
    ok: true,
    action: 'doctor',
    node: {
      version: node.raw.startsWith('v') ? node.raw : `v${node.raw}`,
      major: node.major,
      minor: node.minor,
      patch: node.patch,
      exec_path: process.execPath || null,
    },
    task_support,
    task_support_requires: `node ${TASK_NODE_MAJOR}+`,
    auth,
    workspace_root,
    home: os.homedir(),
    cli_runnable,
    bin,
  };
}

function renderDoctor(payload) {
  const lines = [];
  lines.push('atris doctor');
  lines.push('');
  lines.push(`node: ${payload.node.version} (${payload.node.exec_path || 'unknown'})`);
  lines.push(`task support (22+): ${payload.task_support ? 'yes' : 'no'}`);
  lines.push(`auth: ${payload.auth.signed_in ? `signed in as ${payload.auth.email || 'unknown'}` : 'signed out'}`);
  lines.push(`workspace: ${payload.workspace_root}`);
  lines.push(`cli runnable: ${payload.cli_runnable ? 'yes' : 'no'}`);
  lines.push(`public bin: ${payload.bin.public_bin} (${payload.bin.shim ? `${payload.bin.shim_bytes} byte shim` : 'not a shim'})`);
  if (!payload.task_support) {
    lines.push('');
    lines.push(`install Node ${TASK_NODE_MAJOR}+ before running atris task.`);
  }
  return lines.join('\n');
}

function doctorCommand(args = [], options = {}) {
  if (args.includes('--help') || args.includes('-h') || args[0] === 'help') {
    console.log('Usage: atris doctor [--json]');
    console.log('');
    console.log('Reports node version, task-support (22+), auth, workspace root, and whether the CLI can run.');
    console.log('Public install entry is bin/atris (tiny POSIX shim) -> bin/atris.js.');
    return 0;
  }
  const payload = collectDoctor(options);
  if (args.includes('--json')) {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    console.log(renderDoctor(payload));
  }
  return payload.cli_runnable && payload.task_support ? 0 : 1;
}

module.exports = {
  TASK_NODE_MAJOR,
  collectDoctor,
  doctorCommand,
  parseNodeVersion,
  renderDoctor,
};
