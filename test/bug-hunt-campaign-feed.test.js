'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { campaignCommand } = require('../commands/campaign');
const { fold } = require('../lib/campaign-core');
const { LANE_ASK_KIND, openLaneAsks } = require('../lib/campaign-lanes');
const { closeCampaignStores, createMemoryStore, createSqliteStore, getCampaign, openCampaignStore } = require('../lib/campaign-store');
const { syncCampaign } = require('../lib/campaign-sync');
const feed = require('../lib/feed-core');
const room = require('../lib/feed-room');
const feedTeam = require('../lib/feed-team');
const feedWork = require('../lib/feed-work');
const decisionFeed = require('../commands/decision-feed');
const tasks = require('../lib/task-db');
const { project } = require('./helpers/feed-project');

const CLI = path.resolve(__dirname, '..', 'bin', 'atris.js');

const CLEAN_AGENT_ENV_KEYS = [
  'ATRIS_HUMAN', 'ATRIS_AGENT_ID', 'ATRIS_AGENT_PROOF_ONLY', 'ATRIS_DISPATCH_DEPTH',
  'ATRIS_MISSION_DRIVER_DETACHED', 'ATRIS_MISSION_DRIVER_PARENT_PID',
  'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CODEX_SANDBOX', 'CURSOR_AGENT',
  'CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'DEVIN_SESSION_ID', 'OPENCODE_SESSION_ID',
];

function cleanEnv(extra = {}) {
  const env = { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1', NODE_NO_WARNINGS: '1' };
  for (const key of CLEAN_AGENT_ENV_KEYS) delete env[key];
  return { ...env, ...extra };
}

async function runCampaign(store, args, deps = {}) {
  const out = [];
  const err = [];
  const saved = { log: console.log, error: console.error };
  console.log = (line) => out.push(String(line));
  console.error = (line) => err.push(String(line));
  try {
    const code = await campaignCommand(args, {
      store,
      runJudge: () => ({ passed: false, exit: 1, summary: '0 of 1', seconds: 0 }),
      ...deps,
    });
    return { code, out: out.join('\n'), err: err.join('\n') };
  } finally {
    console.log = saved.log;
    console.error = saved.error;
  }
}

async function runFeedCmd(cwd, args, env, deps = {}) {
  const out = [];
  const err = [];
  const saved = { log: console.log, error: console.error };
  console.log = (line) => out.push(String(line));
  console.error = (line) => err.push(String(line));
  try {
    const code = await decisionFeed.run(args, { cwd, env, deps, write: (text) => out.push(String(text)) });
    return { code, out: out.join('\n'), err: err.join('\n') };
  } finally {
    console.log = saved.log;
    console.error = saved.error;
  }
}

function feedCampaignProject(t) {
  const ctx = project(t, ['mission-lead', 'builder']);
  const saved = process.env.ATRIS_CAMPAIGN_DB;
  const campaignDb = path.join(ctx.dir, 'campaigns.db');
  process.env.ATRIS_CAMPAIGN_DB = campaignDb;
  ctx.env = cleanEnv({ ATRIS_TASKS_DB: ctx.env.ATRIS_TASKS_DB, USER: 'owner', ATRIS_CAMPAIGN_DB: campaignDb });
  ctx.agentEnv = { ...ctx.env, CLAUDECODE: '1' };
  ctx.campaignDb = campaignDb;
  ctx.store = openCampaignStore(ctx.root);
  t.after(() => {
    closeCampaignStores();
    if (saved === undefined) delete process.env.ATRIS_CAMPAIGN_DB;
    else process.env.ATRIS_CAMPAIGN_DB = saved;
  });
  return ctx;
}

// ------------------------------------------------ Bug 2: agent impersonation

test('bug 2: autonomous worker env markers prevent human actor in campaign; ATRIS_AGENT_PROOF_ONLY=0 does not false-trigger', (t) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atris-bug2-campaign-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const db = path.join(dir, 'campaigns.db');

  const markers = [
    ['ATRIS_AGENT_PROOF_ONLY', '1'],
    ['ATRIS_DISPATCH_DEPTH', '1'],
    ['ATRIS_MISSION_DRIVER_DETACHED', '1'],
    ['ATRIS_MISSION_DRIVER_PARENT_PID', '4242'],
    ['CODEX_THREAD_ID', 'thread-1'],
    ['CODEX_SESSION_ID', 'session-1'],
    ['DEVIN_SESSION_ID', 'devin-1'],
    ['OPENCODE_SESSION_ID', 'opencode-1'],
  ];

  for (let i = 0; i < markers.length; i += 1) {
    const [key, value] = markers[i];
    const id = `cmp-m${i}`;
    const env = cleanEnv({ ATRIS_CAMPAIGN_DB: db, [key]: value });
    const started = spawnSync(
      process.execPath,
      [CLI, 'campaign', 'start', `Marker ${key}`, '--judge', 'exit 1', '--budget', '10', '--id', id, '--json'],
      { cwd: dir, env, encoding: 'utf8' },
    );
    assert.equal(started.status, 0, `${key}: ${started.stderr}`);
    const body = JSON.parse(started.stdout);
    assert.equal(
      body.campaign.created_from.includes('human:'),
      false,
      `${key}=${value} must not record a human actor (got ${body.campaign.created_from})`,
    );
  }

  // ATRIS_AGENT_PROOF_ONLY=0 alone must not false-trigger agent detection.
  const humanEnv = cleanEnv({ ATRIS_CAMPAIGN_DB: db, ATRIS_AGENT_PROOF_ONLY: '0' });
  const humanStart = spawnSync(
    process.execPath,
    [CLI, 'campaign', 'start', 'Proof off human', '--judge', 'exit 1', '--budget', '10', '--id', 'cmp-human0', '--json'],
    { cwd: dir, env: humanEnv, encoding: 'utf8' },
  );
  assert.equal(humanStart.status, 0, humanStart.stderr);
  assert.match(JSON.parse(humanStart.stdout).campaign.created_from, /by human:/);
});

