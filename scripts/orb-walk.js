#!/usr/bin/env node
'use strict';

// atris gm walk: walks every stage of the orb on the phone page and says,
// stage by stage, whether a person could get through it. It starts the phone
// server on a free port with a temp home and a made-up workspace
// (scripts/orb-walk-fixture.js), taps through each stage over HTTP the way the
// page does, then drives the real page once in headless Chrome for what only
// the screen shows (Esc, the small orb, the big orb).
//
// Every stage gets two kinds of checks:
//   rules   always the same, in code: a way forward, no option twice, no
//           command, flag, or path in any words, every tap names the card on
//           screen, never two yes cards in a row, Esc and the small orb lead
//           somewhere
//   judge   a fast decision model answers narrow yes or no questions about
//           the screen, given as json, each with a probability; TypeSafe's
//           Jev when TYPESAFE_API_KEY is set, else OpenAI when OPENAI_API_KEY
//           is set, else codex exec in a read-only sandbox
// A stage passes when every rule holds and every judged answer is yes with
// p at or over the threshold (0.8 unless --threshold says otherwise).
//
// The page is moving to one card contract: every card is { id, kind, title,
// body, options: [{ id, label, action }], input, job, table } and every tap
// posts { card_id, option_id } or { card_id, text }. The walk uses that when
// the server answers GET /card (CONTRACT below), and today's /bet answers
// otherwise (legacyAdapter, which taps the way lib/gm-phone-page.js does).
//
//   node scripts/orb-walk.js [--real-copy <workspace>] [--threshold 0.8]
//        [--judge typesafe|openai|codex] [--no-judge] [--no-browser] [--json] [--keep]

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const REPO = path.join(__dirname, '..');
const CONTRACT = { read: '/card', act: '/act' };
const LAYERS = new Set(['team', 'talk', 'swap', 'deck']);
const TEAM_COLUMNS = ['member', 'role', 'ovr', 'engine', 'status'];
const KEY_NAMES = ['TYPESAFE_API_KEY', 'OPENAI_API_KEY'];
const DEFAULT_THRESHOLD = 0.8;
const wait = ms => new Promise(r => setTimeout(r, ms));

// ---- the rules ---------------------------------------------------------------------

