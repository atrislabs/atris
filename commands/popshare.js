'use strict';

/**
 * atris popshare - the posts calendar: what goes out today, what is due by
 * hand, what failed, and how the week is tracking against cadence goals.
 * Popshare never writes the words; every post here is one a person saved.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { apiRequestJson, httpRequest } = require('../utils/api');
const { loadCredentials } = require('../utils/auth');
const { NOT_LOGGED_IN, wantsHelp, wantsJson, tokenFrom, oneLine, printResult } = require('../lib/developer-api');

const PLATFORMS = ['x', 'linkedin', 'blog', 'instagram', 'tiktok'];
const PLATFORM_LABELS = { x: 'X', linkedin: 'LinkedIn', blog: 'Blog', instagram: 'Instagram', tiktok: 'TikTok' };
const EDITABLE_STATUSES = new Set(['idea', 'draft', 'ready', 'scheduled', 'failed', 'check']);
const DAY_MS = 24 * 60 * 60 * 1000;

function showPopshareHelp(log = console.log) {
  log('usage: atris popshare [--json]                          today: what goes out, due by hand, gaps');
  log('       atris popshare add <platform> "text" [--at "YYYY-MM-DD HH:MM"] [--idea|--draft|--ready] [--theme t] [--note n]... [--media f]...');
  log('       atris popshare list [--days 7]');
  log('       atris popshare schedule <id> --at "YYYY-MM-DD HH:MM"');
  log('       atris popshare edit <id> [--text "..."] [--theme t] [--note n]... [--status s] [--platform p] [--media f]... [--clear-media]');
  log('       atris popshare post <id>                            send an x or linkedin post now');
  log('       atris popshare posted <id> [--url u]                 mark a by-hand post as posted');
  log('       atris popshare rm <id>');
  log('       atris popshare score [--weeks 4]');
  log('       atris popshare interview <id>                      answer the questions, get an outline');
  log('       atris popshare interview --new <platform> "topic" [--research]');
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

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'heic', 'bmp']);
const VIDEO_EXTENSIONS = new Set(['mp4', 'mov', 'webm', 'm4v']);
const MIME_BY_EXT = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', avif: 'image/avif', heic: 'image/heic', bmp: 'image/bmp',
  mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', m4v: 'video/mp4',
};
const X_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const X_VIDEO_MAX_BYTES = 512 * 1024 * 1024;
const MEDIA_ITEM_LIMIT = 4;

function fileExtension(name) {
  const leaf = String(name || '').split(/[\\/]/).pop() || '';
  const dot = leaf.lastIndexOf('.');
  return dot === -1 ? '' : leaf.slice(dot + 1).toLowerCase();
}

/** image or video from the file name; null for anything else. */
function kindForFile(name) {
  const ext = fileExtension(name);
  if (IMAGE_EXTENSIONS.has(ext)) return 'image';
  if (VIDEO_EXTENSIONS.has(ext)) return 'video';
  return null;
}

/** X's rules, same as the backend: up to 4 pictures or 1 video. */
function mediaProblem(platform, items = []) {
  const list = Array.isArray(items) ? items : [];
  if (list.length > MEDIA_ITEM_LIMIT) return 'a post takes up to 4 pictures or 1 video.';
  if (list.some((item) => item && item.kind === 'video') && list.length > 1) {
    return 'a video goes alone. remove the pictures or the video.';
  }
  if (platform === 'x') {
    for (const item of list) {
      const size = Number(item && item.size) || 0;
      if (item && item.kind === 'image' && size > X_IMAGE_MAX_BYTES) {
        return 'X pictures are 5 MB or smaller.';
      }
      if (item && item.kind === 'video' && size > X_VIDEO_MAX_BYTES) {
        return 'X videos are 512 MB or smaller.';
      }
    }
  }
  return null;
}

/** "[1 picture]" / "[video]" next to a row that carries files. */
function mediaTag(post) {
  const media = post && Array.isArray(post.media) ? post.media : [];
  if (!media.length) return '';
  if (media.some((item) => item && item.kind === 'video')) return ' [video]';
  return ` [${media.length} picture${media.length === 1 ? '' : 's'}]`;
}

/** The media array a save sends: path, kind, alt, size only. */
function mediaItems(list = []) {
  return (Array.isArray(list) ? list : []).map((item) => {
    const clean = { path: String(item.path || ''), kind: item.kind, alt: String(item.alt || '') };
    if (Number.isFinite(Number(item.size)) && Number(item.size) > 0) clean.size = Number(item.size);
    return clean;
  }).filter((item) => item.path);
}

