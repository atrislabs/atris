'use strict';

// atris channel: the team's shared channels on the hosted Atris server.
// Agents on any computer read, post, claim, and report by channel name, with
// the sign-in they already have. Backend: /api/swarlo/{business}/... (the
// business may be its slug or its id; the server takes both).

const { apiRequestJson } = require('../utils/api');
const { NOT_LOGGED_IN } = require('../lib/developer-api');
const { parseArgs, loginToken, relativeTime, clip } = require('../lib/business-target');
const { resolveChannelBusiness, boardWhy, memberName, lookupMember } = require('../lib/team-board');

// Words that are verbs here, so no channel can be called one of them.
const REPORTS = ['done', 'failed', 'blocked'];
const VERBS = new Set(['list', 'claim', ...REPORTS]);
const FLAGS = { switches: ['new'], values: ['channel', 'limit', 'task', 'as'] };
const OVERVIEW_PER_CHANNEL = 3;
// The server reads the newest limit x 3 posts of the whole business and then
// keeps one channel's, so a small limit hides a quiet channel's older posts.
// Always ask for its most (50) and trim here.
const SERVER_MAX = 50;

function channelHelp(log = console.log) {
  log(`usage: atris channel                                   what's new in every channel
       atris channel <name>                            read a channel, newest last
       atris channel <name> "message"                  post to it
       atris channel <name> "what to do" --task <key>  post a task others can claim
       atris channel claim <task-key> ["note"]         claim a task
       atris channel done <task-key> "summary"         report it done (also: failed, blocked)
       atris channel list                              channel names only

options:
  --business <slug>   which business (else ATRIS_BUSINESS, this folder's business, or your only one)
  --as <member>       post, claim, and report as that team member (else ATRIS_AGENT, else you)
  --channel <name>    for claim and done: skip the search for the task's channel
  --limit <n>         posts to read, 1 to 50 (default 20)
  --new               post to a channel that does not exist yet
  --json              raw replies from the server

the team's channels on the hosted Atris server, shared by every agent on every
computer. uses your existing sign-in (atris login).`);
}

function postLine(post, now, width = 400) {
  const who = clip(post.member_name || 'someone', 18);
  const when = relativeTime(post.created_at, now) || '';
  const key = post.task_key ? String(post.task_key) : '';
  let tag = key ? `[${key}] ` : '';
  if (post.kind === 'claim') tag = `claimed ${key}: `;
  else if (post.kind === 'result') tag = `done ${key}: `;
  else if (post.kind === 'failed') tag = `${post.status || 'failed'} ${key}: `;
  return `${who.padEnd(12)}  ${when.padEnd(11)}  ${clip(`${tag}${post.content || ''}`, width)}`;
}

function closest(name, channels) {
  const n = name.toLowerCase();
  return channels.find((c) => c.toLowerCase().startsWith(n.slice(0, 3))) || null;
}

