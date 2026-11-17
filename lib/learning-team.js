'use strict';

// Learning team: find recent public sources on a topic, have one engine
// distill them and write small linked notes into a wiki folder.
//
// Everything here is deterministic except the one engine call in
// distillWithEngine. Gathering, ranking, the prompt, the checks on what the
// engine returns and the files written are plain functions so tests can pin
// them without the network or a model.

const fs = require('fs');
const https = require('https');
const path = require('path');
const { spawnSync } = require('child_process');

const DEFAULT_DAYS = 30;
const DEFAULT_PER_SOURCE = 4;
const MAX_SOURCES = 8;
const MIN_NOTES = 3;
const MAX_NOTES = 5;
const SUMMARY_CHARS = 600;
const FETCH_MAX_BYTES = 2 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 20000;
const DAY_MS = 24 * 60 * 60 * 1000;
const LEARNING_HEADING = '## Learning';
const STOP_WORDS = new Set('the and for with from into about what how why are was new latest recent best'.split(' '));
const PAID_KEY_NAMES = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'XAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY'];

function topicSlug(topic) {
  return String(topic || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}

function topicWords(topic) {
  const words = String(topic || '').toLowerCase().match(/[a-z0-9]+/g) || [];
  return [...new Set(words.filter((word) => word.length >= 3 && !STOP_WORDS.has(word)))];
}

function isoDay(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toISOString().slice(0, 10);
}

// The owner's calendar day, like the rest of the wiki. A UTC day files an
// evening run under tomorrow anywhere west of Greenwich.
function localDay(now = new Date()) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function decodeEntities(text) {
  return String(text || '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'").replace(/&#x2F;/g, '/').replace(/&amp;/g, '&');
}

function cleanText(text, max = SUMMARY_CHARS) {
  const flat = decodeEntities(String(text || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 3).trim()}...` : flat;
}

// Prose rules every shipped sentence follows: no long dashes and no comma
// right before a joining word. The engine is told this too; this is the net.
function plainProse(text) {
  return String(text || '')
    .replace(/\s*[\u2014\u2013]\s*/g, ', ')
    .replace(/,\s+(and|but|so|then|because|which|when)\b/gi, ' $1')
    .replace(/\s+,/g, ',')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

// ---------- parsers for each source ----------

function parseArxivAtom(xml) {
  const items = [];
  for (const match of String(xml || '').matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const entry = match[1];
    const pick = (tag) => { const m = entry.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`)); return m ? m[1] : ''; };
    const url = cleanText(pick('id'), 300).replace(/^http:/, 'https:');
    if (!/^https:\/\/arxiv\.org\/abs\//.test(url)) continue;
    items.push({
      kind: 'paper',
      title: cleanText(pick('title'), 200),
      url,
      date: isoDay(cleanText(pick('published'), 40)),
      summary: cleanText(pick('summary')),
      popularity: 0,
    });
  }
  return items;
}

function parseNewsHits(json) {
  const hits = json && Array.isArray(json.hits) ? json.hits : [];
  return hits.filter((hit) => hit && hit.title).map((hit) => ({
    kind: 'post',
    title: cleanText(hit.title, 200),
    url: hit.url || `https://news.ycombinator.com/item?id=${hit.objectID}`,
    discussion: `https://news.ycombinator.com/item?id=${hit.objectID}`,
    date: isoDay(hit.created_at || (hit.created_at_i ? hit.created_at_i * 1000 : '')),
    summary: cleanText(hit.story_text || ''),
    popularity: Number(hit.points || 0),
  }));
}

function parseGithubRepos(json) {
  const repos = json && Array.isArray(json.items) ? json.items : [];
  return repos.filter((repo) => repo && repo.html_url).map((repo) => ({
    kind: 'repo',
    title: cleanText(repo.full_name, 200),
    url: repo.html_url,
    date: isoDay(repo.created_at),
    summary: cleanText([repo.description || '', (repo.topics || []).length ? `topics: ${(repo.topics || []).join(', ')}` : ''].filter(Boolean).join('. ')),
    popularity: Number(repo.stargazers_count || 0),
  }));
}

