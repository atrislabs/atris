const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile, execFileSync } = require('node:child_process');
const { measure, percentile, summarize, rankRuns, provider } = require('../lib/perf');
const { perfCommand } = require('../commands/perf');
const { renderHtml } = require('../lib/perf-html');
const { rankRoutes } = require('../lib/perf-routes');

test('invalid route configuration does not block url checks or target management', async t => {
  const originalExitCode = process.exitCode;
  t.after(() => { process.exitCode = originalExitCode; });
  const originalSecret = process.env.ATRIS_INTERNAL_SECRET;
  const originalLog = console.log;
  const output = [];
  console.log = (...args) => output.push(args.join(' '));
  process.env.ATRIS_INTERNAL_SECRET = 'config-test-secret';
  t.after(() => {
    console.log = originalLog;
    if (originalSecret === undefined) delete process.env.ATRIS_INTERNAL_SECRET;
    else process.env.ATRIS_INTERNAL_SECRET = originalSecret;
  });
  let hits = 0;
  const server = http.createServer((req, res) => { hits++; res.end('ok'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-perf-config-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'atris/perf');
  fs.mkdirSync(dir, { recursive: true });
  const url = `http://127.0.0.1:${server.address().port}`;
  const badSource = { name: 'routes', type: 'routes', url: 'invalid-source' };
  fs.writeFileSync(path.join(dir, 'targets.json'), JSON.stringify([{ name: 'local', url }, badSource]));
  await perfCommand(['run', '--target', 'local', '--samples', '1'], root);
  assert.equal(hits, 1);
  await perfCommand(['add', 'another', url], root);
  await perfCommand(['list'], root);
  await perfCommand(['remove', 'another'], root);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'targets.json'), 'utf8')).find(t => t.type === 'routes'), badSource);
  output.length = 0;
  await perfCommand(['--samples', '1'], root);
  assert.equal(hits, 2);
  assert.equal(output.filter(line => line.startsWith('route source must be')).length, 1);
  assert.ok(output.some(line => line.startsWith('performance ranked')));
  output.length = 0;
  await perfCommand(['routes'], root);
  assert.equal(output.length, 1);
  assert.match(output[0], /route source must be/);
});

test('target management rejects names shared by urls and route sources', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-perf-names-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  await assert.rejects(perfCommand(['add', 'routes', 'http://localhost'], root), /reserved/);
  const dir = path.join(root, 'atris/perf');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'targets.json');
  const source = { name: 'backend', type: 'routes', url: 'http://localhost/internal/perf/routes' };
  fs.writeFileSync(file, JSON.stringify([source]));
  await assert.rejects(perfCommand(['add', 'backend', 'http://localhost'], root), /already exists/);
  const duplicates = JSON.stringify([source, { name: 'backend', url: 'http://localhost/health' }]);
  fs.writeFileSync(file, duplicates);
  for (const args of [['list'], ['remove', 'backend'], ['add', 'other', 'http://localhost']]) {
    await assert.rejects(perfCommand(args, root), /names must be unique/);
    assert.equal(fs.readFileSync(file, 'utf8'), duplicates);
  }
});

