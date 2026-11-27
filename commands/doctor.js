'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { findWorkspaceRoot } = require('../lib/workspace-root');
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
  return findWorkspaceRoot(cwd);
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
  const m = payload.members;
  // Same rule as the boot screen: a folder is set up when it has an atris/ folder.
  const setUp = fs.existsSync(path.join(payload.workspace_root, 'atris'));
  const problems = [];
  if (!payload.task_support) problems.push(`install node ${TASK_NODE_MAJOR} or newer  (atris tasks need it)`);
  if (!payload.cli_runnable) problems.push('npm install -g atris  (reinstall atris; a program file is missing)');
  if (!payload.bin.shim) problems.push('npm install -g atris  (reinstall atris; its startup file is damaged)');
  if (!payload.auth.signed_in) problems.push('atris login  (sign in)');
  if (!setUp) problems.push('atris init  (set up this folder)');
  if (setUp && m && !m.members) problems.push('atris init  (add a team to this folder)');
  if (m && !m.git_installed) problems.push('install git  (the team works on safe copies with it)');
  else if (m && !m.git_repo) problems.push('git init  (let the team work on copies in this folder)');
  if (m && !m.tools.length && !m.built_in_tool && payload.auth.signed_in) {
    problems.push('install claude code or codex  (the team needs one coding tool)');
  }
  const count = problems.length;
  const lines = [count ? `atris doctor: ${count === 1 ? 'one thing needs' : `${count} things need`} fixing.` : 'atris doctor: this computer is ready.', ''];
  const row = (label, value) => `  ${label.padEnd(14)}${value}`;
  lines.push(row('atris', `v${payload.version}`));
  lines.push(row('node', payload.task_support
    ? `${payload.node.version} (new enough; atris needs ${TASK_NODE_MAJOR} or newer)`
    : `${payload.node.version} (too old; atris needs ${TASK_NODE_MAJOR} or newer; found at ${payload.node.exec_path || 'an unknown path'})`));
  lines.push(row('signed in', payload.auth.signed_in ? (payload.auth.email || 'yes, account unknown') : 'no'));
  lines.push(row('this folder', `${payload.workspace_root} (${setUp ? 'set up' : 'not set up'})`));
  if (m) {
    const tools = m.tools.concat(m.built_in_tool ? ['built-in'] : []);
    lines.push(row('team', m.members ? `${m.members} member${m.members === 1 ? '' : 's'}` : 'none'));
    lines.push(row('git', !m.git_installed ? 'not installed' : (m.git_repo ? 'yes' : 'installed; this folder has no git history')));
    lines.push(row('coding tools', tools.length ? tools.join(', ') : 'none'));
  }
  if (!payload.cli_runnable) lines.push(row('atris files', 'the program file is missing'));
  if (!payload.bin.shim) lines.push(row('startup file', `${payload.bin.public_bin} is missing or unexpected (${payload.bin.shim_bytes === null ? 'size unknown' : `${payload.bin.shim_bytes} bytes`})`));
  if (payload.warnings && payload.warnings.length) {
    for (const warning of payload.warnings) {
      const plain = warning.replace('cli install is a dirty git checkout', 'the installed atris copy has unsaved changes').replace('cli install is a detached git checkout', 'the installed atris copy is not on a named branch');
      lines.push(row('note', plain));
    }
  }
  if (count) lines.push('', `fix: ${problems[0]}`);
  return lines.join('\n');
}

// --live: one real model turn on the first installed coding tool, checked
// for the exact reply. Proof that setup ended with something that can work.
const LIVE_REPLY = 'ATRIS LIVE OK';
const LIVE_ENGINES = ['claude', 'codex'];
const LIVE_TIMEOUT_MS = 120000;

async function runLiveCheck(options = {}) {
  const root = detectWorkspaceRoot(options.cwd || process.cwd());
  const probe = options.binInstalled || require('../lib/engine-registry').binInstalled;
  const ask = require('../lib/engine-ask');
  const runAsk = options.runAsk || ask.runAskProcess;
  const engine = LIVE_ENGINES.find((bin) => probe(bin)) || null;
  const result = { ok: false, action: 'doctor_live', at: new Date().toISOString(), engine, model: null, requested_model: null, seconds: null, expected: LIVE_REPLY, reply: null, error: null };
  if (!engine) {
    result.error = 'no coding tool found. install claude code or codex, sign in to it, then run atris doctor --live again.';
  } else {
    const invocation = ask.buildReadOnlyEngineInvocation(engine, `Reply with exactly: ${LIVE_REPLY}`, '', {
      timeoutMs: LIVE_TIMEOUT_MS,
      context: engine === 'claude' ? 'light' : '',
    });
    const ran = await runAsk(invocation, { cwd: root, timeoutMs: LIVE_TIMEOUT_MS });
    const flag = invocation.args.indexOf('--model');
    // model is only what the tool says ran; what we asked for is kept apart.
    result.requested_model = flag >= 0 ? invocation.args[flag + 1] : null;
    result.model = ran.model_ran || null;
    result.seconds = Math.round((ran.duration_ms || 0) / 100) / 10;
    result.reply = String(ran.stdout || '').trim();
    result.ok = Boolean(ran.ok) && result.reply === LIVE_REPLY;
    if (!ran.ok) {
      const said = `${ran.stderr || ''}\n${ran.stdout || ''}`.trim();
      result.error = `${ran.timed_out ? 'no answer in time' : ran.reason}${said ? `: ${said.slice(-2000)}` : ''}`;
    } else if (!result.ok) {
      result.error = `replied "${result.reply.slice(0, 300)}" instead of "${LIVE_REPLY}"`;
    }
  }
  try {
    const receipt = path.join(root, '.atris', 'state', 'doctor-live.json');
    fs.mkdirSync(path.dirname(receipt), { recursive: true });
    fs.writeFileSync(receipt, `${JSON.stringify(result, null, 2)}\n`);
    result.receipt = receipt;
  } catch (error) {
    result.receipt = null;
    result.receipt_error = error.message;
  }
  return result;
}

function renderLive(result) {
  const model = result.model || (result.requested_model ? `asked for ${result.requested_model}` : '');
  const tool = result.engine ? ` with ${result.engine}${model ? ` (${model})` : ''}` : '';
  return result.ok
    ? `atris doctor --live: passed in ${result.seconds} seconds${tool}.`
    : `atris doctor --live: failed${tool}. ${result.error}`;
}

function doctorCommand(args = [], options = {}) {
  if (args.includes('--help') || args.includes('-h') || args[0] === 'help') {
    console.log('Usage: atris doctor [--live] [--json]');
    console.log('');
    console.log('Checks that this computer is ready: a new enough node, a working atris install,');
    console.log('whether you are signed in and whether this folder is set up.');
    console.log('Also checks what the team needs: members, git and a coding tool.');
    console.log('--live asks the first installed coding tool (claude, else codex) for one exact');
    console.log('reply and saves the result in .atris/state/doctor-live.json.');
    console.log('--json prints the same facts for scripts.');
    return 0;
  }
  // Only --live waits on a model, so only it returns a promise.
  if (args.includes('--live')) {
    return runLiveCheck(options).then((result) => {
      console.log(args.includes('--json') ? JSON.stringify(result, null, 2) : renderLive(result));
      return result.ok ? 0 : 1;
    });
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