function parseVideoRows(rows) {
  return (rows || []).map((row) => {
    const d = String(row.upload_date || '');
    return {
      kind: 'video',
      title: cleanText(row.title, 200),
      url: row.url,
      date: /^\d{8}$/.test(d) ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : '',
      summary: cleanText(`Video by ${row.channel || 'unknown channel'}. Only the title is read here; run atris youtube notes on the link for the content.`),
      popularity: Number(String(row.views || '').replace(/\D/g, '')) || 0,
    };
  });
}

// ---------- fetching ----------

function sourceUrls(topic, { days = DEFAULT_DAYS, perSource = DEFAULT_PER_SOURCE, now = new Date() } = {}) {
  const words = topicWords(topic);
  const since = new Date(now.getTime() - days * DAY_MS);
  const repoSince = isoDay(new Date(now.getTime() - Math.max(days * 3, 60) * DAY_MS));
  const arxivQuery = (words.length ? words : [topicSlug(topic)]).map((word) => `all:${encodeURIComponent(word)}`).join('+AND+');
  return {
    paper: `https://export.arxiv.org/api/query?search_query=${arxivQuery}&sortBy=submittedDate&sortOrder=descending&max_results=${perSource * 3}`,
    post: `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(topic)}&tags=story&numericFilters=created_at_i>${Math.floor(since.getTime() / 1000)}&hitsPerPage=${perSource * 3}`,
    repo: `https://api.github.com/search/repositories?q=${encodeURIComponent(`${words.join(' ')} in:name,description,topics created:>${repoSince}`)}&sort=stars&order=desc&per_page=${perSource * 3}`,
  };
}