test('multiple route sources fail collection without blocking default url checks', async t => {
  const originalExitCode = process.exitCode;
  const originalSecret = process.env.ATRIS_INTERNAL_SECRET;
  const originalLog = console.log;
  const output = [];
  console.log = (...args) => output.push(args.join(' '));
  process.env.ATRIS_INTERNAL_SECRET = 'multiple-sources-test-secret';
  t.after(() => {
    process.exitCode = originalExitCode;
    console.log = originalLog;
    if (originalSecret === undefined) delete process.env.ATRIS_INTERNAL_SECRET;
    else process.env.ATRIS_INTERNAL_SECRET = originalSecret;
  });
  let urlHits = 0, routeHits = 0;
  const server = http.createServer((req, res) => {
    if (req.url === '/health') urlHits++;
    else routeHits++;
    res.end('ok');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-perf-sources-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'atris/perf');
  fs.mkdirSync(dir, { recursive: true });
  const url = `http://127.0.0.1:${server.address().port}`;
  for (const name of ['another-source', 'routes']) {
    fs.writeFileSync(path.join(dir, 'targets.json'), JSON.stringify([
      { name: 'local', url: url + '/health' },
      { name: 'routes', type: 'routes', url: url + '/first' },
      { name, type: 'routes', url: url + '/second' }
    ]));
    output.length = 0;
    process.exitCode = undefined;
    await perfCommand(['routes'], root);
    assert.equal(process.exitCode, 1);
    assert.deepEqual(output, ['configure only one backend route source']);
    output.length = 0;
    process.exitCode = undefined;
    await perfCommand(['--samples', '1'], root);
    assert.equal(process.exitCode, undefined);
    assert.equal(output.filter(line => line === 'configure only one backend route source').length, 1);
    assert.ok(output.some(line => line.startsWith('performance ranked')));
  }
  assert.equal(urlHits, 2);
  assert.equal(routeHits, 0);
  assert.ok(!fs.existsSync(path.join(dir, 'routes.jsonl')));
});

test('reports skip corrupt route history and keep the latest valid snapshot', async t => {
  const originalLog = console.log;
  const output = [];
  console.log = (...args) => output.push(args.join(' '));
  t.after(() => { console.log = originalLog; });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-perf-history-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'atris/perf');
  fs.mkdirSync(dir, { recursive: true });
  const snapshot = { since: '2026-11-18T00:00:00Z', timestamp: '2026-11-18T01:00:00Z', routes: [
    { method: 'GET', route: '/valid', count: 1, errors: 0, p50: 1, p95: 2, p99: 3, max: 3 }
  ] };
  const history = path.join(dir, 'routes.jsonl');
  fs.writeFileSync(history, ['not json', JSON.stringify(snapshot), 'null', '{}', '{"routes":'].join('\n'));
  await perfCommand(['report', '--json'], root);
  assert.deepEqual(JSON.parse(output.at(-1)), []);
  await perfCommand(['report', '--html'], root);
  assert.ok(output.some(line => line.startsWith('GET /valid:')));
  assert.match(fs.readFileSync(path.join(dir, 'report.html'), 'utf8'), /\/valid/);
  for (const content of ['', '{"truncated":']) {
    fs.writeFileSync(history, content);
    await perfCommand(['report', '--html'], root);
    assert.match(fs.readFileSync(path.join(dir, 'report.html'), 'utf8'), /no backend route snapshots yet/);
  }
});

