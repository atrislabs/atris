'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const walk = require('../scripts/orb-walk');

// a whole card: every rule holds
function card(over = {}) {
  return {
    id: 'bet-1',
    kind: 'bet',
    layer: 'card',
    title: 'Write a getting started page for the phone',
    body: 'new people have nothing to try first.',
    options: [
      { id: 'do', label: 'do it', post: { path: '/act', body: { card_id: 'bet-1', option_id: 'do' } } },
      { id: 'skip', label: 'not now', post: { path: '/act', body: { card_id: 'bet-1', option_id: 'skip' } } },
    ],
    input: { label: 'or say something', post: { path: '/act', body: { card_id: 'bet-1' } } },
    ...over,
  };
}

const failed = checks => checks.filter(c => !c.ok).map(c => c.name);

// ---- the rules -----------------------------------------------------------------------

test('rules: a whole card keeps every rule', () => {
  assert.deepEqual(failed(walk.cardChecks(card())), []);
});

test('rules: a planted duplicate option is caught', () => {
  const twice = card({ options: [...card().options, { id: 'do2', label: 'Do it ', post: { path: '/act', body: { card_id: 'bet-1', option_id: 'do2' } } }] });
  const out = walk.cardChecks(twice);
  assert.deepEqual(failed(out), ['no option twice']);
  assert.match(out.find(c => c.name === 'no option twice').why, /do it/i);
  // the same label in two table rows is two cells, not a duplicate
  const cells = card({ options: [{ id: 'a', label: 'opus 5.5', cell: { row: 0 }, post: card().options[0].post }, { id: 'b', label: 'opus 5.5', cell: { row: 1 }, post: card().options[0].post }] });
  assert.deepEqual(failed(walk.cardChecks(cells)), []);
});

test('rules: a planted raw command, flag, or path is caught wherever it sits', () => {
  const planted = [
    card({ options: [{ id: 'x', label: 'run atris task accept CLI-12', post: card().options[0].post }] }),
    card({ body: 'it will push with --force tonight.' }),
    card({ title: 'Fix lib/gm-bet.js so the run passes' }),
    card({ input: { label: 'see `npm test`', post: card().input.post } }),
    card({ table: { columns: ['work'], rows: [['edit ~/.atris/state now']] } }),
  ];
  for (const c of planted) {
    const out = walk.cardChecks(c);
    assert.deepEqual(failed(out), ['plain words'], JSON.stringify(c));
  }
  assert.match(walk.cardChecks(planted[0]).find(c => c.name === 'plain words').why, /a command: atris task/);
  // plain words with numbers and dates stay plain
  assert.equal(walk.rawBit('300 more installs in the week before nov 1, about 3 hours left.'), null);
});

test('rules: a card with no way forward is caught', () => {
  const stuck = card({ options: [], input: null });
  assert.deepEqual(failed(walk.cardChecks(stuck)), ['a way forward']);
  // a disabled option is not a way forward either
  assert.deepEqual(failed(walk.cardChecks(card({ options: [{ id: 'now', label: 'opus 5.5', disabled: true }], input: null }))), ['a way forward']);
});

test('rules: every tap names the card, two yes cards never come in a row, and a layer has a way back', () => {
  const unnamed = card({ options: [{ id: 'do', label: 'do it', post: { path: '/bet/do', body: { confirm: true } } }] });
  assert.match(walk.cardChecks(unnamed).find(c => c.name === 'every tap names the card').why, /"do it" send no card id/);
  // the page's legacy answer body names the card as card, the contract as card_id
  assert.deepEqual(failed(walk.cardChecks(card({ options: [{ id: 'a', label: 'small teams', post: { path: '/bet/answer', body: { choice: 'a', card: 'bet-1' } } }] }))), []);
  const named = id => ({ id: 'yes', label: 'yes', post: { path: '/act', body: { card_id: id, option_id: 'yes' } } });
  const yes = card({ id: 'yes:2', kind: 'yes', options: [named('yes:2')], input: null });
  assert.deepEqual(failed(walk.cardChecks(yes, { prev: { id: 'yes:1', kind: 'yes' } })), ['one yes at a time']);
  assert.deepEqual(failed(walk.cardChecks(yes, { prev: { id: 'bet-1', kind: 'bet' } })), []);
  // an option that names some other card is caught too
  assert.deepEqual(failed(walk.cardChecks(card({ id: 'yes:2', kind: 'yes', options: [named('yes:1')], input: null }))), ['every tap names the card']);
  const team = card({ id: 'team~1', kind: 'team', layer: 'team', options: [{ id: 'talk', label: 'builder', post: { path: '/act', body: { card_id: 'team~1' } } }], input: null });
  assert.deepEqual(failed(walk.cardChecks(team)), ['a way back']);
});