function fetchText(url, { timeoutMs = FETCH_TIMEOUT_MS, redirects = 0 } = {}) {
  return new Promise((resolve) => {
    const req = https.get(url, {
      timeout: timeoutMs,
      headers: { 'User-Agent': 'atris-learning-team', Accept: 'application/json, application/atom+xml;q=0.9, */*;q=0.5' },
    }, (res) => {
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location && redirects < 3) {
        res.resume();
        resolve(fetchText(new URL(res.headers.location, url).toString(), { timeoutMs, redirects: redirects + 1 }));
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        resolve({ ok: false, status: res.statusCode, text: '' });
        return;
      }
      const chunks = [];
      let total = 0;
      res.on('data', (chunk) => {
        total += chunk.length;
        if (total > FETCH_MAX_BYTES) { req.destroy(); return; }
        chunks.push(chunk);
      });
      res.on('end', () => resolve({ ok: true, status: 200, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (error) => resolve({ ok: false, status: 0, text: '', error: error.message }));
  });
}

function defaultVideoSearch(topic, limit) {
  const youtube = require('./youtube-core');
  const result = youtube.defaultSearchRunner(topic, limit, { spawnSync });
  if (result.status !== 0) return { ok: false, rows: [], error: String(result.stderr || result.error || 'search failed').trim().slice(0, 200) };
  return { ok: true, rows: youtube.parseSearchStdout(result.stdout) };
}

async function gatherSources(topic, options = {}, deps = {}) {
  const fetcher = deps.fetchText || fetchText;
  const videoSearch = deps.videoSearch || defaultVideoSearch;
  const perSource = options.perSource || DEFAULT_PER_SOURCE;
  const urls = sourceUrls(topic, options);
  const misses = [];
  const parsers = {
    paper: (text) => parseArxivAtom(text),
    post: (text) => parseNewsHits(JSON.parse(text)),
    repo: (text) => parseGithubRepos(JSON.parse(text)),
  };
  const lists = await Promise.all(Object.entries(urls).map(async ([kind, url]) => {
    const res = await fetcher(url);
    if (!res || !res.ok) { misses.push({ kind, reason: res && res.status ? `answered ${res.status}` : (res && res.error) || 'no answer' }); return []; }
    try { return parsers[kind](res.text); } catch { misses.push({ kind, reason: 'answer was not readable' }); return []; }
  }));
  let videos = [];
  if (options.video !== false) {
    const found = await Promise.resolve(videoSearch(`${topic} ${new Date(options.now || Date.now()).getUTCFullYear()}`, perSource));
    if (found && found.ok) videos = parseVideoRows(found.rows);
    else misses.push({ kind: 'video', reason: (found && found.error) || 'search failed' });
    if (videos.length && videos.every((v) => !v.date)) {
      misses.push({ kind: 'video', reason: 'search gave no upload dates and freshness could not be checked; videos skipped' });
    }
  }
  return { items: [...lists.flat(), ...videos], misses, urls };
}

// ---------- ranking ----------

function scoreSource(item, words, { days = DEFAULT_DAYS, now = new Date() } = {}) {
  const text = `${item.title} ${item.summary}`.toLowerCase();
  const hits = words.filter((word) => text.includes(word)).length;
  const relevance = words.length ? hits / words.length : 0;
  const ageDays = item.date ? (now.getTime() - new Date(`${item.date}T00:00:00Z`).getTime()) / DAY_MS : Infinity;
  const recency = Number.isFinite(ageDays) ? Math.max(0, 1 - ageDays / Math.max(days, 1)) : 0;
  const popularity = Math.min(1, Math.log10(1 + (item.popularity || 0)) / 4);
  return Math.round((relevance * 5 + recency * 3 + popularity * 2) * 100) / 100;
}

// Keeps sources that match the topic and fall inside the window. Then it takes
// the best of each kind in turn so one busy source cannot fill every slot.
function rankSources(items, topic, { days = DEFAULT_DAYS, now = new Date(), max = MAX_SOURCES } = {}) {
  const words = topicWords(topic);
  const seen = new Set();
  const oldest = now.getTime() - Math.max(days * 3, 60) * DAY_MS;
  const kept = [];
  for (const item of items || []) {
    if (!item || !item.title || !/^https:\/\//.test(item.url || '')) continue;
    const key = item.url.toLowerCase();
    const titleKey = item.title.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (seen.has(key) || seen.has(titleKey)) continue;
    if (!item.date) continue;
    const when = new Date(`${item.date}T00:00:00Z`).getTime();
    if (item.kind === 'repo' ? when < oldest : when < now.getTime() - days * DAY_MS) continue;
    const text = `${item.title} ${item.summary}`.toLowerCase();
    if (words.length && !words.some((word) => text.includes(word))) continue;
    seen.add(key);
    seen.add(titleKey);
    kept.push({ ...item, score: scoreSource(item, words, { days, now }) });
  }
  const byKind = new Map();
  for (const item of kept.sort((a, b) => b.score - a.score || a.url.localeCompare(b.url))) {
    if (!byKind.has(item.kind)) byKind.set(item.kind, []);
    byKind.get(item.kind).push(item);
  }
  const picked = [];
  while (picked.length < max && [...byKind.values()].some((list) => list.length)) {
    for (const list of byKind.values()) {
      if (list.length && picked.length < max) picked.push(list.shift());
    }
  }
  return picked.map((item, index) => ({ id: `S${index + 1}`, ...item }));
}

// ---------- the engine step ----------

function buildDistillPrompt(topic, sources, { minNotes = MIN_NOTES, maxNotes = MAX_NOTES } = {}) {
  const blocks = sources.map((s) => [
    `[${s.id}] ${s.kind}, ${s.date}: ${s.title}`,
    `url: ${s.url}`,
    s.summary ? `text: ${s.summary}` : 'text: (title only)',
  ].join('\n')).join('\n\n');
  return [
    `You are the learning team for an owner who runs AI agents. Topic: "${topic}".`,
    `Below are ${sources.length} recent public sources. Use only these. Do not browse and do not use outside memory for facts.`,
    `Write ${minNotes} to ${maxNotes} short notes the owner's agents should work from. One idea per note. Prefer ideas several sources support.`,
    'Each note gives a rule an agent can act on, says when to open the note, backs the rule with what the sources show and gives one concrete example.',
    'Write plain words for a busy reader. No long dashes. Never put a comma right before and, but, so, then, because, which or when.',
    'Never claim more than a source says. If a source is only a title, say less about it.',
    '',
    'Return only JSON, no prose around it, in this shape:',
    '{"notes":[{"slug":"kebab-case-id","title":"Short title","rule":"One sentence rule.","open_when":"you are about to ...","points":["What a source shows (S1)"],"example":"One concrete example.","sources":["S1","S3"],"links":["other-note-slug"]}]}',
    '',
    'sources:',
    blocks,
  ].join('\n');
}

function extractJson(text) {
  const raw = String(text || '');
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : raw;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try { return JSON.parse(body.slice(start, end + 1)); } catch { return null; }
}

function noteSlug(value) {
  return topicSlug(value).slice(0, 48);
}

// Checks what the engine returned against the sources it was given. Unknown
// source ids and links are dropped; a note left with no source is dropped.
function validateNotes(payload, sources, { minNotes = MIN_NOTES, maxNotes = MAX_NOTES } = {}) {
  const problems = [];
  const ids = new Set(sources.map((s) => s.id));
  const raw = payload && Array.isArray(payload.notes) ? payload.notes : null;
  if (!raw) return { ok: false, notes: [], problems: ['engine answer had no notes list'] };
  const notes = [];
  const slugs = new Set();
  for (const [index, note] of raw.entries()) {
    if (!note || typeof note !== 'object') { problems.push(`note ${index + 1} is not an object`); continue; }
    const title = plainProse(note.title);
    const rule = plainProse(note.rule);
    let slug = noteSlug(note.slug || title);
    if (!title || !rule || !slug) { problems.push(`note ${index + 1} is missing a title or rule`); continue; }
    if (slugs.has(slug)) slug = `${slug}-${index + 1}`;
    const cited = [...new Set((Array.isArray(note.sources) ? note.sources : []).map(String).filter((id) => ids.has(id)))];
    if (!cited.length) { problems.push(`note "${title}" cites no source it was given; dropped`); continue; }
    slugs.add(slug);
    notes.push({
      slug,
      title,
      rule: /[.!?]$/.test(rule) ? rule : `${rule}.`,
      openWhen: plainProse(note.open_when || note.openWhen || '').replace(/[.]$/, ''),
      points: (Array.isArray(note.points) ? note.points : []).map(plainProse).filter(Boolean).slice(0, 5),
      example: plainProse(note.example || ''),
      sources: cited,
      links: (Array.isArray(note.links) ? note.links : []).map(noteSlug),
    });
  }
  const kept = notes.slice(0, maxNotes);
  if (notes.length > maxNotes) problems.push(`engine wrote ${notes.length} notes; kept the first ${maxNotes}`);
  const keptSlugs = new Set(kept.map((n) => n.slug));
  kept.forEach((note, index) => {
    note.links = [...new Set(note.links.filter((s) => s !== note.slug && keptSlugs.has(s)))];
    // Every note links to at least one other so no note is an island.
    if (!note.links.length && kept.length > 1) note.links = [kept[(index + 1) % kept.length].slug];
  });
  if (kept.length < minNotes) {
    problems.push(`only ${kept.length} usable notes; need at least ${minNotes}`);
    return { ok: false, notes: kept, problems };
  }
  return { ok: true, notes: kept, problems };
}

function paidKeyFreeEnv(env = process.env) {
  const clean = { ...env };
  for (const name of PAID_KEY_NAMES) delete clean[name];
  return clean;
}

async function distillWithEngine(prompt, { engine = 'claude', model = '', timeoutMs = 300000, root = process.cwd() } = {}) {
  const { buildReadOnlyEngineInvocation, buildAskSpawnEnv, runAskProcess } = require('./engine-ask');
  const invocation = buildReadOnlyEngineInvocation(engine, prompt, model, { timeoutMs });
  // Subscription logins only: paid API keys never reach the engine.
  const env = buildAskSpawnEnv(paidKeyFreeEnv(process.env));
  const result = await runAskProcess(invocation, { cwd: invocation.cwd || root, timeoutMs, env });
  return { ok: Boolean(result && result.ok !== false && String(result.stdout || '').trim()), stdout: String((result && result.stdout) || ''), result };
}

// ---------- rendering ----------

function confidenceFor(note) {
  return Math.min(0.8, 0.5 + 0.1 * note.sources.length).toFixed(1);
}

function sourceLine(source) {
  const extra = source.discussion && source.discussion !== source.url ? ` ([discussion](${source.discussion}))` : '';
  return `- ${source.id}. [${source.title}](${source.url})${extra}, ${source.kind}, ${source.date}`;
}

function renderNote(note, { topic, slug, sources, notes, day }) {
  const byId = new Map(sources.map((s) => [s.id, s]));
  const bySlug = new Map(notes.map((n) => [n.slug, n]));
  const cited = note.sources.map((id) => byId.get(id));
  const lines = [
    '---',
    'type: concept',
    `slug: ${slug}-${note.slug}`,
    `title: ${note.title}`,
    'sources:',
    ...cited.map((s) => `  - ${s.url}`),
    `last_compiled: ${day}`,
    `last_verified: ${day}`,
    `created: ${day}`,
    `updated: ${day}`,
    `confidence: ${confidenceFor(note)}`,
    'dependencies: []',
    `actionability: ${note.rule}`,
    `tags: [learning, ${slug}]`,
    '---',
    `# ${note.title}`,
    '',
    `Back to [${topic}](../../briefs/${slug}.md).`,
    '',
    `**Rule.** ${note.rule}`,
    '',
  ];
  if (note.openWhen) lines.push(`**Open this when** ${note.openWhen}.`, '');
  if (note.points.length) lines.push('## What the sources show', '', ...note.points.map((p) => `- ${p}`), '');
  if (note.example) lines.push('## Example', '', note.example, '');
  if (note.links.length) {
    lines.push('## Related', '');
    for (const link of note.links) {
      const other = bySlug.get(link);
      lines.push(`- [${other.title}](${link}.md): ${other.openWhen ? `open when ${other.openWhen}` : other.rule}`);
    }
    lines.push('');
  }
  lines.push('## Sources', '', ...cited.map(sourceLine), '');
  return lines.join('\n');
}

function renderBrief({ topic, slug, notes, sources, misses = [], earlier = [], day, days }) {
  const cited = new Set(notes.flatMap((n) => n.sources));
  const urls = sources.filter((s) => cited.has(s.id)).map((s) => s.url);
  const lines = [
    '---',
    'type: brief',
    `slug: ${slug}`,
    `title: ${topic}`,
    'sources:',
    ...urls.map((u) => `  - ${u}`),
    `last_compiled: ${day}`,
    `last_verified: ${day}`,
    `created: ${day}`,
    `updated: ${day}`,
    'confidence: 0.6',
    'dependencies: []',
    `actionability: Read before agents work on ${topic}.`,
    `tags: [learning, ${slug}]`,
    '---',
    `# ${topic}`,
    '',
    `Learned on ${day} from ${sources.length} sources from the last ${days} days. Each line gives the rule and says when to open the note behind it.`,
    '',
    '## Notes',
    '',
    ...notes.map((n) => `- ${n.rule} ${n.openWhen ? `Open when ${n.openWhen}: ` : 'Open: '}[${n.title}](../concepts/${slug}/${n.slug}.md)`),
    '',
  ];
  if (earlier.length) {
    lines.push('## Earlier notes', '', ...earlier.map((e) => `- ${e.rule} [${e.title}](../concepts/${slug}/${e.file})`), '');
  }
  lines.push('## Read this run', '', ...sources.map(sourceLine), '');
  if (misses.length) lines.push('## Could not read', '', ...misses.map((m) => `- ${m.kind}: ${m.reason}`), '');
  return lines.join('\n');
}

function indexLine({ topic, slug, notes, day }) {
  return `- ${topic} (${day}): ${notes[0].rule} Open before agents work on ${topic}: [${topic}](briefs/${slug}.md)`;
}

// Adds or replaces this topic's one line under the Learning heading. Other
// lines and sections stay as they were.
function updateIndexText(text, { slug, line }) {
  const base = String(text || '').trim() ? String(text).replace(/\s*$/, '\n') : '# Atris Wiki Index\n\nEach line gives the rule or answer and says when to open the page behind it.\n';
  const marker = `(briefs/${slug}.md)`;
  const lines = base.split('\n');
  const existing = lines.findIndex((l) => l.includes(marker));
  if (existing !== -1) {
    lines[existing] = line;
    return lines.join('\n');
  }
  const heading = lines.findIndex((l) => l.trim() === LEARNING_HEADING);
  if (heading === -1) return `${base.replace(/\n*$/, '\n')}\n${LEARNING_HEADING}\n\n${line}\n`;
  let insertAt = heading + 1;
  while (insertAt < lines.length && !/^#{1,6}\s/.test(lines[insertAt])) insertAt += 1;
  while (insertAt > heading + 1 && lines[insertAt - 1].trim() === '') insertAt -= 1;
  if (insertAt === heading + 1) { lines.splice(insertAt, 0, '', line); } else { lines.splice(insertAt, 0, line); }
  return lines.join('\n');
}

function readEarlierNotes(dir, freshSlugs) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.md') && !freshSlugs.has(f.slice(0, -3))).sort().map((file) => {
    const fm = parseFrontmatterLite(fs.readFileSync(path.join(dir, file), 'utf8'));
    return { file, title: fm.title || file.slice(0, -3), rule: fm.actionability || '' };
  });
}

function parseFrontmatterLite(content) {
  const out = {};
  const m = String(content || '').match(/^---\n([\s\S]*?)\n---/);
  if (!m) return out;
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([a-z_]+):\s*(.+)$/);
    if (kv) out[kv[1]] = kv[2].trim();
  }
  return out;
}

