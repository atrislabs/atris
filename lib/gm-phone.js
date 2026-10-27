'use strict';

// gm phone: the owner runs the business from a phone by tapping decision
// cards. The Mac serves one page over home wifi; every request needs a
// random token, and every action maps to a real atris command chosen here on
// the server (the page only sends a card id and a choice id).
//
// The core is pure: a view (board plus every review and stuck row) goes in,
// ranked cards come out. createPhoneHandler wires it to http with the
// command runner, the clock, and the file paths passed in, so tests can stub
// the runner and never touch real data.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');

const CARD_LIMIT = 5;
const CONFIRM_MS = 5000;
// a typed send's id, and how many and how long sends are remembered
const SEND_ID = /^[a-z0-9]{8,32}$/;
const SENDS_KEPT = 50;
const SENDS_MS = 10 * 60 * 1000;
const UNDO_MS = 5000;
// the server keeps an undo a little past the toast so a slow tap still counts
const UNDO_GRACE_MS = 3000;
const BODY_MAX = 4096;
const SEND_BACK_NOTE = 'sent back from the phone: the owner wants another pass';
const MEMBER_NAME_RE = /^[a-zA-Z0-9._-]+$/;
// `atris task auto-accept-certified` takes 12 rows a run unless --all.
const ACCEPT_PAGE = 12;

