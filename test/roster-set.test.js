'use strict';

// Swapping a model: `atris engine roster set` and the phone's engine card
// run the same code (lib/roster-swap.js). Every test gets a scratch HOME
// with its own ~/.atris/ROSTER.md fixture; the real one is never read.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawnSync } = require('node:child_process');

const CLI = path.join(__dirname, '..', 'bin', 'atris.js');
const NOW = new Date(2026, 9, 21, 12, 0, 0).getTime();
const TOKEN = 'k'.repeat(43);

const ROSTER = `# roster

> a note the person wrote

## build
- claude code, model: opus 5.5, max: 45 min

## review
- codex, model: gpt-6.1-sol, effort: medium
- claude code, model: opus 5.5

## team
- researcher: claude code, model: haiku 5.5
`;

const ENV_KEYS = [
  'HOME', 'ATRIS_MACHINE_ROSTER_PATH', 'ATRIS_MACHINE_ROSTER_MD_PATH', 'ATRIS_ROSTER_SESSION', 'ATRIS_ROSTER_SESSIONS_DIR',
  'ATRIS_CODEX_MODELS_CACHE_PATH', 'ATRIS_CODEX_CONFIG_PATH', 'ATRIS_RUNNER_PROFILE', 'ATRIS_RUNNER_MODEL', 'ATRIS_ROUTER_EXPLAIN',
];

