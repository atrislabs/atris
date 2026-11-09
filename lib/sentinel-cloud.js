'use strict';

// Sentinel on Atris: hosted engines, credit quotes, run upload, and the
// review timer. lib/security-audit.js does the audit; this file only talks
// to the Atris backend and the local timer.
//
//   engines   atris:fast hunts, atris:pro verifies and critiques, through
//             POST /api/atris2/turn. The backend's turn billing charges the
//             credits; this file only reads what each turn's receipt reports.
//   quote     GET /api/atris2/billing/quote prices one call per model, so the
//             caller can show an estimate before any spend.
//   upload    POST /api/sentinel/runs gets summary fields only (titles,
//             locations, counts). Never source, traces, or code lines.
//   schedule  the same launchd/cron timer `atris worktree sweep --install` uses.
//
// Zero external deps (Node built-ins only).

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');

const HUNTER_MODEL = 'atris:fast';
const VERIFIER_MODEL = 'atris:pro';
const LOCAL_ENGINES = ['codex', 'claude'];
const SEVERITIES = ['critical', 'high', 'medium', 'low', 'informational'];
const MAX_UPLOAD_BYTES = 1024 * 1024;
const MAX_UPLOAD_FINDINGS = 500;
const SCHEDULE_EVERY = { day: 86400, week: 7 * 86400 };

// ---------------------------------------------------------------- identity

function authToken({ env = process.env, loadCredentials } = {}) {
  if (env.OBELISK_AUTH_TOKEN) return env.OBELISK_AUTH_TOKEN;
  if (env.ATRIS_TOKEN) return env.ATRIS_TOKEN;
  try {
    const load = loadCredentials || require('../utils/auth').loadCredentials;
    const creds = load();
    return creds && creds.token ? String(creds.token) : '';
  } catch {
    return '';
  }
}

function apiBase() {
  return require('../utils/api').getApiBaseUrl();
}

// A local engine counts as available when its binary is on PATH.
function localEngineAvailable(name, { env = process.env, platform = process.platform } = {}) {
  const exts = platform === 'win32' ? (env.PATHEXT || '.EXE;.CMD;.BAT').split(';') : [''];
  for (const dir of String(env.PATH || '').split(path.delimiter).filter(Boolean)) {
    for (const ext of exts) {
      try { fs.accessSync(path.join(dir, `${name}${ext}`), fs.constants.X_OK); return true; } catch {}
    }
  }
  return false;
}

// Which engines run the review. An explicit choice always wins; with none,
// local engines stay the default and Atris models step in only when no local
// engine is installed and the user is logged in.
function resolveEngines({ engine = null, hunter = null, verifier = null, token = '', env = process.env } = {}) {
  if (engine && engine !== 'atris' && engine !== 'local') throw new Error('--engine must be atris or local');
  if (engine === 'atris' && (hunter || verifier)) throw new Error('pick --engine atris or --hunter and --verifier, not both');
  if (engine === 'atris') {
    if (!token) throw new Error('reviews on atris models need a login; run atris login first');
    return { mode: 'atris', hunter: HUNTER_MODEL, verifier: VERIFIER_MODEL, chosen: 'flag' };
  }
  if (engine === 'local' || hunter || verifier) return { mode: 'local', hunter: hunter || null, verifier: verifier || null, chosen: 'flag' };
  if (LOCAL_ENGINES.some((name) => localEngineAvailable(name, { env }))) return { mode: 'local', hunter: null, verifier: null, chosen: 'default' };
  if (token) return { mode: 'atris', hunter: HUNTER_MODEL, verifier: VERIFIER_MODEL, chosen: 'no_local_engine' };
  return { mode: 'local', hunter: null, verifier: null, chosen: 'default' };
}

function usesAtrisModels(meta) {
  const e = (meta && meta.engines) || {};
  return [e.hunter, e.verifier, e.critic].some((x) => /^atris:/i.test(String(x || '')));
}

// ---------------------------------------------------------------- http

