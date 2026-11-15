'use strict';

// Atris memory for any agent in any terminal, the parts with no network: the
// help screen, how each command reads its arguments, how answers are worded,
// and the rules block a person pastes into an agent's rules file. Kept free of
// heavy requires so `atris memory --help` and the fast path stay cheap.

const fs = require('fs');
const path = require('path');

const LIVE_COMMANDS = new Set([
  'show', 'search', 'ask', 'read', 'ls', 'remember', 'write', 'rm', 'usage', 'log', 'lesson', 'agents', 'setup',
]);

function isLiveCommand(word) {
  return LIVE_COMMANDS.has(String(word || ''));
}

// One line per command, shown together by `atris memory` and one at a time by
// `atris memory <command> --help`.
const COLUMN = 38;
const row = (form, ...what) => [`  ${form} `.padEnd(COLUMN) + what[0], ...what.slice(1).map((more) => ' '.repeat(COLUMN) + more)].join('\n');
const USAGE_LINES = {
  show: row('show', 'who they are and what matters now; read it before helping'),
  search: row('search "rent|lease" [--in folder]', 'lines with any of the words, split by |'),
  ask: row('ask "a question" [--in folder]', 'answered from their memory, with the lines it rests on'),
  read: row('read <path> [--from N] [--lines N]', 'numbered lines of one file; --raw prints it as stored'),
  ls: row('ls [folder]', 'what is in a folder; MAP.md says what is where'),
  remember: row('remember "one short line"', 'a lasting fact or preference about the person, when they',
    'say remember, note, save or don\'t forget [--to now|learning]'),
  write: row('write <path> [--file f]', 'save a page under wiki/ or features/, or a file under files/, or pipe it in'),
  rm: row('rm <path>', 'delete a page under wiki/ or features/, or a file under files/'),
  usage: row('usage', 'file space used and what the plan gives'),
  log: row('log "what I did" --as <agent>', 'one line in your notebook, team/<agent>/logs/<today>'),
  lesson: row('lesson "text" --before N --after N', 'kept in team/<agent>/lessons.md only when the score', 'went up (--as <agent>)'),
  agents: row('agents [--write AGENTS.md]', 'rules to paste into any agent, plus the MCP setup lines'),
};
USAGE_LINES.setup = USAGE_LINES.agents;

const LIVE_HELP = [
  'atris memory: the person\'s own memory, shared by every app and agent they use.',
  'Every command takes --json. Sign in once with: atris login',
  '',
  'read',
  USAGE_LINES.show,
  USAGE_LINES.search,
  USAGE_LINES.ask,
  USAGE_LINES.read,
  USAGE_LINES.ls,
  '',
  'save',
  USAGE_LINES.remember,
  USAGE_LINES.write,
  USAGE_LINES.rm,
  USAGE_LINES.usage,
  '',
  'notebook (an agent\'s own; --as defaults to $ATRIS_AGENT)',
  USAGE_LINES.log,
  USAGE_LINES.lesson,
  USAGE_LINES.agents,
  '',
];

// Flags that take a value, per command. --json, --raw and --help take none.
const VALUE_FLAGS = {
  search: ['--in'],
  ask: ['--in'],
  read: ['--from', '--lines'],
  ls: [],
  show: [],
  remember: ['--to', '--section', '--as'],
  write: ['--file'],
  rm: [],
  usage: [],
  log: ['--as'],
  lesson: ['--before', '--after', '--as'],
  agents: ['--write', '--as'],
  setup: ['--write', '--as'],
};
const BOOL_FLAGS = { read: ['--raw'] };
const ALL_VALUE_FLAGS = new Set(Object.values(VALUE_FLAGS).flat());
const ALL_BOOL_FLAGS = new Set(Object.values(BOOL_FLAGS).flat());

