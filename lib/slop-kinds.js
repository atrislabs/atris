// Kinds for `atris slop detect --kind <kind>`: precise rules for customer copy,
// first emails and screens. Each rule is data: id, kind, level, a pattern or a
// checker name, why, and said (the owner's words it comes from). No model calls.
//
// customer-copy  words a customer reads
// email          customer-copy plus the shape of a first email
// screen         html, tsx, jsx, css and composition json

const fs = require('fs');
const os = require('os');
const path = require('path');

const KINDS = ['customer-copy', 'email', 'screen'];

// A kind also runs the rules of the kinds it builds on.
const INCLUDES = { 'customer-copy': ['customer-copy'], email: ['customer-copy', 'email'], screen: ['screen'] };

const KIND_EXTS = {
  'customer-copy': new Set(['.md', '.mdx', '.txt', '.html', '.htm', '.eml']),
  email: new Set(['.md', '.txt', '.eml']),
  screen: new Set(['.html', '.htm', '.tsx', '.jsx', '.css', '.json', '.vue', '.svelte']),
};

const SAID = {
  words: 'Never say AI, agent or automate in anything a customer reads. Keep them out except the phrase "AI tools you already have" (rulebook)',
  voice: 'Write in a direct voice: no em dashes, no "not X but Y" patterns, no stacked questions, no commas before "and" or "but" (rulebook)',
  hype: 'Cut vague fluff and claims about unshipped features from pages and launch drafts (rulebook)',
  caps: 'no all-caps (design taste)',
  claims: 'Use concrete claims, not "every hole" or "fix them all" (rulebook)',
  hey: 'Start every outreach email or note "Hey name,"; keep it short with no sign-off (rulebook)',
  greeting: 'In the first email, skip any greeting paragraph, credentials, and calendar link (rulebook)',
  smallYes: 'one small yes (one-line question, no call, meeting or scheduling) (rulebook)',
  notUs: 'Open cold emails with one true, specific fact about the owner\'s business; never I, we, my name or my company (rulebook)',
  oneQuestion: 'ask one tiny, free yes, answerable in ten seconds (rulebook)',
  short: 'The goal is first email, just get a reply (2026-11-25); 75 words from the coordinator brief (2026-11-25)',
  subject: 'Write cold subject lines under six words, with no exclamation marks, all caps, or words like free or offer (rulebook)',
  subtitle: 'no subtitle text. no explanatory text (2026-11-25); No subtitle text, ever (atris-design COPY.md, 2026-08-17)',
  explain: 'no explanatory text (2026-11-25); no placeholder explanation copy in designs (2026-11-11)',
  bars: 'never use decorative left-edge highlight bars on cards or calendar items (rulebook)',
  tokens: 'save components to prevent average design tendencies (2026-11-25)',
};