// A workspace with a builder card, claude and codex marked ready in its own
// registry file, a codex models cache, and the fixture roster in a scratch
// HOME. Env changes are undone after.
function withRoom(fn, { ready = ['claude', 'codex'] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-roster-set-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-roster-set-home-'));
  const saved = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  const rosterFile = path.join(home, '.atris', 'ROSTER.md');
  const cache = path.join(home, '.codex', 'models_cache.json');
  fs.mkdirSync(path.dirname(rosterFile), { recursive: true });
  fs.mkdirSync(path.dirname(cache), { recursive: true });
  fs.writeFileSync(rosterFile, ROSTER);
  fs.writeFileSync(cache, JSON.stringify({ models: [{ slug: 'gpt-6.1-sol' }, { slug: 'gpt-6-astra' }] }));
  for (const name of ['builder', 'researcher']) {
    fs.mkdirSync(path.join(root, 'atris', 'team', name), { recursive: true });
    fs.writeFileSync(path.join(root, 'atris', 'team', name, 'MEMBER.md'), `---\nname: ${name}\nrole: ${name}\n---\n`);
  }
  const checked = new Date().toISOString();
  const ids = Object.keys(require('../lib/runner-command').RUNNER_PROFILE_DEFS);
  const engines = ids.map((id) => (ready.includes(id)
    ? { id, health: { status: 'ready', checked_at: checked } }
    : { id, installed: false, health: { status: 'not_installed', checked_at: checked } }));
  fs.mkdirSync(path.join(root, '.atris', 'state'), { recursive: true });
  fs.writeFileSync(path.join(root, '.atris', 'state', 'engines.json'), `${JSON.stringify({ engines })}\n`);
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.HOME = home;
  process.env.ATRIS_MACHINE_ROSTER_MD_PATH = rosterFile;
  process.env.ATRIS_CODEX_MODELS_CACHE_PATH = cache;
  process.env.ATRIS_ROUTER_EXPLAIN = '0';
  const env = { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1', NO_COLOR: '1' };
  const cli = (...args) => {
    const res = spawnSync(process.execPath, [CLI, 'engine', 'roster', 'set', ...args], { cwd: root, env, encoding: 'utf8' });
    return { exit: res.status, out: res.stdout.trim(), err: res.stderr.trim() };
  };
  const done = () => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  };
  let out;
  try {
    out = fn({ root, home, rosterFile, cli, text: () => fs.readFileSync(rosterFile, 'utf8') });
  } catch (err) {
    done();
    throw err;
  }
  if (out && typeof out.then === 'function') return out.finally(done);
  done();
  return out;
}

function section(text, heading) {
  const lines = text.split('\n');
  const start = lines.indexOf(`## ${heading}`);
  const out = [];
  for (let i = start + 1; i < lines.length && !lines[i].startsWith('## '); i += 1) if (lines[i].trim()) out.push(lines[i]);
  return out;
}

// --- the CLI ---------------------------------------------------------------------

test('roster set swaps the lead, keeps the old lead as the first backup, and says so in one line', () => withRoom(({ cli, text }) => {
  const res = cli('build', 'codex', 'gpt-6.1-sol');
  assert.equal(res.exit, 0, res.err);
  assert.equal(res.out, 'build now runs on codex gpt-6.1-sol. claude opus 5.5 is the backup.');
  // the new lead carries the job's time limit; the old lead stays below it as written
  assert.deepEqual(section(text(), 'build'), [
    '- codex, model: gpt-6.1-sol, max: 45 min',
    '- claude code, model: opus 5.5, max: 45 min',
  ]);
  // every other line stays byte for byte
  assert.match(text(), /^> a note the person wrote$/m);
  assert.deepEqual(section(text(), 'review'), ['- codex, model: gpt-6.1-sol, effort: medium', '- claude code, model: opus 5.5']);
  assert.deepEqual(section(text(), 'team'), ['- researcher: claude code, model: haiku 5.5']);
}));

test('roster set takes a multi-word model and moves an existing backup up as written', () => withRoom(({ cli, text }) => {
  const res = cli('review', 'claude', 'opus', '5.5');
  assert.equal(res.exit, 0, res.err);
  assert.equal(res.out, 'review now runs on claude opus 5.5. codex gpt-6.1-sol is the backup.');
  assert.deepEqual(section(text(), 'review'), ['- claude code, model: opus 5.5', '- codex, model: gpt-6.1-sol, effort: medium']);
  const again = cli('review', 'claude', 'opus', '5.5');
  assert.equal(again.exit, 0, again.err);
  assert.equal(again.out, 'review already runs on claude opus 5.5.');
}));

test('roster set refuses a model this machine does not offer, with the valid list, and writes nothing', () => withRoom(({ cli, text }) => {
  const before = text();
  const res = cli('build', 'codex', 'gpt-made-up');
  assert.equal(res.exit, 2);
  assert.equal(res.err, 'codex has no model "gpt-made-up" on this machine. pick one of: gpt-6.1-sol, gpt-6-astra');
  assert.equal(text(), before);
}));

test('roster set refuses a tool that is not on this machine, with the tools that are', () => withRoom(({ cli, text }) => {
  const before = text();
  const res = cli('build', 'devin', 'swe-2-max');
  assert.equal(res.exit, 2);
  assert.match(res.err, /^devin is not on this machine\. pick one of: /);
  assert.match(res.err, /claude code/);
  assert.match(res.err, /codex/);
  assert.equal(text(), before);
  assert.equal(cli('build').exit, 2);
}));

test('roster set --member writes that member its own team line, leaving the job alone', () => withRoom(({ cli, text }) => {
  const res = cli('--member', 'builder', 'codex', 'gpt-6-astra');
  assert.equal(res.exit, 0, res.err);
  assert.equal(res.out, 'builder now runs on codex gpt-6-astra. every other build job stays on claude opus 5.5.');
  assert.deepEqual(section(text(), 'team'), ['- researcher: claude code, model: haiku 5.5', '- builder: codex, model: gpt-6-astra']);
  assert.deepEqual(section(text(), 'build'), ['- claude code, model: opus 5.5, max: 45 min']);
  // a swap of a member that has a line changes it in place, and the old lead backs it up
  assert.equal(cli('--member', 'researcher', 'claude', 'opus', '5.5').exit, 0);
  assert.deepEqual(section(text(), 'team'), ['- researcher: claude code, model: opus 5.5, backup claude code haiku 5.5', '- builder: codex, model: gpt-6-astra']);
  assert.equal(cli('--member', 'nobody', 'codex', 'gpt-6-astra').exit, 2);
}));

test('a member swap changes only the lead: backups, limits, until, and notes stay, and the old lead backs up first', () => withRoom(({ root, rosterFile, cli, text }) => {
  fs.writeFileSync(rosterFile, ROSTER.replace('## team\n', '## team\n- builder: claude code, model: opus 5.5, backup codex gpt-6-astra, max 20 min, until 2027-01-31 <!-- keep -->\n'));
  const res = cli('--member', 'builder', 'codex', 'gpt-6.1-sol');
  assert.equal(res.exit, 0, res.err);
  assert.deepEqual(section(text(), 'team'), [
    '- builder: codex, model: gpt-6.1-sol, backup claude code opus 5.5, backup codex gpt-6-astra, max 20 min, until 2027-01-31 <!-- keep -->',
    '- researcher: claude code, model: haiku 5.5',
  ]);
  // it reads back: the new lead runs, with both backups behind it in order
  const { readRosterState, rosterPickFromValue } = require('../lib/engine-registry');
  const line = readRosterState(root).machine.team.find((entry) => entry.member === 'builder');
  const pick = rosterPickFromValue(line.value, 'executor');
  assert.deepEqual([pick.engine, pick.model, pick.backup, pick.backup_model], ['codex', 'gpt-6.1-sol', 'claude', 'claude-opus-5-5']);
  assert.deepEqual(pick.more_backups.map((b) => [b.engine, b.model]), [['codex', 'gpt-6-astra']]);
  assert.equal(pick.max_seconds, 1200);
  assert.equal(pick.until, '2027-01-31');
  // swapping to a model that is already a backup moves it up, and the old lead takes the front of the backups
  assert.equal(cli('--member', 'builder', 'codex', 'gpt-6-astra').exit, 0);
  assert.equal(section(text(), 'team')[0], '- builder: codex, model: gpt-6-astra, backup codex gpt-6.1-sol, backup claude code opus 5.5, max 20 min, until 2027-01-31 <!-- keep -->');
}));

test('a label that is not a real model (devin\'s built-in router) saves no model pin', () => withRoom(({ root, cli, text }) => {
  const res = cli('build', 'devin', 'built-in', 'router');
  assert.equal(res.exit, 0, res.err);
  assert.equal(res.out, 'build now runs on devin. claude opus 5.5 is the backup.');
  assert.deepEqual(section(text(), 'build'), ['- devin, max: 45 min', '- claude code, model: opus 5.5, max: 45 min']);
  const { readRosterState } = require('../lib/engine-registry');
  assert.equal(readRosterState(root).machine.picks.executor.workers[0].model, '');
  // the member line is written the same way: the tool alone
  assert.equal(cli('--member', 'builder', 'devin', 'built-in', 'router').exit, 0);
  assert.ok(section(text(), 'team').includes('- builder: devin'), text());
}, { ready: ['claude', 'codex', 'devin'] }));

// --- the orb's engine card, over real http with the page's token check ----------

async function startPhone(root) {
  const phone = require('../lib/gm-phone');
  const gmBet = require('../lib/gm-bet');
  const { phonePage } = require('../lib/gm-phone-page');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-roster-set-phone-'));
  const hosts = [];
  const logPath = path.join(dir, 'gm-phone-actions.jsonl');
  const handler = phone.createPhoneHandler({
    workspaceRoot: root,
    token: TOKEN,
    hosts,
    tally: () => ({}),
    now: () => NOW,
    loadView: () => ({ workspace_name: 'shop', roster: [], reviews: [], stuck: [], outcomes: [], policy: {} }),
    runStep: async () => ({ code: 0, last_line: 'ok' }),
    writeTarget: () => true,
    snapshotTarget: () => () => true,
    logPath,
    page: phonePage,
    makeBetDesk: (log) => gmBet.createBetDesk({
      workspaceRoot: root,
      ledgerFile: path.join(dir, 'gm-bets.jsonl'),
      now: () => NOW,
      log,
      warmOnCreate: false,
      generate: () => new Promise(() => {}),
      generateQuestion: () => new Promise(() => {}),
      readMissions: () => new Map(),
      readHandoffs: () => [],
      loadSeason: () => ({ outcomes: [], error: null }),
      runCli: async () => ({ code: 0, stdout: '{}' }),
    }),
  });
  const server = http.createServer((q, s) => { handler(q, s).catch(() => { s.writeHead(500); s.end(); }); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `127.0.0.1:${server.address().port}`;
  hosts.push(base);
  const call = (method, p, { body, token = TOKEN } = {}) => new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : '';
    const headers = { origin: `http://${base}` };
    if (token) headers['x-gm-token'] = token;
    if (body) { headers['content-type'] = 'application/json'; headers['content-length'] = Buffer.byteLength(data); }
    const r = http.request({ host: '127.0.0.1', port: server.address().port, path: p, method, headers }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => { let json = null; try { json = JSON.parse(text); } catch {} resolve({ status: res.statusCode, json, text }); });
    });
    r.on('error', reject);
    r.end(data);
  });
  return { call, logPath, close: () => new Promise((resolve) => server.close(resolve)) };
}

