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
const gmCard = require('../lib/gm-card');
const registry = require('../lib/engine-registry');

const TODAY = '2026-10-21';
const NOW = new Date(2026, 9, 21, 12, 0, 0).getTime();
const REAL_PATH = process.env.PATH;

const NO_MODEL_TITLE = 'the orb needs a model signed in on this computer.';
const SAY_FALLBACK = 'say that another way, or tap a button.';
const SAY_NO_MODEL = 'the orb needs a model signed in on this computer to read that, so nothing was saved.';
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

// the program each model runs as, when it is not the model's own name
const BIN_NAMES = { cursor: 'cursor-agent' };

// mode: ok answers from the prompt, fail exits 1 like a model that is not
// signed in, printfail says so on stdout and exits 1, hang never answers.
// In ok mode a prompt with HANG in it is never answered, and one with LATE
// is answered a second and a half late. The claude fake speaks stream-json
// the way claude -p --output-format stream-json does; the rest print plain text.
function fakeModel(dir, name, mode = 'ok') {
  const stream = name === 'claude';
  const body = `
const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(path.join(dir, 'calls.jsonl'))}, JSON.stringify({ model: ${JSON.stringify(name)}, args, pid: process.pid }) + '\\n');
const mode = ${JSON.stringify(mode)};
const say = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
if (mode === 'fail') { process.stderr.write('please log in first\\n'); process.exit(1); }
if (mode === 'printfail') { process.stdout.write('error: please log in first\\n'); process.exit(1); }
const all = args.join(' ');
if (mode === 'hang' || all.includes('HANG')) { if (${stream}) say({ type: 'system', subtype: 'init' }); setInterval(() => {}, 1000); return; }
const text = all.includes('skeptical cofounder') ? ${JSON.stringify(PASS)} : all.includes('You read one short message') ? ${JSON.stringify(READ)} : ${JSON.stringify(BET)};
setTimeout(() => {
  if (${stream}) {
    say({ type: 'system', subtype: 'init' });
    say({ type: 'stream_event', event: { type: 'message_start' } });
    say({ type: 'result', result: text });
  } else {
    process.stdout.write(text + '\\n');
  }
}, all.includes('LATE') ? 1500 : 0);
`;
  const file = path.join(dir, BIN_NAMES[name] || name);
  fs.writeFileSync(file, `#!${process.execPath}\n${body}`);
  fs.chmodSync(file, 0o755);
  return file;
}