function writeLearning(wikiDir, { topic, notes, sources, misses = [], day, days, time = '00:00' }) {
  const slug = topicSlug(topic);
  const noteDir = path.join(wikiDir, 'concepts', slug);
  fs.mkdirSync(noteDir, { recursive: true });
  fs.mkdirSync(path.join(wikiDir, 'briefs'), { recursive: true });
  const earlier = readEarlierNotes(noteDir, new Set(notes.map((n) => n.slug)));
  const written = [];
  for (const note of notes) {
    const file = path.join(noteDir, `${note.slug}.md`);
    fs.writeFileSync(file, renderNote(note, { topic, slug, sources, notes, day }));
    written.push(file);
  }
  const briefFile = path.join(wikiDir, 'briefs', `${slug}.md`);
  fs.writeFileSync(briefFile, renderBrief({ topic, slug, notes, sources, misses, earlier, day, days }));
  const indexFile = path.join(wikiDir, 'index.md');
  const before = fs.existsSync(indexFile) ? fs.readFileSync(indexFile, 'utf8') : '';
  fs.writeFileSync(indexFile, updateIndexText(before, { slug, line: indexLine({ topic, slug, notes, day }) }));
  const logFile = path.join(wikiDir, 'log.md');
  const logBefore = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '# Wiki Log\n';
  const header = `## ${day}`;
  const entry = `- ${time} LEARN ${topic}: ${notes.length} notes from ${sources.length} sources into concepts/${slug}/`;
  const logAfter = logBefore.includes(header) ? logBefore.replace(header, `${header}\n${entry}`) : `${logBefore.replace(/\s*$/, '\n')}\n${header}\n${entry}\n`;
  fs.writeFileSync(logFile, logAfter);
  return { slug, noteFiles: written, briefFile, indexFile, logFile, earlier: earlier.length };
}