function recordRuns(root, rows) {
  const file = path.join(root, '.atris', 'state', 'roster_runs.jsonl');
  fs.writeFileSync(file, rows.map((row) => JSON.stringify({ at: new Date(NOW - 3600000).toISOString(), ...row })).join('\n') + '\n');
}

test('orb engine card: every model on this machine grouped by tool, the current one on top, recorded ones first', () => withRoom(async ({ root }) => {
  recordRuns(root, [
    { job: 'build', engine: 'codex', model: 'gpt-6-astra', outcome: 'landed' },
    { job: 'build', engine: 'codex', model: 'gpt-6-astra', outcome: 'failed' },
  ]);
  const h = await startPhone(root);
  try {
    assert.equal((await h.call('POST', '/bet/engine', { body: { member: 'builder' }, token: 'nope' })).status, 403);
    const card = await h.call('POST', '/bet/engine', { body: { member: 'builder' } });
    assert.equal(card.status, 200, card.text);
    assert.equal(card.json.line, 'builder runs on claude opus 5.5.');
    assert.deepEqual(card.json.scopes.map((s) => s.label), ['just builder', 'for every build job']);
    assert.deepEqual(card.json.groups.map((g) => g.tool), ['claude code', 'codex']);
    const claude = card.json.groups[0].models;
    assert.equal(claude[0].label, 'opus 5.5');
    assert.equal(claude[0].current, true);
    assert.ok(claude.length > 1, 'every claude model is offered, not just four');
    const codex = card.json.groups[1].models;
    assert.deepEqual(codex.map((m) => [m.label, m.record]), [['gpt-6-astra', '1 of 2 landed'], ['gpt-6.1-sol', null]]);
  } finally {
    await h.close();
  }
}));