// ---- the judge -----------------------------------------------------------------------

const STATE = { stage: 'the idea card', did: 'tapped the orb', screen: { title: 'Write a getting started page', options: ['do it', 'not now'] } };
const KEY = 'ts-secret-0123456789abcdef';

test('judge: TypeSafe gets Noul questions with the screen as state, and the key only in the header', async () => {
  const seen = [];
  const fetchFn = async (url, init) => {
    seen.push({ url, init });
    return { ok: true, json: async () => ({ model: 'jev-latest', answers: { next: { type: 'noul', noul: 0.93 }, plain: { type: 'noul', noul: 0.41 } }, usage: { input_tokens: 1, output_tokens: 1 } }) };
  };
  const judge = walk.pickJudge({ env: { TYPESAFE_API_KEY: KEY, OPENAI_API_KEY: 'sk-other-0123456789abcdef' }, fetchFn, dir: os.tmpdir() });
  assert.equal(judge.name, 'typesafe jev');
  const out = await judge.ask(['next', 'plain'], STATE);
  // a Noul probability is read as a plain yes or no
  assert.deepEqual(out, { next: { yes: true, why: null }, plain: { yes: false, why: null } });
  assert.equal(seen[0].url, 'https://api.typesafe.ai/v1/systemone');
  assert.equal(seen[0].init.headers.authorization, `Bearer ${KEY}`);
  const body = JSON.parse(seen[0].init.body);
  assert.equal(body.model, 'jev-latest');
  assert.deepEqual(body.questions.next, { type: 'noul', instructions: 'Would a busy founder know what to do next?' });
  assert.deepEqual(body.state.screen, STATE.screen);
  assert.ok(!seen[0].init.body.includes(KEY), 'the key is never in the body');
});

test('judge: OpenAI gets a strict json schema answer of a plain yes or no and one reason per question', async () => {
  let sent = null;
  const fetchFn = async (url, init) => {
    sent = { url, body: JSON.parse(init.body), auth: init.headers.authorization };
    return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ answers: { yes: true, why: 'the box asks for the number' }, plain: { yes: false, why: 'it says  npm' } }) } }] }) };
  };
  const judge = walk.pickJudge({ env: { OPENAI_API_KEY: 'sk-test-0123456789abcdef' }, fetchFn, dir: os.tmpdir() });
  assert.match(judge.name, /^openai /);
  const out = await judge.ask(['answers', 'plain'], STATE);
  assert.deepEqual(out, { answers: { yes: true, why: 'the box asks for the number' }, plain: { yes: false, why: 'it says npm' } });
  assert.equal(sent.url, 'https://api.openai.com/v1/chat/completions');
  const schema = sent.body.response_format.json_schema;
  assert.equal(schema.strict, true);
  assert.deepEqual(schema.schema.required, ['answers', 'plain']);
  assert.deepEqual(schema.schema.properties.plain, { type: 'object', properties: { yes: { type: 'boolean' }, why: { type: 'string' } }, required: ['yes', 'why'], additionalProperties: false });
  // the box counts as an answer, and a judge that gives no plain yes or no gave no answer
  assert.match(sent.body.messages[1].content, /The box to type in counts as an answer/);
  const vague = walk.pickJudge({ env: { OPENAI_API_KEY: 'sk-test-0123456789abcdef' }, fetchFn: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ plain: { yes: 'maybe', why: '' } }) } }] }) }), dir: os.tmpdir() });
  await assert.rejects(vague.ask(['plain'], STATE), /gave no answer/);
});

