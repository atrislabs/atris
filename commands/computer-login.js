'use strict';

// `atris computer login`: put your own Claude or Codex subscription on the
// cloud computers you own, with one browser approval and nothing to answer.
//
// The sign-in happens on this laptop, where the browser is. The result is sent
// straight to Atris, stored encrypted, and used only on runs you start. It is
// never printed and never written to a file here.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { loadCredentials } = require('../utils/auth');
const { apiRequestJson } = require('../utils/api');
const engineLogin = require('../lib/engine-login');

const ENGINES = ['claude', 'codex'];
const WORKER_FOR = { claude: 'claude', codex: 'openai' };
const TEST_MESSAGE = 'Reply with only the word OK.';

function parseLoginArgs(args = []) {
  const options = { engine: 'claude', business: '', status: false, unlink: false, check: false, test: true, help: false, error: '' };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (ENGINES.includes(arg)) options.engine = arg;
    else if (arg === '--status' || arg === 'status') options.status = true;
    else if (arg === '--unlink' || arg === 'unlink' || arg === 'logout') options.unlink = true;
    else if (arg === '--check' || arg === 'check') options.check = true;
    else if (arg === '--no-test') options.test = false;
    else if (arg === '--help' || arg === '-h' || arg === 'help') options.help = true;
    else if (arg === '--business') {
      options.business = String(args[i + 1] || '').trim();
      i += 1;
      if (!options.business) options.error = '--business needs a computer name';
    } else if (arg.startsWith('--business=')) options.business = arg.slice('--business='.length).trim();
    else options.error = `unknown option: ${arg}`;
  }
  return options;
}

function printHelp(log) {
  log('Usage: atris computer login [claude|codex] [--business <name>]');
  log('');
  log('Puts your own subscription on the cloud computers you own.');
  log('One browser approval. It is used only on runs you start.');
  log('');
  log('  atris computer login                 Claude, on every computer you own');
  log('  atris computer login codex           Codex instead (a computer holds one at a time)');
  log('  atris computer login --business x    only the computer named x');
  log('  atris computer login --status        which computers have a subscription');
  log('  atris computer login --check         run one small job and show how it was paid');
  log('  atris computer login --unlink        remove it; add --business x for one');
  log('  --no-test                            skip the test run at the end');
}

function findComputer(computers, name) {
  const wanted = String(name || '').trim().toLowerCase();
  if (!wanted) return null;
  return computers.find((item) => [item.slug, item.name, item.business_id]
    .some((value) => String(value || '').toLowerCase() === wanted)) || null;
}

function printStatus(computers, log) {
  if (!computers.length) {
    log('You do not own any computers on this account.');
    return;
  }
  const width = Math.max(...computers.map((item) => String(item.name || item.slug || '').length));
  for (const item of computers) {
    const name = String(item.name || item.slug || item.business_id).padEnd(width);
    log(`  ${name}  ${item.linked ? `${item.engine} subscription` : 'no subscription'}`);
  }
}

// What the server said, in plain words. Never includes the sign-in.
function explainFailure(result) {
  if (result.status === 404) return 'The server does not have this yet. It needs the latest deploy.';
  if (result.status === 403) return String(result.error || 'This is not switched on for your account.');
  if (result.status === 401) return 'Your Atris sign-in ran out. Run: atris login';
  if (result.status === 400) return String(result.error || 'The server did not accept that sign-in.');
  return 'The server did not answer. Try again in a minute.';
}

// Claude: its own long-lived sign-in command, approved in the browser.
function claudeSignIn(deps) {
  const lib = deps.engineLogin || engineLogin;
  const recorded = lib.recordSetupToken();
  let token = lib.findToken(recorded.text);
  if (!token) token = lib.askToken();
  if (!/^sk-ant-oat/.test(token)) return { error: 'No sign-in came back from Claude.' };
  // Claude prints the sign-in on screen. Wipe it, scrollback included.
  (deps.clearScreen || (() => process.stdout.write('\x1b[2J\x1b[3J\x1b[H')))();
  const check = lib.checkToken(token);
  if (!check.ok) return { error: `The new sign-in did not work on this laptop (${check.detail}).` };
  return { credential: token };
}

