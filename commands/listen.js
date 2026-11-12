'use strict';

// atris listen: a team member's inbox on the team board. Shows what was sent
// to that member (mentions, replies, tasks) that it has not marked handled.
// Backend: GET /api/swarlo/{business}/inbox and POST .../inbox/ack.
//
// Exit codes are for scripts: 0 something new, 1 nothing new, 2 error.
//   if atris listen --as walsh --json > new.json; then ...; fi

const { apiRequestJson } = require('../utils/api');
const { NOT_LOGGED_IN } = require('../lib/developer-api');
const { parseArgs, loginToken, relativeTime, clip } = require('../lib/business-target');
const { resolveChannelBusiness, boardWhy, memberName, lookupMember } = require('../lib/team-board');

const FLAGS = { switches: ['watch'], values: ['as', 'limit', 'ack'] };
const NEW = 0;
const NOTHING = 1;
const FAILED = 2;
const WATCH_MS = 30000;

function listenHelp(log = console.log) {
  log(`usage: atris listen --as <member>                 what was sent to that member, oldest first
       atris listen --as <member> --ack <number>  mark everything up to that number handled
       atris listen --as <member> --watch         keep checking every 30 seconds (Ctrl-C to stop)

options:
  --as <member>       whose inbox (else ATRIS_AGENT)
  --business <slug>   which business (else ATRIS_BUSINESS, this folder's business, or your only one)
  --limit <n>         how many to show, 1 to 50 (default 20)
  --json              the server's reply as is

exits 0 when something is new, 1 when nothing is, 2 on an error, so a script
can run: if atris listen --as walsh --json > new.json; then ...; fi
--watch never marks anything handled. uses your existing sign-in (atris login).`);
}

// Oldest first, whatever order the server sent.
function bySeq(items) {
  return items.slice().sort((a, b) => Number(a.seq) - Number(b.seq));
}

function itemLines(items, now) {
  const rows = items.map((it) => ({
    channel: `#${clip(it.channel || '?', 20)}`,
    who: clip(it.author_name || it.author_id || 'someone', 18),
    when: relativeTime(it.created_at, now) || '',
    text: `[${it.reason || 'note'}] ${clip(it.content || '', 200)}`,
  }));
  const w = (key) => Math.max(...rows.map((r) => r[key].length));
  const wc = w('channel'); const ww = w('who'); const wt = w('when');
  return rows.map((r) => `${r.channel.padEnd(wc)}  ${r.who.padEnd(ww)}  ${r.when.padEnd(wt)}  ${r.text}`);
}