test('bug 2: ATRIS_AGENT_ID alone blocks human-only actions in feed decide, settings, clear, and work', (t) => {
  const ctx = project(t, ['scout', 'writer']);
  const agentOnlyEnv = cleanEnv({ ATRIS_TASKS_DB: ctx.env.ATRIS_TASKS_DB, USER: 'owner', ATRIS_AGENT_ID: 'worker-42' });
  assert.equal(feed.viewerOf(agentOnlyEnv).agent, 'ATRIS_AGENT_ID');

  const idea = feed.proposeCard(ctx.root, { as: 'scout', title: 'Call the ten warm leads', why: 'Warm leads close faster', env: ctx.env }).card;
  const note = room.say(ctx.root, { as: 'scout', text: 'We should call the ten warm leads this week.', env: ctx.env, deps: ctx.deps }).card;
  const reply = room.reply(ctx.root, note.id, 'I can call them tomorrow morning.', { as: 'writer', direct: true, env: ctx.env, deps: ctx.deps }).reply;

  assert.throws(() => feed.decide(ctx.root, idea.id, 'approve', { env: agentOnlyEnv, deps: ctx.deps }), (e) => e.status === 403);
  assert.throws(() => feedTeam.setDefaultEngine(ctx.root, 'codex', { env: agentOnlyEnv }), (e) => e.status === 403);
  assert.throws(() => room.clear(ctx.root, { env: agentOnlyEnv, confirmed: true }), (e) => e.status === 403);
  assert.throws(() => feedWork.startWork(ctx.root, note.id, { replyId: reply.id, env: agentOnlyEnv, deps: ctx.deps }), (e) => e.status === 403);
});

// ------------------------------------------------ Bug 3: campaign budget --add

test('bug 3: non-human actor cannot add campaign budget via CLI or fold()', async () => {
  const store = createMemoryStore({ origin: 'laptop' });
  store.append({
    campaign_id: 'cmp-budget',
    type: 'campaign_started',
    actor: 'human:keshav',
    data: { title: 'Budget cap', judge: 'exit 1', budget: 10 },
  });

  const byFlag = await runCampaign(store, ['budget', 'cmp-budget', '--add', '5000', '--as', 'builder', '--json'], { actor: 'human:keshav' });
  assert.equal(byFlag.code, 2);
  assert.equal(JSON.parse(byFlag.out).ok, false);
  assert.match(JSON.parse(byFlag.out).error, /only a person can add budget/);
  assert.equal(getCampaign(store, 'cmp-budget').budget.total, 10);

  const byWorkerEnv = await runCampaign(store, ['budget', 'cmp-budget', '--add', '5000', '--json'], {
    env: cleanEnv({ CODEX_THREAD_ID: 'worker-thread' }),
  });
  assert.equal(byWorkerEnv.code, 2);
  assert.equal(JSON.parse(byWorkerEnv.out).ok, false);
  assert.equal(getCampaign(store, 'cmp-budget').budget.total, 10);

  // Even a rogue budget_added event written directly into the event log by a non-human is ignored by fold().
  const folded = fold([
    {
      id: 'e1', campaign_id: 'cmp-fold-budget', type: 'campaign_started',
      at: '2026-10-15T10:00:00Z', origin: 'laptop', seq: 1, actor: 'human:keshav',
      data: { title: 'Fold budget', judge: 'exit 1', budget: 10 },
    },
    {
      id: 'e2', campaign_id: 'cmp-fold-budget', type: 'budget_added',
      at: '2026-10-15T10:01:00Z', origin: 'laptop', seq: 2, actor: 'builder',
      data: { amount_usd: 999 },
    },
  ]);
  assert.equal(folded.budget.total, 10);

  // Human actor still succeeds.
  const byHuman = await runCampaign(store, ['budget', 'cmp-budget', '--add', '15', '--json'], { actor: 'human:keshav' });
  assert.equal(byHuman.code, 0, byHuman.err);
  assert.equal(JSON.parse(byHuman.out).campaign.budget.total, 25);
});