function request(method, url, { token, body = null, accept = 'application/json', timeoutMs = 30000, onData = null } = {}) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(url); } catch (e) { reject(new Error(`bad url: ${url}`)); return; }
    const transport = parsed.protocol === 'https:' ? https : http;
    const data = body === null ? null : Buffer.from(JSON.stringify(body));
    const headers = { Accept: accept, 'User-Agent': 'atris-cli-sentinel' };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = data.length; }
    const req = transport.request({
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: `${parsed.pathname}${parsed.search}`,
      method,
      headers,
    }, (res) => {
      res.setEncoding('utf8');
      let text = '';
      res.on('data', (chunk) => { text += chunk; if (onData && res.statusCode >= 200 && res.statusCode < 300) onData(chunk); });
      res.on('end', () => {
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch {}
        resolve({ status: res.statusCode, text, json });
      });
      res.on('error', reject);
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`timed out after ${Math.round(timeoutMs / 1000)}s`)));
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function httpError(res) {
  const detail = res.json && (res.json.detail || res.json.error);
  const text = typeof detail === 'string' ? detail : (detail ? JSON.stringify(detail) : String(res.text || '').slice(0, 200));
  return `the server said ${res.status}${text ? `: ${text}` : ''}`;
}

// ---------------------------------------------------------------- engines

// Every message bound for an Atris model passes through here, so no prompt
// part (seeded lines, cited code, source blocks, candidate JSON) can skip
// it. A line that looks like a secret, read as is or with JSON escapes
// undone, is replaced whole.
const HIDDEN_LINE = '[line hidden: looks like a secret]';
function redactOutgoing(message) {
  let scan;
  try { scan = require('./security-scan'); } catch { scan = null; }
  if (!scan || !scan.SECRET_RULES || !scan.SECRET_RULES.length) return { text: String(message || ''), hidden: 0 };
  let hidden = 0;
  const lines = String(message || '').split('\n').map((line) => {
    const variants = [line, line.replace(/\\"/g, '"').replace(/\\'/g, "'"), line.replace(/\\n/g, '\n')];
    // Any rule match hides the line: no allow markers and no placeholder
    // guesses here, a model-facing message is stricter than a commit check.
    const hit = variants.some((v) => v.split('\n').some((part) => scan.SECRET_RULES.some((rule) => {
      try { rule.re.lastIndex = 0; return rule.re.test(part); } catch { return false; }
    })));
    if (!hit) return line;
    hidden += 1;
    return HIDDEN_LINE;
  });
  return { text: lines.join('\n'), hidden };
}

// One turn on an Atris model. The reply streams as server-sent events: text
// arrives as text_delta, the final answer as result, and the receipt carries
// what the turn was charged.
async function runAtrisTurn({ model, prompt, token, base = apiBase(), timeoutMs = 15 * 60 * 1000, maxOutputTokens = null }) {
  let buffer = '';
  let text = '';
  let result = null;
  let credits = 0;
  let billed = false;
  const errors = [];
  const readBilling = (billing) => {
    if (!billing || typeof billing !== 'object') return;
    billed = true;
    if (billing.billed === false) return;
    const c = Number(billing.credits_charged);
    if (Number.isFinite(c) && c > 0) credits += c;
  };
  const handle = (block) => {
    const data = block.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.replace(/^data:\s?/, '')).join('\n').trim();
    if (!data || data === '[DONE]') return;
    let ev;
    try { ev = JSON.parse(data); } catch { return; }
    if (!ev || typeof ev !== 'object') return;
    if ((ev.type === 'text_delta' || ev.type === 'text') && ev.content) text += ev.content;
    if (ev.type === 'result' && ev.result) result = String(ev.result);
    if (ev.type === 'error' || ev.error) errors.push(String(ev.error || ev.message || 'stream error'));
    readBilling((ev.receipt && ev.receipt.billing) || ev.billing);
  };
  const onData = (chunk) => {
    buffer += chunk;
    let at = buffer.indexOf('\n\n');
    while (at !== -1) { handle(buffer.slice(0, at)); buffer = buffer.slice(at + 2); at = buffer.indexOf('\n\n'); }
  };
  const { text: message } = redactOutgoing(prompt);
  const body = { message, model, max_turns: 1, disable_connector_tools: true };
  if (Number.isInteger(maxOutputTokens) && maxOutputTokens >= 16) body.max_output_tokens = Math.min(8192, maxOutputTokens);
  let res;
  try {
    res = await request('POST', `${base}/atris2/turn`, { token, body, accept: 'text/event-stream', timeoutMs, onData });
  } catch (e) {
    return { ok: false, stdout: '', reason: e.message, credits_charged: 0, billed: false };
  }
  if (res.status < 200 || res.status >= 300) return { ok: false, stdout: '', reason: httpError(res), credits_charged: 0, billed: res.status === 402 ? false : billed };
  if (buffer.trim()) handle(buffer);
  // A plain JSON reply (no stream) still counts.
  if (!text && !result && res.json && typeof res.json === 'object') {
    result = String(res.json.result || res.json.output || res.json.text || '');
    readBilling((res.json.receipt && res.json.receipt.billing) || res.json.billing);
  }
  const stdout = result || text;
  if (!stdout && errors.length) return { ok: false, stdout: '', reason: errors.join('; '), credits_charged: credits, billed };
  return { ok: Boolean(stdout), stdout, reason: stdout ? undefined : 'empty answer', credits_charged: credits, billed };
}

