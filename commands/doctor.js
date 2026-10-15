'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  inspectInstallGitState,
  formatCliVersionLine,
  isGitCheckout,
} = require('../utils/update-check');

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

function readCliVersion(packageRoot) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
    return typeof pkg.version === 'string' ? pkg.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

function installWarnings(packageRoot) {
  const warnings = [];
  if (!isGitCheckout(packageRoot)) return warnings;
  const state = inspectInstallGitState(packageRoot);
  if (state.dirty) {
    warnings.push(`cli install is a dirty git checkout (${state.branch || 'detached'} @ ${state.head || 'unknown'})`);
  } else if (state.detached) {
    warnings.push(`cli install is a detached git checkout (@ ${state.head || 'unknown'})`);
  }
  return warnings;
}

// Outside coding tools a member can run on. The built-in tool (ax) ships
// with atris and only needs a sign-in, so it is counted through auth.
const MEMBER_TOOL_BINS = ['claude', 'codex', 'cursor-agent', 'opencode', 'devin', 'grok', 'agy'];

function teamMembers(workspaceRoot) {
  const teamDir = path.join(workspaceRoot, 'atris', 'team');
  let entries = [];
  try { entries = fs.readdirSync(teamDir, { withFileTypes: true }); } catch { return []; }
  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('_'))
    .filter((entry) => fs.existsSync(path.join(teamDir, entry.name, 'MEMBER.md')))
    .map((entry) => entry.name)
    .sort();
}

// What a member run needs before it can start: someone on the team, git for
// its own copy of the work, and a coding tool to think with. One fix line
// names the first missing piece.
function memberReadiness(workspaceRoot, auth, probe) {
  const members = teamMembers(workspaceRoot);
  const git_installed = probe('git');
  const git_repo = fs.existsSync(path.join(workspaceRoot, '.git'));
  const tools = MEMBER_TOOL_BINS.filter((bin) => probe(bin));
  const built_in_tool = Boolean(auth && auth.signed_in);
  const has_tool = tools.length > 0 || built_in_tool;
  let next = null;
  if (!members.length) next = 'run atris init to add a team to this folder.';
  else if (!git_installed) next = 'install git so members can work on their own copy.';
  else if (!git_repo) next = 'run git init here so members can work on their own copy.';
  else if (!has_tool) next = 'install claude code or codex, or run atris login to use the built-in tool.';
  return {
    ready: next === null,
    members: members.length,
    member_names: members,
    git_installed,
    git_repo,
    tools,
    built_in_tool,
    next,
  };
}

function collectDoctor(options = {}) {
  const packageRoot = options.packageRoot || path.join(__dirname, '..');
  const node = parseNodeVersion(options.nodeVersion || process.version);
  const workspace_root = detectWorkspaceRoot(options.cwd || process.cwd());
  const task_support = node.major >= TASK_NODE_MAJOR;
  const auth = authState();
  const bin = publicBinInfo();
  const cli_runnable = Boolean(process.execPath) && fs.existsSync(path.join(packageRoot, 'bin', 'atris.js'));
  const version = readCliVersion(packageRoot);
  const version_line = formatCliVersionLine(version, packageRoot);
  const install_git = inspectInstallGitState(packageRoot);
  const warnings = installWarnings(packageRoot);
  const probe = options.binInstalled || require('../lib/engine-registry').binInstalled;
  const members = memberReadiness(workspace_root, auth, probe);
  return {
    ok: true,
    action: 'doctor',
    version,
    version_line,
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
    install_git: {
      is_git_repo: Boolean(install_git.isGitRepo),
      dirty: Boolean(install_git.dirty),
      branch: install_git.branch || null,
      head: install_git.head || null,
    },
    members,
    warnings,
  };
}

function renderDoctor(payload) {
  const lines = [];
  lines.push('atris doctor');
  lines.push('');
  lines.push(`version: ${payload.version_line || payload.version}`);
  lines.push(`node: ${payload.node.version} (${payload.node.exec_path || 'unknown'})`);
  lines.push(`task support (22+): ${payload.task_support ? 'yes' : 'no'}`);
  lines.push(`auth: ${payload.auth.signed_in ? `signed in as ${payload.auth.email || 'unknown'}` : 'signed out'}`);
  lines.push(`workspace: ${payload.workspace_root}`);
  lines.push(`cli runnable: ${payload.cli_runnable ? 'yes' : 'no'}`);
  lines.push(`public bin: ${payload.bin.public_bin} (${payload.bin.shim ? `${payload.bin.shim_bytes} byte shim` : 'not a shim'})`);
  const m = payload.members;
  if (m) {
    const toolNames = m.tools.concat(m.built_in_tool ? ['built-in'] : []);
    lines.push('');
    lines.push(`members: ${m.ready ? 'ready' : 'not ready yet'}`);
    lines.push(`  team: ${m.members ? `${m.members} member${m.members === 1 ? '' : 's'}` : 'none'}`);
    lines.push(`  git: ${!m.git_installed ? 'not installed' : (m.git_repo ? 'yes' : 'installed, but this folder is not a git repo')}`);
    lines.push(`  coding tool: ${toolNames.length ? toolNames.join(', ') : 'none'}`);
    if (m.next) lines.push(`  next: ${m.next}`);
  }
  if (payload.warnings && payload.warnings.length) {
    lines.push('');
    for (const warning of payload.warnings) lines.push(`warning: ${warning}`);
  }
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
    console.log('Also checks what members need: a team, git, and a coding tool.');
    console.log('Public install entry is bin/atris (tiny POSIX shim) -> bin/atris.js.');
    return 0;
  }
  const payload = collectDoctor(options);
  if (args.includes('--json')) {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    console.log(renderDoctor(payload));
  }
  const healthy = payload.cli_runnable && payload.task_support;
  return healthy ? 0 : 1;
}

module.exports = {
  doctorCommand,
  collectDoctor,
  renderDoctor,
};
