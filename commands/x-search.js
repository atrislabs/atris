'use strict';

const { apiRequestJson } = require('../utils/api');
const { ensureBilledCommandAuth } = require('./auth');
const applyGate = require('../lib/apply-gate');

const DEFAULT_TIMEOUT_MS = 120000;
const COST_HINT = '5 credits per search';
const APPLY_INCOMPLETE_MESSAGE =
  'x-search incomplete: write one apply (change + receipt) for this query.';

function showXSearchHelp(output = console.log, commandName = 'atris x-search') {
  output('');
  output(`Usage: ${commandName} "<query>" [--limit N] [--days N] [--json]`);
  output(`       ${commandName} person --name <name> [--handle <h>] [--company <c>] [--context <text>] [--json]`);
  output('');
  output(`Search X/Twitter via Atris (${COST_HINT}).`);
  output('Requires login. Same auth path as atris youtube process.');
  output('Empty or failed search refunds the credits.');
  output('');
  output('Options:');
  output('  --limit <n>         Max results hint (search only)');
  output('  --days <n>          Only tweets from the last N days (search only)');
  output('  --json              Print the raw JSON response');
  output('  -h, --help          This help');
  output('');
  output('Person options:');
  output('  --name <text>       Person to research (required)');
  output('  --handle <text>     X handle without @');
  output('  --company <text>    Company or org');
  output('  --context <text>    Why you are researching them');
  output('');
  output('Examples:');
  output(`  ${commandName} "MCP agents"`);
  output(`  ${commandName} "MCP agents" --limit 5 --days 2`);
  output(`  ${commandName} person --name "Leah Bonvissuto" --handle leahbon`);
  output('');
}

function readValue(args, index, name) {
  if (index >= args.length - 1 || String(args[index + 1]).startsWith('--')) {
    throw new Error(`${name} requires a value`);
  }
  return args[index + 1];
}

function parsePositiveInt(raw, name) {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function parseSearchArgs(argv = []) {
  const args = [...argv];
  const options = {
    mode: 'search',
    help: false,
    json: false,
    query: null,
    limit: null,
    daysBack: null,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };

  if (args.length === 0 || ['help', '--help', '-h'].includes(args[0])) {
    options.help = true;
    return options;
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h' || arg === 'help') {
      options.help = true;
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--limit') {
      options.limit = parsePositiveInt(readValue(args, i, arg), '--limit');
      i++;
    } else if (arg.startsWith('--limit=')) {
      options.limit = parsePositiveInt(arg.slice('--limit='.length), '--limit');
    } else if (arg === '--days' || arg === '--days-back' || arg === '--days_back') {
      options.daysBack = parsePositiveInt(readValue(args, i, arg), '--days');
      i++;
    } else if (arg.startsWith('--days=')) {
      options.daysBack = parsePositiveInt(arg.slice('--days='.length), '--days');
    } else if (arg.startsWith('--days-back=') || arg.startsWith('--days_back=')) {
      const raw = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : '';
      options.daysBack = parsePositiveInt(raw, '--days');
    } else if (arg === '--timeout') {
      const seconds = Number(readValue(args, i, arg));
      if (!Number.isFinite(seconds) || seconds <= 0) {
        throw new Error('--timeout must be a positive number of seconds');
      }
      options.timeoutMs = Math.round(seconds * 1000);
      i++;
    } else if (arg.startsWith('--timeout=')) {
      const seconds = Number(arg.slice('--timeout='.length));
      if (!Number.isFinite(seconds) || seconds <= 0) {
        throw new Error('--timeout must be a positive number of seconds');
      }
      options.timeoutMs = Math.round(seconds * 1000);
    } else if (arg.startsWith('-')) {
      throw new Error(`Unknown option: ${arg}`);
    } else if (!options.query) {
      options.query = arg;
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }

  if (options.help) return options;
  if (!options.query) throw new Error('Missing query. Run "atris x-search --help".');
  return options;
}

function parsePersonArgs(argv = []) {
  const args = [...argv];
  const options = {
    mode: 'person',
    help: false,
    json: false,
    name: null,
    handle: null,
    company: null,
    context: null,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };

  if (args.length === 0 || ['help', '--help', '-h'].includes(args[0])) {
    options.help = true;
    return options;
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h' || arg === 'help') {
      options.help = true;
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--name') {
      options.name = readValue(args, i, arg);
      i++;
    } else if (arg.startsWith('--name=')) {
      options.name = arg.slice('--name='.length);
    } else if (arg === '--handle') {
      options.handle = String(readValue(args, i, arg)).replace(/^@/, '');
      i++;
    } else if (arg.startsWith('--handle=')) {
      options.handle = arg.slice('--handle='.length).replace(/^@/, '');
    } else if (arg === '--company') {
      options.company = readValue(args, i, arg);
      i++;
    } else if (arg.startsWith('--company=')) {
      options.company = arg.slice('--company='.length);
    } else if (arg === '--context') {
      options.context = readValue(args, i, arg);
      i++;
    } else if (arg.startsWith('--context=')) {
      options.context = arg.slice('--context='.length);
    } else if (arg === '--timeout') {
      const seconds = Number(readValue(args, i, arg));
      if (!Number.isFinite(seconds) || seconds <= 0) {
        throw new Error('--timeout must be a positive number of seconds');
      }
      options.timeoutMs = Math.round(seconds * 1000);
      i++;
    } else if (arg.startsWith('--timeout=')) {
      const seconds = Number(arg.slice('--timeout='.length));
      if (!Number.isFinite(seconds) || seconds <= 0) {
        throw new Error('--timeout must be a positive number of seconds');
      }
      options.timeoutMs = Math.round(seconds * 1000);
    } else if (arg.startsWith('-')) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }

  if (options.help) return options;
  if (!options.name) throw new Error('Missing --name. Run "atris x-search person --help".');
  return options;
}