const CAP_REASON = 'stopped at the approved credit limit';

// The spend guard every hosted call goes through. `max` is the approved
// limit. Before a call starts, its own worst case (quoted at its exact size
// and output limit) is held against the limit along with every call still
// running; a call that could pass the limit never starts. After a call, the
// receipt's charge is counted, or the worst case when no receipt came back.
function spendGuard({ max = 0, quoteCall } = {}) {
  return { max, spent: 0, held: 0, blocked: 0, calls: 0, limits: {}, quoteCall };
}

// A runJobs for runAudit: atris:* jobs go to the backend, anything else to
// the local engine runner.
function atrisJobRunner({ token, base = null, localRunJobs = null, spend = null } = {}) {
  return async (jobs, { root, concurrency = 3, timeoutMs } = {}) => {
    const answers = new Array(jobs.length);
    const hosted = [];
    const local = [];
    jobs.forEach((job, i) => (/^atris:/i.test(String(job.engine || '')) ? hosted : local).push(i));
    if (local.length) {
      const run = localRunJobs || ((js, o) => {
        const { runEngineAskJobs } = require('./engine-ask');
        return runEngineAskJobs(js, o);
      });
      const got = await run(local.map((i) => jobs[i]), { root, concurrency, timeoutMs });
      local.forEach((i, k) => { answers[i] = got[k]; });
    }
    const url = base || apiBase();
    const one = async (job) => {
      const model = job.engine;
      const outTokens = Number.isInteger(job.max_output_tokens) ? job.max_output_tokens : 8192;
      if (!spend) return runAtrisTurn({ model, prompt: job.prompt, token, base: url, timeoutMs, maxOutputTokens: outTokens });
      const bytes = Buffer.byteLength(redactOutgoing(job.prompt).text);
      const limit = spend.limits[model];
      if (limit && bytes > limit) { spend.blocked += 1; return { ok: false, stdout: '', reason: `message is larger than the size this run was priced for (${bytes} of ${limit} bytes)`, credits_charged: 0 }; }
      let worst;
      try { worst = await (spend.quoteCall || ((m, i, o) => quoteCall(m, i, o, { token, base: url })))(model, bytes, outTokens); } catch (e) { spend.blocked += 1; return { ok: false, stdout: '', reason: `no price for this call: ${e.message}`, credits_charged: 0 }; }
      if (spend.spent + spend.held + worst > spend.max) { spend.blocked += 1; return { ok: false, stdout: '', reason: CAP_REASON, credits_charged: 0 }; }
      spend.held += worst;
      spend.calls += 1;
      let answer;
      try { answer = await runAtrisTurn({ model, prompt: job.prompt, token, base: url, timeoutMs, maxOutputTokens: outTokens }); } finally { spend.held -= worst; }
      spend.spent += answer.billed ? Number(answer.credits_charged) || 0 : worst;
      return answer;
    };
    let next = 0;
    const work = async () => {
      while (next < hosted.length) {
        const i = hosted[next++];
        answers[i] = await one(jobs[i]);
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, hosted.length)) }, work));
    return answers;
  };
}

