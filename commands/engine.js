'use strict';

// atris engine: bring any intelligence.
// Every installed headless coding CLI is a swappable worker behind one
// contract (bounded prompt in, verified proof out, engines never
// self-certify). This command shows the roster, flips the default, and the
// same names ride --engine on mission run / autopilot / run.
//
//   atris engine            roster + current default
//   atris engine cursor     make cursor the default engine here
//   atris engine reset      back to the house default (atris-fast)
//
// The default persists to .atris/engine.json. Per-run flags and
// ATRIS_RUNNER_PROFILE always beat the file.

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { spawnSync } = require('child_process');
const { Writable } = require('stream');
const {
  RUNNER_PROFILE_DEFS,
  RUNNER_PROFILE_NAMES,
  buildRunnerCommand,
} = require('../lib/runner-command');
const {
  ENGINE_ROLES,
  ENGINE_DUTIES,
  ENGINE_HEALTH_STATUSES,
  binInstalled,
  canonicalEngineName,
  engineRegistryFile,
  engineRegistryView,
  readEngineRegistry,
  resolveEngineForRole,
  resolveEngineForRoleRanked,
  requireEngineBin,
  engineDoctorReport,
  setEngineOverrides,
  setEngineHealth,
} = require('../lib/engine-registry');
const { FLEET_CAPABLE, runDispatchFlight } = require('../lib/fleet');
const { ensureValidCredentials } = require('../utils/auth');
const { apiRequestJson } = require('../utils/api');

const HOUSE_ENGINE = 'atris-fast';
const MAX_ENGINE_LOGIN_FILE_BYTES = 64 * 1024;
const ENGINE_DEVICE_LOGIN_POLL_MS = 3000;
const ENGINE_DEVICE_LOGIN_TIMEOUT_MS = 16 * 60 * 1000;
const ENGINE_LOGIN_MANIFESTS = Object.freeze({
  codex: Object.freeze({
    type: 'files',
    files: Object.freeze(['~/.codex/auth.json']),
    missingHint: 'run codex login first',
  }),
  claude: Object.freeze({
    type: 'files',
    files: Object.freeze(['~/.claude/.credentials.json']),
    missingHint: 'run claude login first',
  }),
  cursor: Object.freeze({
    type: 'files',
    files: Object.freeze(['~/.cursor/cli-config.json']),
    missingHint: 'run cursor login first',
  }),
  devin: Object.freeze({
    type: 'api_key',
    missingHint: 'paste a Devin API key',
  }),
  grok: Object.freeze({
    type: 'files',
    files: Object.freeze(['~/.grok/auth.json']),
    missingHint: 'run grok and log in with grok.com',
  }),
});

function knownLoginProviders() {
  return Object.keys(ENGINE_LOGIN_MANIFESTS);
}

function engineFile(root = process.cwd()) {
  return path.join(root, '.atris', 'engine.json');
}

function readSavedEngine(root = process.cwd()) {
  try {
    const saved = JSON.parse(fs.readFileSync(engineFile(root), 'utf8'));
    return canonicalEngineName(saved.default);
  } catch {
    return '';
  }
}

// The default engine for this workspace, in precedence order:
// env (per-run flags land here) -> .atris/engine.json -> house default.
// The house default is our own intelligence when it is installed.
function resolveDefaultEngine(root = process.cwd()) {
  const env = canonicalEngineName(process.env.ATRIS_RUNNER_PROFILE);
  if (env) return { name: env, source: 'env' };
  const saved = readSavedEngine(root);
  if (saved) return { name: saved, source: 'saved' };
  if (binInstalled(RUNNER_PROFILE_DEFS[HOUSE_ENGINE].bin)) return { name: HOUSE_ENGINE, source: 'house' };
  const fallback = RUNNER_PROFILE_NAMES.find((name) => binInstalled(RUNNER_PROFILE_DEFS[name].bin));
  return fallback ? { name: fallback, source: 'detected' } : { name: HOUSE_ENGINE, source: 'none' };
}

function roster(root = process.cwd()) {
  const current = resolveDefaultEngine(root);
  return engineRegistryView(root).map((engine) => ({
    ...engine,
    default: engine.id === current.name,
  }));
}

