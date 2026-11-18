'use strict';

// Plain words: one checker for text a person reads in the feed.
//
// A faithful port of the backend's services/plain_words.py (the decision
// feed's checker), so a card written locally passes or fails the same way it
// would in the cloud. Two profiles share these rules:
//
// - isPlainSentence: the strict allowlist (letters, digits, spaces and
//   . , ' ( ) : - only, no code shapes, no secrets).
// - plumbingWords: the feed's check. Owner-facing text may use any
//   punctuation ($50? 24/7!), but it must not carry plumbing talk: task codes,
//   commit hashes, branch names, file paths, pull request links, command
//   lines, code, secrets, or the internal nouns in INTERNAL_NOUNS. It returns
//   the exact words to remove, so a writer can rewrite instead of guessing.

const PROSE_CHARS = /^[A-Za-z0-9 .,'():-]+$/;
const CODE_SHAPES = [
  /[A-Za-z0-9]\(/, // a call shape: word(
  /[A-Za-z0-9_] \(\s*(?:[\d\s]+|'[^)]*)\)/, // print (123), f ('x')
  /\([^)]*[,'][^)]*\)/, // argument lists
  /[a-z][A-Z]/, // camelCase
  /[A-Za-z0-9]{20,}/, // tokens and long ids
  /(?:^|\s)-+[A-Za-z0-9]/, // command flags: -rf, --force
];
const APOSTROPHE = /[A-Za-z]'(?=[A-Za-z])/g;
const DOTTED = /[A-Za-z0-9]\.[A-Za-z0-9]/;
const VERSION = /^\d+(?:\.\d+)+$/;
// A sentence that opens with one of these, lowercase, is a command line.
const SHELL_WORDS = new Set((
  'rm sudo su curl wget chmod chown bash sh zsh eval exec npm npx pip pip3 git python python3 node '
  + 'cat echo kill dd mkfs ssh scp mv cp ls cd export source docker kubectl brew apt yum'
).split(' '));
const SECRET_RULES = [
  /-----BEGIN (?:RSA |EC |OPENSSH |PGP |DSA |ENCRYPTED )?PRIVATE KEY-----/,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
  /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
  /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]{20,}/,
  /\b(?:sk-proj-[A-Za-z0-9_-]{32,}|sk-[A-Za-z0-9]{32,})\b/,
  /\bsk-ant-[A-Za-z0-9_-]{20,}\b/,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
  /\b[rs]k_live_[A-Za-z0-9]{20,}\b/,
  /\bnpm_[A-Za-z0-9]{36}\b/,
  /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}\b/,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{24,}/,
  /\b(?:password|passwd|pwd|secret|api[_-]?key|apikey|access[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key)\b\s*[:=]\s*(['"`])[^'"`\s]{8,}\1/i,
  /[0-9a-fA-F]{40,}/,
];
const LONG_RUN = /[A-Za-z0-9+/=_-]{40,}/g;

// Python's str.split() with no argument: split on runs of whitespace, no empties.
function words(text) {
  return String(text).split(/\s+/).filter(Boolean);
}

// Python's str.strip(chars).
function stripChars(value, chars) {
  let start = 0;
  let end = value.length;
  while (start < end && chars.includes(value[start])) start += 1;
  while (end > start && chars.includes(value[end - 1])) end -= 1;
  return value.slice(start, end);
}

// What a person is told when their words are refused for holding a password
// or key. The desktop shows it as said, under the card.
const SECRET_REFUSED = 'That looks like it holds a password or key, so it was not saved.';

function secretLike(text) {
  if (SECRET_RULES.some((rule) => rule.test(text))) return true;
  // Long encoded runs holding a digit, plus or equals sign; long hyphenated
  // words have none.
  for (const run of text.match(LONG_RUN) || []) {
    if (/[0-9+=]/.test(run)) return true;
  }
  // Short hyphen-joined segments that add up to a token, like a Slack or
  // license key split with dashes.
  for (const word of words(text)) {
    const joined = stripChars(word, '.,:()').replace(/-/g, '');
    if (word.includes('-') && joined.length >= 16 && /\d/.test(joined)) return true;
  }
  return false;
}

function isPlainSentence(text) {
  if (!text || !PROSE_CHARS.test(text)) return false;
  if (text.replace(APOSTROPHE, '').includes("'")) return false; // quotes, not in-word apostrophes
  if (CODE_SHAPES.some((shape) => shape.test(text))) return false;
  // a.b means a path or member, unless the word is only digits and dots (a version like 8.3.3)
  for (const word of words(text)) {
    const core = stripChars(word, '.,:()');
    if (DOTTED.test(core) && !VERSION.test(core)) return false;
  }
  const first = stripRight(text.split(' ', 1)[0], '.,:');
  if (SHELL_WORDS.has(first)) return false;
  return !secretLike(text);
}

function stripRight(value, chars) {
  let end = value.length;
  while (end > 0 && chars.includes(value[end - 1])) end -= 1;
  return value.slice(0, end);
}

// ------------------------------------------------------------ feed profile

// Internal nouns of software plumbing. A person steering a team should never
// need them; the writer keeps raw technical text in a card's detail instead.
const INTERNAL_NOUNS = [
  'worktree', 'worktrees', 'branch', 'branches', 'commit', 'commits', 'committed',
  'merge', 'merges', 'merged', 'merging', 'pull request', 'pull requests',
  'endpoint', 'endpoints', 'migration', 'migrations', 'schema', 'schemas',
  'repo', 'repos', 'stderr', 'stdout', 'json', 'api route', 'api routes',
];
const escapeRe = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const NOUN_RE = new RegExp(
  `\\b(${[...INTERNAL_NOUNS].sort((a, b) => b.length - a.length).map(escapeRe).join('|')})\\b`,
  'gi',
);
const PR_RE = /\bPRs?\b/g; // PR, PRs (capital only: "pr" is in words)
const TASK_CODE = /\b[A-Z][A-Z0-9]{1,9}-\d+\b/g; // ABC-123
const HEX = /\b[0-9a-f]{7,40}\b/g; // commit hashes, with a digit and a letter
const URL_RE = /\bhttps?:\/\/\S+|\bwww\.\S+/gi;
const URL_START = /^(?:\bhttps?:\/\/\S+|\bwww\.\S+)/i;
const PR_URL = /\/(?:pull|pulls|merge_requests|commit|commits|compare|tree|blob)\//i;
const FILE_EXT = /\b[\w-]+\.(?:py|js|jsx|ts|tsx|mjs|cjs|md|json|sql|sh|ya?ml|toml|txt|log|env|css|html|lock|cfg|ini)\b/gi;
const CALL = /\b[A-Za-z_][A-Za-z0-9_]*\(/g; // word(
const FLAG = /(?:^|\s)(--?[A-Za-z][\w-]*)/g; // --as, -rf
const SNAKE = /\b[a-z0-9]+(?:_[a-z0-9]+)+\b/g; // snake_case names
const CAMEL = /\b[a-z]+[A-Z][A-Za-z0-9]*\b/g; // camelCase (LinkedIn and YouTube start upper)
const CAMEL_OK = new Set(['iPhone', 'iPad', 'iPod', 'iOS', 'iCloud', 'iMessage', 'iMac', 'macOS', 'eBay', 'watchOS']);
const CODE_MARKS = /`|```|=>|==|!=|::|\{|\}|;\s*$|\$\(/g;
const COMMAND_WORDS = new Set([...SHELL_WORDS, ...'atris pytest make yarn pnpm gh npx uv poetry'.split(' ')]);

function add(found, fragment) {
  const clean = String(fragment || '').trim();
  if (clean && !found.includes(clean)) found.push(clean);
}

function all(pattern, text, group = 0) {
  return [...text.matchAll(pattern)].map((match) => match[group]);
}

// The words a person should not have to read, in order. Empty means plain.
function plumbingWords(value) {
  const text = String(value ?? '');
  const found = [];
  for (const url of all(URL_RE, text)) {
    const lower = url.toLowerCase();
    if (PR_URL.test(url) || lower.includes('github.com') || lower.includes('gitlab')) add(found, url);
  }
  for (const word of words(text)) {
    const core = stripChars(word, '.,;:!?()[]"\'');
    // Paths and branch names: two or more slashes, or one leading slash or tilde.
    const slashes = (core.match(/\//g) || []).length;
    if (slashes >= 2 || ((core.startsWith('/') || core.startsWith('~/')) && core.length > 1)) {
      if (!URL_START.test(core)) add(found, core);
    }
  }
  for (const match of all(TASK_CODE, text)) add(found, match);
  for (const match of all(HEX, text)) {
    if (/\d/.test(match) && /[a-f]/.test(match)) add(found, match);
  }
  for (const pattern of [FILE_EXT, CALL, SNAKE]) {
    for (const match of all(pattern, text)) add(found, match);
  }
  for (const match of all(CAMEL, text)) {
    if (!CAMEL_OK.has(match)) add(found, match);
  }
  for (const match of all(FLAG, text, 1)) add(found, match);
  for (const match of all(CODE_MARKS, text)) add(found, match);
  for (const match of all(NOUN_RE, text, 1)) add(found, match);
  for (const match of all(PR_RE, text)) add(found, match);
  const trimmed = text.trim();
  const first = trimmed ? stripRight(trimmed.split(' ', 1)[0], '.,:') : '';
  if (COMMAND_WORDS.has(first)) add(found, first);
  if (secretLike(text) || /[A-Za-z0-9]{24,}/.test(text)) add(found, 'a long code or key');
  return found;
}

function isPlainWords(text) {
  return plumbingWords(text).length === 0;
}

module.exports = {
  isPlainSentence,
  isPlainWords,
  plumbingWords,
  SECRET_REFUSED,
  secretLike,
};
