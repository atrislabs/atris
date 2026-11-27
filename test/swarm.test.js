'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFileSync, spawnSync } = require('node:child_process');

const { knownCommands } = require('../lib/known-commands');
const { swarmCommand } = require('../commands/swarm');
const swarmLib = require('../lib/swarm');
const swarlo = require('../lib/swarlo-members');

const cliPath = path.resolve(__dirname, '../bin/atris.js');

function makeSandbox(t, members = ['coordinator', 'builder', 'validator']) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-swarm-test-'));
  const home = path.join(dir, 'home');
  const root = path.join(dir, 'ws');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(path.join(root, '.atris', 'state'), { recursive: true });
  for (const name of members) {
    const mdir = path.join(root, 'atris', 'team', name);
    fs.mkdirSync(mdir, { recursive: true });
    fs.writeFileSync(path.join(mdir, 'MEMBER.md'), `---\nname: ${name}\nrole: ${name} seat\n---\n# ${name}\n`);
  }
  fs.writeFileSync(path.join(root, 'atris', 'ROSTER.md'), '# roster\n\n## team\n- coordinator: claude\n- builder: codex\n- validator: claude\n');
  fs.writeFileSync(path.join(root, '.atris', 'state', 'engines.json'), JSON.stringify({
    schema: 'atris.engine_registry.v2',
    engines: [
      { id: 'claude', health: { status: 'ready' } },
      { id: 'codex', health: { status: 'ready' } },
    ],
  }));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, home, root };
}

function initGit(root) {
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'core.js'), 'module.exports = 1;\n');
  execFileSync('git', ['add', 'src/core.js'], { cwd: root });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: root });
}

async function startMockHub(t, state = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let parsed = null;
      try { parsed = body ? JSON.parse(body) : null; } catch { parsed = null; }
      requests.push({ method: req.method, url: req.url, auth: req.headers.authorization || '', body: parsed });
      const send = (status, obj) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      if (req.url === '/api/health') return send(200, { status: 'ok' });
      if (req.url === '/api/register' && req.method === 'POST') {
        return send(201, { member_id: parsed.member_id, api_key: `tok-${parsed.member_id}`, hub_id: parsed.hub_id });
      }
      if (/^\/api\/[^/]+\/channels\/[^/]+\/posts$/.test(req.url) && req.method === 'POST') {
        return send(201, { post_id: `p-${requests.length}` });
      }
      if (/^\/api\/[^/]+\/channels\/[^/]+\/claim-file$/.test(req.url) && req.method === 'POST') {
        return send(201, { claimed: true, task_key: `file:${parsed.file_path}` });
      }
      if (/^\/api\/[^/]+\/liveness/.test(req.url)) {
        return send(200, state.liveness || { alive: [{ member_id: 'coordinator' }], dying: [], dead: [], orphaned_claims: [], expired_on_sweep: [] });
      }
      if (/^\/api\/[^/]+\/idle/.test(req.url)) {
        return send(200, state.idle || { idle: [] });
      }
      if (/^\/api\/[^/]+\/claims$/.test(req.url)) {
        return send(200, state.claims || { count: 0, claims: [] });
      }
      if (/^\/api\/[^/]+\/unclaimed$/.test(req.url)) {
        return send(200, state.unclaimed || { count: 0, tasks: [] });
      }
      if (/^\/api\/[^/]+\/members$/.test(req.url)) {
        return send(200, { count: 2, members: [] });
      }
      return send(404, { error: 'not found' });
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  return { url: `http://127.0.0.1:${server.address().port}`, requests };
}

test('swarm is registered in knownCommands and real CLI prints help', (t) => {
  assert.ok(knownCommands.includes('swarm'));
  const { root } = makeSandbox(t);
  const res = spawnSync(process.execPath, [cliPath, 'swarm', '--help'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1' },
  });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /atris swarm start/);
  assert.match(res.stdout, /atris swarm expand/);
  assert.match(res.stdout, /atris swarm freeze/);
  assert.match(res.stdout, /atris swarm watch/);
});

