'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const { swarmCommand } = require('../commands/swarm');
const comms = require('../lib/swarm-comms');
const { runDreamConsolidate } = require('../lib/dream-consolidate');

function makeSandbox(t, withTeam = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-swarm-comms-'));
  const home = path.join(dir, 'home');
  const root = path.join(dir, 'ws');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(path.join(root, '.atris', 'state'), { recursive: true });
  fs.mkdirSync(path.join(root, 'atris'), { recursive: true });
  if (withTeam) {
    for (const [name, desc] of [
      ['coordinator', 'Fast triage and routing'],
      ['strategist', 'Architecture and scope judgment'],
      ['builder', 'Writes backend auth code and fixes tests'],
      ['validator', 'Reviews proofs and regressions'],
    ]) {
      const mdir = path.join(root, 'atris', 'team', name);
      fs.mkdirSync(mdir, { recursive: true });
      fs.writeFileSync(path.join(mdir, 'MEMBER.md'), `---\nname: ${name}\nrole: ${name}\ndescription: ${desc}\n---\n# ${name}\n`);
    }
  }
  fs.writeFileSync(path.join(root, 'atris', 'MAP.md'), '| Task | Primary path | Notes |\n|---|---|---|\n| auth login | `lib/auth.js` | OAuth refresh |\n');
  fs.writeFileSync(path.join(root, 'atris', 'MEMORY_CORE.md'), '# Core\n\n- **auth-rule** (2026-11-26): refresh auth tokens before API calls.\n');
  fs.writeFileSync(path.join(root, 'atris', 'lessons.md'), '# lessons.md\n\n- **[2026-11-26] auth-rule** - fail - [resolved] rule: refresh auth tokens.\n');
  fs.writeFileSync(path.join(root, '.atris', 'state', 'engines.json'), JSON.stringify({
    schema: 'atris.engine_registry.v2',
    engines: [{ id: 'claude', health: { status: 'ready' } }],
  }));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { home, root };
}

test('parseDurationTokens handles natural durations and leaves member names alone', () => {
  assert.equal(comms.parseDurationTokens(['1h']).ms, 3600000);
  assert.equal(comms.parseDurationTokens(['23', 'min']).ms, 23 * 60 * 1000);
  assert.equal(comms.parseDurationTokens(['90s']).ms, 90000);
  assert.equal(comms.parseDurationTokens(['builder', 'validator']), null);
  assert.equal(comms.parseDurationTokens([]), null);
});

test('natural swarm front door uses LLM planner for plain English, solo empty-team, and tier 3 gate', async (t) => {
  const { home, root } = makeSandbox(t, true);

  // Stub LLM planner verifies prompt receives team + MAP + MEMORY_CORE and returns structured JSON.
  const capturedPrompts = [];
  const fakeAsk = async (_r, prompt) => {
    capturedPrompts.push(prompt);
    if (/charge every customer/i.test(prompt)) {
      return {
        ok: true,
        engine: 'claude',
        text: JSON.stringify({
          objective: 'Review customer billing change',
          duration_minutes: null,
          lead: 'coordinator',
          workers: [],
          solo: true,
          tier: 3,
          needs_human_yes: true,
          context_paths: ['lib/auth.js'],
          tasks: [],
          reason: 'Charging customers touches money and needs human approval.',
        }),
      };
    }
    return {
      ok: true,
      engine: 'claude',
      text: JSON.stringify({
        objective: 'Harden OAuth refresh and add regression test',
        duration_minutes: 23,
        lead: 'coordinator',
        workers: ['builder', 'validator'],
        solo: false,
        tier: 1,
        needs_human_yes: false,
        context_paths: ['lib/auth.js'],
        tasks: [{ task_key: 'auth-test', content: 'Add OAuth refresh regression test', depends_on: [] }],
        reason: 'Builder fixes auth code and validator checks the regression test.',
      }),
    };
  };

  // Plain-English invocation (`atris swarm "harden oauth for 23 min"`).
  const out1 = [];
  const code1 = await swarmCommand(
    ['harden oauth refresh for 23 min', '--dry-run', '--once', '--json'],
    { root, home, deps: { askModel: fakeAsk }, log: (l) => out1.push(l) },
  );
  assert.equal(code1, 0);
  const res1 = JSON.parse(out1.join('\n'));
  assert.equal(res1.plan.planner, 'llm');
  assert.equal(res1.plan.duration_minutes, 23);
  assert.deepEqual(res1.plan.workers, ['builder', 'validator']);
  assert.equal(res1.loop.duration_ms, 23 * 60 * 1000);
  assert.match(capturedPrompts[0], /auth-rule/);
  assert.match(capturedPrompts[0], /lib\/auth\.js/);

  // Tier 3 money request pauses safely until --yes.
  const out2 = [];
  const code2 = await swarmCommand(
    ['charge every customer $50', '--dry-run', '--json'],
    { root, home, deps: { askModel: fakeAsk }, log: (l) => out2.push(l) },
  );
  assert.equal(code2, 0);
  const res2 = JSON.parse(out2.join('\n'));
  assert.equal(res2.needs_human_yes, true);
  assert.equal(res2.plan.tier, 3);

  // Empty workspace with ZERO team seats runs solo as `atris` automatically!
  const empty = makeSandbox(t, false);
  const planned = await comms.planNaturalSwarm(empty.root, 'clean dead code', { offline: true });
  assert.equal(planned.plan.solo, true);
  assert.equal(planned.plan.lead, 'atris');
  const soloOut = [];
  const soloCode = await swarmCommand(
    ['clean dead code', '--offline', '--dry-run', '--json'],
    { root: empty.root, home: empty.home, log: (l) => soloOut.push(l) },
  );
  assert.equal(soloCode, 0);
  const soloRes = JSON.parse(soloOut.join('\n'));
  assert.equal(soloRes.plan.solo, true);
  assert.equal(soloRes.swarm.lead, 'atris');
});