// ------------------------------------------------ Bug 4: non-human campaign answer & openLaneAsks

test('bug 4: non-human campaign answer exits non-zero with ok:false, writes no event, and cannot clear openLaneAsks()', async () => {
  const opened = {
    type: 'ask_opened',
    actor: 'campaign-loop',
    data: { ask_id: 'a-lane', kind: LANE_ASK_KIND, lane: 'billing' },
  };
  const agentAnswer = {
    type: 'ask_answered',
    actor: 'builder',
    data: { ask_id: 'a-lane', answer: 'yes' },
  };
  const humanAnswer = {
    type: 'ask_answered',
    actor: 'human:keshav',
    data: { ask_id: 'a-lane', answer: 'yes' },
  };

  assert.deepEqual([...openLaneAsks([opened, agentAnswer])], ['billing'], 'agent answer must not clear protected lane');
  assert.equal(openLaneAsks([opened, agentAnswer, humanAnswer]).size, 0, 'human answer clears protected lane');

  const store = createMemoryStore({ origin: 'laptop' });
  store.append({
    campaign_id: 'cmp-lane-guard',
    type: 'campaign_started',
    actor: 'human:keshav',
    data: { title: 'Lane guard', judge: 'exit 1', budget: 10 },
  });
  store.append({
    campaign_id: 'cmp-lane-guard',
    type: 'ask_opened',
    actor: 'campaign-loop',
    data: { ask_id: 'a-bill', question: 'Allow billing?', kind: LANE_ASK_KIND, lane: 'billing' },
  });

  // Non-human CLI answer must exit non-zero, return ok:false, write zero ask_answered events, and keep lane frozen.
  const byAgent = await runCampaign(store, ['answer', 'cmp-lane-guard', 'a-bill', 'yes', '--as', 'builder', '--json'], { actor: 'human:keshav' });
  assert.notEqual(byAgent.code, 0);
  const agentBody = JSON.parse(byAgent.out);
  assert.equal(agentBody.ok, false);
  assert.match(agentBody.error, /only a person can answer/i);
  assert.equal(store.read('cmp-lane-guard').filter((e) => e.type === 'ask_answered').length, 0);
  assert.deepEqual([...openLaneAsks(store.read('cmp-lane-guard'))], ['billing']);

  // Unknown ask_id from human must also exit non-zero with ok:false and write no event.
  const unknown = await runCampaign(store, ['answer', 'cmp-lane-guard', 'a-missing', 'yes', '--json'], { actor: 'human:keshav' });
  assert.notEqual(unknown.code, 0);
  assert.equal(JSON.parse(unknown.out).ok, false);
  assert.equal(store.read('cmp-lane-guard').filter((e) => e.type === 'ask_answered').length, 0);

  // Human answering open ask succeeds; answering a second time (already closed) exits non-zero.
  const ok = await runCampaign(store, ['answer', 'cmp-lane-guard', 'a-bill', 'yes', '--json'], { actor: 'human:keshav' });
  assert.equal(ok.code, 0, ok.err);
  assert.equal(JSON.parse(ok.out).ok, true);
  assert.equal(openLaneAsks(store.read('cmp-lane-guard')).size, 0);

  const duplicate = await runCampaign(store, ['answer', 'cmp-lane-guard', 'a-bill', 'yes again', '--json'], { actor: 'human:keshav' });
  assert.notEqual(duplicate.code, 0);
  assert.equal(JSON.parse(duplicate.out).ok, false);
  assert.equal(store.read('cmp-lane-guard').filter((e) => e.type === 'ask_answered').length, 1);
});

// ------------------------------------------------ Bug 5: feed reply cloud sync, atomic failure, settleAnswered, isHeld