async function listenCommand(args = [], deps = {}) {
  let secret = '';
  const hide = (line) => (secret ? String(line).split(secret).join('[hidden]') : String(line));
  const log = (line) => (deps.log || console.log)(hide(line));
  const err = (line) => (deps.err || console.error)(hide(line));
  const clock = () => (deps.now ? deps.now() : Date.now());
  const env = deps.env || process.env;

  const { flags, pos, error } = parseArgs(args, FLAGS);
  if (flags.help || pos[0] === 'help') { listenHelp(log); return 0; }
  if (error) { err(`${error}. see: atris listen --help`); return FAILED; }
  if (pos.length) { err(`atris listen takes no other words. to name the member: atris listen --as ${pos[0].replace(/^@/, '')}`); return FAILED; }

  const who = memberName(flags, env);
  if (!who) { err('say who is listening: atris listen --as <member>'); return FAILED; }
  const limit = flags.limit == null ? 20 : Number(flags.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) { err('--limit takes a whole number from 1 to 50'); return FAILED; }
  const ack = flags.ack == null ? null : Number(flags.ack);
  if (ack !== null && (!Number.isInteger(ack) || ack < 0)) { err('--ack takes the number shown on the last line, like: atris listen --as ' + who + ' --ack 42'); return FAILED; }
  if (ack !== null && flags.watch) { err('--ack and --watch do not go together: --watch never marks anything handled'); return FAILED; }

  const business = resolveChannelBusiness(flags, deps);
  if (business.error) { err(business.error); return FAILED; }
  const token = await loginToken(deps);
  if (!token) { err(NOT_LOGGED_IN); return FAILED; }
  secret = token;

  const request = deps.apiRequestJson || apiRequestJson;
  const why = (res) => boardWhy(res, business);
  const found = await lookupMember(request, business, who, token);
  if (found.missing) { err(`no member called "${who}" in ${business.slug}, so nothing was checked. check the spelling of the name`); return FAILED; }
  if (found.failed !== undefined) { err(`could not look up member "${who}": ${why(found.failed)}`); return FAILED; }
  if (found.noId) { err(`member "${who}" in ${business.slug} has no agent id, so it has no inbox`); return FAILED; }
  const member = found.member;

  const base = `/swarlo/${encodeURIComponent(business.id)}/inbox`;
  const inboxWhy = (res) => (res && res.status === 404 && res.data && res.data.detail === 'Not Found'
    ? 'this server has no inboxes yet; the update may still be rolling out'
    : why(res));
  // The same command again, so the hint is copyable as is.
  const again = `atris listen --as ${who}${Object.prototype.hasOwnProperty.call(flags, 'business') ? ` --business ${business.slug}` : ''}`;

  if (ack !== null) {
    const res = await request(`${base}/ack`, { method: 'POST', token, body: { agent_id: member.id, seq: ack } });
    if (!res || !res.ok) { err(`could not mark ${member.name}'s inbox handled: ${inboxWhy(res)}`); return FAILED; }
    if (flags.json) { log(JSON.stringify(res.data)); return 0; }
    const upTo = Number(res.data && res.data.read_up_to);
    if (Number.isFinite(upTo) && upTo > ack) log(`${member.name}'s inbox was already handled up to ${upTo}; nothing changed.`);
    else log(`marked handled for ${member.name}, up to ${Number.isFinite(upTo) ? upTo : ack}.`);
    return 0;
  }

  const fetchInbox = async () => {
    // --watch asks for the most the server gives, since it never marks
    // anything handled and would otherwise keep seeing the same oldest few.
    const n = flags.watch ? 50 : limit;
    const res = await request(`${base}?agent_id=${encodeURIComponent(member.id)}&limit=${n}`, { method: 'GET', token });
    if (!res || !res.ok) return { failed: inboxWhy(res), res };
    if (!res.data || !Array.isArray(res.data.items)) return { failed: 'the server answered without an items list' };
    return { data: res.data, items: bySeq(res.data.items) };
  };

  if (!flags.watch) {
    const got = await fetchInbox();
    if (got.failed) { err(`could not read ${member.name}'s inbox: ${got.failed}`); return FAILED; }
    if (flags.json) { log(JSON.stringify(got.data)); return got.items.length ? NEW : NOTHING; }
    if (!got.items.length) { log(`nothing new for ${member.name}.`); return NOTHING; }
    for (const line of itemLines(got.items, clock())) log(line);
    if (got.items.length >= limit) log(`showing the oldest ${got.items.length}; more are waiting after these are handled.`);
    log(`mark handled: ${again} --ack ${got.items[got.items.length - 1].seq}`);
    return NEW;
  }

  // --watch: for a person at a terminal. Prints only items it has not shown
  // yet and never marks anything handled. Errors that retrying cannot fix
  // (sign-in, access, no such business) stop it; the rest wait for the next round.
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const keepGoing = deps.keepGoing || (() => true);
  if (!deps.sleep) process.once('SIGINT', () => { (deps.log || console.log)('stopped listening.'); process.exit(0); });
  if (!flags.json) log(`listening for ${member.name} in ${business.slug}. checks every 30 seconds; Ctrl-C to stop.`);
  let shown = -Infinity;
  let first = true;
  for (;;) {
    const got = await fetchInbox();
    if (got.failed) {
      err(`could not read ${member.name}'s inbox: ${got.failed}`);
      if (got.res && [401, 403, 404].includes(got.res.status)) return FAILED;
    } else {
      const fresh = got.items.filter((it) => Number(it.seq) > shown);
      if (fresh.length) {
        if (flags.json) for (const it of fresh) log(JSON.stringify(it));
        else for (const line of itemLines(fresh, clock())) log(line);
        shown = Math.max(shown, ...fresh.map((it) => Number(it.seq)));
        if (!flags.json) log(`mark handled: ${again} --ack ${shown}`);
      } else if (first && !flags.json) {
        log(`nothing new for ${member.name} yet.`);
      }
    }
    first = false;
    if (!keepGoing()) return 0;
    await sleep(deps.intervalMs || WATCH_MS);
  }
}

module.exports = { listenCommand };
