'use strict';

// atris feed scrub-keys: finds a password or key that earlier runs saved in
// the feed's own files on this computer, and (without --dry-run) replaces it
// with a short marker in place. Only ever run by a person; it never prints the
// text it found and never touches the business's hosted feed.
//
// Files: the comments (social.json), the posts (posts.jsonl), the events log
// (events.jsonl), all in .atris/state/feed, and each member's daily logs in
// atris/team/<member>/logs. Any saved text the precise check (holdsKey in
// lib/feed-plain-words.js) flags is replaced whole, so no piece of it stays.

const fs = require('fs');
const path = require('path');

const MARKER = '[removed: it held a password or key]';

function core() {
  return require('./feed-core');
}

function holdsKey(text) {
  return require('./feed-plain-words').holdsKey(text);
}

// Every string in a parsed JSON value, flagged ones replaced. count.n grows by
// one for each.
function scrubJson(value, count) {
  if (typeof value === 'string') {
    if (value !== MARKER && holdsKey(value)) { count.n += 1; return MARKER; }
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => scrubJson(item, count));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = scrubJson(item, count);
    return out;
  }
  return value;
}

function scrubJsonLine(line, count) {
  if (!line.trim()) return line;
  try {
    return JSON.stringify(scrubJson(JSON.parse(line), count));
  } catch {
    if (!holdsKey(line)) return line;
    count.n += 1;
    return MARKER;
  }
}

// A log line keeps its indent and list mark; the rest is replaced.
function scrubLogLine(line, count) {
  if (line.includes(MARKER) || !holdsKey(line)) return line;
  count.n += 1;
  const lead = line.match(/^\s*(?:[-*]\s+)?/)[0];
  return `${lead}${MARKER}`;
}

// Rewrites one file with each line changed. Other writers append to these
// files without the lock, so the file is read again right before the swap and
// the change is redone if it grew in between.
function rewriteLines(file, change, { apply }) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    let before;
    try { before = fs.readFileSync(file, 'utf8'); } catch { return 0; }
    const count = { n: 0 };
    const after = before.split('\n').map((line) => change(line, count)).join('\n');
    if (!count.n || !apply) return count.n;
    const temp = `${file}.scrub-${process.pid}`;
    fs.writeFileSync(temp, after);
    let now = null;
    try { now = fs.readFileSync(file, 'utf8'); } catch {}
    if (now === before) {
      fs.renameSync(temp, file);
      return count.n;
    }
    fs.rmSync(temp, { force: true });
  }
  throw new (core().FeedError)(503, 'The feed kept changing while it was being cleaned. Try again in a moment.', { code: 'busy', busy: true });
}

function memberLogs(root) {
  const team = path.join(root, 'atris', 'team');
  const out = [];
  let members = [];
  try { members = fs.readdirSync(team, { withFileTypes: true }).filter((entry) => entry.isDirectory()); } catch { return out; }
  for (const member of members) {
    const dir = path.join(team, member.name, 'logs');
    let names = [];
    try { names = fs.readdirSync(dir).filter((name) => name.endsWith('.md')); } catch { continue; }
    for (const name of names) out.push(path.join(dir, name));
  }
  return out;
}

function scrubKeys(root, options = {}) {
  const c = core();
  const apply = options.dryRun !== true;
  const feedDir = path.join(root, '.atris', 'state', 'feed');
  return c._internal.withQueueLock(root, () => {
    const found = { comments: 0, posts: 0, events: 0, member_logs: 0 };
    const social = path.join(feedDir, 'social.json');
    const saved = fs.existsSync(social) ? c._internal.readJsonFile(social) : null;
    if (saved && typeof saved === 'object') {
      const count = { n: 0 };
      const clean = scrubJson(saved, count);
      found.comments = count.n;
      if (count.n && apply) c._internal.writeJsonAtomic(social, clean);
    }
    found.posts = rewriteLines(path.join(feedDir, 'posts.jsonl'), scrubJsonLine, { apply });
    found.events = rewriteLines(path.join(feedDir, 'events.jsonl'), scrubJsonLine, { apply });
    for (const file of memberLogs(root)) found.member_logs += rewriteLines(file, scrubLogLine, { apply });
    const total = Object.values(found).reduce((sum, n) => sum + n, 0);
    return { version: c.FEED_VERSION, dry_run: !apply, found, total, replaced: apply ? total : 0 };
  }, { lockName: 'room.lock', busy: 'The feed is busy saving a note. Try again in a moment.' });
}

module.exports = { MARKER, scrubKeys };