function fakeCampaignCloud() {
  const events = [];
  const requests = [];
  let seq = 0;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      requests.push({ method: req.method, path: url.pathname });
      const send = (status, body) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      const match = url.pathname.match(/^\/api\/campaigns\/([^/]+)\/(events|asks\/([^/]+)\/answer)$/);
      if (!match) return send(404, { ok: false, error: 'no such route' });
      const campaignId = decodeURIComponent(match[1]);
      const body = raw ? JSON.parse(raw) : {};
      if (match[2] === 'events' && req.method === 'GET') {
        const after = Number(url.searchParams.get('after')) || 0;
        const page = events.map((e, i) => ({ e, seq: i + 1 })).filter((x) => x.e.campaign_id === campaignId && x.seq > after);
        return send(200, { ok: true, events: page.map((x) => x.e), last_event_seq: page.length ? page[page.length - 1].seq : after });
      }
      if (match[2] === 'events' && req.method === 'POST') {
        let accepted = 0;
        for (const event of body.events || []) {
          if (events.some((e) => e.id === event.id)) continue;
          events.push(event);
          accepted += 1;
        }
        return send(200, { ok: true, accepted, duplicates: (body.events || []).length - accepted, last_event_seq: events.length });
      }
      if (match[3]) {
        seq += 1;
        events.push({
          id: `evt-cloud-${seq}`,
          campaign_id: campaignId,
          type: 'ask_answered',
          at: new Date(Date.now() + 1000).toISOString(),
          origin: 'cloud',
          seq,
          actor: 'human:cloud',
          data: { ask_id: decodeURIComponent(match[3]), answer: body.answer },
        });
        return send(200, { ok: true });
      }
      return send(404, { ok: false, error: 'not found' });
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    resolve({
      events,
      requests,
      url: `http://127.0.0.1:${port}/api`,
      close: () => new Promise((done) => server.close(done)),
    });
  }));
}

test('bug 5a: atris feed reply on a cloud-synced campaign ask sends the answer through the cloud', async (t) => {
  const ctx = feedCampaignProject(t);
  const cloud = await fakeCampaignCloud();
  const savedUrl = process.env.ATRIS_API_URL;
  process.env.ATRIS_API_URL = cloud.url;
  t.after(async () => {
    if (savedUrl === undefined) delete process.env.ATRIS_API_URL;
    else process.env.ATRIS_API_URL = savedUrl;
    await cloud.close();
  });

  const cloudDeps = { loadCredentials: () => ({ token: 'test-token' }) };
  ctx.store.append({
    campaign_id: 'cmp-cloud-ask',
    type: 'campaign_started',
    actor: 'human:keshav',
    data: { title: 'Cloud synced ask', judge: 'exit 1', budget: 20, owner: 'mission-lead' },
  });
  ctx.store.append({
    campaign_id: 'cmp-cloud-ask',
    type: 'ask_opened',
    actor: 'mission-lead',
    data: { ask_id: 'a-sync', question: 'Launch to beta users?' },
  });
  const synced = await syncCampaign(ctx.store, 'cmp-cloud-ask', cloudDeps);
  assert.equal(synced.ok, true, synced.error);

  const cardId = 'campaign:cmp-cloud-ask:ask:a-sync';
  const replied = await runFeedCmd(
    ctx.root,
    ['reply', cardId, 'Yes, launch to beta.', '--json'],
    ctx.env,
    { ...ctx.deps, cloud: cloudDeps },
  );
  assert.equal(replied.code, 0, replied.err + replied.out);
  const body = JSON.parse(replied.out);
  assert.equal(body.answered, true);
  assert.equal(body.via, 'cloud');
  assert.ok(cloud.requests.some((r) => r.path === '/api/campaigns/cmp-cloud-ask/asks/a-sync/answer'));
  assert.deepEqual(getCampaign(ctx.store, 'cmp-cloud-ask').asks, []);
  const localAnswers = ctx.store.read('cmp-cloud-ask').filter((e) => e.type === 'ask_answered');
  assert.deepEqual(localAnswers.map((e) => e.origin), ['cloud']);
});