test('explicit routes failures exit nonzero while the default flow continues', async t => {
  let mode = 'success';
  let urlHits = 0;
  const server = http.createServer((req, res) => {
    if (req.url === '/health') { urlHits++; res.end('ok'); return; }
    assert.equal(req.headers.authorization, 'Bearer exit-test-secret');
    if (mode === 'network') { req.socket.destroy(); return; }
    res.writeHead(typeof mode === 'number' ? mode : 200);
    res.end(JSON.stringify({ since: '2026-11-18T00:00:00Z', routes: [] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-perf-exit-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'atris/perf');
  fs.mkdirSync(dir, { recursive: true });
  const url = `http://127.0.0.1:${server.address().port}`;
  fs.writeFileSync(path.join(dir, 'targets.json'), JSON.stringify([
    { name: 'local', url: url + '/health' },
    { name: 'routes', type: 'routes', url: url + '/internal/perf/routes' }
  ]));
  const command = path.resolve(__dirname, '../commands/perf.js');
  const run = (args, secret = 'exit-test-secret') => new Promise(resolve => {
    execFile(process.execPath, ['-e', 'require(process.argv[1]).perfCommand(JSON.parse(process.argv[2]), process.argv[3]).catch(() => { process.exitCode = 1; })', command, JSON.stringify(args), root],
      { env: { ...process.env, ATRIS_INTERNAL_SECRET: secret, ATRIS_PERF_ROUTES_URL: url + '/internal/perf/routes' } },
      (error, stdout, stderr) => resolve({ code: error?.code || 0, stdout, stderr }));
  });
  assert.equal((await run(['routes'])).code, 0);
  fs.rmSync(path.join(dir, 'routes.jsonl'));
  for (const failure of ['missing', 401, 404, 'network', 'save']) {
    mode = failure;
    if (failure === 'save') fs.mkdirSync(path.join(dir, 'routes.jsonl'));
    const secret = failure === 'missing' ? '' : 'exit-test-secret';
    const explicit = await run(['routes'], secret);
    assert.equal(explicit.code, 1, String(failure));
    assert.equal(explicit.stdout.trim().split('\n').length, 1);
    assert.equal(explicit.stderr, '');
    assert.ok(!explicit.stdout.includes('exit-test-secret'));
    const normal = await run(['--samples', '1'], secret);
    assert.equal(normal.code, 0, normal.stderr);
    assert.match(normal.stdout, /performance ranked/);
    if (failure === 'save') fs.rmSync(path.join(dir, 'routes.jsonl'), { recursive: true });
  }
  assert.equal(urlHits, 5);
});

test('backend routes authenticate, rank, record and survive missing or wrong secrets', async t => {
  const originalExitCode = process.exitCode;
  t.after(() => { process.exitCode = originalExitCode; });
  const originalSecret = process.env.ATRIS_INTERNAL_SECRET;
  const originalRouteUrl = process.env.ATRIS_PERF_ROUTES_URL;
  const originalLog = console.log;
  const output = [];
  console.log = (...args) => output.push(args.join(' '));
  t.after(() => {
    console.log = originalLog;
    if (originalRouteUrl === undefined) delete process.env.ATRIS_PERF_ROUTES_URL;
    else process.env.ATRIS_PERF_ROUTES_URL = originalRouteUrl;
    if (originalSecret === undefined) delete process.env.ATRIS_INTERNAL_SECRET;
    else process.env.ATRIS_INTERNAL_SECRET = originalSecret;
  });
  let status = 200, hits = 0, urlHits = 0;
  let snapshot = { since: '2026-11-18T00:00:00Z', routes: [
    { method: 'GET', route: '/fast/{id}', count: 20, errors: 2, p50: 1, p95: 2, p99: 3, max: 4, score: 9999 },
    { method: 'POST', route: '/slow/<id>', count: 10, errors: 0, p50: 4, p95: 8, p99: 10, max: 12, score: 0 }
  ] };
  const secret = 'runtime-test-secret';
  const server = http.createServer((req, res) => {
    if (req.url === '/health') { urlHits++; res.end('ok'); return; }
    hits++;
    assert.equal(req.url, '/internal/perf/routes');
    const code = req.headers.authorization === `Bearer ${secret}` ? status : 401;
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(code === 200 ? JSON.stringify(snapshot) : secret);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-perf-routes-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q'], { cwd: root });
  const dir = path.join(root, 'atris/perf');
  fs.mkdirSync(dir, { recursive: true });
  const url = `http://127.0.0.1:${server.address().port}`;
  process.env.ATRIS_PERF_ROUTES_URL = url + '/internal/perf/routes';
  const config = [{ name: 'local', url: url + '/health' }, { name: 'routes', type: 'routes', url: url + '/internal/perf/routes' }];
  fs.writeFileSync(path.join(dir, 'targets.json'), JSON.stringify(config));
  delete process.env.ATRIS_INTERNAL_SECRET;
  await perfCommand(['routes'], root);
  assert.equal(hits, 0);
  assert.equal(output.length, 1);
  assert.match(output[0], /atris_internal_secret.*uppercase/);
  assert.equal(output[0], output[0].toLowerCase());
  await perfCommand(['--samples', '1'], root);
  assert.equal(urlHits, 1);
  assert.equal(hits, 0);
  process.env.ATRIS_INTERNAL_SECRET = secret;
  output.length = 0;
  await perfCommand(['routes', '--top', '1'], root);
  assert.equal(hits, 1);
  assert.match(output.join('\n'), /since 2026-11-18.*per worker; reset on deploy/);
  assert.match(output.join('\n'), /POST \/slow\/<id>.*score 80.0/);
  assert.ok(!output.some(line => line.includes('/fast/')));
  const history = path.join(dir, 'routes.jsonl');
  const saved = fs.readFileSync(history, 'utf8');
  const record = JSON.parse(saved);
  assert.equal(record.routes.length, 2);
  assert.deepEqual(record.routes.map(r => r.score), [80, 40]);
  assert.equal(record.routes[1].errorRate, .1);
  assert.equal(execFileSync('git', ['check-ignore', 'atris/perf/routes.jsonl'], { cwd: root, encoding: 'utf8' }), 'atris/perf/routes.jsonl\n');
  await perfCommand(['report', '--html'], root);
  const html = fs.readFileSync(path.join(dir, 'report.html'), 'utf8');
  assert.match(html, /backend routes/);
  assert.match(html, /\/slow\/&lt;id&gt;/);
  assert.ok(html.indexOf('/slow/') < html.indexOf('/fast/'));
  assert.doesNotMatch(html, /<(script|link|img)[^>]+(?:src|href)=/i);
  process.env.ATRIS_INTERNAL_SECRET = 'wrong-secret';
  await perfCommand(['routes'], root);
  assert.match(output.at(-1), /secret is wrong \(401\)/);
  process.env.ATRIS_INTERNAL_SECRET = secret;
  status = 404;
  await perfCommand(['routes'], root);
  assert.match(output.at(-1), /not deployed yet \(404\)/);
  status = 503;
  await perfCommand(['routes'], root);
  assert.match(output.at(-1), /request failed/);
  assert.equal(fs.readFileSync(history, 'utf8'), saved);
  assert.ok(!output.join('\n').includes(secret));
  assert.ok(!saved.includes(secret));
  assert.ok(!html.includes(secret));
  assert.ok(!fs.readFileSync(path.join(dir, 'targets.json'), 'utf8').includes(secret));
  status = 200;
  snapshot = { since: snapshot.since, routes: [] };
  await perfCommand(['--samples', '1'], root);
  assert.equal(urlHits, 2);
  assert.equal(fs.readFileSync(history, 'utf8').trim().split('\n').length, 2);
  assert.ok(output.some(line => line === 'no backend route requests yet'));
  snapshot = { invalid: secret };
  await perfCommand(['routes'], root);
  assert.match(output.at(-1), /invalid snapshot/);
  await assert.rejects(perfCommand(['routes', '--top', '0'], root), /top/);
  assert.throws(() => rankRoutes({ since: 'bad', routes: [] }), /invalid/);
  assert.throws(() => rankRoutes({ since: '2026-11-18', routes: [{ count: -1 }] }), /invalid/);
  await perfCommand(['add', 'another', url], root);
  await perfCommand(['remove', 'another'], root);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'targets.json'), 'utf8')).find(t => t.type === 'routes').url, config[1].url);
});

test('nearest rank percentiles, provider detection and empty reports', () => {
  assert.equal(percentile([], .95), null);
  assert.equal(percentile([10, 1, 4, 7], .5), 4);
  assert.equal(percentile([10, 1, 4, 7], .95), 10);
  assert.deepEqual(rankRuns([]), []);
  assert.match(renderHtml([]), /no runs yet/);
  for (const [headers, expected] of [[{'sb-gateway-version':'1'}, 'supabase'], [{'x-vercel-id':'1'}, 'vercel'], [{'rndr-id':'1',server:'cloudflare'}, 'render'], [{'x-amzn-requestid':'1'}, 'aws'], [{server:'cloudflare'}, 'cloudflare'], [{}, 'unknown']]) assert.equal(provider(headers), expected);
});

test('real requests measure phases, failures, slow reads and append report history', async t => {
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    sockets.add(req.socket);
    if (req.url === '/timeout') return;
    if (req.url === '/error') { res.writeHead(503); res.end('unavailable'); return; }
    if (req.url === '/headers') { assert.equal(req.headers.apikey, 'local-only'); }
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'text/plain', 'x-vercel-id': 'local', 'x-vercel-cache': 'MISS' });
      res.end('a'.repeat(2048));
    }, req.url === '/slow' ? 830 : 5);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-perf-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q'], { cwd: root });
  fs.writeFileSync(path.join(root, '.gitignore'), 'existing-rule\n');
  const url = `http://127.0.0.1:${server.address().port}`;
  const target = { name: 'local', url, weight: 2 };
  const first = await measure(target);
  const second = await measure(target);
  assert.equal(sockets.size, 2);
  assert.equal(first.status, 200);
  assert.equal(first.bytes, 2048);
  assert.equal(first.headers['x-vercel-id'], 'local');
  assert.ok(first.ttfb > 0 && first.total >= first.ttfb);
  assert.ok(first.connect > 0 && first.tls === 0 && first.dns === 0);
  assert.ok(Math.abs(first.connect + first.wait + first.download - first.total) < 1);
  const summary = summarize(target, [first, second]);
  assert.equal(summary.provider, 'vercel');
  assert.equal(summary.score, summary.ttfb.p95 * 2);
  assert.ok(summary.findings.some(f => f.code === 'no compression'));
  assert.ok(summary.findings.some(f => f.code === 'uncached get'));
  const slow = summarize({ name: 'slow', url }, [await measure({ name: 'slow', url: url + '/slow' })]);
  assert.ok(slow.findings.some(f => f.code === 'slow ttfb'));
  assert.equal(rankRuns([summary, slow])[0].name, 'slow');
  const failure = await measure({ name: 'error', url: url + '/error' });
  assert.equal(failure.error, 'http 503');
  const timeout = await measure({ name: 'timeout', url: url + '/timeout' }, 30);
  assert.equal(timeout.error, 'timeout');
  assert.ok(timeout.connect > 0);
  assert.ok(timeout.wait > 0);
  assert.equal(timeout.ttfb, timeout.total);
  assert.ok(Math.abs(timeout.dns + timeout.connect + timeout.tls + timeout.wait + timeout.download - timeout.total) < 1);
  assert.ok(summarize(target, [failure, timeout]).findings.some(f => f.code === 'request failures'));
  process.env.ATRIS_PERF_TEST_KEY = 'local-only';
  t.after(() => delete process.env.ATRIS_PERF_TEST_KEY);
  await measure({ name: 'headers', url: url + '/headers', headers: { apikey: '$ATRIS_PERF_TEST_KEY' } });
  assert.throws(() => measure({ name:'missing', url, headers:{ apikey:'$ATRIS_PERF_UNSET_KEY' } }), /missing environment/);
  await perfCommand(['add', 'local', url, '--weight', '2'], root);
  await assert.rejects(perfCommand(['add', 'local', url], root), /already exists/);
  await perfCommand(['list'], root);
  await perfCommand(['run', '--samples', '2'], root);
  await perfCommand(['run', '--samples', '1'], root);
  const file = path.join(root, 'atris/perf/runs.jsonl');
  const runs = fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(runs.length, 2);
  assert.equal(runs[0].samples.length, 2);
  assert.ok(runs[0].timestamp);
  assert.equal(rankRuns(runs)[0].delta, runs[1].ttfb.p95 - runs[0].ttfb.p95);
  await perfCommand(['report', '--html'], root);
  const html = fs.readFileSync(path.join(root, 'atris/perf/report.html'), 'utf8');
  assert.equal(execFileSync('git', ['check-ignore', 'atris/perf/runs.jsonl', 'atris/perf/report.html'], { cwd: root, encoding: 'utf8' }), 'atris/perf/runs.jsonl\natris/perf/report.html\n');
  const ignore = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
  assert.ok(ignore.startsWith('existing-rule\n'));
  assert.equal(ignore.split('atris/perf/runs.jsonl').length, 2);
  assert.equal(ignore.split('atris/perf/report.html').length, 2);
  assert.match(html, /<svg/);
  assert.match(html, /<style>/);
  assert.match(html, /p95 ttfb trend/);
  assert.doesNotMatch(html, /<(script|link|img)[^>]+(?:src|href)=/i);
  assert.ok(!fs.readFileSync(file, 'utf8').includes('local-only'));
  assert.ok(renderHtml([{...rankRuns(runs)[0], name:'<script>alert(1)</script>'}]).includes('&lt;script&gt;'));
  await assert.rejects(perfCommand(['run', '--samples', '0'], root), /samples/);
  await assert.rejects(perfCommand(['run', '--target', 'absent'], root), /not found/);
  await assert.rejects(perfCommand(['add', 'bad', 'ftp://example.com'], root), /http/);
  await perfCommand(['remove', 'local'], root);
  await assert.rejects(perfCommand(['remove', 'local'], root), /not found/);
  await perfCommand(['run'], root);
  assert.equal(fs.readFileSync(file, 'utf8').trim().split('\n').length, 2);
});


