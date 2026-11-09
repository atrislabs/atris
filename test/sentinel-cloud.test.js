'use strict';

// Sentinel on Atris models, upload, and the review timer, against a local
// fake backend. No real network, no credits.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFileSync } = require('node:child_process');
const cloud = require('../lib/sentinel-cloud');
const { auditCommand } = require('../commands/security-review');

function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-cloud-target-'));
  fs.mkdirSync(path.join(root, 'lib'));
  fs.writeFileSync(path.join(root, 'lib', 'run.js'), [
    "const { execSync } = require('child_process');",
    'function runTask(task) {',
    '  const title = task.title;',
    '  return execSync(`echo ${title}`);',
    '}',
    'module.exports = { runTask };',
    '',
  ].join('\n'));
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], { cwd: root });
  return root;
}

const CANDIDATE = {
  proposed_verdict: 'confirmed',
  fingerprint: 'lib/run.js:runTask/shell-from-task-title',
  title: 'Task title runs as shell code',
  description: 'runTask puts the task title inside a shell string.',
  attack_class: 'command-injection',
  attacker: 'anyone who can create a task',
  root_cause: 'execSync gets a template string with the title in it',
  intended_behavior: 'the title is passed as an argument, never as shell text',
  impact: 'code execution as the user running the task',
  trace: [
    { kind: 'entrypoint', file: 'lib/run.js', line: 2, description: 'task arrives' },
    { kind: 'propagation', file: 'lib/run.js', line: 3, description: 'title read' },
    { kind: 'sink', file: 'lib/run.js', line: 4, description: 'execSync with title' },
  ],
  conditions: [{ kind: 'authorization_role', description: 'can create a task' }],
  severity: { likelihood: { score: 'medium', reason: 'tasks come from other people' }, impact: { score: 'high', reason: 'code execution' }, overall: 'high' },
  remediation: { strategy: 'use execFileSync with an argv array', regression_test: 'a title with $(touch x) creates no file' },
};

// What a model would answer for each sentinel prompt.
function answerFor(prompt, { verdict, candidate = CANDIDATE }) {
  if (prompt.includes('security hunter')) {
    const ids = [...prompt.matchAll(/coverage_id: (\S+)/g)].map((m) => m[1]);
    const isRun = prompt.includes('starting paths: lib/run.js') && prompt.includes('command-injection');
    const CANDIDATE = candidate;
    return JSON.stringify({
      units: ids.map((id) => ({ coverage_id: id, disposition: isRun ? 'candidate' : 'covered', reviewed_paths: ['lib/run.js'], checks: [{ invariant: 'input never becomes shell text', method: 'source', result: 'read it', reviewed_paths: ['lib/run.js'] }], candidate_fingerprints: isRun ? [CANDIDATE.fingerprint] : [], unresolved: [] })),
      candidates: isRun ? [{ ...CANDIDATE, coverage_ids: ids }] : [],
      hardening: ['pin the child_process import to execFile only'],
      uncovered: [],
    });
  }
  if (prompt.includes('independent security verifier')) return JSON.stringify({ verdict, reason: 'line 4 puts the title in a shell string', preventing_layer: verdict === 'rejected' ? 'lib/run.js:3' : null, corrected: {}, blockers: [], validation_plan: [] });
  if (prompt.includes('coverage critic')) return JSON.stringify({ missing_units: [], reassign_ids: [], stop: true });
  if (prompt.includes('final record checker')) return '{"ok": true}';
  return 'no idea';
}

// A fake Atris backend: quotes, streamed turns with a billing receipt, and
// the sentinel runs route.
async function fakeBackend({ verdict = 'confirmed', uploadStatus = 201, quoteStatus = 200, candidate = CANDIDATE } = {}) {
  const log = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      const entry = { method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), auth: req.headers.authorization, body: raw ? JSON.parse(raw) : null };
      log.push(entry);
      if (url.pathname === '/api/atris2/billing/quote') {
        if (quoteStatus !== 200) { res.writeHead(quoteStatus, { 'content-type': 'application/json' }); res.end('{"detail":"nope"}'); return; }
        const credits = entry.query.model === 'atris:fast' ? 2 : 5;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ model: entry.query.model, credits, cost_usd: credits / 100 }));
        return;
      }
      if (url.pathname === '/api/atris2/turn') {
        const text = answerFor(entry.body.message, { verdict, candidate });
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const half = Math.floor(text.length / 2);
        res.write(`data: ${JSON.stringify({ type: 'text_delta', content: text.slice(0, half) })}\n\n`);
        res.write(`data: ${JSON.stringify({ type: 'text_delta', content: text.slice(half) })}\n\n`);
        res.write(`data: ${JSON.stringify({ type: 'result', result: text })}\n\n`);
        res.write(`data: ${JSON.stringify({ type: 'receipt', receipt: { model: entry.body.model, billing: { billed: true, credits_charged: entry.body.model === 'atris:fast' ? 1 : 3 } } })}\n\n`);
        res.end();
        return;
      }
      if (url.pathname === '/api/sentinel/runs' && req.method === 'POST') {
        res.writeHead(uploadStatus, { 'content-type': 'application/json' });
        res.end(uploadStatus === 201 ? '{"id":"run-uuid-1"}' : '{"detail":"database is down"}');
        return;
      }
      res.writeHead(404); res.end();
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  return { log, base, close: () => new Promise((r) => server.close(r)) };
}

