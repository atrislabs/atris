'use strict';

// atris scorecard: which AI can do this team's work, measured on the team's
// own past changes.
//
// Finding tasks needs no AI. A past change that touched code and tests
// becomes a task when its tests fail on the change's parent and pass on the
// change itself. The ask is what the team wrote for that change.
//
// Each try starts from the parent in a throwaway clone with no remote and
// none of the repo's branches, stash or config, and every push from it is
// pointed at an address that cannot work. Every `claude` run uses the
// person's own plan login: pay-per-use keys and cloud billing switches are
// removed first, and a run refuses to start without a plan login. The
// change's own tests, which the AI never sees, grade the try.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');
const { checkClaudeSpend } = require('./claude-spend-guard');
const { claudeModelId } = require('./model-names');
const { DEFAULT_CLAUDE_RUNNER_MODEL } = require('./runner-command');

const DEFAULT_MODELS = Object.freeze([DEFAULT_CLAUDE_RUNNER_MODEL]);
const SCAN = 300;
const MAX_TASKS = 12;
// A change bigger than this is a project, not a task one ask can carry.
const MAX_FILES = 20;
const MAX_LINES = 1500;
const MAX_ASK = 2000;
const TEST_TIMEOUT_MS = 5 * 60 * 1000;
// Finding tasks checks many changes, so a test that hangs costs less there.
const FIND_TIMEOUT_MS = 2 * 60 * 1000;
// Opus and Fable work slower and finish real tasks given 20 minutes; the rest
// finish inside 10 (measured on the Atris loop bench, 2026-10-28).
const SLOW_MODELS = /opus|fable/i;
const LINK_NAMES = Object.freeze(['venv', '.venv', 'node_modules']);
// A plan that has run out stops every later try the same way, so the run
// stops instead of marking the rest as errors.
const OUT_OF_PLAN = /usage limit|rate limit|limit reached|out of extra usage|credit balance/i;

// Any of these in a child's environment can bill someone: a pay-per-use key,
// a cloud provider login, or a switch that moves `claude` off the plan login.
const PAID_KEY = /(^|_)(API_KEY|SECRET_ACCESS_KEY|SESSION_TOKEN|BEARER_TOKEN|ACCESS_KEY|AUTH_TOKEN)$|^(ANTHROPIC|OPENAI|AZURE_OPENAI|OPENROUTER|XAI|GROK|GEMINI|GOOGLE_API|MISTRAL|COHERE|TOGETHER|GROQ|DEEPSEEK|FIREWORKS|PERPLEXITY|REPLICATE|ELEVENLABS|EXA|FIRECRAWL|AWS)_/;
const BILLING_SWITCHES = Object.freeze(['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY',
  'GH_TOKEN', 'GITHUB_TOKEN']);
const REPO_POINTERS = Object.freeze(['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE', 'GIT_PREFIX']);

const PUSH_PREFIXES = Object.freeze(['https://', 'http://', 'ssh://', 'git@', 'file://', '/']);
const ENGINE_DENY = Object.freeze(['Bash(git push:*)', 'Bash(gh:*)', 'Bash(pip install:*)', 'Bash(pip3 install:*)',
  'Bash(python -m pip install:*)', 'Bash(python3 -m pip install:*)', 'Bash(uv pip install:*)',
  'Bash(npm install:*)', 'Bash(npm i:*)', 'Bash(npm publish:*)', 'Bash(pnpm add:*)', 'Bash(yarn add:*)']);

// The work prompt the Atris loop bench kept after 12 rounds of measured
// changes (its recipe-8), with the ask in front.
const WORK_PROMPT = `{ask}

You are working in a fresh checkout of this repo. Make the change, check it with the repo's own tests, and stop when it works. Do not commit or push.

Work in this order:

1. Turn the request into a short checklist. List every route, function, flag, field, output line, error message, status code and ordering it names. Tests you cannot see will check this work.
2. Find code nearby that already does the same kind of thing and read its tests. Match its pattern, its order of checks and its error messages. Use the same helpers it uses for lookups, auth, ids, time, subprocesses and rollback, so tests that fake those helpers still control your code.
3. If the code already looks correct, reproduce the reported problem under the condition the request describes before you decide nothing needs to change.
4. Make the core change early, then refine it. Do not spend most of your time reading.
5. When the change adds an access or permission check, put it on every route or action the request names. Run it before input validation, lookups or any other work, so a caller without access learns nothing. Callers who were allowed before must get exactly the same result as before.
6. Run only the test files for the code you touched, not the whole suite. Check each checklist item, including the success path and any existing behavior the request says should stay as it is.
7. Before you stop, look at the full diff. Undo changes to files you did not mean to touch. Confirm the diff covers every checklist item.
`;

// ---- small helpers --------------------------------------------------------

function withoutRepoPointers(env) {
  const out = { ...env };
  for (const name of REPO_POINTERS) delete out[name];
  return out;
}

