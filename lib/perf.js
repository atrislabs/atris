const http = require('node:http');
const https = require('node:https');
const { performance } = require('node:perf_hooks');

const defaultTargets = [
  { name: 'atris', url: 'https://atris.ai', weight: 1 },
  { name: 'evals', url: 'https://evals.atris.ai', weight: 1 },
  { name: 'backend', url: 'https://atrisos.onrender.com/health', weight: 1 }
];
const headerNames = ['server', 'x-vercel-id', 'x-vercel-cache', 'cf-cache-status', 'x-cache', 'age', 'cache-control', 'rndr-id', 'x-render-origin-server', 'sb-gateway-version', 'x-amz-cf-pop', 'x-amzn-requestid', 'content-type', 'content-encoding'];

function validateTarget(target) {
  const url = new URL(target.url);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('use an http or https url without credentials');
  if (typeof target.name !== 'string' || !target.name.trim()) throw new Error('target name is required');
  const weight = target.weight ?? 1;
  if (!Number.isFinite(weight) || weight <= 0) throw new Error('weight must be a positive number');
  const method = target.method || 'GET';
  if (!/^[A-Z]+$/.test(method)) throw new Error('method must use uppercase letters');
  if (target.headers && (typeof target.headers !== 'object' || Array.isArray(target.headers) || Object.values(target.headers).some(v => typeof v !== 'string'))) throw new Error('headers must contain string values');
  return { ...target, method, weight };
}

function measure(target, timeout = 15000) {
  target = validateTarget(target);
  const headers = { 'accept-encoding': 'gzip, deflate, br' };
  for (const [key, value] of Object.entries(target.headers || {})) {
    headers[key] = value.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_, name) => {
      if (process.env[name] === undefined) throw new Error(`missing environment variable: ${name}`);
      return process.env[name];
    });
  }
  return new Promise(resolve => {
    const transport = new URL(target.url).protocol === 'https:' ? https : http;
    const agent = new transport.Agent({ keepAlive: false });
    const start = performance.now();
    let lookup = 0, connect = 0, secure = 0, first = 0, bytes = 0, status = null, captured = {}, settled = false;
    const elapsed = () => performance.now() - start;
    const finish = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      agent.destroy();
      const total = elapsed();
      const tlsEnd = secure || (transport === https && connect ? (first || total) : 0);
      resolve({ status, bytes, headers: captured, error: error || null,
        dns: lookup, connect: Math.max(0, connect - lookup), tls: tlsEnd ? tlsEnd - connect : 0,
        ttfb: first || total, wait: Math.max(0, (first || total) - (tlsEnd || connect || lookup)),
        download: first ? total - first : 0, total });
    };
    const req = transport.request(target.url, { method: target.method, headers, agent }, res => {
      first = elapsed();
      status = res.statusCode;
      for (const key of headerNames) if (res.headers[key] !== undefined) captured[key] = res.headers[key];
      res.on('data', chunk => { bytes += chunk.length; });
      res.on('end', () => finish(status >= 400 ? `http ${status}` : null));
      res.on('error', () => finish('response interrupted'));
      res.on('aborted', () => finish('response aborted'));
    });
    const timer = setTimeout(() => { finish('timeout'); req.destroy(); }, timeout);
    req.on('socket', socket => {
      socket.once('lookup', () => { lookup = elapsed(); });
      socket.once('connect', () => { connect = elapsed(); });
      socket.once('secureConnect', () => { secure = elapsed(); });
    });
    req.on('error', err => finish(err.code || 'request failed'));
    req.end();
  });
}

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
}

function provider(headers) {
  if (headers['sb-gateway-version']) return 'supabase';
  if (headers['x-vercel-id']) return 'vercel';
  if (headers['rndr-id'] || headers['x-render-origin-server']) return 'render';
  if (headers['x-amz-cf-pop'] || headers['x-amzn-requestid']) return 'aws';
  if (/cloudflare/i.test(headers.server || '')) return 'cloudflare';
  return 'unknown';
}

function summarize(target, samples, timestamp = new Date().toISOString()) {
  const stats = field => Object.fromEntries([['p50', .5], ['p95', .95], ['p99', .99], ['max', 1]].map(([key, p]) => [key, percentile(samples.map(s => s[field]), p)]));
  const ttfb = stats('ttfb');
  const phases = Object.fromEntries(['dns', 'connect', 'tls', 'wait', 'download'].map(key => [key, percentile(samples.map(s => s[key]), .5)]));
  const warm = percentile(samples.slice(1).map(s => s.ttfb), .5);
  const failures = samples.filter(s => s.error).length;
  const findings = [];
  const add = (code, fix) => findings.push({ code, fix });
  if (samples.some(s => s.bytes > 1024 && /text|json|javascript|xml|svg/i.test(s.headers['content-type'] || '') && (!s.headers['content-encoding'] || s.headers['content-encoding'] === 'identity'))) add('no compression', 'enable gzip or brotli at the origin or edge for text responses over 1 kb');
  if ((target.method || 'GET') === 'GET' && !Object.keys(target.headers || {}).some(k => /authorization|cookie/i.test(k)) && samples.some(s => s.status === 200 && !/private|no-store/i.test(s.headers['cache-control'] || '') && (!s.headers['cache-control'] || ['x-vercel-cache', 'cf-cache-status', 'x-cache'].some(k => /miss/i.test(s.headers[k] || ''))))) add('uncached get', 'for public reads, set cache-control with s-maxage and stale-while-revalidate; inspect cache keys for misses; keep private data uncached');
  if (samples.some(s => s.bytes > 500 * 1024)) add('large payload', 'paginate results, select only needed fields and resize images to reduce payloads below 500 kb');
  if (ttfb.p95 > 800) add('slow ttfb', 'profile server work and database queries; add indexes, remove sequential calls and cache repeated reads');
  if (warm && samples[0].ttfb > 2 * warm) add('cold start', 'check render spin-down or serverless startup; use an always-on instance or reduce startup work and reuse database connections');
  if (phases.connect > 150 || phases.tls > 200) add('distant region', 'measure from user regions and colocate the app and database; use a nearby edge region to reduce connection setup');
  if (failures) add('request failures', 'inspect status codes and timeout errors in samples; check origin logs, health checks, rate limits and database pool capacity');
  if (ttfb.p50 > 0 && ttfb.p99 / ttfb.p50 > 3) add('latency spread', 'inspect slow-query logs, lock waits and connection pool queues for contention; bound concurrency');
  return { name: target.name, url: target.url, method: target.method || 'GET', weight: target.weight ?? 1, timestamp, provider: provider(Object.assign({}, ...samples.map(s => s.headers))), ttfb, total: stats('total'), phases, cold: samples[0]?.ttfb ?? null, warm, failures, errorRate: failures / samples.length, score: ttfb.p95 * (target.weight ?? 1), findings, samples };
}

function rankRuns(runs) {
  const grouped = new Map();
  for (const run of runs) {
    if (!grouped.has(run.name)) grouped.set(run.name, []);
    grouped.get(run.name).push(run);
  }
  return [...grouped.values()].map(history => {
    const latest = history[history.length - 1];
    const previous = history[history.length - 2];
    const delta = previous ? latest.ttfb.p95 - previous.ttfb.p95 : null;
    return { ...latest, delta, deltaPercent: previous?.ttfb.p95 ? delta / previous.ttfb.p95 * 100 : null, history };
  }).sort((a, b) => b.score - a.score);
}

module.exports = { defaultTargets, validateTarget, measure, percentile, provider, summarize, rankRuns };
