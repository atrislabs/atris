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
const { clipText, displayWidth, terminalWidth, wrapText } = require('../lib/text-table');

const PLATFORMS = ['x', 'linkedin', 'blog', 'instagram', 'tiktok'];
const PLATFORM_LABELS = { x: 'X', linkedin: 'LinkedIn', blog: 'Blog', instagram: 'Instagram', tiktok: 'TikTok' };
const EDITABLE_STATUSES = new Set(['idea', 'draft', 'ready', 'scheduled', 'failed', 'check']);
const DAY_MS = 24 * 60 * 60 * 1000;

function showPopshareHelp(log = console.log) {
  log('usage: atris popshare [--json]                          this week on the calendar');
  log('       atris popshare today                              today board: going out, by hand, failed, gaps');
  log('       atris popshare week [--next|--prev|--date YYYY-MM-DD]');
  log('       atris popshare show <id>                          one post, everything on it');
  log('       atris popshare strategy [--north-star "..."] [--audience "..."] [--cadence "..."] [--arc "..." ...|--clear-arcs]');
  log('       atris popshare goals [platform=n]...              weekly goals, like x=14 linkedin=7');
  log('       atris popshare open                               poke the week with the keyboard');
  log('       atris popshare add <platform> "text" [--at "YYYY-MM-DD HH:MM"] [--idea|--draft|--ready] [--theme t] [--tie slug] [--note n]... [--media f]...');
  log('       atris popshare list [--days 7] [--tie slug]');
  log('       atris popshare schedule <id> --at "YYYY-MM-DD HH:MM"');
  log('       atris popshare edit <id> [--text "..."] [--theme t] [--tie slug|--clear-tie] [--note n]... [--status s] [--platform p] [--media f]... [--clear-media]');
  log('       atris popshare post <id>                            send an x or linkedin post now');
  log('       atris popshare posted <id> [--url u]                 mark a by-hand post as posted');
  log('       atris popshare rm <id>');
  log('       atris popshare scorecard [--tie slug]             engagement, narrative arcs, and tie rollups');
  log('       atris popshare scoreboard [--weeks 4]             weekly output vs cadence goals');
  log('       atris popshare score [--weeks 4]                  alias for scoreboard');
  log('       atris popshare interview <id>                      answer the questions, get an outline');
  log('       atris popshare interview --new <platform> "topic" [--tie slug] [--research]');
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
  const flags = { at: undefined, theme: undefined, tie: undefined, notes: [], status: null, media: [] };
  const positional = [];
  const rest = args.filter((arg) => arg !== '--json');
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === '--at' || arg === '--theme' || arg === '--tie' || arg === '--note' || arg === '--media') {
      const value = rest[i + 1];
      if (value === undefined || value.startsWith('--')) return { error: `${arg} needs a value` };
      if (arg === '--at') flags.at = value;
      else if (arg === '--theme') flags.theme = value;
      else if (arg === '--tie') {
        const cleanedTie = String(value).trim();
        if (!cleanedTie) return { error: '--tie needs a non-empty slug' };
        flags.tie = cleanedTie;
      } else if (arg === '--media') flags.media.push(value);
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
    tieId: flags.tie,
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
  const raw = post && (post.text || post.title || post.text_snippet);
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

function formatMetricSummary(metrics) {
  if (!metrics || typeof metrics !== 'object') return '';
  const ordered = [
    ['impression_count', 'impressions'],
    ['like_count', 'likes'],
    ['reply_count', 'replies'],
    ['comment_count', 'comments'],
    ['retweet_count', 'reposts'],
    ['quote_count', 'quotes'],
    ['bookmark_count', 'bookmarks'],
  ];
  const seen = new Set();
  const parts = [];
  for (const [key, label] of ordered) {
    seen.add(key);
    const count = Number(metrics[key]);
    if (Number.isFinite(count) && count > 0) {
      parts.push(`${count.toLocaleString('en-US')} ${label}`);
    }
  }
  for (const [key, raw] of Object.entries(metrics)) {
    if (seen.has(key)) continue;
    const count = Number(raw);
    if (Number.isFinite(count) && count > 0) {
      parts.push(`${count.toLocaleString('en-US')} ${key.replace(/_/g, ' ')}`);
    }
  }
  return parts.join(', ');
}

/** Engagement, narrative arcs, platform breakdown, and tie rollups. */
function scorecardText(data = {}, opts = {}) {
  const tieFilter = opts && opts.tie ? String(opts.tie).trim() : '';
  const connections = data.connections && typeof data.connections === 'object' ? data.connections : {};
  const lines = [];

  const connParts = [];
  for (const platform of ['x', 'linkedin']) {
    if (connections[platform]) connParts.push(`${platformName(platform)}: ${connections[platform]}`);
  }
  if (connParts.length) {
    lines.push(`connections: ${connParts.join(', ')}`);
  } else if (data.connected === false) {
    lines.push('no social accounts connected yet.');
  }

  const allTies = Array.isArray(data.ties) ? data.ties : [];
  const allPosts = Array.isArray(data.posts) ? data.posts : [];
  const ties = tieFilter ? allTies.filter((item) => item && item.tie_id === tieFilter) : allTies;
  const posts = tieFilter ? allPosts.filter((item) => item && item.tie_id === tieFilter) : allPosts;

  if (!tieFilter) {
    const totals = data.totals && typeof data.totals === 'object' ? data.totals : {};
    const postCount = Number(totals.posts || posts.length || 0);
    const rate = totals.arc_match_rate !== undefined && totals.arc_match_rate !== null
      ? `, ${Math.round(Number(totals.arc_match_rate) * 100)}% on arc`
      : '';
    lines.push(`scorecard: ${postCount} post${postCount === 1 ? '' : 's'}${rate}`);
    const totalMetrics = formatMetricSummary(totals.metrics);
    if (totalMetrics) lines.push(`  metrics: ${totalMetrics}`);
    const byPlatform = totals.by_platform && typeof totals.by_platform === 'object' ? totals.by_platform : {};
    for (const [platform, bucket] of Object.entries(byPlatform)) {
      if (!bucket || typeof bucket !== 'object') continue;
      const count = Number(bucket.posts || 0);
      const metrics = formatMetricSummary(bucket.metrics);
      lines.push(`  ${platformName(platform)}: ${count} post${count === 1 ? '' : 's'}${metrics ? ` (${metrics})` : ''}`);
    }
  } else {
    lines.push(`tie: ${tieFilter}`);
    if (!ties.length && !posts.length) {
      lines.push('  no posted items match this tie yet.');
    }
  }

  if (ties.length) {
    lines.push('', 'ties:');
    for (const tie of ties) {
      const platforms = Array.isArray(tie.platforms) && tie.platforms.length ? tie.platforms.join(', ') : 'none';
      const count = Number(tie.posts || 0);
      const metrics = formatMetricSummary(tie.metrics);
      const metricBit = metrics ? ` · ${metrics}` : '';
      lines.push(`  ${tie.tie_id} (${platforms}) · ${count} post${count === 1 ? '' : 's'}${metricBit}`);
    }
  }

  if (posts.length) {
    lines.push('', 'posts:');
    for (const post of posts.slice(0, 15)) {
      const label = platformName(post.platform);
      const tieBit = post.tie_id && !tieFilter ? ` [${post.tie_id}]` : '';
      const arcBit = post.arc_matched ? ` (${post.arc_matched})` : '';
      const metrics = formatMetricSummary(post.metrics);
      const metricBit = metrics ? ` · ${metrics}` : '';
      lines.push(`  ${label}${tieBit}${arcBit}: ${postSnippet(post)}${metricBit}`);
    }
  } else if (!tieFilter) {
    lines.push('no posted posts scored yet.');
  }

  return lines.join('\n');
}

/** Pull `interview <id>` or `interview --new <platform> "topic" [--tie slug] [--research]`
 * apart. --research only matters when a session starts fresh. */
function parseInterviewArgs(args = []) {
  const rest = args.filter((arg) => arg !== '--json');
  let research = false;
  let isNew = false;
  let tieId = undefined;
  const positional = [];
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === '--research') {
      research = true;
      continue;
    }
    if (arg === '--new') {
      isNew = true;
      continue;
    }
    if (arg === '--tie') {
      const value = rest[i + 1];
      if (value === undefined || value.startsWith('--')) return { error: '--tie needs a value' };
      const cleaned = String(value).trim();
      if (!cleaned) return { error: '--tie needs a non-empty slug' };
      tieId = cleaned;
      i += 1;
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
    return { mode: 'new', platform, topic, tieId, research };
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
function createStdinAsker(input = process.stdin, output = process.stdout) {
  const rl = readline.createInterface({
    input,
    output,
    terminal: Boolean(input && input.isTTY),
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
  const asker = () => {
    if (lines.length) return Promise.resolve(lines.shift());
    if (closed) return Promise.resolve(null);
    return new Promise((resolve) => {
      waiters.push(resolve);
    });
  };
  asker.close = () => rl.close();
  return asker;
}

/** One cooked-mode line prompt for the interactive board. */
function promptLine(input, output, question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input, output, terminal: true });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

// ------------------------------------------------------------------ week view

const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAILY_GOAL_PLATFORMS = new Set(['x', 'linkedin']);
const AUTO_POST_PLATFORMS = new Set(['x', 'linkedin']);
const GRID_MIN_WIDTH = 70;
const MAX_CELL_POSTS = 6;
const STACK_MAX_POSTS = 12;
const GRID_TAG = { x: 'X', linkedin: 'LI', blog: 'B', instagram: 'IG', tiktok: 'TT' };

/** 'YYYY-MM-DD' as a local midnight Date, or null. */
function parseLocalDate(value) {
  const match = String(value || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const [, y, mo, d] = match;
  const date = new Date(Number(y), Number(mo) - 1, Number(d));
  if (Number.isNaN(date.getTime())
    || date.getFullYear() !== Number(y) || date.getMonth() !== Number(mo) - 1 || date.getDate() !== Number(d)) {
    return null;
  }
  return date;
}

function addDays(date, days) {
  const next = new Date(date.getTime());
  next.setDate(next.getDate() + days);
  return next;
}

/** The seven local midnights, Monday first, for the week holding `anchor`. */
function weekDays(anchor = new Date()) {
  const base = anchor instanceof Date ? new Date(anchor.getTime()) : new Date(anchor);
  const safe = Number.isNaN(base.getTime()) ? new Date() : base;
  safe.setHours(0, 0, 0, 0);
  const monday = addDays(safe, -((safe.getDay() + 6) % 7));
  return Array.from({ length: 7 }, (_, index) => addDays(monday, index));
}

/** Local 'YYYY-MM-DD' keys for the week that starts on `weekKey` (a Monday). */
function weekDayKeys(weekKey) {
  const monday = parseLocalDate(weekKey) || weekDays(new Date())[0];
  return weekDays(monday).map((day) => dayKey(day));
}

/** Pull `week [--next|--prev|--date YYYY-MM-DD]` apart into an anchor day. */
function parseWeekArgs(args = []) {
  const rest = args.filter((arg) => arg !== '--json');
  let mode = null;
  let date = null;
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === '--next' || arg === '--prev') {
      if (mode) return { error: 'pick one of --next, --prev, --date' };
      mode = arg.slice(2);
      continue;
    }
    if (arg === '--date') {
      const value = rest[i + 1];
      if (value === undefined || value.startsWith('--')) return { error: '--date needs a day, like 2026-11-16' };
      if (mode) return { error: 'pick one of --next, --prev, --date' };
      const parsed = parseLocalDate(value);
      if (!parsed) return { error: 'write --date as YYYY-MM-DD, like 2026-11-16' };
      mode = 'date';
      date = parsed;
      i += 1;
      continue;
    }
    if (arg.startsWith('--')) return { error: `unknown flag ${arg}` };
    return { error: `unexpected "${arg}". try: atris popshare week --next` };
  }
  const now = new Date();
  let anchor = now;
  if (mode === 'next') anchor = addDays(now, 7);
  else if (mode === 'prev') anchor = addDays(now, -7);
  else if (date) anchor = date;
  return { anchor };
}

/** The moment a post sits on the calendar: scheduled, posted, else saved. */
function postInstant(post) {
  const raw = post && (post.scheduled_for || post.posted_at || post.created_at);
  if (!raw) return null;
  const date = raw instanceof Date ? new Date(raw.getTime()) : new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** First non-empty line of the post's own words. */
function postFirstLine(post) {
  const lines = String((post && (post.text || post.title)) || '').split('\n');
  for (const line of lines) {
    const text = line.trim();
    if (text) return text.replace(/\s+/g, ' ');
  }
  return post && post.theme ? String(post.theme) : '';
}

/** One-character status mark for the grid: scheduled, draft, posted, failed. */
function statusMark(status) {
  if (status === 'posted' || status === 'imported') return '✓';
  if (status === 'failed') return '✗';
  if (status === 'check') return '!';
  if (status === 'posting') return '…';
  if (status === 'scheduled' || status === 'ready') return '→';
  return '·';
}

function gridTag(platform) {
  return GRID_TAG[platform] || String(platform || '').slice(0, 2).toUpperCase() || '?';
}

/** `9:00 X→ first line…` clipped to `width` terminal columns. */
function gridPostLine(post, width) {
  const when = postInstant(post);
  const time = when
    ? `${when.getHours()}:${String(when.getMinutes()).padStart(2, '0')}`
    : '--:--';
  const head = `${time} ${gridTag(post && post.platform)}${statusMark(post && post.status)} `;
  const room = Math.max(1, width - displayWidth(head));
  return `${head}${clipText(postFirstLine(post), room)}`;
}

/** Pad with spaces out to `columns` terminal columns. */
function padTo(text, columns) {
  return String(text) + ' '.repeat(Math.max(0, columns - displayWidth(text)));
}

/** Pad each cell to `colWidth` columns, join with one space, bold one cell. */
function joinCells(cellTexts, colWidth, highlightCol = -1) {
  const parts = cellTexts.map((text) => padTo(text, colWidth));
  let line = parts.join(' ');
  if (highlightCol >= 0 && highlightCol < parts.length) {
    let offset = 0;
    for (let i = 0; i < highlightCol; i += 1) offset += parts[i].length + 1;
    const cell = parts[highlightCol];
    line = `${line.slice(0, offset)}\x1b[1m${cell}\x1b[0m${line.slice(offset + cell.length)}`;
  }
  return line.trimEnd();
}

function weekRangeLabel(start, end) {
  const s = `${MONTH_SHORT[start.getMonth()]} ${start.getDate()}`;
  const e = `${MONTH_SHORT[end.getMonth()]} ${end.getDate()}`;
  if (start.getFullYear() === end.getFullYear()) {
    return `week of ${s} - ${e}, ${start.getFullYear()}`;
  }
  return `week of ${s}, ${start.getFullYear()} - ${e}, ${end.getFullYear()}`;
}

function weekHeaderLine(cells) {
  const todayIndex = cells.findIndex((cell) => cell.isToday);
  const today = todayIndex >= 0
    ? ` · today ${WEEKDAY_SHORT[cells[todayIndex].date.getDay()]} ${cells[todayIndex].date.getDate()}`
    : '';
  return `${weekRangeLabel(cells[0].date, cells[cells.length - 1].date)}${today}`;
}

/** Seven day columns sized to the terminal. `selected` = {day, post} indexes. */
function weekGridLines(cells, options = {}) {
  const width = terminalWidth(options.width);
  const colWidth = Math.max(8, Math.floor((width - 6) / 7));
  const selected = options.selected || null;
  const selDay = selected ? selected.day : -1;
  const selPost = selected ? selected.post : -1;
  const lines = [weekHeaderLine(cells)];
  const headers = cells.map((cell) => (
    `${WEEKDAY_SHORT[cell.date.getDay()]} ${cell.date.getDate()}${cell.isToday ? '*' : ''}`
  ));
  lines.push(joinCells(headers, colWidth, selDay));
  const columns = cells.map((cell) => {
    const shown = cell.posts.slice(0, MAX_CELL_POSTS).map((post) => gridPostLine(post, colWidth));
    if (cell.posts.length > MAX_CELL_POSTS) shown.push(`+${cell.posts.length - MAX_CELL_POSTS} more`);
    return shown;
  });
  const height = Math.max(0, ...columns.map((list) => list.length));
  for (let row = 0; row < height; row += 1) {
    const texts = columns.map((list) => list[row] || '');
    const visible = selDay >= 0 && selPost === row
      && selPost < Math.min(cells[selDay].posts.length, MAX_CELL_POSTS);
    lines.push(joinCells(texts, colWidth, visible ? selDay : -1));
  }
  return lines;
}

/** Day-by-day list for narrow terminals. */
function weekStackedLines(cells, options = {}) {
  const width = terminalWidth(options.width);
  const selected = options.selected || null;
  const lines = [weekHeaderLine(cells)];
  cells.forEach((cell, day) => {
    const date = cell.date;
    lines.push(`${WEEKDAY_SHORT[date.getDay()]} ${MONTH_SHORT[date.getMonth()]} ${date.getDate()}${cell.isToday ? ' (today)' : ''}`);
    const shown = cell.posts.slice(0, STACK_MAX_POSTS);
    shown.forEach((post, index) => {
      let line = `  ${gridPostLine(post, Math.max(12, width - 4))}`;
      if (selected && selected.day === day && selected.post === index) line = `\x1b[1m${line}\x1b[0m`;
      lines.push(line);
    });
    if (cell.posts.length > shown.length) lines.push(`  +${cell.posts.length - shown.length} more`);
  });
  return lines;
}

/** Bucket posts into the week's days, sorted by calendar time. */
function weekCells(dayDates, posts, todayKey) {
  const cells = dayDates.map((date) => ({
    date,
    key: dayKey(date),
    isToday: dayKey(date) === todayKey,
    posts: [],
  }));
  const byKey = new Map(cells.map((cell) => [cell.key, cell]));
  for (const post of Array.isArray(posts) ? posts : []) {
    const when = postInstant(post);
    const cell = when ? byKey.get(dayKey(when)) : null;
    if (cell) cell.posts.push(post);
  }
  for (const cell of cells) {
    cell.posts.sort((a, b) => {
      const ta = postInstant(a);
      const tb = postInstant(b);
      const diff = (ta ? ta.getTime() : 0) - (tb ? tb.getTime() : 0);
      return diff || String((a && a.id) || '').localeCompare(String((b && b.id) || ''));
    });
  }
  return cells;
}

/** `today  X 0/2   LinkedIn 0/1      this week  Blog 0/1 ...`, web style. */
function progressLine(board = {}) {
  const goals = board.goals && typeof board.goals === 'object' ? board.goals : {};
  const gaps = Array.isArray(board.gaps) ? board.gaps : [];
  const todayChips = [];
  const weekChips = [];
  for (const platform of PLATFORMS) {
    const goal = Number(goals[platform] || 0);
    if (!Number.isFinite(goal) || goal <= 0) continue;
    const daily = DAILY_GOAL_PLATFORMS.has(platform);
    const wanted = daily ? Math.round(goal / 7) : Math.trunc(goal);
    const gap = gaps.find((item) => item && item.platform === platform
      && item.period === (daily ? 'day' : 'week'));
    if (!gap && wanted < 1) continue;
    const label = platformName(platform);
    const chip = gap
      ? `${label} ${Number(gap.have || 0)}/${Number(gap.wanted || wanted)}`
      : `${label} ✓`;
    (daily ? todayChips : weekChips).push(chip);
  }
  const parts = [];
  if (todayChips.length) parts.push(`today  ${todayChips.join('   ')}`);
  if (weekChips.length) parts.push(`this week  ${weekChips.join('   ')}`);
  return parts.join('      ');
}

/** The week as text: header, grid or stacked days, progress, connections. */
function weekText(posts, board, options = {}) {
  const anchor = options.anchor instanceof Date ? options.anchor : new Date(options.anchor || Date.now());
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  const safeAnchor = Number.isNaN(anchor.getTime()) ? new Date() : anchor;
  const safeNow = Number.isNaN(now.getTime()) ? new Date() : now;
  const days = weekDays(safeAnchor);
  const cells = weekCells(days, posts, dayKey(safeNow));
  const width = terminalWidth(options.width);
  const lines = width >= GRID_MIN_WIDTH
    ? weekGridLines(cells, { width })
    : weekStackedLines(cells, { width });
  const progress = progressLine(board);
  if (progress) {
    if (displayWidth(progress) <= width) {
      lines.push('', progress);
    } else {
      lines.push('');
      for (const group of progress.split('      ')) {
        if (displayWidth(group) <= width) lines.push(group);
        else lines.push(...wrapText(group, width));
      }
    }
  }
  for (const line of connectionLines(board)) {
    if (displayWidth(line) <= width) lines.push(line);
    else lines.push(...wrapText(line, width));
  }
  return lines.join('\n');
}

// ------------------------------------------------------------------ one post

/** 'Sat Nov 14, 9:30 PM' in local time. */
function formatWhen(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  let hour = date.getHours();
  const minute = String(date.getMinutes()).padStart(2, '0');
  const half = hour >= 12 ? 'PM' : 'AM';
  hour = hour % 12 || 12;
  return `${WEEKDAY_SHORT[date.getDay()]} ${MONTH_SHORT[date.getMonth()]} ${date.getDate()}, ${hour}:${minute} ${half}`;
}

/** X-style engagement counts that are actually there. */
function engagementText(metrics) {
  if (!metrics || typeof metrics !== 'object') return '';
  const fields = [
    ['like_count', 'likes'],
    ['reply_count', 'replies'],
    ['retweet_count', 'reposts'],
    ['quote_count', 'quotes'],
    ['bookmark_count', 'bookmarks'],
    ['impression_count', 'impressions'],
  ];
  const parts = [];
  for (const [key, label] of fields) {
    const count = Number(metrics[key]);
    if (Number.isFinite(count) && count > 0) {
      parts.push(`${count.toLocaleString('en-US')} ${label}`);
    }
  }
  return parts.join(', ');
}

/** The commands that make sense for this post right now. */
function nextCommands(post = {}) {
  const id = shortId(post.id);
  const lines = [];
  const editable = EDITABLE_STATUSES.has(post.status);
  const settled = post.status === 'posted' || post.status === 'imported';
  if (editable) {
    lines.push(`  atris popshare schedule ${id} --at "YYYY-MM-DD HH:MM"`);
    lines.push(`  atris popshare edit ${id} --text "..."`);
    lines.push(`  atris popshare interview ${id}`);
    if (AUTO_POST_PLATFORMS.has(post.platform)) {
      lines.push(`  atris popshare post ${id}`);
    } else {
      lines.push(`  atris popshare posted ${id} --url "..."`);
    }
  } else if (!settled && AUTO_POST_PLATFORMS.has(post.platform)) {
    lines.push(`  atris popshare post ${id}`);
  }
  lines.push(`  atris popshare rm ${id}`);
  return lines;
}

/** Everything about one post: words, media, link, notes, error, next moves. */
function showText(post = {}) {
  const status = post.status === 'check' ? 'check the account' : (post.status || 'draft');
  const lines = [`${platformName(post.platform)} · ${status} · ${shortId(post.id)}`];
  if (post.status === 'posted' || post.status === 'imported') {
    const when = formatWhen(post.posted_at || postInstant(post));
    if (when) lines.push(`posted ${when}`);
  } else if (post.scheduled_for) {
    const when = formatWhen(post.scheduled_for);
    if (when) lines.push(`scheduled for ${when}`);
  } else {
    const when = formatWhen(post.created_at || postInstant(post));
    if (when) lines.push(`saved ${when}`);
  }
  if (post.theme) lines.push(`theme: ${post.theme}`);
  if (post.tie_id) lines.push(`tie: ${post.tie_id}`);
  lines.push('');
  const body = String(post.text || post.title || '').trim();
  lines.push(body || '(no words yet)');
  const media = Array.isArray(post.media) ? post.media : [];
  if (media.length) {
    lines.push('', 'media:');
    for (const item of media) {
      if (!item) continue;
      const bits = [`${item.path} (${item.kind || 'file'})`];
      if (item.alt) bits.push(`"${item.alt}"`);
      if (item.link) bits.push(item.link);
      lines.push(`  - ${bits.join(' ')}`);
    }
  }
  if (post.posted_url) lines.push('', `link: ${post.posted_url}`);
  const engagement = engagementText(post.metrics);
  if (engagement) lines.push(`engagement: ${engagement}`);
  const notes = (Array.isArray(post.notes) ? post.notes : [])
    .map((note) => String(note || '').trim())
    .filter(Boolean);
  if (notes.length) {
    lines.push('', 'notes:');
    notes.forEach((note) => lines.push(`  - ${note}`));
  }
  if (post.error) lines.push('', `error: ${oneLine(post.error)}`);
  const next = nextCommands(post);
  if (next.length) lines.push('', 'next:', ...next);
  return lines.join('\n');
}

// ------------------------------------------------------------------ goals

/** `goals` prints; `goals x=14 linkedin=7` sets. Returns {goals} or {error}. */
function parseGoalsArgs(args = []) {
  const rest = args.filter((arg) => arg !== '--json');
  const goals = {};
  for (const arg of rest) {
    if (arg.startsWith('--')) return { error: `unknown flag ${arg}` };
    const match = arg.match(/^([A-Za-z]+)=(.+)$/);
    if (!match) return { error: 'write goals as platform=count, like x=14 linkedin=7' };
    const rawPlatform = match[1].toLowerCase();
    const platform = rawPlatform === 'twitter' ? 'x' : rawPlatform;
    if (!PLATFORMS.includes(platform)) {
      return { error: `unknown platform ${match[1]}. use ${PLATFORMS.join(', ')}` };
    }
    const raw = match[2].trim();
    if (!/^\d+$/.test(raw)) {
      return { error: `${platformName(platform)} goal must be a whole number, 0 or more` };
    }
    goals[platform] = Number(raw);
  }
  return { goals: Object.keys(goals).length ? goals : null };
}

/** Weekly goals as a short aligned list. */
function goalsText(strategy = {}) {
  const goals = strategy.cadence_goals && typeof strategy.cadence_goals === 'object'
    ? strategy.cadence_goals
    : {};
  const width = Math.max(...PLATFORMS.map((platform) => platformName(platform).length));
  const lines = ['weekly goals'];
  for (const platform of PLATFORMS) {
    const value = Number(goals[platform]);
    lines.push(`  ${platformName(platform).padEnd(width)}  ${Number.isFinite(value) ? value : 0} a week`);
  }
  return lines.join('\n');
}

/** Pull `strategy [--north-star ...] [--audience ...] [--cadence ...] [--arc ...]` apart. */
function parseStrategyArgs(args = []) {
  const rest = args.filter((arg) => arg !== '--json');
  const updates = {};
  const arcs = [];
  const goals = {};
  let clearArcs = false;
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === '--north-star' || arg === '--audience' || arg === '--cadence' || arg === '--arc') {
      const value = rest[i + 1];
      if (value === undefined || value.startsWith('--')) return { error: `${arg} needs a value` };
      if (arg === '--north-star') updates.north_star = value.trim();
      else if (arg === '--audience') updates.audience = value.trim();
      else if (arg === '--cadence') updates.cadence = value.trim();
      else if (value.trim()) arcs.push(value.trim());
      i += 1;
      continue;
    }
    if (arg === '--clear-arcs') {
      clearArcs = true;
      continue;
    }
    if (arg.startsWith('--')) return { error: `unknown flag ${arg}` };
    const goalMatch = arg.match(/^([A-Za-z]+)=(.+)$/);
    if (!goalMatch) return { error: `unexpected "${arg}". try: atris popshare strategy --north-star "..."` };
    const rawPlatform = goalMatch[1].toLowerCase();
    const platform = rawPlatform === 'twitter' ? 'x' : rawPlatform;
    if (!PLATFORMS.includes(platform)) {
      return { error: `unknown platform ${goalMatch[1]}. use ${PLATFORMS.join(', ')}` };
    }
    const rawCount = goalMatch[2].trim();
    if (!/^\d+$/.test(rawCount)) {
      return { error: `${platformName(platform)} goal must be a whole number, 0 or more` };
    }
    goals[platform] = Number(rawCount);
  }
  if (clearArcs && arcs.length) return { error: 'use either --arc or --clear-arcs, not both' };
  if (clearArcs) updates.narrative_arcs = [];
  else if (arcs.length) updates.narrative_arcs = arcs;
  if (Object.keys(goals).length) updates.cadence_goals = goals;
  return { updates: Object.keys(updates).length ? updates : null };
}

/** Full Popshare strategy summary: north star, audience, cadence, arcs, goals. */
function strategyText(strategy = {}) {
  const lines = ['strategy'];
  lines.push(`  north star: ${strategy.north_star || '(not set)'}`);
  lines.push(`  audience:   ${strategy.audience || '(not set)'}`);
  lines.push(`  cadence:    ${strategy.cadence || '(not set)'}`);
  const arcs = Array.isArray(strategy.narrative_arcs) ? strategy.narrative_arcs : [];
  if (arcs.length) {
    lines.push('  narrative arcs:');
    arcs.forEach((arc) => lines.push(`    - ${arc}`));
  } else {
    lines.push('  narrative arcs: (none)');
  }
  lines.push('', goalsText(strategy));
  return lines.join('\n');
}

// ------------------------------------------------------------------ open mode

const OPEN_HELP_LINES = [
  'keys',
  '  left/right    move between days',
  '  up/down       move between posts in the day',
  '  [ / ]         previous / next week',
  '  enter         show the post',
  '  n             new post on this day',
  '  e             edit the text',
  '  s             schedule it, asks for a time',
  '  i             interview: questions, then an outline',
  '  p             post now, x and linkedin only, asks first',
  '  r             refresh',
  '  ?             this help',
  '  q             quit',
];

const OPEN_GRID_FOOTER = 'arrows day/post · [ ] week · enter open · n new · e edit · s schedule · i interview · p post · r refresh · ? keys · q quit';
const OPEN_CONFIRM_FOOTER = 'y post now · n back · q quit';
const OPEN_DETAIL_FOOTER = 'enter back · e edit · s schedule · i interview · p post · r refresh · ? keys · q quit';

/** Split the footer on ' · ' so it never runs past the terminal width. */
function wrapFooter(text, width) {
  if (displayWidth(text) <= width) return [text];
  const lines = [];
  let current = '';
  for (const part of String(text).split(' · ')) {
    const next = current ? `${current} · ${part}` : part;
    if (current && displayWidth(next) > width) {
      lines.push(current);
      current = part;
    } else {
      current = next;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function openInitialState(anchor = new Date(), todayKey = dayKey(new Date())) {
  const keys = weekDays(anchor).map((day) => dayKey(day));
  const day = Math.max(0, keys.indexOf(todayKey));
  return { week: keys[0], day, post: 0, view: 'grid', confirmPost: null, note: '' };
}

/** Canonical key name from a keypress event's string and key object. */
function keyName(str, key) {
  if (key && key.ctrl && (key.name === 'c' || key.name === 'C')) return 'ctrl-c';
  if (key && key.name === 'return') return 'return';
  if (key && key.name === 'escape') return 'escape';
  if (key && ['up', 'down', 'left', 'right'].includes(key.name)) return key.name;
  if (typeof str === 'string' && str.length === 1) return str;
  return key && key.name ? key.name : null;
}

function openPostAt(view, day, post) {
  const cell = view && view.days ? view.days[day] : null;
  const list = cell && Array.isArray(cell.posts) ? cell.posts : [];
  return list[post] || null;
}

function openPostBlockReason(post) {
  if (!post) return 'no posts this day';
  if (!AUTO_POST_PLATFORMS.has(post.platform)) return `${platformName(post.platform)} posts go out by hand`;
  if (post.status === 'posted' || post.status === 'imported') return 'already posted';
  if (post.status === 'posting') return 'already sending';
  return null;
}

/**
 * The interactive week as a pure state machine. `view` = {days, board,
 * todayKey} where days is the seven cells from weekCells. Returns
 * {state, action}; the terminal shell turns actions into prompts and calls.
 */
function openReduce(state, key, view) {
  if (key === 'ctrl-c' || key === 'q') {
    return { state, action: { type: 'quit' } };
  }
  if (key === '?') {
    return {
      state: { ...state, view: state.view === 'help' ? 'grid' : 'help', note: '' },
      action: null,
    };
  }
  if (state.view === 'help') {
    return { state: { ...state, view: 'grid' }, action: null };
  }
  const s = { ...state, note: '' };

  if (state.view === 'confirm') {
    const target = state.confirmPost;
    if (key === 'y' && target) {
      return {
        state: { ...s, view: 'grid', confirmPost: null },
        action: { type: 'post-now', day: target.day, post: target.post },
      };
    }
    if (key === 'n' || key === 'escape') {
      return { state: { ...s, view: 'grid', confirmPost: null }, action: null };
    }
    return { state: { ...s, note: 'y or n' }, action: null };
  }

  if (state.view === 'detail') {
    if (key === 'return' || key === 'escape' || key === ' ') {
      return { state: { ...s, view: 'grid' }, action: null };
    }
    if (['left', 'right', 'up', 'down', '[', ']'].includes(key)) {
      return openReduce({ ...s, view: 'grid' }, key, view);
    }
    // action keys fall through to the grid handling below
  }

  const days = view && Array.isArray(view.days) ? view.days : [];
  const postsOf = (day) => {
    const cell = days[day];
    return cell && Array.isArray(cell.posts) ? cell.posts : [];
  };

  if (key === '[' || key === ']') {
    const delta = key === ']' ? 7 : -7;
    const monday = parseLocalDate(s.week) || weekDays(new Date())[0];
    const nextWeek = dayKey(addDays(monday, delta));
    const nextKeys = weekDayKeys(nextWeek);
    const todayKey = view && view.todayKey ? view.todayKey : '';
    const todayIndex = Math.max(0, nextKeys.indexOf(todayKey));
    return {
      state: { ...s, week: nextWeek, day: todayIndex, post: 0, view: 'grid' },
      action: null,
    };
  }
  if (key === 'left') {
    if (s.day > 0) return { state: { ...s, day: s.day - 1, post: 0 }, action: null };
    return { state: s, action: null };
  }
  if (key === 'right') {
    if (s.day < 6) return { state: { ...s, day: s.day + 1, post: 0 }, action: null };
    return { state: s, action: null };
  }
  if (key === 'up' || key === 'down') {
    const count = postsOf(s.day).length;
    if (!count) return { state: { ...s, note: 'no posts this day' }, action: null };
    const post = key === 'down' ? Math.min(s.post + 1, count - 1) : Math.max(s.post - 1, 0);
    return { state: { ...s, post, view: 'grid' }, action: null };
  }
  if (key === 'enter' || key === 'return') {
    if (state.view === 'detail') return { state: { ...s, view: 'grid' }, action: null };
    if (!openPostAt(view, s.day, s.post)) {
      return { state: { ...s, note: 'no posts this day' }, action: null };
    }
    return { state: { ...s, view: 'detail' }, action: null };
  }
  if (key === 'n') {
    const cell = days[s.day];
    return {
      state: { ...s, view: 'grid' },
      action: { type: 'new-post', day: cell ? cell.key : null },
    };
  }
  if (key === 'r') return { state: s, action: { type: 'refresh' } };
  if (['e', 's', 'i', 'p'].includes(key)) {
    const post = openPostAt(view, s.day, s.post);
    if (key === 'p') {
      const reason = openPostBlockReason(post);
      if (reason) return { state: { ...s, note: reason }, action: null };
      return {
        state: { ...s, view: 'confirm', confirmPost: { day: s.day, post: s.post } },
        action: null,
      };
    }
    if (!post) return { state: { ...s, note: 'no posts this day' }, action: null };
    if (post.status === 'posted' || post.status === 'imported') {
      return { state: { ...s, note: 'posted posts are read only' }, action: null };
    }
    const type = { e: 'edit-post', s: 'schedule-post', i: 'interview-post' }[key];
    return { state: s, action: { type, day: s.day, post: s.post } };
  }
  return { state: s, action: null };
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

  /** The interview walk, shared by `popshare interview` and `open`'s i key. */
  const runInterview = async (parsed) => {
    // Prompts go to stderr under --json so stdout stays one payload.
    const say = (line) => (json ? io.err(line) : io.log(line));
    const ask = deps.ask || createStdinAsker(deps.stdin || process.stdin, deps.stdout || process.stdout);
    try {
      let postId;
      let session;
      if (parsed.mode === 'new') {
        const body = { platform: parsed.platform, topic: parsed.topic, research: parsed.research };
        if (parsed.tieId) body.tie_id = parsed.tieId;
        const got = await call('/popshare/interview', {
          method: 'POST',
          body,
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
    } finally {
      if (ask && typeof ask.close === 'function') ask.close();
    }
  };

  /** Posts and the today board for the Monday-Sunday week holding `anchor`. */
  const loadWeek = async (anchor) => {
    const days = weekDays(anchor);
    const [postsGot, boardGot] = await Promise.all([
      call(`/popshare/posts?start=${encodeURIComponent(days[0].toISOString())}&end=${encodeURIComponent(addDays(days[6], 1).toISOString())}`),
      call(`/popshare/today?tz=${encodeURIComponent(tz)}`),
    ]);
    if (postsGot.error) return postsGot;
    if (boardGot.error) return boardGot;
    return {
      posts: (postsGot.data && postsGot.data.posts) || [],
      board: boardGot.data || {},
      days,
    };
  };

  /**
   * `atris popshare open`: the week redraws in place, keys move around it.
   * Raw mode and the cursor always come back, on quit and on errors.
   */
  const openBoard = async (anchor, tty = {}) => {
    const input = tty.input || process.stdin;
    const output = tty.output || process.stdout;
    const width = () => terminalWidth(output && output.columns);
    const setRaw = (on) => {
      if (input.isTTY && typeof input.setRawMode === 'function') input.setRawMode(on);
    };

    let postList = [];
    let board = {};
    const refresh = async () => {
      const [gotPosts, gotBoard] = await Promise.all([
        allPosts(),
        call(`/popshare/today?tz=${encodeURIComponent(tz)}`),
      ]);
      const problems = [];
      if (gotPosts.error) problems.push(gotPosts.error);
      else postList = gotPosts.posts || [];
      if (gotBoard.error) problems.push(gotBoard.error);
      else board = gotBoard.data || {};
      return problems.length ? problems.join('; ') : null;
    };

    const buildView = (weekKey) => {
      const days = weekDays(parseLocalDate(weekKey) || new Date());
      const todayKey = dayKey(new Date());
      return { days: weekCells(days, postList, todayKey), board, todayKey };
    };

    const frameLines = (state, view) => {
      const w = width();
      if (state.view === 'help') {
        return [...OPEN_HELP_LINES, '', 'any key back · q quit'];
      }
      if (state.view === 'confirm' && state.confirmPost) {
        const post = openPostAt(view, state.confirmPost.day, state.confirmPost.post);
        const lines = [post
          ? `post this now? y/n    ${platformName(post.platform)} ${shortId(post.id)}: "${postSnippet(post)}"`
          : 'post this now? y/n'];
        if (state.note) lines.push('', `note: ${state.note}`);
        lines.push('', OPEN_CONFIRM_FOOTER);
        return lines;
      }
      if (state.view === 'detail') {
        const post = openPostAt(view, state.day, state.post);
        if (post) {
          const lines = [...showText(post).split('\n'), ''];
          if (state.note) lines.push(`note: ${state.note}`, '');
          lines.push(OPEN_DETAIL_FOOTER);
          return lines;
        }
      }
      const selected = { day: state.day, post: state.post };
      const lines = w >= GRID_MIN_WIDTH
        ? weekGridLines(view.days, { width: w, selected })
        : weekStackedLines(view.days, { width: w, selected });
      const progress = progressLine(view.board);
      if (progress) lines.push('', progress);
      for (const line of connectionLines(view.board)) lines.push(line);
      if (state.note) lines.push('', `note: ${state.note}`);
      lines.push('', ...wrapFooter(OPEN_GRID_FOOTER, w));
      return lines;
    };

    const draw = (state, view) => {
      output.write('\x1b[2J\x1b[H');
      output.write(`${frameLines(state, view).join('\n')}\n`);
    };

    readline.emitKeypressEvents(input);
    const queue = [];
    let waiter = null;
    let capturing = true;
    const onKeypress = (str, key) => {
      if (!capturing) return;
      const name = keyName(str, key);
      if (!name) return;
      if (waiter) {
        const resolve = waiter;
        waiter = null;
        resolve(name);
      } else {
        queue.push(name);
      }
    };
    input.on('keypress', onKeypress);
    const nextKey = () => {
      setRaw(true);
      input.resume();
      if (queue.length) return Promise.resolve(queue.shift());
      return new Promise((resolve) => { waiter = resolve; });
    };

    // Cooked-mode line prompt: raw off, keys ignored, raw back after.
    const ask = async (question) => {
      capturing = false;
      setRaw(false);
      input.resume();
      try {
        return await promptLine(input, output, question);
      } finally {
        capturing = true;
        input.resume();
        setRaw(true);
      }
    };

    const flowNewPost = async (dayKeyText) => {
      const day = dayKeyText ? parseLocalDate(dayKeyText) : new Date();
      const dayLabel = day
        ? `${WEEKDAY_SHORT[day.getDay()]} ${MONTH_SHORT[day.getMonth()]} ${day.getDate()}`
        : '';
      let platform = '';
      for (let tries = 0; tries < 3 && !platform; tries += 1) {
        const answer = (await ask(`platform? (${PLATFORMS.join(', ')}) `)).trim().toLowerCase();
        if (!answer) return 'cancelled';
        const candidate = answer === 'twitter' ? 'x' : answer;
        if (PLATFORMS.includes(candidate)) platform = candidate;
        else output.write(`  one of ${PLATFORMS.join(', ')}\n`);
      }
      if (!platform) return 'pick a platform';
      const text = (await ask('text: ')).trim();
      if (!text) return 'cancelled';
      let iso = null;
      for (;;) {
        const raw = (await ask(`time? (${dayKey(day)} HH:MM on ${dayLabel}, empty for draft) `)).trim();
        if (!raw) break;
        const hhmm = raw.match(/^(\d{1,2}):(\d{2})$/);
        const candidate = hhmm
          ? localAtToIso(`${dayKey(day)} ${String(Number(hhmm[1])).padStart(2, '0')}:${hhmm[2]}`)
          : localAtToIso(raw);
        if (candidate) {
          iso = candidate;
          break;
        }
        output.write('  write HH:MM or YYYY-MM-DD HH:MM\n');
      }
      const body = { platform, text, status: iso ? 'scheduled' : 'draft', notes: [] };
      if (iso) body.scheduled_for = iso;
      const got = await call('/popshare/posts', { method: 'POST', body, retries: 0 });
      if (got.error) return got.error;
      const post = got.data || {};
      return post.status === 'scheduled'
        ? `scheduled ${platformName(post.platform)} ${shortId(post.id)}`
        : `saved draft ${platformName(post.platform)} ${shortId(post.id)}`;
    };

    const flowEdit = async (post) => {
      const text = (await ask('new text: ')).trim();
      if (!text) return 'cancelled';
      const got = await call(`/popshare/posts/${encodeURIComponent(post.id)}`, {
        method: 'PATCH',
        body: { text },
      });
      if (got.error) return got.error;
      return `updated ${platformName(post.platform)} ${shortId(post.id)}`;
    };

    const flowSchedule = async (post) => {
      const raw = (await ask('time (YYYY-MM-DD HH:MM): ')).trim();
      if (!raw) return 'cancelled';
      const iso = localAtToIso(raw);
      if (!iso) return 'write the time as YYYY-MM-DD HH:MM, like 2026-11-16 09:30';
      const got = await call(`/popshare/posts/${encodeURIComponent(post.id)}`, {
        method: 'PATCH',
        body: { status: 'scheduled', scheduled_for: iso },
      });
      if (got.error) return got.error;
      return `scheduled ${platformName(post.platform)} ${shortId(post.id)} for ${localTime(iso)}`;
    };

    const flowPostNow = async (post) => {
      const got = await call(`/popshare/posts/${encodeURIComponent(post.id)}/publish`, {
        method: 'POST',
        retries: 0,
      });
      if (got.error) return got.error;
      const updated = got.data || {};
      if (updated.status === 'failed') return oneLine(updated.error) || 'the post did not go out';
      const url = updated.posted_url ? ` ${updated.posted_url}` : '';
      return `posted ${platformName(updated.platform || post.platform)} ${shortId(post.id)}${url}`;
    };

    const flowInterview = async (post) => {
      capturing = false;
      setRaw(false);
      input.resume();
      try {
        const code = await runInterview({ mode: 'resume', idInput: post.id, research: false });
        return code === 0 ? 'interview done' : 'interview stopped';
      } finally {
        input.resume();
        capturing = true;
        setRaw(true);
      }
    };

    const handleAction = async (action, view) => {
      try {
        if (action.type === 'refresh') return null;
        if (action.type === 'new-post') return await flowNewPost(action.day);
        const post = openPostAt(view, action.day, action.post);
        if (!post) return 'that post moved. r to refresh';
        if (action.type === 'edit-post') return await flowEdit(post);
        if (action.type === 'schedule-post') return await flowSchedule(post);
        if (action.type === 'interview-post') return await flowInterview(post);
        if (action.type === 'post-now') return await flowPostNow(post);
      } catch (error) {
        return oneLine(error && error.message) || 'something went wrong';
      }
      return null;
    };

    const restore = () => {
      capturing = false;
      setRaw(false);
      output.write('\x1b[0m\x1b[?25h');
      input.removeListener('keypress', onKeypress);
    };

    output.write('\x1b[?25l');
    const onSigint = () => {
      restore();
      process.exit(130);
    };
    process.on('SIGINT', onSigint);
    try {
      await refresh();
      let state = openInitialState(anchor);
      for (;;) {
        const view = buildView(state.week);
        draw(state, view);
        const key = await nextKey();
        const result = openReduce(state, key, view);
        state = result.state;
        if (result.action && result.action.type === 'quit') break;
        if (result.action) {
          const note = await handleAction(result.action, view);
          if (note) state = { ...state, note };
          await refresh();
        }
      }
    } finally {
      process.removeListener('SIGINT', onSigint);
      restore();
    }
    output.write('\n');
    return 0;
  };

  const cmd = clean[0];
  const rest = clean.slice(1);

  try {
    if (!cmd || cmd === 'week' || cmd === 'open') {
      const parsed = parseWeekArgs(rest);
      if (parsed.error) return fail(parsed.error);
      const input = deps.stdin || process.stdin;
      const output = deps.stdout || process.stdout;
      if (cmd === 'open' && input.isTTY && output.isTTY) {
        return openBoard(parsed.anchor, { input, output });
      }
      const data = await loadWeek(parsed.anchor);
      if (data.error) return fail(data.error, { status: data.status });
      const text = weekText(data.posts, data.board, { anchor: parsed.anchor });
      printResult({
        json,
        ok: true,
        text,
        payload: { ok: true, start: dayKey(data.days[0]), posts: data.posts, today: data.board },
      }, io);
      return 0;
    }

    if (cmd === 'show') {
      const idInput = rest[0];
      if (!idInput) return fail('say which post: atris popshare show <id>');
      const resolved = await resolveId(idInput);
      if (resolved.error) return failResolution(resolved);
      const post = resolved.post || {};
      printResult({ json, ok: true, text: showText(post), payload: { ok: true, post } }, io);
      return 0;
    }

    if (cmd === 'strategy') {
      const parsed = parseStrategyArgs(rest);
      if (parsed.error) return fail(parsed.error);
      const got = await call('/popshare/strategy');
      if (got.error) return fail(got.error, { status: got.status });
      const strategy = got.data || {};
      if (!parsed.updates) {
        printResult({ json, ok: true, text: strategyText(strategy), payload: { ok: true, strategy } }, io);
        return 0;
      }
      const existingGoals = strategy.cadence_goals && typeof strategy.cadence_goals === 'object'
        ? strategy.cadence_goals
        : {};
      const body = {
        narrative_arcs: parsed.updates.narrative_arcs !== undefined
          ? parsed.updates.narrative_arcs
          : (Array.isArray(strategy.narrative_arcs) ? strategy.narrative_arcs : []),
        cadence: parsed.updates.cadence !== undefined ? parsed.updates.cadence : String(strategy.cadence || ''),
        audience: parsed.updates.audience !== undefined ? parsed.updates.audience : String(strategy.audience || ''),
        north_star: parsed.updates.north_star !== undefined ? parsed.updates.north_star : String(strategy.north_star || ''),
        cadence_goals: parsed.updates.cadence_goals
          ? { ...existingGoals, ...parsed.updates.cadence_goals }
          : existingGoals,
      };
      const put = await call('/popshare/strategy', { method: 'PUT', body });
      if (put.error) return fail(put.error, { status: put.status });
      const saved = put.data || {};
      printResult({
        json,
        ok: true,
        text: `strategy saved\n${strategyText(saved)}`,
        payload: { ok: true, strategy: saved },
      }, io);
      return 0;
    }

    if (cmd === 'goals') {
      const parsed = parseGoalsArgs(rest);
      if (parsed.error) return fail(parsed.error);
      const got = await call('/popshare/strategy');
      if (got.error) return fail(got.error, { status: got.status });
      const strategy = got.data || {};
      if (!parsed.goals) {
        printResult({ json, ok: true, text: goalsText(strategy), payload: { ok: true, strategy } }, io);
        return 0;
      }
      // PUT replaces the whole strategy, so send every field back with only
      // the cadence goals merged in.
      const body = {
        narrative_arcs: Array.isArray(strategy.narrative_arcs) ? strategy.narrative_arcs : [],
        cadence: String(strategy.cadence || ''),
        audience: String(strategy.audience || ''),
        north_star: String(strategy.north_star || ''),
        cadence_goals: { ...(strategy.cadence_goals && typeof strategy.cadence_goals === 'object' ? strategy.cadence_goals : {}), ...parsed.goals },
      };
      const put = await call('/popshare/strategy', { method: 'PUT', body });
      if (put.error) return fail(put.error, { status: put.status });
      const saved = put.data || {};
      printResult({
        json,
        ok: true,
        text: `goals saved\n${goalsText(saved)}`,
        payload: { ok: true, strategy: saved },
      }, io);
      return 0;
    }

    if (cmd === 'today') {
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
      if (parsed.tieId) body.tie_id = parsed.tieId;
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
      let days = null;
      let tieFilter = null;
      for (let i = 0; i < rest.length; i += 1) {
        const arg = rest[i];
        if (arg === '--days') {
          const rawDays = rest[i + 1];
          const num = Number(rawDays);
          if (!Number.isInteger(num) || num < 1 || num > 365) return fail('--days takes a whole number from 1 to 365');
          days = num;
          i += 1;
          continue;
        }
        if (arg === '--tie') {
          const val = rest[i + 1];
          if (val === undefined || val.startsWith('--') || !String(val).trim()) return fail('--tie needs a value');
          tieFilter = String(val).trim();
          i += 1;
          continue;
        }
        return fail(`unknown flag ${arg}`);
      }
      const query = [];
      if (tieFilter) query.push(`tie_id=${encodeURIComponent(tieFilter)}`);
      if (days !== null || !tieFilter) {
        const windowDays = days === null ? 7 : days;
        const start = new Date(Date.now() - windowDays * DAY_MS).toISOString();
        const end = new Date().toISOString();
        query.push(`start=${encodeURIComponent(start)}`, `end=${encodeURIComponent(end)}`);
      }
      const got = await call(`/popshare/posts?${query.join('&')}`);
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
        if (['--text', '--theme', '--tie', '--status', '--platform', '--media'].includes(arg)) {
          const value = editArgs[i + 1];
          if (value === undefined || value.startsWith('--')) return fail(`${arg} needs a value`);
          const key = arg === '--tie' ? 'tie_id' : arg.slice(2);
          if (key === 'status' && !EDITABLE_STATUSES.has(value)) {
            return fail(`status must be one of ${[...EDITABLE_STATUSES].join(', ')}`);
          }
          if (key === 'platform' && !PLATFORMS.includes(value)) {
            return fail(`platform must be one of ${PLATFORMS.join(', ')}`);
          }
          if (key === 'media') mediaFiles.push(value);
          else if (key === 'tie_id') {
            const trimmed = String(value).trim();
            if (!trimmed) return fail('--tie needs a non-empty slug (use --clear-tie to clear)');
            fields.tie_id = trimmed;
          } else fields[key] = value;
          i += 1;
          continue;
        }
        if (arg === '--clear-tie') {
          fields.tie_id = '';
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
        return fail(`unexpected "${arg}". flags only after the id: --text, --theme, --tie, --clear-tie, --note, --status, --platform, --media, --clear-media`);
      }
      if (!Object.keys(fields).length && !addedNotes.length && !mediaFiles.length && !clearMedia) {
        return fail('say what to change: --text, --theme, --tie, --clear-tie, --note, --status, --platform, --media or --clear-media');
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

    if (cmd === 'scorecard') {
      let tieFilter = null;
      for (let i = 0; i < rest.length; i += 1) {
        const arg = rest[i];
        if (arg === '--tie') {
          const value = rest[i + 1];
          if (value === undefined || value.startsWith('--') || !String(value).trim()) return fail('--tie needs a value');
          tieFilter = String(value).trim();
          i += 1;
          continue;
        }
        return fail(`unknown flag ${arg}`);
      }
      const got = await call('/popshare/scorecard');
      if (got.error) return fail(got.error, { status: got.status });
      const data = got.data || {};
      const payload = tieFilter
        ? {
            ok: true,
            connected: Boolean(data.connected),
            connections: data.connections || {},
            tie_id: tieFilter,
            tie: (data.by_tie && data.by_tie[tieFilter]) || null,
            ties: (Array.isArray(data.ties) ? data.ties : []).filter((t) => t && t.tie_id === tieFilter),
            posts: (Array.isArray(data.posts) ? data.posts : []).filter((p) => p && p.tie_id === tieFilter),
            totals: data.totals || {},
            by_tie: data.by_tie || {},
          }
        : { ok: true, ...data };
      printResult({ json, ok: true, text: scorecardText(data, { tie: tieFilter }), payload }, io);
      return 0;
    }

    if (cmd === 'score' || cmd === 'scoreboard') {
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
      return runInterview(parsed);
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
  dayKey,
  parseLocalDate,
  parseWeekArgs,
  weekDays,
  weekDayKeys,
  postInstant,
  statusMark,
  gridPostLine,
  progressLine,
  weekText,
  showText,
  parseGoalsArgs,
  goalsText,
  parseStrategyArgs,
  strategyText,
  scorecardText,
  openInitialState,
  keyName,
  openReduce,
};
