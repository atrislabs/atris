'use strict';

// atris tell: send one note or task to one team member, and get a receipt.
// Saved, delivered, seen or picked up, and finished are different things, and
// the output never blurs them. Same business lookup and sign-in as
// `atris channel`. Backend: POST /api/swarlo/{business}/tell and
// GET /api/swarlo/{business}/posts/{post_id}/receipt.

const crypto = require('node:crypto');
const { apiRequestJson } = require('../utils/api');
const { NOT_LOGGED_IN, oneLine } = require('../lib/developer-api');
const { parseArgs, loginToken } = require('../lib/business-target');
const { resolveChannelBusiness, boardWhy, memberName, lookupMember } = require('../lib/team-board');

const FLAGS = { switches: [], values: ['task', 'channel', 'as'] };

// What each receipt state means, in plain words.
const STATE_WORDS = {
  delivered: 'in the inbox, not seen yet',
  seen: 'seen, not picked up yet',
  accepted: 'picked up, working on it',
  completed: 'finished',
  failed: 'tried it and failed',
  blocked: 'blocked, needs help',
};

function tellHelp(log = console.log) {
  log(`usage: atris tell <member> "message"          send a note to one team member
       atris tell status <id>                  was it seen, answered, finished, and how fast
       atris tell wake <member> on|off         wake that member when someone sends it a note
       atris tell listen --as <member>         hear each note to that member the moment it is sent

example: atris tell arjun "check the signup page today"

options:
  --business <slug>   which business (else ATRIS_BUSINESS, this folder's business, or your only one)
  --task <key>        send it as a task the member can claim and report on
  --channel <name>    the channel it shows in (default: general)
  --as <member>       send as that team member (else ATRIS_AGENT, else you); with listen, whose notes
  --wait [seconds]    after sending, wait for the member's answer and print it (default 180)
  --json              the server's raw reply; with listen, one note per line

listen keeps waiting until you stop it, and does not mark notes read.`);
}

function text(value) {
  return value == null ? '' : String(value).trim();
}

function sentence(value) {
  const s = text(value);
  return s && !/[.!?]$/.test(s) ? `${s}.` : s;
}

// FastAPI's own 404 for a route that does not exist yet.
function routeMissing(res) {
  if (!res || res.status !== 404) return false;
  const detail = res.data && res.data.detail;
  return detail == null || detail === 'Not Found';
}

// The server's error in one line. An unknown-member reply may carry the
// team's names as a list beside the message; show them.
function serverMessage(res, business) {
  const detail = res && res.data && res.data.detail;
  if (detail && typeof detail === 'object' && !Array.isArray(detail)) {
    const names = detail.members || detail.names || detail.team;
    const said = oneLine(detail.message || detail.error || '');
    if (Array.isArray(names) && names.length) {
      const list = names.map((n) => (n && typeof n === 'object' ? n.name || n.id : n)).filter(Boolean).join(', ');
      return `${said || 'no such member'}${said && /members?:/i.test(said) ? '' : `. members: ${list}`}`;
    }
    if (said) return said;
  }
  return boardWhy(res, business);
}

function wakesLine(reply, to) {
  if (reply.wakes === true) return `yes. ${to} starts on it now`;
  if (reply.wakes !== false) return '';
  const reason = text(reply.wake_reason);
  if (reason === 'turned_off') return `no. waking on notes is off for ${to}, so it waits for ${to}'s next run`;
  const note = text(reply.note);
  if (note) return `no. ${note}`;
  return `no. it waits for ${to}'s next run`;
}

function receiptLines(reply, business, member) {
  const to = text(reply.to) || member;
  const channel = text(reply.channel);
  const task = text(reply.task_key);
  const lines = [];
  const where = channel ? `in #${channel} ` : '';
  lines.push(['saved', `${task ? `task ${task} ` : ''}${where}for ${to}`]);
  // delivered: null means saved, but the server could not check the inbox yet.
  const unconfirmed = reply.delivered === null;
  if (reply.delivered === true) lines.push(['delivered', `it is in ${to}'s inbox`]);
  else if (reply.delivered === false) lines.unshift(['not delivered', sentence(reply.note) || `it was saved but did not reach ${to}'s inbox`]);
  else if (unconfirmed) lines.push(['delivered', 'saved, not confirmed yet. check status before sending again']);
  else lines.push(['delivered', 'unknown, the server did not say']);
  const wakes = unconfirmed && reply.wakes !== true ? '' : wakesLine(reply, to);
  if (wakes) lines.push(['wakes', wakes]);
  if (reply.wakes === false && text(reply.wake_reason) === 'turned_off') lines.push(['wake', `atris tell wake ${to} on --business ${business.slug}`]);
  if (text(reply.post_id)) lines.push(['check', `atris tell status ${text(reply.post_id)} --business ${business.slug}`]);
  const width = Math.max(...lines.map(([k]) => k.length));
  return lines.map(([k, v]) => `${k.padEnd(width)}  ${v}`);
}