function git(args, cwd) {
  return execFileSync('git', args, {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024,
    env: withoutRepoPointers(process.env),
  }).trim();
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function repoRoot(cwd = process.cwd()) {
  return git(['rev-parse', '--show-toplevel'], cwd);
}

// The repo's own name and folder, the same from any of its worktrees.
function repoHome(root) {
  let common = '';
  try { common = path.resolve(root, git(['rev-parse', '--git-common-dir'], root)); } catch {}
  return common && path.basename(common) === '.git' ? path.dirname(common) : path.resolve(root);
}

function repoName(root) {
  return path.basename(repoHome(root));
}

function repoSlug(root) {
  const home = repoHome(root);
  const hash = crypto.createHash('sha1').update(home).digest('hex').slice(0, 8);
  return `${path.basename(home).replace(/[^a-zA-Z0-9._-]/g, '-')}-${hash}`;
}

function storeDir(root, env = process.env) {
  return path.join(env.HOME || os.homedir(), '.atris', 'scorecard', repoSlug(root));
}

function workDir(root) {
  return path.join(os.tmpdir(), 'atris-scorecard', `${repoSlug(root)}-${process.pid}`);
}

function minutesFor(model, override) {
  if (Number(override) > 0) return Number(override);
  return SLOW_MODELS.test(String(model)) ? 20 : 10;
}

function normalizeModels(list) {
  const raw = Array.isArray(list) ? list : String(list || '').split(',');
  const models = raw.map((m) => claudeModelId(String(m).trim())).filter(Boolean);
  return models.length ? [...new Set(models)] : [...DEFAULT_MODELS];
}

// The full path of an executable on PATH, so a `claude` that a repo installs
// into its own node_modules or venv is never the one that runs.
function findBin(name, env = process.env) {
  if (name.includes('/')) return name;
  for (const dir of String(env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {}
  }
  return null;
}

// ---- environments ---------------------------------------------------------

// A copy of env with every billing key and switch removed. Unlike the spend
// guard's claudeChildEnv, no override keeps the key: a scorecard runs on the
// plan login or not at all.
function stripBilling(env = process.env) {
  const out = {};
  for (const [name, value] of Object.entries(env)) {
    if (PAID_KEY.test(name) || BILLING_SWITCHES.includes(name) || REPO_POINTERS.includes(name)) continue;
    out[name] = value;
  }
  return out;
}

function testEnv(copyDir, env = process.env, extra = {}) {
  const out = stripBilling(env);
  delete out.VIRTUAL_ENV;
  delete out.NODE_TEST_CONTEXT;
  const bins = ['venv', '.venv'].map((name) => path.join(copyDir, name, 'bin')).filter((dir) => fs.existsSync(dir));
  const nodeBin = path.join(copyDir, 'node_modules', '.bin');
  if (fs.existsSync(nodeBin)) bins.push(nodeBin);
  out.PATH = [...bins, out.PATH || ''].filter(Boolean).join(path.delimiter);
  out.CI = '1';
  out.ATRIS_NO_UPDATE_CHECK = '1';
  out.ATRIS_SKIP_UPDATE_CHECK = '1';
  for (const [name, value] of Object.entries(extra || {})) {
    if (!PAID_KEY.test(name) && !BILLING_SWITCHES.includes(name)) out[name] = String(value);
  }
  return out;
}

// The engine's environment: the test environment with the task's test
// settings, so its own test runs work, plus every push URL rewritten to one
// that cannot work and no GitHub login.
function engineEnv(copyDir, scratch, env = process.env, extra = {}) {
  const out = testEnv(copyDir, env, extra);
  out.GIT_TERMINAL_PROMPT = '0';
  out.GH_CONFIG_DIR = path.join(scratch, '.no-gh');
  out.GIT_CONFIG_COUNT = String(PUSH_PREFIXES.length);
  PUSH_PREFIXES.forEach((prefix, n) => {
    out[`GIT_CONFIG_KEY_${n}`] = 'url.no-push://atris-scorecard-blocked/.pushInsteadOf';
    out[`GIT_CONFIG_VALUE_${n}`] = prefix;
  });
  return out;
}

// The Claude Code login this computer would use. Returns
// { ok, plan, extraUsage, message }.
function planLogin(env = process.env) {
  if (env.CLAUDE_CODE_OAUTH_TOKEN) return { ok: true, plan: 'Claude plan', extraUsage: false };
  const file = path.join(env.HOME || os.homedir(), '.claude.json');
  let account = null;
  try {
    account = JSON.parse(fs.readFileSync(file, 'utf8')).oauthAccount || null;
  } catch {}
  if (!account || !account.accountUuid) {
    return {
      ok: false,
      message: 'atris scorecard runs on your Claude plan login and never on an API key. '
        + 'log in first: run `claude`, then /login with your Claude account.',
    };
  }
  const kind = String(account.organizationType || '').replace(/^claude_/, '').replace(/_/g, ' ').trim();
  return { ok: true, plan: kind ? `Claude ${kind} plan` : 'Claude plan', extraUsage: account.hasExtraUsageEnabled === true };
}

// ---- finding tasks --------------------------------------------------------

const CODE_FILE = /\.(py|m?[jt]sx?|cjs)$/i;
const TEST_DIR = /(^|\/)(tests?|__tests__|spec)\//i;
const PY_TEST = /(^|\/)(test_[^/]*|[^/]*_test)\.py$/i;
const JS_TEST = /\.(test|spec)\.(m?[jt]sx?|cjs)$/i;
const HELPER_DIR = /(^|\/)(fixtures?|helpers?|__fixtures__|__mocks__|support|utils?|data)\//i;

function isTestPath(file) {
  return TEST_DIR.test(file) || PY_TEST.test(file) || JS_TEST.test(file);
}

function isRunnableTest(file) {
  if (PY_TEST.test(file) || JS_TEST.test(file)) return true;
  return TEST_DIR.test(file) && /\.(m?js|cjs)$/i.test(file) && !HELPER_DIR.test(file);
}

// name-status lines -> { hidden, runnable, source, deletedTest }. Every test
// path the change touched is hidden from the AI and put back for grading;
// only real test files go to the test runner.
function classifyChange(lines) {
  const hidden = [];
  const runnable = [];
  const source = [];
  let deletedTest = false;
  for (const line of lines) {
    const parts = String(line).split('\t');
    const status = parts[0] || '';
    const files = status.startsWith('R') || status.startsWith('C') ? parts.slice(1) : [parts[1]];
    for (let i = 0; i < files.length; i += 1) {
      const file = files[i];
      if (!file) continue;
      const removed = status === 'D' || (status.startsWith('R') && i === 0);
      if (isTestPath(file)) {
        if (removed) { deletedTest = true; continue; }
        if (!hidden.includes(file)) hidden.push(file);
        if (isRunnableTest(file) && !runnable.includes(file)) runnable.push(file);
      } else if (CODE_FILE.test(file) && !removed) {
        source.push(file);
      }
    }
  }
  return { hidden, runnable, source, deletedTest };
}

function cleanMessage(text) {
  return String(text || '').split('\n')
    .filter((line) => !/^\s*(co-authored-by|signed-off-by|reviewed-by|change-id)\s*:/i.test(line))
    .filter((line) => !/^\s*(🤖 )?generated with \[?claude code/i.test(line))
    .filter((line) => !/^\s*merge (pull request|branch|remote-tracking branch)\b/i.test(line))
    .join('\n')
    .replace(/\s*\(#\d+\)/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function wordCount(text) {
  return String(text || '').split(/\s+/).filter(Boolean).length;
}

// What the team wrote for a change. A merged pull request is its title plus
// the messages of the commits it brought in, oldest first.
function askFor(root, change) {
  const own = cleanMessage(change.body);
  if (!change.merge) return own.slice(0, MAX_ASK);
  const raw = git(['log', '--no-merges', '--reverse', '--format=%B%x1e', '-n10', `${change.base}..${change.fix}`], root);
  const messages = raw.split('\x1e').map(cleanMessage).filter(Boolean);
  const title = own.split('\n')[0].trim();
  // A commit that opens with the pull request's title already carries it.
  const parts = own && !messages.some((message) => message.split('\n')[0].trim() === title) ? [own] : [];
  for (const message of messages) {
    if (!parts.includes(message)) parts.push(message);
  }
  return parts.join('\n\n').slice(0, MAX_ASK).trim();
}

// Past changes on the current branch, newest first: one per first-parent
// commit, so a merged pull request is one change.
function listChanges(root, scan = SCAN) {
  const raw = git(['log', '--first-parent', `-n${scan}`, '--format=%H%x00%P%x00%B%x1e', 'HEAD'], root);
  const out = [];
  for (const record of raw.split('\x1e')) {
    const [sha, parents, body] = record.replace(/^\s+/, '').split('\x00');
    if (!sha || !parents) continue;
    const parentList = parents.trim().split(/\s+/).filter(Boolean);
    if (!parentList.length) continue;
    out.push({ fix: sha.trim(), base: parentList[0], body: body || '', merge: parentList.length > 1 });
  }
  return out;
}

const PY_MARKERS = Object.freeze(['pyproject.toml', 'setup.py', 'setup.cfg', 'pytest.ini', 'tox.ini', 'requirements.txt']);

// The nearest folder above file that holds one of markers, '' for the repo root.
function projectDir(root, file, markers) {
  let dir = path.posix.dirname(file);
  for (;;) {
    const here = dir === '.' ? '' : dir;
    if (markers.some((name) => fs.existsSync(path.join(root, here, name)))) return here;
    if (!here) return '';
    dir = path.posix.dirname(dir);
  }
}

function readConfig(root, configPath) {
  const file = configPath ? path.resolve(configPath) : path.join(root, '.atris', 'scorecard.json');
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    if (configPath) throw new Error(`could not read ${file}`);
    return {};
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${file} is not valid json`);
  }
  return parsed && typeof parsed === 'object' ? parsed : {};
}

// How to run a task's tests: the first configured entry whose pattern
// matches every file, else pytest, vitest, jest or node --test from the
// nearest project folder. null when the files need different runners.
function resolveRunner(root, runnable, config = {}) {
  for (const entry of config.tests || []) {
    if (!entry || !entry.cmd) continue;
    let pattern;
    try { pattern = new RegExp(entry.match || '.'); } catch { continue; }
    if (runnable.every((file) => pattern.test(file))) {
      return {
        kind: 'custom',
        dir: String(entry.dir || '').replace(/^\.\/?/, '').replace(/\/$/, ''),
        cmd: String(entry.cmd),
        env: entry.env && typeof entry.env === 'object' ? entry.env : {},
      };
    }
  }
  const py = runnable.filter((file) => file.endsWith('.py'));
  const js = runnable.filter((file) => !file.endsWith('.py'));
  if (!runnable.length || (py.length && js.length)) return null;
  if (py.length) {
    const dirs = [...new Set(py.map((file) => projectDir(root, file, PY_MARKERS)))];
    return dirs.length === 1 ? { kind: 'pytest', dir: dirs[0] } : null;
  }
  const dirs = [...new Set(js.map((file) => projectDir(root, file, ['package.json'])))];
  if (dirs.length !== 1) return null;
  let pkg = {};
  try { pkg = JSON.parse(fs.readFileSync(path.join(root, dirs[0], 'package.json'), 'utf8')); } catch {}
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  if (deps.vitest) return { kind: 'vitest', dir: dirs[0] };
  if (deps.jest) return { kind: 'jest', dir: dirs[0] };
  if (js.some((file) => /\.(c|m)?tsx?$/.test(file))) return null;
  return { kind: 'node', dir: dirs[0] };
}

function pythonFor(copyDir, dir) {
  for (const base of [dir, '']) {
    for (const name of ['venv', '.venv']) {
      const candidate = path.join(copyDir, base || '', name, 'bin', 'python');
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return 'python3';
}

function runnerCommand(runner, files, copyDir) {
  const cwd = path.join(copyDir, runner.dir || '');
  const rel = files.map((file) => (runner.dir ? path.posix.relative(runner.dir, file) : file));
  if (runner.kind === 'custom') {
    const quoted = rel.map(shellQuote).join(' ');
    const cmd = runner.cmd.includes('{files}') ? runner.cmd.split('{files}').join(quoted) : `${runner.cmd} ${quoted}`;
    return { cmd: '/bin/sh', args: ['-c', cmd], cwd };
  }
  if (runner.kind === 'pytest') {
    return { cmd: pythonFor(copyDir, runner.dir), args: ['-m', 'pytest', '-q', '-p', 'no:cacheprovider', ...rel], cwd };
  }
  if (runner.kind === 'vitest') return { cmd: 'npx', args: ['--no-install', 'vitest', 'run', ...rel], cwd };
  if (runner.kind === 'jest') return { cmd: 'npx', args: ['--no-install', 'jest', ...rel], cwd };
  return { cmd: process.execPath, args: ['--test', ...rel], cwd };
}

function runnerLabel(runner) {
  if (!runner) return 'unknown';
  if (runner.kind === 'custom') return 'your test command';
  return runner.kind === 'node' ? 'node --test' : runner.kind;
}

// ---- processes ------------------------------------------------------------

const LIVE = new Set();

function stopAll() {
  for (const child of LIVE) {
    try { process.kill(-child.pid, 'SIGKILL'); } catch {}
  }
  LIVE.clear();
}

// Run one command in its own process group so a time limit stops everything
// it started. With onLine, stdout goes to it line by line instead of being
// kept, and onLine returning 'stop' ends the run. Resolves
// { code, stdout, stderr, timedOut, stopped, ms }.
function runProcess(cmd, args, { cwd, env, input, timeoutMs, onLine }) {
  return new Promise((resolve) => {
    const started = Date.now();
    let stdout = '';
    let stderr = '';
    let pending = '';
    let timedOut = false;
    let stopped = false;
    let child;
    try {
      child = spawn(cmd, args, { cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ code: 127, stdout: '', stderr: String(err.message || err), timedOut: false, ms: 0 });
      return;
    }
    LIVE.add(child);
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    }, Math.max(1000, Number(timeoutMs) || TEST_TIMEOUT_MS));
    const feed = (line) => {
      if (stopped || !line.trim() || onLine(line) !== 'stop') return;
      stopped = true;
      try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    };
    child.stdout.on('data', (chunk) => {
      if (!onLine) {
        stdout += chunk;
        if (stdout.length > 8e6) stdout = stdout.slice(-4e6);
        return;
      }
      pending += chunk;
      let nl = pending.indexOf('\n');
      while (nl >= 0) {
        feed(pending.slice(0, nl));
        pending = pending.slice(nl + 1);
        nl = pending.indexOf('\n');
      }
      if (pending.length > 16e6) pending = '';
    });
    child.stderr.on('data', (chunk) => { stderr += chunk; if (stderr.length > 8e6) stderr = stderr.slice(-4e6); });
    child.on('error', (err) => { stderr += String(err.message || err); });
    child.on('close', (code) => {
      clearTimeout(timer);
      LIVE.delete(child);
      if (onLine) feed(pending);
      resolve({ code: code === null ? 137 : code, stdout, stderr, timedOut, stopped, ms: Date.now() - started });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input === undefined ? '' : String(input));
  });
}

async function runTests(task, copyDir, env = process.env, timeoutMs = TEST_TIMEOUT_MS) {
  const { cmd, args, cwd } = runnerCommand(task.runner, task.runnable, copyDir);
  const res = await runProcess(cmd, args, {
    cwd, env: testEnv(copyDir, env, task.runner.env), timeoutMs,
  });
  const tail = `${res.stdout}\n${res.stderr}`.trim().split('\n').slice(-25).join('\n');
  return { ok: res.code === 0 && !res.timedOut, timedOut: res.timedOut, tail, seconds: Math.round(res.ms / 1000) };
}

// ---- throwaway copies -----------------------------------------------------

function excludeInCopy(dest, paths) {
  if (!paths.length) return;
  const info = path.join(dest, '.git', 'info');
  fs.mkdirSync(info, { recursive: true });
  fs.appendFileSync(path.join(info, 'exclude'), `\n${paths.map((p) => `/${p}`).join('\n')}\n`);
}

function topDirs(root) {
  const dirs = [''];
  try {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.name.startsWith('.') && !LINK_NAMES.includes(entry.name)) dirs.push(entry.name);
    }
  } catch {}
  return dirs;
}

// Installed packages are linked in from the real checkout so tests can
// import them.
function linkInstalled(root, dest) {
  const linked = [];
  for (const dir of topDirs(root)) {
    for (const name of LINK_NAMES) {
      const src = path.join(root, dir, name);
      const dst = path.join(dest, dir, name);
      if (!fs.existsSync(src) || fs.existsSync(dst) || !fs.existsSync(path.dirname(dst))) continue;
      try {
        fs.symlinkSync(src, dst);
        linked.push(path.posix.join(dir, name));
      } catch {}
    }
  }
  excludeInCopy(dest, linked);
  return linked;
}

// .env files hold settings tests may need. Copied only when asked, read-only,
// with every billing key left out.
function copyEnvFiles(root, dest) {
  const copied = [];
  for (const dir of topDirs(root)) {
    const src = path.join(root, dir, '.env');
    const dst = path.join(dest, dir, '.env');
    if (!fs.existsSync(src) || fs.existsSync(dst) || !fs.existsSync(path.dirname(dst))) continue;
    const kept = fs.readFileSync(src, 'utf8').split('\n').filter((line) => {
      const name = line.split('=')[0].replace(/^\s*export\s+/, '').trim();
      return !name || name.startsWith('#') || !(PAID_KEY.test(name) || BILLING_SWITCHES.includes(name));
    });
    fs.writeFileSync(dst, kept.join('\n'), { mode: 0o400 });
    copied.push(path.posix.join(dir, '.env'));
  }
  excludeInCopy(dest, copied);
  return copied;
}

// A clone that borrows the repo's objects but shares none of its branches,
// stash or config, and has no remote.
function makeCopy(root, ref, dest, opts = {}) {
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  git(['clone', '-q', '--shared', '--no-checkout', root, dest], path.dirname(dest));
  git(['remote', 'remove', 'origin'], dest);
  git(['checkout', '-q', '--detach', ref], dest);
  linkInstalled(root, dest);
  if (opts.withEnv) copyEnvFiles(root, dest);
  return dest;
}

// ---- mining ---------------------------------------------------------------

function taskId(change) {
  const words = change.ask.split('\n')[0].toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `${change.fix.slice(0, 7)}-${words.slice(0, 40).replace(/-$/, '') || 'change'}`;
}

// Turn past changes into graded tasks. No AI runs here: each candidate's
// tests must pass on the change and fail on its parent with the change's
// tests put back. Returns { tasks, looked, candidates, skipped }.
async function findTasks(root, opts = {}) {
  const max = Number(opts.max) > 0 ? Number(opts.max) : MAX_TASKS;
  const config = opts.config || readConfig(root, opts.configPath);
  const changes = listChanges(root, Number(opts.scan) > 0 ? Number(opts.scan) : SCAN);
  const skipped = { no_tests: 0, too_big: 0, short_ask: 0, unknown_runner: 0, fails_after: 0, passes_before: 0 };
  const candidates = [];
  for (const change of changes) {
    const lines = git(['diff', '--name-status', '-M', change.base, change.fix], root).split('\n').filter(Boolean);
    const shape = classifyChange(lines);
    if (!shape.runnable.length || !shape.source.length || shape.deletedTest) { skipped.no_tests += 1; continue; }
    const numstat = git(['diff', '--numstat', change.base, change.fix], root).split('\n').filter(Boolean);
    const changed = numstat.reduce((sum, line) => {
      const [a, d] = line.split('\t');
      return sum + (Number(a) || 0) + (Number(d) || 0);
    }, 0);
    if (lines.length > MAX_FILES || changed > MAX_LINES) { skipped.too_big += 1; continue; }
    const ask = askFor(root, change);
    if (wordCount(ask) < 4) { skipped.short_ask += 1; continue; }
    const runner = resolveRunner(root, shape.runnable, config);
    if (!runner) { skipped.unknown_runner += 1; continue; }
    candidates.push({ ...change, ...shape, ask, runner, lines: changed });
  }

  const tasks = [];
  if (!candidates.length) return { tasks, looked: changes.length, candidates: 0, skipped };
  const scratch = path.join(opts.workDir || workDir(root), 'find');
  const onCheck = typeof opts.onCheck === 'function' ? opts.onCheck : () => {};
  const findTimeout = Number(opts.testTimeoutMs) > 0 ? Number(opts.testTimeoutMs) : FIND_TIMEOUT_MS;
  makeCopy(root, candidates[0].fix, scratch, opts);
  try {
    for (const cand of candidates) {
      if (tasks.length >= max) break;
      const task = {
        id: taskId(cand), fix: cand.fix, base: cand.base, ask: cand.ask, hidden: cand.hidden,
        runnable: cand.runnable, runner: cand.runner, lines: cand.lines,
      };
      git(['checkout', '-q', '-f', '--detach', cand.fix], scratch);
      git(['clean', '-q', '-fd'], scratch);
      const after = await runTests(task, scratch, opts.env, findTimeout);
      if (!after.ok) { skipped.fails_after += 1; onCheck(task, 'fails_after', after); continue; }
      git(['checkout', '-q', '-f', '--detach', cand.base], scratch);
      git(['clean', '-q', '-fd'], scratch);
      git(['checkout', '-q', cand.fix, '--', ...cand.hidden], scratch);
      const before = await runTests(task, scratch, opts.env, findTimeout);
      if (before.ok) { skipped.passes_before += 1; onCheck(task, 'passes_before', before); continue; }
      task.test_seconds = after.seconds;
      tasks.push(task);
      onCheck(task, 'found', after);
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  return { tasks, looked: changes.length, candidates: candidates.length, skipped };
}

// ---- tries ----------------------------------------------------------------

function engineArgs(model) {
  return ['-p', '--model', model, '--permission-mode', 'acceptEdits',
    '--allowedTools', 'Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep',
    '--disallowedTools', ...ENGINE_DENY,
    '--settings', JSON.stringify({ disableAllHooks: true }), '--strict-mcp-config',
    '--output-format', 'stream-json', '--verbose', '--no-session-persistence'];
}

// Everything that must hold before any AI runs: a plan login, no surprise
// overage, the spend guard's yes for every model past Haiku, and a `claude`
// to run. Returns { plan, extraUsage, bin }.
function preflight(models, opts = {}) {
  const env = opts.env || process.env;
  const login = planLogin(env);
  if (!login.ok) throw new Error(login.message);
  if (login.extraUsage && !opts.allowExtraUsage) {
    throw new Error('extra usage is on for this Claude account, so a long run could bill past your plan. '
      + 'turn it off in your Claude settings, or pass --allow-extra-usage to accept that.');
  }
  for (const model of models) {
    const check = checkClaudeSpend({ model, job: 'atris scorecard', env });
    if (!check.ok) {
      throw new Error(`${model} uses much more of your plan than Haiku, so it needs your yes for this run: `
        + `ATRIS_CLAUDE_SPEND_OK=${model} atris scorecard run --models ${models.join(',')}`);
    }
  }
  const bin = findBin(env.ATRIS_SCORECARD_ENGINE || 'claude', env);
  if (!bin) throw new Error('could not find the claude command. install Claude Code, then log in with `claude`.');
  return { ...login, bin };
}

function primaryModel(meta) {
  const usage = meta && meta.modelUsage && typeof meta.modelUsage === 'object' ? meta.modelUsage : null;
  if (!usage) return null;
  let best = null;
  for (const [id, info] of Object.entries(usage)) {
    const cost = Number(info && info.costUSD) || 0;
    if (!best || cost > best.cost) best = { id, cost };
  }
  return best ? best.id : null;
}

async function runTry(root, task, model, opts = {}) {
  const env = opts.env || process.env;
  const scratch = opts.workDir || workDir(root);
  const copy = path.join(scratch, `try-${task.id.slice(0, 7)}-${model.replace(/[^a-z0-9.-]/gi, '_')}-${opts.n || 0}`);
  const row = { id: task.id, model, n: opts.n || 0, passed: false, at: new Date().toISOString() };
  try {
    makeCopy(root, task.base, copy, opts);
    const prompt = WORK_PROMPT.replace('{ask}', () => task.ask);
    const bin = opts.bin || findBin(env.ATRIS_SCORECARD_ENGINE || 'claude', env) || 'claude';
    const limit = minutesFor(model, opts.minutes);
    // Claude Code's first line names where the run's billing comes from.
    // 'none' means the plan login; anything else is a key, so the run is
    // stopped before it asks the model anything.
    let billing = null;
    let meta = null;
    const res = await runProcess(bin, engineArgs(model), {
      cwd: copy, env: engineEnv(copy, scratch, env, task.runner && task.runner.env), input: prompt, timeoutMs: limit * 60000,
      onLine: (line) => {
        let msg;
        try { msg = JSON.parse(line); } catch { return null; }
        if (msg && msg.type === 'system' && msg.subtype === 'init') {
          billing = String(msg.apiKeySource || 'unknown');
          return billing === 'none' ? null : 'stop';
        }
        if (msg && msg.type === 'result') meta = msg;
        return null;
      },
    });
    row.billing = billing === 'none' ? 'plan' : billing;
    if (billing !== 'none') {
      row.engine_error = true;
      row.not_plan = billing !== null;
      row.engine_tail = billing === null
        ? `claude did not start.\n${res.stderr}`.trim().slice(-1500)
        : `claude was about to bill ${billing} instead of your plan login, so the run was stopped.`;
      return row;
    }
    meta = meta || {};
    Object.assign(row, {
      minutes: Math.round((res.ms / 60000) * 100) / 100,
      limit_minutes: limit,
      timed_out: res.timedOut,
      cost_usd: typeof meta.total_cost_usd === 'number' ? meta.total_cost_usd : null,
      turns: Number.isFinite(meta.num_turns) ? meta.num_turns : null,
      model_used: primaryModel(meta),
      engine_error: !res.timedOut && (meta.is_error === true || meta.type !== 'result'),
    });
    if (row.engine_error) {
      row.engine_tail = `${typeof meta.result === 'string' ? meta.result : ''}\n${res.stderr}`.trim().slice(-1500)
        || 'claude stopped without a result';
      row.out_of_plan = OUT_OF_PLAN.test(row.engine_tail);
      return row;
    }
    git(['add', '-A'], copy);
    row.files_changed = git(['diff', '--cached', '--name-only'], copy).split('\n').filter(Boolean);
    if (opts.saveDiff) {
      fs.mkdirSync(path.dirname(opts.saveDiff), { recursive: true });
      fs.writeFileSync(opts.saveDiff, git(['diff', '--cached'], copy));
    }
    git(['checkout', '-q', task.fix, '--', ...task.hidden], copy);
    const graded = await runTests(task, copy, env);
    row.passed = graded.ok && !row.engine_error;
    if (!graded.ok) row.test_tail = graded.tail.slice(-1500);
  } catch (err) {
    row.harness_error = String(err.message || err).slice(-1500);
  } finally {
    fs.rmSync(copy, { recursive: true, force: true });
  }
  return row;
}

function counts(row) {
  return !row.harness_error && !row.engine_error;
}

// Every task on every model, up to `tries` counted tries each. Tries already
// in `done` are skipped, so an interrupted run picks up where it stopped.
// Items go task by task so each task's models run close together. Resolves
// { rows, stopped, planned }; stopped means the plan ran out or a run was
// about to bill something other than the plan login.
async function runAll(root, tasks, opts = {}) {
  const models = normalizeModels(opts.models);
  const tries = Math.max(1, Number(opts.tries) || 1);
  const done = Array.isArray(opts.done) ? opts.done.filter(counts) : [];
  const plan = [];
  for (let n = 0; n < tries; n += 1) {
    for (const task of tasks) {
      for (const model of models) {
        if (!done.some((row) => row.id === task.id && row.model === model && row.n === n)) plan.push({ task, model, n });
      }
    }
  }
  const rows = [];
  let next = 0;
  let stopped = false;
  const jobs = Math.max(1, Math.min(Number(opts.jobs) || 2, plan.length || 1));
  async function worker() {
    while (next < plan.length && !stopped) {
      const item = plan[next];
      next += 1;
      const saveDiff = opts.outDir
        ? path.join(opts.outDir, 'diffs', `${item.task.id.slice(0, 7)}-${item.model.replace(/[^a-z0-9.-]/gi, '_')}-${item.n}.diff`)
        : null;
      const row = await runTry(root, item.task, item.model, { ...opts, n: item.n, saveDiff });
      if (row.out_of_plan || row.not_plan) stopped = true;
      rows.push(row);
      if (typeof opts.onResult === 'function') opts.onResult(row, rows.length, plan.length);
    }
  }
  await Promise.all(Array.from({ length: jobs }, () => worker()));
  return { rows, stopped, planned: plan.length };
}

// ---- the scorecard ----------------------------------------------------------

function money(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '-';
  return value < 0.995 ? `${Math.round(value * 100)}¢` : `$${value.toFixed(2)}`;
}

function summarize(tasks, allRows, models) {
  const ids = new Set(tasks.map((task) => task.id));
  const rows = allRows.filter((row) => ids.has(row.id));
  const counted = rows.filter(counts);
  const names = models && models.length ? models : [...new Set(rows.map((row) => row.model))];
  const byModel = names.map((model) => {
    const mine = counted.filter((row) => row.model === model);
    const passes = mine.filter((row) => row.passed).length;
    const priced = mine.filter((row) => typeof row.cost_usd === 'number');
    const cost = priced.reduce((sum, row) => sum + row.cost_usd, 0);
    return {
      model,
      model_used: (mine.find((row) => row.model_used) || {}).model_used || null,
      tries: mine.length,
      passes,
      tasks_done: new Set(mine.filter((row) => row.passed).map((row) => row.id)).size,
      avg_minutes: mine.length ? Math.round((mine.reduce((s, r) => s + (r.minutes || 0), 0) / mine.length) * 10) / 10 : null,
      cost_per_try: priced.length ? cost / priced.length : null,
      cost_per_pass: passes && priced.length ? cost / passes : null,
    };
  }).filter((m) => m.tries || (models && models.includes(m.model)));
  const tried = (id) => counted.filter((row) => row.id === id);
  const noModel = byModel.length ? tasks.filter((task) => {
    const mine = tried(task.id);
    return byModel.every((m) => mine.some((row) => row.model === m.model)) && !mine.some((row) => row.passed);
  }).map((task) => ({
    id: task.id, fix: task.fix, ask: task.ask, hidden: task.hidden,
    tail: (tried(task.id).find((row) => row.test_tail) || {}).test_tail || '',
  })) : [];
  // Cheapest first: the cheapest model's first try, then each pricier model's
  // first try only when every cheaper one failed the tests.
  let ladder = null;
  const ordered = byModel.filter((m) => m.cost_per_try !== null)
    .sort((a, b) => a.cost_per_try - b.cost_per_try).map((m) => m.model);
  if (ordered.length >= 2) {
    let cost = 0;
    let doneCount = 0;
    let scored = 0;
    for (const task of tasks) {
      const first = ordered.map((model) => tried(task.id).find((row) => row.model === model && row.n === 0));
      if (first.some((row) => !row)) continue;
      scored += 1;
      for (const row of first) {
        cost += row.cost_usd || 0;
        if (row.passed) { doneCount += 1; break; }
      }
    }
    if (scored) {
      ladder = { order: ordered, done: doneCount, of: scored, cost_per_pass: doneCount ? cost / doneCount : null, cost_per_task: cost / scored };
    }
  }
  const errors = rows.filter((row) => !counts(row)).length;
  return { tasks: tasks.length, models: byModel, no_model: noModel, ladder, errors };
}

function shortModel(model) {
  const match = /^claude-([a-z]+)-(\d+)-(\d+)/.exec(model);
  return match ? `${match[1]} ${match[2]}.${match[3]}` : model;
}

function renderScorecard(summary, { repo = '', plan = '', extraUsage = false } = {}) {
  const lines = [];
  lines.push(`atris scorecard  ${repo}`);
  lines.push(`${summary.tasks} past changes from this repo, each graded by the tests that shipped with it`);
  lines.push('');
  const width = Math.max(10, ...summary.models.map((m) => shortModel(m.model).length)) + 2;
  lines.push(`${'model'.padEnd(width)}${'done'.padEnd(12)}${'avg time'.padEnd(12)}price per done change`);
  for (const m of summary.models) {
    const done = m.tries ? `${m.passes} of ${m.tries}` : 'not run';
    const time = m.avg_minutes === null ? '-' : `${m.avg_minutes} min`;
    lines.push(`${shortModel(m.model).padEnd(width)}${done.padEnd(12)}${time.padEnd(12)}${money(m.cost_per_pass)}`);
  }
  if (summary.ladder) {
    const order = summary.ladder.order.map(shortModel);
    lines.push('');
    lines.push(`cheapest first (${order[0]}, then ${order.slice(1).join(', then ')} only when the tests fail): `
      + `${summary.ladder.done} of ${summary.ladder.of} done, ${money(summary.ladder.cost_per_pass)} per done change`);
  }
  if (summary.no_model.length) {
    lines.push('');
    lines.push(summary.models.length > 1
      ? 'no model did these from what was written, so the ask is missing something the tests check:'
      : 'not done from what was written. a stronger model, or a clearer ask, may get these:');
    for (const task of summary.no_model.slice(0, 8)) {
      lines.push(`  ${task.fix.slice(0, 7)}  ${task.ask.split('\n')[0].slice(0, 90)}`);
      lines.push(`           tests: ${task.hidden.slice(0, 3).join(', ')}${task.hidden.length > 3 ? ', ...' : ''}`);
    }
  }
  if (summary.errors) {
    lines.push('');
    lines.push(`${summary.errors} ${summary.errors === 1 ? 'try' : 'tries'} could not run and ${summary.errors === 1 ? 'is' : 'are'} left out.`);
  }
  lines.push('');
  lines.push(extraUsage
    ? `these ran on your ${plan || 'Claude plan'} with extra usage on. prices are what the same runs cost on pay-per-use.`
    : `these ran on your ${plan || 'Claude plan'}, so they billed $0. prices are what the same runs would cost on pay-per-use.`);
  return lines.join('\n');
}

module.exports = {
  DEFAULT_MODELS,
  ENGINE_DENY,
  MAX_TASKS,
  OUT_OF_PLAN,
  WORK_PROMPT,
  classifyChange,
  cleanMessage,
  copyEnvFiles,
  engineArgs,
  engineEnv,
  findBin,
  findTasks,
  isRunnableTest,
  isTestPath,
  linkInstalled,
  listChanges,
  makeCopy,
  minutesFor,
  normalizeModels,
  planLogin,
  preflight,
  readConfig,
  renderScorecard,
  repoName,
  repoRoot,
  repoSlug,
  resolveRunner,
  runAll,
  runTry,
  runnerCommand,
  runnerLabel,
  shortModel,
  stopAll,
  storeDir,
  stripBilling,
  summarize,
  testEnv,
  workDir,
};
