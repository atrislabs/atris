'use strict';

// Local meaning-plus-BM25 ranker for `atris memory search`. Reads the
// calibrated v2 index on this machine, embeds a plain-word question with local
// Ollama, and blends results into the server's word hits via reciprocal rank.
// Every failure returns null silently so search never breaks or prints noise.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { isRawData } = require('./memory-live');

const INDEX_FORMAT = 'calibrated-multiview-maxsim-v2';
const DEFAULT_OLLAMA_HOST = 'http://localhost:11434';
const EMBED_TIMEOUT_MS = 1500;
const BM25_WEIGHT = 0.35;
const TOP_K = 50;
const RRF_K = 10;
const INSTR = "Instruct: Given a message a person sends their assistant, retrieve notes from the person's memory that the assistant should know to do this well\nQuery: ";
const PATTERN_CHARS = /[|\\^$*[\]()]/;

// Tokenizer and stemmer match the index builder (memory_recall_index.py in the
// backend) so query terms line up with bm25.json.
const STOP = new Set((
  'a an and are as at be by for from has have he her his how i in is it its me my of on or our s she so t ' +
  'that the their them there these they this to us was we were what when where which who why will with would ' +
  'you your about after again also can could do does did get give go going into just know like make more most ' +
  'much need new not now one only other out over really right should some still take tell than then thing things ' +
  'think through up very want way well work help please'
).split(' '));

const SUFFIXES = ['ings', 'ers', 'ies', 'ied', 'ing', 'ed', 'es', 'ly', 'er', 's'];

function stem(word) {
  for (const suf of SUFFIXES) {
    if (word.endsWith(suf) && word.length - suf.length >= 3) {
      return word.slice(0, -suf.length) + (suf === 'ies' || suf === 'ied' ? 'y' : '');
    }
  }
  return word;
}

function tokenize(text) {
  const words = String(text).toLowerCase().match(/[a-z0-9]+/g) || [];
  const out = [];
  for (const w of words) {
    if (STOP.has(w)) continue;
    if (w.length < 2 && !/^\d$/.test(w)) continue;
    out.push(stem(w));
  }
  return out;
}

function scoreBM25(prompt, bm25, nDocs) {
  const scores = new Float32Array(nDocs);
  if (!bm25 || !bm25.postings || !bm25.idf || !Array.isArray(bm25.dl) || bm25.dl.length !== nDocs) {
    return scores;
  }
  const qTerms = [...new Set(tokenize(prompt))];
  if (!qTerms.length) return scores;
  // The tables are plain objects, so a word like "constructor" would read a function
  // off the prototype and turn every score into NaN. Own entries of the right type only.
  const own = (table, term) => (Object.prototype.hasOwnProperty.call(table, term) ? table[term] : undefined);
  const idfOf = (term) => { const v = own(bm25.idf, term); return Number.isFinite(v) ? v : 0; };
  let qIdfSum = 0;
  for (const t of qTerms) qIdfSum += idfOf(t);
  const qNorm = Math.sqrt(qIdfSum || 1);
  const k1 = bm25.k1 || 1.2;
  const b = bm25.b || 0.75;
  const avgdl = bm25.avgdl || 1;
  const dl = bm25.dl;
  for (const t of qTerms) {
    const idf = idfOf(t);
    const post = own(bm25.postings, t);
    if (!idf || !Array.isArray(post)) continue;
    for (let k = 0; k < post.length; k += 2) {
      const di = post[k];
      const tf = post[k + 1];
      if (di >= 0 && di < nDocs) {
        scores[di] += (idf * (tf * (k1 + 1))) / (tf + k1 * (1 - b + b * (dl[di] / avgdl)));
      }
    }
  }
  for (let i = 0; i < nDocs; i += 1) scores[i] /= qNorm;
  return scores;
}

// Small files read from Node's shared Buffer pool can start on a non-4-byte
// boundary; copy only when needed so big index files stay zero-copy.
function toFloat32(buf) {
  if (buf.byteOffset % 4 === 0) {
    return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  }
  const ab = new ArrayBuffer(buf.byteLength);
  new Uint8Array(ab).set(buf);
  return new Float32Array(ab);
}