// ---------- command ----------

function parseLearnArgs(argv = []) {
  const opts = { topic: '', into: path.join('atris', 'wiki'), days: DEFAULT_DAYS, perSource: DEFAULT_PER_SOURCE, engine: 'claude', model: '', dryRun: false, json: false, sourcesFile: '', notesFile: '', saveSources: '', video: true };
  const words = [];
  const value = (i, name) => {
    const v = argv[i + 1];
    if (v === undefined || String(v).startsWith('--')) throw new Error(`${name} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--into') { opts.into = value(i, arg); i += 1; }
    else if (arg === '--days') { opts.days = Number(value(i, arg)); i += 1; }
    else if (arg === '--per-source') { opts.perSource = Number(value(i, arg)); i += 1; }
    else if (arg === '--engine') { opts.engine = value(i, arg); i += 1; }
    else if (arg === '--model') { opts.model = value(i, arg); i += 1; }
    else if (arg === '--sources') { opts.sourcesFile = value(i, arg); i += 1; }
    else if (arg === '--notes') { opts.notesFile = value(i, arg); i += 1; }
    else if (arg === '--save-sources') { opts.saveSources = value(i, arg); i += 1; }
    else if (arg === '--no-video') opts.video = false;
    else if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--json') opts.json = true;
    else if (arg.startsWith('--')) throw new Error(`unknown flag ${arg}`);
    else words.push(arg);
  }
  opts.topic = words.join(' ').trim();
  if (!opts.topic) throw new Error('give a topic, like: atris wiki learn "ai agent security"');
  if (!Number.isInteger(opts.days) || opts.days < 1 || opts.days > 365) throw new Error('--days must be a whole number from 1 to 365');
  if (!Number.isInteger(opts.perSource) || opts.perSource < 1 || opts.perSource > 10) throw new Error('--per-source must be a whole number from 1 to 10');
  return opts;
}

function learnUsage() {
  return [
    'Usage: atris wiki learn "<topic>" [--into <wiki folder>] [--days N] [--engine claude] [--dry-run]',
    '',
    'Finds recent papers, posts, repos and videos on a topic, has one engine distill them,',
    'and writes 3 to 5 linked notes plus a brief and an index line into the wiki folder.',
    '',
    `  --into <dir>          wiki folder to write into (default atris/wiki)`,
    `  --days N              how far back to look (default ${DEFAULT_DAYS})`,
    `  --per-source N        results asked from each source (default ${DEFAULT_PER_SOURCE})`,
    '  --engine <name>       engine that writes the notes (default claude, on your own login)',
    '  --model <name>        model for that engine',
    '  --dry-run             gather and rank sources only; write nothing',
    '  --save-sources <file> keep the ranked sources to replay later',
    '  --sources <file>      replay saved sources instead of searching',
    '  --notes <file>        use a saved engine answer instead of asking an engine',
    '  --no-video            skip the video search',
    '  --json                print the result as json',
  ].join('\n');
}

async function runLearn(argv = [], deps = {}) {
  const out = deps.output || console;
  let opts;
  try { opts = parseLearnArgs(argv); } catch (error) {
    out.error(error.message);
    out.error(learnUsage());
    return { ok: false, code: 2, reason: error.message };
  }
  const now = deps.now ? new Date(deps.now) : new Date();
  const day = localDay(now);
  const cwd = deps.cwd || process.cwd();
  const wikiDir = path.resolve(cwd, opts.into);

  let sources;
  let misses = [];
  if (opts.sourcesFile) {
    const saved = JSON.parse(fs.readFileSync(path.resolve(cwd, opts.sourcesFile), 'utf8'));
    sources = saved.sources || [];
    misses = saved.misses || [];
  } else {
    const gathered = await gatherSources(opts.topic, { days: opts.days, perSource: opts.perSource, now, video: opts.video }, deps);
    sources = rankSources(gathered.items, opts.topic, { days: opts.days, now });
    misses = gathered.misses;
  }
  if (opts.saveSources) {
    fs.writeFileSync(path.resolve(cwd, opts.saveSources), `${JSON.stringify({ topic: opts.topic, day, sources, misses }, null, 2)}\n`);
  }
  if (sources.length < 2) {
    out.error(`found ${sources.length} usable recent sources on "${opts.topic}"; need at least 2. Try --days ${Math.min(opts.days * 2, 365)}.`);
    return { ok: false, code: 1, reason: 'too few sources', sources, misses };
  }
  if (opts.dryRun) {
    if (opts.json) out.log(JSON.stringify({ ok: true, dry_run: true, sources, misses }, null, 2));
    else {
      out.log(`${sources.length} sources on "${opts.topic}" from the last ${opts.days} days:`);
      for (const s of sources) out.log(`  ${s.id} ${s.kind} ${s.date} ${s.score}  ${s.title}`);
      for (const m of misses) out.log(`  could not read ${m.kind}: ${m.reason}`);
    }
    return { ok: true, dryRun: true, sources, misses };
  }

  const prompt = buildDistillPrompt(opts.topic, sources);
  let answer;
  if (opts.notesFile) answer = fs.readFileSync(path.resolve(cwd, opts.notesFile), 'utf8');
  else {
    const distill = deps.distill || distillWithEngine;
    const res = await distill(prompt, { engine: opts.engine, model: opts.model, root: cwd });
    if (!res.ok) {
      out.error(`the ${opts.engine} engine gave no answer; nothing was written.`);
      return { ok: false, code: 1, reason: 'engine failed', sources, misses };
    }
    answer = res.stdout;
  }
  const checked = validateNotes(extractJson(answer), sources);
  if (!checked.ok) {
    out.error(`notes did not pass the checks; nothing was written: ${checked.problems.join('; ')}`);
    return { ok: false, code: 1, reason: 'notes failed checks', problems: checked.problems, sources, misses };
  }
  const time = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const written = writeLearning(wikiDir, { topic: opts.topic, notes: checked.notes, sources, misses, day, days: opts.days, time });
  const summary = { ok: true, topic: opts.topic, wiki: wikiDir, notes: checked.notes.length, sources: sources.length, misses, problems: checked.problems, credits: 0, ...written };
  if (opts.json) out.log(JSON.stringify(summary, null, 2));
  else {
    out.log(`wrote ${checked.notes.length} notes on "${opts.topic}" from ${sources.length} sources.`);
    out.log(`brief: ${written.briefFile}`);
    for (const f of written.noteFiles) out.log(`note: ${f}`);
    for (const p of checked.problems) out.log(`fixed: ${p}`);
    for (const m of misses) out.log(`could not read ${m.kind}: ${m.reason}`);
    out.log('cost: 0 credits. The notes were written on your own engine login.');
  }
  return summary;
}

module.exports = {
  topicSlug,
  topicWords,
  localDay,
  plainProse,
  parseArxivAtom,
  parseNewsHits,
  parseGithubRepos,
  parseVideoRows,
  sourceUrls,
  rankSources,
  extractJson,
  validateNotes,
  paidKeyFreeEnv,
  updateIndexText,
  parseLearnArgs,
  learnUsage,
  runLearn,
};