function calls(dir, field = 'model') {
  const file = path.join(dir, 'calls.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)[field]);
}

// until every fake that was started has ended, so what its end decides is done
async function allEnded(dir, ms = 10000) {
  const end = Date.now() + ms;
  const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
  while (Date.now() < end && calls(dir, 'pid').some(alive)) await new Promise(r => setTimeout(r, 25));
  for (let i = 0; i < 5; i += 1) await new Promise(r => setTimeout(r, 10));
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

// the words a person reads on a card, all of them
function words(card) {
  return [card.title, card.body, card.line, ...(card.options || []).map(o => o.label)].filter(Boolean).join(' ');
}

function plainForOwner(card) {
  assert.deepEqual(gmCard.cardProblems(card), [], 'the card keeps every card rule');
  assert.equal(gmBet.OWNER_BANNED.test(words(card)), false, `no word of ours on the card: ${words(card)}`);
  assert.doesNotMatch(words(card), /claude|codex|`|--|\/|\binstall\b|\bnpm\b|\bcli\b/i, 'no command, flag, path, or tool name');
}

// ---- no model on this computer ------------------------------------------------------

test('no model here: an idea attempt asks nothing, starts nothing, and says the orb needs a model', async () => {
  const dir = bin();
  const root = workspace();
  await onPath(dir, async () => {
    const started = Date.now();
    const out = await generate(root);
    assert.equal(out.ok, false);
    assert.equal(out.no_model, 'none');
    assert.equal(out.retry, false);
    assert.ok(Date.now() - started < 5000, 'it knows at once, before the facts are read');
  });
  assert.deepEqual(calls(dir), []);
});

test('no model here: the desk shows one calm card with try again, and typed words are never blamed', async () => {
  const dir = bin();
  const root = workspace();
  await onPath(dir, async () => {
    const d = desk(root);
    d.next();
    const card = await settled(d);
    assert.equal(card.kind, 'missed');
    assert.equal(card.title, NO_MODEL_TITLE);
    assert.equal(card.body, 'there is none here yet. once one is set up, tap try again.');
    assert.deepEqual(card.options.map(o => [o.label, o.action]), [['try again', 'next']]);
    assert.doesNotMatch(words(card), /no idea came together/);
    plainForOwner(d.card().card);
    // words typed on it get the truth, never "say that another way"
    const said = await d.act({ card_id: card.id, text: 'what do i do?' });
    assert.equal(said.status, 200, JSON.stringify(said.body));
    assert.equal(said.body.card.kind, 'reply');
    assert.equal(said.body.card.title, SAY_NO_MODEL);
  });
  assert.deepEqual(calls(dir), []);
});

test('no model here: once one is signed in, the next tap on try again writes an idea, with no restart', async () => {
  const dir = bin();
  const root = workspace();
  await onPath(dir, async () => {
    const d = desk(root);
    d.next();
    const missed = await settled(d);
    assert.equal(missed.title, NO_MODEL_TITLE);
    // the owner signs in to a model, then taps try again
    fakeModel(dir, 'claude');
    const again = await d.act({ card_id: missed.id, option_id: 'again' });
    assert.equal(again.status, 200, JSON.stringify(again.body));
    await settled(d);
    const next = await d.act({ orb: true, card_id: d.card().card.id });
    assert.equal(next.body.card.kind, 'idea', JSON.stringify(next.body.card));
    assert.equal(next.body.card.title, 'write a getting started page for atris gm phone with a 30 second screen recording');
  });
  assert.ok(calls(dir).includes('claude'));
});

test('no model here: a model other than claude signed in after the card also works on the next tap', async () => {
  const dir = bin();
  const root = workspace();
  await onPath(dir, async () => {
    const d = desk(root);
    d.next();
    const missed = await settled(d);
    assert.equal(missed.title, NO_MODEL_TITLE);
    // the saved list says codex is not here, checked a moment ago
    const saved = JSON.parse(fs.readFileSync(registry.engineRegistryFile(root), 'utf8')).engines.find(e => e.id === 'codex');
    assert.equal(saved.health.status, 'not_installed');
    fakeModel(dir, 'codex');
    await d.act({ card_id: missed.id, option_id: 'again' });
    await settled(d);
    const next = await d.act({ orb: true, card_id: d.card().card.id });
    assert.equal(next.body.card.kind, 'idea', JSON.stringify(next.body.card));
  });
  assert.ok(calls(dir).includes('codex'));
});

// ---- the model here is broken ----------------------------------------------------

test('broken model only: the card says the model here did not answer, and a typed word is not blamed on the owner', async () => {
  const dir = bin();
  fakeModel(dir, 'claude', 'fail');
  const root = workspace();
  await onPath(dir, async () => {
    const out = await generate(root);
    assert.deepEqual([out.ok, out.no_model, out.retry], [false, 'failed', false]);
    const r = await read(workspace());
    assert.equal(r.ok, false);
    assert.equal(r.answered, undefined, 'no model answered');
    assert.equal(r.no_model, 'failed');
    const d = desk(workspace());
    d.next();
    const card = await settled(d);
    assert.deepEqual([card.kind, card.title, card.body], ['missed', NO_MODEL_TITLE, 'the model here did not answer. check that it is signed in, then tap try again.']);
    plainForOwner(d.card().card);
    const said = await d.act({ card_id: card.id, text: 'make it about schools' });
    assert.equal(said.body.card.title, SAY_NO_MODEL);
    assert.notEqual(said.body.card.title, SAY_FALLBACK);
  });
});

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
    // the silent one sits out once its time is up and it is stopped; the next word goes to the second model
    await allEnded(dir);
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

test('a model that never answers and no other: the wait ends in the calm card, never "no idea came together"', async () => {
  const dir = bin();
  fakeModel(dir, 'claude', 'hang');
  const root = workspace();
  await onPath(dir, async () => {
    const out = await generate(root, { budgetMs: 3000 });
    assert.deepEqual([out.ok, out.no_model, out.retry], [false, 'failed', false]);
    const d = desk(workspace(), { budgetMs: 3000 });
    d.next();
    const card = await settled(d);
    assert.deepEqual([card.kind, card.title], ['missed', NO_MODEL_TITLE]);
  });
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

test('claude not here, the second model never answers, a third one works: the read after the silent one goes to the third', async () => {
  const dir = bin();
  fakeModel(dir, 'codex', 'hang');
  fakeModel(dir, 'cursor');
  const root = workspace();
  await onPath(dir, async () => {
    // long enough for a busy machine to start the silent one, so it is seen to run
    const first = await read(root, { timeoutMs: 4000 });
    assert.deepEqual([first.ok, first.answered, first.retry], [false, undefined, true]);
    await allEnded(dir);
    const second = await read(root, { timeoutMs: 5000 });
    assert.equal(second.ok, true, second.reason);
  });
  assert.deepEqual(calls(dir), ['codex', 'cursor']);
});

test('a second model that prints an error and exits 1 is a failure, never an answer to read', async () => {
  const dir = bin();
  fakeModel(dir, 'codex', 'printfail');
  fakeModel(dir, 'cursor');
  const root = workspace();
  await onPath(dir, async () => {
    const r = await read(root);
    assert.equal(r.ok, true, r.reason);
    assert.equal(r.reply, 'it asks what you want the next idea to be about.');
  });
  assert.deepEqual(calls(dir), ['codex', 'cursor']);
});

test('a model that answers after another call gave up on it is back in the lineup at once', async () => {
  const dir = bin();
  fakeModel(dir, 'claude');
  const root = workspace();
  await onPath(dir, async () => {
    // one read gives up on claude while another is still being answered by it
    const [gaveUp, answered] = await Promise.all([read(root, { text: 'HANG', timeoutMs: 1000 }), read(root, { text: 'LATE', timeoutMs: 8000 })]);
    assert.equal(gaveUp.ok, false);
    assert.equal(answered.ok, true, answered.reason);
    const after = await read(root);
    assert.equal(after.ok, true, after.reason);
  });
});

test('stopping the phone server stops a call, and no other model is started after it', async () => {
  const dir = bin();
  fakeModel(dir, 'claude', 'hang');
  fakeModel(dir, 'codex');
  const root = workspace();
  await onPath(dir, async () => {
    const pending = read(root, { timeoutMs: 20000 });
    const end = Date.now() + 10000;
    while (Date.now() < end && !calls(dir).length) await new Promise(r => setTimeout(r, 20));
    await new Promise(r => setTimeout(r, 200));
    assert.ok(gmBet.stopWriters() >= 1);
    const out = await pending;
    assert.equal(out.ok, false);
    await new Promise(r => setTimeout(r, 300));
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
      for (let i = 0; i < 3; i += 1) {
        const r = await read(root);
        assert.equal(r.ok, true, r.reason);
      }
    });
  } finally {
    registry.readEngineRegistry = real;
  }
  assert.equal(reads, 1);
});