test('bug 5b: failed campaign ask answer never writes social.json and never hides the open ask', async (t) => {
  const ctx = feedCampaignProject(t);
  ctx.store.append({
    campaign_id: 'cmp-ro',
    type: 'campaign_started',
    actor: 'human:keshav',
    data: { title: 'Read only ask', judge: 'exit 1', budget: 10, owner: 'mission-lead' },
  });
  ctx.store.append({
    campaign_id: 'cmp-ro',
    type: 'ask_opened',
    actor: 'mission-lead',
    data: { ask_id: 'a-ro', question: 'Approve spend?' },
  });
  const cardId = 'campaign:cmp-ro:ask:a-ro';

  // Close the writable handle and make the sqlite file read-only so store.append fails.
  closeCampaignStores();
  for (const suffix of ['', '-wal', '-shm']) {
    const file = `${ctx.campaignDb}${suffix}`;
    if (fs.existsSync(file)) fs.chmodSync(file, 0o444);
  }
  t.after(() => {
    for (const suffix of ['', '-wal', '-shm']) {
      const file = `${ctx.campaignDb}${suffix}`;
      if (fs.existsSync(file)) fs.chmodSync(file, 0o644);
    }
  });

  // 1. Synchronous room.reply fails before writing social.json.
  assert.throws(() => room.reply(ctx.root, cardId, 'Yes, approved.', { env: ctx.env, deps: ctx.deps }));
  const socialAfterFail = room.readSocial(ctx.root);
  assert.equal((socialAfterFail[cardId] && socialAfterFail[cardId].replies || []).length, 0, 'failed ask answer must not save comment to social.json');

  // 2. Even if social.json somehow has a person comment on a campaign_ask card, settleAnswered must not hide it.
  room._updateEntry(ctx.root, cardId, (entry) => {
    entry.replies.push({ id: 'deadbeef0001', by: 'user:owner', text: 'stale comment', at: new Date().toISOString() });
  });
  const listed = feed.listCards(ctx.root, { filter: 'needs_decision', env: ctx.env });
  const askCard = listed.cards.find((card) => card.id === cardId);
  assert.ok(askCard, 'open campaign ask must stay visible on needs_decision even if social.json has a person comment');
  assert.equal(askCard.needs_decision, true);
});

test('bug 5c: open task with metadata.stage === "plan" surfaces as a held decision card on the feed', (t) => {
  const ctx = project(t, ['scout']);
  const id = tasks.addTask(ctx.db, {
    workspaceRoot: ctx.root,
    title: 'Approve the Q4 onboarding plan',
    status: 'open',
    metadata: { stage: 'plan', assigned_to: 'scout' },
  }).id;
  const listed = feed.listCards(ctx.root, { filter: 'needs_decision', env: ctx.env });
  const card = listed.cards.find((item) => item.source.id === id);
  assert.ok(card, 'open plan-stage task should surface on needs_decision');
  assert.equal(card.needs_decision, true);
  assert.equal(card.can_decide, true);
});

// ------------------------------------------------ Audit Fix 1: human actor spoofing via ATRIS_AGENT_ID