function plural(n, one, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

function listWords(names) {
  if (names.length <= 1) return names.join('');
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

function initials(name) {
  const parts = String(name || '').split(/[-_.\s]+/).filter(Boolean);
  if (parts.length >= 2) return `${parts[0][0]}${parts[1][0]}`.toLowerCase();
  return String(name || '?').slice(0, 2).toLowerCase();
}

function tone(status) {
  const s = String(status || '');
  if (s === 'on a job') return 'working';
  if (s.startsWith('stuck')) return 'stuck';
  if (s.startsWith('waiting on review')) return 'waiting';
  if (s === 'asleep') return 'asleep';
  return 'idle';
}

// The command the reviewer card runs: the same certify-then-accept pass the
// hourly autoland heartbeat runs, with the same policy flags. It lands only
// what a second actor re-checked; protected lanes and jobs with no runnable
// check wait for the owner. Null when the standing policy is off, because
// then every accept is the owner's own call.
function reviewerCommand(policy) {
  if (!policy || !policy.authorized) return null;
  const args = ['task', 'auto-accept-certified', '--json', '--certify-first'];
  if (policy.accept_all) args.push('--all');
  else if (policy.strict_verify === false) args.push('--no-strict-verify');
  return args;
}

// The same quoting the playable board shows, so the log reads the same.
function displayCommand(args) {
  return require('../commands/gm').displayCommand(args);
}

// ---- cards ---------------------------------------------------------------------

function reviewCard(view) {
  const reviews = view.reviews || [];
  if (!reviews.length) return null;
  const n = reviews.length;
  const oldest = reviews[0];
  const reviewer = reviewerCommand(view.policy);
  const pass = view.policy && view.policy.accept_all ? n : Math.min(n, ACCEPT_PAGE);
  const jobs = reviews.slice(0, 3).map(r => ({ ref: r.ref || r.task_id, task_id: r.task_id, title: r.title, member: r.member, age: r.age }));
  const choices = [];
  if (reviewer) {
    choices.push({
      id: 'check',
      label: 'have the reviewer check them',
      effect: `up to +${pass} toward your target`,
      member: 'reviewer',
      ack: `reviewer: on it, checking ${plural(n, 'job')}`,
      confirm: true,
      steps: [reviewer],
    });
  }
  choices.push({
    id: 'oldest',
    label: 'show me the oldest 3',
    effect: 'approve or send back one at a time',
    view: 'oldest',
  });
  choices.push({ id: 'later', label: 'later' });
  return {
    id: 'review',
    text: `${plural(n, 'job')} ${n === 1 ? 'is' : 'are'} waiting on review. the oldest has waited ${oldest.age}.`,
    moves: reviewer ? pass : Math.min(n, 3),
    choices,
    jobs,
  };
}

function stuckCard(view) {
  const stuck = (view.stuck || []).filter(s => MEMBER_NAME_RE.test(String(s.member || '')));
  if (!stuck.length) return null;
  const n = stuck.length;
  const holders = [...new Set(stuck.map(s => s.member))];
  return {
    id: 'stuck',
    text: `${plural(n, 'job')} ${n === 1 ? 'is' : 'are'} stuck with ${listWords(holders)}. nothing moved on ${n === 1 ? 'it' : 'them'} for 6h or more, the oldest ${stuck[0].age}.`,
    moves: n,
    choices: [
      {
        id: 'free',
        label: `free the ${n} so others can take them`,
        effect: `${plural(n, 'job')} back in the queue, counts as ${plural(n, 'drop')}`,
        member: 'front office',
        ack: `front office: freeing ${plural(n, 'job')}`,
        confirm: true,
        steps: stuck.map(s => ['task', 'release', s.ref || s.task_id, '--as', s.member]),
      },
      {
        id: 'nudge',
        label: 'nudge the players',
        effect: `wakes ${listWords(holders)}`,
        member: holders[0],
        ack: `${listWords(holders)}: on it`,
        confirm: true,
        steps: holders.map(h => ['member', 'wake', h]),
      },
      { id: 'later', label: 'later' },
    ],
  };
}

function targetCard(view) {
  if (view.target) return null;
  const def = view.target_default || { landed: 1, max_abandoned: 2, max_stuck: 0 };
  const lower = Math.ceil(def.landed / 2);
  const setTo = landed => ({ landed, max_abandoned: def.max_abandoned, max_stuck: def.max_stuck });
  const choices = [{
    id: 'set',
    label: `set this week's target: ${def.landed}`,
    effect: `${def.landed} landed, at most ${def.max_abandoned} abandoned, ${def.max_stuck} stuck over a day`,
    member: 'front office',
    ack: `front office: target set to ${def.landed}`,
    local: true,
    target: setTo(def.landed),
  }];
  if (lower < def.landed) {
    choices.push({
      id: 'lower',
      label: `set a lower one: ${lower}`,
      effect: `${lower} landed, same limits`,
      member: 'front office',
      ack: `front office: target set to ${lower}`,
      local: true,
      target: setTo(lower),
    });
  }
  choices.push({ id: 'later', label: 'later' });
  return {
    id: 'target',
    text: `no target set for this week. over the last 4 weeks you landed about ${def.landed} a week.`,
    moves: null,
    choices,
  };
}

// Every card the view supports, ranked by how much it moves the weekly
// target. With no target set, the target card leads: it is one cheap,
// undoable tap, and every other card's "+N toward your target" counts
// against it. Ties keep review ahead of stuck.
function buildCards(view) {
  const order = { target: 0, review: 1, stuck: 2 };
  const cards = [targetCard(view), reviewCard(view), stuckCard(view)].filter(Boolean);
  return cards.sort((a, b) => {
    if ((a.moves == null) !== (b.moves == null)) return a.moves == null ? -1 : 1;
    return (b.moves || 0) - (a.moves || 0) || order[a.id] - order[b.id];
  });
}

// The cards still to show this session: snoozed or decided cards drop out,
// and after CARD_LIMIT decisions the session is all clear.
function sessionCards(cards, session = {}) {
  const snoozed = session.snoozed || new Set();
  if ((session.decided || 0) >= CARD_LIMIT) return [];
  return cards.filter(c => !snoozed.has(c.id)).slice(0, CARD_LIMIT - (session.decided || 0));
}

// The choice a tap names, resolved against cards built from current state.
// Job buttons on the oldest-3 view are approve:<ref> and sendback:<ref>.
function resolveChoice(cards, cardId, choiceId) {
  const card = cards.find(c => c.id === cardId);
  if (!card) return null;
  const direct = card.choices.find(c => c.id === choiceId);
  if (direct) return { card, choice: direct };
  const m = /^(approve|sendback):(.+)$/.exec(String(choiceId || ''));
  if (card.id !== 'review' || !m) return null;
  const job = (card.jobs || []).find(j => String(j.ref) === m[2]);
  if (!job) return null;
  const approve = m[1] === 'approve';
  return {
    card,
    job,
    choice: {
      id: choiceId,
      label: approve ? `approve ${job.ref}` : `send back ${job.ref}`,
      member: job.member,
      ack: approve ? `${job.member}: thanks, landing it` : `${job.member}: on it, taking another pass`,
      confirm: true,
      keepCard: true,
      steps: [approve ? ['task', 'accept', job.ref] : ['task', 'revise', job.ref, '--note', SEND_BACK_NOTE]],
    },
  };
}

// What the page needs to draw a card: no commands, only words and flags.
function publicCard(card) {
  if (!card) return null;
  return {
    id: card.id,
    text: card.text,
    choices: card.choices.map(c => ({
      id: c.id,
      label: c.label,
      effect: c.effect || null,
      ack: c.ack || null,
      confirm: Boolean(c.confirm),
      local: Boolean(c.local),
      view: c.view || null,
      commands: (c.steps || []).map(displayCommand),
    })),
    jobs: card.jobs || null,
  };
}

// ---- the strip, the live line, and outcomes ---------------------------------------

function targetStrip(view) {
  const t = view.target;
  if (t) {
    return {
      line: `${t.landed} of ${t.target.landed} landed, ${t.verdict}`,
      landed: t.landed,
      goal: t.target.landed,
      verdict: t.verdict,
    };
  }
  const landed = view.landed_this_week || 0;
  return { line: `${landed} landed this week, no target yet`, landed, goal: null, verdict: null };
}

function agoLabel(ms) {
  const mins = Math.max(0, Math.round(ms / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function liveLine(view, now) {
  const play = (view.last_plays || [])[0];
  if (!play) return 'no task events yet';
  return `${play.member} ${play.play} "${play.title}" ${agoLabel(now - Number(play.at || 0))}`;
}

// After a command exits: the exit code plus what the task list did since the
// tap. Never calls a model.
function actionOutcome(action, outcomes = [], { tally } = {}) {
  if (action.status === 'running') return action.ack;
  const after = outcomes.filter(o => Number(o.at) >= Number(action.started_at));
  const t = tally(after);
  const parts = [];
  if (t.landed) parts.push(`${t.landed} landed`);
  if (t.sent_back) parts.push(`${t.sent_back} sent back`);
  if (t.dropped) parts.push(`${t.dropped} dropped`);
  if (t.abandoned) parts.push(`${t.abandoned} abandoned`);
  const events = parts.length ? `since you tapped: ${parts.join(', ')}` : 'no task events since you tapped';
  if (action.exit_code === 0) return `${action.member}: done. ${events}`;
  const tail = action.last_line ? ` (${action.last_line})` : '';
  return `${action.member}: did not finish, exit code ${action.exit_code}${tail}. ${events}`;
}

// ---- requests ------------------------------------------------------------------------

function tokenMatches(given, token) {
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(String(token || ''));
  return a.length === b.length && b.length > 0 && crypto.timingSafeEqual(a, b);
}

// Every request needs the right token. GET takes it in the link (?t=) or the
// x-gm-token header; POST only in the header, and only from the page's own
// origin. The Host header must name an address this server listens on, so a
// look-alike hostname pointed at the Mac gets nothing.
function checkRequest(req, { token, hosts = [] }) {
  const host = String(req.headers.host || '').toLowerCase();
  let url;
  try {
    const target = req.url || '/';
    url = new URL(target, 'http://local');
    if (!target.startsWith('/') || target.startsWith('//') || /[\\#\0]/.test(target) || decodeURIComponent(url.pathname).includes('\0')) throw new Error('url');
    decodeURIComponent(target);
  } catch {
    return { ok: false, status: 400, reason: 'url' };
  }
  if (!hosts.includes(host)) return { ok: false, status: 403, reason: 'host' };
  // Another site is refused on every route, reads too: a page in the owner's
  // browser that holds the key could otherwise read his cards. A fetch says
  // where it came from in Origin or Sec-Fetch-Site; a scan or a typed link
  // says none, and a plain client says nothing. The one exception is a
  // top-level open of the page itself (a link tapped in a mail or chat app):
  // a navigation cannot read anything, and the page load starts no work.
  if (req.headers.origin != null && String(req.headers.origin) !== `http://${host}`) return { ok: false, status: 403, reason: 'origin' };
  const site = String(req.headers['sec-fetch-site'] || '').toLowerCase();
  const pageOpen = req.method === 'GET' && url.pathname === '/'
    && String(req.headers['sec-fetch-mode'] || '').toLowerCase() === 'navigate'
    && String(req.headers['sec-fetch-dest'] || '').toLowerCase() === 'document';
  if (site && site !== 'same-origin' && site !== 'none' && !pageOpen) return { ok: false, status: 403, reason: 'site' };
  const header = req.headers['x-gm-token'];
  if (req.method === 'GET') {
    if (!tokenMatches(url.searchParams.get('t') || header, token)) return { ok: false, status: 403, reason: 'token' };
    if (req.headers['transfer-encoding'] || Number(req.headers['content-length'] || 0) > 0) return { ok: false, status: 400, reason: 'body' };
    return { ok: true, path: url.pathname };
  }
  if (req.method === 'POST') {
    if (!tokenMatches(header, token)) return { ok: false, status: 403, reason: 'token' };
    if (String(req.headers.origin || '') !== `http://${host}`) return { ok: false, status: 403, reason: 'origin' };
    return { ok: true, path: url.pathname };
  }
  if (!tokenMatches(url.searchParams.get('t') || header, token)) return { ok: false, status: 403, reason: 'token' };
  return { ok: false, status: 405, reason: 'method' };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      if (size > BODY_MAX) return;
      size += chunk.length;
      if (size > BODY_MAX) {
        reject(new Error('too_large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// ---- the handler ----------------------------------------------------------------------

function appendLog(logPath, row) {
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, `${JSON.stringify(row)}\n`);
  } catch {
    // the log is a receipt, never a reason to fail the tap
  }
}

// deps:
//   workspaceRoot, token, hosts   who and where
//   loadView()                    -> view (see loadPhoneView)
//   runStep(args)                 -> Promise<{ code, last_line }>, one atris command
//   writeTarget(target)           -> boolean; snapshotTarget() -> restore fn
//   logPath, now(), page(nonce, first)   receipts, clock, html (first: the card on screen now)
//   makeBetDesk(log)              -> optional bet desk (lib/gm-bet createBetDesk)
function createPhoneHandler(deps) {
  const now = deps.now || Date.now;
  const tally = deps.tally || require('./gm-season').tally;
  const session = { decided: 0, snoozed: new Set() };
  const actions = [];
  let undo = null;
  let seq = 0;

  const log = (row) => appendLog(deps.logPath, { at: new Date(now()).toISOString(), workspace: deps.workspaceRoot, ...row });
  const orbModel = () => deps.orbModel || require('./orb-model');
  const bet = deps.makeBetDesk ? deps.makeBetDesk(log) : null;

  // The steps of a started bet that need the owner's yes come first, then the
  // cards built from the task list.
  function deck(view) {
    return sessionCards([...(bet ? bet.yesCards() : []), ...buildCards(view)], session);
  }

  function state() {
    const view = deps.loadView();
    const cards = deck(view);
    const running = actions.filter(a => a.status === 'running');
    const stillRunning = [
      ...(view.roster || []).filter(r => tone(r.status) === 'working').map(r => `${r.name} is on a job`),
      ...running.map(a => `${a.member}: ${a.label}`),
    ];
    return {
      workspace_name: view.workspace_name,
      now: now(),
      strip: targetStrip(view),
      team: (view.roster || []).map(r => ({ name: r.name, initials: initials(r.name), status: r.status, tone: tone(r.status) })),
      card: publicCard(cards[0] || null),
      cards_left: cards.length,
      decided: session.decided,
      card_limit: CARD_LIMIT,
      all_clear: cards.length ? null : { still_running: stillRunning },
      live: liveLine(view, now()),
      actions: actions.slice(-5).reverse().map(a => ({
        id: a.id,
        card: a.card,
        choice: a.choice,
        status: a.status,
        exit_code: a.exit_code,
        line: actionOutcome(a, view.outcomes || [], { tally }),
      })),
      undo: undo && undo.expires_at > now() ? { id: undo.id, until: undo.expires_at } : null,
      error: view.error || null,
      bet: bet ? bet.view() : null,
    };
  }

  async function runAction(action, steps) {
    let worst = 0;
    let lastLine = '';
    for (const args of steps) {
      let result;
      try {
        result = await deps.runStep(args);
      } catch (err) {
        result = { code: 1, last_line: String((err && err.message) || err) };
      }
      const code = Number.isInteger(result.code) ? result.code : 1;
      log({ card: action.card, choice: action.choice, command: displayCommand(args), exit_code: code });
      if (code !== 0 && worst === 0) {
        worst = code;
        lastLine = String(result.last_line || '').slice(0, 160);
      }
    }
    action.status = worst === 0 ? 'done' : 'failed';
    action.exit_code = worst;
    action.last_line = lastLine;
  }

  function act(body) {
    const cards = deck(deps.loadView());
    const cardId = String(body.card || '');
    const choiceId = String(body.choice || '');
    const found = resolveChoice(cards, cardId, choiceId);
    if (!found) return { status: 409, body: { ok: false, reason: 'gone', message: 'that card changed, here is the latest' } };
    const { card, choice } = found;
    if (choice.view) return { status: 400, body: { ok: false, reason: 'view_only' } };
    if (choice.confirm && body.confirm !== true) {
      return { status: 409, body: { ok: false, reason: 'needs_confirm', confirm_ms: CONFIRM_MS } };
    }
    if (choice.id === 'later') {
      session.snoozed.add(card.id);
      session.decided += 1;
      log({ card: card.id, choice: 'later', command: null, exit_code: 0 });
      return { status: 200, body: { ok: true, ack: 'saved for later' } };
    }
    if (!choice.keepCard) {
      session.snoozed.add(card.id);
      session.decided += 1;
    }
    if (bet && card.bet_yes) bet.recordYes(card.bet_yes);
    seq += 1;
    const id = `a${seq}`;
    if (choice.local) {
      const restore = deps.snapshotTarget();
      const ok = deps.writeTarget(choice.target);
      const command = `atris gm target --landed ${choice.target.landed} --max-abandoned ${choice.target.max_abandoned} --max-stuck ${choice.target.max_stuck}`;
      log({ card: card.id, choice: choice.id, command, ran: 'in process', exit_code: ok ? 0 : 1 });
      if (!ok) return { status: 500, body: { ok: false, reason: 'write_failed', message: 'could not save the target' } };
      undo = { id, card: card.id, restore, expires_at: now() + UNDO_MS + UNDO_GRACE_MS };
      return { status: 200, body: { ok: true, id, ack: choice.ack, undo: { id, ms: UNDO_MS } } };
    }
    const action = {
      id,
      card: card.id,
      choice: choice.id,
      label: choice.label,
      member: choice.member,
      ack: choice.ack,
      status: 'running',
      exit_code: null,
      started_at: now(),
    };
    actions.push(action);
    action.done = runAction(action, choice.steps);
    return { status: 200, body: { ok: true, id, ack: choice.ack, commands: choice.steps.map(displayCommand) } };
  }

  function doUndo(body) {
    if (!undo || undo.id !== String(body.id || '') || undo.expires_at <= now()) {
      return { status: 409, body: { ok: false, reason: 'undo_expired', message: 'too late to undo' } };
    }
    const ok = undo.restore();
    session.snoozed.delete(undo.card);
    session.decided = Math.max(0, session.decided - 1);
    log({ card: undo.card, choice: 'undo', command: 'restore the previous target file', ran: 'in process', exit_code: ok ? 0 : 1 });
    undo = null;
    return { status: ok ? 200 : 500, body: { ok, ack: ok ? 'undone, target back how it was' : 'could not undo' } };
  }

  // The one route for the card on screen (lib/gm-card.js): the card's id and
  // one option on it, or typed words for its box, or the orb's next card, or
  // the team or the job deck from the footer. The desk checks the card id
  // and the option, and refuses anything else. A second tap is the page
  // sending confirm on an option that asks for one.
  function cardAction(body) {
    const clean = {
      card_id: typeof body.card_id === 'string' ? body.card_id.slice(0, 300) : null,
      option_id: typeof body.option_id === 'string' ? body.option_id.slice(0, 120) : null,
      confirm: body.confirm === true,
      orb: body.orb === true,
      open: body.open === 'team' || body.open === 'deck' || body.open === 'thinker' ? body.open : null,
    };
    if (typeof body.text === 'string') clean.text = body.text.slice(0, 1000);
    return Promise.resolve(bet.act(clean));
  }

  // A typed send carries its own id, made on the phone when the words are
  // first sent and the same on every retry of those words. A repeat of a
  // send that went through, or is still going, gets the first answer and
  // nothing is sent again; one that did nothing is tried again. The newest
  // SENDS_KEPT are remembered for SENDS_MS.
  const sends = new Map();
  function sendOnce(p, body) {
    const id = typeof body.send === 'string' && SEND_ID.test(body.send) ? `${p} ${body.send}` : null;
    if (!id) return cardAction(body);
    const seen = sends.get(id);
    if (seen && now() - seen.at < SENDS_MS) return seen.out;
    sends.delete(id);
    const out = cardAction(body);
    sends.set(id, { at: now(), out });
    const forget = () => { if (sends.get(id) && sends.get(id).out === out) sends.delete(id); };
    out.then(r => { if (!r.body || r.body.ok !== true) forget(); }, forget);
    while (sends.size > SENDS_KEPT) sends.delete(sends.keys().next().value);
    return out;
  }

  const send = (res, status, body, type = 'application/json; charset=utf-8', extra = {}) => {
    res.writeHead(status, {
      'content-type': type,
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      ...extra,
    });
    res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
  };

  async function handle(req, res) {
    // the token is read on every request, so a rotated link is dead at once
    const token = typeof deps.token === 'function' ? deps.token() : deps.token;
    const check = checkRequest(req, { token: token || '', hosts: deps.hosts });
    if (!check.ok) return send(res, check.status, check.status === 400 ? 'bad request' : check.status === 403 ? 'forbidden' : 'method not allowed', 'text/plain; charset=utf-8');
    try {
      if (req.method === 'GET' && check.path === '/') {
        const nonce = crypto.randomBytes(16).toString('base64');
        // the card on screen now goes in the page itself, so its first paint is that card;
        // a desk that cannot read it right now (starting again) still serves the page, without one, and the page asks
        let first = null;
        try { first = bet ? bet.card() : null; } catch { first = null; }
        const html = deps.page(nonce, first);
        // packed when the phone takes it (every browser does): about a third of the bytes over a weak wifi
        const packed = /\bgzip\b/i.test(String(req.headers['accept-encoding'] || ''));
        return send(res, 200, packed ? zlib.gzipSync(html) : html, 'text/html; charset=utf-8', {
          vary: 'accept-encoding',
          ...(packed ? { 'content-encoding': 'gzip' } : {}),
          // img-src data: only for the page's own inline icon; nothing else loads an image
          'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; img-src data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
        });
      }
      if (req.method === 'GET' && check.path === '/state') return send(res, 200, state());
      // the card on screen now; a read starts no work
      if (req.method === 'GET' && check.path === '/card') return bet ? send(res, 200, bet.card()) : send(res, 404, { ok: false, reason: 'not_found' });
      // the model the orb thinks with, for anything holding the link (the desktop app):
      // what is offered here and the pick; a post sets it, only to one offered here
      if (req.method === 'GET' && check.path === '/model') return send(res, 200, { ok: true, ...(await orbModel().publicStatus(deps.workspaceRoot)) });
      if (req.method === 'POST' && check.path === '/model') {
        if (String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase() !== 'application/json') return send(res, 415, { ok: false, reason: 'json_only' });
        let body;
        try {
          body = JSON.parse(await readBody(req) || '{}');
          if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('bad_body');
        } catch (err) {
          return send(res, err.message === 'too_large' ? 413 : 400, { ok: false, reason: 'bad_body' });
        }
        // { engine, model } as the list names them, or { pick: "words" } as typed at the terminal
        const want = typeof body.engine === 'string' ? { engine: body.engine.slice(0, 40), model: typeof body.model === 'string' ? body.model.slice(0, 120) : '' }
          : typeof body.pick === 'string' ? body.pick.slice(0, 120) : null;
        if (!want) return send(res, 400, { ok: false, reason: 'bad_body' });
        const out = await orbModel().setPick(deps.workspaceRoot, want);
        log({ card: 'orb_model', choice: 'set', command: null, ran: 'in process', exit_code: out.ok ? 0 : 2, want: typeof want === 'string' ? want : `${want.engine} ${want.model}`, ...(out.ok ? { changed: out.changed } : { reason: out.reason }) });
        // the new pick is tried on the very next call, with nothing benched from before
        if (out.ok) require('./gm-bet').forgetThinkers(deps.workspaceRoot);
        return send(res, out.ok ? 200 : 409, out.ok ? { ...out, ...(await orbModel().publicStatus(deps.workspaceRoot)) } : out);
      }
      if (req.method === 'POST' && (check.path === '/action' || check.path === '/undo' || (bet && check.path === '/act'))) {
        if (String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase() !== 'application/json') return send(res, 415, { ok: false, reason: 'json_only' });
        let body;
        try {
          body = JSON.parse(await readBody(req) || '{}');
          if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('bad_body');
        } catch (err) {
          return send(res, err.message === 'too_large' ? 413 : 400, { ok: false, reason: 'bad_body' });
        }
        if (check.path === '/act') {
          const out = await sendOnce(check.path, body || {});
          return send(res, out.status, out.body);
        }
        const out = check.path === '/action' ? act(body || {}) : doUndo(body || {});
        return send(res, out.status, out.body);
      }
      return send(res, 404, { ok: false, reason: 'not_found' });
    } catch (err) {
      return send(res, 500, { ok: false, reason: 'server_error', message: String((err && err.message) || err).slice(0, 200) });
    }
  }

  handle.session = session;
  handle.actions = actions;
  handle.state = state;
  handle.bet = bet;
  return handle;
}

// ---- real wiring ----------------------------------------------------------------------

// Everything the cards need, read-only: the board, every review and stuck
// row (oldest first), the season's plays, and the autoland policy.
function loadPhoneView(workspaceRoot, { now = Date.now(), dbPath, targetsDir } = {}) {
  const season = require('./gm-season');
  const autoland = require('./autoland');
  const loaded = season.loadSeason(workspaceRoot, { now, dbPath, lastSeen: null, targetsDir });
  const board = season.seasonBoard(loaded, { limit: 8, lastSeen: null });
  const auth = autoland.liveAcceptAuthorization(workspaceRoot);
  const policy = autoland.readPolicy(workspaceRoot) || {};
  return {
    workspace_name: board.workspace_name,
    target: board.target,
    target_default: board.target_default,
    landed_this_week: board.mood ? board.mood.landed_by_autoland + board.mood.landed_by_you : 0,
    roster: board.roster,
    last_plays: board.last_plays,
    reviews: season.reviewRows(loaded.reviews || [], now, Infinity),
    stuck: season.stuckRows(loaded.claims || [], now, Infinity),
    outcomes: loaded.outcomes || [],
    policy: { authorized: auth.ok, accept_all: Boolean(policy.accept_all), strict_verify: policy.strict_verify },
    error: board.error,
  };
}

// The first private IPv4 on a real interface (en0 first), or null.
function lanAddress(interfaces = require('os').networkInterfaces()) {
  const names = Object.keys(interfaces).sort((a, b) => (a === 'en0' ? -1 : b === 'en0' ? 1 : a.localeCompare(b)));
  for (const name of names) {
    for (const addr of interfaces[name] || []) {
      const v4 = addr.family === 'IPv4' || addr.family === 4;
      if (v4 && !addr.internal && !String(addr.address).startsWith('169.254.')) return addr.address;
    }
  }
  return null;
}

// Runs one atris command in the workspace, detached so a started agent keeps
// going if the page stops. Output goes to a log file; the result carries the
// exit code and the last output line.
function makeStepRunner({ cliPath, cwd, logDir }) {
  const { spawn } = require('child_process');
  return args => new Promise((resolve) => {
    fs.mkdirSync(logDir, { recursive: true });
    const file = path.join(logDir, `${Date.now()}-${crypto.randomBytes(3).toString('hex')}.log`);
    const fd = fs.openSync(file, 'a');
    let child;
    try {
      child = spawn(process.execPath, [cliPath, ...args], {
        cwd,
        detached: true,
        stdio: ['ignore', fd, fd],
        env: { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1' },
      });
    } catch (err) {
      fs.closeSync(fd);
      resolve({ code: 1, last_line: String((err && err.message) || err) });
      return;
    }
    fs.closeSync(fd);
    child.unref();
    child.on('error', err => resolve({ code: 1, last_line: String(err.message || err) }));
    child.on('exit', (code, signal) => {
      let last = '';
      try {
        const text = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/).filter(Boolean);
        last = text.length ? text[text.length - 1] : '';
      } catch {
        last = '';
      }
      resolve({ code: code == null ? (signal ? 1 : 0) : code, last_line: last.slice(0, 160) });
    });
  });
}

// The phone link's token, one per workspace, kept in the home state dir so a
// restart gives the same link. Only this user can read the file (0600).
// rotate (atris gm phone --new-link) makes a new one; the old link stops working.
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;
function phoneToken(workspaceRoot, { stateDir, rotate = false } = {}) {
  const file = path.join(stateDir, 'gm-phone-links.json');
  let links = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) links = parsed;
  } catch {
    links = {};
  }
  const saved = links[workspaceRoot] && links[workspaceRoot].token;
  let token = saved;
  let reused = true;
  if (rotate || typeof saved !== 'string' || !TOKEN_SHAPE.test(saved)) {
    token = crypto.randomBytes(32).toString('base64url');
    reused = false;
    links[workspaceRoot] = { token, created_at: new Date().toISOString() };
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(links, null, 2)}\n`, { mode: 0o600 });
  }
  // a file loosened by hand is tightened again
  try { fs.chmodSync(file, 0o600); } catch { /* read-only state dir */ }
  return { token, reused };
}

// The saved token for this workspace, or null; read fresh on every request.
function readPhoneToken(workspaceRoot, { stateDir } = {}) {
  try {
    const links = JSON.parse(fs.readFileSync(path.join(stateDir, 'gm-phone-links.json'), 'utf8'));
    const t = links && links[workspaceRoot] && links[workspaceRoot].token;
    return typeof t === 'string' && TOKEN_SHAPE.test(t) ? t : null;
  } catch {
    return null;
  }
}

// Snapshot of the target file, so the undo puts back exactly what was there.
function targetSnapshot(workspaceRoot, dir) {
  const gmTarget = require('./gm-target');
  const file = gmTarget.targetsPath(workspaceRoot, dir || gmTarget.targetsDir());
  let before = null;
  try {
    before = fs.readFileSync(file, 'utf8');
  } catch {
    before = null;
  }
  return () => {
    try {
      if (before == null) fs.rmSync(file, { force: true });
      else fs.writeFileSync(file, before);
      return true;
    } catch {
      return false;
    }
  };
}

module.exports = {
  CARD_LIMIT,
  UNDO_MS,
  SEND_BACK_NOTE,
  actionOutcome,
  buildCards,
  checkRequest,
  createPhoneHandler,
  displayCommand,
  initials,
  lanAddress,
  liveLine,
  loadPhoneView,
  makeStepRunner,
  phoneToken,
  readPhoneToken,
  publicCard,
  resolveChoice,
  reviewerCommand,
  sessionCards,
  targetSnapshot,
  targetStrip,
  tokenMatches,
  tone,
};
