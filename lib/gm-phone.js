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

const CARD_LIMIT = 5;
const CONFIRM_MS = 5000;
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
  const url = new URL(req.url || '/', 'http://local');
  if (!hosts.includes(host)) return { ok: false, status: 403, reason: 'host' };
  const header = req.headers['x-gm-token'];
  if (req.method === 'GET') {
    if (!tokenMatches(url.searchParams.get('t') || header, token)) return { ok: false, status: 403, reason: 'token' };
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
      size += chunk.length;
      if (size > BODY_MAX) {
        reject(new Error('too_large'));
        req.destroy();
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
//   logPath, now(), page(nonce)   receipts, clock, html
//   makeBetDesk(log)              -> optional bet desk (lib/gm-bet createBetDesk)
function createPhoneHandler(deps) {
  const now = deps.now || Date.now;
  const tally = deps.tally || require('./gm-season').tally;
  const session = { decided: 0, snoozed: new Set() };
  const actions = [];
  let undo = null;
  let seq = 0;

  const log = (row) => appendLog(deps.logPath, { at: new Date(now()).toISOString(), workspace: deps.workspaceRoot, ...row });
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

  // think shows the next card at once (a choice of ideas, one idea, or a
  // question when none is ready); pick opens one idea from a choice; sharper
  // asks for a new bet; answer saves the owner's answer to the question on
  // screen; do it needs a second tap because it starts
  // agents; not now only marks the bet skipped.
  async function betAction(p, body) {
    let out;
    if (p === '/bet/think') out = bet.next({ sharper: body.sharper === true });
    else if (p === '/bet/answer') out = bet.answer({ choice: String(body.choice || '') });
    else if (p === '/bet/pick') out = bet.pick({ id: String(body.id || '') });
    else if (p === '/bet/skip') out = bet.skip();
    else if (p === '/bet/do') {
      if (body.confirm !== true) return { status: 409, body: { ok: false, reason: 'needs_confirm', confirm_ms: CONFIRM_MS } };
      out = await bet.doIt();
    } else if (p === '/bet/nice') {
      out = bet.nice();
    } else if (p === '/bet/yes') {
      // a yes unblocks agents, so it needs a second tap
      if (body.confirm !== true) return { status: 409, body: { ok: false, reason: 'needs_confirm', confirm_ms: CONFIRM_MS } };
      out = await bet.answerYes();
    } else return { status: 404, body: { ok: false, reason: 'not_found' } };
    return { status: out.ok ? 200 : 409, body: out };
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
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  };

  async function handle(req, res) {
    const check = checkRequest(req, { token: deps.token, hosts: deps.hosts });
    if (!check.ok) return send(res, check.status, check.status === 403 ? 'forbidden' : 'method not allowed', 'text/plain; charset=utf-8');
    try {
      if (req.method === 'GET' && check.path === '/') {
        const nonce = crypto.randomBytes(16).toString('base64');
        return send(res, 200, deps.page(nonce), 'text/html; charset=utf-8', {
          'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
        });
      }
      if (req.method === 'GET' && check.path === '/state') return send(res, 200, state());
      if (req.method === 'GET' && check.path === '/bet') return bet ? send(res, 200, bet.warm()) : send(res, 404, { ok: false, reason: 'not_found' });
      if (req.method === 'POST' && (check.path === '/action' || check.path === '/undo' || (bet && check.path.startsWith('/bet/')))) {
        if (!String(req.headers['content-type'] || '').startsWith('application/json')) return send(res, 415, { ok: false, reason: 'json_only' });
        let body;
        try {
          body = JSON.parse(await readBody(req) || '{}');
        } catch {
          return send(res, 400, { ok: false, reason: 'bad_body' });
        }
        if (check.path.startsWith('/bet/')) {
          const out = await betAction(check.path, body || {});
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
  publicCard,
  resolveChoice,
  reviewerCommand,
  sessionCards,
  targetSnapshot,
  targetStrip,
  tokenMatches,
  tone,
};