test('audit fix 1: ATRIS_AGENT_ID=human:... cannot spoof human actor in campaign CLI, makeContext, or MCP', async (t) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atris-audit1-spoof-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const db = path.join(dir, 'campaigns.db');

  // 1. CLI campaign start, budget, answer with ATRIS_AGENT_ID=human:... (no ATRIS_HUMAN=1) must never act as human.
  const spoofEnv = cleanEnv({ ATRIS_CAMPAIGN_DB: db, ATRIS_AGENT_ID: 'human:keshav' });
  const started = spawnSync(
    process.execPath,
    [CLI, 'campaign', 'start', 'Spoof test', '--judge', 'exit 1', '--budget', '10', '--id', 'cmp-spoof', '--json'],
    { cwd: dir, env: spoofEnv, encoding: 'utf8' },
  );
  assert.equal(started.status, 0, started.stderr);
  assert.equal(JSON.parse(started.stdout).campaign.created_from.includes('human:'), false);

  const asked = spawnSync(
    process.execPath,
    [CLI, 'campaign', 'ask', 'cmp-spoof', 'Ship to production?', '--json'],
    { cwd: dir, env: spoofEnv, encoding: 'utf8' },
  );
  assert.equal(asked.status, 0, asked.stderr);
  const askId = JSON.parse(asked.stdout).campaign.asks[0].id;

  for (const spoofId of ['human:keshav', 'Human:keshav']) {
    const env = cleanEnv({ ATRIS_CAMPAIGN_DB: db, ATRIS_AGENT_ID: spoofId });
    const badBudget = spawnSync(
      process.execPath,
      [CLI, 'campaign', 'budget', 'cmp-spoof', '--add', '50', '--json'],
      { cwd: dir, env, encoding: 'utf8' },
    );
    assert.equal(badBudget.status, 2, `${spoofId} budget: ${badBudget.stdout}`);
    assert.equal(JSON.parse(badBudget.stdout).ok, false);

    const badAnswer = spawnSync(
      process.execPath,
      [CLI, 'campaign', 'answer', 'cmp-spoof', askId, 'yes', '--json'],
      { cwd: dir, env, encoding: 'utf8' },
    );
    assert.equal(badAnswer.status, 2, `${spoofId} answer: ${badAnswer.stdout}`);
    assert.equal(JSON.parse(badAnswer.stdout).ok, false);
  }

  // 2. makeContext fails closed when an agent env is paired with a human actor.
  const memStore = createMemoryStore({ origin: 'laptop' });
  memStore.append({
    campaign_id: 'cmp-fc',
    type: 'campaign_started',
    actor: 'human:keshav',
    data: { title: 'Fail closed', judge: 'exit 1', budget: 10 },
  });
  const forged = await runCampaign(memStore, ['budget', 'cmp-fc', '--add', '100', '--json'], {
    actor: 'human:keshav',
    env: cleanEnv({ CLAUDECODE: '1' }),
  });
  assert.equal(forged.code, 2);
  assert.equal(JSON.parse(forged.out).ok, false);
  assert.equal(getCampaign(memStore, 'cmp-fc').budget.total, 10);

  // 3. MCP server sanitizes ATRIS_AGENT_ID=human:... so campaign_answer never closes the ask.
  const mcp = await import('../mcp/atris-mcp/index.mjs');
  const prevDb = process.env.ATRIS_CAMPAIGN_DB;
  const prevAgent = process.env.ATRIS_AGENT_ID;
  const prevHuman = process.env.ATRIS_HUMAN;
  process.env.ATRIS_CAMPAIGN_DB = db;
  process.env.ATRIS_AGENT_ID = 'human:keshav';
  process.env.ATRIS_HUMAN = '1';
  try {
    const res = await mcp.handleCampaignTool('campaign_answer', {
      id: 'cmp-spoof',
      ask_id: askId,
      answer: 'yes from spoofed mcp',
      cwd: dir,
    });
    const payload = JSON.parse(res.content[0].text);
    assert.equal(res.isError, true);
    assert.equal(payload.ok, false);
    assert.equal(payload.still_open, true);
  } finally {
    if (prevDb === undefined) delete process.env.ATRIS_CAMPAIGN_DB; else process.env.ATRIS_CAMPAIGN_DB = prevDb;
    if (prevAgent === undefined) delete process.env.ATRIS_AGENT_ID; else process.env.ATRIS_AGENT_ID = prevAgent;
    if (prevHuman === undefined) delete process.env.ATRIS_HUMAN; else process.env.ATRIS_HUMAN = prevHuman;
  }
});

// ------------------------------------------------ Audit Fix 2: OPENCODE_SESSION_ID marker parity

test('audit fix 2: every AGENT_ENV marker in campaign.js marks caller as agent in feed.viewerOf and OPENCODE_SESSION_ID works in task-core', () => {
  const campaignSrc = fs.readFileSync(path.resolve(__dirname, '..', 'commands', 'campaign.js'), 'utf8');
  const match = campaignSrc.match(/const AGENT_ENV = \[([\s\S]*?)\];/);
  assert.ok(match, 'AGENT_ENV array must exist in commands/campaign.js');
  const markers = [...match[1].matchAll(/'([A-Z0-9_]+)'/g)].map((m) => m[1]);
  assert.ok(markers.includes('OPENCODE_SESSION_ID'), 'campaign.js AGENT_ENV must include OPENCODE_SESSION_ID');

  for (const marker of markers) {
    const env = cleanEnv({ [marker]: '1' });
    const viewer = feed.viewerOf(env);
    assert.ok(viewer.agent, `feed.viewerOf must treat ${marker}=1 as an agent`);
  }

  const { workerEnvMarker } = require('../lib/task-core');
  assert.equal(workerEnvMarker(cleanEnv({ OPENCODE_SESSION_ID: 'oc-1' })), 'OPENCODE_SESSION_ID');
});

// ------------------------------------------------ Audit Fix 3: cmdEvent blocks judge_set

test('audit fix 3: campaign event rejects judge_set cleanly without altering view.judge', async () => {
  const store = createMemoryStore({ origin: 'laptop' });
  store.append({
    campaign_id: 'cmp-judge-guard',
    type: 'campaign_started',
    actor: 'human:keshav',
    data: { title: 'Judge guard', judge: 'npm test', budget: 10 },
  });

  const res = await runCampaign(
    store,
    ['event', 'cmp-judge-guard', 'judge_set', '--data', '{"judge":"true"}', '--json'],
    { actor: 'human:keshav' },
  );
  assert.equal(res.code, 2);
  const body = JSON.parse(res.out);
  assert.equal(body.ok, false);
  assert.match(body.error, /atris campaign set-judge/);
  assert.equal(getCampaign(store, 'cmp-judge-guard').judge, 'npm test');
});

// ------------------------------------------------ Audit Fix 4: stage='plan' feed approval clears hold & restores on launch failure

