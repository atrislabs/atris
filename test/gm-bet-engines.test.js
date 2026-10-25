'use strict';

// The orb when its model is missing, broken, or never answers: what the
// owner sees, and which model thinks instead. Every model here is a fake
// script on a fake PATH under a fake HOME, so no test reaches a real one.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// hermetic: nothing here may touch the real ~/.atris
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'gm-engines-home-'));
process.env.HOME = HOME;
process.env.ATRIS_HOME = path.join(HOME, '.atris');
delete process.env.ATRIS_TOKEN;
process.env.ATRIS_SWITCH_NOTICE = '0';
process.env.ATRIS_ROUTER_EXPLAIN = '0';

const gmBet = require('../lib/gm-bet');
const registry = require('../lib/engine-registry');

const TODAY = '2026-10-21';
const NOW = new Date(2026, 9, 21, 12, 0, 0).getTime();
const REAL_PATH = process.env.PATH;

const SAY_NOT_HEARD = 'the model did not answer this time, so nothing was saved. try again in a moment.';

function workspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gm-engines-ws-'));
  fs.mkdirSync(path.join(root, 'atris', 'wiki', 'briefs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'atris', 'now.md'), '# now\n\nLast updated: 2026-10-20 at 09:00 local time\n\n- the phone page is live\n');
  fs.writeFileSync(path.join(root, 'atris', 'wiki', 'briefs', 'new.md'), '# brief new\n\nagents that pay for themselves win the week\n');
  for (const [m, role, description] of [['builder', 'Builder', 'Writes and tests the code'], ['launcher', 'Launcher', 'Writes posts, pages, and launch copy']]) {
    fs.mkdirSync(path.join(root, 'atris', 'team', m), { recursive: true });
    fs.writeFileSync(path.join(root, 'atris', 'team', m, 'MEMBER.md'), `---\nname: ${m}\nrole: ${role}\ndescription: ${description}\n---\n\n# ${m}\n`);
  }
  return root;
}

// 60 days ending 2026-09-30: last week 1,400, the best week 1,550
function npmBody() {
  const downloads = [];
  const n = 60;
  for (let i = 0; i < n; i += 1) {
    const d = new Date(Date.UTC(2026, 8, 30 - (n - 1 - i)));
    const back = n - 1 - i;
    const week = Math.floor(back / 7);
    const value = week === 0 ? 200 : week === 3 ? (back % 7 === 6 ? 230 : 220) : (back % 7 === 6 ? 160 : 190);
    downloads.push({ day: d.toISOString().slice(0, 10), downloads: value });
  }
  return { downloads };
}

// the facts, read with no network and no task db; no model stub in here
const FACTS = {
  seasonFacts: () => ({ landed: 4, target: { landed: 4, goal: 6, verdict: 'behind' }, record: { won: 2, lost: 1 }, waiting_on_review: 0, waiting_jobs: [], stuck: 0 }),
  classifyQueue: (root, jobs) => jobs,
  gitLanded: () => ['gm phone: decision cards', 'bench: agy engine'],
  fetchJson: async url => (url.startsWith('https://registry.npmjs.org/') ? { version: '3.71.3' } : npmBody()),
  releaseGap: () => ({ count: 67 }),
  packageName: 'atris',
};

const BET = JSON.stringify({
  title: 'Write a getting started page for atris gm phone with a 30 second screen recording',
  why_now: 'installs last week were 1,400 and the phone page just went live, so new installs have nothing to try first.',
  expect: '300 more npm installs in the week before nov 1',
  target: { metric: 'installs', baseline: 1400, goal: 1700 },
  check_in_days: 9,
  metric_source: 'npm installs for atris',
  verify: 'test -s docs/gm-phone.md',
  cost: 'about 4 hours of agent time, $0',
  steps: [
    { text: 'draft the getting started page', detail: 'docs/gm-phone.md, about 300 words', who: 'team', member: 'builder', public: false },
    { text: 'record a 30 second screen capture of the phone page', who: 'team', member: 'launcher', public: false },
    { text: 'publish the page and post the recording on x', who: 'you', public: true },
  ],
});
const PASS = JSON.stringify({ verdict: 'pass', missing_first: 'nothing', moves_metric: true, reason: 'a getting started page is what new installs hit first.' });
const READ = JSON.stringify({ kind: 'question', reply: 'it asks what you want the next idea to be about.' });

// A folder that stands in for PATH: /bin is there for sh, and no model is
// in /bin. Each fake model writes what it was asked to calls.jsonl.
function bin() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gm-engines-bin-'));
}