const ALLOWED_AI_PHRASE = /\bAI tools you already (?:have|use)\b/gi;
const CAPS_OK = new Set(['CEO', 'CTO', 'COO', 'CFO', 'USA', 'NYC', 'FAQ', 'PDF', 'API', 'URL', 'SEO', 'CRM', 'HVAC', 'LLC', 'SAT',
  'ACT', 'HTML', 'CSS', 'SQL', 'JSON', 'ETA', 'EST', 'PST', 'PDT', 'EDT', 'UTC', 'GDPR', 'SOC', 'HIPAA', 'IRS', 'DMV', 'ESL', 'STEM',
  'MBA', 'CPA', 'ADU', 'HOA', 'SMS', 'DNA', 'GPS', 'ROI', 'KPI', 'MRR', 'ARR', 'SSO', 'CLI', 'NBA', 'NFL', 'UCLA', 'USC', 'MIT',
  'HTTP', 'HTTPS', 'JWT', 'XSS', 'CSRF', 'SSRF', 'IDOR', 'OWASP', 'NASA', 'RSVP', 'ASAP', 'YAML', 'TOML', 'UUID', 'FAFSA', 'NASDAQ',
  'NYSE', 'JPEG', 'COVID', 'FDIC', 'NCUA', 'UNESCO', 'NATO', 'BCBS', 'AARP', 'NAACP', 'OSHA', 'FEMA', 'NOAA', 'ISBN', 'UNICEF', 'WIFI',
  'IEEE', 'USDA', 'USPS', 'UCSF', 'NYU', 'ACLU', 'HTML5', 'AWS', 'IBM', 'SAAS', 'ACH', 'ATM', 'EBITDA', 'GAAP', 'IPO', 'REST', 'GRPC', 'OAUTH',
  'HDMI', 'USB', 'WCAG', 'ESPN', 'FIFA', 'UEFA', 'NCAA', 'WNBA', 'NASCAR', 'IKEA', 'LEGO', 'RFID', 'ISO', 'CPU', 'GPU', 'RAM', 'SSD', 'CSV',
  'VPN', 'SKU', 'OLED', 'QLED', 'HDTV', 'MPEG', 'ASCII', 'UTF8', 'MSRP', 'FICO', 'ADHD', 'PTSD', 'HIV', 'AIDS', 'OSHA', 'GMAT', 'LSAT',
  'MCAT', 'TOEFL', 'IELTS', 'LGBT', 'LGBTQ', 'NHTSA', 'OPEC', 'IATA', 'AMEX', 'VISA', 'NIST', 'ANSI', 'IETF', 'ICANN', 'CMYK', 'PCIE',
  'POST', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'TRACE', 'CONNECT', 'UNIX', 'POSIX', 'COBRA', 'ESPP', 'FICA', 'FSA', 'HSA', 'USAA',
  'GEICO', 'YIMBY', 'NIMBY', 'HELOC', 'EMEA', 'APAC', 'LATAM', 'CRISPR', 'MRNA', 'NAFTA', 'BIPOC', 'DACA', 'OPEB', 'ERISA', 'HUD', 'FAANG']);

// Placeholder copy, read by the page rules (lib/page-rules/shared.js), where a name or a phrase
// here is a guess that leaves a note. screen-explanatory below keeps its own narrower list.
const PLACEHOLDER_RE = /\blorem ipsum dolor\b|\bdolor sit amet\b|\bconsectetur adipiscing\b|\b(?:description|heading|headline|title|subtitle|text|caption|content|copy|tagline|name|image) goes here\b|\b(?:your|some(?: helpful)?|insert(?: your)?) (?:text|title|heading|headline|copy|content|description|tagline|caption) here\b|\b(?:John|Jane) Doe\b/i;

// atris site check owns html pages. On one, the screen kind hands the page to it
// (lib/page-lang.js checkText) and skips these per-line rules, which it replaces.
const PAGE_REPLACES = new Set(['screen-subtitle', 'screen-explanatory', 'screen-all-caps', 'screen-left-bar']);

function lazyHype() {
  // Reuse the existing hype rule; required lazily because commands/slop.js requires this file.
  return require('../commands/slop').RULES.find((r) => r.id === 'hype-copy').re;
}

