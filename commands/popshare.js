'use strict';

/**
 * atris popshare - the posts calendar: what goes out today, what is due by
 * hand, what failed, and how the week is tracking against cadence goals.
 * Popshare never writes the words; every post here is one a person saved.
 */

const { apiRequestJson } = require('../utils/api');
const { loadCredentials } = require('../utils/auth');
const { NOT_LOGGED_IN, wantsHelp, wantsJson, tokenFrom, oneLine, printResult } = require('../lib/developer-api');

const PLATFORMS = ['x', 'linkedin', 'blog', 'instagram', 'tiktok'];
const PLATFORM_LABELS = { x: 'X', linkedin: 'LinkedIn', blog: 'Blog', instagram: 'Instagram', tiktok: 'TikTok' };
const EDITABLE_STATUSES = new Set(['idea', 'draft', 'ready', 'scheduled', 'failed', 'check']);
const DAY_MS = 24 * 60 * 60 * 1000;

function showPopshareHelp(log = console.log) {
  log('usage: atris popshare [--json]                          today: what goes out, due by hand, gaps');
  log('       atris popshare add <platform> "text" [--at "YYYY-MM-DD HH:MM"] [--idea|--draft|--ready] [--theme t] [--note n]...');
  log('       atris popshare list [--days 7]');
  log('       atris popshare schedule <id> --at "YYYY-MM-DD HH:MM"');
  log('       atris popshare edit <id> [--text "..."] [--theme t] [--note n]... [--status s] [--platform p]');
  log('       atris popshare post <id>                            send an x or linkedin post now');
  log('       atris popshare posted <id> [--url u]                 mark a by-hand post as posted');
  log('       atris popshare rm <id>');
  log('       atris popshare score [--weeks 4]');
  log('       atris popshare install <business>                    add popshare to a workspace');
  log('platforms: x, linkedin, blog, instagram, tiktok. --at is local time. ids take the first 6+ characters.');
}

/** "2026-11-14 09:30" read as local wall time, returned as a UTC ISO string. */
function localAtToIso(value) {
  const text = String(value || '').trim();
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) return null;
  const [, y, mo, d, h, mi, s] = match;
  const date = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s || 0));
  if (Number.isNaN(date.getTime())) return null;
  // Date rolls impossible days forward (Feb 31 becomes Mar 3); reject those.
  if (date.getFullYear() !== Number(y) || date.getMonth() !== Number(mo) - 1
    || date.getDate() !== Number(d) || date.getHours() !== Number(h)
    || date.getMinutes() !== Number(mi)) return null;
  return date.toISOString();
}

/** Pull `add <platform> "text" [flags]` apart into a create body. */
function parseAddArgs(args = []) {
  const flags = { at: undefined, theme: undefined, notes: [], status: null };
  const positional = [];
  const rest = args.filter((arg) => arg !== '--json');
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === '--at' || arg === '--theme' || arg === '--note') {
      const value = rest[i + 1];
      if (value === undefined || value.startsWith('--')) return { error: `${arg} needs a value` };
      if (arg === '--at') flags.at = value;
      else if (arg === '--theme') flags.theme = value;
      else flags.notes.push(value);
      i += 1;
      continue;
    }
    if (arg === '--idea' || arg === '--draft' || arg === '--ready') {
      flags.status = arg.slice(2);
      continue;
    }
    if (arg.startsWith('--')) return { error: `unknown flag ${arg}` };
    positional.push(arg);
  }

  const rawPlatform = String(positional[0] || '').trim().toLowerCase();
  const platform = rawPlatform === 'twitter' ? 'x' : rawPlatform;
  const text = positional.slice(1).join(' ').trim();
  if (!PLATFORMS.includes(platform)) {
    return { error: `platform must be one of ${PLATFORMS.join(', ')}` };
  }
  if (!text) return { error: 'write the post: atris popshare add x "your words"' };

  let scheduledFor = null;
  if (flags.at !== undefined) {
    scheduledFor = localAtToIso(flags.at);
    if (!scheduledFor) return { error: 'write --at as YYYY-MM-DD HH:MM, like 2026-11-14 09:30' };
    if (flags.status) return { error: '--at schedules the post; drop --idea/--draft/--ready' };
  }
  return {
    platform,
    text,
    status: scheduledFor ? 'scheduled' : (flags.status || 'draft'),
    scheduledFor,
    theme: flags.theme,
    notes: flags.notes,
  };
}