// { sub, words, flags, json, help } or { error }. Everything after -- is a
// word, so a line that starts with a dash still gets through.
function parseLiveArgs(args = []) {
  const out = { sub: '', words: [], flags: {}, json: false, help: false };
  const words = [];
  const used = [];
  let rest = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = String(args[i]);
    if (rest || arg === '-' || !arg.startsWith('-')) { words.push(arg); continue; }
    if (arg === '--') { rest = true; continue; }
    if (arg === '--json') { out.json = true; continue; }
    if (arg === '--help' || arg === '-h') { out.help = true; continue; }
    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg : arg.slice(0, eq);
    if (ALL_VALUE_FLAGS.has(name)) {
      const value = eq === -1 ? args[i + 1] : arg.slice(eq + 1);
      if (eq === -1) i += 1;
      if (value === undefined || value === '') return { error: `${name} needs a value` };
      out.flags[name] = String(value);
    } else if (ALL_BOOL_FLAGS.has(name) && eq === -1) {
      out.flags[name] = true;
    } else {
      return { error: `unknown option ${name}. To pass words that start with a dash, put -- before them.` };
    }
    used.push(name);
  }
  out.sub = words.shift() || '';
  out.words = words;
  const allowed = new Set([...(VALUE_FLAGS[out.sub] || []), ...(BOOL_FLAGS[out.sub] || [])]);
  const wrong = used.find((name) => !allowed.has(name));
  if (wrong) return { error: `${wrong} does not work with atris memory ${out.sub}` };
  return out;
}

function positiveInt(value, name) {
  if (value === undefined) return { value: undefined };
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) return { error: `${name} must be a whole number, 1 or more` };
  return { value: n };
}

function plainNumber(value, name) {
  const n = Number(value);
  if (value === undefined || value === '' || !Number.isFinite(n)) return { error: `${name} needs a number` };
  return { value: n };
}

function size(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1000) return `${n} B`;
  if (n < 1000000) return `${(n / 1000).toFixed(n < 10000 ? 1 : 0)} KB`;
  return `${(n / 1000000).toFixed(1)} MB`;
}

// ---------------------------------------------------------------- show

const SHOW_SECTIONS = [
  ['about', 'About them, in their words', 'about.md'],
  ['now', 'What they are working on now', 'now.md'],
  ['learning', 'Their learning', 'wiki/learning.md'],
  ['board', 'Their board: the goal, the deadline, the doors they are knocking on', 'board.md'],
];
const SECTION_MAX_CHARS = 2400;
const JOURNAL_LINES = 15;

