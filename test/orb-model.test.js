'use strict';

// The model the orb thinks with: what is offered, how a pick is saved and
// checked, the order the orb asks in, the model card, and the /model address.
// Every tool here is a fake (a stubbed login check, or a script on a fake
// PATH), so no test reaches a real model.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'orb-model-home-'));
process.env.HOME = HOME;
process.env.ATRIS_HOME = path.join(HOME, '.atris');
delete process.env.ATRIS_TOKEN;

const orbModel = require('../lib/orb-model');
const gmBet = require('../lib/gm-bet');
const gmCard = require('../lib/gm-card');
const phone = require('../lib/gm-phone');

const ws = () => fs.mkdtempSync(path.join(os.tmpdir(), 'orb-model-ws-'));

// claude and codex here, signed in; grok and devin too, but devin with no
// subscription login and grok never offered
const TOOLS = [
  { engine: 'claude', bin: 'claude', models: [] },
  { engine: 'codex', bin: 'codex', models: ['codex'] },
  { engine: 'devin', bin: 'devin', models: ['built-in router'] },
];
const LOGINS = {
  claude: { status: 0, stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }) },
  codex: { status: 0, stdout: 'Logged in using ChatGPT\n' },
  devin: { status: 1, stdout: 'Not logged in\n' },
};
const MODELS = engines => engines.map(e => (e.id === 'codex'
  ? { engine: 'codex', models: ['gpt-6.1-sol', 'gpt-5.6-sol', 'gpt-5.6-terra', 'codex-auto-review'] }
  : { engine: 'claude', models: ['opus 5.5', 'sonnet 5.5', 'haiku 5.5'] }));
function opts(over = {}) {
  const ran = [];
  return {
    ran,
    tools: TOOLS,
    fresh: true,
    availableModels: MODELS,
    run: async (bin, args) => { ran.push([bin, ...args].join(' ')); return LOGINS[bin] || { status: 127, stdout: '' }; },
    ...over,
  };
}

test('no pick saved: the orb thinks on claude opus, as it always has, and nothing is written', async () => {
  const root = ws();
  assert.deepEqual(orbModel.readPick(root), { engine: 'claude', model: 'opus' });
  assert.equal(orbModel.leadFor(root), null);
  assert.equal(orbModel.pickLabel(root), 'opus');
  const s = await orbModel.offer(root, opts());
  assert.equal(s.saved, null);
  assert.equal(s.line, null);
  assert.equal(fs.existsSync(orbModel.orbModelFile(root)), false);
  // the lineup is the one it always was
  const list = [{ id: 'claude', lead: true }, { id: 'codex', lead: false }];
  assert.deepEqual(gmBet.thinkerOrder(root, list), list);
});