test('swarm start, expand, freeze, watch, and down coordinate 1 lead + N workers on Swarlo + Git', async (t) => {
  const { home, root } = makeSandbox(t, ['coordinator', 'builder', 'validator']);
  initGit(root);
  const hub = await startMockHub(t, {
    liveness: {
      alive: [{ member_id: 'coordinator' }, { member_id: 'builder' }],
      dying: [{ member_id: 'builder-1' }],
      dead: [],
      orphaned_claims: [{ task_key: 'task-9', member_id: 'builder-1' }],
      expired_on_sweep: ['task-9'],
    },
    idle: { idle: [{ member_id: 'validator' }] },
    unclaimed: { count: 2, tasks: [{ task_key: 't-1' }, { task_key: 't-2' }] },
  });

  const planned = swarmLib.planWorkerSeats(root, { lead: 'coordinator', count: 3 });
  assert.deepEqual(planned, ['builder', 'validator', 'builder-1']);

  const brief = swarmLib.buildLeadBrief({ objective: 'Ship auth', lead: 'coordinator', workers: planned, channel: 'general' });
  assert.match(brief, /\[swarm lead: coordinator\] objective: Ship auth/);

  const startLines = [];
  const startCode = await swarmCommand([
    'start', 'Ship auth', '--lead', 'coordinator', '--workers', '2',
    '--server', hub.url, '--hub', 'testhub', '--channel', 'general', '--json',
  ], { root, home, log: (l) => startLines.push(l) });
  assert.equal(startCode, 0);
  const started = JSON.parse(startLines.join('\n'));
  assert.equal(started.ok, true);
  assert.equal(started.announced, true);
  assert.equal(started.swarm.lead, 'coordinator');
  assert.deepEqual(started.swarm.workers, ['builder', 'validator']);
  assert.equal(swarmLib.loadSwarmState(root).lead, 'coordinator');
  assert.ok(hub.requests.some((r) => r.body && r.body.kind === 'briefing'));
  assert.ok(swarlo.loadLaunched(home).testhub.coordinator);

  // Expand by 2 more cloned workers inheriting builder/MEMBER.md.
  const expandLines = [];
  const expandCode = await swarmCommand([
    'expand', '2', '--role', 'builder', '--server', hub.url, '--hub', 'testhub', '--json',
  ], { root, home, log: (l) => expandLines.push(l) });
  assert.equal(expandCode, 0);
  const expanded = JSON.parse(expandLines.join('\n'));
  assert.deepEqual(expanded.added.map((m) => m.member), ['builder-1', 'builder-2']);
  assert.equal(expanded.added[0].cloned, true);
  assert.deepEqual(expanded.swarm.workers, ['builder', 'validator', 'builder-1', 'builder-2']);

  // Freeze solved module, verify clean, then modify it and verify freeze --check catches it.
  const freezeLines = [];
  const freezeCode = await swarmCommand([
    'freeze', 'src/core.js', '--reason', 'verified complete', '--server', hub.url, '--hub', 'testhub', '--json',
  ], { root, home, log: (l) => freezeLines.push(l) });
  assert.equal(freezeCode, 0);
  const frozen = JSON.parse(freezeLines.join('\n'));
  assert.equal(frozen.hub_notified, true);
  assert.deepEqual(swarmLib.loadFrozenState(root).paths, ['src/core.js']);
  assert.ok(hub.requests.some((r) => r.url.endsWith('/claim-file') && r.body.file_path === 'src/core.js'));

  const cleanCheck = [];
  assert.equal(await swarmCommand(['freeze', '--check', '--json'], { root, home, log: (l) => cleanCheck.push(l) }), 0);
  assert.deepEqual(JSON.parse(cleanCheck.join('\n')).changed, []);

  // Mutate the frozen file -> freeze --check and watch both flag it.
  fs.writeFileSync(path.join(root, 'src', 'core.js'), 'module.exports = 2;\n');
  const dirtyCheck = [];
  assert.equal(await swarmCommand(['freeze', '--check', '--json'], { root, home, log: (l) => dirtyCheck.push(l) }), 1);
  assert.deepEqual(JSON.parse(dirtyCheck.join('\n')).changed, ['src/core.js']);

  const watchLines = [];
  const watchCode = await swarmCommand([
    'watch', '--stale-minutes', '10', '--expire', '--server', hub.url, '--hub', 'testhub', '--json',
  ], { root, home, log: (l) => watchLines.push(l) });
  assert.equal(watchCode, 1);
  const watched = JSON.parse(watchLines.join('\n'));
  assert.ok(watched.alerts.some((a) => /frozen modules modified: src\/core\.js/.test(a)));
  assert.ok(watched.alerts.some((a) => /dying workers \(1\): builder-1/.test(a)));
  assert.ok(watched.alerts.some((a) => /orphaned claims \(1\): task-9/.test(a)));
  assert.ok(watched.alerts.some((a) => /1 idle worker\(s\) while 2 unclaimed task\(s\) wait/.test(a)));
  assert.ok(hub.requests.some((r) => r.url.includes('/liveness?stale_minutes=10&auto_expire=true')));

  // Unfreeze and stop swarm cleanly.
  assert.equal(await swarmCommand(['unfreeze', 'src/core.js'], { root, home, log: () => {} }), 0);
  assert.deepEqual(swarmLib.loadFrozenState(root).paths, []);
  const downLines = [];
  assert.equal(await swarmCommand(['down', '--server', hub.url, '--hub', 'testhub', '--json'], { root, home, log: (l) => downLines.push(l) }), 0);
  const downed = JSON.parse(downLines.join('\n'));
  assert.equal(downed.remaining, 0);
  assert.equal(swarmLib.loadSwarmState(root), null);
});