/** First-6+-characters id lookup against the post list. */
function resolvePostId(posts, input) {
  const needle = String(input || '').trim();
  if (needle.length < 6) return { error: 'give at least 6 characters of the post id' };
  const list = Array.isArray(posts) ? posts : [];
  const exact = list.find((post) => post && post.id === needle);
  if (exact) return { id: exact.id, post: exact };
  const matches = list.filter((post) => post && String(post.id || '').startsWith(needle));
  if (matches.length === 1) return { id: matches[0].id, post: matches[0] };
  if (matches.length > 1) {
    return {
      error: 'more than one post matches; be more specific',
      candidates: matches.slice(0, 8).map((post) => ({
        id: post.id,
        platform: post.platform,
        status: post.status,
        text: post.text,
      })),
    };
  }
  return { error: `no post matches "${needle}"` };
}

function platformName(platform) {
  const key = String(platform || '').trim().toLowerCase();
  return PLATFORM_LABELS[key] || key || 'post';
}

function shortId(id) {
  return String(id || '').slice(0, 8);
}

function postSnippet(post) {
  const raw = post && (post.text || post.title);
  const text = String(raw || '').replace(/\s+/g, ' ').trim();
  return text.length > 80 ? `${text.slice(0, 79)}...` : text;
}

function localTime(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function dayKey(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function gapLine(gap = {}) {
  const label = platformName(gap.platform);
  const have = Number(gap.have || 0);
  const wanted = Number(gap.wanted || 0);
  const when = gap.period === 'day' ? 'today' : 'this week';
  if (!have) return `No ${label} post ${when}. You wanted ${wanted}.`;
  return `${label}: ${have} of ${wanted} ${when}.`;
}

function calendarRow(post, extra = '') {
  const when = localTime(post.scheduled_for || post.posted_at || post.created_at);
  const label = platformName(post.platform).padEnd(9);
  return `  ${when}  ${label} ${postSnippet(post)}${extra}`;
}

/** Broken X/LinkedIn connections worth a line up top. Only platforms the
 * person has a goal for or a scheduled post on qualify, same as the web. */
function connectionLines(data = {}) {
  const connections = data.connections && typeof data.connections === 'object' ? data.connections : null;
  if (!connections) return [];
  const goals = data.goals && typeof data.goals === 'object' ? data.goals : {};
  const scheduled = [
    ...(Array.isArray(data.scheduled_today) ? data.scheduled_today : []),
    ...(Array.isArray(data.due_by_hand) ? data.due_by_hand : []),
  ];
  const lines = [];
  for (const platform of ['x', 'linkedin']) {
    const state = String(connections[platform] || 'ok');
    if (!state || state === 'ok') continue;
    const goal = Number(goals[platform] || 0);
    const hasScheduled = scheduled.some((post) => post.platform === platform && post.status === 'scheduled');
    if (!(Number.isFinite(goal) && goal > 0) && !hasScheduled) continue;
    if (platform === 'x') {
      lines.push(state === 'reconnect'
        ? 'X needs a fresh connection. Reconnect it so scheduled posts go out and your tweets count.'
        : "X isn't connected. Connect it so scheduled posts go out and your tweets count.");
    } else {
      lines.push("LinkedIn isn't connected. Connect it so scheduled posts go out.");
    }
  }
  return lines;
}

/** The today board as a few short sections. */
function todayText(data = {}) {
  const lines = [...connectionLines(data)];
  const scheduled = Array.isArray(data.scheduled_today) ? data.scheduled_today : [];
  const posted = Array.isArray(data.posted_today) ? data.posted_today : [];
  const byHand = Array.isArray(data.due_by_hand) ? data.due_by_hand : [];
  const failed = Array.isArray(data.failed) ? data.failed : [];
  const check = Array.isArray(data.check) ? data.check : [];
  const gaps = Array.isArray(data.gaps) ? data.gaps : [];

  if (scheduled.length) {
    lines.push('going out');
    scheduled.forEach((post) => lines.push(calendarRow(post)));
  }
  if (byHand.length) {
    lines.push('post by hand');
    byHand.forEach((post) => lines.push(calendarRow(post)));
  }
  if (posted.length) {
    lines.push('posted');
    posted.forEach((post) => lines.push(calendarRow(post)));
  }
  if (failed.length) {
    lines.push('failed');
    failed.forEach((post) => lines.push(calendarRow(post, `  ${oneLine(post.error)}`)));
  }
  if (check.length) {
    lines.push('check the account');
    check.forEach((post) => lines.push(calendarRow(post, `  ${oneLine(post.error)}`)));
  }
  if (gaps.length) {
    lines.push('gaps');
    gaps.forEach((gap) => lines.push(`  ${gapLine(gap)}`));
  }
  return lines.length ? lines.join('\n') : 'nothing on the calendar today.';
}

/** Posts grouped by local day, calendar style. */
function listText(posts = []) {
  const list = Array.isArray(posts) ? posts : [];
  if (!list.length) return 'no posts in this window. add one: atris popshare add x "your words"';
  const now = new Date();
  const todayKey = dayKey(now);
  const tomorrowKey = dayKey(new Date(now.getTime() + DAY_MS));
  const groups = new Map();
  for (const post of list) {
    const when = post.scheduled_for || post.posted_at || post.created_at;
    const key = dayKey(when) || 'undated';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(post);
  }
  const lines = [];
  for (const [key, items] of groups) {
    let label = key;
    if (key === todayKey) label = 'today';
    else if (key === tomorrowKey) label = 'tomorrow';
    else if (key !== 'undated') {
      const date = new Date(`${key}T12:00:00`);
      label = Number.isNaN(date.getTime())
        ? key
        : date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    }
    lines.push(label);
    for (const post of items) {
      const status = post.status && !['scheduled', 'posted'].includes(post.status) ? ` (${post.status})` : '';
      lines.push(calendarRow(post, status));
    }
  }
  return lines.join('\n');
}

/** Scoreboard units as label plus value/target lines. */
function scoreText(units = []) {
  const list = Array.isArray(units) ? units : [];
  if (!list.length) return 'no platforms on the scoreboard yet.';
  const period = String((list[0] && list[0].period) || '').replace(/d$/, '');
  const width = Math.max(...list.map((unit) => String(unit.label || unit.id).length));
  const lines = [`last ${period} days`];
  for (const unit of list) {
    const value = unit.value === null || unit.value === undefined
      ? 'no data'
      : Number(unit.value).toLocaleString('en-US');
    const target = unit.target !== null && unit.target !== undefined
      ? ` / ${Number(unit.target).toLocaleString('en-US')}`
      : '';
    lines.push(`${String(unit.label || unit.id).padEnd(width)}  ${value}${target}`);
  }
  return lines.join('\n');
}

function apiFailure(result) {
  const status = Number(result && result.status);
  if (status === 401) return NOT_LOGGED_IN;
  return oneLine(result && result.error) || `HTTP ${status || '?'}`;
}

async function popshareCommand(args = [], deps = {}) {
  const io = { log: deps.log || console.log, err: deps.err || console.error };
  if (wantsHelp(args)) {
    showPopshareHelp(io.log);
    return 0;
  }
  const json = wantsJson(args);
  const fail = (error, extra = {}) => {
    printResult({ json, ok: false, error, payload: { ok: false, error, ...extra } }, io);
    return 1;
  };

  const token = tokenFrom((deps.loadCredentials || loadCredentials)());
  if (!token) return fail(NOT_LOGGED_IN);
  const request = deps.apiRequestJson || apiRequestJson;

  // --business scopes every call to one workspace; --json is already read.
  let businessId = null;
  const clean = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--business') {
      businessId = args[i + 1];
      i += 1;
      continue;
    }
    if (args[i] !== '--json') clean.push(args[i]);
  }
  const scopeQuery = businessId ? `business_id=${encodeURIComponent(businessId)}` : '';
  const withScope = (path) => (scopeQuery ? `${path}${path.includes('?') ? '&' : '?'}${scopeQuery}` : path);
  const tz = deps.timeZone
    || (typeof Intl !== 'undefined' && Intl.DateTimeFormat().resolvedOptions().timeZone)
    || 'UTC';

  const call = async (path, options = {}) => {
    const result = await request(withScope(path), {
      method: options.method || 'GET',
      token,
      ...(options.body !== undefined ? { body: options.body } : {}),
      ...(options.retries !== undefined ? { retries: options.retries } : {}),
    });
    if (!result || !result.ok) {
      return { error: apiFailure(result), status: result && result.status };
    }
    return { data: result.data };
  };

  const allPosts = async () => {
    const got = await call('/popshare/posts?start=2000-01-01&end=2100-01-01');
    if (got.error) return got;
    return { posts: (got.data && got.data.posts) || [] };
  };

  const resolveId = async (input) => {
    const got = await allPosts();
    if (got.error) return got;
    const resolved = resolvePostId(got.posts, input);
    if (resolved.error) return { error: resolved.error, candidates: resolved.candidates };
    return { id: resolved.id, post: resolved.post };
  };

  const failResolution = (resolved) => {
    if (resolved.candidates && resolved.candidates.length) {
      resolved.candidates.forEach((post) => {
        io.err(`  ${String(post.id || '').slice(0, 12)}  ${platformName(post.platform)}  ${postSnippet(post)}`);
      });
    }
    return fail(resolved.error);
  };

  const cmd = clean[0];
  const rest = clean.slice(1);

  try {
    if (!cmd || cmd === 'today') {
      const got = await call(`/popshare/today?tz=${encodeURIComponent(tz)}`);
      if (got.error) return fail(got.error, { status: got.status });
      const data = got.data || {};
      printResult({ json, ok: true, text: todayText(data), payload: { ok: true, ...data } }, io);
      return 0;
    }

    if (cmd === 'add') {
      const parsed = parseAddArgs(rest);
      if (parsed.error) return fail(parsed.error);
      const body = {
        platform: parsed.platform,
        text: parsed.text,
        status: parsed.status,
        notes: parsed.notes,
      };
      if (parsed.theme) body.theme = parsed.theme;
      if (parsed.scheduledFor) body.scheduled_for = parsed.scheduledFor;
      const got = await call('/popshare/posts', { method: 'POST', body, retries: 0 });
      if (got.error) return fail(got.error, { status: got.status });
      const post = got.data || {};
      const when = post.scheduled_for ? ` for ${localTime(post.scheduled_for)}` : '';
      const verb = post.status === 'scheduled' ? 'scheduled' : `added ${post.status || 'draft'}`;
      printResult({
        json,
        ok: true,
        text: `${verb} ${platformName(post.platform)} ${shortId(post.id)}${when}: "${postSnippet(post)}"`,
        payload: { ok: true, post },
      }, io);
      return 0;
    }

    if (cmd === 'list') {
      const at = rest.indexOf('--days');
      const rawDays = at !== -1 ? rest[at + 1] : undefined;
      const days = rawDays === undefined ? 7 : Number(rawDays);
      if (!Number.isInteger(days) || days < 1 || days > 365) return fail('--days takes a whole number from 1 to 365');
      const start = new Date(Date.now() - days * DAY_MS).toISOString();
      const end = new Date().toISOString();
      const got = await call(`/popshare/posts?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`);
      if (got.error) return fail(got.error, { status: got.status });
      const posts = (got.data && got.data.posts) || [];
      printResult({ json, ok: true, text: listText(posts), payload: { ok: true, posts } }, io);
      return 0;
    }

    if (cmd === 'schedule') {
      const idInput = rest[0];
      const atIndex = rest.indexOf('--at');
      const at = atIndex !== -1 ? rest[atIndex + 1] : undefined;
      if (!idInput) return fail('say which post: atris popshare schedule <id> --at "YYYY-MM-DD HH:MM"');
      if (!at) return fail('give the time: --at "YYYY-MM-DD HH:MM"');
      const iso = localAtToIso(at);
      if (!iso) return fail('write --at as YYYY-MM-DD HH:MM, like 2026-11-14 09:30');
      const resolved = await resolveId(idInput);
      if (resolved.error) return failResolution(resolved);
      const got = await call(`/popshare/posts/${encodeURIComponent(resolved.id)}`, {
        method: 'PATCH',
        body: { status: 'scheduled', scheduled_for: iso },
      });
      if (got.error) return fail(got.error, { status: got.status });
      const post = got.data || {};
      printResult({
        json,
        ok: true,
        text: `scheduled ${platformName(post.platform)} ${shortId(post.id)} for ${localTime(post.scheduled_for || iso)}: "${postSnippet(post)}"`,
        payload: { ok: true, post },
      }, io);
      return 0;
    }

    if (cmd === 'edit') {
      const idInput = rest[0];
      if (!idInput) return fail('say which post: atris popshare edit <id> --text "..."');
      const fields = {};
      const addedNotes = [];
      const editArgs = rest.slice(1).filter((arg) => arg !== '--json');
      for (let i = 0; i < editArgs.length; i += 1) {
        const arg = editArgs[i];
        if (['--text', '--theme', '--status', '--platform'].includes(arg)) {
          const value = editArgs[i + 1];
          if (value === undefined || value.startsWith('--')) return fail(`${arg} needs a value`);
          const key = arg.slice(2);
          if (key === 'status' && !EDITABLE_STATUSES.has(value)) {
            return fail(`status must be one of ${[...EDITABLE_STATUSES].join(', ')}`);
          }
          if (key === 'platform' && !PLATFORMS.includes(value)) {
            return fail(`platform must be one of ${PLATFORMS.join(', ')}`);
          }
          fields[key] = value;
          i += 1;
          continue;
        }
        if (arg === '--note') {
          const value = editArgs[i + 1];
          if (value === undefined || value.startsWith('--')) return fail('--note needs a value');
          addedNotes.push(value);
          i += 1;
          continue;
        }
        if (arg.startsWith('--')) return fail(`unknown flag ${arg}`);
        return fail(`unexpected "${arg}". flags only after the id: --text, --theme, --note, --status, --platform`);
      }
      if (!Object.keys(fields).length && !addedNotes.length) {
        return fail('say what to change: --text, --theme, --note, --status or --platform');
      }
      const resolved = await resolveId(idInput);
      if (resolved.error) return failResolution(resolved);
      if (addedNotes.length) {
        const existing = resolved.post || {};
        fields.notes = [...(Array.isArray(existing.notes) ? existing.notes : []), ...addedNotes];
      }
      const got = await call(`/popshare/posts/${encodeURIComponent(resolved.id)}`, {
        method: 'PATCH',
        body: fields,
      });
      if (got.error) return fail(got.error, { status: got.status });
      const post = got.data || {};
      printResult({
        json,
        ok: true,
        text: `updated ${platformName(post.platform)} ${shortId(post.id)}: "${postSnippet(post)}"`,
        payload: { ok: true, post },
      }, io);
      return 0;
    }

    if (cmd === 'post') {
      const idInput = rest[0];
      if (!idInput) return fail('say which post: atris popshare post <id>');
      const resolved = await resolveId(idInput);
      if (resolved.error) return failResolution(resolved);
      const got = await call(`/popshare/posts/${encodeURIComponent(resolved.id)}/publish`, {
        method: 'POST',
        retries: 0,
      });
      if (got.error) return fail(got.error, { status: got.status });
      const post = got.data || {};
      if (post.status === 'failed') {
        return fail(oneLine(post.error) || 'the post did not go out', { post });
      }
      const url = post.posted_url ? ` ${post.posted_url}` : '';
      printResult({
        json,
        ok: true,
        text: `posted ${platformName(post.platform)} ${shortId(post.id)}${url}`,
        payload: { ok: true, post },
      }, io);
      return 0;
    }

    if (cmd === 'posted') {
      const idInput = rest[0];
      if (!idInput) return fail('say which post: atris popshare posted <id> [--url u]');
      const at = rest.indexOf('--url');
      const url = at !== -1 ? rest[at + 1] : undefined;
      const resolved = await resolveId(idInput);
      if (resolved.error) return failResolution(resolved);
      const body = url ? { url } : {};
      const got = await call(`/popshare/posts/${encodeURIComponent(resolved.id)}/posted`, {
        method: 'POST',
        body,
        retries: 0,
      });
      if (got.error) return fail(got.error, { status: got.status });
      const post = got.data || {};
      printResult({
        json,
        ok: true,
        text: `marked ${platformName(post.platform)} ${shortId(post.id)} posted`,
        payload: { ok: true, post },
      }, io);
      return 0;
    }

    if (cmd === 'rm') {
      const idInput = rest[0];
      if (!idInput) return fail('say which post: atris popshare rm <id>');
      const resolved = await resolveId(idInput);
      if (resolved.error) return failResolution(resolved);
      const got = await call(`/popshare/posts/${encodeURIComponent(resolved.id)}`, { method: 'DELETE' });
      if (got.error) return fail(got.error, { status: got.status });
      printResult({ json, ok: true, text: `removed ${shortId(resolved.id)}`, payload: { ok: true, id: resolved.id } }, io);
      return 0;
    }

    if (cmd === 'score') {
      const at = rest.indexOf('--weeks');
      const rawWeeks = at !== -1 ? rest[at + 1] : undefined;
      const weeks = rawWeeks === undefined ? 4 : Number(rawWeeks);
      if (!Number.isInteger(weeks) || weeks < 1 || weeks > 52) return fail('--weeks takes a whole number from 1 to 52');
      const days = weeks * 7;
      const got = await call(`/popshare/scoreboard?days=${days}&tz=${encodeURIComponent(tz)}`);
      if (got.error) return fail(got.error, { status: got.status });
      const units = (got.data && got.data.units) || [];
      printResult({ json, ok: true, text: scoreText(units), payload: { ok: true, units } }, io);
      return 0;
    }

    if (cmd === 'install') {
      const business = rest[0];
      if (!business) return fail('say the business: atris popshare install <business>');
      const got = await call('/popshare/install', { method: 'POST', body: { business_id: business }, retries: 0 });
      if (got.error) return fail(got.error, { status: got.status });
      printResult({
        json,
        ok: true,
        text: `popshare added to ${business}`,
        payload: { ok: true, ...(got.data || {}) },
      }, io);
      return 0;
    }

    return fail(`unknown command ${cmd}. try: atris popshare --help`);
  } catch (error) {
    return fail(oneLine(error && error.message));
  }
}

module.exports = {
  popshareCommand,
  localAtToIso,
  parseAddArgs,
  resolvePostId,
  todayText,
  listText,
  scoreText,
};
