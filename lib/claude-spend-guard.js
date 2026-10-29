'use strict';

// Claude spend guard. On 2026-10-28 unattended jobs ran Opus and Fable models
// in loops and billed about $900 of paid Claude usage in one day.
//
// The rule, enforced in two places:
// 1. Our own launchers call checkClaudeSpend() before starting `claude`, and
//    hand it claudeChildEnv() so the pay-per-use key never reaches it.
// 2. `atris spend guard install` adds a Claude Code hook on this computer that
//    applies the same rule to every unattended `claude` run, whatever script
//    started it.
//
// Haiku runs freely. Any other Claude model in an unattended run needs the
// owner's yes for that run: ATRIS_CLAUDE_SPEND_OK=<model>[,<model>].
// A person typing in an interactive Claude session is never blocked.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const APPROVAL_ENV = 'ATRIS_CLAUDE_SPEND_OK';
const KEY_OK_ENV = 'ATRIS_CLAUDE_KEY_OK';
// Either of these moves a `claude` run from the plan login to metered billing.
const PAID_KEY_VARS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'];
const HOOK_MARK = 'claude-spend-guard';

function home(env = process.env) {
  return env.HOME || os.homedir();
}

function ledgerPath(env = process.env) {
  return path.join(home(env), '.atris', 'spend', 'claude-guard.jsonl');
}

function isFreeModel(model) {
  return /haiku/i.test(String(model || ''));
}

function approvedModels(env = process.env) {
  return String(env[APPROVAL_ENV] || '')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

function hasPaidKey(env = process.env) {
  return PAID_KEY_VARS.some((name) => Boolean(env[name]));
}

// The model a `claude` run will use when no --model flag is given: the
// ANTHROPIC_MODEL env var, then the user's settings, then the account default,
// which on Max is Opus.
function defaultClaudeModel(env = process.env) {
  if (env.ANTHROPIC_MODEL) return env.ANTHROPIC_MODEL;
  try {
    const settings = JSON.parse(fs.readFileSync(path.join(home(env), '.claude', 'settings.json'), 'utf8'));
    if (settings && typeof settings.model === 'string' && settings.model) return settings.model;
  } catch {}
  return 'default';
}

// `--model haiku` can be remapped by ANTHROPIC_DEFAULT_HAIKU_MODEL; judge the
// model that actually runs.
function resolveAlias(model, env = process.env) {
  const alias = String(model).toLowerCase().replace(/\[1m\]$/, '');
  const mapped = { opus: 'ANTHROPIC_DEFAULT_OPUS_MODEL', sonnet: 'ANTHROPIC_DEFAULT_SONNET_MODEL',
    haiku: 'ANTHROPIC_DEFAULT_HAIKU_MODEL' }[alias];
  return (mapped && env[mapped]) || model;
}

function record(entry, env = process.env) {
  try {
    const file = ledgerPath(env);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), host: os.hostname(), ...entry }) + '\n');
  } catch {}
}

function blockMessage(model, job) {
  const who = job ? `${job}: ` : '';
  return `${who}${model} is a paid Claude model and this run is unattended. Haiku runs free. `
    + `Get the owner's yes with a dollar estimate, then rerun with ${APPROVAL_ENV}=${model}.`;
}

// Decide whether an unattended Claude run may start.
// Returns { ok, reason, message }. Never throws.
function checkClaudeSpend({ model, job = '', env = process.env, checkKey = false, log = true } = {}) {
  const resolved = resolveAlias(String(model || '').trim() || defaultClaudeModel(env), env);
  if (checkKey && hasPaidKey(env) && env[KEY_OK_ENV] !== '1') {
    const message = `${job ? `${job}: ` : ''}this unattended Claude run carries a pay-per-use key `
      + `(${PAID_KEY_VARS.join(' or ')}). Unset it so the run uses the plan login.`;
    if (log) record({ decision: 'blocked', reason: 'paid_key', model: resolved, job, cwd: process.cwd() }, env);
    return { ok: false, reason: 'paid_key', model: resolved, message };
  }
  if (isFreeModel(resolved)) return { ok: true, reason: 'free_model', model: resolved };
  if (approvedModels(env).includes(resolved.toLowerCase())) {
    if (log) record({ decision: 'approved', model: resolved, job, cwd: process.cwd() }, env);
    return { ok: true, reason: 'approved', model: resolved };
  }
  if (log) record({ decision: 'blocked', reason: 'paid_model', model: resolved, job, cwd: process.cwd() }, env);
  return { ok: false, reason: 'paid_model', model: resolved, message: blockMessage(resolved, job) };
}

// A copy of env safe to hand a `claude` child: no pay-per-use key, so the run
// bills the plan login. ATRIS_CLAUDE_KEY_OK=1 keeps the key (servers only).
function claudeChildEnv(env = process.env) {
  const out = { ...env };
  if (out[KEY_OK_ENV] === '1') return out;
  for (const name of PAID_KEY_VARS) delete out[name];
  return out;
}

// ---- Claude Code hook --------------------------------------------------

function processArgs(pid) {
  try {
    if (process.platform === 'linux') {
      return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
    }
    const line = execFileSync('ps', ['-o', 'args=', '-p', String(pid)], { encoding: 'utf8', timeout: 3000 }).trim();
    return line ? line.split(/\s+/) : [];
  } catch {
    return [];
  }
}