async function channelCommand(args = [], deps = {}) {
  let secret = '';
  const hide = (line) => (secret ? String(line).split(secret).join('[hidden]') : String(line));
  const log = (line) => (deps.log || console.log)(hide(line));
  const err = (line) => (deps.err || console.error)(hide(line));
  const now = deps.now ? deps.now() : Date.now();

  const { flags, pos, error } = parseArgs(args, FLAGS);
  if (flags.help || pos[0] === 'help') { channelHelp(log); return 0; }
  if (error) { err(`${error}. see: atris channel --help`); return 1; }

  const verb = VERBS.has(pos[0]) ? pos[0] : null;
  const name = verb ? null : (pos[0] ? pos[0].replace(/^#/, '') : null);
  const taskKey = verb && verb !== 'list' ? pos[1] : null;
  const text = verb ? pos.slice(2).join(' ').trim() : pos.slice(1).join(' ').trim();
  if (verb && verb !== 'list' && !taskKey) { err(`${verb} needs a task key, like: atris channel ${verb} <task-key>${verb === 'claim' ? '' : ' "summary"'}`); return 1; }
  if (REPORTS.includes(verb) && !text) { err(`${verb} needs a summary, like: atris channel ${verb} ${taskKey} "what happened"`); return 1; }
  if (verb === 'list' && pos.length > 1) { err('atris channel list takes no other words'); return 1; }
  if (name === '') { err('give a channel name, like: atris channel general'); return 1; }
  const limit = flags.limit == null ? 20 : Number(flags.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) { err('--limit takes a whole number from 1 to 50'); return 1; }

  const business = resolveChannelBusiness(flags, deps);
  if (business.error) { err(business.error); return 1; }
  const token = await loginToken(deps);
  if (!token) { err(NOT_LOGGED_IN); return 1; }
  secret = token;

  const request = deps.apiRequestJson || apiRequestJson;
  const base = `/swarlo/${encodeURIComponent(business.id)}`;
  const call = (route, options = {}) => request(`${base}${route}`, { method: 'GET', ...options, token });
  const why = (res) => boardWhy(res, business);
  const say = (res) => log(JSON.stringify(res.data));
  const channelList = async () => {
    const res = await call('/channels');
    if (!res || !res.ok) { err(`could not list ${business.slug}'s channels: ${why(res)}`); return null; }
    return Array.isArray(res.data && res.data.channels) ? res.data.channels.map(String) : [];
  };
  const readPosts = async (channel, n) => {
    const res = await call(`/channels/${encodeURIComponent(channel)}/posts?limit=${SERVER_MAX}`);
    if (res && res.ok && res.data && Array.isArray(res.data.posts)) {
      const posts = res.data.posts.slice(0, n);
      return { ...res, data: { ...res.data, count: posts.length, posts } };
    }
    return res;
  };
  const unknownChannel = (channel, channels) => {
    const near = closest(channel, channels);
    err(`no channel named "${channel}" in ${business.slug}.${near ? ` did you mean ${near}?` : ''} channels: ${channels.join(', ') || 'none yet'}`);
  };

  // Find where a task lives: --channel, then an open claim, then any post carrying the key.
  const findTaskChannel = async (key, useClaims) => {
    if (typeof flags.channel === 'string') return { channel: flags.channel.replace(/^#/, '') };
    if (useClaims) {
      const res = await call('/claims');
      if (!res || !res.ok) return { failed: `could not check open claims: ${why(res)}` };
      const hit = ((res.data && res.data.claims) || []).find((c) => c.task_key === key && c.channel);
      if (hit) return { channel: hit.channel };
    }
    const channels = await channelList();
    if (!channels) return { failed: 'shown' };
    const reads = await Promise.all(channels.map((c) => readPosts(c, SERVER_MAX)));
    let best = null;
    reads.forEach((res, i) => {
      if (!res || !res.ok) return;
      for (const p of (res.data && res.data.posts) || []) {
        if (p.task_key !== key) continue;
        if (!best || String(p.created_at || '') > String(best.created_at || '')) best = { ...p, channel: p.channel || channels[i] };
      }
    });
    if (best) return { channel: best.channel };
    return { failed: `no channel has a task called "${key}" in ${business.slug}. check the key with: atris channel, or start it in one with --channel <name>` };
  };

  // Writes go out as a team member when one is named (--as, else ATRIS_AGENT),
  // so a member's post reads as that member, not as the signed-in person. A
  // member that cannot be found stops the write; it never falls back to you.
  const writes = (verb && verb !== 'list') || (name && text);
  const env = deps.env || process.env;
  const asWho = memberName(flags, env);
  let member = null;
  if (writes && asWho) {
    const found = await lookupMember(request, business, asWho, token);
    if (found.missing) { err(`no member called "${asWho}" in ${business.slug}, so nothing was sent. check the name, or leave off --as to post as yourself`); return 1; }
    if (found.failed !== undefined) { err(`could not look up member "${asWho}", so nothing was sent: ${why(found.failed)}`); return 1; }
    if (found.noId) { err(`member "${asWho}" in ${business.slug} has no agent id, so nothing was sent`); return 1; }
    member = found.member;
  }
  const signed = (body) => (member ? { ...body, agent_id: member.id } : body);
  const byline = member ? ` as ${member.name}` : '';

  if (verb === 'claim' || REPORTS.includes(verb)) {
    const found = await findTaskChannel(taskKey, verb !== 'claim');
    if (found.failed) { if (found.failed !== 'shown') err(found.failed); return 1; }
    const channel = found.channel;
    const res = verb === 'claim'
      ? await call(`/channels/${encodeURIComponent(channel)}/claim`, { method: 'POST', body: signed({ task_key: taskKey, content: text || `claimed ${taskKey}` }) })
      : await call(`/channels/${encodeURIComponent(channel)}/report`, { method: 'POST', body: signed({ task_key: taskKey, status: verb, content: text }) });
    if (!res || !res.ok) { err(`could not ${verb === 'claim' ? 'claim' : 'report'} ${taskKey} in #${channel}: ${why(res)}`); return 1; }
    if (flags.json) say(res);
    else log(verb === 'claim' ? `claimed ${taskKey} in #${channel}${byline}` : `${taskKey} is ${verb} in #${channel}${byline}`);
    return 0;
  }

  if (verb === 'list') {
    const channels = await channelList();
    if (!channels) return 1;
    log(flags.json ? JSON.stringify({ channels }) : channels.map((c) => `#${c}`).join('\n'));
    return 0;
  }

  if (name && text) {
    const channels = await channelList();
    if (!channels) return 1;
    if (!channels.includes(name) && !flags.new) { unknownChannel(name, channels); err(`to start #${name}, add --new`); return 1; }
    const body = signed(typeof flags.task === 'string' ? { content: text, task_key: flags.task } : { content: text });
    const res = await call(`/channels/${encodeURIComponent(name)}/posts`, { method: 'POST', body });
    if (!res || !res.ok) { err(`could not post to #${name}: ${why(res)}`); return 1; }
    if (flags.json) say(res);
    else log(body.task_key ? `posted task ${body.task_key} to #${name}${byline}. claim it: atris channel claim ${body.task_key}` : `posted to #${name}${byline}`);
    return 0;
  }

  if (name) {
    const res = await readPosts(name, limit);
    if (!res || !res.ok) { err(`could not read #${name}: ${why(res)}`); return 1; }
    const posts = (res.data && res.data.posts) || [];
    if (!posts.length) {
      const channels = await channelList();
      if (channels && !channels.includes(name)) { unknownChannel(name, channels); return 1; }
    }
    if (flags.json) { say(res); return 0; }
    if (!posts.length) { log(`#${name} has no posts yet. post one: atris channel ${name} "hello"`); return 0; }
    log(`#${name}`);
    for (const p of posts.slice().reverse()) log(`  ${postLine(p, now)}`);
    return 0;
  }

  // No name: the latest few posts in every channel, busiest-most-recent first.
  const channels = await channelList();
  if (!channels) return 1;
  const reads = await Promise.all(channels.map((c) => readPosts(c, OVERVIEW_PER_CHANNEL)));
  const failed = reads.map((r, i) => (r && r.ok ? null : `#${channels[i]}: ${why(r)}`)).filter(Boolean);
  const rows = channels.map((c, i) => ({ channel: c, posts: (reads[i] && reads[i].ok && reads[i].data && reads[i].data.posts) || [] }));
  if (flags.json) {
    log(JSON.stringify({ business: business.slug, channels: rows }));
  } else {
    const active = rows.filter((r) => r.posts.length)
      .sort((a, b) => String(b.posts[0].created_at || '').localeCompare(String(a.posts[0].created_at || '')));
    const quiet = rows.filter((r) => !r.posts.length).map((r) => `#${r.channel}`);
    if (!active.length) log(`no posts yet in ${business.slug}'s channels.`);
    active.forEach((r, i) => {
      if (i) log('');
      log(`#${r.channel}`);
      for (const p of r.posts.slice().reverse()) log(`  ${postLine(p, now, 140)}`);
    });
    if (quiet.length) { log(''); log(`quiet: ${quiet.join(', ')}`); }
  }
  for (const f of failed) err(`could not read ${f}`);
  return failed.length === channels.length && channels.length ? 1 : 0;
}

module.exports = { channelCommand, resolveChannelBusiness };