// mode: ok answers from the prompt, fail exits 1 like a model that is not
// signed in, hang never answers. The claude fake speaks stream-json the way
// claude -p --output-format stream-json does; the rest print plain text.
function fakeModel(dir, name, mode = 'ok') {
  const stream = name === 'claude';
  const body = `
const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(path.join(dir, 'calls.jsonl'))}, JSON.stringify({ model: ${JSON.stringify(name)}, args }) + '\\n');
const mode = ${JSON.stringify(mode)};
const say = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
if (mode === 'fail') { process.stderr.write('please log in first\\n'); process.exit(1); }
if (mode === 'hang') { if (${stream}) say({ type: 'system', subtype: 'init' }); setInterval(() => {}, 1000); return; }
const all = args.join(' ');
const text = all.includes('skeptical cofounder') ? ${JSON.stringify(PASS)} : all.includes('You read one short message') ? ${JSON.stringify(READ)} : ${JSON.stringify(BET)};
if (${stream}) {
  say({ type: 'system', subtype: 'init' });
  say({ type: 'stream_event', event: { type: 'message_start' } });
  say({ type: 'result', result: text });
} else {
  process.stdout.write(text + '\\n');
}
`;
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!${process.execPath}\n${body}`);
  fs.chmodSync(file, 0o755);
  return file;
}

function calls(dir) {
  const file = path.join(dir, 'calls.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l).model);
}

// PATH is this folder and /bin for the length of one test
async function onPath(dir, fn) {
  process.env.PATH = `${dir}${path.delimiter}/bin`;
  try {
    return await fn();
  } finally {
    process.env.PATH = REAL_PATH;
  }
}

const generate = (root, extra = {}) => gmBet.generateBet({ workspaceRoot: root, today: TODAY, ledgerFile: path.join(root, 'bets.jsonl'), attemptsFile: path.join(root, 'attempts.jsonl'), deps: { ...FACTS }, ...extra });
const read = (root, extra = {}) => gmBet.readSaid({ text: 'what do you mean?', card: { kind: 'idea', title: 'an idea', detail: 'why it matters', buttons: ['do it', 'sharpen it', 'not now'] }, workspaceRoot: root, deps: { readerModel: () => 'haiku' }, ...extra });

// the owner answered the one fallback question, so no question card comes first
function answered(ledgerFile, root) {
  const file = gmBet.focusPath(path.dirname(ledgerFile));
  const q = gmBet.FALLBACK_QUESTION;
  fs.appendFileSync(file, `${JSON.stringify({ workspace: root, key: q.key, answer: q.choices[0].id, label: q.choices[0].label, ask: q.ask, at: new Date(NOW).toISOString() })}\n`);
}

// A desk on the real writer and the real reader: only the facts are stubbed.
// writer: an idea writer of the test's own, so a test can start from an idea card
function desk(root, { budgetMs = 30000, sayTimeoutMs, writer = null } = {}) {
  const ledgerFile = path.join(root, 'state', 'gm-bets.jsonl');
  fs.mkdirSync(path.dirname(ledgerFile), { recursive: true });
  answered(ledgerFile, root);
  return gmBet.createBetDesk({
    workspaceRoot: root,
    ledgerFile,
    attemptsFile: path.join(root, 'state', 'attempts.jsonl'),
    now: () => NOW,
    warmOnCreate: false,
    choices: false,
    generate: writer || (opts => gmBet.generateBet({ ...opts, today: TODAY, deps: { ...FACTS }, ledgerFile, attemptsFile: path.join(root, 'state', 'attempts.jsonl'), budgetMs })),
    readSaid: opts => gmBet.readSaid({ ...opts, workspaceRoot: root, deps: { readerModel: () => 'haiku' }, ...(sayTimeoutMs ? { timeoutMs: sayTimeoutMs } : {}) }),
    generateQuestion: () => new Promise(() => {}),
    suggestScoreboard: () => new Promise(() => {}),
    readMissions: () => ({}),
    readHandoffs: () => [],
    runCli: async () => ({ code: 0, stdout: '{}', stderr: '' }),
    ...(sayTimeoutMs ? { sayTimeoutMs } : {}),
  });
}

// an idea already written, for tests about what the owner types
const ready = async () => ({ ok: true, bet: { ...JSON.parse(BET), check_date: '2026-10-30' } });

// every drafting the desk starts, one after another, until none is running
async function settled(d) {
  for (let i = 0; i < 20 && d.state.gen; i += 1) {
    await d.state.gen.done;
    for (let j = 0; j < 5; j += 1) await new Promise(r => setImmediate(r));
  }
  return d.card().card;
}

// the idea card, from a desk whose writer is the test's own
async function ideaCard(d) {
  d.next();
  await settled(d);
  const shown = await d.act({ orb: true, card_id: d.card().card.id });
  assert.equal(shown.body.card.kind, 'idea', JSON.stringify(shown.body.card));
  return shown.body.card;
}

// ---- the model here is broken ----------------------------------------------------

test('broken model, a second one signed in: ideas and reads come from the second one', async () => {
  const dir = bin();
  fakeModel(dir, 'claude', 'fail');
  fakeModel(dir, 'codex');
  const root = workspace();
  await onPath(dir, async () => {
    const out = await generate(root);
    assert.equal(out.ok, true, out.reason);
    assert.equal(out.checked, true, 'the second one also checked it');
    // the broken one sits out once it failed: the three writers that started with it
    // asked it, and nothing after them does
    const broken = calls(dir).filter(m => m === 'claude').length;
    assert.ok(broken >= 1 && broken <= 3, `asked ${broken} times`);
    const r = await read(root);
    assert.deepEqual(r, { ok: true, kind: 'question', reply: 'it asks what you want the next idea to be about.' });
    assert.equal(calls(dir).filter(m => m === 'claude').length, broken);
    assert.ok(calls(dir).filter(m => m === 'codex').length >= 3, 'writer, check, and read');
    // the desk: an idea, and a word typed on it is read by the second one
    const d = desk(workspace());
    d.next();
    await settled(d);
    const shown = await d.act({ orb: true, card_id: d.card().card.id });
    assert.equal(shown.body.card.kind, 'idea', JSON.stringify(shown.body.card));
    const said = await d.act({ card_id: shown.body.card.id, text: 'what do you mean?' });
    assert.equal(said.body.card.title, 'it asks what you want the next idea to be about.');
  });
});

// ---- the model here never answers -----------------------------------------------------

test('a model that never answers: a typed word that times out is not blamed on the owner; the next one goes to the second model', async () => {
  const dir = bin();
  fakeModel(dir, 'claude', 'hang');
  fakeModel(dir, 'codex');
  const root = workspace();
  await onPath(dir, async () => {
    const d = desk(root, { sayTimeoutMs: 1500, writer: ready });
    const card = await ideaCard(d);
    const first = await d.act({ card_id: card.id, text: 'what do you mean?' });
    assert.equal(first.body.card.title, SAY_NOT_HEARD);
    // the silent one sat out once its time was up; the next word goes to the second model
    await new Promise(r => setTimeout(r, 300));
    const base = d.card().card;
    const second = await d.act({ card_id: base.id, text: 'and then?' });
    assert.equal(second.body.card.title, 'it asks what you want the next idea to be about.');
  });
});

test('a model that never answers, a second one signed in: the wait keeps going and the idea comes from the second one', async () => {
  const dir = bin();
  fakeModel(dir, 'claude', 'hang');
  fakeModel(dir, 'codex');
  const root = workspace();
  await onPath(dir, async () => {
    const d = desk(root, { budgetMs: 4000 });
    d.next();
    assert.equal(d.card().card.kind, 'wait');
    // the first drafting gets no answer: the calm line says another model is trying, not that nothing came
    const end = Date.now() + 15000;
    const said = new Set();
    while (Date.now() < end && !d.state.queue.length) {
      await new Promise(r => setTimeout(r, 50));
      const c = d.card().card;
      if (c.kind === 'wait') for (const p of c.progress || []) said.add(p.line);
      assert.notEqual(c.kind, 'missed', 'the wait never ends in a card while another model can still try');
    }
    assert.ok(said.has('the model here did not answer, so another one is trying.'), JSON.stringify([...said]));
    assert.equal(d.state.queue.length >= 1, true);
    const shown = await d.act({ orb: true, card_id: d.card().card.id });
    assert.equal(shown.body.card.kind, 'idea', JSON.stringify(shown.body.card));
  });
  assert.ok(calls(dir).includes('codex'));
});

test('a saved list that says claude is gone, with claude here now: the orb still thinks on it', async () => {
  const dir = bin();
  fakeModel(dir, 'claude');
  const root = workspace();
  // an old credit wall saved claude as not here, and nothing looks at it again
  fs.mkdirSync(path.join(root, '.atris', 'state'), { recursive: true });
  const stale = ['claude', 'fable', 'haiku'].map(id => ({ id, name: id, installed: false, health: { status: 'credit_out' } }));
  fs.writeFileSync(registry.engineRegistryFile(root), JSON.stringify({ schema: 'atris.engine_registry.v2', engines: stale }));
  await onPath(dir, async () => {
    assert.deepEqual(registry.readEngineRegistry(root, { persist: false }).engines.filter(e => e.bin === 'claude').map(e => e.installed), [false, false, false]);
    assert.equal((await read(root)).ok, true);
  });
  assert.deepEqual(calls(dir), ['claude']);
});

// ---- cheap and cached ------------------------------------------------------------

test('finding the models is cheap: read once and kept, so a tap never waits on it', async () => {
  const dir = bin();
  fakeModel(dir, 'claude');
  const root = workspace();
  const real = registry.readEngineRegistry;
  let reads = 0;
  registry.readEngineRegistry = (...a) => { reads += 1; return real(...a); };
  try {
    await onPath(dir, async () => {
      for (let i = 0; i < 3; i += 1) assert.equal((await read(root)).ok, true);
    });
  } finally {
    registry.readEngineRegistry = real;
  }
  assert.equal(reads, 1);
});
