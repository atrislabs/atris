'use strict';

// The dashboard's own plain-sentence check, copied from the server
// (atrisos-backend backend/routers/sentinel_router.py is_plain_sentence).
// The server refuses a whole batch of events with 422 when one title or
// detail fails it, and the CLI then keeps the batch waiting forever. So the
// CLI runs the same check before it sends, and a sentence that would fail
// is swapped for plainer words instead.
//
// Keep this in step with the server. It is stricter than plain() in
// lib/sentinel-cloud.js on purpose: versions like 15.0.0-canary.3, long
// hyphen-joined names with digits, and camelCase all fail here.

const PROSE_CHARS = /^[A-Za-z0-9 .,'():-]+$/;
const CODE_SHAPES = [
  /[A-Za-z0-9]\(/,
  /[A-Za-z0-9_] \(\s*(?:[\d\s]+|'[^)]*)\)/,
  /\([^)]*[,'][^)]*\)/,
  /[a-z][A-Z]/,
  /[A-Za-z0-9]{20,}/,
  /(?:^|\s)-+[A-Za-z0-9]/,
];
const APOSTROPHE = /[A-Za-z]'(?=[A-Za-z])/g;
const DOTTED = /[A-Za-z0-9]\.[A-Za-z0-9]/;
const VERSION = /^\d+(?:\.\d+)+$/;
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

function strip(word) {
  return word.replace(/^[.,:()]+|[.,:()]+$/g, '');
}

function secretLike(text) {
  if (SECRET_RULES.some((r) => r.test(text))) return true;
  if ((text.match(LONG_RUN) || []).some((run) => /[0-9+=]/.test(run))) return true;
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const joined = strip(word).replace(/-/g, '');
    if (word.includes('-') && joined.length >= 16 && /\d/.test(joined)) return true;
  }
  return false;
}

function serverPlain(text) {
  const s = String(text == null ? '' : text);
  if (!s || !PROSE_CHARS.test(s)) return false;
  if (s.replace(APOSTROPHE, '').includes("'")) return false;
  if (CODE_SHAPES.some((r) => r.test(s))) return false;
  for (const word of s.split(/\s+/).filter(Boolean)) {
    const core = strip(word);
    if (DOTTED.test(core) && !VERSION.test(core)) return false;
  }
  const first = s.split(' ', 1)[0].replace(/[.,:]+$/, '');
  if (SHELL_WORDS.has(first)) return false;
  return !secretLike(s);
}

module.exports = { serverPlain };
