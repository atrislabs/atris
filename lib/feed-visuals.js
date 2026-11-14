'use strict';

// One visual per feed card: plain data the screen draws, never code that runs.
//
// A port of the backend's services/feed_visuals.py with the same six kinds and
// the same limits, so a visual written locally is accepted or refused the way
// the cloud would. Anything off these lists is refused, never repaired.
//
//   {kind: "metric", label, value, change?}
//   {kind: "chart", chart: "bar", title, data: [<=6 {label, value}], unit?, caption?}
//   {kind: "chart", chart: "line", title, data: [2..24 {label, value}], unit?, caption?}
//   {kind: "before_after", before, after, caption?}
//   {kind: "steps", steps: [1..4 strings], caption?}
//   {kind: "image", url, alt}            Atris media store
//   {kind: "image", path, alt}           a picture file inside the project or ~/.atris
//   {kind: "code", language?, code, caption?}   the key lines, shown as code
//   {kind: "drawing", svg, alt}          SVG, allow-listed, <= 20 KB
//
// Every piece of text in a visual (labels, captions, SVG text) must pass the
// plain-words check.

const { plumbingWords } = require('./feed-plain-words');

const TEXT_MAX = 120;
const CAPTION_MAX = 200;
const BEFORE_AFTER_MAX = 200;
const SVG_MAX_BYTES = 20 * 1024;
const BAR_MAX = 6;
const LINE_MIN = 2;
const LINE_MAX = 24;
const STEPS_MAX = 4;
const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp'];
const MEDIA_BUCKET = 'atris-uploads';
const CODE_MAX_BYTES = 4 * 1024;
const IMAGE_FILE_MAX_BYTES = 8 * 1024 * 1024;
// The first bytes each allowed picture type starts with: a file named .png
// that is not a picture is refused.
const IMAGE_SIGNATURES = [
  ['.png', (b) => b.length >= 8 && b[0] === 0x89 && b.toString('latin1', 1, 4) === 'PNG'],
  ['.jpg', (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  ['.jpeg', (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  ['.gif', (b) => b.length >= 6 && /^GIF8[79]a$/.test(b.toString('latin1', 0, 6))],
  ['.webp', (b) => b.length >= 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP'],
];

class VisualRejected extends Error {
  constructor(message, words = []) {
    super(message);
    this.name = 'VisualRejected';
    this.words = words;
  }
}

// ------------------------------------------------------------------ text

function text(value, field, { required = true, limit = TEXT_MAX } = {}) {
  if (value === null || value === undefined || (typeof value === 'string' && !value.trim())) {
    if (required) throw new VisualRejected(`The visual needs ${field}.`);
    return null;
  }
  if (typeof value !== 'string') throw new VisualRejected(`${field} must be text.`);
  const clean = value.split(/\s+/).filter(Boolean).join(' ');
  if (clean.length > limit) throw new VisualRejected(`Keep ${field} under ${limit} characters.`);
  if (clean.includes('<') || clean.includes('>')) throw new VisualRejected(`${field} must be plain text, not markup.`);
  const words = plumbingWords(clean);
  if (words.length) throw new VisualRejected(`Write ${field} in plain words. Remove: ${words.join(', ')}.`, words);
  return clean;
}

function number(value, field) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new VisualRejected(`${field} must be a number.`);
  return value;
}

function points(raw, low, high) {
  if (!Array.isArray(raw) || raw.length < low || raw.length > high) {
    throw new VisualRejected(`A chart needs ${low} to ${high} points.`);
  }
  return raw.map((point, index) => {
    if (!isObject(point)) throw new VisualRejected('Each chart point needs a label and a value.');
    return {
      label: text(point.label, `point ${index + 1} label`, { limit: 40 }),
      value: number(point.value, `point ${index + 1} value`),
    };
  });
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function only(raw, allowed) {
  const extra = Object.keys(raw).filter((key) => key !== 'kind' && !allowed.includes(key)).sort();
  if (extra.length) throw new VisualRejected(`Unknown visual fields: ${extra.join(', ')}.`);
}

// ----------------------------------------------------------------- image

function mediaHosts(env = process.env) {
  const region = env.AWS_REGION || env.ECS_REGION || 'us-east-1';
  const hosts = new Set([
    `${MEDIA_BUCKET}.s3.${region}.amazonaws.com`,
    `${MEDIA_BUCKET}.s3.amazonaws.com`,
    `${MEDIA_BUCKET}.s3.us-east-1.amazonaws.com`,
  ]);
  for (const host of String(env.ATRIS_FEED_MEDIA_HOSTS || '').split(',')) {
    if (host.trim()) hosts.add(host.trim().toLowerCase());
  }
  return hosts;
}

function mediaUrl(url) {
  if (typeof url !== 'string' || url.length > 2000 || /\s/.test(url)) {
    throw new VisualRejected("The image needs a link to a picture in Atris's media store.");
  }
  let parts;
  try {
    parts = new URL(url);
  } catch {
    throw new VisualRejected("Images must come from Atris's own media store.");
  }
  if (parts.protocol !== 'https:' || parts.username || parts.password || parts.port
    || !mediaHosts().has(parts.hostname.toLowerCase())) {
    throw new VisualRejected("Images must come from Atris's own media store.");
  }
  if (!IMAGE_EXTENSIONS.some((ext) => parts.pathname.toLowerCase().endsWith(ext))) {
    throw new VisualRejected('The image link must point to a png, jpg, gif or webp picture.');
  }
  return url;
}

// A picture a member made, as a file: inside the project folder or under
// ~/.atris, after every link is followed (a link that points out is refused),
// a real png, jpg, gif or webp, at most 8 MB. Kept as its full path.
function imageFile(raw, root) {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 1000 || raw.includes('\0')) {
    throw new VisualRejected('The image needs the path of a picture file.');
  }
  if (!root) throw new VisualRejected('A picture file can only be checked inside a project.');
  const path = require('path');
  const fsMod = require('fs');
  const os = require('os');
  const real = (p) => { try { return fsMod.realpathSync(p); } catch { return null; } };
  const allowedRoots = [real(root), real(path.join(require('./state-home').atrisHome()))].filter(Boolean);
  const resolved = real(path.resolve(root, raw.replace(/^~(?=\/)/, os.homedir())));
  if (!resolved) throw new VisualRejected('There is no picture at that path.');
  if (!allowedRoots.some((base) => resolved === base || resolved.startsWith(base + path.sep))) {
    throw new VisualRejected('A picture must be a file inside this project or under ~/.atris.');
  }
  const ext = path.extname(resolved).toLowerCase();
  const signature = IMAGE_SIGNATURES.find(([e]) => e === ext);
  if (!signature) throw new VisualRejected('The picture must be a png, jpg, gif or webp file.');
  const stat = fsMod.statSync(resolved);
  if (!stat.isFile()) throw new VisualRejected('The picture must be a file.');
  if (stat.size > IMAGE_FILE_MAX_BYTES) throw new VisualRejected('Keep the picture under 8 MB.');
  const fd = fsMod.openSync(resolved, 'r');
  const head = Buffer.alloc(12);
  try { fsMod.readSync(fd, head, 0, 12, 0); } finally { fsMod.closeSync(fd); }
  if (!signature[1](head)) throw new VisualRejected('That file is not a real picture.');
  return resolved;
}

// Code shown as code: plain text only, at most 4 KB. The code itself is not
// held to the plain-words check (it is code), and it only ever sits in the
// visual, never in a card's title, why or story.
function codeText(raw) {
  if (typeof raw !== 'string' || !raw.trim()) throw new VisualRejected('A code visual needs the code.');
  if (Buffer.byteLength(raw, 'utf8') > CODE_MAX_BYTES) throw new VisualRejected('Keep the code under 4 KB: show only the lines that matter.');
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(raw)) throw new VisualRejected('The code must be plain text.');
  return raw.replace(/\r\n/g, '\n');
}

// --------------------------------------------------------------- drawing

const SVG_NS = 'http://www.w3.org/2000/svg';
const SVG_ELEMENTS = new Set([
  'svg', 'g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'text', 'tspan',
  'title', 'desc', 'defs', 'linearGradient', 'radialGradient', 'stop',
]);
const SVG_ATTRIBUTES = new Set([
  'id', 'viewBox', 'width', 'height', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry',
  'fx', 'fy', 'd', 'points', 'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin',
  'stroke-dasharray', 'opacity', 'fill-opacity', 'stroke-opacity', 'transform', 'font-size',
  'font-family', 'font-weight', 'text-anchor', 'dominant-baseline', 'offset', 'stop-color',
  'stop-opacity', 'gradientUnits', 'gradientTransform', 'preserveAspectRatio', 'version', 'role',
  'aria-label', 'style', 'dx', 'dy',
]);
const STYLE_PROPERTIES = new Set([
  'fill', 'stroke', 'stroke-width', 'opacity', 'fill-opacity', 'stroke-opacity', 'font-size',
  'font-weight', 'font-family', 'text-anchor', 'stroke-linecap', 'stroke-linejoin', 'stop-color',
  'stop-opacity',
]);
const SAFE_VALUE = /^[#A-Za-z0-9 .,%()+-]*$/;
const LOCAL_PAINT = /^url\(#[A-Za-z][A-Za-z0-9_-]*\)$/;
const BANNED_VALUE = /javascript:|vbscript:|data:|url\(|expression\(|@import|&#|\\/i;

function attributeOk(name, value) {
  // A namespaced attribute comes through as {uri}name, as ElementTree names it.
  if (name.startsWith('{') || name.toLowerCase().startsWith('on') || !SVG_ATTRIBUTES.has(name)) return false;
  if ((name === 'fill' || name === 'stroke') && LOCAL_PAINT.test(value.trim())) return true; // a gradient in this drawing
  if (BANNED_VALUE.test(value)) return false;
  if (name === 'style') {
    for (const declaration of value.split(';').map((part) => part.trim()).filter(Boolean)) {
      const at = declaration.indexOf(':');
      const prop = (at === -1 ? declaration : declaration.slice(0, at)).trim().toLowerCase();
      const val = at === -1 ? '' : declaration.slice(at + 1).trim();
      if (!STYLE_PROPERTIES.has(prop) || !SAFE_VALUE.test(val)) return false;
    }
    return true;
  }
  if (['id', 'aria-label', 'role', 'font-family'].includes(name)) return /^[A-Za-z0-9 ,._-]*$/.test(value);
  return SAFE_VALUE.test(value);
}

// A small, strict XML reader: elements, attributes, text, comments and the
// five built-in entities plus character references. Anything else (and any
// malformed input) is a parse error, the way Python's ElementTree refuses it.
class XmlError extends Error {}

const NAME_START = /[A-Za-z_:]/;
const NAME_CHAR = /[A-Za-z0-9_:.-]/;
const ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

function decodeEntities(raw) {
  return raw.replace(/&([^;&\s]*);?/g, (whole, body) => {
    if (!whole.endsWith(';')) throw new XmlError('bare ampersand');
    if (Object.prototype.hasOwnProperty.call(ENTITIES, body)) return ENTITIES[body];
    const hex = /^#x([0-9A-Fa-f]+)$/.exec(body);
    const dec = /^#([0-9]+)$/.exec(body);
    const code = hex ? parseInt(hex[1], 16) : dec ? parseInt(dec[1], 10) : NaN;
    if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) throw new XmlError(`unknown entity ${body}`);
    return String.fromCodePoint(code);
  });
}

function parseXml(source) {
  let i = 0;
  const n = source.length;
  const stack = [];
  let root = null;

  const readName = () => {
    const start = i;
    if (i >= n || !NAME_START.test(source[i])) throw new XmlError('bad name');
    i += 1;
    while (i < n && NAME_CHAR.test(source[i])) i += 1;
    return source.slice(start, i);
  };
  const skipSpace = () => { while (i < n && /\s/.test(source[i])) i += 1; };
  const appendText = (raw) => {
    if (!raw) return;
    const value = decodeEntities(raw);
    if (!stack.length) {
      if (value.trim()) throw new XmlError('text outside the root');
      return;
    }
    const parent = stack[stack.length - 1];
    if (parent.children.length) {
      const last = parent.children[parent.children.length - 1];
      last.tail = (last.tail || '') + value;
    } else {
      parent.text = (parent.text || '') + value;
    }
  };

  while (i < n) {
    const lt = source.indexOf('<', i);
    if (lt === -1) {
      appendText(source.slice(i));
      break;
    }
    const chunk = source.slice(i, lt);
    if (chunk.includes('>') && /\]\]>/.test(chunk)) throw new XmlError('stray cdata end');
    appendText(chunk);
    i = lt;
    if (source.startsWith('<!--', i)) {
      const end = source.indexOf('-->', i + 4);
      if (end === -1) throw new XmlError('open comment');
      if (source.slice(i + 4, end).includes('--')) throw new XmlError('double dash in comment');
      i = end + 3;
      continue;
    }
    if (source.startsWith('<!', i) || source.startsWith('<?', i)) throw new XmlError('declaration');
    if (source.startsWith('</', i)) {
      i += 2;
      const name = readName();
      skipSpace();
      if (source[i] !== '>') throw new XmlError('bad close tag');
      i += 1;
      const open = stack.pop();
      if (!open || open.raw !== name) throw new XmlError('mismatched tag');
      continue;
    }
    i += 1;
    if (root && !stack.length) throw new XmlError('second root');
    const element = { raw: readName(), attrs: [], children: [], text: null, tail: null, parent: stack[stack.length - 1] || null };
    const seen = new Set();
    let selfClosing = false;
    for (;;) {
      const before = i;
      skipSpace();
      if (source[i] === '>') { i += 1; break; }
      if (source.startsWith('/>', i)) { i += 2; selfClosing = true; break; }
      if (i === before) throw new XmlError('attributes need space');
      const name = readName();
      skipSpace();
      if (source[i] !== '=') throw new XmlError('attribute without value');
      i += 1;
      skipSpace();
      const quote = source[i];
      if (quote !== '"' && quote !== "'") throw new XmlError('unquoted attribute');
      const end = source.indexOf(quote, i + 1);
      if (end === -1) throw new XmlError('open attribute');
      const raw = source.slice(i + 1, end);
      if (raw.includes('<')) throw new XmlError('< in attribute');
      if (seen.has(name)) throw new XmlError('duplicate attribute');
      seen.add(name);
      // XML attribute value normalization: tabs and newlines read as spaces.
      element.attrs.push([name, decodeEntities(raw.replace(/[\t\n\r]/g, ' '))]);
      i = end + 1;
    }
    if (element.parent) element.parent.children.push(element);
    else root = element;
    if (!selfClosing) stack.push(element);
  }
  if (stack.length || !root) throw new XmlError('unclosed element');
  resolveNamespaces(root, { xml: 'http://www.w3.org/XML/1998/namespace' });
  return root;
}

function resolveNamespaces(element, inherited) {
  const scope = { ...inherited };
  const attrs = [];
  for (const [name, value] of element.attrs) {
    if (name === 'xmlns') scope[''] = value;
    else if (name.startsWith('xmlns:')) scope[name.slice(6)] = value;
    else attrs.push([name, value]);
  }
  const qualify = (name, isAttribute) => {
    const colon = name.indexOf(':');
    if (colon === -1) {
      if (isAttribute) return name; // an unprefixed attribute has no namespace
      return scope[''] ? `{${scope['']}}${name}` : name;
    }
    const prefix = name.slice(0, colon);
    if (!Object.prototype.hasOwnProperty.call(scope, prefix)) throw new XmlError('unbound prefix');
    return `{${scope[prefix]}}${name.slice(colon + 1)}`;
  };
  element.tag = qualify(element.raw, false);
  element.attrib = attrs.map(([name, value]) => [qualify(name, true), value]);
  for (const child of element.children) resolveNamespaces(child, scope);
}

function* iterElements(element) {
  yield element;
  for (const child of element.children) yield* iterElements(child);
}

function checkSvg(svg) {
  if (typeof svg !== 'string' || !svg.trim()) throw new VisualRejected('The drawing needs SVG.');
  if (Buffer.byteLength(svg, 'utf8') > SVG_MAX_BYTES) {
    throw new VisualRejected(`Keep the drawing under ${SVG_MAX_BYTES / 1024} KB.`);
  }
  const body = svg.replace(/^\s*<\?xml[^?<>]*\?>/, ''); // one leading XML declaration is fine
  const lowered = body.toLowerCase();
  // No document types or entities, no processing instructions, no CDATA hiding markup.
  if (lowered.includes('<!doctype') || lowered.includes('<!entity') || body.includes('<?') || lowered.includes('<![cdata[')) {
    throw new VisualRejected('The drawing may only use basic shapes, paths, text, groups and gradients.');
  }
  let root;
  try {
    root = parseXml(body);
  } catch (error) {
    if (error instanceof XmlError) throw new VisualRejected('The drawing is not valid SVG.');
    throw error;
  }
  const texts = [];
  for (const element of iterElements(root)) {
    if (!element.tag.startsWith(`{${SVG_NS}}`)) {
      throw new VisualRejected('The drawing must be SVG (with the SVG namespace) and nothing else.');
    }
    const name = element.tag.slice(SVG_NS.length + 2);
    if (!SVG_ELEMENTS.has(name)) throw new VisualRejected(`The drawing may not use <${name}>.`);
    for (const [attr, value] of element.attrib) {
      if (!attributeOk(attr, value)) {
        const shown = attr.includes('}') ? attr.slice(attr.indexOf('}') + 1) : attr;
        throw new VisualRejected(`The drawing may not use the ${shown} attribute or that value.`);
      }
    }
    for (const piece of [element.text, element.tail]) {
      if (piece && piece.trim()) texts.push(piece.trim());
    }
  }
  if (root.tag !== `{${SVG_NS}}svg`) throw new VisualRejected('The drawing must start with <svg>.');
  for (const piece of texts) text(piece, 'text in the drawing', { limit: CAPTION_MAX });
  return svg;
}

// ---------------------------------------------------------------- visual

function checkVisual(raw, { root = null } = {}) {
  if (raw === null || raw === undefined) return null;
  if (!isObject(raw)) throw new VisualRejected('A visual is an object with a kind.');
  const kind = raw.kind;
  if (kind === 'metric') {
    only(raw, ['label', 'value', 'change']);
    const out = { kind: 'metric', label: text(raw.label, 'the label'), value: text(raw.value, 'the value', { limit: 24 }) };
    const change = text(raw.change, 'the change', { required: false, limit: 40 });
    return change ? { ...out, change } : out;
  }
  if (kind === 'chart') {
    only(raw, ['chart', 'title', 'data', 'unit', 'caption']);
    const chart = raw.chart;
    if (chart !== 'bar' && chart !== 'line') throw new VisualRejected('A chart is "bar" or "line".');
    const [low, high] = chart === 'bar' ? [1, BAR_MAX] : [LINE_MIN, LINE_MAX];
    const out = { kind: 'chart', chart, title: text(raw.title, 'the title'), data: points(raw.data, low, high) };
    for (const [field, limit] of [['unit', 16], ['caption', CAPTION_MAX]]) {
      const value = text(raw[field], `the ${field}`, { required: false, limit });
      if (value) out[field] = value;
    }
    return out;
  }
  if (kind === 'before_after') {
    only(raw, ['before', 'after', 'caption']);
    const out = {
      kind: 'before_after',
      before: text(raw.before, 'before', { limit: BEFORE_AFTER_MAX }),
      after: text(raw.after, 'after', { limit: BEFORE_AFTER_MAX }),
    };
    const caption = text(raw.caption, 'the caption', { required: false, limit: CAPTION_MAX });
    return caption ? { ...out, caption } : out;
  }
  if (kind === 'steps') {
    only(raw, ['steps', 'caption']);
    const steps = raw.steps;
    if (!Array.isArray(steps) || steps.length < 1 || steps.length > STEPS_MAX) {
      throw new VisualRejected(`Steps need 1 to ${STEPS_MAX} lines.`);
    }
    const out = { kind: 'steps', steps: steps.map((step, index) => text(step, `step ${index + 1}`)) };
    const caption = text(raw.caption, 'the caption', { required: false, limit: CAPTION_MAX });
    return caption ? { ...out, caption } : out;
  }
  if (kind === 'image') {
    only(raw, ['url', 'path', 'alt']);
    if ((raw.url === undefined) === (raw.path === undefined)) throw new VisualRejected('An image has either a url or a path, not both.');
    const alt = text(raw.alt, 'the alt text');
    return raw.url !== undefined ? { kind: 'image', url: mediaUrl(raw.url), alt } : { kind: 'image', path: imageFile(raw.path, root), alt };
  }
  if (kind === 'code') {
    only(raw, ['language', 'code', 'caption']);
    const out = { kind: 'code' };
    if (raw.language !== undefined && raw.language !== null && raw.language !== '') {
      if (typeof raw.language !== 'string' || !/^[A-Za-z0-9+#._-]{1,20}$/.test(raw.language)) throw new VisualRejected('The language is one short word, like js or python.');
      out.language = raw.language.toLowerCase();
    }
    out.code = codeText(raw.code);
    const caption = text(raw.caption, 'the caption', { required: false, limit: CAPTION_MAX });
    return caption ? { ...out, caption } : out;
  }
  if (kind === 'drawing') {
    only(raw, ['svg', 'alt']);
    return { kind: 'drawing', svg: checkSvg(raw.svg), alt: text(raw.alt, 'the alt text') };
  }
  throw new VisualRejected('kind must be metric, chart, before_after, steps, image, drawing or code.');
}

// For showing a stored visual: checked again, and dropped if it no longer passes.
function safeVisual(raw, options = {}) {
  try {
    return checkVisual(raw, options);
  } catch (error) {
    if (error instanceof VisualRejected) return null;
    throw error;
  }
}

module.exports = {
  CODE_MAX_BYTES,
  IMAGE_FILE_MAX_BYTES,
  SVG_MAX_BYTES,
  VisualRejected,
  checkSvg,
  checkVisual,
  safeVisual,
};
