'use strict';

/**
 * atris design, brand design-system commands against api.atris.ai.
 *
 *   atris design extract <url> [--json] [--sections colors,typography]
 *   atris design check <url> --against <brand-url> [--json]
 *   atris design search "<words>" [--limit n] [--json]
 *
 * Auth: developer key as `Authorization: Bearer atris_...`, resolved by
 * lib/design-api.js (ATRIS_API_KEY, then ~/.atris/design-api-key, then login).
 */

const {
  resolveDesignKey,
  designRequest,
  pollDesignJob,
  billingOf,
  creditLine,
} = require('../lib/design-api');

const NO_KEY = 'no api key found. set ATRIS_API_KEY or run: atris api-key create';

function showDesignHelp() {
  console.log('usage: atris design extract <url> [--json] [--sections colors,typography]');
  console.log('       atris design check <url> --against <brand-url> [--json]');
  console.log('       atris design search "<words>" [--limit n] [--json]');
  console.log('pull a site\'s design system, score a page against a brand, or search extracted brands.');
}

function wantsHelp(args) {
  return args.includes('--help') || args.includes('-h') || args[0] === 'help';
}

function readFlag(args, name) {
  for (let i = 0; i < args.length; i += 1) {
    const a = String(args[i]);
    if (a === name) {
      const v = args[i + 1];
      if (v === undefined || String(v).startsWith('--')) return { error: `${name} needs a value` };
      args.splice(i, 2);
      return { value: String(v) };
    }
    if (a.startsWith(`${name}=`)) {
      args.splice(i, 1);
      return { value: a.slice(name.length + 1) };
    }
  }
  return {};
}

function positionals(args) {
  return args.filter((a) => !String(a).startsWith('--'));
}

function unknownFlags(args, allowed) {
  return args.filter((a) => String(a).startsWith('--') && !allowed.includes(a));
}

function normalizeUrl(url) {
  return /^https?:\/\//i.test(url) ? url : `https://${url}`;
}

function isTerminal(job) {
  const s = String(job && job.status || '').toLowerCase();
  return s === 'completed' || s === 'failed' || s === 'error' || s === 'succeeded';
}

// One-line spinner on TTY only; off TTY stays silent so --json and pipes stay clean.
function makeSpinner(label, io) {
  const write = io.write;
  if (!io.tty || typeof write !== 'function') return { stop() {} };
  const start = Date.now();
  const frames = ['-', '\\', '|', '/'];
  let n = 0;
  const timer = setInterval(() => {
    const secs = Math.floor((Date.now() - start) / 1000);
    write(`\r  ${frames[n++ % frames.length]} ${label} ${secs}s`);
  }, 250);
  if (timer.unref) timer.unref();
  return {
    stop() {
      clearInterval(timer);
      write('\r\x1b[2K');
    },
  };
}

function uniqueHexes(colors = {}, palette = []) {
  const out = [];
  for (const key of ['primary', 'secondary', 'accent']) {
    const hex = colors[key];
    if (hex && !out.includes(hex)) out.push(hex);
  }
  for (const p of Array.isArray(palette) ? palette : []) {
    const hex = p && typeof p === 'object' ? p.hex : p;
    if (hex && !out.includes(hex)) out.push(hex);
    if (out.length >= 6) break;
  }
  return out.slice(0, 6);
}

function fontFamily(value) {
  if (!value) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'object') return value.family || null;
  return null;
}

// Short readable card for an extraction job.
function extractionCard(job = {}) {
  const ds = job.result && job.result.design_system ? job.result.design_system : {};
  const profile = ds.profile || {};
  const colors = ds.colors || {};
  const typo = ds.typography || {};
  const lines = [];
  lines.push('');
  lines.push(`  ${profile.brand_name || job.source_url || 'unknown brand'}`);
  if (job.source_url) lines.push(`  ${job.source_url}`);
  lines.push('');
  const hexes = uniqueHexes(colors, colors.palette);
  if (hexes.length) lines.push(`  colors    ${hexes.join(' ')}`);
  const heading = fontFamily(typo.heading);
  const body = fontFamily(typo.body);
  if (heading) lines.push(`  heading   ${heading}`);
  if (body) lines.push(`  body      ${body}`);
  if (profile.one_line_positioning) lines.push(`  line      ${profile.one_line_positioning}`);
  lines.push('');
  lines.push(`  ${creditLine(job)}`);
  lines.push('');
  return lines.join('\n');
}

