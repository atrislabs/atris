const http = require('node:http');
const https = require('node:https');

const defaultRouteSource = { name: 'routes', type: 'routes', url: 'https://atrisos.onrender.com/internal/perf/routes' };

const APPROVED_ROUTE_ORIGIN = new URL(defaultRouteSource.url).origin;

function validateRouteSource(source, { allowCustomOrigin = false } = {}) {
  let url;
  try { url = new URL(source.url); } catch { throw new Error('route source must be an http or https url without credentials'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('route source must be an http or https url without credentials, query or fragment');
  }
  if (!allowCustomOrigin && (url.protocol !== 'https:' || url.origin !== APPROVED_ROUTE_ORIGIN)) {
    throw new Error('route source must use the approved https backend origin (set ATRIS_PERF_ROUTES_URL outside the repository to override)');
  }
  return { name: 'routes', type: 'routes', url: url.href };
}

function rankRoutes(snapshot) {
  if (!snapshot || typeof snapshot.since !== 'string' || !Number.isFinite(Date.parse(snapshot.since)) || !Array.isArray(snapshot.routes)) {
    throw new Error('invalid backend route snapshot');
  }
  const routes = snapshot.routes.map(row => {
    if (!row || typeof row.method !== 'string' || !/^[A-Z]+$/.test(row.method) || typeof row.route !== 'string' ||
        !['count', 'errors', 'p50', 'p95', 'p99', 'max'].every(key => Number.isFinite(row[key]) && row[key] >= 0) ||
        !Number.isSafeInteger(row.count) || !Number.isSafeInteger(row.errors) || row.errors > row.count || !Number.isFinite(row.p95 * row.count)) {
      throw new Error('invalid backend route snapshot');
    }
    const { method, route, count, errors, p50, p95, p99, max } = row;
    return { method, route, count, errors, p50, p95, p99, max, score: p95 * count, errorRate: count ? errors / count : 0 };
  }).sort((a, b) => b.score - a.score);
  return { since: snapshot.since, routes };
}

function fetchRoutes(source, secret, timeout = 15000, options = {}) {
  source = validateRouteSource(source, options);
  return new Promise((resolve, reject) => {
    const transport = source.url.startsWith('https:') ? https : http;
    const req = transport.get(source.url, { headers: { authorization: `Bearer ${secret}`, accept: 'application/json' }, agent: false }, res => {
      if (res.statusCode !== 200) {
        const message = res.statusCode === 401 ? 'backend routes: secret is wrong (401)' :
          res.statusCode === 404 ? 'backend routes: backend is not deployed yet (404)' : 'backend routes: request failed';
        req.destroy();
        reject(new Error(message));
        return;
      }
      const chunks = [];
      let size = 0;
      res.on('data', chunk => {
        size += chunk.length;
        if (size > 2 * 1024 * 1024) req.destroy(new Error('response too large'));
        else chunks.push(chunk);
      });
      res.on('error', () => reject(new Error('backend routes: response failed')));
      res.on('end', () => {
        try { resolve(rankRoutes(JSON.parse(Buffer.concat(chunks).toString('utf8')))); }
        catch { reject(new Error('backend routes: invalid snapshot')); }
      });
    });
    const timer = setTimeout(() => req.destroy(new Error('timeout')), timeout);
    req.on('close', () => clearTimeout(timer));
    req.on('error', () => reject(new Error('backend routes: request failed or timed out')));
  });
}

function printRoutes(snapshot, top = 10) {
  console.log(`backend routes since ${snapshot.since}; per worker; reset on deploy`);
  console.log('ranked by p95 × count; timings in milliseconds');
  if (!snapshot.routes.length) console.log('no backend route requests yet');
  for (const row of snapshot.routes.slice(0, top)) {
    console.log(`${row.method} ${row.route}: count ${row.count}; p50 ${row.p50.toFixed(1)}; p95 ${row.p95.toFixed(1)}; p99 ${row.p99.toFixed(1)}; errors ${(row.errorRate * 100).toFixed(1)}%; score ${row.score.toFixed(1)}`);
  }
}

module.exports = { defaultRouteSource, validateRouteSource, rankRoutes, fetchRoutes, printRoutes };