// "48 seconds", "3 minutes", "2 hours".
function duration(seconds) {
  const s = Math.max(0, Math.round(Number(seconds)));
  const unit = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  if (s < 90) return unit(s, 'second');
  if (s < 90 * 60) return unit(Math.round(s / 60), 'minute');
  return unit(Math.round(s / 3600), 'hour');
}

// Seconds from one time to another, or null when either is missing or bad.
function between(from, to) {
  const a = Date.parse(text(from));
  const b = Date.parse(text(to));
  return Number.isFinite(a) && Number.isFinite(b) && b >= a ? (b - a) / 1000 : null;
}

function answeredSeconds(p, receipt) {
  if (Number.isFinite(Number(p.seconds_to_first_reply)) && p.seconds_to_first_reply !== null && p.seconds_to_first_reply !== '') {
    return Number(p.seconds_to_first_reply);
  }
  return between(p.sent_at || receipt.sent_at, p.first_reply_at);
}

function hasAnswered(p) {
  return Boolean(p && (text(p.first_reply_at) || (p.seconds_to_first_reply != null && p.seconds_to_first_reply !== '')));
}

const FINAL_STATES = new Set(['completed', 'failed', 'blocked']);

// The most one send may ask the server to hold for an answer.
const SERVER_WAIT_MAX = 25;
// A repeat with the same key sends nothing new for ten minutes; stop asking
// again a minute before that.
const SAME_KEY_MS = 9 * 60 * 1000;

// A member's reply is printed as written, minus terminal control characters.
function safeText(value) {
  return text(value).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '');
}

// One person's receipt in plain words, with times when the server has them.
function personWords(p, receipt = {}) {
  const state = text(p && p.state);
  let words = STATE_WORDS[state] || (state ? state : 'no word on it yet');
  const extra = [];
  const answered = answeredSeconds(p, receipt);
  if (answered !== null) extra.push(`answered in ${duration(answered)}`);
  const finished = between(p.sent_at || receipt.sent_at, p.completed_at);
  if (finished !== null && state === 'completed') words = `finished in ${duration(finished)}`;
  else if (finished !== null) extra.push(`finished in ${duration(finished)}`);
  const note = sentence(p.note);
  return `${[words, ...extra].join(', ')}${note ? `. ${note}` : ''}`;
}

function statusLines(reply) {
  const people = (Array.isArray(reply.recipients) ? reply.recipients : []).filter((p) => p && typeof p === 'object');
  if (!people.length) return ['nobody has this note in their inbox yet'];
  const names = people.map((p) => text(p.name) || text(p.to) || 'someone');
  const width = Math.max(...names.map((n) => n.length));
  return people.map((p, i) => `${names[i].padEnd(width)}  ${personWords(p, reply)}`);
}

// The member a send went to, in a receipt that may list several. The member id
// from the send wins; a name match (any case) only stands in for a row that
// carries no id. Never the first row by default: that could be someone else.
function pickRecipient(people, reply, target) {
  const id = text(reply && reply.member_id);
  if (id) {
    const hit = people.find((p) => text(p.member_id) === id);
    if (hit) return hit;
  }
  const wanted = [text(reply && reply.to), text(target)].map((s) => s.toLowerCase()).filter(Boolean);
  return people.find((p) => !(id && text(p.member_id))
    && [text(p.name), text(p.to)].some((n) => n && wanted.includes(n.toLowerCase()))) || null;
}

// --wait [seconds]: an optional number after the switch. Pulled out before
// the normal parse so `--wait "message"` never eats the message.
function takeWait(args) {
  const rest = [];
  let wait = null;
  let error = '';
  for (let i = 0; i < args.length; i += 1) {
    const arg = String(args[i]);
    if (arg === '--wait' || arg.startsWith('--wait=')) {
      let raw = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : '';
      if (!raw && /^\d+$/.test(String(args[i + 1] || ''))) { raw = String(args[i + 1]); i += 1; }
      const n = raw === '' ? 180 : Number(raw);
      if (!Number.isInteger(n) || n < 1 || n > 3600) error = '--wait takes a whole number of seconds from 1 to 3600';
      wait = n;
      continue;
    }
    rest.push(args[i]);
  }
  return { rest, wait, error };
}