// Short readable card for an adherence job.
function adherenceCard(job = {}) {
  const result = job.result && typeof job.result === 'object' ? job.result : {};
  const lines = [];
  lines.push('');
  const score = Number(result.score);
  lines.push(`  score     ${Number.isFinite(score) ? score.toFixed(2) : '?'}`);
  if (job.source_url) lines.push(`  source    ${job.source_url}`);
  if (job.reference_url) lines.push(`  against   ${job.reference_url}`);
  lines.push('');
  for (const key of ['fixes', 'recommendations']) {
    const items = Array.isArray(result[key]) ? result[key] : [];
    if (!items.length) continue;
    lines.push(`  ${key}:`);
    for (const item of items.slice(0, 5)) {
      const text = typeof item === 'string' ? item : (item && (item.title || item.detail || item.message)) || JSON.stringify(item);
      lines.push(`   - ${String(text).replace(/\s+/g, ' ').trim()}`);
    }
    lines.push('');
  }
  lines.push(`  ${creditLine(job)}`);
  lines.push('');
  return lines.join('\n');
}

// Short readable card for a search response.
function searchCard(data = {}, query = '') {
  const results = Array.isArray(data.results) ? data.results : [];
  const lines = [];
  lines.push('');
  lines.push(`  ${results.length} result${results.length === 1 ? '' : 's'} for "${query}"`);
  lines.push('');
  for (const r of results) {
    const name = r.brand_name || r.source_url || 'unknown';
    lines.push(`  ${name}${r.source_url ? `  ${r.source_url}` : ''}`);
    const palette = Array.isArray(r.palette) ? r.palette.slice(0, 6).join(' ') : '';
    if (palette) lines.push(`    ${palette}`);
  }
  lines.push('');
  lines.push(`  ${creditLine(data)}`);
  lines.push('');
  return lines.join('\n');
}

async function designExtract(args, ctx) {
  const json = args.includes('--json');
  const sections = readFlag(args, '--sections');
  if (sections.error) { ctx.err(sections.error); return 1; }
  const bad = unknownFlags(args, ['--json']);
  if (bad.length) { ctx.err(`unknown flag for design extract: ${bad.join(' ')}`); return 1; }
  const url = positionals(args)[0];
  if (!url) { ctx.err('usage: atris design extract <url> [--json] [--sections colors,typography]'); return 1; }
  const target = normalizeUrl(url);

  const first = await ctx.request('/design/extractions', { method: 'POST', body: { url: target }, key: ctx.key });
  if (!first.ok) {
    ctx.err(`design extract failed (${first.status}): ${first.error}`);
    return 1;
  }
  let job = first.data || {};
  const pollMs = ctx.pollMs;
  if (!isTerminal(job) && job.id) {
    const qs = sections.value ? `?sections=${encodeURIComponent(sections.value)}` : '';
    const spinner = makeSpinner(`extracting ${target}`, ctx.io);
    let failures = 0;
    const polled = await pollDesignJob(async () => {
      const res = await ctx.request(`/design/extractions/${job.id}${qs}`, { key: ctx.key });
      if (!res.ok) {
        failures += 1;
        if (failures >= 3) return { status: 'failed', error: res.error };
        return { status: 'polling' };
      }
      failures = 0;
      return res.data;
    }, { intervalMs: pollMs, timeoutMs: ctx.maxWaitMs, sleep: ctx.sleep });
    spinner.stop();
    if (polled.timedOut) {
      ctx.err(`still running after ${Math.round(ctx.maxWaitMs / 1000)}s. job id: ${job.id}`);
      return 1;
    }
    job = polled.job || job;
  }
  if (json) { ctx.out(JSON.stringify(job, null, 2)); return job.status === 'completed' ? 0 : 1; }
  if (!isTerminal(job) || job.status !== 'completed') {
    ctx.err(`extraction did not finish: ${job.error || job.status || 'unknown'}`);
    return 1;
  }
  ctx.out(extractionCard(job));
  return 0;
}