test('judge: codex runs read-only from an empty folder with the schema, and never gets a key', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orb-walk-judge-'));
  let call = null;
  const spawnFn = (bin, args, opts) => {
    call = { bin, args, opts };
    const child = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    setImmediate(() => {
      fs.writeFileSync(args[args.indexOf('-o') + 1], JSON.stringify({ next: { yes: true, why: 'do it is right there' } }));
      child.emit('close', 0);
    });
    return child;
  };
  try {
    const judge = walk.pickJudge({ env: { PATH: '/usr/bin', TYPESAFE_API_KEY: '', OPENAI_API_KEY: '' }, spawnFn, dir });
    assert.equal(judge.name, 'codex');
    assert.deepEqual(await judge.ask(['next'], STATE), { next: { yes: true, why: 'do it is right there' } });
    assert.equal(call.bin, 'codex');
    assert.deepEqual(call.args.slice(0, 3), ['exec', '--sandbox', 'read-only']);
    assert.ok(call.args.includes('--output-schema'));
    assert.ok(call.args.includes('--skip-git-repo-check'));
    assert.equal(call.opts.cwd, dir);
    assert.equal('TYPESAFE_API_KEY' in call.opts.env, false);
    assert.equal('OPENAI_API_KEY' in call.opts.env, false);
    assert.match(call.args[call.args.length - 1], /Would a busy founder know what to do next\?/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('judge: TypeSafe first, then OpenAI, then codex; none when asked; a missing key for a named judge says so', () => {
  const pick = env => walk.pickJudge({ env, fetchFn: async () => ({}), spawnFn: () => null, dir: os.tmpdir() });
  assert.equal(pick({ TYPESAFE_API_KEY: KEY, OPENAI_API_KEY: 'sk-x-0123456789abcdef' }).name, 'typesafe jev');
  assert.match(pick({ OPENAI_API_KEY: 'sk-x-0123456789abcdef' }).name, /^openai /);
  assert.equal(pick({}).name, 'codex');
  assert.equal(walk.pickJudge({ env: { TYPESAFE_API_KEY: KEY }, which: 'none', dir: os.tmpdir() }), null);
  assert.throws(() => walk.pickJudge({ env: {}, which: 'typesafe', dir: os.tmpdir() }), /needs TYPESAFE_API_KEY/);
});

test('judge: a failed call never puts the key in what is printed or saved', async () => {
  const env = { TYPESAFE_API_KEY: KEY };
  const judge = walk.pickJudge({ env, fetchFn: async () => { throw new Error(`could not reach the api with ${KEY}`); }, dir: os.tmpdir() });
  const stages = [{ name: 'the idea card', card: card(), ask: ['next'], checks: [] }];
  await walk.judgeStages(stages, judge, { env });
  assert.match(stages[0].judged.error, /could not reach the api/);
  assert.ok(!stages[0].judged.error.includes(KEY));
  assert.ok(!walk.redact(`Bearer ${KEY} and ${KEY}`, env).includes(KEY));
});

// ---- the pass rule -------------------------------------------------------------------

test('a stage passes only when every rule holds and no judged question gets a no from most of its votes', () => {
  const y = { yes: true, why: null };
  const n = why => ({ yes: false, why });
  const stage = (votes, checks = [{ name: 'a way forward', ok: true }]) => ({ name: 's', checks, ask: ['answers', 'next', 'plain'], judged: { votes } });
  const good = [{ answers: y, next: y, plain: y }, { answers: y, next: n('no clear next step'), plain: y }, { answers: y, next: y, plain: y }];
  // one no in three is a pass, and every vote shows in the judge cell
  assert.equal(walk.stageResult(stage(good)).result, 'pass');
  assert.equal(walk.stageResult(stage(good)).judge, 'answers yyy, next yny, plain yyy');
  const two = [good[0], { ...good[1], plain: n('it says ovr') }, { ...good[2], plain: n('model names') }];
  const out = walk.stageResult(stage(two));
  assert.equal(out.result, 'fail');
  assert.equal(out.note, 'judge says no to plain words (2 of 3): it says ovr');
  // any number of votes: most of them saying no fails it
  assert.equal(walk.stageResult(stage([{ answers: y, next: y, plain: n('x') }])).result, 'fail');
  assert.equal(walk.stageResult(stage([...good, good[0], good[0]])).judge, 'answers yyyyy, next ynyyy, plain yyyyy');
  assert.equal(walk.stageResult(stage(good, [{ name: 'plain words', ok: false, why: 'the title has a path: lib/x' }])).result, 'fail');
  assert.equal(walk.stageResult({ name: 's', checks: [], ask: ['next'], judged: { error: 'codex is not installed' } }).result, 'fail');
  assert.equal(walk.stageResult({ name: 's', checks: [], ask: ['next'], judged: { skipped: true } }).result, 'pass', 'rules only with --no-judge');
});

test('report: a divided box with one row per stage and the note wrapped to fit', () => {
  const table = walk.renderTable([{ stage: 'the idea card', checks: '5/5', judge: '3/3 (min .9)', result: 'pass', note: 'ok' }, { stage: 'a yes card', checks: '5/7', judge: '-', result: 'fail', note: 'the yes card has no "no" or "not now" and the walk tapped the orb instead of either one' }], { width: 80 });
  const lines = table.split('\n');
  assert.match(lines[0], /^┌─+┬/);
  assert.match(lines[1], /│ stage +│ checks │ judge +│ result │ note +│/);
  assert.match(lines[2], /^├─+┼/);
  assert.match(lines[lines.length - 1], /^└─+┴/);
  assert.ok(lines.every(l => l.length <= 80), table);
  assert.ok(lines.length > 6, 'the long note wraps onto more lines');
});

// ---- the contract adapter ---------------------------------------------------------------

test('contract: every tap posts the card id and the option id, and a confirm option gets its second tap', async () => {
  const posts = [];
  const idea = { id: 'bet-7', kind: 'idea', title: 'Record a demo', body: null, options: [{ id: 'do', label: 'do it', action: 'do', confirm: 'tap again to start' }, { id: 'skip', label: 'not now', action: 'skip' }], input: { label: 'or say something', action: 'say' }, job: null, table: null };
  const http = {
    get: async () => ({ status: 200, json: { ok: true, card: idea } }),
    post: async (p, body) => {
      posts.push({ p, body });
      if (body.option_id === 'do' && !body.confirm) return { status: 409, json: { ok: false, reason: 'needs_confirm', card: idea } };
      return { status: 200, json: { ok: true, card: { ...idea, id: 'bet-8' } } };
    },
  };
  const a = walk.contractAdapter(http);
  const shown = await a.open();
  assert.deepEqual(failed(walk.cardChecks(shown)), []);
  const next = await a.tap(shown.options[0]);
  assert.deepEqual(posts, [
    { p: walk.CONTRACT.act, body: { card_id: 'bet-7', option_id: 'do' } },
    { p: walk.CONTRACT.act, body: { card_id: 'bet-7', option_id: 'do', confirm: true } },
  ]);
  assert.equal(next.id, 'bet-8');
  await a.type(next, 'make it shorter');
  assert.deepEqual(posts[2], { p: walk.CONTRACT.act, body: { card_id: 'bet-8', text: 'make it shorter' } });
});

test('contract: a card id that comes back with other options fails the walk', async () => {
  const deck = id => ({ id, kind: 'deck', title: 'post the thread on x now?', body: null, options: [{ id: 'yes', label: 'yes', action: 'yes', binds: { job: 'm-a', key: 'm-a:0' } }, { id: 'back', label: 'the whole team', action: 'back' }], input: null, job: null, table: null });
  let served = deck('deck~1');
  const http = { get: async () => ({ status: 200, json: { ok: true, card: served } }), post: async () => ({ status: 200, json: { ok: true, card: served } }) };
  const a = walk.contractAdapter(http);
  const first = await a.open();
  assert.deepEqual(failed(walk.cardChecks(first, { changed: a.changed })), []);
  // the same id with job B's yes under it
  served = { ...deck('deck~1'), options: [{ id: 'yes', label: 'yes', action: 'yes', binds: { job: 'm-b', key: 'm-b:0' } }, { id: 'back', label: 'the whole team', action: 'back' }] };
  const again = await a.open();
  assert.deepEqual(failed(walk.cardChecks(again, { changed: a.changed })), ['a card keeps its options']);
  // a new id for new options is fine
  served = { ...served, id: 'deck~2' };
  const fresh = await a.open();
  assert.deepEqual(failed(walk.cardChecks(fresh, { changed: a.changed })), []);
});

// ---- one whole walk on the made-up workspace, with a fake judge and no network ------------

test('walk: the made-up workspace walks every http stage with a fake judge and no network', { timeout: 60000 }, async () => {
  const realFetch = global.fetch;
  const outside = [];
  global.fetch = (url, init) => {
    if (!/^http:\/\/127\.0\.0\.1:\d+\//.test(String(url))) { outside.push(String(url)); throw new Error('no network in tests'); }
    return realFetch(url, init);
  };
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'orb-walk-test-'));
  const asked = [];
  const judge = { name: 'fake', ask: async (ids, state) => { asked.push(state); return Object.fromEntries(ids.map(id => [id, { yes: true, why: null }])); } };
  let server = null;
  try {
    server = await walk.startFixture(root, process.env);
    const out = await walk.walk({ server, judge, browser: false });
    assert.deepEqual(out.rows.map(r => r.stage), [
      'first open',
      'the idea card',
      'tap an option, then the next card',
      '"something else", then "what"',
      'a real answer, which saves',
      'the weekly number card',
      '"not now" on the weekly number',
      'the team page',
      'a swap card',
      '"more models"',
      'the job deck',
      'flip the deck',
      '"talk to this job"',
      'a yes card',
      '"no" on the yes card',
      '"not now" on a yes card',
    ]);
    const byName = Object.fromEntries(out.stages.map(s => [s.name, s]));
    // the stages that work the same on the old cards and the contract
    for (const name of ['first open', 'the idea card', '"something else", then "what"', 'a real answer, which saves', 'the team page', 'the job deck', 'a yes card']) {
      const s = byName[name];
      assert.ok(s.card, `${name} had a screen`);
      assert.equal(s.checks.find(c => c.name === 'the step worked'), undefined, `${name}: ${JSON.stringify(s.checks)}`);
    }
    assert.equal(byName['a real answer, which saves'].checks.find(c => c.name === 'the answer was saved').ok, true);
    assert.equal(byName['"something else", then "what"'].checks.find(c => c.name === '"what" saved nothing').ok, true);
    assert.equal(byName['the idea card'].checks.find(c => c.name === 'an idea came').ok, true);
    // every stage with a screen was judged three times, and only by the fake
    const judged = out.stages.filter(s => s.card && s.ask.length);
    assert.ok(judged.length >= 12, `judged ${judged.length}`);
    assert.equal(asked.length, judged.length * 3);
    assert.ok(judged.every(s => s.judged && s.judged.votes && s.judged.votes.length === 3));
    // the judge is told exact model names are wanted on the team and the swap card, and nowhere else
    const wanted = new Set(asked.filter(a => a.screen.wanted).map(a => a.stage));
    assert.deepEqual([...wanted].sort(), ['"more models"', 'a swap card', 'the team page']);
    assert.deepEqual(outside, []);
  } finally {
    global.fetch = realFetch;
    if (server) await server.stop();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
});