test('fleet and swarm both understand every verb across standby and attack surfaces', (t) => {
  const { home, root } = makeSandbox(t, ['coordinator', 'builder']);
  const env = { ...process.env, HOME: home, USERPROFILE: home, ATRIS_SKIP_UPDATE_CHECK: '1' };

  // `atris fleet start --dry-run` routes to swarm attack verb.
  const fleetStart = spawnSync(process.execPath, [cliPath, 'fleet', 'start', 'Ship search', '--workers', '1', '--dry-run', '--json'], {
    cwd: root, encoding: 'utf8', env,
  });
  assert.equal(fleetStart.status, 0, fleetStart.stderr);
  const startPayload = JSON.parse(fleetStart.stdout);
  assert.equal(startPayload.dry_run, true);
  assert.equal(startPayload.swarm.objective, 'Ship search');

  // `atris fleet freeze --check` routes to swarm freeze verb.
  const fleetFreeze = spawnSync(process.execPath, [cliPath, 'fleet', 'freeze', '--check', '--json'], {
    cwd: root, encoding: 'utf8', env,
  });
  assert.equal(fleetFreeze.status, 0, fleetFreeze.stderr);
  assert.equal(JSON.parse(fleetFreeze.stdout).action, 'check');

  // `atris swarm members --json` and `atris swarm launched --json` route to fleet standby verbs.
  const swarmMembers = spawnSync(process.execPath, [cliPath, 'swarm', 'members', '--json'], {
    cwd: root, encoding: 'utf8', env,
  });
  assert.equal(swarmMembers.status, 0, swarmMembers.stderr);
  assert.equal(JSON.parse(swarmMembers.stdout).members.count, 2);

  const swarmLaunched = spawnSync(process.execPath, [cliPath, 'swarm', 'launched', '--json'], {
    cwd: root, encoding: 'utf8', env,
  });
  assert.equal(swarmLaunched.status, 0, swarmLaunched.stderr);
  assert.equal(JSON.parse(swarmLaunched.stdout).count, 0);
});