// ---------------------------------------------------------------- quote

// The price of one call at these exact counts, capped by the backend's own
// most-per-request when it reports one.
async function quoteCall(model, inputTokens, outputTokens, { token, base = apiBase(), timeoutMs = 15000 } = {}) {
  const qs = new URLSearchParams({ model, input_tokens: String(Math.ceil(inputTokens)), output_tokens: String(Math.ceil(outputTokens)) });
  const res = await request('GET', `${base}/atris2/billing/quote?${qs}`, { token, timeoutMs });
  if (res.status < 200 || res.status >= 300 || !res.json || !Number.isFinite(Number(res.json.credits))) {
    throw new Error(`could not get a price for ${model}: ${httpError(res)}`);
  }
  return Number(res.json.credits);
}

// Prices every hosted row of a spend estimate: each call at its largest
// allowed size and full output limit, times the calls. Throws when any quote
// fails, so a run never spends without a price shown.
async function quoteEstimate(estimate, { token, base = apiBase(), timeoutMs = 15000 } = {}) {
  const rows = [];
  for (const row of estimate.calls || []) {
    const per = await quoteCall(row.model, row.input_tokens, row.output_tokens, { token, base, timeoutMs });
    rows.push({ ...row, credits_per_call: per, credits: per * row.calls });
  }
  const credits = rows.reduce((n, r) => n + r.credits, 0);
  const limits = {};
  for (const r of rows) if (r.max_input_bytes) limits[r.model] = Math.max(limits[r.model] || 0, r.max_input_bytes);
  return { rows, credits, limits };
}

function describeQuote(quote) {
  const parts = quote.rows.map((r) => `${r.calls} ${r.role === 'hunter' ? 'search' : 'check'} call${r.calls === 1 ? '' : 's'} on ${r.model} at most ${r.credits_per_call} credit${r.credits_per_call === 1 ? '' : 's'} each`);
  return [
    `this review runs on atris models and costs at most ${quote.credits} credits`,
    `  ${parts.join('; ')}`,
    '  the run stops before it could pass that. most runs spend far less',
    '  your code is sent to atris models to be read. lines that look like secrets are hidden first',
  ].join('\n');
}

// ---------------------------------------------------------------- upload

function readJsonFile(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

// Plain sentence only: code spans, line breaks and anything that looks like
// a secret are removed, and the length is capped.
// Words that read as code: calls, assignments, arrows, template or shell
// substitutions, operators, and paths glued to operators.
const CODE_FRAGMENTS = [
  /\$\{[^}]*\}|\$\([^)]*\)/g,
  /[\w$.\[\]'"]+\([^()]*(?:\([^()]*\)[^()]*)*\)/g,
  /[\w$.\[\]]+\s*(?:===?|!==?|\+=|-=|=>|:=|=)\s*(?:\{[^{}]*\}|\[[^\]]*\]|\S+)/g,
  /\{[^{}]*\}/g,
  /\S+\s*(?:&&|\|\||\|)\s*\S+(?:\s+-[\w-]+)*(?:\s+[/~.]\S*)?/g,
  /\S*(?:&&|\|\||=>|<<|>>|::|->)\S*|\S+;\S+/g,
  /\S*[|<>]\S*/g,
  /(?:^|\s)-{1,2}[A-Za-z][\w-]*(?=\s|$)/g,
  /(?:^|\s)\/(?=\s|$)/g,
];

function stripCode(text) {
  let out = String(text || '').replace(/```[\s\S]*?(?:```|$)/g, ' ').replace(/`[^`]*`?/g, ' ');
  for (const re of CODE_FRAGMENTS) out = out.replace(re, ' ');
  return out.replace(/\s+([,.;:!?])/g, '$1').replace(/([,;:])(?=[,.;:])/g, '').replace(/\(\s*\)/g, ' ').replace(/\s+/g, ' ').trim();
}

function plain(value, max = 500) {
  let s = stripCode(value == null ? '' : value);
  try {
    const scan = require('./security-scan');
    if (scan.scanLine(s, scan.SECRET_RULES).length) s = '[removed: looked like a secret]';
  } catch {}
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}.` : s;
}