/** A clean leaf name for files/popshare/<folder>/... */
function mediaFileName(name) {
  const leaf = String(name || 'file').split(/[\\/]/).pop() || 'file';
  const cleaned = leaf.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(-80) || 'file';
  return `${Date.now().toString(36)}-${cleaned}`;
}

/** multipart/form-data body for the bucket POST: every signed field, file last. */
function multipartBody(fields, filePath, fileName) {
  const boundary = `----atris${crypto.randomBytes(8).toString('hex')}`;
  const chunks = [];
  for (const [key, value] of Object.entries(fields || {})) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`));
  }
  const mime = MIME_BY_EXT[fileExtension(fileName)] || 'application/octet-stream';
  chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: ${mime}\r\n\r\n`));
  chunks.push(fs.readFileSync(filePath));
  chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

/**
 * Upload one local file to the person's Atris Memory: ask for a signed
 * form, POST the bytes straight to the bucket, confirm with the token.
 * Returns { item } for the post's media list or { error }.
 */
async function uploadPostMedia(filePath, folder, deps = {}) {
  const request = deps.apiRequestJson || apiRequestJson;
  const rawHttp = deps.httpRequest || httpRequest;
  const token = deps.token;
  const fileName = path.basename(String(filePath || ''));
  const kind = kindForFile(fileName);
  if (!kind) return { error: `${fileName || 'that file'} is not a picture or a video.` };
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return { error: `cannot read ${fileName || filePath}` };
  }
  if (!stat.isFile()) return { error: `${fileName} is not a file.` };
  const relPath = `files/popshare/${folder}/${mediaFileName(fileName)}`;
  const contentType = MIME_BY_EXT[fileExtension(fileName)] || 'application/octet-stream';

  const start = await request('/memory/upload', {
    method: 'POST',
    token,
    body: { path: relPath, size: stat.size, content_type: contentType },
    retries: 0,
  });
  if (!start || !start.ok) {
    const detail = start && start.data && (start.data.detail || start.data.error);
    return { error: (typeof detail === 'string' && detail.trim()) || 'could not start the upload.' };
  }
  const signed = start.data || {};
  if (!signed.url || !signed.fields || !signed.token) {
    return { error: 'storage did not return an upload link.' };
  }

  const { body, contentType: multipartType } = multipartBody(signed.fields, filePath, fileName);
  let put;
  try {
    put = await rawHttp(signed.url, {
      method: 'POST',
      headers: { 'Content-Type': multipartType },
      body,
      timeoutMs: 300000,
    });
  } catch (error) {
    return { error: `the file did not reach storage: ${oneLine(error && error.message)}` };
  }
  if (!put || put.status < 200 || put.status >= 300) {
    return { error: 'the file did not reach storage. try again.' };
  }

  const done = await request('/memory/upload/done', {
    method: 'POST',
    token,
    body: { token: signed.token },
    retries: 0,
  });
  if (!done || !done.ok) {
    const detail = done && done.data && (done.data.detail || done.data.error);
    return { error: (typeof detail === 'string' && detail.trim()) || 'the upload did not finish. try again.' };
  }
  return { item: { path: relPath, kind, alt: '', size: stat.size } };
}