test('orb swap: one tap through the token-checked route swaps the job, says what changed, and returns the new table', () => withRoom(async ({ root, text }) => {
  const h = await startPhone(root);
  try {
    const tap = { member: 'builder', engine: 'codex', model: 'gpt-6.1-sol', scope: 'job' };
    assert.equal((await h.call('POST', '/bet/swap', { body: tap, token: 'nope' })).status, 403);
    assert.equal((await h.call('POST', '/bet/swap', { body: tap, token: '' })).status, 403);
    assert.equal(section(text(), 'build')[0], '- claude code, model: opus 5.5, max: 45 min', 'a refused tap writes nothing');
    const out = await h.call('POST', '/bet/swap', { body: tap });
    assert.equal(out.status, 200, out.text);
    assert.equal(out.json.ack, 'build now runs on codex gpt-6.1-sol. claude opus 5.5 is the backup.');
    assert.equal(out.json.rows.find((r) => r.member === 'builder').engine, 'codex gpt-6.1-sol');
    assert.deepEqual(section(text(), 'build'), ['- codex, model: gpt-6.1-sol, max: 45 min', '- claude code, model: opus 5.5, max: 45 min']);
    // the receipt names the same command the CLI runs
    const receipt = fs.readFileSync(h.logPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).find((r) => r.choice === 'engine_swap');
    assert.equal(receipt.command, 'atris engine roster set build codex gpt-6.1-sol');
    // just one member
    const one = await h.call('POST', '/bet/swap', { body: { member: 'researcher', engine: 'claude', model: 'opus 5.5', scope: 'member' } });
    assert.equal(one.status, 200, one.text);
    assert.match(one.json.ack, /^researcher now runs on claude opus 5\.5\./);
    assert.equal(one.json.rows.find((r) => r.member === 'researcher').engine, 'claude opus 5.5');
    // a tool that cannot do the member's kind of work is refused
    assert.equal((await h.call('POST', '/bet/swap', { body: { member: 'researcher', engine: 'codex', model: 'gpt-6-astra', scope: 'member' } })).status, 409);
    // an unknown model is refused with the list, and nothing changes
    const bad = await h.call('POST', '/bet/swap', { body: { member: 'builder', engine: 'codex', model: 'gpt-made-up', scope: 'job' } });
    assert.equal(bad.status, 409);
    assert.match(bad.json.message, /pick one of: gpt-6\.1-sol, gpt-6-astra/);
    assert.equal((await h.call('POST', '/bet/swap', { body: { member: 'ghost', engine: 'codex', model: 'gpt-6-astra', scope: 'job' } })).status, 409);
  } finally {
    await h.close();
  }
}));

test('orb: tapping devin\'s built-in router writes devin with no model, and the card shows it as current after', () => withRoom(async ({ root, text }) => {
  const h = await startPhone(root);
  try {
    const card = await h.call('POST', '/bet/engine', { body: { member: 'builder' } });
    const devin = card.json.groups.find((g) => g.engine === 'devin');
    assert.deepEqual(devin.models.map((m) => [m.label, m.model, m.current]), [['built-in router', '', false]]);
    const out = await h.call('POST', '/bet/swap', { body: { member: 'builder', engine: 'devin', model: devin.models[0].model, scope: 'job' } });
    assert.equal(out.status, 200, out.text);
    assert.equal(section(text(), 'build')[0], '- devin, max: 45 min');
    const after = await h.call('POST', '/bet/engine', { body: { member: 'builder' } });
    assert.equal(after.json.groups[0].engine, 'devin');
    assert.equal(after.json.groups[0].models[0].current, true);
  } finally {
    await h.close();
  }
}, { ready: ['claude', 'codex', 'devin'] }));

test('the phone page opens the engine card from the engine cell and has no looping motion', () => {
  const { phonePage } = require('../lib/gm-phone-page');
  const html = phonePage('n0nce');
  assert.match(html, /\/bet\/engine/);
  assert.match(html, /\/bet\/swap/);
  assert.match(html, /function drawEngine/);
  assert.doesNotMatch(html, /infinite/);
});