function indexDir(env = process.env) {
  const custom = env && env.ATRIS_MEMORY_INDEX ? String(env.ATRIS_MEMORY_INDEX).trim() : '';
  if (custom) return custom;
  const home = (env && env.HOME) || os.homedir();
  return path.join(home, '.atris', 'memory-recall');
}

function loadIndex(dir) {
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
    if (!meta || meta.format !== INDEX_FORMAT) return null;
    if (typeof meta.model !== 'string' || !meta.model) return null;
    if (!Number.isInteger(meta.dim) || meta.dim <= 0 || !Array.isArray(meta.items)) return null;
    const nItems = meta.items.length;
    const dim = meta.dim;
    const vbuf = fs.readFileSync(path.join(dir, 'vectors.f32'));
    const bbuf = fs.readFileSync(path.join(dir, 'bias.f32'));
    if (vbuf.byteLength !== nItems * dim * 4 || bbuf.byteLength !== nItems * 4) return null;
    let bm25 = null;
    const bmPath = path.join(dir, 'bm25.json');
    if (fs.existsSync(bmPath)) {
      try { bm25 = JSON.parse(fs.readFileSync(bmPath, 'utf8')); } catch { bm25 = null; }
    }
    return { meta, vec: toFloat32(vbuf), bias: toFloat32(bbuf), bm25 };
  } catch {
    return null;
  }
}

function parseFolders(folder) {
  return String(folder || '')
    .split('|')
    .map((part) => part.trim().replace(/^\/+|\/+$/g, ''))
    .filter(Boolean);
}

function inFolders(itemPath, scopes) {
  if (!scopes.length) return true;
  return scopes.some((scope) => itemPath === scope || itemPath.startsWith(`${scope}/`));
}

// Plain-word questions get local mixing; patterns like rent|lease stay pure word search.
function isPlainQuestion(query) {
  const text = String(query || '').trim();
  if (!text || PATTERN_CHARS.test(text)) return false;
  const words = text.split(/\s+/).filter((w) => /[a-z0-9]/i.test(w));
  return words.length >= 3;
}

async function defaultEmbed(input, { model, host, signal }) {
  const base = String(host || DEFAULT_OLLAMA_HOST).replace(/\/+$/, '');
  const res = await fetch(`${base}/api/embed`, {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, input: [input], keep_alive: '30m' }),
  });
  if (!res.ok) return null;
  const body = await res.json();
  return body && Array.isArray(body.embeddings) ? body.embeddings[0] : null;
}

async function embedQuestion(question, { model, dim, host, timeoutMs, signal, embed }) {
  const ctl = new AbortController();
  const onParentAbort = () => ctl.abort();
  if (signal) {
    if (signal.aborted) return null;
    signal.addEventListener('abort', onParentAbort, { once: true });
  }
  const input = INSTR + String(question).slice(0, 2000);
  const fn = embed || defaultEmbed;
  let timer;
  try {
    const work = Promise.resolve().then(() => fn(input, { model, host, signal: ctl.signal })).catch(() => null);
    const deadline = new Promise((resolve) => {
      timer = setTimeout(() => { ctl.abort(); resolve(null); }, timeoutMs);
      if (timer.unref) timer.unref();
    });
    const raw = await Promise.race([work, deadline]);
    if (!raw || raw.length !== dim) return null;
    let norm = 0;
    for (let j = 0; j < dim; j += 1) {
      const v = Number(raw[j]);
      if (!Number.isFinite(v)) return null;
      norm += v * v;
    }
    norm = Math.sqrt(norm) || 1;
    const qn = new Float32Array(dim);
    for (let j = 0; j < dim; j += 1) qn[j] = raw[j] / norm;
    return qn;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onParentAbort);
  }
}

