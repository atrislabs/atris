'use strict';

// Check an x-search answer against what was actually posted on X, whatever
// layout Grok picked this time. X's free public embed endpoint returns the
// real post for each cited status id. Two passes:
//   1. citations into the answer: a real post whose words show up in the
//      answer is `checked`.
//   2. quotes out of the answer: a quote of 40+ characters that matches no
//      real post is `unverified`, or `unknown` when a lookup failed and it
//      could belong to the post we could not read.
// The block parser below only decides where a link goes, never what counts.
// Same spirit as scripts/det/ytquote-repair.js: keep what the source says,
// flag the rest.

const EMBED_URL = 'https://cdn.syndication.twimg.com/tweet-result';
const FETCH_TIMEOUT_MS = 5000;
const MAX_IDS = 25;
const OVERLAP_MIN = 0.6;
const PROBE_WORDS = 6;
const MIN_QUOTE_WORDS = 3;
const MIN_REAL_WORDS = 4;
const NEAR_CHARS = 300;
const MIN_SPAN_CHARS = 40;

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

// Helper only: parse numbered posts from Grok's answer. Tolerant of markdown:
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

// The words of a real post, minus leading reply mentions ("@a @b actual text"),
// which answers usually leave out.
function realWordsOf(text) {
  return words(String(text || '').replace(/^\s*(?:@[A-Za-z0-9_]+\s+)+/, ''));
}

// Does the real post show up anywhere in the answer, whatever the layout?
// Yes when its first 6 words appear, or when some window of the answer holds
// 60% of its words.
function realInAnswer(realWords, answerWords, answerFlat) {
  if (realWords.length < MIN_REAL_WORDS) return false;
  const probe = realWords.slice(0, Math.min(PROBE_WORDS, realWords.length)).join(' ');
  if (answerFlat.includes(` ${probe} `)) return true;
  const n = realWords.length;
  if (!answerWords.length) return false;
  const size = Math.min(n, answerWords.length);
  const need = new Map();
  for (const w of realWords) need.set(w, (need.get(w) || 0) + 1);
  const have = new Map();
  let hits = 0;
  const add = (w, delta) => {
    if (!need.has(w)) return;
    const before = Math.min(have.get(w) || 0, need.get(w));
    have.set(w, (have.get(w) || 0) + delta);
    const after = Math.min(have.get(w), need.get(w));
    hits += after - before;
  };
  for (let i = 0; i < answerWords.length; i += 1) {
    add(answerWords[i], 1);
    if (i >= size) add(answerWords[i - size], -1);
    if (i >= size - 1 && hits / n >= OVERLAP_MIN) return true;
  }
  return false;
}

// Every 6-word run of the real post, for the looser near-the-handle rule.
function realGrams(realWords) {
  const grams = [];
  for (let i = 0; i + PROBE_WORDS <= realWords.length; i += 1) {
    grams.push(realWords.slice(i, i + PROBE_WORDS).join(' '));
  }
  return grams;
}

// Every quote pair, straight or curly, paired left to right inside each
// paragraph. Short quotes are paired too, so a short "phrase" never shifts
// the pairing and turns the gap between two posts into a fake quote.
function allQuotes(content) {
  const text = String(content || '');
  const out = [];
  const para = /[^\n]*(?:\n(?!\s*\n)[^\n]*)*/g;
  let p;
  while ((p = para.exec(text))) {
    if (!p[0]) { para.lastIndex += 1; continue; }
    const re = /["“]([^"“”]*)["”]/g;
    let m;
    while ((m = re.exec(p[0]))) {
      out.push({ text: m[1].trim(), start: p.index + m.index, end: p.index + m.index + m[0].length });
    }
  }
  return out;
}

// Quoted spans of 40+ characters, anywhere in the answer.
function quotedSpans(content) {
  return allQuotes(content).filter((q) => q.text.length >= MIN_SPAN_CHARS);
}

// Near the handle: within ~300 characters of an @handle mention there is a
// 6-word run of the real post, or a quote whose words are mostly in it.
function nearHandle(content, handle, realWords) {
  const text = String(content || '');
  const re = new RegExp(`@${handle.replace(/[^A-Za-z0-9_]/g, '')}\\b`, 'gi');
  const grams = realGrams(realWords);
  const realSet = new Set(realWords);
  let m;
  while ((m = re.exec(text))) {
    const hood = text.slice(Math.max(0, m.index - NEAR_CHARS), m.index + m[0].length + NEAR_CHARS);
    const flat = ` ${words(hood).join(' ')} `;
    if (grams.some((g) => flat.includes(` ${g} `))) return true;
    for (const span of allQuotes(hood)) {
      const w = words(span.text);
      if (w.length >= MIN_REAL_WORDS && w.filter((x) => realSet.has(x)).length / w.length >= OVERLAP_MIN) return true;
    }
  }
  return false;
}

function lineAt(content, offset) {
  return String(content).slice(0, offset).split('\n').length - 1;
}

// Where a link can go inline: a line inside a post block that is not a table
// row. The block parser only places links; it never decides what counts.
function inlineLines(lines) {
  const ok = new Set();
  for (const block of splitBlocks(lines)) {
    block.lines.forEach((line, i) => {
      if (!/^\s*\|/.test(line)) ok.add(block.start + i);
    });
  }
  return ok;
}

// Last non-empty line of the post block holding this real post, or null.
function blockLineFor(lines, realWords) {
  for (const block of splitBlocks(lines)) {
    const body = block.lines.join('\n');
    const w = words(body);
    if (realInAnswer(realWords, w, ` ${w.join(' ')} `)) {
      for (let i = block.lines.length - 1; i >= 0; i -= 1) {
        if (block.lines[i].trim()) return block.start + i;
      }
    }
  }
  return null;
}