function parentPid(pid) {
  try {
    const out = execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8', timeout: 3000 }).trim();
    const n = Number(out);
    return Number.isInteger(n) && n > 1 ? n : 0;
  } catch {
    return 0;
  }
}

function isClaudeArgv(argv) {
  if (!argv.length) return false;
  if (path.basename(argv[0]) === 'claude') return true;
  return argv.slice(0, 3).some((a) => /claude-code|[\\/]claude$/.test(a));
}

// The argv of the `claude` process that ran this hook. Hooks run as direct
// children of claude; walk a few levels up in case a shell sits between.
function claudeArgv(startPid = process.ppid) {
  let pid = startPid;
  for (let i = 0; i < 4 && pid; i += 1) {
    const argv = processArgs(pid);
    if (isClaudeArgv(argv)) return argv;
    pid = parentPid(pid);
  }
  return null;
}

function modelFromArgv(argv) {
  let model = '';
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--model' && argv[i + 1]) model = argv[i + 1];
    else if (argv[i].startsWith('--model=')) model = argv[i].slice('--model='.length);
  }
  return model;
}

// Unattended means print mode or an SDK run. A person's interactive session
// reports CLAUDE_CODE_ENTRYPOINT=cli and has no -p flag.
function isUnattended(argv, env = process.env) {
  if (String(env.CLAUDE_CODE_ENTRYPOINT || '').startsWith('sdk')) return true;
  return argv.includes('-p') || argv.includes('--print');
}

// Decide for the hook. Returns { block, message }.
function hookDecision({ argv, env = process.env }) {
  if (!argv || !isUnattended(argv, env)) return { block: false };
  const verdict = checkClaudeSpend({ model: modelFromArgv(argv), job: 'claude spend guard', env, checkKey: true });
  return verdict.ok ? { block: false } : { block: true, message: verdict.message };
}

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

// Entry point for the UserPromptSubmit hook. Exit 2 stops the run before any
// model call; anything unexpected fails open so a guard bug never breaks work.
function hookMain() {
  let event = {};
  try { event = JSON.parse(readStdin() || '{}'); } catch {}
  if (event.hook_event_name && event.hook_event_name !== 'UserPromptSubmit') return 0;
  const decision = hookDecision({ argv: claudeArgv() });
  if (!decision.block) return 0;
  try { fs.writeSync(2, `${decision.message}\n`); } catch {}
  return 2;
}

// ---- install into ~/.claude/settings.json ------------------------------

function settingsPath(env = process.env) {
  return path.join(home(env), '.claude', 'settings.json');
}

function hookScriptPath(env = process.env) {
  return path.join(home(env), '.claude', 'hooks', `${HOOK_MARK}.js`);
}

function nodeBinary() {
  for (const candidate of ['/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node']) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return process.execPath;
}

function readSettings(file) {
  if (!fs.existsSync(file)) return {};
  const text = fs.readFileSync(file, 'utf8');
  if (!text.trim()) return {};
  return JSON.parse(text);
}

function guardEntries(settings) {
  const groups = (settings.hooks && settings.hooks.UserPromptSubmit) || [];
  return groups.filter((g) => (g.hooks || []).some((h) => String(h.command || '').includes(HOOK_MARK)));
}

function guardStatus(env = process.env) {
  let settings = {};
  let readable = true;
  try { settings = readSettings(settingsPath(env)); } catch { readable = false; }
  return {
    installed: readable && guardEntries(settings).length > 0 && fs.existsSync(hookScriptPath(env)),
    settings: settingsPath(env),
    script: hookScriptPath(env),
    readable,
  };
}

function installGuard({ env = process.env, modulePath = __filename } = {}) {
  const file = settingsPath(env);
  const settings = readSettings(file); // throws on unparseable settings: never clobber them
  // The hook is a copy of this file, so it keeps working if the CLI moves.
  // Rerun install after a CLI update to pick up guard fixes.
  const script = hookScriptPath(env);
  fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.copyFileSync(modulePath, script);
  fs.chmodSync(script, 0o755);
  settings.hooks = settings.hooks || {};
  const groups = settings.hooks.UserPromptSubmit || [];
  const kept = groups.filter((g) => !guardEntries({ hooks: { UserPromptSubmit: [g] } }).length);
  // First in line, so it runs before any hook that might spend.
  settings.hooks.UserPromptSubmit = [
    { hooks: [{ type: 'command', command: `${nodeBinary()} ${script}` }] },
    ...kept,
  ];
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.atris-tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n');
  fs.renameSync(tmp, file);
  return guardStatus(env);
}

function uninstallGuard({ env = process.env } = {}) {
  const file = settingsPath(env);
  const settings = readSettings(file);
  if (settings.hooks && settings.hooks.UserPromptSubmit) {
    const kept = settings.hooks.UserPromptSubmit.filter((g) => !guardEntries({ hooks: { UserPromptSubmit: [g] } }).length);
    if (kept.length) settings.hooks.UserPromptSubmit = kept;
    else delete settings.hooks.UserPromptSubmit;
    const tmp = `${file}.atris-tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n');
    fs.renameSync(tmp, file);
  }
  try { fs.unlinkSync(hookScriptPath(env)); } catch {}
  return guardStatus(env);
}

module.exports = {
  APPROVAL_ENV,
  checkClaudeSpend,
  claudeChildEnv,
  hookDecision,
  guardStatus,
  installGuard,
  uninstallGuard,
  ledgerPath,
};

if (require.main === module) process.exit(hookMain());