test('repository route sources cannot send secrets to unapproved origins', async t => {
  const oldSecret = process.env.ATRIS_INTERNAL_SECRET, oldUrl = process.env.ATRIS_PERF_ROUTES_URL, oldExit = process.exitCode, oldLog = console.log;
  const output = []; console.log = (...args) => output.push(args.join(' '));
  process.env.ATRIS_INTERNAL_SECRET = 'secret'; delete process.env.ATRIS_PERF_ROUTES_URL;
  t.after(() => { console.log = oldLog; process.exitCode = oldExit; if (oldSecret === undefined) delete process.env.ATRIS_INTERNAL_SECRET; else process.env.ATRIS_INTERNAL_SECRET = oldSecret; if (oldUrl === undefined) delete process.env.ATRIS_PERF_ROUTES_URL; else process.env.ATRIS_PERF_ROUTES_URL = oldUrl; });
  let hits = 0; const server = http.createServer((req, res) => { hits++; res.end(); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-origin-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'atris/perf'); fs.mkdirSync(dir, { recursive: true });
  for (const url of [`http://127.0.0.1:${server.address().port}/steal`, 'https://evil.example/internal/perf/routes']) {
    fs.writeFileSync(path.join(dir, 'targets.json'), JSON.stringify([{ name: 'routes', type: 'routes', url }]));
    output.length = 0; process.exitCode = undefined; await perfCommand(['routes'], root);
    assert.equal(process.exitCode, 1); assert.match(output.join(' '), /approved https backend origin/); assert.equal(hits, 0);
  }
});