async function designCheck(args, ctx) {
  const json = args.includes('--json');
  const against = readFlag(args, '--against');
  if (against.error) { ctx.err(against.error); return 1; }
  const bad = unknownFlags(args, ['--json']);
  if (bad.length) { ctx.err(`unknown flag for design check: ${bad.join(' ')}`); return 1; }
  const url = positionals(args)[0];
  if (!url || !against.value) {
    ctx.err('usage: atris design check <url> --against <brand-url> [--json]');
    return 1;
  }
  const source = normalizeUrl(url);
  const reference = normalizeUrl(against.value);

  const first = await ctx.request('/design/adherence', {
    method: 'POST',
    body: { source_url: source, reference_url: reference },
    key: ctx.key,
  });
  if (!first.ok) {
    ctx.err(`design check failed (${first.status}): ${first.error}`);
    return 1;
  }
  let job = first.data || {};
  if (!isTerminal(job) && job.id) {
    const spinner = makeSpinner(`checking ${source}`, ctx.io);
    let failures = 0;
    const polled = await pollDesignJob(async () => {
      const res = await ctx.request(`/design/adherence/${job.id}`, { key: ctx.key });
      if (!res.ok) {
        failures += 1;
        if (failures >= 3) return { status: 'failed', error: res.error };
        return { status: 'polling' };
      }
      failures = 0;
      return res.data;
    }, { intervalMs: ctx.pollMs, timeoutMs: ctx.maxWaitMs, sleep: ctx.sleep });
    spinner.stop();
    if (polled.timedOut) {
      ctx.err(`still running after ${Math.round(ctx.maxWaitMs / 1000)}s. job id: ${job.id}`);
      return 1;
    }
    job = polled.job || job;
  }
  if (json) { ctx.out(JSON.stringify(job, null, 2)); return job.status === 'completed' ? 0 : 1; }
  if (job.status !== 'completed') {
    ctx.err(`check did not finish: ${job.error || job.status || 'unknown'}`);
    return 1;
  }
  ctx.out(adherenceCard(job));
  return 0;
}

async function designSearch(args, ctx) {
  const json = args.includes('--json');
  const limitFlag = readFlag(args, '--limit');
  if (limitFlag.error) { ctx.err(limitFlag.error); return 1; }
  const bad = unknownFlags(args, ['--json']);
  if (bad.length) { ctx.err(`unknown flag for design search: ${bad.join(' ')}`); return 1; }
  const query = positionals(args).join(' ').trim();
  if (!query) { ctx.err('usage: atris design search "<words>" [--limit n] [--json]'); return 1; }
  let limit;
  if (limitFlag.value != null) {
    limit = parseInt(limitFlag.value, 10);
    if (!Number.isInteger(limit) || limit < 1) {
      ctx.err(`invalid --limit value: "${limitFlag.value}". expected a positive integer.`);
      return 1;
    }
  }

  const body = { query };
  if (limit != null) body.limit = limit;
  const res = await ctx.request('/design/search', { method: 'POST', body, key: ctx.key });
  if (!res.ok) {
    ctx.err(`design search failed (${res.status}): ${res.error}`);
    return 1;
  }
  const data = res.data || {};
  if (json) { ctx.out(JSON.stringify(data, null, 2)); return 0; }
  ctx.out(searchCard(data, query));
  return 0;
}

async function run(args = [], deps = {}) {
  const rest = args.slice();
  if (rest.length === 0 || wantsHelp(rest)) {
    showDesignHelp();
    return rest.length === 0 ? 1 : 0;
  }
  const sub = rest.shift();

  const io = deps.io || {
    out: (s) => process.stdout.write(`${s}\n`),
    err: (s) => process.stderr.write(`${s}\n`),
    write: (s) => process.stdout.write(s),
    tty: Boolean(process.stdout.isTTY),
  };
  const ctx = {
    out: deps.out || io.out,
    err: deps.err || io.err,
    io,
    key: deps.key !== undefined ? deps.key : resolveDesignKey(process.env, deps),
    request: deps.request || designRequest,
    sleep: deps.sleep,
    pollMs: deps.pollMs != null
      ? deps.pollMs
      : Number(process.env.ATRIS_DESIGN_POLL_MS) || undefined,
    maxWaitMs: deps.maxWaitMs != null ? deps.maxWaitMs : 3 * 60 * 1000,
  };

  if (!['extract', 'check', 'search'].includes(sub)) {
    ctx.err(`unknown design subcommand: ${sub}`);
    showDesignHelp();
    return 1;
  }
  if (!ctx.key) {
    ctx.err(NO_KEY);
    return 1;
  }

  try {
    if (sub === 'extract') return await designExtract(rest, ctx);
    if (sub === 'check') return await designCheck(rest, ctx);
    return await designSearch(rest, ctx);
  } catch (error) {
    ctx.err(`design ${sub} failed: ${(error && error.message) || error}`);
    return 1;
  }
}

module.exports = {
  run,
  showDesignHelp,
  extractionCard,
  adherenceCard,
  searchCard,
};
