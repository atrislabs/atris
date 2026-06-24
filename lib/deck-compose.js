// Compose a deck spec from a prose/markdown analysis (e.g. a transcript summary
// the cloud returns for a YouTube video). Pure and deterministic: text in,
// lint-clean spec out. The network fetch lives in the CLI; this just turns
// structured text into layout SECTIONS and runs them through the layout planner
// so the result picks narrative archetypes and stays under template fatigue.

const { planLayout } = require('./deck-layout');

function stripNoise(md) {
  return String(md == null ? '' : md)
    .replace(/```[\s\S]*?```/g, '')   // fenced code
    .replace(/`([^`]+)`/g, '$1')      // inline code
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '') // images
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // links -> text
    .replace(/\r\n?/g, '\n');
}

// Tokenize markdown-ish text into headings, bullet lists, quotes, paragraphs.
function parseBlocks(md) {
  const lines = stripNoise(md).split('\n');
  const blocks = [];
  let para = [];
  let bullets = [];
  const flushPara = () => { if (para.length) { blocks.push({ kind: 'p', text: para.join(' ').trim() }); para = []; } };
  const flushBullets = () => { if (bullets.length) { blocks.push({ kind: 'ul', items: bullets.slice() }); bullets = []; } };
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    const h = line.match(/^(#{1,4})\s+(.+?)\s*#*$/);
    const bul = line.match(/^\s*[-*•]\s+(.+)/) || line.match(/^\s*\d+[.)]\s+(.+)/);
    const quote = line.match(/^\s*>\s*(.+)/);
    if (h) { flushPara(); flushBullets(); blocks.push({ kind: 'h', level: h[1].length, text: h[2].trim() }); }
    else if (bul) { flushPara(); bullets.push(bul[1].trim()); }
    else if (quote) { flushPara(); flushBullets(); blocks.push({ kind: 'quote', text: quote[1].trim() }); }
    else if (line.trim() === '') { flushPara(); flushBullets(); }
    else { flushBullets(); para.push(line.trim()); }
  }
  flushPara();
  flushBullets();
  return blocks;
}

// "Term: detail" or bold "**Term** detail" -> { text, sub }; else a plain string.
function toItem(line) {
  const bold = line.match(/^\*\*(.+?)\*\*[:\s,-]+(.+)/);
  if (bold && bold[1].length <= 48) return { text: bold[1].trim(), sub: bold[2].trim() };
  const colon = line.match(/^([^:]{2,48}):\s+(.+)/);
  if (colon) return { text: colon[1].trim(), sub: colon[2].trim() };
  return line.replace(/\*\*/g, '');
}

// A quote may carry an attribution: `"..." - Name` or `... (Name)`.
function splitQuote(text) {
  const dash = text.match(/^["“]?(.+?)["”]?\s+[-–—]\s+(.+)$/);
  if (dash) return { text: dash[1].trim(), author: dash[2].trim() };
  const paren = text.match(/^["“]?(.+?)["”]?\s+\(([^)]+)\)\s*$/);
  if (paren) return { text: paren[1].trim(), author: paren[2].trim() };
  return { text: text.replace(/^["“]|["”]$/g, '').trim() };
}

function classify(heading, content) {
  const ul = content.find((b) => b.kind === 'ul');
  const quote = content.find((b) => b.kind === 'quote');
  const paras = content.filter((b) => b.kind === 'p').map((b) => b.text);

  if (ul) {
    return { kind: 'points', heading: heading || undefined, items: ul.items.map(toItem) };
  }
  if (quote) {
    const q = splitQuote(quote.text);
    return { kind: 'quote', quote: q };
  }
  const body = paras.join(' ').trim();
  if (!body) return { kind: 'statement', text: heading || 'Untitled' };
  if (body.length > 180 || paras.length > 1) {
    return { kind: 'prose', heading: heading || undefined, paragraphs: paras.slice(0, 3) };
  }
  // short single paragraph: the heading is the claim, the paragraph the support
  if (heading) return { kind: 'statement', text: heading, sub: body };
  return { kind: 'statement', text: body };
}

// Group tokenized blocks into sections (one per heading; leading content forms
// an untitled section), then classify each into a layout section.
function blocksToSections(blocks) {
  const groups = [];
  let current = null;
  for (const b of blocks) {
    if (b.kind === 'h') { if (current) groups.push(current); current = { heading: b.text, content: [] }; }
    else { if (!current) current = { heading: null, content: [] }; current.content.push(b); }
  }
  if (current) groups.push(current);
  return groups.map((g) => ({ raw: g, section: classify(g.heading, g.content) }));
}

function composeSpec(text, opts = {}) {
  const blocks = parseBlocks(text);
  const grouped = blocksToSections(blocks);
  let sections = grouped.map((g) => g.section);

  // Cover: promote the first section into a cover using the doc title if present.
  const h1 = blocks.find((b) => b.kind === 'h' && b.level === 1);
  const docTitle = opts.title || (h1 && h1.text) || (sections[0] && (sections[0].heading || sections[0].text)) || 'Untitled';
  const firstPara = blocks.find((b) => b.kind === 'p');
  if (sections.length) {
    sections[0] = { kind: 'cover', headline: docTitle, sub: opts.subtitle || (sections[0].sub) || (firstPara && firstPara.text) || undefined };
  } else {
    sections = [{ kind: 'cover', headline: docTitle, sub: opts.subtitle }];
  }

  // Close: synthesize a closing slide so every deck lands a takeaway.
  sections.push({
    kind: 'close',
    text: opts.tagline || docTitle,
    ...(opts.url || opts.footer ? { footer: [opts.footer, opts.url].filter(Boolean).join(' · ') } : {}),
  });

  const style = opts.style || 'narrative';
  const slides = planLayout(sections, { style });
  return {
    theme: opts.theme || 'ink',
    brand: opts.brand || { name: opts.brandName || docTitle, accent: '.' },
    slides,
  };
}

module.exports = {
  parseBlocks,
  blocksToSections,
  classify,
  toItem,
  splitQuote,
  composeSpec,
};
