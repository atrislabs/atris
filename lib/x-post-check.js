'use strict';

// Check the posts in an x-search answer against what was actually posted on X.
// Grok's answer lists numbered posts with an @handle and a quote. X's free
// public embed endpoint returns the real post for a status id. A post is
// `checked` when a cited post has the same handle and the same words,
// `unmatched` when no cited post does, and `unknown` when a fetch failed and
// the post could have been the one we could not read. Same spirit as
// scripts/det/ytquote-repair.js: keep what the source says, flag the rest.

const EMBED_URL = 'https://cdn.syndication.twimg.com/tweet-result';
const FETCH_TIMEOUT_MS = 5000;
const MAX_IDS = 15;
const OVERLAP_MIN = 0.6;
const PROBE_WORDS = 6;
const MIN_QUOTE_WORDS = 3;

const STATUS_ID = /(?:x|twitter)\.com\/(?:i(?:\/web)?|([A-Za-z0-9_]{1,15}))\/status(?:es)?\/(\d{5,25})/i;
const HANDLE = /@([A-Za-z0-9_]{1,15})\b/;
// A post starts at "1.", "**1.**", "Post 1:", a heading, a top-level bullet
// with a handle, or a table row with a handle.
const BLOCK_START = /^\s?(?:\*\*)?\s?(?:\d{1,2}[.)]|(?:post|tweet)\s*#?\s*\d{1,2}\b)(?:\*\*)?[\s:]|^#{2,4}\s|^[-*•]\s.*@[A-Za-z0-9_]|^\|.*@[A-Za-z0-9_]/i;
const TEXT_LABEL = /\b(?:(?:full\s+)?(?:(?:tweet|post)\s+)?(?:text|content|quote)|tweet|post)\b\s*\**\s*:\s*\**\s*/i;
const QUOTE_SPAN = /["“]([^"“”]{15,1000}?)["”]/;
const URL_RE = /https?:\/\/\S+/g;

function decodeEntities(s) {
  return String(s)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

// Like ytquote-repair's normalizeText, but keeps letters from any language so
// a Japanese or Spanish post can still be checked.
function normalizeText(s) {
  return decodeEntities(s)
    .replace(URL_RE, ' ')
    .toLowerCase()
    .replace(/[‘’'`]/g, '')
    .replace(/[^\p{L}\p{N} ]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function words(s) {
  return normalizeText(s).split(' ').filter(Boolean);
}

function statusIdFromUrl(url) {
  const match = String(url || '').match(STATUS_ID);
  if (!match) return null;
  return { id: match[2], handle: match[1] || null };
}

// Pull the quoted post text out of one answer block. Prefers a labeled line
// ("Full tweet text: ..."), then the first long quoted span. Returns the text
// and the character offset where it ends, so a link can go right under it.
function quoteFromBlock(block) {
  const label = block.match(TEXT_LABEL);
  if (label) {
    const lead = block.slice(label.index + label[0].length).match(/^>\s?/);
    const start = label.index + label[0].length + (lead ? lead[0].length : 0);
    const rest = block.slice(start);
    const opener = rest.match(/^["“]/);
    if (opener) {
      const close = rest.slice(1).search(/["”](?=\s*(?:\.{3}|…)?\s*(?:$|\n|\*|\(|,|;|-|—|\[))/);
      const end = close === -1 ? rest.search(/\n|$/) : close + 1;
      const text = rest.slice(1, end).trim();
      if (words(text).length >= MIN_QUOTE_WORDS) return { text, end: start + end + 1 };
    } else {
      const lineEnd = rest.search(/\n|$/);
      const text = rest.slice(0, lineEnd).replace(/\*+/g, '').trim();
      if (words(text).length >= MIN_QUOTE_WORDS) return { text, end: start + lineEnd };
    }
  }
  const span = block.match(QUOTE_SPAN);
  if (span && words(span[1]).length >= MIN_QUOTE_WORDS) {
    return { text: span[1].trim(), end: span.index + span[0].length };
  }
  return blockquoteFromBlock(block) || tableCellFromBlock(block);
}

// "> post text" lines, joined.
function blockquoteFromBlock(block) {
  const lines = block.split('\n');
  const first = lines.findIndex((l) => /^\s*>\s?\S/.test(l));
  if (first === -1) return null;
  let last = first;
  while (last + 1 < lines.length && /^\s*>/.test(lines[last + 1])) last += 1;
  const text = lines.slice(first, last + 1).map((l) => l.replace(/^\s*>\s?/, '')).join(' ').replace(/\*+/g, '').trim();
  if (words(text).length < MIN_QUOTE_WORDS) return null;
  return { text, end: lines.slice(0, last + 1).join('\n').length };
}

// A markdown table row: the wordiest cell that is not just a handle or link.
function tableCellFromBlock(block) {
  if (!/^\|/.test(block)) return null;
  const row = block.split('\n')[0];
  const cells = row.split('|').map((c) => c.replace(/\*+/g, '').trim())
    .filter((c) => c && !/^@\w+$/.test(c) && !/^https?:\/\//.test(c));
  let best = null;
  for (const cell of cells) {
    if (!best || words(cell).length > words(best).length) best = cell;
  }
  if (!best || words(best).length < MIN_QUOTE_WORDS + 3) return null;
  return { text: best.replace(/^["“]|["”]$/g, ''), end: row.length };
}

function splitBlocks(lines) {
  const blocks = [];
  let current = null;
  lines.forEach((line, index) => {
    if (BLOCK_START.test(line)) {
      if (current) blocks.push(current);
      current = { start: index, lines: [line] };
    } else if (current) {
      current.lines.push(line);
    }
  });
  if (current) blocks.push(current);
  return blocks;
}

// Parse numbered posts from Grok's free-text answer. Tolerant of markdown:
// **@handle**, "(@handle)", "Full tweet text: ...", or a plain quoted span.
// defaultHandle fills in for person searches that never repeat the handle.
function parsePosts(content, { defaultHandle = null } = {}) {
  const lines = String(content || '').replace(/\r\n/g, '\n').split('\n');
  const posts = [];
  for (const block of splitBlocks(lines)) {
    const body = block.lines.join('\n');
    const quote = quoteFromBlock(body);
    if (!quote) continue;
    const outside = body.replace(quote.text, ' ');
    const linked = statusIdFromUrl(outside);
    const handleMatch = outside.match(HANDLE);
    const handle = (handleMatch && handleMatch[1])
      || (linked && linked.handle)
      || (defaultHandle ? String(defaultHandle).replace(/^@/, '') : null);
    if (!handle) continue;
    const endLine = block.start + body.slice(0, quote.end).split('\n').length - 1;
    posts.push({
      index: posts.length + 1,
      handle,
      text: quote.text,
      line: Math.min(endLine, block.start + block.lines.length - 1),
      linkedId: linked ? linked.id : null,
    });
  }
  return posts;
}

// Citation urls in order, one entry per status id. Non-status urls come back
// with id null so they are never lost.
function parseCitations(citations) {
  const seen = new Set();
  const out = [];
  for (const raw of Array.isArray(citations) ? citations : []) {
    const url = String(raw || '').trim();
    if (!url) continue;
    const parsed = statusIdFromUrl(url);
    if (parsed && seen.has(parsed.id)) continue;
    if (parsed) seen.add(parsed.id);
    out.push({ url, id: parsed ? parsed.id : null, handle: parsed ? parsed.handle : null });
  }
  return out;
}

function realText(json) {
  const note = json?.note_tweet?.note_tweet_results?.result?.text;
  return String(note || json?.text || '');
}

// One embed lookup. ok:false means we could not tell (network, timeout, rate
// limit). ok:true with post:null means X says the post does not exist.
async function fetchXPost(id, { fetch = globalThis.fetch, timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  if (typeof fetch !== 'function') return { id, ok: false, error: 'no fetch' };
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const res = await fetch(`${EMBED_URL}?id=${encodeURIComponent(id)}&token=a`, {
      signal: controller ? controller.signal : undefined,
      headers: { accept: 'application/json' },
    });
    if (res.status === 404) return { id, ok: true, post: null };
    if (!res.ok) return { id, ok: false, error: `http ${res.status}` };
    const json = await res.json();
    const handle = json?.user?.screen_name;
    const text = realText(json);
    if (!handle || !text || json.__typename === 'TweetTombstone') return { id, ok: true, post: null };
    return { id, ok: true, post: { id, handle, text, createdAt: json.created_at || null } };
  } catch (err) {
    return { id, ok: false, error: err && err.name === 'AbortError' ? 'timeout' : String(err && err.message || err) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function textAgrees(quote, real) {
  const quoteWords = words(quote);
  const realWords = words(real);
  if (!quoteWords.length || !realWords.length) return false;
  const probe = quoteWords.slice(0, Math.min(PROBE_WORDS, quoteWords.length)).join(' ');
  if (` ${realWords.join(' ')} `.includes(` ${probe} `)) return true;
  const realSet = new Set(realWords);
  const hits = quoteWords.filter((w) => realSet.has(w)).length;
  return hits / quoteWords.length >= OVERLAP_MIN;
}

// Pure matcher. results: [{ id, ok, post }]. Each real post backs at most one
// answer post.
function matchPosts(posts, results) {
  const found = results.filter((r) => r.ok && r.post);
  const anyFailed = results.some((r) => !r.ok);
  const used = new Set();
  return posts.map((post) => {
    const handle = String(post.handle).toLowerCase();
    const hit = found.find((r) => !used.has(r.id)
      && r.post.handle.toLowerCase() === handle
      && textAgrees(post.text, r.post.text));
    if (hit) {
      used.add(hit.id);
      return {
        index: post.index,
        handle: hit.post.handle,
        text: post.text,
        status: 'checked',
        id: hit.id,
        url: `https://x.com/${hit.post.handle}/status/${hit.id}`,
        posted_at: hit.post.createdAt,
      };
    }
    return {
      index: post.index,
      handle: post.handle,
      text: post.text,
      status: anyFailed ? 'unknown' : 'unmatched',
      id: null,
      url: null,
      posted_at: null,
    };
  });
}

function tallyChecks(checks) {
  const tally = { checked: 0, unmatched: 0, unknown: 0 };
  for (const c of checks) tally[c.status] += 1;
  return tally;
}

function formatTally(tally) {
  return `posts: ${tally.checked} checked, ${tally.unmatched} unverified, ${tally.unknown} unknown`;
}

// Check every post in one answer. Returns null when the answer has no posts
// to check, so the caller prints the original output unchanged.
async function checkXPosts({ content, citations, defaultHandle = null, fetchPost, fetch, timeoutMs } = {}) {
  const posts = parsePosts(content, { defaultHandle });
  if (!posts.length) return null;
  const cites = parseCitations(citations);
  const ids = [];
  for (const id of [...posts.map((p) => p.linkedId), ...cites.map((c) => c.id)]) {
    if (id && !ids.includes(id)) ids.push(id);
  }
  const lookup = fetchPost || ((id) => fetchXPost(id, { fetch, timeoutMs }));
  const results = await Promise.all(ids.slice(0, MAX_IDS).map(async (id) => {
    try {
      const r = await lookup(id);
      return r && typeof r === 'object' ? { ...r, id } : { id, ok: false, error: 'empty' };
    } catch (err) {
      return { id, ok: false, error: String(err && err.message || err) };
    }
  }));
  const checks = matchPosts(posts, results);
  const usedIds = new Set(checks.filter((c) => c.id).map((c) => c.id));
  return {
    posts,
    checks,
    tally: tallyChecks(checks),
    otherSources: cites.filter((c) => !c.id || !usedIds.has(c.id)).map((c) => c.url),
  };
}

const UNMATCHED_NOTE = '(could not find this post on X, treat as unverified)';
const UNKNOWN_NOTE = '(could not reach X to check this post)';

function indentOf(line) {
  const lead = String(line).match(/^\s*/)[0];
  return lead.length ? lead : '   ';
}

// Put each post's link or warning right under its quote.
function annotateContent(content, result) {
  const lines = String(content || '').replace(/\r\n/g, '\n').split('\n');
  const byLine = new Map();
  result.posts.forEach((post, i) => {
    const check = result.checks[i];
    const note = check.status === 'checked'
      ? `${check.url} (checked)`
      : check.status === 'unknown' ? UNKNOWN_NOTE : UNMATCHED_NOTE;
    const list = byLine.get(post.line) || [];
    list.push(`${indentOf(lines[post.line])}${note}`);
    byLine.set(post.line, list);
  });
  const out = [];
  lines.forEach((line, index) => {
    out.push(line);
    if (byLine.has(index)) out.push(...byLine.get(index));
  });
  return out.join('\n');
}

module.exports = {
  EMBED_URL,
  FETCH_TIMEOUT_MS,
  MAX_IDS,
  UNMATCHED_NOTE,
  UNKNOWN_NOTE,
  normalizeText,
  parsePosts,
  parseCitations,
  statusIdFromUrl,
  fetchXPost,
  textAgrees,
  matchPosts,
  tallyChecks,
  formatTally,
  checkXPosts,
  annotateContent,
};