test('swarm plan, pull, report verify/freeze gates, and watch --reallocate work cleanly', async (t) => {
  const { home, root } = makeSandbox(t, ['coordinator', 'builder']);
  initGit(root);
  const claimedKeys = new Set();
  const doneKeys = new Set();
  const posts = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let parsed = null;
      try { parsed = body ? JSON.parse(body) : null; } catch { parsed = null; }
      const send = (status, obj) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      if (req.url === '/api/health') return send(200, { status: 'ok' });
      if (req.url === '/api/register' && req.method === 'POST') {
        return send(201, { member_id: parsed.member_id, api_key: `k-${parsed.member_id}`, hub_id: parsed.hub_id });
      }
      if (/\/posts$/.test(req.url) && req.method === 'POST') {
        const row = { post_id: `p-${posts.length + 1}`, channel: 'general', created_at: new Date().toISOString(), ...parsed };
        posts.push(row);
        return send(201, row);
      }
      if (/\/posts\?/.test(req.url) && req.method === 'GET') {
        return send(200, { posts });
      }
      if (/\/ready\//.test(req.url)) return send(200, { tasks: [] });
      if (/\/unclaimed/.test(req.url)) {
        const open = posts.filter((p) => p.kind === 'message' && p.task_key && !claimedKeys.has(p.task_key) && !doneKeys.has(p.task_key));
        return send(200, { count: open.length, tasks: open });
      }
      if (/\/claim$/.test(req.url) && req.method === 'POST') {
        const deps = Array.isArray(parsed.depends_on) ? parsed.depends_on : [];
        const unmet = deps.filter((d) => !doneKeys.has(d));
        if (unmet.length) return send(400, { detail: `unmet deps: ${unmet.join(', ')}` });
        if (claimedKeys.has(parsed.task_key)) return send(409, { conflict: true });
        claimedKeys.add(parsed.task_key);
        return send(201, { claimed: true, task_key: parsed.task_key });
      }
      if (/\/claim-file$/.test(req.url) && req.method === 'POST') {
        return send(201, { claimed: true, task_key: `file:${parsed.file_path}` });
      }
      if (/\/report(\/once)?$/.test(req.url) && req.method === 'POST') {
        claimedKeys.delete(parsed.task_key);
        doneKeys.add(parsed.task_key);
        return send(201, { ok: true, task_key: parsed.task_key, status: parsed.status, next_task: null });
      }
      if (/\/liveness/.test(req.url)) return send(200, { alive: [], dying: [], dead: [], orphaned_claims: [], expired_on_sweep: ['t-old'] });
      if (/\/idle/.test(req.url)) return send(200, { idle: [{ member_id: 'builder' }] });
      if (/\/claims$/.test(req.url)) return send(200, { count: claimedKeys.size, claims: [] });
      if (/\/members$/.test(req.url)) return send(200, { count: 2, members: [] });
      return send(404, { error: 'not found' });
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}`;

  assert.equal(await swarmCommand(['start', 'Ship DAG', '--workers', '1', '--server', url, '--hub', 'h1', '--json'], { root, home, log: () => {} }), 0);

  const planOut = [];
  const tasksJson = JSON.stringify([
    { task_key: 'a', content: 'first', priority: 2 },
    { task_key: 'b', content: 'second', depends_on: ['a'], priority: 1 },
  ]);
  assert.equal(await swarmCommand(['plan', '--as', 'coordinator', '--tasks', tasksJson, '--server', url, '--hub', 'h1', '--json'], { root, home, log: (l) => planOut.push(l) }), 0);
  assert.equal(JSON.parse(planOut.join('\n')).planned, 2);

  const pullOut = [];
  assert.equal(await swarmCommand(['pull', '--as', 'builder', '--server', url, '--hub', 'h1', '--json'], { root, home, log: (l) => pullOut.push(l) }), 0);
  assert.equal(JSON.parse(pullOut.join('\n')).task.task_key, 'a');

  // Verify gate refuses failing check.
  const badVerify = [];
  assert.equal(await swarmCommand(['report', 'a', 'done', 'nope', '--as', 'builder', '--verify', 'node -e "process.exit(1)"', '--server', url, '--hub', 'h1', '--json'], { root, home, log: (l) => badVerify.push(l) }), 1);
  assert.equal(JSON.parse(badVerify.join('\n')).blocked_by, 'verify_failed');

  // Passing verify with --next closes a and claims b.
  const okVerify = [];
  assert.equal(await swarmCommand(['report', 'a', 'done', 'ok', '--as', 'builder', '--verify', 'node -e "process.exit(0)"', '--next', '--server', url, '--hub', 'h1', '--json'], { root, home, log: (l) => okVerify.push(l) }), 0);
  assert.equal(JSON.parse(okVerify.join('\n')).next_task.task_key, 'b');

  // Freeze blocks report done when frozen file changed.
  assert.equal(await swarmCommand(['freeze', 'src/core.js', '--server', url, '--hub', 'h1', '--json'], { root, home, log: () => {} }), 0);
  fs.writeFileSync(path.join(root, 'src', 'core.js'), 'module.exports = 99;\n');
  const blockedFreeze = [];
  assert.equal(await swarmCommand(['report', 'b', 'done', 'tampered', '--as', 'builder', '--server', url, '--hub', 'h1', '--json'], { root, home, log: (l) => blockedFreeze.push(l) }), 1);
  assert.equal(JSON.parse(blockedFreeze.join('\n')).blocked_by, 'frozen_modules');

  // Watch --reallocate posts reallocation notice when expired claims exist.
  const watchOut = [];
  await swarmCommand(['watch', '--expire', '--reallocate', '--server', url, '--hub', 'h1', '--json'], { root, home, log: (l) => watchOut.push(l) });
  assert.equal(JSON.parse(watchOut.join('\n')).reallocated, true);
});