// file:line from a trace step, kept as is when it is a plain repo path.
function location(sink) {
  if (!sink || typeof sink.file !== 'string') return '';
  const file = sink.file.trim();
  if (!/^[\w./@+-]+$/.test(file) || file.split('/').includes('..') || file.length > 280) return '';
  return `${file}${Number.isInteger(sink.line) && sink.line > 0 ? `:${sink.line}` : ''}`;
}

function hardeningFromReport(text) {
  const lines = String(text || '').split('\n');
  const start = lines.findIndex((l) => /^##\s+Hardening notes/i.test(l));
  if (start === -1) return [];
  const out = [];
  for (const l of lines.slice(start + 1)) {
    if (/^##\s/.test(l)) break;
    const m = l.match(/^\s*-\s+(.*)$/);
    const note = m ? plain(m[1], 400) : '';
    if (note) out.push(note);
  }
  return out.slice(0, 50);
}

function needsFromMarkdown(text) {
  const out = [];
  let cur = null;
  let inBlocked = false;
  for (const l of String(text || '').split('\n')) {
    const h = l.match(/^##\s+(.*)$/);
    if (h) { cur = { title: plain(h[1], 300), blocked_on: '' }; out.push(cur); inBlocked = false; continue; }
    if (!cur) continue;
    if (/^Blocked on:/i.test(l)) { inBlocked = true; continue; }
    if (/^\S.*:$/.test(l)) { inBlocked = false; continue; }
    const m = l.match(/^-\s+(.*)$/);
    if (inBlocked && m && !cur.blocked_on) cur.blocked_on = plain(m[1], 400);
  }
  return out;
}

function count(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

// The contract body (POST /api/sentinel/runs), built from a run folder.
function buildUploadBody(dir) {
  const meta = readJsonFile(path.join(dir, 'run-metadata.json'));
  if (!meta) throw new Error(`no run-metadata.json in ${dir}`);
  const records = readJsonFile(path.join(dir, 'findings.json')) || [];
  let report = '';
  try { report = fs.readFileSync(path.join(dir, 'REPORT.md'), 'utf8'); } catch {}
  let nvText = '';
  try { nvText = fs.readFileSync(path.join(dir, 'NEEDS-VALIDATION.md'), 'utf8'); } catch {}

  const cov = meta.coverage || {};
  const counts = meta.counts || {};
  const sev = counts.severity || {};
  const rank = Object.fromEntries(SEVERITIES.map((s, i) => [s, i]));
  const confirmed = records.filter((r) => r && r.verdict === 'confirmed')
    .sort((a, b) => (rank[(a.severity || {}).overall] ?? 9) - (rank[(b.severity || {}).overall] ?? 9));
  const findings = confirmed.slice(0, MAX_UPLOAD_FINDINGS).map((r, i) => {
    const trace = Array.isArray(r.trace) ? r.trace : [];
    const sink = trace[trace.length - 1] || {};
    const severity = SEVERITIES.includes((r.severity || {}).overall) ? r.severity.overall : 'informational';
    return {
      id: plain(r.fingerprint || `f${i + 1}`, 200),
      severity,
      title: plain(r.title, 300),
      location: location(sink),
      fix: plain((r.remediation || {}).strategy, 600),
      status: 'open',
    };
  });
  let needs = records.filter((r) => r && r.verdict === 'needs_validation').map((r) => ({
    title: plain(r.title, 300),
    blocked_on: plain(Array.isArray(r.blockers) && r.blockers[0] ? r.blockers[0] : '', 400),
  }));
  if (!needs.length && nvText) needs = needsFromMarkdown(nvText);
  const engines = meta.engines || {};
  const body = {
    repo: String(meta.repo || path.basename(path.dirname(dir))),
    run_id: String(meta.run_id || path.basename(dir)),
    started_at: meta.started_at || null,
    finished_at: meta.finished_at || null,
    profile: String(meta.profile || 'standard'),
    source: usesAtrisModels({ engines }) ? 'atris-models' : 'cli-local',
    coverage: { in_scope: count(cov.in_scope), done: count(cov.done), deferred: count(cov.deferred), blocked: count(cov.blocked) },
    counts: {
      confirmed: count(counts.confirmed),
      needs_validation: count(counts.needs_validation),
      rejected: count(counts.rejected),
      severity: Object.fromEntries(SEVERITIES.map((s) => [s, count(sev[s])])),
    },
    findings,
    needs_validation: needs.slice(0, MAX_UPLOAD_FINDINGS),
    hardening: hardeningFromReport(report),
    credits_used: Number(meta.credits_used) > 0 ? Number(meta.credits_used) : 0,
  };
  while (Buffer.byteLength(JSON.stringify(body)) > MAX_UPLOAD_BYTES && (body.findings.length || body.needs_validation.length || body.hardening.length)) {
    if (body.hardening.length) body.hardening.pop();
    else if (body.needs_validation.length) body.needs_validation.pop();
    else body.findings.pop();
  }
  return body;
}

async function uploadRun(dir, { token, base = apiBase(), timeoutMs = 20000 } = {}) {
  if (!token) return { ok: false, reason: 'not logged in' };
  let body;
  try { body = buildUploadBody(dir); } catch (e) { return { ok: false, reason: e.message }; }
  try {
    const res = await request('POST', `${base}/sentinel/runs`, { token, body, timeoutMs });
    if (res.status < 200 || res.status >= 300) return { ok: false, reason: httpError(res), body };
    return { ok: true, id: res.json && res.json.id ? String(res.json.id) : null, body };
  } catch (e) {
    return { ok: false, reason: e.message, body };
  }
}

// ---------------------------------------------------------------- schedule

function schedulePlan({ target, every, homeDir = os.homedir(), platform = process.platform, atrisBin, envPath = process.env.PATH || '' }) {
  if (!SCHEDULE_EVERY[every]) throw new Error('--every must be day or week');
  const { planKeep } = require('./campaign-keep');
  return planKeep({
    root: target,
    home: path.join(homeDir, '.atris', 'sentinel'),
    platform,
    homeDir,
    atrisBin,
    envPath,
    job: {
      name: 'sentinel-review',
      args: ['sentinel', '--quick', '--scheduled'],
      every_seconds: SCHEDULE_EVERY[every],
      marker: 'ATRIS_SENTINEL_REVIEW',
    },
  });
}

// What the owner approved when the timer went on: which engines, and for
// atris models the most credits one run may spend. A scheduled run reads
// this and nothing else; with no record it does not run at all.
function scheduleKey(target) {
  let real = path.resolve(target);
  try { real = fs.realpathSync(real); } catch {}
  return require('crypto').createHash('sha256').update(real).digest('hex').slice(0, 16);
}

function approvalPath(target, homeDir = os.homedir()) {
  return path.join(homeDir, '.atris', 'sentinel', 'schedules', `${scheduleKey(target)}.json`);
}

function writeApproval(target, approval, homeDir) {
  const file = approvalPath(target, homeDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ target: path.resolve(target), ...approval }, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  return file;
}

function readApproval(target, homeDir) {
  const a = readJsonFile(approvalPath(target, homeDir));
  if (!a || (a.engine !== 'atris' && a.engine !== 'local')) return null;
  if (a.engine === 'atris' && !(Number(a.max_credits) > 0)) return null;
  return a;
}

function removeApproval(target, homeDir) {
  const file = approvalPath(target, homeDir);
  const had = fs.existsSync(file);
  if (had) fs.unlinkSync(file);
  return had;
}

module.exports = {
  approvalPath,
  writeApproval,
  readApproval,
  removeApproval,
  CAP_REASON,
  redactOutgoing,
  spendGuard,
  quoteCall,
  HUNTER_MODEL,
  VERIFIER_MODEL,
  SCHEDULE_EVERY,
  authToken,
  apiBase,
  localEngineAvailable,
  resolveEngines,
  usesAtrisModels,
  runAtrisTurn,
  atrisJobRunner,
  quoteEstimate,
  describeQuote,
  buildUploadBody,
  uploadRun,
  schedulePlan,
};