test('audit fix 4: approving a stage=plan task in feed clears heldForPerson and restores stage=plan on failed launch', (t) => {
  const { heldForPerson, isPlanAwaitingApproval } = require('../lib/member-task-pick');
  const ctx = project(t, ['scout', 'writer']);

  // 1. Happy path: approving clears stage=plan -> stage=do so member picker can claim it.
  const planId = tasks.addTask(ctx.db, {
    workspaceRoot: ctx.root,
    title: 'Approve the onboarding plan',
    status: 'open',
    metadata: { stage: 'plan', assigned_to: 'scout' },
  }).id;
  assert.equal(heldForPerson(tasks.getTask(ctx.db, planId)), 'plan_awaiting_approval');

  const card = feed.listCards(ctx.root, { filter: 'needs_decision', env: ctx.env }).cards
    .find((item) => item.source.id === planId);
  assert.ok(card, 'plan task card must appear in needs_decision');

  feed.decide(ctx.root, card.id, 'approve', { env: ctx.env, deps: ctx.deps });
  const freshRow = tasks.getTask(ctx.db, planId);
  assert.equal(freshRow.metadata.stage, 'do');
  assert.ok(freshRow.metadata.plan_approved_at, 'plan_approved_at must be stamped');
  assert.equal(isPlanAwaitingApproval(freshRow), false);
  assert.equal(heldForPerson(freshRow), '');

  // 2. Rollback path: if the launch fails, returnToWaiting restores stage='plan' and clears plan_approved_at.
  const failId = tasks.addTask(ctx.db, {
    workspaceRoot: ctx.root,
    title: 'Approve the backup rollout plan',
    status: 'open',
    metadata: { stage: 'plan', assigned_to: 'writer' },
  }).id;
  const failCard = feed.listCards(ctx.root, { filter: 'needs_decision', env: ctx.env }).cards
    .find((item) => item.source.id === failId);
  assert.ok(failCard);

  const failingDeps = {
    ...ctx.deps,
    spawnRunner: () => { throw new Error('spawn failed'); },
  };
  const failedResult = feed.decide(ctx.root, failCard.id, 'approve', { env: ctx.env, deps: failingDeps });
  assert.equal(failedResult.outcome.reason, 'enqueue_failed');
  const rolledBack = tasks.getTask(ctx.db, failId);
  assert.equal(rolledBack.metadata.stage, 'plan');
  assert.equal(rolledBack.metadata.plan_approved_at, undefined);
  assert.equal(heldForPerson(rolledBack), 'plan_awaiting_approval');
});

// ------------------------------------------------ Audit Fix 10: feed-room post-answer race & element-inspect cloud sync