// Runs fn with a temp audit home, the fake backend's address, and captured output.
async function withEnv(backend, fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-cloud-home-'));
  const saved = { home: process.env.ATRIS_SECURITY_AUDIT_HOME, api: process.env.ATRIS_API_URL };
  process.env.ATRIS_SECURITY_AUDIT_HOME = home;
  process.env.ATRIS_API_URL = backend.base;
  const out = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...a) => out.push(a.join(' '));
  console.error = (...a) => out.push(a.join(' '));
  try {
    return await fn({ home, out });
  } finally {
    console.log = origLog;
    console.error = origErr;
    for (const [k, v] of [['ATRIS_SECURITY_AUDIT_HOME', saved.home], ['ATRIS_API_URL', saved.api]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    fs.rmSync(home, { recursive: true, force: true });
  }
}

const NO_LOCAL = { PATH: '' };

test('the price is quoted first, and a no spends nothing', async () => {
  const backend = await fakeBackend();
  const root = makeRepo();
  try {
    await withEnv(backend, async ({ home, out }) => {
      let asked = 0;
      const code = await auditCommand(['--engine', 'atris', '--quick'], { root, token: 'tok', env: NO_LOCAL, input: { isTTY: true }, ask: async () => { asked += 1; return false; } });
      assert.strictEqual(code, 1);
      assert.strictEqual(asked, 1);
      const quotes = backend.log.filter((e) => e.path === '/api/atris2/billing/quote');
      assert.deepStrictEqual(quotes.map((q) => q.query.model).sort(), ['atris:fast', 'atris:pro']);
      assert.ok(quotes.every((q) => q.auth === 'Bearer tok' && Number(q.query.input_tokens) > 0 && Number(q.query.output_tokens) > 0));
      assert.ok(!backend.log.some((e) => e.path === '/api/atris2/turn'), 'no turn after a no');
      assert.ok(!backend.log.some((e) => e.path === '/api/sentinel/runs'));
      assert.ok(out.join('\n').includes('costs at most'));
      assert.ok(out.join('\n').includes('nothing was spent'));
      // quick budget 8: 4 hunters at 2 credits, 4 checks at 5 credits.
      assert.ok(out.join('\n').includes('at most 28 credits'), out.join('\n'));
      const repoDir = fs.readdirSync(home).map((d) => path.join(home, d))[0];
      assert.ok(!repoDir || !fs.readdirSync(repoDir).length, 'a declined run leaves no folder');
    });
  } finally { await backend.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('without a terminal and without --yes nothing runs', async () => {
  const backend = await fakeBackend();
  const root = makeRepo();
  try {
    await withEnv(backend, async ({ out }) => {
      const code = await auditCommand(['--engine', 'atris', '--quick'], { root, token: 'tok', env: NO_LOCAL });
      assert.strictEqual(code, 1);
      assert.ok(!backend.log.some((e) => e.path === '/api/atris2/turn'));
      assert.ok(out.join('\n').includes('add --yes'));
    });
  } finally { await backend.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('a failed quote stops the run before any spend', async () => {
  const backend = await fakeBackend({ quoteStatus: 500 });
  const root = makeRepo();
  try {
    await withEnv(backend, async () => {
      const code = await auditCommand(['--engine', 'atris', '--quick', '--yes'], { root, token: 'tok', env: NO_LOCAL });
      assert.strictEqual(code, 2);
      assert.ok(!backend.log.some((e) => e.path === '/api/atris2/turn'));
    });
  } finally { await backend.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('after a yes, hunters run on atris:fast and checks on atris:pro, then the summary uploads in the contract shape', async () => {
  const backend = await fakeBackend();
  const root = makeRepo();
  try {
    await withEnv(backend, async ({ out }) => {
      const code = await auditCommand(['--engine', 'atris', '--quick'], { root, token: 'tok', env: NO_LOCAL, input: { isTTY: true }, ask: async () => true });
      assert.strictEqual(code, 1, out.join('\n')); // a confirmed high finding fails the run
      const order = backend.log.map((e) => e.path);
      const firstTurn = order.indexOf('/api/atris2/turn');
      assert.deepStrictEqual(backend.log.slice(0, firstTurn).filter((e) => e.path === '/api/atris2/billing/quote').slice(0, 2).map((q) => q.query.model).sort(), ['atris:fast', 'atris:pro'], 'the whole-run quote comes before the first turn');
      // Every turn is priced on its own first, at its exact size and output limit.
      const turnsAndQuotes = backend.log.filter((e) => e.path !== '/api/sentinel/runs');
      turnsAndQuotes.forEach((e, i) => {
        if (e.path !== '/api/atris2/turn') return;
        const before = turnsAndQuotes.slice(0, i).filter((q) => q.path === '/api/atris2/billing/quote' && q.query.model === e.body.model);
        assert.ok(before.some((q) => Number(q.query.input_tokens) >= Buffer.byteLength(e.body.message) && Number(q.query.output_tokens) === e.body.max_output_tokens), 'a call is priced at least at its own size');
        assert.strictEqual(e.body.max_output_tokens, e.body.model === 'atris:fast' ? 8192 : 4096);
      });
      const turns = backend.log.filter((e) => e.path === '/api/atris2/turn');
      assert.ok(turns.length >= 3);
      for (const t of turns) {
        assert.strictEqual(t.auth, 'Bearer tok');
        const p = t.body.message;
        if (p.includes('security hunter')) assert.strictEqual(t.body.model, 'atris:fast');
        else assert.strictEqual(t.body.model, 'atris:pro', p.slice(0, 80));
      }
      const hunterTurn = turns.find((t) => t.body.model === 'atris:fast' && t.body.message.includes('starting paths: lib/run.js'));
      assert.ok(hunterTurn.body.message.includes('    4    return execSync(`echo ${title}`);'), 'hosted hunters get numbered source');
      assert.ok(turns.some((t) => t.body.message.includes('independent security verifier') && t.body.message.includes('## Source')));

      const uploads = backend.log.filter((e) => e.path === '/api/sentinel/runs');
      assert.strictEqual(uploads.length, 1);
      const body = uploads[0].body;
      assert.strictEqual(uploads[0].auth, 'Bearer tok');
      assert.deepStrictEqual(Object.keys(body).sort(), ['counts', 'coverage', 'credits_used', 'finished_at', 'findings', 'hardening', 'needs_validation', 'profile', 'repo', 'run_id', 'source', 'started_at'].sort());
      assert.deepStrictEqual(Object.keys(body.coverage).sort(), ['blocked', 'deferred', 'done', 'in_scope']);
      assert.deepStrictEqual(Object.keys(body.counts).sort(), ['confirmed', 'needs_validation', 'rejected', 'severity']);
      assert.deepStrictEqual(Object.keys(body.counts.severity), ['critical', 'high', 'medium', 'low', 'informational']);
      assert.strictEqual(body.source, 'atris-models');
      assert.strictEqual(body.profile, 'quick');
      assert.match(body.run_id, /^run-\d+$/);
      assert.ok(!Number.isNaN(Date.parse(body.started_at)) && !Number.isNaN(Date.parse(body.finished_at)));
      assert.strictEqual(body.counts.confirmed, 1);
      assert.strictEqual(body.counts.severity.high, 1);
      // The fix names execFileSync (camelCase), so it is replaced, never cleaned.
      assert.deepStrictEqual(body.findings.map(({ id, ...f }) => f), [{ severity: 'high', title: CANDIDATE.title, location: 'lib/run.js:4', fix: cloud.FALLBACK_SENTENCE, status: 'open' }]);
      assert.match(body.findings[0].id, /^f-[0-9a-f]{12}$/);
      assert.deepStrictEqual(body.needs_validation, []);
      assert.deepStrictEqual(body.hardening, [cloud.FALLBACK_SENTENCE]);
      // Every turn's receipt counts: 1 per fast call, 3 per pro call.
      const expected = turns.reduce((n, t) => n + (t.body.model === 'atris:fast' ? 1 : 3), 0);
      assert.strictEqual(body.credits_used, expected);
      const text = JSON.stringify(body);
      assert.ok(!text.includes('execSync('), 'no source code in the upload');
      assert.ok(!text.includes('trace') && !text.includes('"code"'));
      assert.ok(out.join('\n').includes('saved the summary to your atris account'));
      assert.ok(out.join('\n').includes(`${expected} credits used`));
    });
  } finally { await backend.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('a failed upload warns and keeps the review result', async () => {
  const backend = await fakeBackend({ verdict: 'rejected', uploadStatus: 500 });
  const root = makeRepo();
  try {
    await withEnv(backend, async ({ out }) => {
      const code = await auditCommand(['--engine', 'atris', '--quick', '--yes'], { root, token: 'tok', env: NO_LOCAL });
      assert.strictEqual(code, 0, out.join('\n'));
      assert.strictEqual(backend.log.filter((e) => e.path === '/api/sentinel/runs').length, 1);
      assert.ok(out.join('\n').includes('warning: could not save the summary'));
      assert.ok(out.join('\n').includes('database is down'));
    });
  } finally { await backend.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('--no-upload keeps the run local, and sentinel upload saves it later', async () => {
  const backend = await fakeBackend({ verdict: 'rejected' });
  const root = makeRepo();
  try {
    await withEnv(backend, async ({ out }) => {
      const code = await auditCommand(['--engine', 'atris', '--quick', '--yes', '--no-upload'], { root, token: 'tok', env: NO_LOCAL });
      assert.strictEqual(code, 0, out.join('\n'));
      assert.ok(!backend.log.some((e) => e.path === '/api/sentinel/runs'));
      const up = await auditCommand(['upload'], { root, token: 'tok' });
      assert.strictEqual(up, 0, out.join('\n'));
      const uploads = backend.log.filter((e) => e.path === '/api/sentinel/runs');
      assert.strictEqual(uploads.length, 1);
      assert.strictEqual(uploads[0].body.counts.rejected, 1);
      assert.strictEqual(uploads[0].body.findings.length, 0);
      assert.strictEqual(await auditCommand(['upload'], { root, token: '' }), 2);
    });
  } finally { await backend.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('a local run that is not logged in never calls the backend', async () => {
  const backend = await fakeBackend({ verdict: 'rejected' });
  const root = makeRepo();
  try {
    await withEnv(backend, async ({ out }) => {
      const runJobs = async (jobs) => jobs.map((j) => ({ ok: true, stdout: answerFor(j.prompt, { verdict: 'rejected' }) }));
      const code = await auditCommand(['--quick'], { root, token: '', env: NO_LOCAL, runJobs });
      assert.strictEqual(code, 0, out.join('\n'));
      assert.strictEqual(backend.log.length, 0);
    });
  } finally { await backend.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('engine choice: local stays the default, atris only without local engines', () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-bin-'));
  try {
    fs.writeFileSync(path.join(bin, 'codex'), '#!/bin/sh\n');
    fs.chmodSync(path.join(bin, 'codex'), 0o755);
    assert.strictEqual(cloud.resolveEngines({ token: 'tok', env: { PATH: bin } }).mode, 'local');
    assert.deepStrictEqual(cloud.resolveEngines({ token: 'tok', env: NO_LOCAL }), { mode: 'atris', hunter: 'atris:fast', verifier: 'atris:pro', chosen: 'no_local_engine' });
    assert.strictEqual(cloud.resolveEngines({ token: '', env: NO_LOCAL }).mode, 'local');
    assert.strictEqual(cloud.resolveEngines({ engine: 'atris', token: 'tok', env: { PATH: bin } }).mode, 'atris');
    assert.throws(() => cloud.resolveEngines({ engine: 'atris', token: '' }), /atris login/);
    assert.throws(() => cloud.resolveEngines({ engine: 'atris', hunter: 'codex', token: 'tok' }), /not both/);
  } finally { fs.rmSync(bin, { recursive: true, force: true }); }
});

test('schedule installs and removes the timer file', async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-sched-home-'));
  const target = makeRepo();
  const calls = [];
  const spawn = (cmd, args) => { calls.push([cmd, ...args].join(' ')); return { status: 0, stdout: '', stderr: '' }; };
  const out = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...a) => out.push(a.join(' '));
  console.error = (...a) => out.push(a.join(' '));
  try {
    const deps = { homeDir, platform: 'darwin', spawn, atrisBin: '/opt/atris/bin/atris.js', envPath: '/usr/bin', token: '', env: NO_LOCAL };
    assert.strictEqual(await auditCommand(['schedule', '--every', 'week', target], deps), 0, out.join('\n'));
    const agents = path.join(homeDir, 'Library', 'LaunchAgents');
    const files = fs.readdirSync(agents);
    assert.strictEqual(files.length, 1);
    assert.match(files[0], /^ai\.atris\.sentinel-review\.[0-9a-f]{8}\.plist$/);
    const plist = fs.readFileSync(path.join(agents, files[0]), 'utf8');
    assert.ok(plist.includes('<string>sentinel</string><string>--quick</string><string>--scheduled</string>'));
    assert.ok(plist.includes(`<key>WorkingDirectory</key><string>${target}</string>`));
    assert.ok(plist.includes('<integer>604800</integer>'));
    assert.ok(calls.some((c) => c.startsWith('launchctl bootstrap')));
    assert.ok(out.join('\n').includes('once a week'));
    assert.strictEqual(await auditCommand(['schedule', '--uninstall', target], deps), 0);
    assert.deepStrictEqual(fs.readdirSync(agents), []);
    assert.strictEqual(await auditCommand(['schedule', '--every', 'month', target], deps), 2);

    // cron elsewhere: one marked line in, then out.
    let crontab = 'MAILTO=""\n';
    const cronSpawn = (cmd, args, opts) => {
      if (args[0] === '-l') return { status: 0, stdout: crontab };
      crontab = opts.input;
      return { status: 0, stdout: '' };
    };
    const cronDeps = { ...deps, platform: 'linux', spawn: cronSpawn };
    assert.strictEqual(await auditCommand(['schedule', '--every', 'day', target], cronDeps), 0);
    assert.match(crontab, /^0 0 \* \* \* cd .* 'sentinel' '--quick' '--scheduled' .*# ATRIS_SENTINEL_REVIEW_[0-9a-f]{8}$/m);
    assert.ok(crontab.includes('MAILTO'));
    assert.strictEqual(await auditCommand(['schedule', '--uninstall', target], cronDeps), 0);
    assert.ok(!crontab.includes('ATRIS_SENTINEL_REVIEW'));
    assert.ok(crontab.includes('MAILTO'));
  } finally {
    console.log = origLog;
    console.error = origErr;
    fs.rmSync(homeDir, { recursive: true, force: true });
    fs.rmSync(target, { recursive: true, force: true });
  }
});

test('upload body strips code spans and secrets from model text', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-run-'));
  try {
    fs.writeFileSync(path.join(dir, 'run-metadata.json'), JSON.stringify({ repo: 'r', run_id: 'run-1', started_at: '2026-01-01T00:00:00.000Z', finished_at: '2026-01-01T00:01:00.000Z', profile: 'standard', engines: { hunter: 'codex', verifier: 'claude' }, coverage: { in_scope: 3, done: 2, deferred: 1 }, counts: { confirmed: 1, needs_validation: 1, rejected: 0, severity: { low: 1 } } }));
    fs.writeFileSync(path.join(dir, 'findings.json'), JSON.stringify([
      { verdict: 'confirmed', fingerprint: 'a:b', title: 'Key leaks', severity: { overall: 'low' }, trace: [{ file: 'a.js', line: 3, code: 'const k = 1' }], remediation: { strategy: `move the token ${'ghp_'}a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8 out of the file` } },
      { verdict: 'needs_validation', title: 'Maybe open', blockers: ['who can reach port 80'] },
    ]));
    fs.writeFileSync(path.join(dir, 'REPORT.md'), '# x\n\n## Hardening notes (not findings)\n\n- use `fs.writeFileSync(name, body, { mode: 0o600 })` for keys\n\n## Coverage\n\n- units: 3\n');
    const body = cloud.buildUploadBody(dir);
    assert.strictEqual(body.source, 'cli-local');
    assert.strictEqual(body.credits_used, 0);
    assert.deepStrictEqual(body.coverage, { in_scope: 3, done: 2, deferred: 1, blocked: 0 });
    assert.deepStrictEqual(body.counts.severity, { critical: 0, high: 0, medium: 0, low: 1, informational: 0 });
    assert.strictEqual(body.findings[0].fix, cloud.FALLBACK_SENTENCE);
    assert.deepStrictEqual(body.needs_validation, [{ title: 'Maybe open', blocked_on: 'who can reach port 80' }]);
    assert.deepStrictEqual(body.hardening, [cloud.FALLBACK_SENTENCE]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------- review fixes

const GH = `${'ghp_'}a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8`;

test('a credential on a seeded line and on a cited line never reaches an atris model', async () => {
  const root = makeRepo();
  fs.appendFileSync(path.join(root, 'lib', 'run.js'), `const githubToken = '${GH}';\nexecSync(githubToken);\n`);
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qam', 'token'], { cwd: root });
  const cited = { ...CANDIDATE, trace: [...CANDIDATE.trace.slice(0, 2), { kind: 'sink', file: 'lib/run.js', line: 7, description: 'token used' }] };
  const backend = await fakeBackend({ candidate: cited });
  try {
    await withEnv(backend, async ({ out }) => {
      await auditCommand(['--engine', 'atris', '--yes', '--no-upload'], { root, token: 'tok', env: NO_LOCAL });
      const turns = backend.log.filter((e) => e.path === '/api/atris2/turn');
      assert.ok(turns.some((t) => t.body.message.includes('independent security verifier')), out.join('\n'));
      assert.ok(turns.some((t) => t.body.message.includes('lib/run.js:7')), 'the seeded line itself is listed');
      for (const t of turns) assert.ok(!t.body.message.includes(GH.slice(4)), 'the credential never leaves');
      assert.ok(turns.some((t) => t.body.message.includes('[line hidden: looks like a secret]')));
    });
  } finally { await backend.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('a model citing .env or a file outside the scope never gets those files sent', async () => {
  const root = makeRepo();
  fs.writeFileSync(path.join(root, '.env'), 'DB_HOST=internal-db.example\n');
  fs.mkdirSync(path.join(root, 'config'));
  fs.writeFileSync(path.join(root, 'config', 'app.js'), 'module.exports = { OUTSIDE_SCOPE_MARKER: 1 };\n');
  execFileSync('git', ['add', 'config/app.js'], { cwd: root });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'config'], { cwd: root });
  const sneaky = { ...CANDIDATE, trace: [{ kind: 'entrypoint', file: '.env', line: 1, description: 'env' }, { kind: 'propagation', file: 'config/app.js', line: 1, description: 'config' }, CANDIDATE.trace[2]] };
  const backend = await fakeBackend({ candidate: sneaky });
  try {
    await withEnv(backend, async ({ home }) => {
      await auditCommand(['lib', '--engine', 'atris', '--quick', '--yes', '--no-upload'], { root, token: 'tok', env: NO_LOCAL });
      const turns = backend.log.filter((e) => e.path === '/api/atris2/turn');
      assert.ok(turns.length >= 1);
      for (const t of turns) {
        assert.ok(!t.body.message.includes('internal-db'), '.env never leaves');
        assert.ok(!t.body.message.includes('OUTSIDE_SCOPE_MARKER'), 'out-of-scope files never leave');
      }
      assert.ok(!turns.some((t) => t.body.message.includes('independent security verifier')), 'the candidate never reaches a hosted verifier');
      const runDir = path.join(home, fs.readdirSync(home)[0], 'run-1');
      const findings = JSON.parse(fs.readFileSync(path.join(runDir, 'findings.json'), 'utf8'));
      assert.strictEqual(findings[0].verdict, 'rejected');
      assert.match(findings[0].reason, /may not send to atris models: \.env, config\/app\.js/);
    });
  } finally { await backend.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('the hosted allow list keeps only tracked, unignored, in-scope, non-key files', () => {
  const audit = require('../lib/security-audit');
  const root = makeRepo();
  try {
    fs.writeFileSync(path.join(root, '.gitignore'), 'lib/ignored.js\n');
    for (const f of ['lib/ignored.js', 'lib/server.pem', 'lib/.env.production', 'docs.js']) fs.writeFileSync(path.join(root, f), 'x\n');
    execFileSync('git', ['add', '-f', 'lib/ignored.js', 'lib/server.pem', 'lib/.env.production', 'docs.js', '.gitignore'], { cwd: root });
    fs.writeFileSync(path.join(root, 'lib', 'untracked.js'), 'x\n');
    assert.deepStrictEqual([...audit.hostedAllowedFiles(root, ['lib'])].sort(), ['lib/run.js']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a schedule on atris models needs a priced yes at install and stores a cap', async () => {
  const backend = await fakeBackend();
  const target = makeRepo();
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-sched-atris-'));
  const spawn = () => ({ status: 0, stdout: '', stderr: '' });
  try {
    await withEnv(backend, async ({ out }) => {
      const deps = { homeDir, platform: 'darwin', spawn, atrisBin: '/opt/atris/bin/atris.js', envPath: '/usr/bin', token: 'tok', env: NO_LOCAL, input: { isTTY: true } };
      const agents = path.join(homeDir, 'Library', 'LaunchAgents');
      assert.strictEqual(await auditCommand(['schedule', '--every', 'day', target], { ...deps, ask: async () => false }), 1);
      assert.ok(!fs.existsSync(agents) || !fs.readdirSync(agents).length, 'a no installs nothing');
      assert.strictEqual(cloud.readApproval(target, homeDir), null);
      assert.ok(out.join('\n').includes('costs at most 28 credits'), out.join('\n'));
      assert.ok(!backend.log.some((e) => e.path === '/api/atris2/turn'), 'pricing a schedule calls no model');

      assert.strictEqual(await auditCommand(['schedule', '--every', 'day', '--max-credits', '12', target], { ...deps, ask: async () => true }), 0, out.join('\n'));
      const approval = cloud.readApproval(target, homeDir);
      assert.strictEqual(approval.engine, 'atris');
      assert.strictEqual(approval.max_credits, 12);
      const plist = fs.readFileSync(path.join(agents, fs.readdirSync(agents)[0]), 'utf8');
      assert.ok(!plist.includes('--yes'));
      assert.strictEqual(await auditCommand(['schedule', '--uninstall', target], deps), 0);
      assert.strictEqual(cloud.readApproval(target, homeDir), null);
    });
  } finally { await backend.close(); fs.rmSync(target, { recursive: true, force: true }); fs.rmSync(homeDir, { recursive: true, force: true }); }
});

test('a scheduled run never switches to atris models without that approval', async () => {
  const backend = await fakeBackend({ verdict: 'rejected' });
  const root = makeRepo();
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-sched-run-'));
  try {
    await withEnv(backend, async ({ out }) => {
      // No approval at all: nothing runs.
      assert.strictEqual(await auditCommand(['--quick', '--scheduled'], { root, token: 'tok', env: NO_LOCAL, homeDir }), 2);
      assert.strictEqual(backend.log.length, 0);
      // Approved for local engines: stays local even with a login and no local engine.
      cloud.writeApproval(root, { engine: 'local' }, homeDir);
      const engines = [];
      const runJobs = async (jobs) => jobs.map((j) => { engines.push(j.engine); return { ok: true, stdout: answerFor(j.prompt, { verdict: 'rejected' }) }; });
      assert.strictEqual(await auditCommand(['--quick', '--scheduled'], { root, token: 'tok', env: NO_LOCAL, homeDir, runJobs }), 0, out.join('\n'));
      assert.ok(engines.length && engines.every((e) => e === 'codex' || e === 'claude'), engines.join(','));
      assert.ok(!backend.log.some((e) => e.path.startsWith('/api/atris2/')), 'no quote and no turn');
    });
  } finally { await backend.close(); fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(homeDir, { recursive: true, force: true }); }
});

test('a run stops at its credit cap: no call starts that could pass it', async () => {
  const backend = await fakeBackend({ verdict: 'rejected' });
  const root = makeRepo();
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-cap-'));
  try {
    await withEnv(backend, async ({ out }) => {
      cloud.writeApproval(root, { engine: 'atris', max_credits: 6 }, homeDir);
      const code = await auditCommand(['--quick', '--scheduled', '--no-upload'], { root, token: 'tok', env: NO_LOCAL, homeDir });
      assert.ok(code === 0 || code === 1, out.join('\n'));
      const turns = backend.log.filter((e) => e.path === '/api/atris2/turn');
      const charged = turns.reduce((n, t) => n + (t.body.model === 'atris:fast' ? 1 : 3), 0);
      assert.ok(turns.length >= 1, 'some calls fit');
      assert.ok(charged <= 6, `charged ${charged}`);
      // Worst cases (2 per fast call, 5 per pro call) never add past 6.
      assert.ok(out.join('\n').includes('stopped at the approved limit of 6 credits'), out.join('\n'));
    });
  } finally { await backend.close(); fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(homeDir, { recursive: true, force: true }); }
});

test('the spend guard counts the worst case when a call returns no receipt', async () => {
  const spend = cloud.spendGuard({ max: 10, quoteCall: async () => 4 });
  const server = http.createServer((req, res) => { req.resume(); req.on('end', () => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(`data: ${JSON.stringify({ type: 'result', result: '{"ok": true}' })}\n\n`); }); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const run = cloud.atrisJobRunner({ token: 't', base: `http://127.0.0.1:${server.address().port}/api`, spend });
    const answers = await run([1, 2, 3].map(() => ({ engine: 'atris:pro', prompt: 'p', max_output_tokens: 4096 })), { concurrency: 1 });
    assert.deepStrictEqual(answers.map((a) => a.ok), [true, true, false]);
    assert.strictEqual(answers[2].reason, cloud.CAP_REASON);
    assert.strictEqual(spend.spent, 8);
  } finally { await new Promise((r) => server.close(r)); }
});

test('uploaded text drops code spans and code-looking fragments, and keeps file:line', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-run-code-'));
  try {
    fs.writeFileSync(path.join(dir, 'run-metadata.json'), JSON.stringify({ repo: 'r', run_id: 'run-1', profile: 'quick', engines: { hunter: 'atris:fast', verifier: 'atris:pro' }, coverage: {}, counts: {} }));
    fs.writeFileSync(path.join(dir, 'findings.json'), JSON.stringify([{
      verdict: 'confirmed', fingerprint: 'lib/run.js:runTask/shell', title: 'Title reaches execSync(`echo ${title}`) as shell text', severity: { overall: 'high' },
      trace: [{ file: 'lib/run.js', line: 4 }],
      remediation: { strategy: 'replace `execSync(command)` with `execFile(file, args)` and set opts = { shell: false } so cmd && rm -rf / cannot run' },
    }]));
    fs.writeFileSync(path.join(dir, 'REPORT.md'), '');
    const [f] = cloud.buildUploadBody(dir).findings;
    assert.strictEqual(f.location, 'lib/run.js:4');
    assert.strictEqual(f.title, cloud.FALLBACK_SENTENCE);
    assert.strictEqual(f.fix, cloud.FALLBACK_SENTENCE);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('upload text is kept only when it is plain prose', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-run-prose-'));
  const keep = 'Anyone who can reach the admin route can delete accounts (no role check).';
  const sentences = {
    auth: 'return request.headers.authorization;',
    py: 'from app.auth import verify_token',
    example: `${'ghp_'}a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8 example`,
    exampleWords: 'the example token AKIA2E4C6G8I0K2M4O6Q is live',
    longToken: 'rotate the key abcdefghij0123456789xyz now',
    plain: keep,
  };
  try {
    fs.writeFileSync(path.join(dir, 'run-metadata.json'), JSON.stringify({ repo: 'r', run_id: 'run-1', engines: {}, coverage: {}, counts: {} }));
    fs.writeFileSync(path.join(dir, 'findings.json'), JSON.stringify(Object.entries(sentences).map(([k, v]) => ({ verdict: 'confirmed', fingerprint: k, title: v, severity: { overall: 'low' }, trace: [{ file: 'app/auth.py', line: 12 }], remediation: { strategy: v } }))));
    fs.writeFileSync(path.join(dir, 'REPORT.md'), `## Hardening notes (not findings)\n\n- ${sentences.py}\n- ${keep}\n`);
    const body = cloud.buildUploadBody(dir);
    const byTitle = body.findings.map((f) => f.title);
    assert.deepStrictEqual(byTitle, [cloud.FALLBACK_SENTENCE, cloud.FALLBACK_SENTENCE, cloud.FALLBACK_SENTENCE, cloud.FALLBACK_SENTENCE, cloud.FALLBACK_SENTENCE, keep]);
    assert.ok(body.findings.every((f) => f.location === 'app/auth.py:12'));
    assert.strictEqual(body.findings[5].fix, keep);
    assert.deepStrictEqual(body.hardening, [cloud.FALLBACK_SENTENCE, keep]);
    assert.ok(!JSON.stringify(body).includes('authorization') && !JSON.stringify(body).includes('verify_token'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a private key inside an allowed file never reaches an atris model', async () => {
  const root = makeRepo();
  const begin = ['-----BEGIN', 'RSA PRIVATE KEY-----'].join(' ');
  const end = ['-----END', 'RSA PRIVATE KEY-----'].join(' ');
  const body = ['MIIEowIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo4lgOEePzNm0tRgeLezV6ffAt0gun', 'VTLw7onLRnrq0/IzW7yWR7QkrmBL7jTKEn5u+qKhbwKfBstIs+bMY2Zkp18gnTxK', 'LxoS2tFczGkPLPgizskuemMghRniWaoLcyehkd3qqGElvW/VDL5AaWTg0nLVkjRo'];
  fs.writeFileSync(path.join(root, 'lib', 'keys.js'), ['const { execSync } = require(\'child_process\');', 'const key = `', begin, ...body, end, '`;', 'execSync(process.argv[2]);', 'module.exports = { key };', ''].join('\n'));
  execFileSync('git', ['add', 'lib/keys.js'], { cwd: root });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'keys'], { cwd: root });
  const backend = await fakeBackend({ verdict: 'rejected' });
  try {
    await withEnv(backend, async () => {
      await auditCommand(['--engine', 'atris', '--yes', '--no-upload'], { root, token: 'tok', env: NO_LOCAL });
      const turns = backend.log.filter((e) => e.path === '/api/atris2/turn');
      assert.ok(turns.some((t) => t.body.message.includes('### lib/keys.js')), 'the file itself was sent');
      for (const t of turns) {
        assert.ok(!t.body.message.includes('PRIVATE KEY'), 'no key markers');
        for (const b of body) assert.ok(!t.body.message.includes(b.slice(0, 30)), 'no key body');
      }
      assert.ok(turns.some((t) => t.body.message.includes('module.exports = { key };')), 'lines after the key still go');
    });
  } finally { await backend.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('redaction hides long encoded runs but keeps paths and prose', () => {
  const hex = 'a'.repeat(20) + '0123456789abcdef0123';
  const b64 = 'QWxhZGRpbjpvcGVuIHNlc2FtZQ0K3k9z+Lm2Pq8Rt5Uv7Wx';
  const { text } = cloud.redactOutgoing([`sha ${hex}`, `blob = "${b64}"`, '  starting paths: src/components/dashboard/widgets/charts/LineChart.jsx', 'plain words stay'].join('\n'));
  assert.deepStrictEqual(text.split('\n'), ['[line hidden: looks like a secret]', '[line hidden: looks like a secret]', '  starting paths: src/components/dashboard/widgets/charts/LineChart.jsx', 'plain words stay']);
});