// Pure matcher, layout-independent. results: [{ id, ok, post }].
// Pass one, citations into the answer: a real post that appears in the answer
// is checked. Pass two, quotes out of the answer: a 40+ character quote that
// matches no real post is unverified, or unknown when a lookup failed.
function matchAnswer(content, results) {
  const text = String(content || '').replace(/\r\n/g, '\n');
  const lines = text.split('\n');
  const answerWords = words(text);
  const answerFlat = ` ${answerWords.join(' ')} `;
  const spans = quotedSpans(text);
  const inline = inlineLines(lines);
  const found = results.filter((r) => r.ok && r.post);
  // Failed lookups, and ids past the lookup cap, could be any quote's source.
  const anyFailed = results.some((r) => !r.ok);
  const spanOwner = new Map();
  const checks = [];

  for (const r of found) {
    const realWords = realWordsOf(r.post.text);
    const span = spans.find((sp) => !spanOwner.has(sp) && realWords.length >= MIN_REAL_WORDS && textAgrees(sp.text, r.post.text));
    const hit = Boolean(span)
      || realInAnswer(realWords, answerWords, answerFlat)
      || (realWords.length >= MIN_REAL_WORDS && nearHandle(text, r.post.handle, realWords));
    if (!hit) continue;
    if (span) spanOwner.set(span, r.id);
    const anchor = span ? lineAt(text, span.end) : blockLineFor(lines, realWords);
    checks.push({
      status: 'checked',
      handle: r.post.handle,
      id: r.id,
      url: `https://x.com/${r.post.handle}/status/${r.id}`,
      text: r.post.text,
      posted_at: r.post.createdAt,
      line: anchor !== null && inline.has(anchor) ? anchor : null,
    });
  }

  for (const sp of spans) {
    if (spanOwner.has(sp)) continue;
    if (found.some((r) => textAgrees(sp.text, r.post.text))) continue;
    const anchor = lineAt(text, sp.end);
    checks.push({
      status: anyFailed ? 'unknown' : 'unverified',
      handle: null,
      id: null,
      url: null,
      text: sp.text,
      posted_at: null,
      line: inline.has(anchor) ? anchor : null,
    });
  }
  return checks;
}

function tallyChecks(checks) {
  const tally = { checked: 0, unverified: 0, unknown: 0 };
  for (const c of checks) tally[c.status] += 1;
  return tally;
}

function formatTally(tally) {
  return `posts: ${tally.checked} checked, ${tally.unverified} unverified, ${tally.unknown} unknown`;
}

// Check one answer against the real posts behind its citations. Returns null
// when there is nothing to check, so the caller prints the original output.
async function checkXPosts({ content, citations, fetchPost, fetch, timeoutMs } = {}) {
  const cites = parseCitations(citations);
  const ids = [];
  const inlineIds = [...String(content || '').matchAll(new RegExp(STATUS_ID.source, 'gi'))].map((m) => m[2]);
  for (const id of [...inlineIds, ...cites.map((c) => c.id)]) {
    if (id && !ids.includes(id)) ids.push(id);
  }
  if (!ids.length && !quotedSpans(content).length) return null;
  const lookup = fetchPost || ((id) => fetchXPost(id, { fetch, timeoutMs }));
  const skipped = ids.slice(MAX_IDS).map((id) => ({ id, ok: false, error: 'not looked up' }));
  const looked = await Promise.all(ids.slice(0, MAX_IDS).map(async (id) => {
    try {
      const r = await lookup(id);
      return r && typeof r === 'object' ? { ...r, id } : { id, ok: false, error: 'empty' };
    } catch (err) {
      return { id, ok: false, error: String(err && err.message || err) };
    }
  }));
  const results = [...looked, ...skipped];
  const checks = matchAnswer(content, results);
  if (!checks.length) return null;
  const usedIds = new Set(checks.filter((c) => c.id).map((c) => c.id));
  return {
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

function noteFor(check) {
  if (check.status === 'checked') return `${check.url} (checked)`;
  return check.status === 'unknown' ? UNKNOWN_NOTE : UNMATCHED_NOTE;
}

function shortQuote(text, max = 60) {
  const flat = String(text).replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 3).trim()}...` : flat;
}

// Put each link or warning under its post when the post block can be found.
// Anything that cannot be placed (tables, prose) is listed after the answer.
function annotateContent(content, result) {
  const lines = String(content || '').replace(/\r\n/g, '\n').split('\n');
  const byLine = new Map();
  const loose = [];
  for (const check of result.checks) {
    if (check.line === null || check.line === undefined || check.line >= lines.length) {
      loose.push(check);
      continue;
    }
    const list = byLine.get(check.line) || [];
    list.push(`${indentOf(lines[check.line])}${noteFor(check)}`);
    byLine.set(check.line, list);
  }
  const out = [];
  lines.forEach((line, index) => {
    out.push(line);
    if (byLine.has(index)) out.push(...byLine.get(index));
  });
  const looseChecked = loose.filter((c) => c.status === 'checked');
  const looseOther = loose.filter((c) => c.status !== 'checked');
  if (looseChecked.length) {
    out.push('', 'Checked posts:');
    for (const c of looseChecked) out.push(`  @${c.handle}: ${c.url} (checked)`);
  }
  if (looseOther.length) {
    out.push('', 'Unverified quotes:');
    for (const c of looseOther) out.push(`  "${shortQuote(c.text)}" ${noteFor(c)}`);
  }
  return out.join('\n');
}

module.exports = {
  UNMATCHED_NOTE,
  UNKNOWN_NOTE,
  normalizeText,
  parsePosts,
  parseCitations,
  fetchXPost,
  textAgrees,
  quotedSpans,
  matchAnswer,
  formatTally,
  checkXPosts,
  annotateContent,
};