// Codex: a fresh sign-in in a throwaway folder, so the cloud gets its own
// session and this laptop's Codex sign-in is left alone.
function codexSignIn(deps) {
  const spawn = deps.spawnSync || spawnSync;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-codex-login-'));
  fs.chmodSync(home, 0o700);
  try {
    const result = spawn('codex', ['login', '-c', 'cli_auth_credentials_store="file"'], {
      stdio: 'inherit',
      env: { ...process.env, CODEX_HOME: home },
    });
    if (result.error && result.error.code === 'ENOENT') return { error: 'Codex is not installed on this laptop.' };
    const file = path.join(home, 'auth.json');
    if (!fs.existsSync(file)) return { error: 'No sign-in came back from Codex.' };
    const content = fs.readFileSync(file, 'utf8').trim();
    try {
      if (typeof JSON.parse(content) !== 'object') throw new Error('not an object');
    } catch {
      return { error: 'Codex wrote a sign-in this tool could not read.' };
    }
    return { credential: content };
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

function defaultRunTest(computer, engine) {
  const result = spawnSync(process.execPath, [
    path.join(__dirname, '..', 'bin', 'atris.js'), 'computer', 'chat',
    '--business', String(computer.slug || computer.business_id),
    '--worker', WORKER_FOR[engine], '--message', TEST_MESSAGE,
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 300000 });
  const lines = `${result.stdout || ''}`.trim().split('\n').filter(Boolean);
  return { ok: result.status === 0, reply: lines[lines.length - 1] || '' };
}

async function lastRun(api, token, computer) {
  const result = await api(`/ai-computer/subscription/last-run?business_id=${encodeURIComponent(computer.business_id)}`, {
    method: 'GET', token, timeoutMs: 15000, retries: 1,
  });
  return result.ok && result.data ? { ok: true, run: result.data.run || null } : { ok: false, run: null };
}

// Runs one tiny job as you, then asks the server how that run was paid for.
// "New" means a different run than the newest one before the test, so no
// clocks are compared.
async function proveSubscription({ api, token, computer, engine, deps, log }) {
  const name = computer.name || computer.slug;
  const before = await lastRun(api, token, computer);
  if (!before.ok) {
    log('Could not read this computer\'s run records, so this is not proven yet.');
    return false;
  }
  log(`Running one small job on ${name}. It may take a minute to wake.`);
  const test = (deps.runTest || defaultRunTest)(computer, engine);
  const after = await lastRun(api, token, computer);
  const record = after.run;
  const isNew = record && record.execution_id && (!before.run || record.execution_id !== before.run.execution_id);
  if (!isNew) {
    log('The test job left no new record, so this is not proven yet.');
    return false;
  }
  if (!record.on_subscription) {
    log(`Not working: that job was paid as "${record.billing_mode || 'unknown'}", not your subscription.`);
    return false;
  }
  if (record.status !== 'completed' || !/\bok\b/i.test(test.reply || '')) {
    log(`Not proven: the job was sent to your ${engine} subscription but did not finish cleanly (${record.status || 'unknown'}).`);
    return false;
  }
  if (computer.shared_sign_in) {
    log(`That job ran on a ${engine} subscription. ${name} also has the older shared sign-in,`);
    log('so this result cannot tell the two apart.');
    return true;
  }
  log(`Proven: that job ran on your ${engine} subscription.`);
  return true;
}

// Ctrl-C during a sign-in goes to the sign-in program. Holding the signal here
// lets cleanup of its screen recording run instead of dying mid-way.
function holdingInterrupt(work) {
  const hold = () => {};
  process.on('SIGINT', hold);
  try {
    return work();
  } finally {
    process.removeListener('SIGINT', hold);
  }
}

async function computerLogin(args = [], deps = {}) {
  const log = deps.log || console.log;
  const fail = deps.error || console.error;
  const options = parseLoginArgs(args);
  if (!options.business && deps.business) options.business = String(deps.business).trim();
  if (options.help) {
    printHelp(log);
    return 0;
  }
  if (options.error) {
    fail(options.error);
    return 1;
  }

  const credentials = await (deps.loadCredentials || loadCredentials)();
  if (!credentials || !credentials.token) {
    fail('Not signed in to Atris. Run: atris login');
    return 1;
  }
  const token = credentials.token;
  const api = deps.apiRequestJson || apiRequestJson;

  const listed = await api('/ai-computer/subscription', { method: 'GET', token, timeoutMs: 15000, retries: 1 });
  if (!listed.ok) {
    fail(explainFailure(listed));
    return 1;
  }
  const computers = Array.isArray(listed.data && listed.data.computers) ? listed.data.computers : [];

  if (options.status) {
    printStatus(computers, log);
    return 0;
  }

  let target = null;
  if (options.business) {
    target = findComputer(computers, options.business);
    if (!target) {
      fail(`You do not own a computer named "${options.business}".`);
      return 1;
    }
  }
  if (!computers.length) {
    fail('You do not own any computers on this account, so there is nothing to sign in to.');
    return 1;
  }

  if (options.unlink) {
    const removed = await api('/ai-computer/subscription/unlink', {
      method: 'POST', token, body: target ? { business_id: target.business_id } : {}, timeoutMs: 30000, retries: 0,
    });
    if (!removed.ok) {
      fail(explainFailure(removed));
      return 1;
    }
    const count = (removed.data && removed.data.unlinked ? removed.data.unlinked : []).length;
    const stuck = (removed.data && removed.data.failed ? removed.data.failed : []).length;
    log(`Removed your subscription from ${count} computer${count === 1 ? '' : 's'}.`);
    if (stuck) {
      fail(`${stuck} could not be removed. See which: atris computer login --status`);
      return 1;
    }
    return 0;
  }

  const binding = (deps.readBusinessBinding || (() => null))();
  const bound = binding ? findComputer(computers, binding.business_id || binding.id || binding.slug) : null;

  if (options.check) {
    const checked = target || bound;
    if (!checked) {
      fail('Name the computer to check: atris computer login --check --business <name>');
      return 1;
    }
    if (!checked.linked) {
      fail(`${checked.name || checked.slug} has no subscription yet. Run: atris computer login`);
      return 1;
    }
    const proven = await proveSubscription({ api, token, computer: checked, engine: checked.engine, deps, log });
    return proven ? 0 : 2;
  }

  const engine = options.engine;
  log(`Signing in to ${engine}. A browser page opens. Approve it there.`);
  const signIn = holdingInterrupt(() => (engine === 'claude'
    ? (deps.claudeSignIn || claudeSignIn)(deps)
    : (deps.codexSignIn || codexSignIn)(deps)));
  if (signIn.error) {
    fail(`${signIn.error} Nothing was changed.`);
    return 1;
  }

  const linked = await api('/ai-computer/subscription/link', {
    method: 'POST',
    token,
    body: { engine, credential: signIn.credential, ...(target ? { business_id: target.business_id } : {}) },
    timeoutMs: 60000,
    retries: 0,
  });
  if (!linked.ok) {
    // A refusal means nothing was stored. Anything else (a timeout, a server
    // error) may have stored it on some computers, so do not claim otherwise.
    const refused = [400, 401, 403, 404].includes(linked.status);
    fail(refused
      ? `${explainFailure(linked)} Nothing was changed.`
      : 'The server did not confirm. Some computers may have it. See which: atris computer login --status');
    return 1;
  }
  const done = linked.data && Array.isArray(linked.data.linked) ? linked.data.linked : [];
  const missed = linked.data && Array.isArray(linked.data.failed) ? linked.data.failed : [];
  const names = done
    .map((item) => computers.find((computer) => computer.business_id === item.business_id))
    .filter(Boolean)
    .map((computer) => computer.name || computer.slug);
  log(`Your ${engine} subscription is on ${done.length} computer${done.length === 1 ? '' : 's'}${names.length ? `: ${names.join(', ')}` : ''}.`);
  log('It is used only on runs you start.');
  if (missed.length) {
    const missedNames = missed.map((id) => {
      const computer = computers.find((item) => item.business_id === id);
      return computer ? (computer.name || computer.slug) : id;
    });
    fail(`It could not be added to ${missed.length}: ${missedNames.join(', ')}. Run the command again to retry.`);
  }

  if (!done.length) return 1;
  if (!options.test) return missed.length ? 1 : 0;
  const proofTarget = target || (bound && done.some((item) => item.business_id === bound.business_id) ? bound : null);
  if (!proofTarget) {
    log('To prove it on one computer: atris computer login --check --business <name>');
    return missed.length ? 1 : 0;
  }
  const proven = await proveSubscription({ api, token, computer: proofTarget, engine, deps, log });
  if (!proven) return 2;
  return missed.length ? 1 : 0;
}

module.exports = { computerLogin, parseLoginArgs, findComputer, explainFailure, claudeSignIn, codexSignIn };