test('brief, route, escalate, timed swarm up, and dreaming trace join work end-to-end', async (t) => {
  const { home, root } = makeSandbox(t, true);
  const posted = [];
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
        return send(201, { member_id: parsed.member_id, api_key: `tok-${parsed.member_id}`, hub_id: parsed.hub_id });
      }
      if (/\/posts$/.test(req.url) && req.method === 'POST') {
        posted.push({ url: req.url, body: parsed });
        return send(201, { post_id: `p-${posted.length}` });
      }
      if (/\/briefing$/.test(req.url) && req.method === 'POST') {
        return send(200, {
          task: parsed.task,
          scorer: parsed.scorer,
          extracted_paths: ['lib/auth.js'],
          extracted_keywords: ['auth', 'refresh'],
          count: 1,
          posts: [{ member_id: 'builder', member_name: 'builder', content: 'Fixed OAuth refresh in lib/auth.js' }],
        });
      }
      if (/\/liveness/.test(req.url)) return send(200, { alive: [{ member_id: 'coordinator' }], dying: [], dead: [], orphaned_claims: [], expired_on_sweep: [] });
      if (/\/idle/.test(req.url)) return send(200, { idle: [] });
      if (/\/claims$/.test(req.url)) return send(200, { count: 0, claims: [] });
      if (/\/unclaimed/.test(req.url)) return send(200, { count: 0, tasks: [] });
      if (/\/members$/.test(req.url)) return send(200, { count: 2, members: [] });
      return send(404, { error: 'not found' });
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}`;

  assert.equal(await swarmCommand(['start', 'Auth hardening', '--workers', '1', '--server', url, '--hub', 'h1', '--json'], { root, home, log: () => {} }), 0);

  const upOut = [];
  assert.equal(await swarmCommand(['up', '23', 'min', '--once', '--server', url, '--hub', 'h1', '--json'], { root, home, log: (l) => upOut.push(l) }), 0);
  const up = JSON.parse(upOut.join('\n'));
  assert.equal(up.duration_ms, 23 * 60 * 1000);
  assert.equal(up.cycles, 1);

  const briefOut = [];
  assert.equal(await swarmCommand(['brief', 'Fix OAuth refresh in lib/auth.js', '--server', url, '--hub', 'h1', '--json'], { root, home, log: (l) => briefOut.push(l) }), 0);
  const brief = JSON.parse(briefOut.join('\n'));
  assert.equal(brief.board_posts.length, 1);
  assert.ok(brief.memory_core.some((m) => /auth-rule/.test(m)));
  assert.ok(brief.map_routes.some((r) => /lib\/auth\.js/.test(r)));

  const r1Out = [];
  assert.equal(await swarmCommand(['route', 'Fix backend auth test', '--task-key', 't-auth', '--offline', '--server', url, '--hub', 'h1', '--json'], { root, home, log: (l) => r1Out.push(l) }), 0);
  assert.equal(JSON.parse(r1Out.join('\n')).tier, 1);

  const escOut = [];
  assert.equal(await swarmCommand(['escalate', 'Resolve architecture scope conflict', '--tier', '2', '--tried', 'checked MAP', '--evidence', 'lib/auth.js', '--offline', '--server', url, '--hub', 'h1', '--json'], { root, home, log: (l) => escOut.push(l) }), 0);
  const esc = JSON.parse(escOut.join('\n'));
  assert.equal(esc.tier, 2);
  assert.equal(esc.seat, 'strategist');
  assert.equal(esc.channel, 'escalations');

  fs.writeFileSync(path.join(root, '.atris', 'state', 'task_episodes.jsonl'), `${JSON.stringify({
    ts: '2026-12-01T00:00:00Z',
    task_id: 't-auth',
    status: 'accepted',
    reward: { value: 1 },
  })}\n`);
  const dream = runDreamConsolidate(root, { apply: true });
  assert.equal(dream.coordination_trace.joined, 1);
  assert.equal(dream.coordination_trace.accepted, 1);
});

test('timed swarm up executes queued tasks across cycles, verifies bare, halts on repeated errors with escalation, and stops on frozen tamper', async (t) => {
  const { execFileSync } = require('node:child_process');
  const { home, root } = makeSandbox(t, true);
  fs.mkdirSync(path.join(root, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(root, 'lib', 'core.js'), 'module.exports = 1;\n');
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-q', '-m', 'seed'], { cwd: root });

  const tasks = new Map([
    ['t-1', { task_key: 't-1', content: 'Harden OAuth refresh in lib/auth.js', status: 'open', owner: null, channel: 'general' }],
    ['t-2', { task_key: 't-2', content: 'Add regression test for refresh', status: 'open', owner: null, channel: 'general' }],
  ]);
  const escalations = [];
  const reports = [];

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
        return send(201, { member_id: parsed.member_id, api_key: `tok-${parsed.member_id}`, hub_id: parsed.hub_id });
      }
      if (/\/channels\/escalations\/posts$/.test(req.url) && req.method === 'POST') {
        escalations.push(parsed);
        return send(201, { post_id: `esc-${escalations.length}` });
      }
      if (/\/posts$/.test(req.url) && req.method === 'POST') return send(201, { post_id: 'p-1' });
      if (/\/posts\?/.test(req.url) && req.method === 'GET') {
        return send(200, { posts: [...tasks.values()].map((x) => ({ ...x, kind: 'message', created_at: '2026-11-26T00:00:00Z' })) });
      }
      if (/\/briefing$/.test(req.url) && req.method === 'POST') {
        return send(200, { task: parsed.task, scorer: 'tfidf', posts: [{ member_id: 'coordinator', content: 'Use bare checks' }] });
      }
      if (/\/ready/.test(req.url)) return send(200, { tasks: [] });
      if (/\/unclaimed/.test(req.url)) {
        const open = [...tasks.values()].filter((x) => x.status === 'open');
        return send(200, { count: open.length, tasks: open });
      }
      if (/\/claim$/.test(req.url) && req.method === 'POST') {
        const item = tasks.get(parsed.task_key);
        if (!item || item.status !== 'open') return send(409, { detail: 'already claimed' });
        item.status = 'claimed';
        item.owner = parsed.member_id || 'worker';
        return send(201, { task_key: item.task_key, status: 'claimed' });
      }
      if (/\/report(\/once)?$/.test(req.url) && req.method === 'POST') {
        const item = tasks.get(parsed.task_key);
        if (item) item.status = parsed.status;
        reports.push(parsed);
        return send(200, { task_key: parsed.task_key, status: parsed.status });
      }
      if (/\/liveness/.test(req.url)) return send(200, { alive: [{ member_id: 'builder' }], dying: [], dead: [], orphaned_claims: [], expired_on_sweep: [] });
      if (/\/idle/.test(req.url)) return send(200, { idle: [] });
      if (/\/claims$/.test(req.url)) return send(200, { count: 0, claims: [] });
      if (/\/members$/.test(req.url)) return send(200, { count: 3, members: [] });
      return send(404, { error: 'not found' });
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}`;

  // Start swarm with 2 workers + freeze lib/core.js.
  assert.equal(await swarmCommand(['start', '3h autonomous improvement', '--team', 'builder,validator', '--server', url, '--hub', 'h2', '--json'], { root, home, log: () => {} }), 0);
  assert.equal(await swarmCommand(['freeze', 'lib/core.js', '--as', 'coordinator', '--server', url, '--hub', 'h2', '--json'], { root, home, log: () => {} }), 0);

  // 1) Multi-cycle execution with fake clock drains both tasks cleanly and verifies bare.
  let fakeNow = 1000000;
  const ran = [];
  const res1 = await comms.runSwarmUpLoop(root, {
    durationMs: 3 * 3600 * 1000,
    label: '3 hr',
    intervalMs: 5 * 60 * 1000,
    stopOnEmpty: true,
    verify: 'node -e "process.exit(0)"',
    server: url,
    hub: 'h2',
    home,
    json: true,
  }, {
    now: () => fakeNow,
    sleep: async (ms) => { fakeNow += ms; },
    runWorker: async ({ member, task, brief }) => {
      ran.push({ member, task_key: task.task_key, has_brief: Boolean(brief && brief.memory_core.length) });
      return { ok: true, summary: `${member} finished ${task.task_key}` };
    },
  });
  assert.equal(res1.ok, true);
  assert.equal(res1.exitCode, 0);
  assert.equal(res1.stop_reason, 'queue_drained');
  assert.equal(res1.executed_count, 2);
  assert.equal(res1.succeeded_count, 2);
  assert.equal(res1.failed_count, 0);
  assert.deepEqual(ran.map((r) => r.task_key), ['t-1', 't-2']);
  assert.equal(ran[0].member, 'builder');
  assert.equal(ran[1].member, 'validator');
  assert.equal(ran.every((r) => r.has_brief), true);
  assert.equal(reports.filter((r) => r.status === 'done').length, 2);

  // 2) Repeat-error circuit breaker halts after 2 identical errors and escalates once to #escalations.
  tasks.set('t-fail-1', { task_key: 't-fail-1', content: 'Failing slice 1', status: 'open', owner: null, channel: 'general' });
  tasks.set('t-fail-2', { task_key: 't-fail-2', content: 'Failing slice 2', status: 'open', owner: null, channel: 'general' });
  tasks.set('t-fail-3', { task_key: 't-fail-3', content: 'Never reached', status: 'open', owner: null, channel: 'general' });
  const res2 = await comms.runSwarmUpLoop(root, {
    durationMs: 3 * 3600 * 1000,
    label: '3 hr',
    intervalMs: 60 * 1000,
    maxCycles: 10,
    maxRepeatErrors: 2,
    server: url,
    hub: 'h2',
    home,
    json: true,
  }, {
    now: () => fakeNow,
    sleep: async (ms) => { fakeNow += ms; },
    runWorker: async () => ({ ok: false, error: 'sqlite database is locked at step 42' }),
  });
  assert.equal(res2.ok, false);
  assert.equal(res2.exitCode, 1);
  assert.equal(res2.stop_reason, 'repeated_error');
  assert.ok(res2.cycles >= 1 && res2.cycles <= 2);
  assert.equal(res2.failed_count, 2);
  assert.equal(res2.escalated.channel, 'escalations');
  assert.equal(res2.escalated.seat, 'strategist');
  assert.equal(res2.escalated.posted, true);
  assert.equal(escalations.length, 1);
  assert.equal(tasks.get('t-fail-3').status, 'open');

  // 3) Real --exec shell command receives env vars (incl ATRIS_AGENT_PROOF_ONLY=1) and passes bare --verify.
  tasks.clear();
  tasks.set('t-shell', { task_key: 't-shell', content: 'Shell exec proof', status: 'open', owner: null, channel: 'general' });
  const execLogs = [];
  const execCode = await swarmCommand([
    'up', '30', 'min', '--once', '--server', url, '--hub', 'h2',
    '--exec', `node -e "require('fs').writeFileSync('shell-proof.txt', process.env.SWARM_TASK_KEY + ':' + process.env.ATRIS_AGENT_PROOF_ONLY)"`,
    '--verify', `node -e "process.exit(require('fs').readFileSync('shell-proof.txt', 'utf8') === 't-shell:1' ? 0 : 1)"`,
    '--json',
  ], { root, home, log: (l) => execLogs.push(l) });
  assert.equal(execCode, 0);
  const execRes = JSON.parse(execLogs.join('\n'));
  assert.equal(execRes.executed_count, 1);
  assert.equal(execRes.succeeded_count, 1);

  // 4) Frozen module tamper mid-loop halts immediately with frozen_module_modified.
  tasks.set('t-tamper', { task_key: 't-tamper', content: 'Modify frozen core', status: 'open', owner: null, channel: 'general' });
  const res3 = await comms.runSwarmUpLoop(root, {
    durationMs: 3600 * 1000,
    label: '1 hr',
    intervalMs: 60 * 1000,
    maxCycles: 5,
    server: url,
    hub: 'h2',
    home,
    json: true,
  }, {
    now: () => fakeNow,
    sleep: async (ms) => { fakeNow += ms; },
    runWorker: async () => {
      fs.writeFileSync(path.join(root, 'lib', 'core.js'), 'module.exports = 999;\n');
      return { ok: true, summary: 'mutated core' };
    },
  });
  assert.equal(res3.ok, false);
  assert.equal(res3.exitCode, 1);
  assert.equal(res3.stop_reason, 'frozen_module_modified');
  assert.equal(res3.cycles, 1);

  // 5) --dispatch mode checks every runnable seat before marking queue_drained, and enforces post-turn checks.
  fs.writeFileSync(path.join(root, 'lib', 'core.js'), 'module.exports = 1;\n');
  const dispatched = [];
  const res4 = await comms.runSwarmUpLoop(root, {
    durationMs: 3600 * 1000,
    label: '1 hr',
    dispatch: true,
    stopOnEmpty: true,
    server: url,
    hub: 'h2',
    home,
    json: true,
  }, {
    now: () => fakeNow,
    sleep: async (ms) => { fakeNow += ms; },
    dispatchMember: async (_r, { member }) => {
      dispatched.push(member);
      // Cycle 1: first seat ('builder') is idle, second seat ('validator') has work -> must run validator, NOT stop early!
      if (dispatched.length === 2 && member === 'validator') {
        return { ok: true, idle: false, summary: 'validator fixed one task' };
      }
      return { ok: true, idle: true, summary: 'no runnable task' };
    },
  });
  assert.equal(res4.ok, true);
  assert.equal(res4.stop_reason, 'queue_drained');
  assert.equal(res4.executed_count, 1);
  assert.equal(res4.succeeded_count, 1);
  assert.deepEqual(dispatched, ['builder', 'validator', 'validator', 'builder']);
});

