'use strict';

const SHORT_LOOKUP_MAX_CHARS = 140;
const LONG_INPUT_MIN_CHARS = 1200;

const LOOKUP_WORD_RE = /\b(?:what|who|when|where|list|show|define)\b/i;
const HEAVY_REASONING_RE = /\b(?:design(?:s|ed|ing)?|architect(?:s|ed|ing)?|prov(?:e|es|ed|ing)|analy(?:ze|zes|zed|zing|se|ses|sed|sing)|compar(?:e|es|ed|ing)|plan(?:s|ned|ning)?)\b|\btrade[- ]?offs?\b/i;
const CODE_EDIT_RE = /\b(?:fix(?:es|ed|ing)?|refactor(?:s|ed|ing)?|renam(?:e|es|ed|ing)|debug(?:s|ged|ging)?)\b/i;
const CODE_CONTEXT_RE = /```|(?:^|\n)\s*(?:traceback\b|(?:[a-z]+)?(?:error|exception):|at\s+\S+\s+\()/im;

function threshold(value, fallback) {
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function pickLane(message, opts = {}) {
  const text = String(message || '').trim();
  const shortLookupMaxChars = threshold(opts.shortLookupMaxChars, SHORT_LOOKUP_MAX_CHARS);
  const longInputMinChars = threshold(opts.longInputMinChars, LONG_INPUT_MIN_CHARS);
  const questionCount = (text.match(/\?/g) || []).length;

  if (text.length > longInputMinChars) {
    return { lane: 'max', reason: 'max fits this long input.' };
  }
  if (questionCount > 1) {
    return { lane: 'max', reason: 'max fits a request with multiple questions.' };
  }
  if (HEAVY_REASONING_RE.test(text)) {
    return { lane: 'max', reason: 'max fits this reasoning-heavy request.' };
  }
  if (CODE_EDIT_RE.test(text) && CODE_CONTEXT_RE.test(text)) {
    return { lane: 'code-fast', reason: 'code-fast fits this bounded code edit.' };
  }
  if (text.length <= shortLookupMaxChars && LOOKUP_WORD_RE.test(text)) {
    return { lane: 'fast', reason: 'fast fits this short factual lookup.' };
  }
  return { lane: 'pro', reason: 'pro fits this general request.' };
}

module.exports = {
  LONG_INPUT_MIN_CHARS,
  SHORT_LOOKUP_MAX_CHARS,
  pickLane,
};