// The file without its title line. Empty when only headings are left, which is
// how a fresh note looks (learning.md starts with three empty headings).
function noteBody(text) {
  const body = String(text || '').replace(/\r\n/g, '\n').replace(/^# .*\n?/, '').trim();
  const hasWords = body.split('\n').some((line) => line.trim() && !/^#{1,6} /.test(line.trim()));
  return hasWords ? body : '';
}

function clip(body, readPath) {
  if (body.length <= SECTION_MAX_CHARS) return body;
  const cut = body.slice(0, SECTION_MAX_CHARS);
  const atLine = cut.lastIndexOf('\n');
  return `${atLine > 0 ? cut.slice(0, atLine) : cut}\n(more: atris memory read ${readPath})`;
}

function journalLines(text, max = JOURNAL_LINES) {
  return String(text || '').split(/\r?\n/).filter((line) => line.startsWith('- ')).slice(0, max);
}

// The person's notes as one short block for a model, from GET /me/memory.
function showText(data) {
  const files = (data && data.files) || {};
  const parts = ['# Atris memory', 'The person\'s own notes, shared by every app they use. Use them to fit your help; do not recite them.'];
  let any = false;
  for (const [name, label, readPath] of SHOW_SECTIONS) {
    const body = noteBody(files[name]);
    if (!body) continue;
    any = true;
    // Headings inside a note sit one level under the section title.
    parts.push('', `## ${label} (${readPath})`, clip(body, readPath).replace(/^(#{2,5}) /gm, '#$1 '));
  }
  const recent = journalLines(files.journal);
  if (recent.length) {
    any = true;
    parts.push('', '## Recently they said, newest first', ...recent);
  }
  if (!any) {
    parts.push('', 'Nothing saved yet. When they tell you something lasting about themselves, save it:',
      'atris memory remember "one short line"');
    return parts.join('\n');
  }
  parts.push('', 'More: atris memory search "word|other word". Save: atris memory remember "one short line".');
  return parts.join('\n');
}

// ---------------------------------------------------------------- other answers

function searchLines(query, data) {
  const hits = (data && data.hits) || [];
  const scanned = data && Number.isFinite(Number(data.files)) ? Number(data.files) : null;
  const where = scanned === null ? '' : ` (searched ${scanned} ${scanned === 1 ? 'file' : 'files'})`;
  if (!hits.length) {
    const words = String(query).split('|').map((w) => w.trim()).filter(Boolean).map((w) => `"${w}"`);
    return [`No lines with ${words.join(' or ')}${where}.`];
  }
  const lines = hits.map((hit) => `${hit.path}:${hit.n}: ${hit.text}`);
  lines.push(`${hits.length} ${hits.length === 1 ? 'line' : 'lines'}${where}. Read around one: atris memory read <path> --from <line>`);
  if (data.truncated) lines.push('More lines match than shown. Narrow it with fewer words or --in <folder>.');
  return lines;
}

// The answer first, then each line it rests on, then how sure it is. With no
// answer (the model was busy) the search hits it started from are shown.
function askLines(data) {
  const sources = (data && data.sources) || [];
  const cite = sources.map((s) => `  ${s.path}:${s.n}: ${s.text}`);
  if (data && data.answer && data.found) {
    return [String(data.answer), ...(cite.length ? ['', 'From:', ...cite] : [])];
  }
  if (data && data.answer) {
    const lines = [String(data.answer)];
    if (cite.length) lines.push('', 'Closest lines:', ...cite);
    lines.push('', 'Not found for certain. Search it yourself: atris memory search "word|other word"');
    return lines;
  }
  const hits = (data && data.search && data.search.hits) || [];
  const lines = [String((data && data.note) || 'No answer right now.')];
  if (hits.length) lines.push('', 'Lines that may hold it:', ...hits.slice(0, 8).map((h) => `  ${h.path}:${h.n}: ${h.text}`));
  return lines;
}

function readLines(data) {
  const page = (data && data.lines) || [];
  const total = Number(data && data.total) || 0;
  if (!page.length) return [total ? `${data.path} has ${total} lines; none from there.` : `${data.path} is empty.`];
  const width = String(page[page.length - 1].n).length;
  const lines = page.map((line) => `${String(line.n).padStart(Math.max(width, 3))}  ${line.text}`);
  if (data.more) {
    const last = page[page.length - 1].n;
    lines.push(`(lines ${page[0].n}-${last} of ${total}. Next: atris memory read ${data.path} --from ${last + 1})`);
  }
  return lines;
}

function lsLines(folder, data) {
  const items = (data && data.items) || [];
  if (!items.length) return [folder ? `Nothing in ${folder} yet.` : 'Your Atris memory folder is empty so far.'];
  const width = Math.max(...items.map((item) => String(item.name).length)) + 2;
  return items.map((item) => {
    const name = String(item.name);
    const note = name.endsWith('/') ? `${item.files} ${item.files === 1 ? 'file' : 'files'}` : size(item.size);
    return `${name.padEnd(width)}${note}`;
  });
}

// ---------------------------------------------------------------- rules block

const BEGIN = '<!-- atris-memory:begin -->';
const END = '<!-- atris-memory:end -->';

// What a person pastes into AGENTS.md, CLAUDE.md, .cursorrules or Codex
// instructions. Plain words, under 15 lines.
function rulesBlock(agent) {
  const as = agent || '<your-name>';
  return [
    BEGIN,
    '## Atris memory',
    '',
    'This person keeps one memory in Atris that every app and agent shares. Use it.',
    '- Start each task with `atris memory show`: who they are and what matters now.',
    '- Before you ask them anything they may have said before, search: `atris memory search "word|other word"`, or ask in plain words: `atris memory ask "..."`.',
    '- Open what you find with `atris memory read <path>`. `atris memory ls` shows the folder.',
    '- When they say remember, note, save or don\'t forget, save one short line: `atris memory remember "..."`.',
    '- Save only lasting facts about them, never logs or your own work. Never rewrite their about.md.',
    '- Put what you learn on a topic in a page: `atris memory write wiki/<topic>.md --file <file>`.',
    `- Keep your notebook. After a task: \`atris memory log "what you did" --as ${as}\`.`,
    `- A lesson that raised a score: \`atris memory lesson "..." --before 3 --after 5 --as ${as}\`.`,
    '- Every command takes --json. If one says not logged in, ask them to run `atris login`.',
    END,
  ].join('\n');
}

// The text with exactly one rules block: replaced where it was, else added at
// the end. Nothing outside the markers changes. Line endings follow the file.
function upsertBlock(existing, block) {
  const text = String(existing || '');
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const body = block.replace(/\r?\n/g, eol);
  const spans = [];
  for (let from = 0; ;) {
    const start = text.indexOf(BEGIN, from);
    if (start === -1) break;
    const end = text.indexOf(END, start + BEGIN.length);
    if (end === -1) {
      throw new Error(`found ${BEGIN} with no ${END} after it. Fix that by hand, then run this again.`);
    }
    spans.push([start, end + END.length]);
    from = end + END.length;
  }
  if (!spans.length) {
    if (!text) return { text: `${body}${eol}`, action: 'added' };
    const gap = text.endsWith(eol) ? eol : `${eol}${eol}`;
    return { text: `${text}${gap}${body}${eol}`, action: 'added' };
  }
  let next = text.slice(0, spans[0][0]) + body;
  for (let i = 0; i < spans.length; i += 1) {
    const until = i + 1 < spans.length ? spans[i + 1][0] : text.length;
    let between = text.slice(spans[i][1], until);
    if (i + 1 < spans.length && between.trim() === '') between = ''; // a pasted-twice copy goes, with its gap
    next += between;
  }
  return { text: next, action: next === text ? 'unchanged' : 'replaced' };
}

function writeRulesFile(file, block, cwd = process.cwd()) {
  const abs = path.resolve(cwd, file);
  let existing = '';
  try {
    if (fs.statSync(abs).isDirectory()) throw new Error(`${file} is a folder. Name a rules file, like AGENTS.md.`);
    existing = fs.readFileSync(abs, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const { text, action } = upsertBlock(existing, block);
  if (action !== 'unchanged') {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text); // in place, so a linked AGENTS.md stays a link
  }
  return { path: abs, action };
}

// Install lines for apps that speak MCP. The address is the same server the
// CLI talks to, at /mcp (backend docs/MCP.md has the same wording).
function mcpSetup(apiBase) {
  let origin;
  try { origin = new URL(apiBase).origin; } catch { return null; }
  const url = `${origin}/mcp`;
  const cursor = JSON.stringify({ mcpServers: { atris: { type: 'http', url, headers: { Authorization: 'Bearer atris_YOUR_KEY' } } } });
  return {
    url,
    key: 'atris api-key create memory',
    claude_code: `claude mcp add --transport http atris ${url} --header "Authorization: Bearer atris_YOUR_KEY"`,
    codex: `codex mcp add atris --url ${url} --bearer-token-env-var ATRIS_API_KEY`,
    cursor,
  };
}

function mcpLines(setup) {
  if (!setup) return [];
  return [
    'Apps that speak MCP get the same memory through the Atris connection.',
    `Make a key first: ${setup.key}, then put it where atris_YOUR_KEY is.`,
    `  Claude Code: ${setup.claude_code}`,
    `  Codex:       ${setup.codex}`,
    '               (with ATRIS_API_KEY=atris_YOUR_KEY set where Codex runs)',
    `  Cursor:      in ~/.cursor/mcp.json: ${setup.cursor}`,
  ];
}

module.exports = {
  BEGIN,
  END,
  LIVE_HELP,
  USAGE_LINES,
  askLines,
  isLiveCommand,
  lsLines,
  mcpLines,
  mcpSetup,
  noteBody,
  parseLiveArgs,
  plainNumber,
  positiveInt,
  readLines,
  rulesBlock,
  searchLines,
  showText,
  size,
  upsertBlock,
  writeRulesFile,
};