test('the list: every model on every signed-in tool, by tool, from each tool\'s own models; never grok, never an api key login', async () => {
  const root = ws();
  const o = opts();
  const s = await orbModel.offer(root, o);
  assert.deepEqual(s.groups.map(g => g.label), ['claude', 'codex'], 'devin is not signed in, so it is not offered');
  const claude = s.groups[0].models.map(m => m.model);
  assert.deepEqual(claude, ['opus', 'sonnet', 'haiku', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']);
  const codex = s.groups[1].models.map(m => m.model);
  assert.deepEqual(codex, ['', 'gpt-6.1-sol', 'gpt-5.6-sol', 'gpt-5.6-terra'], 'codex\'s own list, without its review model');
  assert.equal(s.groups[0].models[0].current, true, 'opus is marked');
  // each tool's own status command, run once each, at the same time
  assert.deepEqual(o.ran.sort(), ['claude auth status', 'codex login status', 'devin auth status']);
  // a claude login by api key, or codex by api key, is not a subscription
  const keyed = await orbModel.offer(root, opts({ run: async bin => (bin === 'claude' ? { status: 0, stdout: JSON.stringify({ loggedIn: true, authMethod: 'api_key' }) } : { status: 0, stdout: 'Logged in using an API key - sk-***\n' }) }));
  assert.deepEqual(keyed.groups, []);
  // grok is never a tool the orb offers, whatever the registry says
  const reg = {
    readEngineRegistry: () => ({ engines: [{ id: 'grok', bin: 'grok', installed: true, models: ['grok 4.7'] }, { id: 'claude', bin: 'claude', installed: true }, { id: 'atris-fast', bin: 'ax', installed: true }, { id: 'commandcode', bin: 'cmd', installed: true }] }),
    engineHosted: e => e.id === 'atris-fast',
    binInstalled: () => true,
  };
  assert.deepEqual(orbModel.localTools(root, { registry: reg }).map(t => t.engine), ['claude'], 'no grok, no hosted tool, no tool atris cannot check a login for');
  // and no model named grok on another tool either
  const cursor = orbModel.toolModels({ engine: 'cursor', models: ['composer 2.5', 'grok 4.6'] }, {});
  assert.deepEqual(cursor.map(m => m.model), ['', 'composer 2.5']);
  // the login checks never see an api key
  const env = orbModel.keylessEnv({ ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'b', CODEX_API_KEY: 'c', PATH: '/bin' });
  assert.deepEqual(env, { PATH: '/bin' });
});

test('a pick is saved per workspace, survives a fresh read, and must be on the list', async () => {
  const root = ws();
  const other = ws();
  const o = opts();
  const out = await orbModel.setPick(root, 'terra', o);
  assert.equal(out.ok, true, out.message);
  assert.deepEqual([out.engine, out.model], ['codex', 'gpt-5.6-terra']);
  assert.match(out.line, /^the orb thinks with codex gpt-5\.6-terra now\./);
  // a new process reads the file: same pick
  const saved = JSON.parse(fs.readFileSync(orbModel.orbModelFile(root), 'utf8'));
  assert.equal(saved.schema, 'atris.orb_model.v1');
  assert.deepEqual([saved.engine, saved.model], ['codex', 'gpt-5.6-terra']);
  delete require.cache[require.resolve('../lib/orb-model')];
  assert.deepEqual(require('../lib/orb-model').leadFor(root), { engine: 'codex', model: 'gpt-5.6-terra' });
  // another workspace is untouched
  assert.equal(orbModel.leadFor(other), null);
  // the other ways to say a model
  for (const [words, engine, model] of [['codex gpt-5.6-sol', 'codex', 'gpt-5.6-sol'], ['claude sonnet', 'claude', 'sonnet'], ['opus 5.5', 'claude', 'claude-opus-5-5'], ['codex', 'codex', ''], ['haiku', 'claude', 'haiku']]) {
    const r = await orbModel.setPick(root, words, o);
    assert.equal(r.ok, true, `${words}: ${r.message}`);
    assert.deepEqual(orbModel.leadFor(root), { engine, model }, words);
  }
  // refused, and nothing changes: a model not offered, grok, a tool not signed in, words that name nothing
  for (const words of ['grok', 'claude grok', 'devin', 'codex gpt-9', 'gpt-oss', '', 'cursor composer 2.5']) {
    const r = await orbModel.setPick(root, words, o);
    assert.equal(r.ok, false, words);
    assert.match(r.message, /nothing changed/);
    assert.deepEqual(orbModel.leadFor(root), { engine: 'claude', model: 'haiku' }, words);
  }
  // a pair from the page must match a listed pair exactly
  assert.equal((await orbModel.setPick(root, { engine: 'codex', model: 'gpt-5.6-terra' }, o)).ok, true);
  assert.equal((await orbModel.setPick(root, { engine: 'grok', model: 'grok 4.7' }, o)).ok, false);
  // a file edited by hand to name grok counts as no pick
  fs.writeFileSync(orbModel.orbModelFile(root), JSON.stringify({ engine: 'grok', model: 'grok 4.7' }));
  assert.equal(orbModel.leadFor(root), null);
});

test('a saved pick whose tool is not signed in here: the list says which model thinks instead, in plain words', async () => {
  const root = ws();
  await orbModel.setPick(root, 'terra', opts());
  const gone = await orbModel.offer(root, opts({ run: async bin => (bin === 'codex' ? { status: 1, stdout: 'Not logged in\n' } : LOGINS[bin]) }));
  assert.deepEqual(gone.groups.map(g => g.label), ['claude']);
  assert.equal(gone.line, 'codex gpt-5.6-terra is not signed in on this computer, so the orb thinks with claude opus until it is.');
  assert.deepEqual(gone.lead, { engine: 'claude', model: 'opus', label: 'opus' });
  const card = gmCard.thinker({ id: 'thinker~1', groups: gone.groups, line: gone.line });
  assert.deepEqual(gmCard.cardProblems(card), []);
  assert.equal(card.line, gone.line);
});

// ---- the order the orb asks in ---------------------------------------------------------------

test('the pick goes first on its own model; the rest keep their order, so the fallback is unchanged', () => {
  const root = ws();
  const list = [{ id: 'claude', lead: true }, { id: 'codex', lead: false }, { id: 'cursor', lead: false }];
  orbModel.writePick(root, { engine: 'codex', model: 'gpt-5.6-terra' });
  assert.deepEqual(gmBet.thinkerOrder(root, list), [{ id: 'codex', lead: false, model: 'gpt-5.6-terra' }, { id: 'claude', lead: true }, { id: 'cursor', lead: false }]);
  orbModel.writePick(root, { engine: 'claude', model: 'sonnet' });
  assert.deepEqual(gmBet.thinkerOrder(root, list), [{ id: 'claude', lead: true, model: 'sonnet' }, { id: 'codex', lead: false }, { id: 'cursor', lead: false }]);
  // a pick whose tool is not in the lineup here: the lineup as it is
  orbModel.writePick(root, { engine: 'devin', model: '' });
  assert.deepEqual(gmBet.thinkerOrder(root, list), list);
  // the claude command takes the pick's model in place of opus, and nothing else changes
  const cmd = gmBet.withModel(gmBet.writerCommand(), 'sonnet');
  const args = cmd.args('hi');
  assert.equal(args[args.indexOf('--model') + 1], 'sonnet');
  assert.deepEqual(args.filter((_, i) => i !== args.indexOf('--model') + 1), gmBet.writerCommand().args('hi').filter((a, i, all) => i !== all.indexOf('--model') + 1));
});

// A folder that stands in for PATH, with fake claude and codex that write
// what they were asked to calls.jsonl.
function fakeTools({ codex = 'ok', claude = 'ok' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orb-model-bin-'));
  const write = (name, mode) => {
    const stream = name === 'claude';
    fs.writeFileSync(path.join(dir, name), `#!${process.execPath}
const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(path.join(dir, 'calls.jsonl'))}, JSON.stringify({ tool: ${JSON.stringify(name)}, args, key: process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY || null }) + '\\n');
if (${JSON.stringify(mode)} === 'fail') { process.stderr.write('not signed in\\n'); process.exit(1); }
const text = '{"kind": "question", "reply": "answered by ${name}"}';
if (${stream}) {
  process.stdout.write(JSON.stringify({ type: 'stream_event', event: { type: 'message_start' } }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'result', result: text }) + '\\n');
} else process.stdout.write(text + '\\n');
`);
    fs.chmodSync(path.join(dir, name), 0o755);
  };
  write('claude', claude);
  write('codex', codex);
  const calls = () => (fs.existsSync(path.join(dir, 'calls.jsonl')) ? fs.readFileSync(path.join(dir, 'calls.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)) : []);
  return { dir, calls };
}

async function withPath(dir, fn) {
  const before = { PATH: process.env.PATH, OPENAI_API_KEY: process.env.OPENAI_API_KEY, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY };
  process.env.PATH = `${dir}${path.delimiter}/bin`;
  process.env.OPENAI_API_KEY = 'sk-should-never-reach-a-model';
  process.env.ANTHROPIC_API_KEY = 'sk-ant-should-never-reach-a-model';
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(before)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

const READ_CARD = { kind: 'idea', title: 'an idea', detail: 'why it matters', buttons: ['do it', 'sharpen it', 'not now'] };

test('picked terra: a real read goes to codex with that model, read-only, with no api key', async () => {
  const root = ws();
  orbModel.writePick(root, { engine: 'codex', model: 'gpt-5.6-terra' });
  const t = fakeTools();
  await withPath(t.dir, async () => {
    gmBet.forgetThinkers(root);
    const r = await gmBet.readSaid({ text: 'what do you mean?', card: READ_CARD, workspaceRoot: root, deps: { readerModel: () => 'haiku' } });
    assert.deepEqual(r, { ok: true, kind: 'question', reply: 'answered by codex' });
  });
  const calls = t.calls();
  assert.equal(calls.length, 1, JSON.stringify(calls));
  assert.equal(calls[0].tool, 'codex');
  const args = calls[0].args;
  assert.equal(args[args.indexOf('-m') + 1], 'gpt-5.6-terra');
  assert.ok(args.includes('read-only'));
  // no shell for it to look around with: every fact is in the prompt
  assert.ok(args.includes('features.shell_tool=false') && args.includes('features.shell_snapshot=false'));
  assert.match(args[args.length - 1], /Everything you need is in this message\. Do not run any command/);
  assert.equal(calls[0].key, null, 'no api key in its environment');
});

test('picked terra, codex fails: claude answers the same call, and codex sits out the next one', async () => {
  const root = ws();
  orbModel.writePick(root, { engine: 'codex', model: 'gpt-5.6-terra' });
  const t = fakeTools({ codex: 'fail' });
  await withPath(t.dir, async () => {
    gmBet.forgetThinkers(root);
    const r = await gmBet.readSaid({ text: 'what do you mean?', card: READ_CARD, workspaceRoot: root, deps: { readerModel: () => 'haiku' } });
    assert.deepEqual(r, { ok: true, kind: 'question', reply: 'answered by claude' });
    const again = await gmBet.readSaid({ text: 'and why?', card: READ_CARD, workspaceRoot: root, deps: { readerModel: () => 'haiku' } });
    assert.equal(again.reply, 'answered by claude');
  });
  assert.deepEqual(t.calls().map(c => c.tool), ['codex', 'claude', 'claude']);
  // a quick read keeps claude's fast model; the claude call carries no api key
  const claudeArgs = t.calls()[1].args;
  assert.equal(claudeArgs[claudeArgs.indexOf('--model') + 1], 'haiku');
  assert.equal(t.calls()[1].key, null);
});

test('picked claude sonnet: the orb\'s own calls run on sonnet; quick reads keep their fast model', async () => {
  const root = ws();
  orbModel.writePick(root, { engine: 'claude', model: 'sonnet' });
  const t = fakeTools();
  await withPath(t.dir, async () => {
    gmBet.forgetThinkers(root);
    await gmBet.readSaid({ text: 'what do you mean?', card: READ_CARD, workspaceRoot: root, deps: { readerModel: () => 'haiku' } });
    const out = await gmBet.generateScoreboardChoices({ workspaceRoot: root, bundle: { sources: {}, facts: [] }, deps: { readContext: () => 'a shop' } }).catch(err => ({ err }));
    assert.ok(out, 'it ran');
  });
  const models = t.calls().filter(c => c.tool === 'claude').map(c => c.args[c.args.indexOf('--model') + 1]);
  assert.deepEqual(models, ['haiku', 'sonnet']);
});

// ---- the model card on the desk ---------------------------------------------------------------

function deskWith(root, stub) {
  const ledgerFile = path.join(root, 'state', 'gm-bets.jsonl');
  fs.mkdirSync(path.dirname(ledgerFile), { recursive: true });
  const logged = [];
  const d = gmBet.createBetDesk({
    workspaceRoot: root,
    ledgerFile,
    attemptsFile: path.join(root, 'state', 'attempts.jsonl'),
    now: () => Date.now(),
    warmOnCreate: false,
    choices: false,
    generate: () => new Promise(() => {}),
    readSaid: async () => ({ ok: false }),
    generateQuestion: () => new Promise(() => {}),
    suggestScoreboard: () => new Promise(() => {}),
    readMissions: () => ({}),
    readHandoffs: () => [],
    runCli: async () => ({ code: 0, stdout: '{}', stderr: '' }),
    wakeThinkers: () => { logged.push('woke'); },
    log: row => logged.push(row),
    orbModel: stub,
  });
  return { d, logged };
}

const stubOf = o => ({
  offer: r => orbModel.offer(r, o),
  setPick: (r, w) => orbModel.setPick(r, w, o),
  pickLabel: r => orbModel.pickLabel(r),
});

test('the model card: opened from the team, a tap switches, the team comes back with one line and the new model in its link', async () => {
  const root = ws();
  const { d, logged } = deskWith(root, stubOf(opts()));
  const team = (await d.act({ open: 'team', card_id: null })).body.card;
  const link = team.options.find(o => o.action === 'thinker');
  assert.equal(link.label, 'the orb thinks with opus');
  const opened = await d.act({ card_id: team.id, option_id: link.id });
  assert.equal(opened.status, 200);
  const card = opened.body.card;
  assert.equal(card.kind, 'thinker');
  assert.equal(card.title, 'the model the orb thinks with');
  assert.match(card.body, /^now: claude opus\./);
  const terra = card.options.find(o => o.label === 'gpt-5.6-terra');
  assert.equal(terra.group, 'codex');
  assert.deepEqual(terra.binds, { engine: 'codex', model: 'gpt-5.6-terra' });
  assert.equal(card.options.find(o => o.chosen).label, 'opus');
  assert.ok(!card.options.some(o => /grok/.test(o.label)));
  // the card on screen takes only its own options: a forged pick is refused, and nothing is saved
  const forged = await d.act({ card_id: card.id, option_id: 'p-grok' });
  assert.equal(forged.body.reason, 'bad_option');
  assert.equal(orbModel.leadFor(root), null);
  const picked = await d.act({ card_id: card.id, option_id: terra.id });
  assert.equal(picked.status, 200, JSON.stringify(picked.body));
  assert.equal(picked.body.card.kind, 'team');
  assert.equal(picked.body.card.line, 'the orb thinks with codex gpt-5.6-terra now. if it does not answer, the next model signed in here does.');
  assert.equal(picked.body.card.options.find(o => o.action === 'thinker').label, 'the orb thinks with gpt-5.6-terra');
  assert.deepEqual(orbModel.leadFor(root), { engine: 'codex', model: 'gpt-5.6-terra' });
  assert.ok(logged.includes('woke'), 'the lineup is read fresh for the next call');
  assert.ok(logged.some(r => r && r.choice === 'orb_model' && r.exit_code === 0));
  // the model card's way back is the team
  const again = (await d.act({ card_id: picked.body.card.id, option_id: 'thinker' })).body.card;
  assert.equal(again.options.find(o => o.chosen).label, 'gpt-5.6-terra');
  const back = await d.act({ card_id: again.id, option_id: 'back' });
  assert.equal(back.body.card.kind, 'team');
});

// ---- the /model address -----------------------------------------------------------------------

test('/model: the link key and the page\'s own origin are required; a post sets only a listed model', async () => {
  const root = ws();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orb-model-srv-'));
  const TOKEN = 'a'.repeat(43);
  const hosts = [];
  const o = opts();
  const handler = phone.createPhoneHandler({
    workspaceRoot: root,
    token: TOKEN,
    hosts,
    loadView: () => ({ roster: [], reviews: [], stuck: [], outcomes: [], last_plays: [] }),
    runStep: async () => ({ code: 0 }),
    writeTarget: () => true,
    snapshotTarget: () => () => true,
    logPath: path.join(dir, 'log.jsonl'),
    page: () => '',
    orbModel: { publicStatus: r => orbModel.publicStatus(r, o), setPick: (r, w) => orbModel.setPick(r, w, o) },
  });
  const server = http.createServer((q, s) => { handler(q, s).catch(() => { s.writeHead(500); s.end(); }); });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `127.0.0.1:${server.address().port}`;
  hosts.push(base);
  const call = async (method, body, { token = TOKEN, origin = `http://${base}` } = {}) => {
    const headers = {};
    if (token) headers['x-gm-token'] = token;
    if (origin) headers.origin = origin;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(`http://${base}/model`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  try {
    assert.equal((await call('GET', undefined, { token: null })).status, 403);
    assert.equal((await call('GET', undefined, { token: 'b'.repeat(43) })).status, 403);
    assert.equal((await call('POST', { pick: 'terra' }, { token: null })).status, 403);
    assert.equal((await call('POST', { pick: 'terra' }, { origin: 'http://evil.example' })).status, 403);
    assert.equal(orbModel.leadFor(root), null, 'nothing was set');
    const got = await call('GET');
    assert.equal(got.status, 200);
    assert.deepEqual(got.json.pick, { engine: 'claude', model: 'opus' });
    assert.deepEqual(got.json.groups.map(g => g.label), ['claude', 'codex']);
    assert.equal((await call('POST', { engine: 'grok', model: 'grok 4.7' })).status, 409);
    assert.equal((await call('POST', { pick: 'codex gpt-9' })).status, 409);
    assert.equal((await call('POST', [])).status, 400);
    assert.equal(orbModel.leadFor(root), null, 'nothing was set');
    const set = await call('POST', { engine: 'codex', model: 'gpt-5.6-terra' });
    assert.equal(set.status, 200, JSON.stringify(set.json));
    assert.deepEqual(set.json.pick, { engine: 'codex', model: 'gpt-5.6-terra' });
    assert.deepEqual(orbModel.leadFor(root), { engine: 'codex', model: 'gpt-5.6-terra' });
  } finally {
    server.closeAllConnections();
    await new Promise(r => server.close(r));
  }
});

test('a login check that runs out of time on a busy computer keeps the last answer; with none, the tool is not offered', async () => {
  orbModel.forgetSignedIn();
  const slow = async () => ({ status: 1, stdout: '', timed_out: true });
  assert.equal(await orbModel.signedIn('cursor', 'cursor-agent', { run: slow, fresh: true }), false);
  assert.equal(await orbModel.signedIn('cursor', 'cursor-agent', { run: async () => ({ status: 0, stdout: 'Logged in as someone\n' }), fresh: true }), true);
  assert.equal(await orbModel.signedIn('cursor', 'cursor-agent', { run: slow, fresh: true }), true);
  assert.equal(await orbModel.signedIn('cursor', 'cursor-agent', { run: async () => ({ status: 1, stdout: 'Not logged in\n' }), fresh: true }), false);
  orbModel.forgetSignedIn();
});