// Built-in kind rules. `re` rules run per line; `check` rules get the whole document.
const KIND_RULES = [
  { id: 'cc-banned-words', kind: 'customer-copy', level: 'error', check: 'bannedWords',
    why: 'says AI, agent or automate; only "AI tools you already have/use" may stay', said: SAID.words },
  { id: 'cc-em-dash', kind: 'customer-copy', level: 'error', re: /—/,
    why: 'em dash: use a period or a comma', said: SAID.voice },
  { id: 'cc-not-x-but-y', kind: 'customer-copy', level: 'error',
    re: /\bnot\s+(?:just\s+|only\s+|merely\s+|simply\s+)?[^.,;!?\n]{1,40}?,?\s+but\b|\b(?:it'?s|it is|this is|that'?s|that is)\s+not\b[^.!?\n]{1,60}[.;,]\s*(?:it'?s|it is|this is|that'?s)\b/i,
    why: '"not X but Y": say the one thing', said: SAID.voice },
  { id: 'cc-comma-and-but', kind: 'customer-copy', level: 'error', re: /,\s+(?:and|but)\b/i,
    why: 'comma before "and" or "but": drop the comma', said: SAID.voice },
  { id: 'cc-stacked-questions', kind: 'customer-copy', level: 'error', check: 'stackedQuestions',
    why: 'two questions in a row: ask one', said: SAID.voice },
  { id: 'cc-hype', kind: 'customer-copy', level: 'error', check: 'hype',
    why: 'hype phrase: say the specific thing instead', said: SAID.hype },
  { id: 'cc-all-caps', kind: 'customer-copy', level: 'error', check: 'allCaps',
    why: 'an all-caps word reads as shouting', said: SAID.caps },
  { id: 'cc-overclaim', kind: 'customer-copy', level: 'error', re: /\b(?:every hole|fix(?:es)? them all)\b/i,
    why: 'claims more than was found: name what was found and fixed', said: SAID.claims },

  { id: 'email-hey-name', kind: 'email', level: 'error', check: 'heyName',
    why: 'the body starts "Hey <Name>,"', said: SAID.hey },
  { id: 'email-sign-off', kind: 'email', level: 'error', check: 'signOff',
    why: 'sign-off line at the end: stop at the question', said: SAID.hey },
  { id: 'email-greeting-paragraph', kind: 'email', level: 'error',
    re: /\b(?:hope (?:you'?re|you are|this finds you|all is)|my name is|i'?m reaching out|i am reaching out|i wanted to reach out|just reaching out|allow me to introduce)\b/i,
    why: 'greeting paragraph: open with their fact instead', said: SAID.greeting },
  { id: 'email-asks-for-call', kind: 'email', level: 'error',
    re: /\b(?:(?:a|quick|short|phone|intro|discovery|brief) call|call (?:this|next) week|meeting|meet up|calendar|calendly|zoom|15[- ]?min(?:ute)?s?|hop on|jump on|book a (?:time|slot)|schedule (?:a|some) time|grab coffee)\b/i,
    why: 'asks for a call or meeting: ask a yes they can give standing up', said: SAID.smallYes },
  { id: 'email-opens-on-us', kind: 'email', level: 'error', check: 'opensOnUs',
    why: 'the first sentence after the greeting is about us: open with their fact', said: SAID.notUs },
  { id: 'email-one-question', kind: 'email', level: 'error', check: 'oneQuestion',
    why: 'the body needs exactly one question mark', said: SAID.oneQuestion },
  { id: 'email-length', kind: 'email', level: 'error', check: 'length',
    why: 'the body runs past 75 words', said: SAID.short },
  { id: 'email-subject', kind: 'email', level: 'error', check: 'subject',
    why: 'subject: under six words, no "!", no all caps, no free, offer or quick question', said: SAID.subject },

  { id: 'screen-subtitle', kind: 'screen', level: 'error', check: 'subtitle',
    why: 'subtitle text under a title: the title alone carries it', said: SAID.subtitle },
  { id: 'screen-explanatory', kind: 'screen', level: 'error',
    re: /(?:[>"'`]\s*)(?:This page\b|Here you can\b|Use this (?:to|page)\b|Welcome to\b)|\blorem ipsum\b|\b(?:placeholder text|description goes here|add (?:a|your) description(?: here)?|some (?:helpful )?text here)\b/i,
    why: 'explanatory or placeholder copy on a screen: the screen explains itself', said: SAID.explain },
  { id: 'screen-all-caps', kind: 'screen', level: 'error',
    re: /text-transform:\s*uppercase\b|textTransform:\s*['"]uppercase['"]|class(?:Name)?=\s*[{"'`][^>]*?\buppercase\b/i,
    why: 'all-caps styling: use sentence case', said: SAID.caps },
  { id: 'screen-left-bar', kind: 'screen', level: 'error', check: 'leftBar',
    why: 'decorative left-edge bar on a card', said: SAID.bars },
  { id: 'screen-raw-colour', kind: 'screen', level: 'warn', check: 'rawColour',
    why: 'raw colour where an atris token exists: use the token', said: SAID.tokens },
  { id: 'screen-components', kind: 'screen', level: 'warn', check: 'components',
    why: 'hand-rolled controls where saved catalog components exist', said: SAID.tokens },
];

// --- shared text helpers ------------------------------------------------------

function fencedLines(lines) {
  let inside = false;
  return lines.map((line) => {
    if (line.trimStart().startsWith('```')) { inside = !inside; return true; }
    return inside;
  });
}

// Email split: an optional "Subject: ..." first line, then the body.
function parseEmail(text, subjectFlag) {
  const lines = text.split('\n');
  let subject = null, subjectLine = 0, start = 0;
  const m = (lines[0] || '').match(/^subject:\s*(.*)$/i);
  if (m) { subject = m[1].trim(); subjectLine = 1; start = 1; }
  if (subjectFlag != null) { subject = String(subjectFlag).trim(); if (!m) subjectLine = 0; }
  const body = [];
  for (let i = start; i < lines.length; i++) body.push({ n: i + 1, text: lines[i] });
  return { subject, subjectLine, body };
}

function sentencesWithLines(body) {
  // Sentences across the body, each tagged with the line it ends on.
  const out = [];
  let buf = '', from = null;
  for (const { n, text } of body) {
    const parts = text.split(/(?<=[.!?])\s+/);
    for (const part of parts) {
      if (!part.trim()) continue;
      if (from == null) from = n;
      buf += (buf ? ' ' : '') + part.trim();
      if (/[.!?]["')\]]*$/.test(part.trim())) { out.push({ text: buf, line: n, from }); buf = ''; from = null; }
    }
    if (!text.trim() && buf) { out.push({ text: buf, line: n - 1, from }); buf = ''; from = null; }
  }
  if (buf) out.push({ text: buf, line: body.length ? body[body.length - 1].n : 1, from });
  return out;
}

function capsWords(text) {
  return (text.match(/\b[A-Z][A-Z]{2,}\b/g) || []).filter((w) => !CAPS_OK.has(w) && w !== 'AI');
}

// --- design library (catalog for the component report, tokens for colours) ----

function designDir() {
  const candidates = [process.env.ATRIS_DESIGN_DIR, path.join(os.homedir(), 'arena', 'atris-design')].filter(Boolean);
  return candidates.find((dir) => fs.existsSync(path.join(dir, 'components', 'catalog.json'))) || null;
}

let catalogCache;
function loadCatalog() {
  if (catalogCache !== undefined) return catalogCache;
  catalogCache = null;
  const dir = designDir();
  if (!dir) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, 'components', 'catalog.json'), 'utf8'));
    const components = raw.components || [];
    const hasTokens = fs.existsSync(path.join(dir, 'tokens', 'atris-tokens.css')) || fs.existsSync(path.join(dir, 'tokens', 'atris-tokens.json'));
    catalogCache = { dir, components, hasTokens };
  } catch { catalogCache = null; }
  return catalogCache;
}

// Which catalog components replace a hand-rolled control, by id, kept only if present.
const REPLACES = {
  button: ['selection-actions', 'approval-checkpoint', 'recommendation'],
  input: ['prompt-composer', 'command-search'],
  card: ['insight-card', 'context-cards'],
};

function componentReport(text, catalog) {
  const used = new Set();
  for (const c of catalog.components) {
    const names = [c.react && `<${c.react}\\b`, c.web && `<${c.web}\\b`, `"componentID"\\s*:\\s*"${c.id}"`].filter(Boolean);
    if (names.some((n) => new RegExp(n).test(text))) used.add(c.id);
  }
  const raw = {
    button: (text.match(/<button\b/gi) || []).length,
    input: (text.match(/<(?:input|textarea|select)\b/gi) || []).length,
    card: (text.match(/<div\b[^>]*class(?:Name)?=\s*[{"'`][^>]*\bcard\b/gi) || []).length,
  };
  const names = (ids) => ids.map((id) => catalog.components.find((c) => c.id === id)).filter(Boolean).map((c) => c.react || c.id);
  const replace = {};
  for (const kind of Object.keys(raw)) if (raw[kind]) replace[kind] = names(REPLACES[kind]);
  return { used: [...used], raw, replace, hand_rolled: raw.button + raw.input + raw.card };
}

// --- checkers -----------------------------------------------------------------

const CHECKERS = {
  bannedWords(doc, rule, add) {
    doc.lines.forEach((line, i) => {
      if (doc.skip[i]) return;
      const clean = line.replace(ALLOWED_AI_PHRASE, '');
      // "AI" only in capitals (so "ai" inside other text never trips it); the rest in any case.
      const m = clean.match(/\bAI\b|\bA\.I\./) || clean.match(/\bagent(?:s|ic)?\b|\bautomat(?:e|ed|es|ing|ion)\b/i);
      if (m) add(rule, i + 1, m[0]);
    });
  },
  hype(doc, rule, add) {
    const re = lazyHype();
    doc.lines.forEach((line, i) => { if (!doc.skip[i]) { const m = line.match(re); if (m) add(rule, i + 1, m[0]); } });
  },
  allCaps(doc, rule, add) {
    doc.lines.forEach((line, i) => {
      if (doc.skip[i]) return;
      const words = capsWords(line.replace(/^subject:\s*/i, ''));
      if (words.length) add(rule, i + 1, words[0]);
    });
  },
  stackedQuestions(doc, rule, add) {
    const sentences = sentencesWithLines(doc.lines.map((text, i) => ({ n: i + 1, text: doc.skip[i] ? '' : text })));
    for (let i = 1; i < sentences.length; i++) {
      if (sentences[i - 1].text.endsWith('?') && sentences[i].text.endsWith('?')) { add(rule, sentences[i].line, sentences[i].text.slice(0, 60)); return; }
    }
  },
  heyName(doc, rule, add) {
    const first = doc.email.body.find((b) => b.text.trim());
    if (!first) return add(rule, 1, '(empty body)');
    if (!/^Hey [A-Z][\w'’.-]*(?: [A-Z][\w'’.-]*)?,/.test(first.text.trim())) add(rule, first.n, first.text.trim().slice(0, 40));
  },
  signOff(doc, rule, add) {
    const rest = doc.email.body.filter((b) => b.text.trim());
    if (rest.length < 2) return;
    const last = rest[rest.length - 1];
    const t = last.text.trim().replace(/^[-–—]\s*/, '');
    const words = /^(?:best|thanks|thank you|thanks again|many thanks|cheers|regards|kind regards|best regards|warm regards|warmly|sincerely|talk soon|all the best|take care)\b[\s,.!]*(?:[A-Z][a-z]+)?[.!]?$/i;
    const bareName = /^[A-Z][a-z'’-]+(?: [A-Z][a-z'’-]+)?[.!]?$/;
    if (words.test(t) || bareName.test(t)) add(rule, last.n, t);
  },
  opensOnUs(doc, rule, add) {
    const body = doc.email.body;
    const firstIdx = body.findIndex((b) => b.text.trim());
    if (firstIdx < 0) return;
    const rest = body.slice(firstIdx).map((b, k) => (k === 0 ? { ...b, text: b.text.replace(/^\s*(?:Hey|Hi|Hello|Dear)\b[^,\n]{0,40},\s*/i, '') } : b));
    const first = sentencesWithLines(rest).find((s) => s.text.trim());
    if (!first) return;
    const m = first.text.match(/\b(?:I|I'm|I’m|I've|I'd|I'll)\b/) || first.text.match(/\b(?:we|we're|we’re|we've|we'd|we'll|my|our|ours)\b/i);
    if (m) add(rule, first.from || first.line, m[0]);
  },
  oneQuestion(doc, rule, add) {
    const body = doc.email.body;
    const count = body.reduce((n, b) => n + (b.text.match(/\?/g) || []).length, 0);
    if (count === 1) return;
    const where = count ? body.filter((b) => b.text.includes('?')).slice(-1)[0].n : (body.length ? body[body.length - 1].n : 1);
    add(rule, where, `${count} question marks`);
  },
  length(doc, rule, add) {
    const words = doc.email.body.map((b) => b.text).join(' ').split(/\s+/).filter((w) => /[\w$]/.test(w));
    if (words.length > 75) add(rule, doc.email.body[0] ? doc.email.body[0].n : 1, `${words.length} words`);
  },
  subject(doc, rule, add) {
    const { subject, subjectLine } = doc.email;
    if (!subject) return add(rule, 1, 'no subject (start with "Subject: ..." or pass --subject)');
    const problems = [];
    const words = subject.split(/\s+/).filter(Boolean);
    if (words.length >= 6) problems.push(`${words.length} words`);
    if (subject.includes('!')) problems.push('"!"');
    const caps = capsWords(subject);
    if (caps.length) problems.push(`all caps "${caps[0]}"`);
    const banned = subject.match(/\b(?:free|offer|quick question)\b/i);
    if (banned) problems.push(`"${banned[0]}"`);
    if (problems.length) add(rule, subjectLine || 1, `${subject} (${problems.join(', ')})`);
  },
  subtitle(doc, rule, add) {
    const names = 'subtitle|subTitle|sub_title|subheading|subHeading|sub_heading|description|helperText|helper_text|helper|caption|tagline|eyebrow|kicker';
    const prop = new RegExp(`(?:^|[\\s{,("'])["']?(${names})["']?\\s*[=:]\\s*\\{?\\s*(["'\`])([^"'\`]*)\\2`);
    const lines = doc.lines;
    // Page metadata and structured data (metadata, generateMetadata, openGraph, "@type") feed
    // search results and link previews, not the screen.
    const meta = new Set();
    lines.forEach((line, i) => {
      if (!/\b(?:const|let|var)\s+metadata\b|\bfunction\s+generateMetadata\b|\bopenGraph\s*:|\btwitter\s*:|['"]@type['"]/.test(line)) return;
      let depth = 0, opened = false;
      for (let j = i; j < lines.length; j++) {
        meta.add(j);
        for (const ch of lines[j]) { if (ch === '{') { depth++; opened = true; } else if (ch === '}') depth--; }
        if (opened && depth <= 0) break;
      }
    });
    lines.forEach((line, i) => {
      const m = line.match(prop);
      if (m && !meta.has(i) && /[A-Za-z]{2,}/.test(m[3]) && m[3].trim().split(/\s+/).length >= 2 && !/<meta\b/.test(line)) {
        add(rule, i + 1, `${m[1]}: ${m[3].slice(0, 40)}`);
        return;
      }
      if (/<h[1-6]\b|<(?:Heading|Title|CardTitle)\b/.test(line)) {
        const after = [line.split(/<\/h[1-6]>|<\/(?:Heading|Title|CardTitle)>/)[1] || '', ...lines.slice(i + 1, i + 4)].join('\n');
        const muted = /<p\b[^>]*(?:muted|secondary|subtle|text-(?:gray|slate|zinc|neutral|stone)-[3-6]00|opacity-[3-7]0|fg-2|fg-3)[^>]*>\s*[^<\s]/;
        if (muted.test(after)) add(rule, i + 1, 'heading followed by a muted paragraph');
      }
    });
  },
  leftBar(doc, rule, add) {
    let selector = '';
    doc.lines.forEach((line, i) => {
      const open = line.match(/^\s*([^{}]+)\{\s*$/);
      if (open) selector = open[1];
      if (/^\s*\}/.test(line)) selector = '';
      const cls = line.match(/\bborder-l-(?:[2-9]|\[\d+px\])\b/);
      if (cls && /\b(?:rounded|card|shadow|bg-|p-\d|px-\d|py-\d)/.test(line)) return add(rule, i + 1, cls[0]);
      const css = line.match(/border-left:\s*[2-9]px\s+solid|borderLeft:\s*['"][2-9]px\s+solid/i);
      if (css && (/card|tile|panel|item|callout|event|note|box/i.test(selector) || /card|rounded|borderRadius|padding/i.test(line))) add(rule, i + 1, css[0]);
    });
  },
  rawColour(doc, rule, add) {
    const catalog = loadCatalog();
    if (!catalog || !catalog.hasTokens) return;
    doc.lines.forEach((line, i) => {
      if (/^\s*--[\w-]+\s*:/.test(line)) return; // a token definition itself
      const m = line.match(/#[0-9a-fA-F]{3,8}\b|\brgba?\(/);
      if (m) add(rule, i + 1, m[0]);
    });
  },
  components(doc, rule, add, ctx) {
    const catalog = loadCatalog();
    if (!catalog) return;
    const report = componentReport(doc.text, catalog);
    ctx.components = report;
    if (!report.hand_rolled) return;
    const parts = Object.entries(report.raw).filter(([, n]) => n).map(([k, n]) => `${k} ${n}`).join(', ');
    const swaps = Object.entries(report.replace).map(([k, list]) => `${k}: ${list.join(' or ')}`).join('; ');
    add(rule, 1, `${report.used.length} catalog component${report.used.length === 1 ? '' : 's'}, ${report.hand_rolled} hand-rolled (${parts}); use ${swaps}`);
  },
};

// --- project rules with a kind --------------------------------------------------

function projectKindRules(root, kind) {
  const file = path.join(root, '.atris', 'slop.rules.json');
  let arr = [];
  try { const raw = JSON.parse(fs.readFileSync(file, 'utf8')); arr = Array.isArray(raw) ? raw : (raw.rules || []); } catch { return []; }
  const kinds = INCLUDES[kind] || [kind];
  return arr.map((r) => {
    if (!r || !r.id || !r.pattern || !r.kind || !kinds.includes(r.kind)) return null;
    let re; try { re = new RegExp(r.pattern, r.flags || 'i'); } catch { return null; }
    return { id: r.id, kind: r.kind, level: r.sev === 'warn' ? 'warn' : 'error', re, why: r.why || r.id, said: r.said || '', project: true };
  }).filter(Boolean);
}

function rulesForKind(kind, root = process.cwd()) {
  const kinds = INCLUDES[kind] || [];
  return KIND_RULES.filter((r) => kinds.includes(r.kind)).concat(projectKindRules(root, kind));
}

// --- scanning -----------------------------------------------------------------

function scanText(text, label, kind, options = {}) {
  const page = kind === 'screen' && /\.html?$/i.test(label);
  let rules = options.rules || rulesForKind(kind, options.root);
  if (page) rules = rules.filter((r) => !PAGE_REPLACES.has(r.id));
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const prose = kind !== 'screen' && /\.(md|mdx)$/i.test(label);
  const skip = prose ? fencedLines(lines) : lines.map(() => false);
  const doc = { text, lines, skip, email: kind === 'email' ? parseEmail(text, options.subject) : null };
  const findings = [];
  const ctx = {};
  const add = (rule, line, matched) => findings.push({
    rule: rule.id, kind: rule.kind, level: rule.level, file: label, line, text: String(matched).slice(0, rule.check === 'components' ? 240 : 80), why: rule.why, said: rule.said,
  });
  for (const rule of rules) {
    if (rule.check) { CHECKERS[rule.check](doc, rule, add, ctx); continue; }
    lines.forEach((line, i) => {
      if (skip[i]) return;
      const m = line.match(rule.re);
      if (m) add(rule, i + 1, m[0].trim());
    });
  }
  // an html page also carries what the page check could not read and which rules are switched off
  const site = page ? require('./page-lang').checkText(text, label, { root: options.root || process.cwd() }) : null;
  if (site) findings.push(...site.findings);
  findings.sort((a, b) => a.line - b.line);
  return { findings, components: ctx.components || null, ...(site ? { notChecked: site.notChecked.map((n) => n.said), off: site.off } : {}) };
}

function walkKind(target, kind, out) {
  let stat;
  try { stat = fs.statSync(target); } catch { return out; }
  if (stat.isFile()) { out.push(target); return out; } // a named file is scanned whatever its extension
  if (!stat.isDirectory()) return out;
  for (const name of fs.readdirSync(target)) {
    if (name.startsWith('.') || ['node_modules', 'dist', 'build', '.next', 'coverage', 'vendor'].includes(name)) continue;
    const p = path.join(target, name);
    let st; try { st = fs.statSync(p); } catch { continue; }
    if (st.isDirectory()) walkKind(p, kind, out);
    else if (KIND_EXTS[kind].has(path.extname(name).toLowerCase())) out.push(p);
  }
  return out;
}

module.exports = { KINDS, KIND_RULES, CHECKERS, CAPS_OK, PLACEHOLDER_RE, PAGE_REPLACES, rulesForKind, scanText, walkKind, parseEmail, loadCatalog, componentReport };