async function tellCommand(args = [], deps = {}) {
  let secret = '';
  const hide = (line) => (secret ? String(line).split(secret).join('[hidden]') : String(line));
  const log = (line) => (deps.log || console.log)(hide(line));
  const err = (line) => (deps.err || console.error)(hide(line));

  const waited = takeWait(args);
  const { flags, pos, error } = parseArgs(waited.rest, FLAGS);
  if (flags.help || pos[0] === 'help') { tellHelp(log); return 0; }
  if (error || waited.error) { err(`${error || waited.error}. see: atris tell --help`); return 1; }
  if (!pos.length) { tellHelp(log); return 0; }
  if (pos[0] === 'listen') {
    if (waited.wait !== null) { err('--wait goes with a send, like: atris tell arjun "hello" --wait'); return 1; }
    return listen(pos, flags, deps, log, err, (t) => { secret = t; });
  }

  // `status`, `wake` and `listen` are verbs here; a member with one of those names is
  // reached with a leading @ (atris tell @status "...").
  const verb = pos[0] === 'status' || pos[0] === 'wake' ? pos[0] : null;
  const postId = verb === 'status' ? text(pos[1]) : '';
  const target = verb === 'status' ? '' : text(verb ? pos[1] : pos[0]).replace(/^@/, '');
  const message = verb ? '' : pos.slice(1).join(' ').trim();
  const wakeTo = verb === 'wake' ? text(pos[2]).toLowerCase() : '';
  if (verb === 'status' && !postId) { err('status needs the id from the send, like: atris tell status 6c0b6823'); return 1; }
  if (verb === 'status' && pos.length > 2) { err('atris tell status takes one id'); return 1; }
  if (verb === 'wake' && (!target || !['on', 'off'].includes(wakeTo) || pos.length > 3)) { err('say who and on or off, like: atris tell wake arjun on'); return 1; }
  if (!verb && !target) { err('say who, like: atris tell arjun "check the signup page"'); return 1; }
  if (!verb && !message) { err(`say what to tell ${target}, like: atris tell ${target} "check the signup page"`); return 1; }
  if (verb && waited.wait !== null) { err('--wait goes with a send, like: atris tell arjun "hello" --wait'); return 1; }

  const business = resolveChannelBusiness(flags, deps);
  if (business.error) { err(business.error); return 1; }
  const token = await loginToken(deps);
  if (!token) { err(NOT_LOGGED_IN); return 1; }
  secret = token;

  const request = deps.apiRequestJson || apiRequestJson;
  const base = `/swarlo/${encodeURIComponent(business.id)}`;
  const readReceipt = (id) => request(`${base}/posts/${encodeURIComponent(id)}/receipt`, { method: 'GET', token });
  const NO_RECEIPTS = 'This Atris server does not have tell receipts yet. Read the channel instead: atris channel general';

  if (verb === 'status') {
    const res = await readReceipt(postId);
    if (routeMissing(res)) { err(NO_RECEIPTS); return 1; }
    if (!res || !res.ok) { err(`could not check ${postId}: ${serverMessage(res, business)}`); return 1; }
    const reply = (res.data && typeof res.data === 'object') ? res.data : {};
    if (flags.json) { log(JSON.stringify(reply)); return 0; }
    for (const line of statusLines(reply)) log(line);
    return 0;
  }

  if (verb === 'wake') {
    const on = wakeTo === 'on';
    const res = await request(`/business/${encodeURIComponent(business.id)}/team/${encodeURIComponent(target)}`, { method: 'PATCH', body: { wake_on_mention: on }, token });
    const detail = res && res.data && res.data.detail;
    if (res && res.status === 404 && /\b(agent|member) not found\b/i.test(String(detail || ''))) { err(`no member called "${target}" in ${business.slug}, so nothing changed`); return 1; }
    if (!res || !res.ok) { err(`could not change waking for ${target}: ${serverMessage(res, business)}`); return 1; }
    const updated = res.data && res.data.updated && typeof res.data.updated === 'object' ? res.data.updated : null;
    if (flags.json) log(JSON.stringify(res.data));
    if (!updated || !Object.prototype.hasOwnProperty.call(updated, 'wake_on_mention')) {
      err(`This Atris server does not have waking on notes yet, so nothing changed for ${target}.`);
      return 1;
    }
    const saved = updated.wake_on_mention;
    const now = typeof saved === 'boolean' ? saved : (saved && typeof saved === 'object' && typeof saved.enabled === 'boolean' ? saved.enabled : on);
    if (now !== on) { err(`the server kept waking ${now ? 'on' : 'off'} for ${target}, so nothing changed`); return 1; }
    if (!flags.json) {
      log(on
        ? `${target} now wakes when sent a note. Each wake runs ${target}'s computer on the business's credits, up to the daily limit.`
        : `${target} no longer wakes for notes.`);
    }
    // Inside this business's project folder, the feed switch follows (best effort).
    const local = require('../lib/wake-sync').setLocalSwitch(deps.cwd || process.cwd(), business, target, on, deps);
    if (local.line) err(local.line);
    return 0;
  }

  // Send as a team member when one is named, like `atris channel`. A member
  // that cannot be found stops the send; it never falls back to you.
  const asWho = memberName(flags, deps.env || process.env);
  let sender = null;
  if (asWho) {
    const found = await lookupMember(request, business, asWho, token);
    if (found.missing) { err(`no member called "${asWho}" in ${business.slug}, so nothing was sent. check the name, or leave off --as to send as yourself`); return 1; }
    if (found.failed !== undefined) { err(`could not look up member "${asWho}", so nothing was sent: ${boardWhy(found.failed, business)}`); return 1; }
    if (found.noId) { err(`member "${asWho}" in ${business.slug} has no agent id, so nothing was sent`); return 1; }
    sender = found.member;
  }

  const body = {
    member: target,
    text: message,
    task_key: typeof flags.task === 'string' ? flags.task : null,
    channel: typeof flags.channel === 'string' ? flags.channel.replace(/^#/, '') : null,
  };
  if (sender) body.agent_id = sender.id;
  // One key per run: if this request is retried, the server returns the first
  // receipt instead of sending the note twice.
  body.idempotency_key = deps.newKey ? deps.newKey() : crypto.randomUUID();
  const clock = deps.now || Date.now;
  const started = clock();
  // With --wait the server holds the call open until the member answers (up to
  // 25 seconds), so the answer often comes back with the send itself.
  const send = (seconds) => request(`${base}/tell`, seconds
    ? { method: 'POST', body: { ...body, wait_seconds: seconds }, token, timeoutMs: (seconds + 20) * 1000 }
    : { method: 'POST', body, token });
  const res = await send(waited.wait === null ? 0 : Math.min(SERVER_WAIT_MAX, waited.wait));
  if (routeMissing(res)) {
    err(`This Atris server does not have tell yet. Use: atris channel ${body.channel || 'general'} "@${target} ..."`);
    return 1;
  }
  if (!res || !res.ok) { err(`nothing was sent to ${target}: ${serverMessage(res, business)}`); return 1; }
  const reply = (res.data && typeof res.data === 'object') ? res.data : {};
  const quiet = Boolean(flags.json);
  if (waited.wait === null || reply.delivered === false || !text(reply.post_id)) {
    if (quiet) log(JSON.stringify(reply));
    else for (const line of receiptLines(reply, business, target)) log(line);
    if (waited.wait !== null && reply.delivered !== false && !text(reply.post_id)) { err('the server gave no id to watch, so --wait stopped here'); return 1; }
    return reply.delivered === false ? 1 : 0;
  }
  if (!quiet) for (const line of receiptLines(reply, business, target)) log(line);

  const sleep = deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const to = text(reply.to) || target;
  const limitMs = waited.wait * 1000;
  const elapsed = () => Math.round((clock() - started) / 1000);
  if (!quiet) log(`waiting up to ${waited.wait} seconds for ${to}`);

  // A server that waits for the answer itself says answered true or false.
  // While time is left, ask again with the same key: the server sends nothing
  // new and holds for the answer once more. Past nine minutes the key would no
  // longer stop a second send, so the receipt watch below takes over.
  if (typeof reply.answered === 'boolean') {
    let latest = reply;
    let saidOnIt = false;
    let report = null;
    let outcome = 'timeout';
    for (;;) {
      if (latest.accepted && !latest.answered && !saidOnIt) {
        saidOnIt = true;
        if (!quiet) log(`${String(elapsed()).padStart(4)}s  ${to} is on it${text(latest.on_it) ? `: ${oneLine(safeText(latest.on_it))}` : ''}`);
      }
      if (latest.answered) { outcome = 'answered'; break; }
      const leftMs = limitMs - (clock() - started);
      if (leftMs < 1000 || clock() - started >= SAME_KEY_MS) break;
      // A task report (finished, failed, blocked) carries no reply; the receipt shows it.
      const check = await readReceipt(reply.post_id);
      const people = check && check.ok && check.data && Array.isArray(check.data.recipients) ? check.data.recipients.filter((p) => p && typeof p === 'object') : [];
      const person = people.length ? pickRecipient(people, reply, target) : null;
      if (person && FINAL_STATES.has(text(person.state))) {
        report = check.data;
        outcome = text(person.state) === 'completed' ? 'finished' : text(person.state);
        break;
      }
      const asked = clock();
      const again = await send(Math.min(SERVER_WAIT_MAX, Math.floor(leftMs / 1000)));
      if (again && (again.status === 401 || again.status === 403)) { err(`could not check ${reply.post_id}: ${serverMessage(again, business)}`); return 1; }
      if (again && again.ok && again.data && typeof again.data === 'object' && typeof again.data.answered === 'boolean') latest = again.data;
      // A reply that came back at once (or an error) gets a short pause, so this never spins.
      if (clock() - asked < 1000) await sleep(Math.min(5000, Math.max(0, limitMs - (clock() - started))));
    }
    const handOff = outcome === 'timeout' && clock() - started >= SAME_KEY_MS && limitMs - (clock() - started) >= 1000;
    if (!handOff) {
      const seconds = elapsed();
      if (quiet) {
        log(JSON.stringify({ ...latest, ...(report ? { receipt: report } : {}), waited_seconds: seconds }));
      } else if (outcome === 'answered') {
        const answer = safeText(latest.answer);
        if (answer) log(`${to}: ${answer}`);
        log(`answered in ${seconds} seconds`);
      } else if (outcome === 'finished') {
        log(`finished in ${seconds} seconds`);
      } else if (outcome === 'timeout') {
        log(`no answer from ${to} after ${seconds} seconds${saidOnIt ? `. ${to} is still on it` : ''}. check: atris tell status ${text(reply.post_id)} --business ${business.slug}`);
      } else {
        log(`${to} ${outcome === 'blocked' ? 'is blocked' : 'failed'} after ${seconds} seconds`);
      }
      return outcome === 'answered' || outcome === 'finished' ? 0 : 1;
    }
  }

  // --wait on the receipt alone: check every 5 seconds until the member answers
  // or finishes, or time runs out. One line per change, timed from the send.
  let receipt = null;
  let last = '';
  let outcome = 'timeout';
  while (clock() - started < limitMs) {
    await sleep(Math.min(5000, Math.max(0, limitMs - (clock() - started))));
    const check = await readReceipt(reply.post_id);
    if (routeMissing(check)) { err(NO_RECEIPTS); return 1; }
    if (check && (check.status === 401 || check.status === 403)) { err(`could not check ${reply.post_id}: ${serverMessage(check, business)}`); return 1; }
    if (!check || !check.ok || !check.data || typeof check.data !== 'object') continue;
    receipt = check.data;
    const people = (Array.isArray(receipt.recipients) ? receipt.recipients : []).filter((p) => p && typeof p === 'object');
    if (!people.length) continue;
    const person = pickRecipient(people, reply, target);
    if (!person) {
      err(`the receipt does not list ${to}, so --wait stopped here. check: atris tell status ${text(reply.post_id)} --business ${business.slug}`);
      return 1;
    }
    const words = personWords(person, receipt);
    if (words !== last && !quiet) log(`${String(elapsed()).padStart(4)}s  ${to} ${words}`);
    last = words;
    const state = text(person.state);
    if (state === 'completed') { outcome = 'finished'; break; }
    if (hasAnswered(person)) { outcome = 'answered'; break; }
    if (FINAL_STATES.has(state)) { outcome = state; break; }
  }
  const seconds = elapsed();
  if (quiet) {
    log(JSON.stringify({ ...(receipt || { post_id: reply.post_id, recipients: [] }), waited_seconds: seconds }));
  } else if (outcome === 'timeout') {
    log(`no answer from ${to} after ${seconds} seconds`);
  } else if (outcome === 'answered' || outcome === 'finished') {
    log(`${outcome} in ${seconds} seconds`);
  } else {
    log(`${to} ${outcome === 'blocked' ? 'is blocked' : 'failed'} after ${seconds} seconds`);
  }
  return outcome === 'answered' || outcome === 'finished' ? 0 : 1;
}

// atris tell listen: the open line. Holds one wait at a time on the member's
// inbox (GET /api/swarlo/{business}/inbox/wait, up to 25 seconds each) and
// prints each note the moment it lands. A timeout or a network error just
// waits again, after a short pause that grows while the server is away. It
// never marks notes read. Backend: services/inbox_wait_service.py.
const LISTEN_SECONDS = 25;
const MAX_PAUSE_MS = 30000;

function noteLine(item) {
  const who = text(item.author_name) || 'someone';
  const where = text(item.channel) ? ` in #${text(item.channel)}` : '';
  const body = text(item.content).replace(/\s+/g, ' ') || '(no text)';
  const id = text(item.post_id);
  return `${who}${where}: ${body}${id ? `  (post ${id})` : ''}`;
}

async function listen(pos, flags, deps, log, err, setSecret) {
  if (pos.length > 1) { err('atris tell listen takes no names. say whose notes with --as, like: atris tell listen --as walsh'); return 1; }
  const who = memberName(flags, deps.env || process.env);
  if (!who) { err('say whose notes to listen for, like: atris tell listen --as walsh (or set ATRIS_AGENT)'); return 1; }
  const business = resolveChannelBusiness(flags, deps);
  if (business.error) { err(business.error); return 1; }
  const token = await loginToken(deps);
  if (!token) { err(NOT_LOGGED_IN); return 1; }
  setSecret(token);
  const request = deps.apiRequestJson || apiRequestJson;
  const found = await lookupMember(request, business, who, token);
  if (found.missing) { err(`no member called "${who}" in ${business.slug}, so there is nothing to listen to`); return 1; }
  if (found.failed !== undefined) { err(`could not look up member "${who}": ${boardWhy(found.failed, business)}`); return 1; }
  if (found.noId) { err(`member "${who}" in ${business.slug} has no agent id, so it has no inbox`); return 1; }
  const member = found.member;

  const sleep = deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const rounds = Number.isInteger(deps.rounds) ? deps.rounds : Infinity; // tests stop the loop
  const base = `/swarlo/${encodeURIComponent(business.id)}/inbox/wait?agent_id=${encodeURIComponent(member.id)}`;
  if (!flags.json) log(`listening for notes to ${member.name} in ${business.slug}. ctrl-c to stop`);
  let after = null;
  let pause = 0;
  for (let round = 0; round < rounds; round += 1) {
    const query = `${base}&timeout=${LISTEN_SECONDS}${after === null ? '' : `&after_seq=${after}`}`;
    const res = await request(query, { method: 'GET', token, timeoutMs: (LISTEN_SECONDS + 15) * 1000, retries: 0 });
    if (routeMissing(res)) { err('This Atris server does not have the open line yet. Read the inbox instead: atris channel'); return 1; }
    if (res && [401, 403, 404].includes(res.status)) { err(`stopped listening: ${serverMessage(res, business)}`); return 1; }
    if (!res || !res.ok || !res.data || typeof res.data !== 'object') {
      // The server is away or the line dropped: wait a little longer each time, then try again.
      pause = Math.min(MAX_PAUSE_MS, pause ? pause * 2 : 1000);
      await sleep(pause);
      continue;
    }
    pause = 0;
    const reply = res.data;
    if (reply.ended === 'replaced') {
      err(`another listener took the line for ${member.name}, so this one stopped. keep one listener per member`);
      return 1;
    }
    const items = (Array.isArray(reply.items) ? reply.items : []).filter((i) => i && typeof i === 'object');
    for (const item of items) log(flags.json ? JSON.stringify(item) : noteLine(item));
    if (Number.isInteger(reply.after_seq)) after = reply.after_seq;
  }
  return 0;
}

// One line per member a channel post reached, when the server says who.
function reachedLines(reply) {
  const list = reply && Array.isArray(reply.delivered_to) ? reply.delivered_to : null;
  if (!list) return [];
  return list.map((d) => {
    const to = text(d && d.to) || 'someone';
    if (d && d.wakes === true) return `reached ${to}'s inbox, will wake`;
    if (d && d.wakes === false) return `reached ${to}'s inbox, will not wake`;
    return `reached ${to}'s inbox`;
  });
}

module.exports = { tellCommand, tellHelp, reachedLines };