test('audit fix 10a: room.replySynced succeeds cleanly if social.json races with same_reply or feedEpoch after cloud answer', async (t) => {
  const ctx = feedCampaignProject(t);
  let onAnswerHook = null;
  const events = [];
  let seq = 0;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      const send = (status, body) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      const match = url.pathname.match(/^\/api\/campaigns\/([^/]+)\/(events|asks\/([^/]+)\/answer)$/);
      if (!match) return send(404, { ok: false, error: 'no route' });
      const campaignId = decodeURIComponent(match[1]);
      const body = raw ? JSON.parse(raw) : {};
      if (match[2] === 'events' && req.method === 'GET') {
        const after = Number(url.searchParams.get('after')) || 0;
        const page = events.map((e, i) => ({ e, seq: i + 1 })).filter((x) => x.e.campaign_id === campaignId && x.seq > after);
        return send(200, { ok: true, events: page.map((x) => x.e), last_event_seq: page.length ? page[page.length - 1].seq : after });
      }
      if (match[2] === 'events' && req.method === 'POST') {
        for (const ev of body.events || []) if (!events.some((e) => e.id === ev.id)) events.push(ev);
        return send(200, { ok: true, accepted: (body.events || []).length, duplicates: 0, last_event_seq: events.length });
      }
      if (match[3]) {
        seq += 1;
        events.push({
          id: `evt-race-${seq}`,
          campaign_id: campaignId,
          type: 'ask_answered',
          at: new Date(Date.now() + 1000).toISOString(),
          origin: 'cloud',
          seq,
          actor: 'human:cloud',
          data: { ask_id: decodeURIComponent(match[3]), answer: body.answer },
        });
        if (onAnswerHook) onAnswerHook();
        return send(200, { ok: true });
      }
      return send(404, { ok: false });
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const cloudUrl = `http://127.0.0.1:${server.address().port}/api`;
  const savedUrl = process.env.ATRIS_API_URL;
  process.env.ATRIS_API_URL = cloudUrl;
  t.after(async () => {
    if (savedUrl === undefined) delete process.env.ATRIS_API_URL; else process.env.ATRIS_API_URL = savedUrl;
    await new Promise((done) => server.close(done));
  });

  const cloudDeps = { loadCredentials: () => ({ token: 'test-token' }) };
  ctx.store.append({
    campaign_id: 'cmp-race',
    type: 'campaign_started',
    actor: 'human:keshav',
    data: { title: 'Race test', judge: 'exit 1', budget: 20, owner: 'mission-lead' },
  });
  ctx.store.append({
    campaign_id: 'cmp-race',
    type: 'ask_opened',
    actor: 'mission-lead',
    data: { ask_id: 'a-dup', question: 'Allow duplicate race?' },
  });
  ctx.store.append({
    campaign_id: 'cmp-race',
    type: 'ask_opened',
    actor: 'mission-lead',
    data: { ask_id: 'a-clr', question: 'Allow clear race?' },
  });
  assert.equal((await syncCampaign(ctx.store, 'cmp-race', cloudDeps)).ok, true);

  // Race 1: another writer writes the exact same reply to social.json while the cloud answer is in flight.
  const dupCardId = 'campaign:cmp-race:ask:a-dup';
  onAnswerHook = () => {
    room._updateEntry(ctx.root, dupCardId, (entry) => {
      entry.replies.push({ id: 'race00000001', by: 'user:owner', text: 'Ship it now.', at: new Date().toISOString() });
    });
  };
  const dupRes = await room.replySynced(ctx.root, dupCardId, 'Ship it now.', {
    env: ctx.env,
    deps: { ...ctx.deps, cloud: cloudDeps },
  });
  assert.equal(dupRes.answered, true);
  assert.equal(dupRes.via, 'cloud');
  assert.equal(dupRes.reply.id, 'race00000001');

  // Race 2: the feed is cleared while the cloud answer is in flight (feedEpoch changes).
  const clrCardId = 'campaign:cmp-race:ask:a-clr';
  const beforeEpoch = room.clearedAt(ctx.root);
  onAnswerHook = () => {
    room.clear(ctx.root, { env: ctx.env, confirmed: true });
  };
  const clrRes = await room.replySynced(ctx.root, clrCardId, 'Approved after clear.', {
    env: ctx.env,
    feedEpoch: beforeEpoch,
    deps: { ...ctx.deps, cloud: cloudDeps },
  });
  assert.equal(clrRes.answered, true);
  assert.equal(clrRes.via, 'cloud');
  assert.deepEqual(getCampaign(ctx.store, 'cmp-race').asks, []);
});

test('audit fix 10b: element-inspect POST /api/reply syncs campaign ask answers to the cloud', async (t) => {
  const ctx = feedCampaignProject(t);
  const cloud = await fakeCampaignCloud();
  const savedUrl = process.env.ATRIS_API_URL;
  process.env.ATRIS_API_URL = cloud.url;
  t.after(async () => {
    if (savedUrl === undefined) delete process.env.ATRIS_API_URL; else process.env.ATRIS_API_URL = savedUrl;
    await cloud.close();
  });

  const cloudDeps = { loadCredentials: () => ({ token: 'test-token' }) };
  ctx.store.append({
    campaign_id: 'cmp-web-reply',
    type: 'campaign_started',
    actor: 'human:keshav',
    data: { title: 'Web reply sync', judge: 'exit 1', budget: 20, owner: 'mission-lead' },
  });
  ctx.store.append({
    campaign_id: 'cmp-web-reply',
    type: 'ask_opened',
    actor: 'mission-lead',
    data: { ask_id: 'a-web', question: 'Publish release notes?' },
  });
  assert.equal((await syncCampaign(ctx.store, 'cmp-web-reply', cloudDeps)).ok, true);

  const inspect = require('../lib/element-inspect');
  const srv = await inspect.startInspector(ctx.root, {
    port: 0,
    host: '127.0.0.1',
    env: ctx.env,
    deps: { ...ctx.deps, cloud: cloudDeps },
  });
  t.after(() => srv.close());

  const res = await fetch(`${srv.url}/api/reply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: srv.url },
    body: JSON.stringify({ card_id: 'campaign:cmp-web-reply:ask:a-web', text: 'Yes, publish them.' }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.answered, true);
  assert.equal(body.via, 'cloud');
  assert.ok(cloud.requests.some((r) => r.path === '/api/campaigns/cmp-web-reply/asks/a-web/answer'));
  assert.deepEqual(getCampaign(ctx.store, 'cmp-web-reply').asks, []);
});