function setEngine(name, root = process.cwd()) {
  const canonical = canonicalEngineName(name);
  if (!canonical) {
    throw new Error(`Unknown engine "${name}". Known engines: ${RUNNER_PROFILE_NAMES.join(', ')}`);
  }
  const file = engineFile(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ default: canonical, set_at: new Date().toISOString() }, null, 2)}\n`);
  return canonical;
}

function resetEngine(root = process.cwd()) {
  try { fs.unlinkSync(engineFile(root)); return true; } catch { return false; }
}

function expandHomePath(filePath, homeDir = os.homedir()) {
  const value = String(filePath || '');
  if (value === '~') return homeDir;
  if (value.startsWith('~/')) return path.join(homeDir, value.slice(2));
  return value;
}

function normalizeLoginProvider(name) {
  const raw = String(name || '').trim().toLowerCase();
  if (!raw) return '';
  const canonical = canonicalEngineName(raw) || raw;
  return ENGINE_LOGIN_MANIFESTS[canonical] ? canonical : '';
}

function normalizeEngineLoginSeat(name) {
  return String(name || '')
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, '_');
}

function validEngineLoginSeat(name) {
  return /^[A-Z0-9][A-Z0-9_]{0,47}$/.test(String(name || ''));
}

function engineLoginSeatError() {
  return 'seat names are letters, numbers, underscores - like personal or work';
}

function byteLength(value) {
  return Buffer.byteLength(String(value || ''), 'utf8');
}

function detectedEmailFromJsonValue(value, depth = 0) {
  if (depth > 6 || value == null) return '';
  if (typeof value === 'string') {
    const match = value.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
    return match ? match[0] : '';
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = detectedEmailFromJsonValue(item, depth + 1);
      if (found) return found;
    }
    return '';
  }
  if (typeof value === 'object') {
    const preferred = ['email', 'account_email', 'user_email'];
    for (const key of preferred) {
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        const found = detectedEmailFromJsonValue(value[key], depth + 1);
        if (found) return found;
      }
    }
    for (const item of Object.values(value)) {
      const found = detectedEmailFromJsonValue(item, depth + 1);
      if (found) return found;
    }
  }
  return '';
}

function detectedEmailFromContent(content) {
  try {
    return detectedEmailFromJsonValue(JSON.parse(content));
  } catch {
    return '';
  }
}

function readEngineLoginFiles(provider, { homeDir = os.homedir(), fsModule = fs } = {}) {
  const manifest = ENGINE_LOGIN_MANIFESTS[provider];
  if (!manifest || manifest.type !== 'files') {
    throw new Error(`No file manifest for ${provider}`);
  }

  const files = {};
  const summary = [];
  for (const displayPath of manifest.files) {
    const absolutePath = expandHomePath(displayPath, homeDir);
    let stat;
    try {
      stat = fsModule.statSync(absolutePath);
    } catch {
      const err = new Error(`Missing ${displayPath}. ${manifest.missingHint}.`);
      err.code = 'missing_file';
      throw err;
    }
    if (!stat.isFile()) {
      const err = new Error(`Missing ${displayPath}. ${manifest.missingHint}.`);
      err.code = 'missing_file';
      throw err;
    }
    if (stat.size > MAX_ENGINE_LOGIN_FILE_BYTES) {
      const err = new Error(`${displayPath} is ${stat.size} bytes; maximum is ${MAX_ENGINE_LOGIN_FILE_BYTES} bytes.`);
      err.code = 'file_too_large';
      throw err;
    }
    const content = fsModule.readFileSync(absolutePath, 'utf8');
    files[displayPath] = content;
    summary.push({
      path: displayPath,
      bytes: byteLength(content),
      email: detectedEmailFromContent(content),
    });
  }
  return { payload: { files }, summary };
}

function parseEngineLoginArgs(args = []) {
  const options = {
    provider: '',
    list: false,
    remove: '',
    yes: false,
    json: false,
    computer: false,
    business: '',
    businessFlag: false,
    seat: '',
    seatFlag: false,
    help: false,
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = String(args[i] || '');
    if (arg === '--help' || arg === '-h' || arg === 'help') {
      options.help = true;
      continue;
    }
    if (arg === '--list' || arg === 'list') {
      options.list = true;
      continue;
    }
    if (arg === '--remove' && args[i + 1]) {
      options.remove = String(args[i + 1] || '').trim();
      i += 1;
      continue;
    }
    if (arg.startsWith('--remove=')) {
      options.remove = arg.slice('--remove='.length).trim();
      continue;
    }
    if (arg === '--yes' || arg === '-y') {
      options.yes = true;
      continue;
    }
    if (arg === '--json') {
      options.json = true;
      continue;
    }
    if (arg === '--computer') {
      options.computer = true;
      continue;
    }
    if (arg === '--business' || arg === '-b') {
      options.computer = true;
      options.businessFlag = true;
      const next = args[i + 1] === undefined ? '' : String(args[i + 1] || '');
      if (next && !next.startsWith('--')) {
        options.business = next.trim();
        i += 1;
      }
      continue;
    }
    if (arg.startsWith('--business=')) {
      options.computer = true;
      options.businessFlag = true;
      options.business = arg.slice('--business='.length).trim();
      continue;
    }
    if (arg === '--seat') {
      options.seatFlag = true;
      const next = args[i + 1] === undefined ? '' : String(args[i + 1] || '');
      if (next && !next.startsWith('--')) {
        options.seat = normalizeEngineLoginSeat(next);
        i += 1;
      }
      continue;
    }
    if (arg.startsWith('--seat=')) {
      options.seatFlag = true;
      options.seat = normalizeEngineLoginSeat(arg.slice('--seat='.length));
      continue;
    }
    if (arg.startsWith('--')) continue;
    if (!options.provider) options.provider = arg;
  }
  return options;
}

function parseEngineSeedArgs(args = []) {
  const options = {
    provider: '',
    business: '',
    user: false,
    json: false,
    help: false,
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = String(args[i] || '');
    if (arg === '--help' || arg === '-h' || arg === 'help') {
      options.help = true;
      continue;
    }
    if ((arg === '--business' || arg === '-b') && args[i + 1]) {
      options.business = String(args[i + 1] || '').trim();
      i += 1;
      continue;
    }
    if (arg.startsWith('--business=')) {
      options.business = arg.slice('--business='.length).trim();
      continue;
    }
    if (arg === '--user') {
      options.user = true;
      continue;
    }
    if (arg === '--json') {
      options.json = true;
      continue;
    }
    if (arg.startsWith('--')) continue;
    if (!options.provider) options.provider = arg;
  }
  return options;
}

function printEngineLoginHelp() {
  console.log('\n  atris engine login <provider> --yes\n                           upload a local whitelisted engine login to the Atris vault\n  atris engine login <provider> --computer [--seat <name>]\n                           sign in on one of your Atris computers by device flow\n  atris engine login <provider> --business <id> [--seat <name>]\n                           sign in on a business Atris computer by device flow\n  atris engine login --list\n                           list vaulted engine logins\n  atris engine login --remove <provider>\n                           remove a vaulted engine login\n  providers: codex, claude, cursor, devin, grok\n');
}

function printEngineSeedHelp() {
  console.log('\n  atris engine seed <provider> --business <id>\n  atris engine seed <provider> --user\n                           ask the backend to seed a vaulted login onto a computer\n');
}

function redactBackendResponse(value, parentKey = '') {
  if (value == null) return value;
  if (Array.isArray(value)) return value.map((item) => redactBackendResponse(item, parentKey));
  if (typeof value !== 'object') {
    if (/api[_-]?key|token|secret|credential|auth|files?/i.test(parentKey)) return '[redacted]';
    return value;
  }
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    if (/api[_-]?key|token|secret|credential|auth/i.test(key)) {
      output[key] = '[redacted]';
    } else if (key === 'files' && item && typeof item === 'object') {
      output[key] = Object.fromEntries(Object.keys(item).map((filePath) => [filePath, '[redacted]']));
    } else {
      output[key] = redactBackendResponse(item, key);
    }
  }
  return output;
}

function printBackendResult(result, { json = false } = {}) {
  const data = result && result.data !== undefined && result.data !== null
    ? result.data
    : { ok: Boolean(result && result.ok), status: result && result.status };
  const safe = redactBackendResponse(data);
  if (json || typeof safe === 'object') {
    console.log(JSON.stringify(safe, null, 2));
  } else {
    console.log(String(safe));
  }
}

function printLoginSummary(provider, summary) {
  console.log('');
  console.log(`  engine login: ${provider}`);
  for (const item of summary) {
    const email = item.email ? ` email: ${item.email}` : '';
    console.log(`  ${item.path.padEnd(32)} ${String(item.bytes).padStart(6)} bytes${email}`);
  }
  console.log('');
}

function readLineNoEcho(question) {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) {
      let data = '';
      process.stdout.write(question);
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (chunk) => { data += chunk; });
      process.stdin.on('end', () => resolve(data.trim()));
      process.stdin.on('error', () => resolve(''));
      process.stdin.resume();
      return;
    }

    const muted = new Writable({
      write(chunk, encoding, callback) {
        if (!muted.muted) process.stdout.write(chunk, encoding);
        callback();
      },
    });
    const rl = readline.createInterface({ input: process.stdin, output: muted, terminal: true });
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(String(answer || '').trim());
    });
    muted.muted = true;
  });
}

function readLineVisible(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(String(answer || '').trim());
    });
  });
}

async function promptApiKey(provider, deps = {}) {
  if (typeof deps.promptSecret === 'function') {
    return String(await deps.promptSecret(provider) || '').trim();
  }
  return readLineNoEcho(`Paste ${provider} API key: `);
}

async function confirmEngineLoginUpload(provider, deps = {}) {
  if (typeof deps.confirmUpload === 'function') {
    return Boolean(await deps.confirmUpload(provider));
  }
  const answer = await readLineVisible('Upload this credential to the Atris backend vault? [y/N] ');
  return /^y(es)?$/i.test(answer);
}

async function authenticatedEngineApi(pathname, options, deps = {}) {
  const apiFn = deps.apiRequestJson || apiRequestJson;
  const ensureFn = deps.ensureValidCredentials || ensureValidCredentials;
  const ensured = await ensureFn(apiFn);
  if (ensured.error) {
    return {
      ok: false,
      status: 0,
      data: null,
      error: ensured.detail || ensured.error || 'not_logged_in',
      authError: true,
    };
  }
  const token = ensured.credentials && ensured.credentials.token;
  return apiFn(pathname, {
    ...options,
    token,
  });
}

async function listEngineLogins(deps = {}) {
  return authenticatedEngineApi('/engines/logins', {
    method: 'GET',
    timeoutMs: 15000,
    retries: 0,
  }, deps);
}

async function listEngineSeats(deps = {}) {
  return authenticatedEngineApi('/engines/logins/seats', {
    method: 'GET',
    timeoutMs: 15000,
    retries: 0,
  }, deps);
}

async function readyCheckEngineLogin(provider, target, deps = {}) {
  return authenticatedEngineApi(`/engines/logins/${encodeURIComponent(provider)}/ready-check`, {
    method: 'POST',
    body: { target },
    timeoutMs: 30000,
    retries: 0,
  }, deps);
}

function formatEngineSeats(data, now = Date.now()) {
  const seats = Array.isArray(data?.seats) ? data.seats : [];
  if (!seats.length) return 'No accounts linked yet. Run: atris computer setup';

  const nowValue = now instanceof Date ? now.getTime() : Number(now);
  const nowSeconds = Number.isFinite(nowValue) ? nowValue / 1000 : Date.now() / 1000;
  return seats.map((seat) => {
    const engine = String(seat?.engine || 'engine').trim().toLowerCase();
    const name = String(seat?.name || 'account').trim().toLowerCase();
    const coolingUntil = Number(seat?.cooling_until);
    if (!Number.isFinite(coolingUntil) || coolingUntil <= nowSeconds) {
      return `${engine} ${name} - ready`;
    }
    const minutes = Math.ceil((coolingUntil - nowSeconds) / 60);
    const hours = Math.floor(minutes / 60);
    return `${engine} ${name} - cooling down, back ${hours}h ${minutes % 60}m`;
  }).join('\n');
}

async function runEngineSeatsCommand(deps = {}) {
  const result = await listEngineSeats(deps);
  if (!result.ok) {
    console.error(result.authError ? 'Run atris login first.' : `engine seats failed: ${result.error || result.status}`);
    return 1;
  }
  const now = typeof deps.now === 'function' ? deps.now() : Date.now();
  console.log(formatEngineSeats(result.data, now));
  return 0;
}

async function buildEngineLoginPayload(provider, deps = {}) {
  const manifest = ENGINE_LOGIN_MANIFESTS[provider];
  if (!manifest) {
    throw new Error(`Unknown engine login provider "${provider}". Known providers: ${knownLoginProviders().join(', ')}`);
  }

  if (manifest.type === 'api_key') {
    const apiKey = await promptApiKey(provider, deps);
    if (!apiKey) {
      const err = new Error('No API key provided.');
      err.code = 'missing_api_key';
      throw err;
    }
    if (byteLength(apiKey) > MAX_ENGINE_LOGIN_FILE_BYTES) {
      const err = new Error(`API key is ${byteLength(apiKey)} bytes; maximum is ${MAX_ENGINE_LOGIN_FILE_BYTES} bytes.`);
      err.code = 'api_key_too_large';
      throw err;
    }
    return {
      payload: { api_key: apiKey },
      summary: [{ path: 'api key', bytes: byteLength(apiKey), email: '' }],
    };
  }

  return readEngineLoginFiles(provider, deps);
}

function engineDeviceLoginTarget(options) {
  if (options.target) return options.target;
  if (!options.computer) return null;
  if (options.businessFlag && !options.business) {
    const err = new Error('usage: atris engine login <provider> --business <id>');
    err.code = 'usage';
    throw err;
  }
  if (options.business) return { type: 'business', id: options.business };
  return { type: 'user' };
}

function normalizeDeviceLoginStatus(data, provider, sessionId, seat = '') {
  const payload = data && typeof data === 'object' ? data : {};
  return {
    ...payload,
    session_id: payload.session_id || sessionId || '',
    provider: payload.provider || provider,
    ...(payload.seat || seat ? { seat: payload.seat || seat } : {}),
  };
}

function printDeviceLoginCode(status, { json = false } = {}) {
  const lines = [
    '',
    `Sign in: ${status.verify_url}`,
    `Code:    ${status.code}   (expires in 15 minutes; never share this code)`,
    '',
  ];
  for (const line of lines) {
    if (json) console.error(line);
    else console.log(line);
  }
}

function printDeviceLoginCompleted(status, { json = false } = {}) {
  if (json) {
    console.log(JSON.stringify(status, null, 2));
    return;
  }
  const registered = status.registered === true ? 'true' : status.registered === false ? 'false' : String(status.registered ?? '');
  console.log('');
  console.log(`engine login ready: ${status.provider}`);
  if (status.seat) console.log(`seat: ${status.seat}`);
  console.log(`account_email: ${status.account_email || '(none)'}`);
  console.log(`registered: ${registered}`);
  console.log(`ready-check: provider=${status.provider} session_id=${status.session_id || ''} status=${status.status} registered=${registered}`);
  console.log('');
}

function printDeviceLoginFinalJson(status, options) {
  if (options.json) console.log(JSON.stringify(status, null, 2));
}

async function waitForDeviceLoginPoll(ms, deps = {}) {
  if (typeof deps.sleep === 'function') return deps.sleep(ms);
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readDeviceLoginPasteBackCode(deps = {}) {
  const readlineDep = deps.readline || readline;
  const input = deps.stdin || process.stdin;
  const output = deps.stdout || process.stdout;
  const rl = readlineDep.createInterface({ input, output });
  try {
    return String(await new Promise((resolve) => rl.question('', resolve)) || '').trim();
  } finally {
    rl.close();
  }
}

async function runEngineDeviceLoginCommand(provider, options, deps = {}) {
  let target;
  let seat;
  try {
    target = engineDeviceLoginTarget(options);
    seat = normalizeEngineLoginSeat(options.seat);
    if ((options.seatFlag || options.seat) && !validEngineLoginSeat(seat)) {
      const err = new Error(engineLoginSeatError());
      err.code = 'usage';
      throw err;
    }
  } catch (err) {
    console.error(err.message);
    return 2;
  }

  const body = seat ? { target, seat } : { target };
  const started = await authenticatedEngineApi(`/engines/logins/${encodeURIComponent(provider)}/device-login`, {
    method: 'POST',
    body,
    timeoutMs: 30000,
    retries: 0,
  }, deps);
  if (!started.ok) {
    console.error(options.setup
      ? `could not connect the ${provider} account; please try again.`
      : (started.authError ? 'Run atris login first.' : `engine login device flow failed: ${started.error || started.status}`));
    return 1;
  }

  const startStatus = normalizeDeviceLoginStatus(started.data, provider, '', seat);
  const sessionId = startStatus.session_id;
  if (!sessionId) {
    console.error(options.setup
      ? `could not connect the ${provider} account; please try again.`
      : 'engine login device flow failed: missing session_id');
    return 1;
  }

  let finalStatus = startStatus;
  let codePrinted = false;
  let pasteBackSubmitted = false;
  const pollMs = Math.max(1, Number(deps.deviceLoginPollMs ?? ENGINE_DEVICE_LOGIN_POLL_MS));
  const timeoutMs = Math.max(0, Number(deps.deviceLoginTimeoutMs ?? ENGINE_DEVICE_LOGIN_TIMEOUT_MS));
  const maxPolls = Math.ceil(timeoutMs / pollMs);

  for (let attempt = 0; attempt <= maxPolls; attempt += 1) {
    const polled = await authenticatedEngineApi(`/engines/logins/device-login/${encodeURIComponent(sessionId)}`, {
      method: 'GET',
      timeoutMs: 30000,
      retries: 0,
    }, deps);
    if (!polled.ok) {
      console.error(options.setup
        ? `could not connect the ${provider} account; please try again.`
        : (polled.authError ? 'Run atris login first.' : `engine login device poll failed: ${polled.error || polled.status}`));
      return 1;
    }

    finalStatus = normalizeDeviceLoginStatus(polled.data, provider, sessionId, seat);
    const status = String(finalStatus.status || '').toLowerCase();
    if (!codePrinted && finalStatus.verify_url && finalStatus.code) {
      if (options.setup) {
        console.log(`On your phone, open: ${finalStatus.verify_url}  and type the code: ${finalStatus.code}`);
      } else {
        printDeviceLoginCode(finalStatus, { json: options.json });
      }
      codePrinted = true;
    }

    const pasteBackRequired = !pasteBackSubmitted
      && status === 'pending_user'
      && finalStatus.verify_url
      && !finalStatus.code
      && String(finalStatus.provider || provider).toLowerCase() === 'claude';
    if (pasteBackRequired) {
      const printPrompt = options.json ? console.error : console.log;
      printPrompt(`On your phone, open: ${finalStatus.verify_url}`);
      let submitted = false;
      for (let submitAttempt = 0; submitAttempt < 2; submitAttempt += 1) {
        printPrompt('When the browser shows you a code, paste it here:');
        const pastedCode = await readDeviceLoginPasteBackCode(deps);
        const codeResult = await authenticatedEngineApi(
          `/engines/logins/device-login/${encodeURIComponent(sessionId)}/code`,
          {
            method: 'POST',
            body: { code: pastedCode },
            timeoutMs: 30000,
            retries: 0,
          },
          deps
        );
        if (codeResult.ok) {
          submitted = true;
          pasteBackSubmitted = true;
          break;
        }
        if (submitAttempt === 0) {
          console.error('that code did not work; paste it again.');
        } else {
          console.error('that code did not work; please start the login again.');
        }
      }
      if (!submitted) return 1;
    }

    if (status === 'completed') {
      if (options.setup) console.log(`${seat} linked.`);
      else printDeviceLoginCompleted(finalStatus, { json: options.json });
      return 0;
    }
    if (status === 'failed' || status === 'expired') {
      if (options.setup) {
        console.error(`could not connect the ${provider} account; please try again.`);
      } else {
        printDeviceLoginFinalJson(finalStatus, options);
        console.error(`engine login device flow ended: ${status}`);
      }
      return 1;
    }

    if (attempt < maxPolls) await waitForDeviceLoginPoll(pollMs, deps);
  }

  finalStatus = {
    ...finalStatus,
    status: 'timeout',
    error: `device login did not complete within ${Math.round(timeoutMs / 60000)} minutes`,
  };
  if (options.setup) {
    console.error(`could not connect the ${provider} account; please try again.`);
  } else {
    printDeviceLoginFinalJson(finalStatus, options);
    console.error('engine login device flow timed out');
  }
  return 1;
}

async function runEngineLoginCommand(args, root, deps = {}) {
  const options = parseEngineLoginArgs(args);
  if (options.help) {
    printEngineLoginHelp();
    return 0;
  }

  if (options.list) {
    const result = await listEngineLogins(deps);
    if (!result.ok) {
      console.error(result.authError ? 'Run atris login first.' : `engine login list failed: ${result.error || result.status}`);
      return 1;
    }
    printBackendResult(result, { json: options.json });
    return 0;
  }

  if (options.remove) {
    const provider = normalizeLoginProvider(options.remove);
    if (!provider) {
      console.error(`Unknown engine login provider "${options.remove}". Known providers: ${knownLoginProviders().join(', ')}`);
      return 2;
    }
    const result = await authenticatedEngineApi(`/engines/logins/${encodeURIComponent(provider)}`, {
      method: 'DELETE',
      timeoutMs: 15000,
      retries: 0,
    }, deps);
    if (!result.ok) {
      console.error(result.authError ? 'Run atris login first.' : `engine login remove failed: ${result.error || result.status}`);
      return 1;
    }
    printBackendResult(result, { json: options.json });
    return 0;
  }

  const provider = normalizeLoginProvider(options.provider);
  if (!provider) {
    console.error(`usage: atris engine login <provider> --yes; providers: ${knownLoginProviders().join(', ')}`);
    return 2;
  }

  if (options.seatFlag && !options.computer) {
    console.error('use --seat with --computer or --business');
    return 2;
  }

  if (options.computer) {
    return runEngineDeviceLoginCommand(provider, options, deps);
  }

  let built;
  try {
    built = await buildEngineLoginPayload(provider, deps);
  } catch (err) {
    console.error(err.message);
    return err.code === 'missing_file' || err.code === 'missing_api_key' ? 1 : 2;
  }

  printLoginSummary(provider, built.summary);
  if (!options.yes) {
    const confirmed = await confirmEngineLoginUpload(provider, deps);
    if (!confirmed) {
      console.error('engine login upload cancelled');
      return 1;
    }
  }

  const result = await authenticatedEngineApi(`/engines/logins/${encodeURIComponent(provider)}`, {
    method: 'POST',
    body: built.payload,
    timeoutMs: 30000,
    retries: 0,
  }, deps);
  if (!result.ok) {
    console.error(result.authError ? 'Run atris login first.' : `engine login upload failed: ${result.error || result.status}`);
    return 1;
  }
  printBackendResult(result, { json: options.json });
  return 0;
}

async function runEngineSeedCommand(args, root, deps = {}) {
  const options = parseEngineSeedArgs(args);
  if (options.help) {
    printEngineSeedHelp();
    return 0;
  }

  const provider = normalizeLoginProvider(options.provider);
  if (!provider) {
    console.error(`usage: atris engine seed <provider> --business <id>|--user; providers: ${knownLoginProviders().join(', ')}`);
    return 2;
  }
  if ((options.business && options.user) || (!options.business && !options.user)) {
    console.error('usage: atris engine seed <provider> --business <id>|--user');
    return 2;
  }

  const body = options.user
    ? { target: { type: 'user' } }
    : { target: { type: 'business', id: options.business } };
  const result = await authenticatedEngineApi(`/engines/logins/${encodeURIComponent(provider)}/seed`, {
    method: 'POST',
    body,
    timeoutMs: 60000,
    retries: 0,
  }, deps);
  if (!result.ok) {
    console.error(result.authError ? 'Run atris login first.' : `engine seed failed: ${result.error || result.status}`);
    return 1;
  }
  printBackendResult(result, { json: options.json });
  return 0;
}

function printRoster(root) {
  const list = roster(root);
  const found = list.filter((e) => e.installed).length;
  const current = resolveDefaultEngine(root);
  console.log('');
  console.log(`  engines: ${found} intelligence${found === 1 ? '' : 's'} found`);
  console.log('');
  for (const engine of list) {
    const mark = engine.default ? '→' : ' ';
    const state = engine.health.status === 'not_installed' ? 'not installed' : engine.health.status.replace(/_/g, ' ');
    const roles = engine.roles.join(',');
    console.log(`  ${mark} ${engine.id.padEnd(12)} ${state.padEnd(13)} ${engine.tier.padEnd(4)} ${roles}`);
    const details = [`models: ${engine.models.join(', ')}`];
    if (engine.duty) details.push(`duty: ${engine.duty}`);
    console.log(`      ${details.join('   ')}`);
  }
  console.log('');
  console.log(`  default: ${current.name}${current.source === 'saved' ? ' (set here)' : current.source === 'env' ? ' (this session)' : ''}`);
  console.log(`  switch:  atris engine <name>   ·   one run: --engine <name> on mission run / autopilot / run`);
  console.log('');
}

function chartEngineLabel(engine) {
  const id = String(engine && (engine.id || engine.name) || '').trim();
  const models = Array.isArray(engine && engine.models)
    ? engine.models.map((model) => String(model || '').trim()).filter(Boolean)
    : [];
  return models.length ? `${id}: ${models.join(', ')}` : id;
}

function chartBox(title, engines, note = '', emptyLabel = 'unassigned') {
  const labels = engines.length ? engines.map(chartEngineLabel) : (emptyLabel ? [emptyLabel] : []);
  const body = [title, ...labels, ...(note ? [note] : [])];
  const innerWidth = Math.max(...body.map((line) => line.length)) + 2;
  return {
    width: innerWidth + 2,
    lines: [
      `┌${'─'.repeat(innerWidth)}┐`,
      ...body.map((line) => `│ ${line.padEnd(innerWidth - 2)} │`),
      `└${'─'.repeat(innerWidth)}┘`,
    ],
  };
}

function centerChartLine(line, width, center = Math.floor((width - 1) / 2)) {
  const left = Math.max(0, center - Math.floor(line.length / 2));
  return `${' '.repeat(left)}${line}`.padEnd(width);
}

function renderEngineChart(registry) {
  const engines = Array.isArray(registry) ? registry : ((registry && registry.engines) || []);
  const specialDuties = new Set(ENGINE_DUTIES);
  const leaders = engines.filter((entry) => entry.duty === 'leader');
  const rolePool = engines.filter((entry) => !specialDuties.has(entry.duty));
  const builders = rolePool.filter((entry) => Array.isArray(entry.roles) && entry.roles.includes('executor'));
  const checkers = rolePool.filter((entry) => Array.isArray(entry.roles) && entry.roles.includes('validator'));
  const errands = engines.filter((entry) => entry.duty === 'errands');
  const apprentices = engines.filter((entry) => entry.duty === 'learning');

  const ownerBox = chartBox('owner', [], '', '');
  const leaderBox = chartBox('leader', leaders);
  const columns = [
    chartBox('builders', builders),
    chartBox('checkers', checkers),
    chartBox('errands', errands),
  ];
  const gap = 3;
  const totalWidth = columns.reduce((sum, column) => sum + column.width, 0) + (gap * (columns.length - 1));
  const columnHeight = Math.max(...columns.map((column) => column.lines.length));
  const columnLines = [];
  for (let row = 0; row < columnHeight; row += 1) {
    columnLines.push(columns.map((column) => (column.lines[row] || '').padEnd(column.width)).join(' '.repeat(gap)));
  }

  const centers = [];
  let offset = 0;
  for (const column of columns) {
    centers.push(offset + Math.floor(column.width / 2));
    offset += column.width + gap;
  }
  const fleetCenter = centers[1];
  const branch = Array(totalWidth).fill(' ');
  for (let i = centers[0]; i <= centers[centers.length - 1]; i += 1) branch[i] = '─';
  branch[centers[0]] = '┌';
  branch[centers[centers.length - 1]] = '┐';
  for (const center of centers.slice(1, -1)) branch[center] = '┬';
  branch[fleetCenter] = centers.includes(fleetCenter) ? '┼' : '┴';
  const stems = Array(totalWidth).fill(' ');
  for (const center of centers) stems[center] = '│';

  const lines = [
    ...ownerBox.lines.map((line) => centerChartLine(line, totalWidth, fleetCenter)),
    centerChartLine('│', totalWidth, fleetCenter),
    ...leaderBox.lines.map((line) => centerChartLine(line, totalWidth, fleetCenter)),
    centerChartLine('│', totalWidth, fleetCenter),
    branch.join(''),
    stems.join(''),
    ...columnLines,
  ];
  if (apprentices.length) {
    const apprenticeBox = chartBox('apprentice', apprentices, 'learning the system');
    lines.push(centerChartLine('│', totalWidth, fleetCenter));
    lines.push(...apprenticeBox.lines.map((line) => centerChartLine(line, totalWidth, fleetCenter)));
  }
  return lines.map((line) => line.replace(/\s+$/, '')).join('\n');
}

function printEngineChart(root) {
  console.log(renderEngineChart(readEngineRegistry(root)));
}

function flagValue(args, flag) {
  const equals = `${flag}=`;
  for (let i = 0; i < args.length; i += 1) {
    const value = String(args[i] || '');
    if (value === flag) return { present: true, value: args[i + 1] || '' };
    if (value.startsWith(equals)) return { present: true, value: value.slice(equals.length) };
  }
  return { present: false, value: '' };
}

function runSetEngineCommand(args, root) {
  const name = String(args[0] || '').trim();
  const dutyFlag = flagValue(args.slice(1), '--duty');
  const modelsFlag = flagValue(args.slice(1), '--models');
  const duty = String(dutyFlag.value || '').trim();
  const models = String(modelsFlag.value || '').split(',').map((model) => model.trim()).filter(Boolean);
  if (!name || (!dutyFlag.present && !modelsFlag.present)) {
    console.error('usage: atris engine set <name> [--duty leader|errands|learning] [--models "a, b"]');
    return 2;
  }
  if (dutyFlag.present && !ENGINE_DUTIES.includes(duty)) {
    console.error(`unknown duty "${duty}". known duties: ${ENGINE_DUTIES.join(', ')}`);
    return 2;
  }
  if (modelsFlag.present && !models.length) {
    console.error('models must include at least one name');
    return 2;
  }
  try {
    const updated = setEngineOverrides(name, {
      ...(dutyFlag.present ? { duty } : {}),
      ...(modelsFlag.present ? { models } : {}),
    }, root);
    const details = [];
    if (updated.duty) details.push(`duty ${updated.duty}`);
    if (updated.models) details.push(`models ${updated.models.join(', ')}`);
    console.log(`${updated.id} updated: ${details.join('; ')}`);
    return 0;
  } catch (err) {
    console.error(String(err.message || err).replace(/^Unknown/, 'unknown'));
    return 2;
  }
}

function registryPayload(root) {
  const current = resolveDefaultEngine(root);
  const registry = readEngineRegistry(root);
  return {
    default: current.name,
    source: current.source,
    engines: registry.engines.map((engine) => ({
      ...engine,
      default: engine.id === current.name,
    })),
  };
}

function parseSetFlag(args) {
  const prefix = '--set=';
  for (let i = 0; i < args.length; i += 1) {
    const arg = String(args[i]);
    if (arg === '--set') return args[i + 1] || '';
    if (arg.startsWith(prefix)) return arg.slice(prefix.length);
  }
  return '';
}

function runResolveCommand(args, root) {
  const json = args.includes('--json');
  const role = args.filter((a) => !String(a).startsWith('--'))[0] || '';
  if (!role) {
    const message = `usage: atris engine resolve <role>; roles: ${ENGINE_ROLES.join(', ')}`;
    if (json) console.log(JSON.stringify({ ok: false, error: message }, null, 2));
    else console.error(message);
    return 2;
  }
  let picked;
  try {
    picked = resolveEngineForRoleRanked(role, root);
  } catch (err) {
    if (json) console.log(JSON.stringify({ ok: false, error: err.message }, null, 2));
    else console.error(err.message);
    return 2;
  }
  const engine = picked.engine;
  if (!engine) {
    const message = `No ready installed engine can fill role "${role}".`;
    if (json) console.log(JSON.stringify({ ok: false, role, error: message, won_reason: picked.reason }, null, 2));
    else console.error(message);
    return 1;
  }
  if (json) console.log(JSON.stringify({ ...engine, won_reason: picked.reason }, null, 2));
  else {
    console.error(picked.reason);
    console.log(engine.id);
  }
  return 0;
}

// Doctor is the one opt-in place that probes the machine: it checks every
// engine binary, reports installed state, and folds ready/not_installed flips
// back into the policy file. Routing itself never probes.
function runDoctorCommand(args, root) {
  const json = args.includes('--json');
  const engines = engineDoctorReport(root);
  if (json) {
    console.log(JSON.stringify({ ok: true, engines }, null, 2));
    return 0;
  }
  console.log('');
  for (const engine of engines) {
    const state = engine.installed ? 'installed' : 'missing';
    const health = engine.health.status.replace(/_/g, ' ');
    console.log(`  ${engine.id.padEnd(12)} ${String(engine.bin).padEnd(14)} ${state.padEnd(10)} health: ${health}`);
  }
  console.log('');
  console.log('  probed just now and saved to the registry; routing reads that saved policy, never the machine.');
  console.log('');
  return 0;
}

function runHealthCommand(args, root) {
  const json = args.includes('--json');
  const positional = args.filter((a) => !String(a).startsWith('--'));
  const name = positional[0] || '';
  const status = parseSetFlag(args);
  if (!name || !status) {
    const message = `usage: atris engine health <name> --set <status>; statuses: ${ENGINE_HEALTH_STATUSES.join(', ')}`;
    if (json) console.log(JSON.stringify({ ok: false, error: message }, null, 2));
    else console.error(message);
    return 2;
  }
  try {
    const engine = setEngineHealth(name, status, root);
    if (json) console.log(JSON.stringify(engine, null, 2));
    else console.log(`engine ${engine.id} health: ${engine.health.status}`);
    return 0;
  } catch (err) {
    if (json) console.log(JSON.stringify({ ok: false, error: err.message }, null, 2));
    else console.error(err.message);
    return 2;
  }
}

// Preflight: run one engine CLI headless with a reply-OK prompt and report
// pass/fail. A dead login, missing binary, or hung spawn is a one-command
// diagnosis instead of a failed overnight flight. `name` is canonical.
const PROBE_PROMPT = 'Reply with exactly the two characters: OK';
// Real engines think before replying: cursor measured at ~68s for a one-word
// answer on 2026-07-02. 30s produced a false FAIL on a healthy engine.
const PROBE_DEFAULT_TIMEOUT_MS = 120000;

function probeEngine(name, { timeout = PROBE_DEFAULT_TIMEOUT_MS } = {}) {
  const def = RUNNER_PROFILE_DEFS[name];
  if (!binInstalled(def.bin)) {
    return {
      engine: name,
      bin: def.bin,
      pass: false,
      reason: 'not-installed',
      message: `${def.bin} CLI not installed`,
      stdout: '',
      stderr: '',
      durationMs: 0,
    };
  }
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-engine-probe-'));
  const promptFile = path.join(tmpDir, 'prompt.txt');
  fs.writeFileSync(promptFile, `${PROBE_PROMPT}\n`);
  let cmd;
  const prevProfile = process.env.ATRIS_RUNNER_PROFILE;
  process.env.ATRIS_RUNNER_PROFILE = name;
  try {
    cmd = buildRunnerCommand({ promptFile });
  } finally {
    if (prevProfile === undefined) delete process.env.ATRIS_RUNNER_PROFILE;
    else process.env.ATRIS_RUNNER_PROFILE = prevProfile;
  }
  const start = Date.now();
  let res;
  try {
    res = spawnSync('sh', ['-c', cmd], { encoding: 'utf8', timeout });
  } catch (err) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    return {
      engine: name,
      bin: def.bin,
      pass: false,
      reason: 'spawn-error',
      message: String(err && err.message ? err.message : err),
      stdout: '',
      stderr: '',
      durationMs: Date.now() - start,
    };
  }
  const durationMs = Date.now() - start;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  const stdout = res.stdout || '';
  const stderr = res.stderr || '';
  const timedOut = res.status === null && Boolean(res.signal) && String(res.signal).toLowerCase().includes('term');
  const combined = `${stdout}\n${stderr}`.trim();
  const ok = res.status === 0 && /OK/i.test(combined);
  let reason;
  if (ok) reason = 'ok';
  else if (timedOut) reason = 'timeout';
  else if (res.status !== 0 && res.status !== null) reason = 'bad-exit';
  else if (!/OK/i.test(combined)) reason = 'no-ok';
  else reason = 'unknown';
  return {
    engine: name,
    bin: def.bin,
    pass: ok,
    reason,
    message: ok
      ? 'responded OK'
      : (timedOut ? `no reply within ${timeout}ms` : `did not reply OK (exit ${res.status}, signal ${res.signal})`),
    stdout,
    stderr,
    durationMs,
  };
}

// A probe is a real engine round trip on the same command shape dispatches
// use, so its pass/fail and latency are routing evidence. Record one receipt
// per role the engine serves so the router brain (lib/router-brain.js) can
// learn from every preflight. Liveness evidence only: real build outcomes
// land in the same pool via task receipts and outweigh probes over time.
function writeProbeReceipt(result, root = process.cwd()) {
  const runsDir = path.join(root, 'atris', 'runs');
  fs.mkdirSync(runsDir, { recursive: true });
  let roles = [];
  try {
    const engine = engineRegistryView(root).find((row) => row.id === result.engine);
    roles = engine && Array.isArray(engine.roles) ? engine.roles : [];
  } catch { /* registry unavailable: still record the probe */ }
  if (!roles.length) roles = ['executor'];
  const at = new Date().toISOString();
  const stampMs = Date.now();
  for (const role of roles) {
    const receipt = {
      schema: 'atris.engine_probe_receipt.v1',
      engine: result.engine,
      task_type: role,
      verified_passed: Boolean(result.pass),
      duration_ms: result.durationMs,
      reason: result.reason,
      at,
    };
    const file = path.join(runsDir, `engine-probe-task-${result.engine}-${role}-${stampMs}.json`);
    fs.writeFileSync(file, `${JSON.stringify(receipt, null, 2)}\n`);
  }
}

function runEngineTest(targets, { json, root } = {}) {
  let enginesToTest;
  if (targets && targets.length) {
    enginesToTest = targets.map((n) => {
      const c = canonicalEngineName(n);
      if (!c) {
        throw new Error(`Unknown engine "${n}". Known engines: ${RUNNER_PROFILE_NAMES.join(', ')}`);
      }
      return c;
    });
  } else {
    enginesToTest = RUNNER_PROFILE_NAMES.filter((n) => binInstalled(RUNNER_PROFILE_DEFS[n].bin));
    if (!enginesToTest.length) {
      if (json) {
        console.log(JSON.stringify({ ok: false, results: [], summary: { pass: 0, fail: 0 } }, null, 2));
      } else {
        console.error('\n  no installed engines to test\n');
      }
      return 1;
    }
  }
  const results = enginesToTest.map((name) => probeEngine(name));
  const failures = results.filter((r) => !r.pass);
  const passed = results.length - failures.length;
  // A live probe is the freshest health evidence there is: write it back so
  // a transient failure does not leave an engine stuck on error forever.
  for (const r of results) {
    try { setEngineHealth(r.engine, r.pass ? 'ready' : 'error', root); } catch { /* best-effort */ }
    if (r.reason !== 'not-installed') {
      try { writeProbeReceipt(r, root); } catch { /* best-effort */ }
    }
  }
  if (json) {
    console.log(JSON.stringify({
      ok: failures.length === 0,
      results,
      summary: { pass: passed, fail: failures.length },
    }, null, 2));
  } else {
    console.log('');
    for (const r of results) {
      const mark = r.pass ? '✓' : '✗';
      const line = r.pass
        ? `  ${mark} ${r.engine.padEnd(12)} pass — ${r.message} (${r.durationMs}ms)`
        : `  ${mark} ${r.engine.padEnd(12)} FAIL — ${r.message}`;
      if (r.pass) console.log(line);
      else console.error(line);
    }
    console.log('');
    if (failures.length) {
      console.error(`  ${failures.length} engine${failures.length === 1 ? '' : 's'} failed: ${failures.map((f) => f.engine).join(', ')}`);
      console.error(`  fix the login/binary, then re-run: atris engine test${targets && targets.length ? ' ' + targets.join(' ') : ''}`);
    } else {
      console.log(`  all engines responded — clear for flight`);
    }
    console.log('');
  }
  return failures.length ? 1 : 0;
}

// One-command dispatch: claim -> worktree start -> bounded prompt -> engine
// -> re-run Check: -> ship -> task ready, in one call instead of the 6
// hand-rolled Bash calls per task the manual version took. Task ids are
// positional; --engine/--prompt-file are the only flags, so parse by hand
// instead of the generic "anything starting with --" split used above (that
// split would swallow an --engine value like "cursor" as a task id).
function parseDispatchArgs(args) {
  const taskIds = [];
  let engine = '';
  let promptFile = '';
  let base = '';
  let json = false;
  let yolo = false;
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--engine') { engine = args[i + 1] || ''; i += 1; continue; }
    if (a.startsWith('--engine=')) { engine = a.slice('--engine='.length); continue; }
    if (a === '--prompt-file') { promptFile = args[i + 1] || ''; i += 1; continue; }
    if (a.startsWith('--prompt-file=')) { promptFile = a.slice('--prompt-file='.length); continue; }
    if (a === '--base') { base = args[i + 1] || ''; i += 1; continue; }
    if (a.startsWith('--base=')) { base = a.slice('--base='.length); continue; }
    if (a === '--json') { json = true; continue; }
    if (a === '--yolo') { yolo = true; continue; }
    if (a.startsWith('--')) continue;
    taskIds.push(a);
  }
  return { taskIds, engine, promptFile, base, json, yolo };
}

function runDispatchCommand(args, root) {
  const { taskIds, engine, promptFile, base, json, yolo } = parseDispatchArgs(args);
  if (!taskIds.length || !engine) {
    console.error('usage: atris engine dispatch <task-id> [<task-id> ...] --engine cursor|codex [--prompt-file <f>] [--yolo]');
    return 2;
  }
  const canonical = canonicalEngineName(engine);
  if (!canonical || !FLEET_CAPABLE.includes(canonical)) {
    console.error(`engine dispatch: --engine must be one of ${FLEET_CAPABLE.join(', ')}`);
    return 2;
  }
  // Argument-shape errors surface before environment errors: --prompt-file
  // with multiple ids is wrong on any machine, installed CLI or not.
  let promptOverride = '';
  if (promptFile) {
    if (taskIds.length > 1) {
      console.error('engine dispatch: --prompt-file only supports a single task id');
      return 2;
    }
    try {
      promptOverride = fs.readFileSync(promptFile, 'utf8');
    } catch (err) {
      console.error(`engine dispatch: could not read --prompt-file ${promptFile}: ${err.message}`);
      return 2;
    }
  }
  // Execution stage: this is where the binary must exist. Routing above never
  // probed the machine; a missing CLI fails loudly here instead.
  try {
    requireEngineBin(canonical);
  } catch (err) {
    console.error(`engine dispatch: ${err.message}`);
    return 2;
  }
  return runDispatchFlight({ root, taskIds, engine: canonical, prompt: promptOverride, yolo, ...(base ? { checkoutBase: base } : {}) }).then((flight) => {
    if (json) console.log(JSON.stringify(flight, null, 2));
    return flight.paused.length ? 1 : 0;
  });
}

function engineCommand(args = [], deps = {}) {
  const root = process.cwd();
  if ((args[0] || '').trim() === 'dispatch') {
    return runDispatchCommand(args.slice(1), root);
  }

  const json = args.includes('--json');
  const positional = args.filter((a) => !a.startsWith('--'));
  const sub = (positional[0] || '').trim();

  if (sub === 'login') {
    return runEngineLoginCommand(args.slice(args.indexOf('login') + 1), root);
  }

  if (sub === 'seed') {
    return runEngineSeedCommand(args.slice(args.indexOf('seed') + 1), root);
  }

  if (sub === 'seats') {
    return runEngineSeatsCommand(deps);
  }

  if (sub === 'test') {
    return runEngineTest(positional.slice(1), { json, root });
  }

  if (sub === 'resolve') {
    return runResolveCommand(args.slice(args.indexOf('resolve') + 1), root);
  }

  if (sub === 'health') {
    return runHealthCommand(args.slice(args.indexOf('health') + 1), root);
  }

  if (sub === 'doctor') {
    return runDoctorCommand(args.slice(args.indexOf('doctor') + 1), root);
  }

  if (sub === 'set') {
    return runSetEngineCommand(args.slice(args.indexOf('set') + 1), root);
  }

  if (sub === 'chart' || args.includes('--chart')) {
    printEngineChart(root);
    return 0;
  }

  if (!sub || sub === 'list' || sub === 'status') {
    if (json) {
      console.log(JSON.stringify(registryPayload(root), null, 2));
      return 0;
    }
    printRoster(root);
    return 0;
  }

  if (sub === 'reset' || sub === 'off') {
    const removed = resetEngine(root);
    console.log(removed
      ? `\n  default engine reset — back to ${resolveDefaultEngine(root).name}\n`
      : `\n  nothing to reset — no engine was set here\n`);
    return 0;
  }

  if (sub === 'help') {
    console.log('\n  atris engine            roster + current default\n  atris engines --chart   show the fleet as an org chart\n  atris engine list --json full registry: default + engines with tier, roles, fallback, health\n  atris engine set <name> --duty leader|errands|learning [--models "a, b"]\n                           arrange the fleet and save its model policy\n  atris engine resolve <role> [--json]\n                           choose the best ready engine for navigator|executor|validator\n  atris engine health <name> --set ready|not_installed|credit_out\n                           flip runtime health, for example when credits run out\n  atris engine doctor [--json]\n                           probe which engine CLIs are installed here and sync that into health policy\n  atris engine <name>     make that engine the default here\n  atris engine test [name] preflight: run the engine CLI headless, report pass/fail\n  atris engine dispatch <task-id> [<task-id> ...] --engine cursor|codex [--prompt-file <f>] [--yolo]\n                           one-command claim, worktree, build, verify, ship, ready\n  atris engine login <provider> --yes\n                           upload a local provider CLI login to the backend vault\n  atris engine login <provider> --computer [--seat <name>]\n  atris engine login <provider> --business <id> [--seat <name>]\n                           sign in on an Atris computer by device flow\n  atris engine login --list | --remove <provider>\n                           list or remove vaulted provider logins\n  atris engine seats       show which named accounts are ready to work\n  atris engine seed <provider> --business <id>|--user\n                           push a vaulted login onto an Atris computer\n  atris engine reset      back to the house default\n  --engine <name>         one run on that engine (mission run / autopilot / run)\n');
    return 0;
  }

  // atris engine <name> — flip the default. An unknown name is a plain user
  // typo, not a crash: report it cleanly (and as JSON on demand) instead of
  // letting setEngine throw a raw stack trace at a new person.
  if (!canonicalEngineName(sub)) {
    const known = RUNNER_PROFILE_NAMES.join(', ');
    if (json) {
      console.log(JSON.stringify({ ok: false, error: `Unknown engine "${sub}"`, known: RUNNER_PROFILE_NAMES }, null, 2));
    } else {
      console.error(`\n  Unknown engine "${sub}". known engines: ${known}`);
      console.error('  run "atris engine" to see the roster, or "atris engine help".\n');
    }
    return 2;
  }
  const canonical = setEngine(sub, root);
  const def = RUNNER_PROFILE_DEFS[canonical];
  const installed = binInstalled(def.bin);
  console.log('');
  console.log(`  default engine: ${canonical}`);
  if (!installed) console.log(`  heads up: its CLI (${def.bin}) is not installed here yet — runs will fail until it is.`);
  console.log(`  every mission run / autopilot / run tick now rides it. one-off: --engine <name>. undo: atris engine reset`);
  console.log('');
  return 0;
}

module.exports = {
  engineCommand,
  resolveDefaultEngine,
  canonicalEngineName,
  readSavedEngine,
  roster,
  engineRegistryFile,
  readEngineRegistry,
  resolveEngineForRole,
  setEngineHealth,
  setEngineOverrides,
  renderEngineChart,
  parseDispatchArgs,
  runDispatchCommand,
  ENGINE_LOGIN_MANIFESTS,
  expandHomePath,
  normalizeLoginProvider,
  normalizeEngineLoginSeat,
  validEngineLoginSeat,
  engineLoginSeatError,
  parseEngineLoginArgs,
  listEngineSeats,
  readyCheckEngineLogin,
  formatEngineSeats,
  runEngineDeviceLoginCommand,
  runEngineLoginCommand,
  runEngineSeedCommand,
  HOUSE_ENGINE,
};