/** Today's local date as the files/popshare folder for adds. */
function todayFolder() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** Pull `add <platform> "text" [flags]` apart into a create body. */
function parseAddArgs(args = []) {
  const flags = { at: undefined, theme: undefined, notes: [], status: null, media: [] };
  const positional = [];
  const rest = args.filter((arg) => arg !== '--json');
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === '--at' || arg === '--theme' || arg === '--note' || arg === '--media') {
      const value = rest[i + 1];
      if (value === undefined || value.startsWith('--')) return { error: `${arg} needs a value` };
      if (arg === '--at') flags.at = value;
      else if (arg === '--theme') flags.theme = value;
      else if (arg === '--media') flags.media.push(value);
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
    media: flags.media,
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
  return `  ${when}  ${label} ${postSnippet(post)}${mediaTag(post)}${extra}`;
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

/** Pull `interview <id>` or `interview --new <platform> "topic" [--research]`
 * apart. --research only matters when a session starts fresh. */
function parseInterviewArgs(args = []) {
  const rest = args.filter((arg) => arg !== '--json');
  let research = false;
  let isNew = false;
  const positional = [];
  for (const arg of rest) {
    if (arg === '--research') {
      research = true;
      continue;
    }
    if (arg === '--new') {
      isNew = true;
      continue;
    }
    if (arg.startsWith('--')) return { error: `unknown flag ${arg}` };
    positional.push(arg);
  }
  if (isNew) {
    const rawPlatform = String(positional[0] || '').trim().toLowerCase();
    const platform = rawPlatform === 'twitter' ? 'x' : rawPlatform;
    const topic = positional.slice(1).join(' ').trim();
    if (!PLATFORMS.includes(platform)) {
      return { error: `platform must be one of ${PLATFORMS.join(', ')}` };
    }
    if (!topic) {
      return { error: 'say what the post is about: atris popshare interview --new x "your topic"' };
    }
    return { mode: 'new', platform, topic, research };
  }
  const idInput = positional[0];
  if (!idInput) {
    return { error: 'say which post: atris popshare interview <id>  (or --new <platform> "topic")' };
  }
  return { mode: 'resume', idInput, research };
}

/** The question still waiting on the person, with its 0-based index. */
function sessionOpenQuestion(session = {}) {
  const questions = Array.isArray(session.questions) ? session.questions : [];
  for (let i = questions.length - 1; i >= 0; i -= 1) {
    const item = questions[i];
    const answered = item && item.a !== null && item.a !== undefined && String(item.a).trim() !== '';
    if (!answered) {
      return { index: i, text: String((item && item.q) || '').trim() };
    }
  }
  return null;
}

/** Facts and voice notes the interview gathered, as a short block. */
function interviewContextText(session = {}) {
  const lines = [];
  const topic = session.topic ? ` for "${session.topic}"` : '';
  lines.push(`interview${topic}`);
  const facts = (Array.isArray(session.facts) ? session.facts : [])
    .filter((fact) => fact && String(fact.text || '').trim())
    .map((fact) => `  - ${String(fact.text).trim()}${fact.source ? ` (${fact.source})` : ''}`);
  const style = (Array.isArray(session.style) ? session.style : [])
    .map((note) => String(note || '').trim())
    .filter(Boolean)
    .map((note) => `  - ${note}`);
  if (facts.length) lines.push('what I know:', ...facts);
  if (style.length) lines.push('how you write:', ...style);
  return lines.join('\n');
}

/** The finished outline plus the command that turns it into a post. */
function interviewDoneText(session = {}, postId = '') {
  const lines = ['outline:'];
  const outline = Array.isArray(session.outline) ? session.outline : [];
  for (const beat of outline) {
    lines.push(`  ${beat && beat.beat || 'point'}: "${beat && beat.quote || ''}"`);
  }
  if (!outline.length) lines.push('  (nothing survived; answer again with --new)');
  if (postId) lines.push(`now write it: atris popshare edit ${shortId(postId)} --text "..."`);
  return lines.join('\n');
}

/** One line from stdin per call; null on Ctrl-C or closed input so the
 * interview pauses instead of dying mid-answer. The session lives server-side,
 * so rerunning the command picks up right where it stopped. Lines are queued
 * ourselves because rl.question drops input that lands before it is asked. */
function createStdinAsker() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: Boolean(process.stdin && process.stdin.isTTY),
  });
  const lines = [];
  const waiters = [];
  let closed = false;
  const drain = (value) => {
    while (waiters.length) waiters.shift()(value);
  };
  rl.on('line', (line) => {
    const waiter = waiters.shift();
    if (waiter) waiter(line);
    else lines.push(line);
  });
  rl.on('SIGINT', () => {
    closed = true;
    rl.close();
    drain(null);
  });
  rl.on('close', () => {
    closed = true;
    drain(null);
  });
  return () => {
    if (lines.length) return Promise.resolve(lines.shift());
    if (closed) return Promise.resolve(null);
    return new Promise((resolve) => {
      waiters.push(resolve);
    });
  };
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
  const rawHttp = deps.httpRequest || httpRequest;

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
      if (parsed.media && parsed.media.length) {
        const uploads = [];
        for (const file of parsed.media) {
          const up = await uploadPostMedia(file, todayFolder(), { apiRequestJson: request, httpRequest: rawHttp, token });
          if (up.error) return fail(up.error);
          uploads.push(up.item);
        }
        const problem = mediaProblem(parsed.platform, uploads);
        if (problem) return fail(problem);
        body.media = uploads;
      }
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
      const mediaFiles = [];
      let clearMedia = false;
      const editArgs = rest.slice(1).filter((arg) => arg !== '--json');
      for (let i = 0; i < editArgs.length; i += 1) {
        const arg = editArgs[i];
        if (['--text', '--theme', '--status', '--platform', '--media'].includes(arg)) {
          const value = editArgs[i + 1];
          if (value === undefined || value.startsWith('--')) return fail(`${arg} needs a value`);
          const key = arg.slice(2);
          if (key === 'status' && !EDITABLE_STATUSES.has(value)) {
            return fail(`status must be one of ${[...EDITABLE_STATUSES].join(', ')}`);
          }
          if (key === 'platform' && !PLATFORMS.includes(value)) {
            return fail(`platform must be one of ${PLATFORMS.join(', ')}`);
          }
          if (key === 'media') mediaFiles.push(value);
          else fields[key] = value;
          i += 1;
          continue;
        }
        if (arg === '--clear-media') {
          clearMedia = true;
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
        return fail(`unexpected "${arg}". flags only after the id: --text, --theme, --note, --status, --platform, --media, --clear-media`);
      }
      if (!Object.keys(fields).length && !addedNotes.length && !mediaFiles.length && !clearMedia) {
        return fail('say what to change: --text, --theme, --note, --status, --platform, --media or --clear-media');
      }
      const resolved = await resolveId(idInput);
      if (resolved.error) return failResolution(resolved);
      if (addedNotes.length) {
        const existing = resolved.post || {};
        fields.notes = [...(Array.isArray(existing.notes) ? existing.notes : []), ...addedNotes];
      }
      if (mediaFiles.length || clearMedia) {
        const platform = fields.platform || (resolved.post && resolved.post.platform) || '';
        let items = clearMedia ? [] : mediaItems((resolved.post && resolved.post.media) || []);
        for (const file of mediaFiles) {
          const up = await uploadPostMedia(file, resolved.id, { apiRequestJson: request, httpRequest: rawHttp, token });
          if (up.error) return fail(up.error);
          items.push(up.item);
        }
        const problem = mediaProblem(platform, items);
        if (problem) return fail(problem);
        fields.media = items;
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

    if (cmd === 'interview') {
      const parsed = parseInterviewArgs(rest);
      if (parsed.error) return fail(parsed.error);
      // Prompts go to stderr under --json so stdout stays one payload.
      const say = (line) => (json ? io.err(line) : io.log(line));
      const ask = deps.ask || createStdinAsker();

      let postId;
      let session;
      if (parsed.mode === 'new') {
        const got = await call('/popshare/interview', {
          method: 'POST',
          body: { platform: parsed.platform, topic: parsed.topic, research: parsed.research },
          retries: 0,
        });
        if (got.error) return fail(got.error, { status: got.status });
        postId = got.data && got.data.post && got.data.post.id;
        session = got.data && got.data.session;
      } else {
        const resolved = await resolveId(parsed.idInput);
        if (resolved.error) return failResolution(resolved);
        postId = resolved.id;
        const got = await call(`/popshare/posts/${encodeURIComponent(postId)}/interview`);
        if (got.error && got.status !== 404) return fail(got.error, { status: got.status });
        if (got.error) {
          // No session yet: start one. The server takes the topic from the
          // post's theme or text when we do not pass one.
          const started = await call(`/popshare/posts/${encodeURIComponent(postId)}/interview`, {
            method: 'POST',
            body: { research: parsed.research },
            retries: 0,
          });
          if (started.error) return fail(started.error, { status: started.status });
          session = started.data;
        } else {
          session = got.data;
        }
      }
      if (!postId || !session) return fail('the interview did not start. try again.');

      say(interviewContextText(session));
      for (;;) {
        if (session.status === 'done') {
          printResult({
            json,
            ok: true,
            text: interviewDoneText(session, postId),
            payload: { ok: true, post_id: postId, session },
          }, io);
          return 0;
        }
        const open = sessionOpenQuestion(session);
        if (!open || !open.text) return fail('the interview has no open question. try again.');
        say(`Q${open.index + 1}: ${open.text}`);
        const raw = await ask();
        if (raw === null || raw === undefined) {
          say('paused. run the same command again to pick up where you left off.');
          return 0;
        }
        const answer = String(raw).trim();
        if (!answer) {
          say('empty answer skipped. same question again.');
          continue;
        }
        const got = await call(`/popshare/posts/${encodeURIComponent(postId)}/interview/answer`, {
          method: 'POST',
          body: { answer },
          retries: 0,
        });
        if (got.error) return fail(got.error, { status: got.status });
        session = got.data || session;
      }
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
  kindForFile,
  mediaProblem,
  mediaTag,
  mediaItems,
  mediaFileName,
  multipartBody,
  uploadPostMedia,
  parseInterviewArgs,
  sessionOpenQuestion,
  interviewContextText,
  interviewDoneText,
};