function parseXSearchArgs(argv = []) {
  const args = [...argv];
  if (args[0] === 'person') {
    return parsePersonArgs(args.slice(1));
  }
  return parseSearchArgs(args);
}

function buildSearchPayload(options) {
  const payload = { query: options.query };
  if (options.limit != null) payload.limit = options.limit;
  if (options.daysBack != null) payload.days_back = options.daysBack;
  return payload;
}

function buildPersonPayload(options) {
  const payload = { name: options.name };
  if (options.handle) payload.handle = options.handle;
  if (options.company) payload.company = options.company;
  if (options.context) payload.context = options.context;
  return payload;
}

function resultErrorText(result) {
  const raw = result?.error || result?.text || 'unknown error';
  if (typeof raw === 'string') return raw;
  try {
    return JSON.stringify(raw);
  } catch {
    return String(raw);
  }
}

function unwrapXSearchPayload(data) {
  return data?.data && typeof data.data === 'object' ? data.data : data;
}

function xSearchContent(data) {
  const payload = unwrapXSearchPayload(data);
  return payload?.content != null ? String(payload.content).trim() : '';
}

function xSearchCitations(data) {
  const payload = unwrapXSearchPayload(data);
  if (Array.isArray(payload?.citations)) return payload.citations;
  if (Array.isArray(data?.citations)) return data.citations;
  return [];
}

function xSearchCredits(data) {
  if (!data || typeof data !== 'object') {
    return { used: undefined, remaining: undefined, refunded: undefined };
  }
  const payload = unwrapXSearchPayload(data) || {};
  const used = data.credits_used !== undefined ? data.credits_used : payload.credits_used;
  const remaining = data.credits_remaining !== undefined
    ? data.credits_remaining
    : payload.credits_remaining;
  let refunded = data.credits_refunded !== undefined
    ? data.credits_refunded
    : payload.credits_refunded;
  if (refunded === undefined && (data.refunded === true || payload.refunded === true)) {
    refunded = true;
  }
  return { used, remaining, refunded };
}

function creditsWereRefunded(credits) {
  if (!credits) return false;
  if (credits.used === 0) return true;
  if (credits.refunded === true) return true;
  return typeof credits.refunded === 'number' && credits.refunded > 0;
}

function formatCreditsLines(credits) {
  const lines = [];
  if (credits.used !== undefined || credits.remaining !== undefined) {
    lines.push(`Credits: ${credits.used !== undefined ? credits.used : '?'} used, ${credits.remaining !== undefined ? credits.remaining : '?'} remaining`);
  }
  if (creditsWereRefunded(credits)) {
    lines.push('credits refunded');
  }
  return lines;
}

function xSearchFailureError(result) {
  const hint = result.status === 401
    ? ' Run "atris login --force".'
    : result.status === 402
      ? ' Check Atris credits.'
      : result.status === 502
        ? ' xAI is unavailable; retry in a few seconds.'
        : '';
  const credits = xSearchCredits(result.data);
  const refundHint = result.status === 502 && creditsWereRefunded(credits)
    ? ' credits refunded.'
    : '';
  const lines = [`X search failed (${result.status}): ${resultErrorText(result)}.${hint}${refundHint}`];
  lines.push(...formatCreditsLines(credits));
  return new Error(lines.join('\n'));
}