// A command, a flag, a path, a file name, or an env name, anywhere a person reads.
const RAW = [
  [/`[^`]*`?/, 'a code span'],
  [/(^|[\s("'])(~|\.{1,2})?\/[\w.-]+/, 'a path'],
  [/\b(lib|bin|commands|scripts|test|src|docs|atris|node_modules)\/[\w./-]*/, 'a path'],
  [/\b[\w-]+\.(js|mjs|cjs|ts|tsx|sh|md|json|jsonl|py|yml|yaml|txt|html|css|toml|lock)\b/i, 'a file name'],
  [/(^|\s)--?[a-z][\w-]*/i, 'a flag'],
  [/\b(npm|npx|git|node|gh|atris|claude|codex|curl)\s+(install|run|publish|test|view|push|commit|merge|tag|log|pr|task|mission|gm|exec|release|init|member|engine|decide|start|status|ask|login)\b/i, 'a command'],
  [/\b[A-Z][A-Z0-9]*_[A-Z0-9_]{2,}\b/, 'an env name'],
];

// the first raw bit in a line of words, as { what, text }, or null
function rawBit(text) {
  const t = String(text == null ? '' : text);
  for (const [re, what] of RAW) {
    const m = t.match(re);
    if (m) return { what, text: m[0].trim() };
  }
  return null;
}

// every piece of words on a card, with where it sits
function cardWords(card) {
  const out = [];
  const add = (where, text) => { if (text != null && String(text).trim()) out.push([where, String(text)]); };
  add('the title', card.title);
  add('the body', card.body);
  add('the line', card.line);
  for (const o of card.options || []) { add(`option "${o.label}"`, o.label); add(`option "${o.label}"`, o.detail); }
  if (card.input) { add('the box', card.input.label); add('the box', card.input.placeholder); }
  for (const row of (card.table && card.table.rows) || []) for (const cell of row) add('the table', cell);
  for (const turn of card.thread || []) add('the conversation', turn.text);
  return out;
}

const check = (name, ok, why = '') => ({ name, ok: Boolean(ok), why: ok ? '' : why });

// What a tap on this option or a send in this box would post names the card.
function namesCard(post, id) {
  if (!post || !post.body) return false;
  return Boolean(id) && (post.body.card_id === id || post.body.card === id);
}

// The rules for one screen. ctx.prev: the main card served just before this
// one, for the two-yes rule.
function cardChecks(card, { prev = null } = {}) {
  if (!card) return [check('a screen to check', false, 'nothing was on screen')];
  const options = (card.options || []).filter(o => !o.disabled);
  const out = [];
  out.push(check('a way forward', options.length > 0 || Boolean(card.input), 'no option and no box to type in'));
  const seen = new Map();
  const twice = [];
  for (const o of card.options || []) {
    const key = [String(o.label || '').trim().toLowerCase().replace(/\s+/g, ' '), String(o.detail || '').trim().toLowerCase(), o.group || '', o.cell ? o.cell.row : ''].join('|');
    if (seen.has(key)) twice.push(o.label);
    seen.set(key, true);
    if (o.id && card.options.filter(x => x.id === o.id).length > 1 && !twice.includes(o.label)) twice.push(o.label);
  }
  out.push(check('no option twice', twice.length === 0, `shown twice: ${[...new Set(twice)].join(', ')}`));
  const raw = cardWords(card).map(([where, text]) => ({ where, bit: rawBit(text) })).filter(x => x.bit);
  out.push(check('plain words', raw.length === 0, raw.length ? `${raw[0].where} has ${raw[0].bit.what}: ${raw[0].bit.text}` : ''));
  if (card.kind !== 'home') {
    const posts = [...options.filter(o => o.post), ...(card.input && card.input.post ? [card.input] : [])];
    const unnamed = posts.filter(o => !namesCard(o.post, card.id)).map(o => `"${o.label || 'the box'}"`);
    const list = `${unnamed.slice(0, 3).join(', ')}${unnamed.length > 3 ? ` and ${unnamed.length - 3} more` : ''}`;
    out.push(check('every tap names the card', unnamed.length === 0, !card.id ? `this screen has no card id for ${list} to send` : `${list} send no card id`));
  }
  if (card.kind === 'yes') out.push(check('one yes at a time', !(prev && prev.kind === 'yes' && prev.id !== card.id), 'a yes card came right after another yes card'));
  if (LAYERS.has(card.layer)) out.push(check('a way back', (card.options || []).some(o => o.back), 'no way back from here'));
  return out;
}

// ---- talking to the phone server ---------------------------------------------------

function client(base, token) {
  const origin = base.replace(/\/$/, '');
  async function call(method, p, body) {
    const headers = { 'x-gm-token': token, origin };
    if (body) headers['content-type'] = 'application/json';
    const url = `${origin}${p}${method === 'GET' ? `${p.includes('?') ? '&' : '?'}t=${encodeURIComponent(token)}` : ''}`;
    const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { json = null; }
    return { status: res.status, text, json: json || {}, headers: res.headers };
  }
  return { get: p => call('GET', p), post: (p, body) => call('POST', p, body || {}), base: origin };
}

const sendId = () => crypto.randomBytes(8).toString('hex').slice(0, 14);

// ---- the card contract: the server draws, the walk only taps -----------------------

function layerOf(kind) {
  if (kind === 'member') return 'talk';
  return LAYERS.has(kind) ? kind : 'card';
}

function contractAdapter(http) {
  let env = {};
  const served = [];
  const remember = (c) => { if (c && !LAYERS.has(layerOf(c.kind)) && c.kind !== 'reply' && (!served.length || served[served.length - 1].id !== c.id)) served.push({ id: c.id, kind: c.kind }); };
  async function act(body) {
    let r = await http.post(CONTRACT.act, body);
    if (r.json.reason === 'needs_confirm') r = await http.post(CONTRACT.act, { ...body, confirm: true });
    if ('card' in r.json) env = r.json;
    remember(env.card);
    return { card: current(), out: r.json, status: r.status };
  }
  function current() {
    const c = env.card;
    if (!c) {
      return { id: null, kind: 'home', layer: 'home', title: 'tap to think', options: [{ id: 'orb', label: 'the orb', post: { path: CONTRACT.act, body: { orb: true } }, run: () => act({ orb: true }) }], input: null };
    }
    const options = (c.options || []).map(o => ({
      id: o.id, label: o.label, detail: o.detail || null, action: o.action, cell: o.cell || null, typed: Boolean(o.type), disabled: o.action === 'none',
      back: o.action === 'back',
      post: { path: CONTRACT.act, body: { card_id: c.id, option_id: o.id } },
      run: text => act({ card_id: c.id, option_id: o.id, ...(text != null ? { text } : {}) }),
    }));
    const input = c.input ? { label: c.input.label, placeholder: c.input.placeholder, post: { path: CONTRACT.act, body: { card_id: c.id } }, run: text => act({ card_id: c.id, text }) } : null;
    return { id: c.id, kind: c.kind, layer: layerOf(c.kind), title: c.title, body: c.body, line: c.line || c.count || null, options, input, table: c.table || null, thread: c.thread || [], count: c.count || null };
  }
  return {
    mode: 'contract',
    http,
    served,
    current,
    async open() { const r = await http.get(CONTRACT.read); env = r.json; remember(env.card); return current(); },
    async orb() { return (await act({ orb: true, ...(env.card ? { card_id: env.card.id } : {}) })).card; },
    async openTeam() { return (await act({ open: 'team', ...(env.card ? { card_id: env.card.id } : {}) })).card; },
    async openDeck() { return (await act({ open: 'deck', ...(env.card ? { card_id: env.card.id } : {}) })).card; },
    async tap(option, text) { const r = await option.run(text == null ? undefined : text); return r.card; },
    async type(card, text) { if (!card.input) throw new Error('this card has no box to type in'); return (await card.input.run(text)).card; },
    async close() {
      for (let i = 0; i < 4; i += 1) {
        const c = current();
        const back = c.options.find(o => o.back);
        if (!LAYERS.has(c.layer) && c.kind !== 'reply') return c;
        if (!back) return c;
        await back.run();
      }
      return current();
    },
    last: () => env,
  };
}

// ---- today's /bet answers: the walk taps the way lib/gm-phone-page.js does ----------

function legacyAdapter(http) {
  let main = null;
  let layer = null;
  let reply = null;
  let homeLine = 'tap to think';
  let lastOut = {};
  const served = [];
  const remember = (s) => { if (s && s.id && (!served.length || served[served.length - 1].id !== s.id)) served.push({ id: s.id, kind: s.kind === 'bet' ? 'bet' : s.kind }); };
  const post = async (p, body) => { const r = await http.post(p, body); lastOut = r.json; return r; };
  const isCard = s => Boolean(s && (s.bet || s.job || s.question || s.choice || s.report) && ['ready', 'started', 'starting'].includes(s.status));

  async function think(sharper = false) {
    const r = await post('/bet/think', { sharper: Boolean(sharper) });
    if (r.status !== 200) throw new Error(`the next card did not come (${r.status})`);
    main = r.json;
    reply = null;
    remember(main);
    return current();
  }

  // typed words on the main card, read first: a question back is a reply on the card
  async function say(text, more = {}) {
    const s = main;
    const r = await post('/bet/say', { text, card: s && s.id, send: sendId(), ...more });
    if (r.json.ok && !r.json.stay) return think(false);
    if (!r.json.ok && r.json.reason !== 'needs_confirm') return current();
    reply = { r: r.json, said: text };
    return current();
  }

  const opt = (id, label, postAs, run, extra = {}) => ({ id, label, post: postAs, run, ...extra });
  const nav = (id, label, run, extra = {}) => ({ id, label, post: null, run, nav: true, ...extra });
  const sayBox = s => ({ label: 'or say something', placeholder: 'say something', post: { path: '/bet/say', body: { card: s.id } }, run: text => say(text) });

  // after a yes, a nice, or a saved number, the next card comes on its own
  const thenNext = r => (r.json.ok ? think(false) : current());

  function mainCard(s) {
    if (!s) return { id: null, kind: 'home', layer: 'home', title: homeLine, options: [opt('orb', 'the orb', { path: '/bet/think', body: { sharper: false } }, () => think(false)), nav('team', 'the team', () => openTeam())], input: null };
    const kind = s.kind || 'bet';
    const base = { id: s.id, kind, layer: 'card', thread: [], table: null };
    if (kind === 'report') {
      return {
        ...base, title: s.report.what, body: s.report.why,
        options: [
          opt('save', 'save', { path: '/bet/report', body: {} }, async text => thenNext(await post('/bet/report', { value: text })), { typed: true }),
          opt('later', 'not now', { path: '/bet/think', body: { sharper: false } }, () => think(false)),
        ],
        input: sayBox(s),
      };
    }
    if (kind === 'choice') {
      return {
        ...base, title: 'which one next?', body: null,
        options: s.choice.options.map(o => opt(o.id, o.title, { path: '/bet/pick', body: { id: o.id } }, async () => {
          const r = await post('/bet/pick', { id: o.id });
          if (r.status === 200 && r.json.bet) { main = r.json; remember(main); return current(); }
          return think(false);
        }, { detail: o.why })),
        input: sayBox(s),
      };
    }
    if (kind === 'question') {
      const q = s.question;
      const other = q.choices.some(c => c.other);
      return {
        ...base, title: q.ask, body: q.line || null,
        options: q.choices.map(c => (c.other
          ? opt(c.id, c.label, { path: '/bet/say', body: { card: s.id } }, text => say(text), { typed: true, other: true })
          : opt(c.id, c.label, { path: '/bet/answer', body: { choice: c.id, card: s.id } }, async () => thenNext(await post('/bet/answer', { choice: c.id, card: s.id }))))),
        input: other ? null : sayBox(s),
      };
    }
    if (kind !== 'bet') {
      const j = s.job || {};
      const options = [];
      if (kind === 'yes') options.push(opt('yes', 'yes', { path: '/bet/yes', body: { confirm: true } }, async () => thenNext(await post('/bet/yes', { confirm: true })), { confirm: true }));
      if (kind === 'done') options.push(opt('nice', 'nice', { path: '/bet/nice', body: {} }, async () => thenNext(await post('/bet/nice', {}))));
      return { ...base, title: j.what, body: j.why || null, options, input: sayBox(s), watch: kind === 'wait' };
    }
    const b = s.bet;
    const body = [b.why_now, b.expect].map(t => { const x = String(t || '').trim(); return x && !/[.!?]$/.test(x) ? `${x}.` : x; }).join(' ');
    if (s.mission || s.status === 'starting') return { ...base, title: b.title, body, line: s.mission ? s.mission.line : 'starting now', options: [], input: null };
    return {
      ...base, title: b.title, body,
      options: [
        opt('do', 'do it', { path: '/bet/do', body: { confirm: true } }, async () => { await post('/bet/do', { confirm: true }); return think(false); }, { confirm: true }),
        opt('sharper', 'sharper idea', { path: '/bet/think', body: { sharper: true } }, () => think(true)),
        opt('skip', 'not now', { path: '/bet/skip', body: {} }, async () => { await post('/bet/skip', {}); main = null; homeLine = 'not now. tap when you want another'; return current(); }),
      ],
      input: sayBox(s),
    };
  }

  // the orb's reply on the card: the card's own row stays, then the new
  // suggestions, then a start-or-note pair when a member is not running
  function replyCard() {
    const own = mainCard(main);
    const { r, said } = reply;
    const have = own.options.map(o => String(o.label).trim().toLowerCase());
    const options = [...own.options];
    if (r.stay) {
      for (const sug of r.suggestions || []) {
        if (!have.includes(String(sug).trim().toLowerCase())) options.push(opt(`say:${sug}`, sug, { path: '/bet/say', body: { card: main.id } }, () => say(sug)));
      }
    }
    if (r.reason === 'needs_confirm') {
      options.push(opt('start', 'start it', { path: '/bet/say', body: { card: main.id } }, () => say(said, { confirm: true })));
      options.push(opt('note', 'keep it as a note instead', { path: '/bet/say', body: { card: main.id } }, () => say(said, { note: true })));
    }
    return { ...own, kind: 'reply', base: own.kind, title: r.stay ? r.reply : (r.message || 'that did not go through'), body: null, options, input: own.options.some(o => o.other) ? null : sayBox(main), thread: (r.thread || []).slice(0, -1) };
  }

  async function openTeam(note = null) {
    const r = await http.get('/bet/team');
    if (r.status !== 200) throw new Error(`the team did not open (${r.status})`);
    layer = { kind: 'team', rows: r.json.rows || [], note };
    return current();
  }

  async function openDeck() {
    const r = await http.get('/bet/jobs');
    if (r.status !== 200) throw new Error(`the jobs did not open (${r.status})`);
    if (!(r.json.cards || []).length) return openTeam();
    layer = { kind: 'deck', cards: r.json.cards, columns: r.json.columns || [], at: 0, said: {}, talk: {} };
    return current();
  }

  // a word to a member in a talk box: the reply stays in the box, an ack replaces it
  async function steer(member, text, more = {}) {
    const r = await post('/bet/steer', { member, text, send: sendId(), ...more });
    const box = { reply: r.json.stay ? r.json.reply : (r.json.reason === 'needs_confirm' ? r.json.message : null), suggestions: r.json.stay ? (r.json.suggestions || []) : [], thread: r.json.stay ? (r.json.thread || []).slice(0, -1) : [], confirm: r.json.reason === 'needs_confirm' ? text : null, ack: r.json.ok && !r.json.stay ? r.json.ack : null, unsent: !r.json.ok && r.json.reason !== 'needs_confirm' ? (r.json.message || 'that did not send') : null };
    return box;
  }

  function talkParts(member, box, label) {
    const options = [];
    let input = { label, placeholder: label, post: { path: '/bet/steer', body: { member } }, run: async (text) => { Object.assign(box, await steer(member, text)); return current(); } };
    if (box.ack) input = null;
    for (const sug of box.suggestions || []) options.push(opt(`say:${sug}`, sug, { path: '/bet/steer', body: { member } }, async () => { Object.assign(box, await steer(member, sug)); return current(); }));
    if (box.confirm) options.push(opt('note', 'keep it as a note instead', { path: '/bet/steer', body: { member } }, async () => { Object.assign(box, await steer(member, box.confirm, { note: true })); return current(); }));
    return { options, input, line: box.ack || box.reply || box.unsent || null, thread: box.thread || [] };
  }

  function layerCard() {
    const toTeam = nav('back', 'back to the team', () => openTeam(), { back: true });
    if (layer.kind === 'team') {
      const rows = layer.rows;
      const options = [];
      rows.forEach((r, i) => {
        options.push(nav(`talk:${r.member}`, r.member, async () => { layer = { kind: 'talk', row: r, box: {} }; return current(); }, { cell: { row: i, column: 'member' } }));
        if (r.engine !== 'person') {
          options.push(opt(`swap:${r.member}`, r.engine, { path: '/bet/engine', body: { member: r.member } }, async () => {
            const s = await post('/bet/engine', { member: r.member });
            layer = { kind: 'swap', row: r, s: s.json, scope: 'member' };
            return current();
          }, { cell: { row: i, column: 'engine' }, action: 'swap' }));
        }
      });
      if (rows.some(r => ['waiting for your yes', 'working', 'waiting to start'].includes(r.status))) options.push(nav('deck', 'the jobs, one at a time', () => openDeck()));
      options.push(nav('close', 'close', async () => { layer = null; return current(); }, { back: true }));
      return { id: null, kind: 'team', layer: 'team', title: 'the team', body: rows.length ? null : 'nobody is on the team yet.', line: layer.note, options, input: null, table: rows.length ? { columns: TEAM_COLUMNS, rows: rows.map(r => [r.member, r.role, r.ovr, r.engine, r.sentence]) } : null, thread: [] };
    }
    if (layer.kind === 'talk') {
      const r = layer.row;
      const parts = talkParts(r.member, layer.box, `tell ${r.member} something`);
      return { id: null, kind: 'member', layer: 'talk', title: r.member, body: `${r.sentence}.`, line: parts.line, options: [...parts.options, toTeam], input: parts.input, table: null, thread: parts.thread };
    }
    if (layer.kind === 'swap') {
      const { row: r, s } = layer;
      const options = [];
      if (s.ok) {
        if ((s.scopes || []).length > 1) for (const sc of s.scopes) options.push(nav(`scope:${sc.id}`, sc.label, async () => { layer.scope = sc.id; return current(); }, { chosen: sc.id === layer.scope }));
        for (const g of s.groups || []) {
          for (const m of g.models) {
            options.push(m.current
              ? { id: `now:${g.engine}:${m.model}`, label: m.label, detail: 'now', group: g.tool, disabled: true, post: null }
              : opt(`m:${g.engine}:${m.model}`, m.label, { path: '/bet/swap', body: { member: r.member, engine: m.engine, model: m.model, scope: layer.scope } }, async () => {
                const out = await post('/bet/swap', { member: r.member, engine: m.engine, model: m.model, scope: layer.scope });
                if (out.status === 200 && out.json.ok) { layer = { kind: 'team', rows: out.json.rows || [], note: out.json.ack }; }
                return current();
              }, { detail: m.record || null, group: g.tool, action: 'swap_to' }));
          }
        }
      }
      return { id: null, kind: 'swap', layer: 'swap', title: r.member, body: s.ok ? s.line : (s.message || 'could not read the models on this machine.'), line: null, options: [...options, toTeam], input: null, table: null, thread: [] };
    }
    // the job deck: one running job at a time
    const n = layer.cards.length;
    const c = layer.cards[layer.at];
    const box = layer.talk[c.member] || (layer.talk[c.member] = {});
    const parts = talkParts(c.member, box, 'talk to this job');
    const options = [];
    if (c.yes) options.push(opt('yes', 'yes', { path: '/bet/yes', body: { confirm: true, key: c.yes.key, job: c.job_id } }, async () => { const r = await post('/bet/yes', { confirm: true, key: c.yes.key, job: c.job_id }); layer.said[c.job_id] = r.json.ack || r.json.message; c.yes = null; return current(); }, { confirm: true }));
    options.push(...parts.options);
    const flip = step => async () => { layer.at = (layer.at + step + n) % n; return current(); };
    if (n > 1) options.push(nav('prev', 'previous', flip(-1)));
    options.push(nav('team', 'the whole team', () => openTeam(), { back: true }));
    if (n > 1) options.push(nav('next', 'next', flip(1)));
    return {
      id: null, kind: 'deck', layer: 'deck',
      title: c.yes ? c.yes.what : null, body: c.yes ? c.yes.why : null,
      line: [`job ${layer.at + 1} of ${n}`, c.label, layer.said[c.job_id] || parts.line].filter(Boolean).join(' · '),
      count: `job ${layer.at + 1} of ${n}`,
      options, input: parts.input,
      table: { columns: layer.columns, rows: c.rows.map(r => layer.columns.map(k => r[k] || '')) },
      thread: parts.thread,
      job: c.job_id,
    };
  }

  function current() {
    if (layer) return layerCard();
    if (reply && main) return replyCard();
    return mainCard(isCard(main) || (main && main.kind === 'wait') ? main : null);
  }

  return {
    mode: 'legacy',
    http,
    served,
    current,
    async open() {
      const r = await http.get('/bet');
      if (r.status !== 200) throw new Error(`the page found no orb desk (${r.status})`);
      main = isCard(r.json) ? r.json : null;
      if (main) remember(main);
      if (r.json.status === 'skipped') homeLine = 'not now. tap when you want another';
      return current();
    },
    orb: () => { layer = null; return think(false); },
    openTeam: () => openTeam(),
    openDeck: () => openDeck(),
    async tap(option, text) { return option.run(text == null ? undefined : text); },
    async type(card, text) { if (!card.input) throw new Error('this card has no box to type in'); return card.input.run(text); },
    async close() { layer = null; reply = null; return current(); },
    last: () => lastOut,
    // the walk reads the desk's status for the calm line and the queue
    async peek() { return (await http.get('/bet')).json; },
  };
}

// GET /card answers with a card envelope once the contract is on the server.
async function pickAdapter(http) {
  const probe = await http.get(CONTRACT.read).catch(() => null);
  if (probe && probe.status === 200 && probe.json && 'card' in probe.json) return contractAdapter(http);
  return legacyAdapter(http);
}

// ---- the judge ----------------------------------------------------------------------

const QUESTIONS = {
  answers: 'Do these options answer the question shown?',
  next: 'Would a busy founder know what to do next?',
  plain: 'Is this plain language with no system words?',
};
// the judged questions, short, for the note column
const DOUBT = { answers: 'the options answer it', next: 'a founder knows what to do next', plain: 'plain words' };
const ABOUT = 'One screen of a phone app. A busy founder uses it to make decisions about the AI team that works for them. title is the big line, body and line are the smaller words, options are the buttons, input is a box to type in, table is a grid on screen, thread is the conversation so far, did is what the founder just did.';
const RULES = `${ABOUT} Answer each question about this screen with yes (true or false) and p, the probability from 0 to 1 that the answer is yes: above 0.5 when yes is true, below 0.5 when yes is false. Judge only what the screen shows.`;
const HOME_PICTURE = 'a big dotted orb in the middle of a dark screen; the orb is the button';

// the screen as the judge reads it: words only, no ids or posts
function judgeScreen(stage) {
  const c = stage.card || {};
  const screen = {
    title: c.title || null,
    body: c.body || null,
    line: c.line || null,
    options: (c.options || []).filter(o => !o.disabled).map(o => (o.detail ? `${o.label} (${o.detail})` : o.label)),
    input: c.input ? (c.input.label || c.input.placeholder || 'a box to type in') : null,
  };
  if (c.table) screen.table = { columns: c.table.columns, rows: c.table.rows.slice(0, 6) };
  if (c.thread && c.thread.length) screen.thread = c.thread.map(t => `${t.who === 'owner' ? 'founder' : 'app'}: ${t.text}`);
  if (c.kind === 'home') screen.picture = HOME_PICTURE;
  return { stage: stage.name, did: stage.did || null, screen };
}

function answerSchema(ids) {
  const one = { type: 'object', properties: { yes: { type: 'boolean' }, p: { type: 'number' } }, required: ['yes', 'p'], additionalProperties: false };
  return { type: 'object', properties: Object.fromEntries(ids.map(id => [id, one])), required: ids, additionalProperties: false };
}

const clampP = p => (Number.isFinite(Number(p)) ? Math.min(1, Math.max(0, Number(p))) : null);

// p is kept as the probability of yes. A model that gave p as how sure it is
// of its own answer (yes false with p 0.9) is read that way instead.
function normalizeAnswers(ids, raw) {
  const out = {};
  for (const id of ids) {
    const a = raw && raw[id];
    const p = clampP(a && a.p);
    if (!a || p == null) throw new Error(`the judge gave no answer for "${QUESTIONS[id] || id}"`);
    const yes = a.yes === true;
    out[id] = { yes, p: yes === (p >= 0.5) ? p : 1 - p };
  }
  return out;
}

// Never let a key reach a line we print or save.
function redact(text, env = process.env) {
  let s = String(text == null ? '' : text);
  for (const name of KEY_NAMES) {
    const key = env[name];
    if (key && key.length >= 6) s = s.split(key).join('[key]');
  }
  return s.replace(/\b(sk|ts|tsk)-[A-Za-z0-9_-]{12,}/g, '[key]').replace(/Bearer\s+\S+/gi, 'Bearer [key]');
}

// TypeSafe System One: Noul questions, one request per screen.
function typesafeJudge({ key, fetchFn = fetch, model = 'jev-latest', url = 'https://api.typesafe.ai/v1/systemone', timeoutMs = 30000 }) {
  return {
    name: 'typesafe jev',
    async ask(ids, state) {
      const questions = Object.fromEntries(ids.map(id => [id, { type: 'noul', instructions: QUESTIONS[id] }]));
      const res = await fetchFn(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model, state: { about: ABOUT, ...state }, questions }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`typesafe answered ${res.status}`);
      const json = await res.json();
      const raw = {};
      for (const id of ids) {
        const a = json && json.answers && json.answers[id];
        const p = clampP(a && a.noul);
        raw[id] = p == null ? null : { yes: p >= 0.5, p };
      }
      return normalizeAnswers(ids, raw);
    },
  };
}

// OpenAI chat completions with a strict json schema answer.
function openaiJudge({ key, fetchFn = fetch, model = 'gpt-5-mini', url = 'https://api.openai.com/v1/chat/completions', timeoutMs = 60000 }) {
  return {
    name: `openai ${model}`,
    async ask(ids, state) {
      const res = await fetchFn(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: RULES },
            { role: 'user', content: JSON.stringify({ questions: Object.fromEntries(ids.map(id => [id, QUESTIONS[id]])), ...state }) },
          ],
          response_format: { type: 'json_schema', json_schema: { name: 'screen_judgment', strict: true, schema: answerSchema(ids) } },
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`openai answered ${res.status}`);
      const json = await res.json();
      const text = json && json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content;
      return normalizeAnswers(ids, JSON.parse(String(text || '{}')));
    },
  };
}

// codex exec in a read-only sandbox, from an empty folder, answering in the schema.
function codexJudge({ spawnFn = spawn, model = null, dir, env = process.env, timeoutMs = 180000, bin = 'codex' }) {
  const childEnv = { ...env };
  for (const name of KEY_NAMES) delete childEnv[name];
  let n = 0;
  return {
    name: model ? `codex ${model}` : 'codex',
    ask(ids, state) {
      n += 1;
      const schemaFile = path.join(dir, `schema-${n}.json`);
      const outFile = path.join(dir, `answer-${n}.json`);
      fs.writeFileSync(schemaFile, JSON.stringify(answerSchema(ids)));
      const prompt = `${RULES}\n\nQuestions:\n${ids.map(id => `- ${id}: ${QUESTIONS[id]}`).join('\n')}\n\nThe screen, as json:\n${JSON.stringify(state)}\n\nAnswer with json only, one entry per question id, each { "yes": true or false, "p": 0 to 1 }. Do not run any command.`;
      const args = ['exec', '--sandbox', 'read-only', '--skip-git-repo-check', '--ephemeral', '--color', 'never', '--output-schema', schemaFile, '-o', outFile, '-c', 'model_reasoning_effort="low"', ...(model ? ['-m', model] : []), prompt];
      return new Promise((resolve, reject) => {
        let child;
        try {
          child = spawnFn(bin, args, { cwd: dir, env: childEnv, stdio: ['ignore', 'ignore', 'pipe'] });
        } catch (err) {
          reject(new Error(`codex did not start: ${err.message}`));
          return;
        }
        let stderr = '';
        const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, timeoutMs);
        if (child.stderr) child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-2000); });
        child.on('error', (err) => { clearTimeout(timer); reject(new Error(err.code === 'ENOENT' ? 'codex is not installed' : `codex did not start: ${err.message}`)); });
        child.on('close', (code) => {
          clearTimeout(timer);
          let text = '';
          try { text = fs.readFileSync(outFile, 'utf8'); } catch { text = ''; }
          if (!text.trim()) { reject(new Error(`codex gave no answer (exit ${code}): ${stderr.trim().split('\n').pop() || 'no output'}`)); return; }
          try {
            const m = text.match(/\{[\s\S]*\}/);
            resolve(normalizeAnswers(ids, JSON.parse(m ? m[0] : text)));
          } catch (err) {
            reject(err);
          }
        });
      });
    },
  };
}

// TypeSafe when its key is set, else OpenAI when its key is set, else codex.
function pickJudge({ env = process.env, which = null, fetchFn = fetch, spawnFn = spawn, dir }) {
  const pick = which || (env.TYPESAFE_API_KEY ? 'typesafe' : env.OPENAI_API_KEY ? 'openai' : 'codex');
  if (pick === 'none') return null;
  if (pick === 'typesafe') {
    if (!env.TYPESAFE_API_KEY) throw new Error('the typesafe judge needs TYPESAFE_API_KEY set');
    return typesafeJudge({ key: env.TYPESAFE_API_KEY, fetchFn, ...(env.ATRIS_WALK_TYPESAFE_MODEL ? { model: env.ATRIS_WALK_TYPESAFE_MODEL } : {}) });
  }
  if (pick === 'openai') {
    if (!env.OPENAI_API_KEY) throw new Error('the openai judge needs OPENAI_API_KEY set');
    return openaiJudge({ key: env.OPENAI_API_KEY, fetchFn, ...(env.ATRIS_WALK_OPENAI_MODEL ? { model: env.ATRIS_WALK_OPENAI_MODEL } : {}) });
  }
  if (pick === 'codex') return codexJudge({ spawnFn, dir, env, model: env.ATRIS_WALK_CODEX_MODEL || null });
  throw new Error(`no judge called ${pick}; use typesafe, openai, or codex`);
}

// Asks the judge about every stage that has a screen and questions, a few at a time.
async function judgeStages(stages, judge, { concurrency = 4, env = process.env } = {}) {
  const todo = stages.filter(s => s.card && s.ask && s.ask.length && !s.skipped);
  if (!judge) {
    for (const s of todo) s.judged = { skipped: true };
    return;
  }
  let at = 0;
  const worker = async () => {
    while (at < todo.length) {
      const s = todo[at++];
      try {
        s.judged = { answers: await judge.ask(s.ask, judgeScreen(s)) };
      } catch (err) {
        s.judged = { error: redact((err && err.message) || err, env) };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, todo.length) }, worker));
}

// pass, fail, or skip for one stage, and the line that says why
function stageResult(stage, threshold = DEFAULT_THRESHOLD) {
  const checks = stage.checks || [];
  const okChecks = checks.filter(c => c.ok).length;
  const failed = checks.find(c => !c.ok);
  const j = stage.judged || null;
  const asked = j && j.answers ? Object.entries(j.answers) : [];
  const low = asked.filter(([, a]) => !(a.p >= threshold));
  const minP = asked.length ? Math.min(...asked.map(([, a]) => a.p)) : null;
  let judgeCell = '-';
  if (j && j.skipped) judgeCell = 'not asked';
  else if (j && j.error) judgeCell = 'no answer';
  else if (asked.length) judgeCell = `${asked.length - low.length}/${asked.length} (min ${minP.toFixed(2).replace(/^0/, '')})`;
  if (stage.skipped) return { result: 'skip', checks: '-', judge: '-', note: stage.note || 'not reached' };
  const notes = checks.filter(c => !c.ok).map(c => c.why || c.name);
  if (j && j.error) notes.push(`the judge did not answer: ${j.error}`);
  if (low.length) notes.push(`judge doubts ${low.map(([id, a]) => `${DOUBT[id] || id} (p ${a.p.toFixed(2)})`).join(', ')}`);
  const note = notes.length ? notes.join('; ') : 'ok';
  const judgedOk = !stage.ask || !stage.ask.length || (j && j.skipped) || (j && j.answers && low.length === 0);
  return { result: !failed && judgedOk ? 'pass' : 'fail', checks: `${okChecks}/${checks.length}`, judge: judgeCell, note };
}

// ---- the walk over http --------------------------------------------------------------

function findOption(card, re) {
  return (card && card.options || []).find(o => !o.disabled && re.test(String(o.label || '')));
}

function needOption(card, re, what) {
  const o = findOption(card, re);
  if (!o) throw new Error(`this card has no ${what}`);
  return o;
}

const isIdea = c => Boolean(c && (c.kind === 'bet' || c.kind === 'idea'));

// The stage runner: each stage gets a screen, its own checks, and judge questions.
function stageRunner(adapter) {
  const stages = [];
  async function stage(name, fn, { ask = ['answers', 'next', 'plain'] } = {}) {
    const st = { name, card: null, extra: [], ask, did: null, note: null, skipped: false };
    try {
      await fn(st);
    } catch (err) {
      st.extra.push(check('the step worked', false, String((err && err.message) || err)));
    }
    if (!st.skipped) {
      const prev = st.card && st.card.id && st.card.kind === 'yes' ? previousServed(adapter.served, st.card.id) : null;
      // what this stage is for first, then the rules every screen keeps
      st.checks = [...st.extra, ...(st.card ? cardChecks(st.card, { prev }) : [])];
      if (!st.card && !st.extra.length) st.checks.push(check('a screen to check', false, 'nothing was on screen'));
      if (!st.card) st.ask = [];
    }
    stages.push(st);
    return st;
  }
  return { stages, stage };
}

function previousServed(served, id) {
  for (let i = served.length - 1; i > 0; i -= 1) if (served[i].id === id) return served[i - 1];
  return null;
}

// Taps the orb until a card like this shows. Real writers can take a while,
// so the calm line is waited out up to waitMs.
async function reach(a, want, { tries = 4, waitMs = 2000 } = {}) {
  let card = a.current();
  if (want(card)) return card;
  const end = Date.now() + waitMs;
  const step = waitMs > 10000 ? 3000 : 250;
  for (let i = 0; i < tries; i += 1) {
    card = await a.orb();
    while (card.kind === 'wait' && Date.now() < end) {
      await wait(step);
      card = await a.orb();
    }
    if (want(card)) return card;
  }
  return card;
}

async function walkHttp(a, world) {
  const { stages, stage } = stageRunner(a);
  const live = world.mode === 'real';
  // real writers take a minute or two for the first idea; later ones are written ahead
  const waitMs = live ? 240000 : 2000;
  const waitLater = live ? 60000 : 2000;
  const skip = (st, why) => { st.skipped = true; st.note = why; };

  await stage('first open', async (st) => {
    const page = await a.http.get('/');
    st.extra.push(check('the page loads', page.status === 200 && /<html/i.test(page.text), `the page answered ${page.status}`));
    st.extra.push(check('the page is locked down', /default-src 'none'/.test((page.headers && page.headers.get('content-security-policy')) || ''), 'no content security policy on the page'));
    st.card = await a.open();
  }, { ask: ['next', 'plain'] });

  await stage('the idea card', async (st) => {
    if (world.ideasReady) await world.ideasReady(a);
    st.did = 'tapped the orb';
    st.card = await reach(a, isIdea, { tries: live ? 6 : 3, waitMs });
    st.extra.push(check('an idea came', isIdea(st.card), `a ${st.card.kind} card came instead`));
  });

  await stage('tap an option, then the next card', async (st) => {
    const before = a.current();
    if (world.scoreboardOn) world.scoreboardOn();
    const o = findOption(before, /^sharper idea$/i) || (before.options || []).find(x => !x.disabled && !x.confirm && !x.typed && !x.nav);
    if (!o && live && !isIdea(before)) return skip(st, 'no idea came in time to tap');
    if (!o) throw new Error('this card has no option to tap');
    st.did = `tapped "${o.label}"`;
    st.card = await a.tap(o);
    st.extra.push(check('a new card came', st.card.id && st.card.id !== before.id, 'the same card stayed'));
  });

  let question = null;
  await stage('"something else", then "what"', async (st) => {
    const hasOther = c => Boolean(findOption(c, /something else/i));
    question = await reach(a, hasOther, { tries: live ? 6 : 3, waitMs: waitLater });
    if (!hasOther(question)) {
      if (live) return skip(st, 'no question with something else came in this copy');
      throw new Error('no question with "something else" came');
    }
    st.did = 'tapped "something else" and typed "what"';
    st.card = await a.tap(needOption(question, /something else/i, '"something else"'), 'what');
    st.extra.push(check('a reply came in words', Boolean(st.card.title) && st.card.title !== question.title, 'no reply came; the card stayed as it was'));
    if (world.savedNumber) st.extra.push(check('"what" saved nothing', !world.savedNumber(), `it saved "${world.savedNumber()}" as the number`));
  });

  await stage('a real answer, which saves', async (st) => {
    if (!question) return skip(st, 'the question was not reached');
    const card = a.current();
    const other = findOption(card, /something else/i);
    st.did = 'typed "paying schools" as the answer';
    if (other) st.card = await a.tap(other, 'paying schools');
    else st.card = await a.type(card, 'paying schools');
    const out = a.last() || {};
    if (world.savedNumber) st.extra.push(check('the answer was saved', world.savedNumber() === 'paying schools', world.savedNumber() ? `it saved "${world.savedNumber()}"` : 'nothing was saved'));
    else st.extra.push(check('the answer was saved', out.ok === true && !out.stay, 'the answer did not save'));
    st.extra.push(check('the next card came', st.card.id !== card.id && st.card.kind !== 'reply', 'the same card stayed'));
  });

  await stage('the weekly number card', async (st) => {
    st.card = await reach(a, c => c.kind === 'report', { tries: 2, waitMs: waitLater });
    if (st.card.kind !== 'report' && live) return skip(st, 'no weekly number is asked in this copy');
    st.extra.push(check('the weekly number is asked', st.card.kind === 'report', `a ${st.card.kind} card came instead`));
  });

  await stage('"not now" on the weekly number', async (st) => {
    const card = a.current();
    if (card.kind !== 'report') return live ? skip(st, 'no weekly number card to pass') : (() => { throw new Error('the weekly number card is not on screen'); })();
    st.did = 'tapped "not now"';
    st.card = await a.tap(needOption(card, /^not now$/i, '"not now"'));
    st.extra.push(check('it moved on', st.card.kind !== 'report', 'the weekly number card stayed'));
  });

  await stage('the team page', async (st) => {
    st.did = 'opened the team';
    st.card = await a.openTeam();
    st.extra.push(check('the team shows', st.card.layer === 'team' && Boolean(st.card.table && st.card.table.rows.length), 'no team rows'));
  }, { ask: ['next', 'plain'] });

  let swapBefore = 0;
  await stage('a swap card', async (st) => {
    const team = a.current();
    const eng = (team.options || []).find(o => o.action === 'swap' || /^swap:/.test(String(o.id)));
    if (!eng) throw new Error('the team has no engine to tap');
    st.did = `tapped the engine "${eng.label}"`;
    st.card = await a.tap(eng);
    swapBefore = st.card.options.filter(o => !o.back && !/^scope:/.test(String(o.id))).length;
    st.extra.push(check('models to pick from', st.card.layer === 'swap' && swapBefore > 1, 'no models listed'));
  });

  await stage('"more models"', async (st) => {
    const swap = a.current();
    if (swap.layer !== 'swap') throw new Error('the swap card is not on screen');
    st.did = 'tapped "more models"';
    st.card = await a.tap(needOption(swap, /more models/i, '"more models"'));
    const after = st.card.options.filter(o => !o.back && !/^scope:/.test(String(o.id))).length;
    st.extra.push(check('more models came', after > swapBefore, `the list stayed at ${after}`));
  });

  await a.close();
  await stage('the job deck', async (st) => {
    st.did = 'opened the jobs, one at a time';
    st.card = await a.openDeck();
    if (st.card.layer !== 'deck' && live) return skip(st, 'no job is running in this copy');
    st.extra.push(check('one job on screen', st.card.layer === 'deck', 'the deck did not open'));
  }, { ask: ['next', 'plain'] });

  await stage('flip the deck', async (st) => {
    const deck = a.current();
    if (deck.layer !== 'deck' && live) return skip(st, 'no job deck in this copy');
    if (deck.layer !== 'deck') throw new Error('the deck is not on screen');
    st.did = 'tapped "next"';
    st.card = await a.tap(needOption(deck, /^next$/i, '"next"'));
    st.extra.push(check('a different job', st.card.layer === 'deck' && JSON.stringify(st.card.table) !== JSON.stringify(deck.table), 'the same job stayed'));
  }, { ask: ['next', 'plain'] });

  await stage('"talk to this job"', async (st) => {
    const deck = a.current();
    if (deck.layer !== 'deck' && live) return skip(st, 'no job deck in this copy');
    if (!deck.input || !/talk to this job/i.test(String(deck.input.label || deck.input.placeholder))) throw new Error('this job has no "talk to this job" box');
    st.did = 'typed "what are you on right now?" to this job';
    st.card = await a.type(deck, 'what are you on right now?');
    st.extra.push(check('an answer came back', Boolean((st.card.thread && st.card.thread.length) || (st.card.line && st.card.line !== deck.line) || st.card.kind === 'reply'), 'nothing came back'));
  }, { ask: ['answers', 'next', 'plain'] });

  await a.close();
  if (world.addYesJobs) { world.addYesJobs(); await wait(700); }

  await stage('a yes card', async (st) => {
    st.did = 'tapped the orb';
    st.card = await reach(a, c => c.kind === 'yes', { tries: 3 });
    if (st.card.kind !== 'yes' && live) return skip(st, 'no job waits on a yes in this copy');
    st.extra.push(check('a yes card came', st.card.kind === 'yes', `a ${st.card.kind} card came instead`));
    const missing = [[/^yes$/i, 'yes'], [/^no$/i, 'no'], [/^not now$/i, 'not now']].filter(([re]) => !findOption(st.card, re)).map(([, w]) => `"${w}"`);
    st.extra.push(check('yes, no, and not now', missing.length === 0, `the yes card has no ${missing.join(' or ')}`));
  });

  // a missing answer is a failure, then the orb moves on, as a person would
  const passYes = async (st, re, label) => {
    const y = a.current();
    if (y.kind !== 'yes') return live ? skip(st, 'no yes card to answer') : (() => { throw new Error('no yes card is on screen'); })();
    const o = findOption(y, re);
    st.extra.push(check(`"${label}" is there`, Boolean(o), `the yes card has no "${label}", so the orb was tapped instead`));
    st.did = o ? `tapped "${label}"` : 'tapped the orb';
    st.card = o ? await a.tap(o) : await a.orb();
    st.extra.push(check('it moved on', st.card.id !== y.id, 'the same yes card stayed'));
    return undefined;
  };
  await stage('"no" on the yes card', st => passYes(st, /^no$/i, 'no'));
  await stage('"not now" on a yes card', async (st) => {
    if (a.current().kind !== 'yes' && !live) await reach(a, c => c.kind === 'yes', { tries: 3 });
    return passYes(st, /^not now$/i, 'not now');
  });
  await a.close();
  return stages;
}

// ---- the screen pass in headless chrome ------------------------------------------------

// Records every post the page sends and every card it is served, before any
// page script runs, so "every tap names the card" is read from real requests.
const RECORDER = `(function () {
  var W = window.__walk = { posts: [], cards: [] };
  var f = window.fetch;
  window.fetch = function (input, init) {
    var p = String(typeof input === 'string' ? input : (input && input.url) || '').split('?')[0];
    if (init && init.method === 'POST') { var b = null; try { b = JSON.parse(init.body); } catch (e) { b = null; } W.posts.push({ path: p, body: b, onCard: W.cards.length ? W.cards[W.cards.length - 1].id : null, home: !document.body.classList.contains('has-card') }); }
    return f.apply(this, arguments).then(function (r) {
      try { r.clone().json().then(function (j) { var c = j && j.card ? j.card : j; if (c && c.id && (j.card || j.bet || j.job || j.question || j.choice || j.report)) W.cards.push({ id: c.id, kind: c.kind || 'bet' }); }, function () {}); } catch (e) { /* not json */ }
      return r;
    });
  };
})()`;

// What is on screen: the top layer, its words, its buttons, and its boxes.
const SNAP = `(function () {
  function vis(n) { if (!n) return false; var s = getComputedStyle(n); if (s.display === 'none' || s.visibility === 'hidden') return false; var r = n.getBoundingClientRect(); return r.width > 0 && r.height > 0; }
  function txt(n) { return n ? n.textContent.replace(/\\s+/g, ' ').trim() : null; }
  var team = document.getElementById('team');
  var up = Boolean(team && !team.hidden && vis(team));
  var hasCard = document.body.classList.contains('has-card');
  var root = up ? (document.getElementById('team-inner') || team) : document.getElementById('bet');
  var active = document.activeElement;
  var typing = Boolean(active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA') && root && root.contains(active));
  var h1 = root ? root.querySelector('h1') : null;
  var layer = 'home';
  if (up) {
    if (root.querySelector('.deckcard')) layer = 'deck';
    else if (root.querySelector('table.roster') || txt(h1) === 'the team') layer = 'team';
    else if (root.querySelector('.models, .scopes')) layer = 'swap';
    else layer = 'talk';
  } else if (hasCard) layer = 'card';
  var W = window.__walk || { cards: [] };
  var last = W.cards.length ? W.cards[W.cards.length - 1] : null;
  var scope = layer === 'home' ? null : root;
  var buttons = scope ? Array.prototype.filter.call(scope.querySelectorAll('button'), vis) : [];
  var inputs = scope ? Array.prototype.filter.call(scope.querySelectorAll('input, textarea'), vis) : [];
  var orb = document.getElementById('orb');
  return {
    layer: layer, typing: typing,
    big_orb: Boolean(orb && vis(orb) && getComputedStyle(orb).visibility !== 'hidden' && !hasCard),
    id: layer === 'card' && last ? last.id : null, kind: layer === 'card' && last ? last.kind : layer,
    title: layer === 'home' ? txt(document.getElementById('line')) : txt(h1),
    body: scope ? Array.prototype.filter.call(scope.querySelectorAll('p.why'), vis).map(txt).join(' ') || null : null,
    line: scope ? Array.prototype.filter.call(scope.querySelectorAll('p.mission, p.done, .count, .label'), vis).map(txt).join(' ') || null : null,
    options: layer === 'home'
      ? [].concat(orb && vis(orb) ? [{ label: 'the orb', disabled: false }] : [], Array.prototype.filter.call(document.querySelectorAll('#working'), vis).map(function (b) { return { label: txt(b), disabled: false }; }))
      : buttons.map(function (b) { var tr = b.closest('tbody tr'); return { label: txt(b), disabled: b.disabled, row: tr ? Array.prototype.indexOf.call(tr.parentNode.children, tr) : null }; }).filter(function (o) { return o.label && o.label !== 'send' && o.label !== '\\u2026'; }),
    input: inputs.length ? { label: inputs[0].getAttribute('aria-label') || inputs[0].placeholder || 'a box', value: inputs[0].value } : null,
    table: scope && scope.querySelector('table') ? { columns: Array.prototype.map.call(scope.querySelectorAll('table th'), txt), rows: Array.prototype.map.call(scope.querySelectorAll('table tbody tr'), function (tr) { return Array.prototype.map.call(tr.querySelectorAll('td'), txt); }) } : null,
    posts: W.posts.length
  };
})()`;

// a screen read in chrome, as a card for the rules and the judge
function snapCard(s) {
  return {
    id: s.id, kind: s.layer === 'home' ? 'home' : (s.layer === 'card' ? s.kind : s.layer), layer: s.layer,
    title: s.title, body: s.body, line: s.line,
    options: s.options.map(o => ({ label: o.label, disabled: o.disabled, cell: o.row == null ? null : { row: o.row }, back: /^(close|back|back to the team|the whole team)$/i.test(o.label) })),
    input: s.input ? { label: s.input.label } : null, table: s.table, thread: [],
  };
}

async function walkBrowser(url, { chromePath, launch }) {
  const stages = [];
  const chrome = await launch(chromePath);
  const { send } = chrome;
  const run = async (expr) => {
    const out = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (out.exceptionDetails) throw new Error(`the page threw: ${out.exceptionDetails.exception ? out.exceptionDetails.exception.description : out.exceptionDetails.text}`);
    return out.result.value;
  };
  const until = async (expr, what, ms = 6000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await run(expr)) return true; await wait(40); }
    throw new Error(`waited ${Math.round(ms / 1000)}s for ${what}`);
  };
  const click = async (expr, what) => {
    const r = await run(`(function () { var n = ${expr}; if (!n) return null; n.scrollIntoView({ block: 'center' }); var b = n.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`);
    if (!r) throw new Error(`nothing to tap: ${what}`);
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: r.x, y: r.y });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: r.x, y: r.y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: r.x, y: r.y, button: 'left', clickCount: 1 });
  };
  const byText = (scope, re) => `Array.prototype.find.call(document.querySelectorAll(${JSON.stringify(`${scope} button`)}), function (b) { return ${re}.test(b.textContent.trim()) && b.getBoundingClientRect().width > 0; })`;
  const esc = async () => {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await wait(250);
  };
  const snap = () => run(SNAP);
  const settled = "document.body.classList.contains('has-card') && !document.querySelector('.bet.ghost') && !document.getElementById('bet').classList.contains('turning') && Boolean(document.querySelector('#bet h1'))";
  const teamUp = "(function () { var t = document.getElementById('team'); return Boolean(t && !t.hidden); })()";
  const postsSince = async n => (await run('window.__walk.posts')).slice(n);

  // one screen stage: fn returns { snap, extra }; posts during it must name the card
  async function stage(name, fn, ask = ['next', 'plain']) {
    const st = { name, card: null, extra: [], ask, did: null, skipped: false };
    let mark = 0;
    try {
      mark = (await run('window.__walk.posts.length')) || 0;
      await fn(st);
    } catch (err) {
      st.extra.push(check('the step worked', false, String((err && err.message) || err)));
    }
    try {
      const posts = (await postsSince(mark)).filter(p => !p.home);
      const unnamed = posts.filter(p => !(p.body && p.onCard && (p.body.card_id === p.onCard || p.body.card === p.onCard)));
      if (posts.length) st.extra.push(check('every tap names the card', unnamed.length === 0, `${unnamed.map(p => p.path).slice(0, 2).join(', ')} sent no card id`));
    } catch { /* the page is gone; the step already failed */ }
    st.checks = [...st.extra, ...(st.card ? cardChecks(st.card).filter(c => c.name !== 'every tap names the card') : [])];
    if (!st.card) st.ask = [];
    stages.push(st);
  }

  const toCard = async () => {
    for (let i = 0; i < 4 && await run(teamUp); i += 1) await esc();
    if (!(await run("document.body.classList.contains('has-card')"))) {
      await click("document.getElementById('orb')", 'the big orb');
      await until(settled, 'a card', 8000);
    }
    await wait(300);
  };
  const openTeam = async () => {
    await click("document.getElementById('working')", 'the team link');
    await until(`${teamUp} && Boolean(document.querySelector('#team .row, #team .why'))`, 'the team', 6000);
    await wait(250);
  };
  const escTo = async (st, want, from) => {
    await esc();
    const after = await snap();
    const where = { card: 'the card', home: 'the big orb', team: 'the team page', talk: 'a talk card', swap: 'a swap card', deck: 'the job deck' };
    st.extra.push(check(`Esc on the ${from} leads back`, want.includes(after.layer), want.includes(after.layer) ? '' : `Esc on the ${from} went to ${where[after.layer] || after.layer}, not back one step`));
    return after;
  };

  try {
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
    await send('Page.enable');
    await send('Page.addScriptToEvaluateOnNewDocument', { source: RECORDER });
    await send('Page.navigate', { url });
    await until("document.readyState === 'complete'", 'the page', 10000);
    await wait(800);

    await stage('Esc on the typing box', async (st) => {
      await toCard();
      const say = await run(`Boolean(${byText('#bet', '/^(or say something|say something)$/i')})`);
      if (say) await click(byText('#bet', '/^(or say something|say something)$/i'), 'the say line');
      else await click(byText('#bet', '/^something else$/i'), 'something else');
      await until("document.activeElement && document.activeElement.tagName === 'INPUT'", 'the cursor in the box', 3000);
      await send('Input.insertText', { text: 'hello' });
      const typing = await snap();
      st.did = 'opened the box, typed "hello", pressed Esc';
      st.card = snapCard(typing);
      await esc();
      const after = await snap();
      st.extra.push(check('Esc on the box leads back', typing.typing && !after.typing && after.layer === 'card' && !(after.input && after.input.value), 'Esc left the box open'));
    });

    await stage('Esc on the team page', async (st) => {
      await toCard();
      await openTeam();
      const team = await snap();
      st.did = 'opened the team, pressed Esc';
      st.card = snapCard(team);
      await escTo(st, ['card'], 'team page');
    });

    await stage('Esc on a talk card', async (st) => {
      await toCard();
      await openTeam();
      await click("document.querySelector('#team .row .who button')", 'a member');
      await until("Boolean(document.querySelector('#team input'))", 'the talk card', 4000);
      st.card = snapCard(await snap());
      st.did = 'opened a member, pressed Esc twice';
      const after = await escTo(st, ['team'], 'talk card');
      if (after.layer === 'team') await escTo(st, ['card'], 'team page');
    });

    await stage('Esc on a swap card', async (st) => {
      await toCard();
      await openTeam();
      await click("document.querySelector('#team .eng button')", 'an engine');
      await until("Boolean(document.querySelector('#team .models, #team .scopes')) || /could not|did not/.test(document.getElementById('team-inner').textContent)", 'the swap card', 6000);
      st.card = snapCard(await snap());
      st.did = 'tapped an engine, pressed Esc twice';
      const after = await escTo(st, ['team'], 'swap card');
      if (after.layer === 'team') await escTo(st, ['card'], 'team page');
    });

    await stage('Esc on the job deck', async (st) => {
      await toCard();
      await openTeam();
      await click(byText('#team', '/^the jobs, one at a time$/i'), 'the jobs, one at a time');
      await until("Boolean(document.querySelector('#team .deckcard'))", 'the job deck', 6000);
      st.card = snapCard(await snap());
      st.did = 'opened the job deck, pressed Esc';
      const after = await escTo(st, ['team', 'card'], 'job deck');
      if (after.layer === 'team') await escTo(st, ['card'], 'team page');
    });

    let leftTitle = null;
    await stage('the small orb goes home', async (st) => {
      await toCard();
      const before = await snap();
      leftTitle = before.title;
      st.did = 'tapped the small orb on a card';
      await click("document.getElementById('lava')", 'the small orb');
      await until("!document.body.classList.contains('has-card')", 'the big dots', 5000).catch(() => {});
      await wait(700);
      const home = await snap();
      st.extra.push(check('the small orb leads home', home.layer === 'home' && home.big_orb, home.layer === 'home' ? 'the big dots did not come back' : 'the card stayed'));
      st.card = snapCard(home);
    });

    await stage('the big orb brings the next idea', async (st) => {
      st.did = 'tapped the big orb';
      await click("document.getElementById('orb')", 'the big orb');
      await until(settled, 'the next card', 8000);
      await wait(400);
      const next = await snap();
      st.extra.push(check('a new card came', next.layer === 'card' && next.title && next.title !== leftTitle, 'the same card came back'));
      st.card = snapCard(next);
    }, ['answers', 'next', 'plain']);
  } finally {
    chrome.close();
  }
  return stages;
}

// ---- the report ---------------------------------------------------------------------

function wrapWords(text, width) {
  const out = [];
  let line = '';
  for (let word of String(text).split(/\s+/)) {
    while (word.length > width) { if (line) { out.push(line); line = ''; } out.push(word.slice(0, width)); word = word.slice(width); }
    const next = line ? `${line} ${word}` : word;
    if (next.length > width && line) { out.push(line); line = word; } else line = next;
  }
  out.push(line);
  return out;
}

// A divided box: one header row, a rule under it, one row per stage, and
// the last column wraps to fit the width.
function renderTable(rows, { width = 110 } = {}) {
  const head = ['stage', 'checks', 'judge', 'result', 'note'];
  const cells = rows.map(r => [r.stage, r.checks, r.judge, r.result, r.note]);
  const widths = head.map((h, i) => Math.max(h.length, ...cells.map(c => String(c[i]).length)));
  const fixed = widths.slice(0, 4).reduce((a, b) => a + b, 0) + 3 * 5 + 1;
  widths[4] = Math.max(12, Math.min(widths[4], width - fixed - 3));
  const rule = (l, m, r) => `${l}${widths.map(w => '─'.repeat(w + 2)).join(m)}${r}`;
  const line = parts => `│ ${parts.map((p, i) => String(p).padEnd(widths[i])).join(' │ ')} │`;
  const out = [rule('┌', '┬', '┐'), line(head), rule('├', '┼', '┤')];
  for (const c of cells) {
    const note = wrapWords(c[4], widths[4]);
    const stage = wrapWords(c[0], widths[0]);
    const h = Math.max(note.length, stage.length);
    for (let i = 0; i < h; i += 1) out.push(line([stage[i] || '', i ? '' : c[1], i ? '' : c[2], i ? '' : c[3], note[i] || '']));
  }
  out.push(rule('└', '┴', '┘'));
  return out.join('\n');
}

// ---- starting the server ---------------------------------------------------------------

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

// The server's env: no judge keys, and every atris state file under the
// temp folder. The made-up world gets a temp HOME. A real copy keeps HOME so
// its writers can use the claude login, and points atris state at the temp
// folder through the same fence the tests use (lib/state-home.js).
function childEnv(env, home, { keepHome = false } = {}) {
  const out = { ...env, ATRIS_SKIP_UPDATE_CHECK: '1', NO_UPDATE_NOTIFIER: '1' };
  for (const name of KEY_NAMES) delete out[name];
  delete out.NODE_TEST_CONTEXT;
  if (keepHome) {
    out.ATRIS_TEST_STATE_DIR = home;
    out.ATRIS_TASKS_DB = path.join(home, '.atris', 'tasks.db');
    out.ATRIS_PROGRESS_DIR = path.join(home, '.atris', 'progress');
  } else {
    out.HOME = home;
    delete out.ATRIS_TEST_STATE_DIR;
  }
  return out;
}

function stopChild(child) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null) { resolve(); return; }
    const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } resolve(); }, 3000);
    child.once('exit', () => { clearTimeout(t); resolve(); });
    try { child.kill('SIGTERM'); } catch { clearTimeout(t); resolve(); }
  });
}

// the made-up workspace, served by scripts/orb-walk-fixture.js in its own process
async function startFixture(root, env) {
  const fixture = require('./orb-walk-fixture');
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { recursive: true });
  const ws = fixture.makeWorkspace(path.join(root, 'workspace'));
  const stateDir = path.join(home, '.atris', 'state');
  const token = crypto.randomBytes(32).toString('base64url');
  const child = spawn(process.execPath, [path.join(__dirname, 'orb-walk-fixture.js'), ws, token], { cwd: root, env: childEnv(env, home), stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  child.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
  const port = await new Promise((resolve, reject) => {
    let buf = '';
    const t = setTimeout(() => reject(new Error(`the phone server did not start: ${err.trim()}`)), 15000);
    child.stdout.on('data', (d) => {
      buf += d;
      const m = buf.match(/\{"port":(\d+)\}/);
      if (m) { clearTimeout(t); resolve(Number(m[1])); }
    });
    child.on('exit', (code) => { clearTimeout(t); reject(new Error(`the phone server stopped (${code}): ${err.trim()}`)); });
  });
  const base = `http://127.0.0.1:${port}`;
  const gmBet = require('../lib/gm-bet');
  return {
    base, token, url: `${base}/?t=${token}`, stop: () => stopChild(child),
    world: {
      mode: 'fixture',
      scoreboardOn: () => fixture.scoreboardOn(ws),
      addYesJobs: () => fixture.addYesJobs(ws, stateDir),
      savedNumber: () => { const b = gmBet.readScoreboard(gmBet.scoreboardPath(stateDir), ws); return b ? b.name : null; },
      // the writers answer at once; wait until the first idea is queued
      ideasReady: async (a) => {
        if (!a.peek) return;
        for (let i = 0; i < 50; i += 1) { const s = await a.peek(); if (s.queue > 0) return; await wait(100); }
      },
    },
  };
}

// a copy of a real workspace's atris folder, served by the real atris gm phone
async function startRealCopy(root, source, env) {
  const src = path.resolve(source);
  if (!fs.existsSync(path.join(src, 'atris'))) throw new Error(`there is no atris folder in ${src}`);
  const home = path.join(root, 'home');
  const ws = path.join(root, 'workspace');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(ws, { recursive: true });
  fs.cpSync(path.join(src, 'atris'), path.join(ws, 'atris'), { recursive: true, filter: p => !/[\\/]node_modules([\\/]|$)/.test(p) });
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(REPO, 'bin', 'atris.js'), 'gm', 'phone', '--port', String(port), '--workspace', ws], { cwd: ws, env: childEnv(env, home, { keepHome: true }), stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  child.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
  const token = await new Promise((resolve, reject) => {
    let buf = '';
    const t = setTimeout(() => reject(new Error(`atris gm phone did not start: ${err.trim() || buf.trim().slice(-300)}`)), 30000);
    child.stdout.on('data', (d) => {
      buf += d;
      const m = buf.match(/\/\?t=([A-Za-z0-9_-]{43})/);
      if (m) { clearTimeout(t); resolve(m[1]); }
    });
    child.on('exit', (code) => { clearTimeout(t); reject(new Error(`atris gm phone stopped (${code}): ${err.trim() || buf.trim().slice(-300)}`)); });
  });
  const base = `http://127.0.0.1:${port}`;
  return { base, token, url: `${base}/?t=${token}`, stop: () => stopChild(child), world: { mode: 'real' } };
}

// ---- the command ------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = { realCopy: null, threshold: DEFAULT_THRESHOLD, judge: null, browser: true, json: false, keep: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const value = () => { const v = argv[i + 1]; if (v == null || v.startsWith('--')) throw new Error(`${a} needs a value`); i += 1; return v; };
    if (a === '--help' || a === '-h' || a === 'help') opts.help = true;
    else if (a === '--real-copy') opts.realCopy = value();
    else if (a.startsWith('--real-copy=')) opts.realCopy = a.slice(12);
    else if (a === '--threshold') opts.threshold = Number(value());
    else if (a.startsWith('--threshold=')) opts.threshold = Number(a.slice(12));
    else if (a === '--judge') opts.judge = value();
    else if (a.startsWith('--judge=')) opts.judge = a.slice(8);
    else if (a === '--no-judge') opts.judge = 'none';
    else if (a === '--no-browser') opts.browser = false;
    else if (a === '--json') opts.json = true;
    else if (a === '--keep') opts.keep = true;
    else throw new Error(`unknown option ${a}`);
  }
  if (!(opts.threshold > 0 && opts.threshold <= 1)) throw new Error('--threshold takes a number over 0 and up to 1, like 0.8');
  return opts;
}

const HELP = [
  'Usage: atris gm walk [--real-copy <workspace>] [--threshold 0.8] [--judge typesafe|openai|codex] [--no-judge] [--no-browser] [--json] [--keep]',
  '',
  'Walks every stage of the orb on the phone page and prints one row per stage.',
  'It starts the phone server on a free port with a temp home and a made-up',
  'workspace, taps through each stage over http the way the page does, then',
  'drives the real page once in headless Chrome for Esc, the small orb, and',
  'the big orb. Your real workspace and ~/.atris are never touched.',
  '',
  'Each stage passes when the rules hold (a way forward, no option twice, no',
  'command, flag, or path in the words, every tap names the card on screen,',
  'never two yes cards in a row, Esc and the small orb lead somewhere) and a',
  'fast judge says yes, with p at or over the threshold, to: do these options',
  'answer the question shown, would a busy founder know what to do next, and',
  'is this plain language. The judge is TypeSafe Jev when TYPESAFE_API_KEY is',
  'set, else OpenAI when OPENAI_API_KEY is set, else codex exec read-only.',
  'ATRIS_WALK_TYPESAFE_MODEL, ATRIS_WALK_OPENAI_MODEL, and ATRIS_WALK_CODEX_MODEL',
  'pick the judge\'s model. Keys are only ever sent to their own api.',
  '',
  '  --real-copy <ws>  copy that workspace\'s atris folder into the temp folder',
  '                    and run the real atris gm phone with the real writers;',
  '                    HOME stays yours only for the claude login, and every',
  '                    atris state file goes to the temp folder',
  '  --threshold <p>   the p each judged answer must reach (default 0.8)',
  '  --judge <name>    use this judge instead of the first one with a key',
  '  --no-judge        rules only, no judge',
  '  --no-browser      skip the Chrome pass',
  '  --json            print the report as json',
  '  --keep            keep the temp workspace and home',
  '',
  'Exit 0 only when every stage passes. The report is also saved to a temp file.',
].join('\n');

// The whole walk, for main and the tests. Returns the stages and the rows.
async function walk({ server, judge, threshold = DEFAULT_THRESHOLD, browser = true, chromePath = null, launch = null, env = process.env }) {
  const http = client(server.base, server.token);
  const adapter = await pickAdapter(http);
  const stages = await walkHttp(adapter, server.world);
  if (browser) {
    if (!chromePath) stages.push({ name: 'the screen pass', checks: [check('chrome to drive the page', false, 'no chrome found; set CHROME_PATH or pass --no-browser')], ask: [] });
    else {
      try {
        stages.push(...await walkBrowser(server.url, { chromePath, launch }));
      } catch (err) {
        stages.push({ name: 'the screen pass', checks: [check('the page opened in chrome', false, String((err && err.message) || err))], ask: [] });
      }
    }
  }
  await judgeStages(stages, judge, { concurrency: judge && /^codex/.test(judge.name) ? 6 : 8, env });
  const rows = stages.map(s => ({ stage: s.name, ...stageResult(s, threshold) }));
  return { mode: adapter.mode, stages, rows };
}

async function main(argv = [], { env = process.env, stdout = process.stdout, stderr = process.stderr } = {}) {
  let opts;
  try { opts = parseArgs(argv); } catch (err) { stderr.write(`${err.message}\n`); return 2; }
  if (opts.help) { stdout.write(`${HELP}\n`); return 0; }
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'atris-orb-walk-'));
  const judgeDir = path.join(root, 'judge');
  fs.mkdirSync(judgeDir);
  let server = null;
  const started = Date.now();
  try {
    let judge;
    try { judge = pickJudge({ env, which: opts.judge, dir: judgeDir }); } catch (err) { stderr.write(`${redact(err.message, env)}\n`); return 2; }
    stdout.write(opts.realCopy ? `copying ${path.resolve(opts.realCopy)}'s atris folder into a temp folder and starting atris gm phone...\n` : 'starting the phone page on a made-up workspace...\n');
    server = opts.realCopy ? await startRealCopy(root, opts.realCopy, env) : await startFixture(root, env);
    const trace = opts.browser ? require('./gm-phone-trace') : null;
    stdout.write(`walking the stages, then asking ${judge ? judge.name : 'no judge'}...\n`);
    const out = await walk({ server, judge, threshold: opts.threshold, browser: opts.browser, chromePath: trace ? trace.findChrome() : null, launch: trace ? trace.launch : null, env });
    const passed = out.rows.filter(r => r.result === 'pass').length;
    const seconds = Math.round((Date.now() - started) / 1000);
    const head = `${opts.realCopy ? 'a copy of a real workspace' : 'made-up workspace'}, ${out.mode === 'contract' ? 'one-card contract' : 'today\'s /bet cards'}, judge ${judge ? judge.name : 'off'}, threshold ${opts.threshold}${opts.browser ? '' : ', no chrome pass'}`;
    const table = renderTable(out.rows, { width: Math.max(90, Math.min(140, (stdout.columns || 120))) });
    const summary = `${passed} of ${out.rows.length} stages passed in ${seconds}s.`;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const reportFile = path.join(fs.realpathSync(os.tmpdir()), `atris-orb-walk-${stamp}.txt`);
    const json = { schema: 'atris.orb_walk.v1', at: new Date().toISOString(), mode: out.mode, world: server.world.mode, judge: judge ? judge.name : null, threshold: opts.threshold, rows: out.rows, stages: out.stages.map(s => ({ name: s.name, did: s.did || null, screen: s.card ? judgeScreen(s).screen : null, checks: s.checks || [], judged: s.judged || null, skipped: Boolean(s.skipped) })) };
    fs.writeFileSync(reportFile, redact(`${head}\n${table}\n${summary}\n`, env));
    fs.writeFileSync(reportFile.replace(/\.txt$/, '.json'), redact(`${JSON.stringify(json, null, 2)}\n`, env));
    if (opts.json) stdout.write(`${redact(JSON.stringify({ ...json, report: reportFile }, null, 2), env)}\n`);
    else stdout.write(redact(`\n${head}\n${table}\n${summary}\nreport: ${reportFile}\n`, env));
    return out.rows.every(r => r.result === 'pass') ? 0 : 1;
  } catch (err) {
    stderr.write(`${redact(`the walk stopped: ${(err && err.message) || err}`, env)}\n`);
    return 2;
  } finally {
    if (server) await server.stop();
    if (!opts.keep) fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
    else stdout.write(`kept ${root}\n`);
  }
}

module.exports = {
  CONTRACT,
  QUESTIONS,
  cardChecks,
  rawBit,
  pickJudge,
  typesafeJudge,
  openaiJudge,
  codexJudge,
  judgeStages,
  stageResult,
  redact,
  renderTable,
  legacyAdapter,
  contractAdapter,
  startFixture,
  walk,
  main,
};

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