async function rankLocal(question, options = {}) {
  try {
    const env = options.env || process.env;
    const loaded = loadIndex(indexDir(env));
    if (!loaded || !loaded.meta.items.length) return null;
    const { meta, vec, bias, bm25 } = loaded;
    const dim = meta.dim;
    const nItems = meta.items.length;
    const host = (env && env.OLLAMA_HOST) || DEFAULT_OLLAMA_HOST;
    const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : EMBED_TIMEOUT_MS;
    const qn = await embedQuestion(question, {
      model: meta.model,
      dim,
      host,
      timeoutMs,
      signal: options.signal,
      embed: options.embed,
    });
    if (!qn) return null;

    const bmScores = bm25 ? scoreBM25(question, bm25, nItems) : null;
    const scopes = parseFolders(options.folder);
    const allFiles = Boolean(options.allFiles);
    // Rule cards share (path, n) with the line they cite; keep best score per location.
    const bestByLoc = new Map();
    for (let i = 0; i < nItems; i += 1) {
      const it = meta.items[i];
      if (!it || typeof it.path !== 'string' || !Number.isFinite(it.n) || typeof it.text !== 'string') continue;
      if (!allFiles && isRawData(it.path)) continue;
      if (!inFolders(it.path, scopes)) continue;
      let dot = 0;
      const off = i * dim;
      for (let j = 0; j < dim; j += 1) dot += vec[off + j] * qn[j];
      const score = dot + bias[i] + (bmScores ? BM25_WEIGHT * bmScores[i] : 0);
      const loc = `${it.path}:${it.n}`;
      const prev = bestByLoc.get(loc);
      if (!prev || score > prev.score) {
        bestByLoc.set(loc, { path: it.path, n: it.n, text: it.text, score });
      }
    }

    return [...bestByLoc.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, TOP_K)
      .map(({ path: p, n, text }) => ({ path: p, n, text }));
  } catch {
    return null;
  }
}

function mixHits(serverHits, localHits, { k = RRF_K, top = TOP_K, includeMatch = false } = {}) {
  const sHits = Array.isArray(serverHits) ? serverHits : [];
  if (!Array.isArray(localHits) || !localHits.length) return { hits: sHits, mixed: false };
  const sTop = sHits.slice(0, top);
  const lTop = localHits.slice(0, top);
  const entries = new Map();

  for (let i = 0; i < sTop.length; i += 1) {
    const hit = sTop[i];
    if (!hit) continue;
    const key = `${hit.path}:${hit.n}`;
    if (entries.has(key)) continue;
    entries.set(key, { hit, score: 1 / (k + i + 1), serverRank: i + 1, localRank: Infinity });
  }

  for (let i = 0; i < lTop.length; i += 1) {
    const hit = lTop[i];
    if (!hit) continue;
    const key = `${hit.path}:${hit.n}`;
    const add = 1 / (k + i + 1);
    const existing = entries.get(key);
    if (existing) {
      if (existing.localRank === Infinity) {
        existing.score += add;
        existing.localRank = i + 1;
      }
    } else {
      const localHit = includeMatch
        ? { path: hit.path, n: hit.n, text: hit.text, match: 'meaning', local: true }
        : { path: hit.path, n: hit.n, text: hit.text, local: true };
      entries.set(key, { hit: localHit, score: add, serverRank: Infinity, localRank: i + 1 });
    }
  }

  const limit = Math.max(sHits.length, 10);
  const mixed = [...entries.values()]
    .sort((a, b) => b.score - a.score || a.serverRank - b.serverRank || a.localRank - b.localRank)
    .slice(0, limit)
    .map((entry) => entry.hit);

  if (sHits.length > top && mixed.length < limit) {
    const seen = new Set(mixed.map((h) => `${h.path}:${h.n}`));
    for (let i = top; i < sHits.length && mixed.length < limit; i += 1) {
      const hit = sHits[i];
      const key = `${hit.path}:${hit.n}`;
      if (!seen.has(key)) {
        seen.add(key);
        mixed.push(hit);
      }
    }
  }
  return { hits: mixed, mixed: true };
}

module.exports = { isPlainQuestion, mixHits, rankLocal };