async function ensureToken(deps = {}) {
  const ensureBilled = deps.ensureBilledCommandAuth || ensureBilledCommandAuth;
  const auth = await ensureBilled('x-search', deps);
  if (!auth?.ok || !auth.token) {
    throw new Error(auth?.error || 'not signed in. run atris login first.');
  }
  return auth;
}

async function runXSearch(options, deps = {}) {
  const apiFn = deps.apiRequestJson || apiRequestJson;
  let auth = await ensureToken(deps);
  const pathname = options.mode === 'person' ? '/x-search/research-person' : '/x-search/search';
  const body = options.mode === 'person' ? buildPersonPayload(options) : buildSearchPayload(options);

  const call = (token) => apiFn(pathname, {
    method: 'POST',
    token,
    timeoutMs: options.timeoutMs,
    retries: 0,
    body,
  });

  let result = await call(auth.token);
  if (!result.ok && result.status === 401 && !auth.minted) {
    const remint = await (deps.ensureBilledCommandAuth || ensureBilledCommandAuth)('x-search', {
      ...deps,
      forceMint: true,
    });
    if (remint?.ok && remint.token) {
      auth = remint;
      result = await call(auth.token);
    }
  }

  if (!result.ok) {
    throw xSearchFailureError(result);
  }
  return result.data;
}

function xSearchApplySource(options) {
  if (options?.mode === 'person') return options.name;
  return options?.query;
}

function xSearchApplyRel(source) {
  return applyGate.applySidecarRel('x-search', applyGate.applySlug(source));
}

function xSearchHasResults(data) {
  return Boolean(xSearchContent(data)) || xSearchCitations(data).length > 0;
}

function ensureXSearchApply({ cwd, source, now, output } = {}) {
  return applyGate.ensureApply({
    cwd,
    source,
    rel: source ? xSearchApplyRel(source) : null,
    now,
    output,
    incompleteMessage: APPLY_INCOMPLETE_MESSAGE,
  });
}

function formatXSearchResult(data) {
  const lines = [];
  const content = xSearchContent(data);
  const citations = xSearchCitations(data);

  if (content) {
    lines.push(content);
  } else if (data?.message) {
    lines.push(String(data.message).trim());
  } else {
    lines.push('X search completed');
  }

  if (citations.length) {
    lines.push('');
    lines.push('Citations:');
    for (const cite of citations) {
      lines.push(`  ${cite}`);
    }
  }

  const creditLines = formatCreditsLines(xSearchCredits(data));
  if (creditLines.length) {
    lines.push('');
    lines.push(...creditLines);
  }

  return lines.join('\n');
}

function formatEmptyXSearchResult(data) {
  const lines = ['no results'];
  const creditLines = formatCreditsLines(xSearchCredits(data));
  if (creditLines.length) {
    lines.push('');
    lines.push(...creditLines);
  }
  return lines.join('\n');
}

async function xSearchCommand(argv = process.argv.slice(3), deps = {}) {
  const output = deps.output || ((line = '') => console.log(line));
  let options;
  try {
    options = parseXSearchArgs(argv);
  } catch (err) {
    output(err.message);
    return 2;
  }

  if (options.help) {
    showXSearchHelp(output, deps.commandName || 'atris x-search');
    return 0;
  }

  let status = 0;
  try {
    const data = await runXSearch(options, deps);
    const hasResults = xSearchHasResults(data);
    if (options.json) {
      output(JSON.stringify(data, null, 2));
    } else {
      output(hasResults ? formatXSearchResult(data) : formatEmptyXSearchResult(data));
    }
    if (hasResults) {
      const ensureApply = deps.ensureApply || ensureXSearchApply;
      status = ensureApply({
        cwd: deps.cwd || process.cwd(),
        source: xSearchApplySource(options),
        now: deps.applyNow,
        output,
      });
    } else {
      status = 2;
    }
  } catch (err) {
    output(err.message);
    status = 1;
  }
  if (!deps.output && !deps.apiRequestJson && !deps.ensureValidCredentials && !deps.ensureBilledCommandAuth) {
    process.exit(status);
  }
  return status;
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  APPLY_INCOMPLETE_MESSAGE,
  parseXSearchArgs,
  buildSearchPayload,
  buildPersonPayload,
  formatXSearchResult,
  formatEmptyXSearchResult,
  xSearchHasResults,
  xSearchCredits,
  creditsWereRefunded,
  xSearchApplyRel,
  xSearchCommand,
};