test('audit regressions: no fleet/swarm recursion, startSwarm failure stops natural loop, per-run idempotency, token isolation, and per-path freeze base', async (t) => {
  const { execFileSync } = require('node:child_process');
  const { home, root } = makeSandbox(t, true);
  const { freezeModules } = require('../lib/swarm');
  const swarlo = require('../lib/swarlo-members');

  // 1) No infinite recursion when value flags precede member name in `swarm up --every 5m builder`.
  const noRecurseCode = await swarmCommand(['up', '--every', '5m', 'builder', '--dry-run', '--json'], { root, home, log: () => {} });
  assert.equal(typeof noRecurseCode, 'number');

  // 2) startSwarm failure aborts runNaturalSwarm cleanly with error and exitCode 2 (no loop run).
  const errLogs = [];
  const errCode = await swarmCommand(
    ['fix auth for 10 min', '--engine', 'not-a-real-engine', '--offline', '--dry-run', '--json'],
    { root, home, log: (l) => errLogs.push(l) },
  );
  assert.equal(errCode, 2);
  const errPayload = JSON.parse(errLogs.join('\n'));
  assert.equal(errPayload.ok, false);
  assert.match(errPayload.error, /not recognized/);
  assert.equal(errPayload.loop, null);

  // 3) Cross-hub token isolation: a token saved for prod-hub is NEVER sent to staging-hub.
  const seenAuth = [];
  const server = http.createServer((req, res) => {
    if (req.headers.authorization) seenAuth.push({ url: req.url, auth: req.headers.authorization });
    res.writeHead(req.url === '/api/health' ? 200 : 200, { 'Content-Type': 'application/json' });
    if (req.url === '/api/health') return res.end(JSON.stringify({ status: 'ok' }));
    return res.end(JSON.stringify({ posts: [], alive: [], dying: [], dead: [], orphaned_claims: [] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}`;
  const prodDir = swarlo.identityDirFor({ server: url, hub: 'prod-hub', member: 'coordinator' }, home);
  swarlo.saveIdentity(prodDir, { server: url, hub: 'prod-hub', member_id: 'coordinator', token: 'secret-prod-token' });
  await comms.buildSwarmBrief(root, { task: 'check auth', as: 'coordinator', server: url, hub: 'staging-hub', home });
  assert.equal(seenAuth.some((h) => h.auth.includes('secret-prod-token')), false);

  // 4) Freezing path B after committing a change to frozen path A still catches A's modification.
  fs.mkdirSync(path.join(root, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(root, 'lib', 'a.js'), 'module.exports = "v1";\n');
  fs.writeFileSync(path.join(root, 'lib', 'b.js'), 'module.exports = "v1";\n');
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-q', '-m', 'seed'], { cwd: root });

  assert.equal((await freezeModules(root, ['lib/a.js'], { dryRun: false, home })).ok, true);
  fs.writeFileSync(path.join(root, 'lib', 'a.js'), 'module.exports = "mutated";\n');
  execFileSync('git', ['add', 'lib/a.js'], { cwd: root });
  execFileSync('git', ['commit', '-q', '-m', 'mutate a'], { cwd: root });
  assert.equal((await freezeModules(root, ['lib/b.js'], { dryRun: false, home })).ok, true);
  const check = await freezeModules(root, [], { check: true, home });
  assert.equal(check.ok, false);
  assert.ok(check.changed.includes('lib/a.js'));
});

test('gold upgrades: quoted duration, dry-run zero writes, full MAP+wiki+descriptions+track-record sight, parallel waves, isolated worktrees, offline local queue, honest review_pending, unfreeze release', async (t) => {
  const { execFileSync } = require('node:child_process');
  const { home, root } = makeSandbox(t, true);
  const { freezeModules } = require('../lib/swarm');

  // 1) Quoted leading duration parses cleanly without losing the rest of the prompt.
  const quotedDur = comms.parseDurationTokens(['1 hour to understand the swarm']);
  assert.equal(quotedDur.ms, 3600000);
  assert.equal(quotedDur.label, '1 hour');
  assert.equal(quotedDur.remainder, 'to understand the swarm');

  // 2) Full planner sight: deep MAP row (>4KB), wiki index, MEMBER.md description, ROSTER.md, and seat track record.
  const fillerRows = Array.from({ length: 80 }, (_, i) => `| pad feature ${i} | \`lib/pad-${i}.js\` | filler row ${i} |`).join('\n');
  fs.writeFileSync(path.join(root, 'atris', 'MAP.md'), `| Task | Primary path | Notes |\n|---|---|---|\n${fillerRows}\n| deep refund engine | \`lib/refund-engine.js\` | handles customer refunds |\n`);
  fs.mkdirSync(path.join(root, 'atris', 'wiki'), { recursive: true });
  fs.writeFileSync(path.join(root, 'atris', 'wiki', 'index.md'), '# Index\n\n- [[atris/wiki/systems/refund-flow.md]]: How refund engine handles retries.\n');
  fs.writeFileSync(path.join(root, 'atris', 'ROSTER.md'), '# Roster\n- builder: codex\n- validator: claude\n');
  fs.writeFileSync(path.join(root, '.atris', 'state', 'coordination_trace.jsonl'), [
    JSON.stringify({ ts: '2026-11-26T00:00:00Z', seat: 'builder', outcome: 'accepted' }),
    JSON.stringify({ ts: '2026-11-26T00:01:00Z', seat: 'validator', outcome: 'failed' }),
  ].join('\n') + '\n');

  let seenPrompt = '';
  const planned = await comms.planNaturalSwarm(root, 'fix refund engine retry bug', { skipBoard: true }, {
    askModel: async (_r, prompt) => {
      seenPrompt = prompt;
      return {
        ok: true,
        engine: 'haiku',
        text: JSON.stringify({
          objective: 'Fix refund engine retry bug',
          duration_minutes: 30,
          lead: 'coordinator',
          workers: ['builder', 'validator'],
          solo: false,
          tier: 1,
          needs_human_yes: false,
          context_paths: ['lib/refund-engine.js'],
          tasks: [{ task_key: 'refund-1', content: 'Fix retry', depends_on: [] }],
          reason: 'Builder owns refund code.',
        }),
      };
    },
  });
  assert.equal(planned.plan.planner, 'llm');
  assert.match(seenPrompt, /lib\/refund-engine\.js/);
  assert.match(seenPrompt, /refund-flow\.md/);
  assert.match(seenPrompt, /Writes backend auth code and fixes tests/);
  assert.match(seenPrompt, /builder: 1 accepted, 0 failed/);
  assert.match(seenPrompt, /Active ROSTER\.md/);

  // 3) --dry-run NEVER posts reallocation or auto_expire=true to live Swarlo, and unfreeze releases file:<path> claim.
  const livePosts = [];
  const liveReports = [];
  const livenessUrls = [];
  const tasks = new Map([
    ['w1', { task_key: 'w1', content: 'Parallel step 1', status: 'open', channel: 'general' }],
    ['w2', { task_key: 'w2', content: 'Parallel step 2', status: 'open', channel: 'general' }],
  ]);
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
      if (req.url === '/api/register') return send(201, { member_id: parsed.member_id, api_key: `tok-${parsed.member_id}`, hub_id: parsed.hub_id });
      if (/\/posts$/.test(req.url) && req.method === 'POST') { livePosts.push(parsed); return send(201, { post_id: `p-${livePosts.length}` }); }
      if (/\/claim-file$/.test(req.url) && req.method === 'POST') return send(201, { status: 'claimed' });
      if (/\/touch$/.test(req.url) && req.method === 'POST') return send(200, { ok: true });
      if (/\/briefing$/.test(req.url)) return send(200, { posts: [] });
      if (/\/posts\?/.test(req.url)) return send(200, { posts: [...tasks.values()].map((x) => ({ ...x, kind: 'message', created_at: '2026-11-26T00:00:00Z' })) });
      if (/\/ready/.test(req.url)) return send(200, { tasks: [] });
      if (/\/unclaimed/.test(req.url)) {
        const open = [...tasks.values()].filter((x) => x.status === 'open');
        return send(200, { count: open.length, tasks: open });
      }
      if (/\/claim$/.test(req.url) && req.method === 'POST') {
        const item = tasks.get(parsed.task_key);
        if (!item || item.status !== 'open') return send(409, { detail: 'taken' });
        item.status = 'claimed';
        return send(201, { task_key: item.task_key, status: 'claimed' });
      }
      if (/\/report(\/once)?$/.test(req.url) && req.method === 'POST') {
        const item = tasks.get(parsed.task_key);
        if (item) item.status = parsed.status;
        liveReports.push(parsed);
        return send(200, { task_key: parsed.task_key, status: parsed.status });
      }
      if (/\/liveness/.test(req.url)) {
        livenessUrls.push(req.url);
        return send(200, { alive: [{ member_id: 'builder' }], dying: [], dead: [], orphaned_claims: [], expired_on_sweep: [] });
      }
      if (/\/idle/.test(req.url)) return send(200, { idle: [{ member_id: 'builder' }] });
      if (/\/claims$/.test(req.url)) return send(200, { count: 0, claims: [] });
      if (/\/members$/.test(req.url)) return send(200, { count: 2, members: [] });
      return send(404, { error: 'not found' });
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}`;

  fs.mkdirSync(path.join(root, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(root, 'lib', 'safe.js'), 'module.exports = 1;\n');
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-q', '-m', 'seed'], { cwd: root });

  assert.equal(await swarmCommand(['start', 'Gold test', '--team', 'builder,validator', '--server', url, '--hub', 'hg', '--json'], { root, home, log: () => {} }), 0);

  // Dry run must NOT post reallocation or call auto_expire=true!
  const postsBeforeDry = livePosts.length;
  livenessUrls.length = 0;
  const dryRes = await comms.runSwarmUpLoop(root, { durationMs: 60000, once: true, dryRun: true, server: url, hub: 'hg', home, json: true });
  assert.equal(dryRes.history[0].reallocated, false);
  assert.equal(livePosts.length, postsBeforeDry);
  assert.ok(livenessUrls.every((u) => u.includes('auto_expire=false')));

  // Freeze + unfreeze must release file:lib/safe.js claim on Swarlo!
  await freezeModules(root, ['lib/safe.js'], { as: 'coordinator', server: url, hub: 'hg', home });
  const unf = await freezeModules(root, ['lib/safe.js'], { unfreeze: true, as: 'coordinator', server: url, hub: 'hg', home });
  assert.equal(unf.hub_released, 1);
  assert.ok(liveReports.some((r) => r.task_key === 'file:lib/safe.js' && r.status === 'done'));

  // 4) True parallel wave runs BOTH w1 and w2 concurrently in 1 cycle with zero sleep between active waves,
  // auto-applies dreaming, and records honest review_pending (never self-graded accepted) without reviewTurn.
  let inFlight = 0;
  let peakInFlight = 0;
  let sleepCalls = 0;
  const waveRes = await comms.runSwarmUpLoop(root, {
    durationMs: 3600000,
    parallel: 2,
    stopOnEmpty: true,
    server: url,
    hub: 'hg',
    home,
    json: true,
  }, {
    sleep: async () => { sleepCalls += 1; },
    runWorker: async ({ task }) => {
      inFlight += 1;
      peakInFlight = Math.max(peakInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 40));
      inFlight -= 1;
      return { ok: true, summary: `done ${task.task_key}` };
    },
  });
  assert.equal(waveRes.ok, true);
  assert.equal(waveRes.executed_count, 2);
  assert.equal(peakInFlight, 2);
  assert.equal(sleepCalls, 0);
  assert.equal(waveRes.dream.applied, true);
  const traceRows = fs.readFileSync(path.join(root, '.atris', 'state', 'coordination_trace.jsonl'), 'utf8')
    .trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(traceRows.find((r) => r.task_key === 'w1').outcome, 'review_pending');

  // 5) Isolated worktree for --exec keeps shared root clean, preserves verified work on a branch,
  // AND enforces frozen-module guard from root inside the isolated worktree!
  tasks.set('w-iso', { task_key: 'w-iso', content: 'Isolated shell write', status: 'open', channel: 'general' });
  const isoRes = await comms.runSwarmUpLoop(root, {
    durationMs: 60000,
    once: true,
    exec: `node -e "require('fs').writeFileSync('isolated-only.txt', 'ok')"`,
    verify: `node -e "process.exit(require('fs').readFileSync('isolated-only.txt','utf8')==='ok'?0:1)"`,
    server: url,
    hub: 'hg',
    home,
    json: true,
  });
  assert.equal(isoRes.ok, true);
  assert.equal(isoRes.history[0].steps[0].isolated, true);
  assert.equal(fs.existsSync(path.join(root, 'isolated-only.txt')), false);
  assert.ok(isoRes.history[0].steps[0].branch, 'verified isolated edits must be preserved on a git branch');
  assert.ok(isoRes.history[0].steps[0].commit, 'verified isolated edits must record commit SHA');
  const savedContent = execFileSync('git', ['show', `${isoRes.history[0].steps[0].branch}:isolated-only.txt`], { cwd: root, encoding: 'utf8' });
  assert.equal(savedContent, 'ok');

  // Mutating a frozen file INSIDE an isolated worktree MUST fail with frozen_module_modified!
  await freezeModules(root, ['lib/safe.js'], { as: 'coordinator', server: url, hub: 'hg', home });
  tasks.set('w-iso-tamper', { task_key: 'w-iso-tamper', content: 'Tamper frozen inside worktree', status: 'open', channel: 'general' });
  const isoTamper = await comms.runSwarmUpLoop(root, {
    durationMs: 60000,
    once: true,
    exec: `node -e "require('fs').writeFileSync('lib/safe.js', 'module.exports = 999;')"`,
    server: url,
    hub: 'hg',
    home,
    json: true,
  });
  assert.equal(isoTamper.ok, false);
  assert.equal(isoTamper.stop_reason, 'frozen_module_modified');
  await freezeModules(root, ['lib/safe.js'], { unfreeze: true, as: 'coordinator', server: url, hub: 'hg', home });

  // Dry run on existing swarm (`swarm up 1 hr --dry-run` without --once) must run exactly 1 cycle and not hang!
  const dryNoOnce = await comms.runSwarmUpLoop(root, { durationMs: 3600000, dryRun: true, server: url, hub: 'hg', home, json: true });
  assert.equal(dryNoOnce.cycles, 1);

  // 6) Offline natural swarm persists queue to swarm.json, drains a 2-step DAG with reviewTurn -> accepted,
  // and cascades upstream failures to blocked_failed without deadlocking!
  const off = makeSandbox(t, true);
  const bigQuote = `${'> intro line about roster rules and policy.\n'.repeat(30)}\n## team\n- builder: codex\n`;
  fs.writeFileSync(path.join(off.root, 'atris', 'ROSTER.md'), bigQuote);
  let rosterPromptSeen = '';
  const offOrder = [];
  const offRes = await comms.runNaturalSwarm(off.root, '30 min offline dag proof', {
    offline: false,
    stopOnEmpty: true,
    server: 'http://127.0.0.1:1',
    hub: 'offline-hub',
    home: off.home,
    json: true,
  }, {
    askModel: async (_r, prompt) => {
      rosterPromptSeen = prompt;
      return {
        ok: true,
        engine: 'haiku',
        text: JSON.stringify({
          objective: 'Run offline DAG',
          duration_minutes: 30,
          lead: 'coordinator',
          workers: ['builder'],
          solo: false,
          tier: 1,
          needs_human_yes: false,
          context_paths: [],
          tasks: [
            { task_key: 'step-a', content: 'First step', depends_on: [] },
            { task_key: 'step-b', content: 'Second step', depends_on: ['step-a'] },
          ],
          reason: 'Offline queue DAG proof.',
        }),
      };
    },
    runWorker: async ({ task }) => {
      offOrder.push(task.task_key);
      return { ok: true, summary: `ran ${task.task_key}` };
    },
    reviewTurn: async () => ({ ok: true }),
  });
  assert.equal(offRes.ok, true);
  assert.match(rosterPromptSeen, /## team/);
  assert.deepEqual(offOrder, ['step-a', 'step-b']);
  const offTrace = fs.readFileSync(path.join(off.root, '.atris', 'state', 'coordination_trace.jsonl'), 'utf8')
    .trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(offTrace.find((r) => r.task_key === 'step-a').outcome, 'accepted');
  assert.equal(offTrace.find((r) => r.task_key === 'step-b').outcome, 'accepted');
  assert.equal(offTrace.filter((r) => r.task_key === 'step-a').length, 1, 'must not append duplicate pending trace row');

  // Upstream failure in offline queue cascades to blocked_failed so stopOnEmpty drains cleanly without deadlock!
  const dead = makeSandbox(t, true);
  const deadRes = await comms.runNaturalSwarm(dead.root, '30 min upstream failure cascade', {
    stopOnEmpty: true,
    maxRepeatErrors: 5,
    server: 'http://127.0.0.1:1',
    hub: 'offline-hub',
    home: dead.home,
    json: true,
  }, {
    askModel: async () => ({
      ok: true,
      engine: 'haiku',
      text: JSON.stringify({
        objective: 'Upstream fail cascade',
        duration_minutes: 30,
        lead: 'coordinator',
        workers: ['builder'],
        solo: false,
        tier: 1,
        needs_human_yes: false,
        context_paths: [],
        tasks: [
          { task_key: 'up-1', content: 'Fails upstream', depends_on: [] },
          { task_key: 'down-2', content: 'Depends on up-1', depends_on: ['up-1'] },
        ],
        reason: 'Cascade test.',
      }),
    }),
    runWorker: async () => ({ ok: false, error: 'upstream broke' }),
  });
  assert.equal(deadRes.loop.stop_reason, 'queue_drained');
  assert.equal(deadRes.loop.executed_count, 1);
});
