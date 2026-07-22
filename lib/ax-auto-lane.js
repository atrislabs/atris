'use strict';

const SHORT_LOOKUP_MAX_CHARS = 140;
const LONG_INPUT_MIN_CHARS = 1200;
const TINY_MESSAGE_MAX_CHARS = 20;
const GREETING_MAX_CHARS = 40;
const DECISION_FACTOR_MIN_COMMAS = 3;
const TRADEOFF_DEPTH_MIN_CHARS = 100;

// Anchored to the start: a lookup word mid-sentence is usually a subordinate
// clause (my fan spins when i run tests), not a lookup.
const LOOKUP_START_RE = /^(?:(?:please|pls|hey|hi|yo)[,: ]+)?(?:whats|whos|wheres|whens|what|who|when|where|list|show|define)\b/i;
// Words that turn a lookup-shaped message into a judgment call: never fast.
const JUDGMENT_WORD_RE = /\b(?:should|tradeoffs?|better|best|recommend|worth|good way)\b/i;
const HEAVY_REASONING_RE = /\b(?:design(?:s|ed|ing)?|architect(?:s|ed|ing)?|prov(?:e|es|ed|ing)|analy(?:ze|zes|zed|zing|se|ses|sed|sing)|compar(?:e|es|ed|ing)|plan(?:s|ned|ning)?|sketch(?:es|ed|ing)?)\b|\bwalk(?:s|ed|ing)? (?:me |us )?through\b/i;
const DECISION_PHRASE_RE = /\b(?:should|whether|decide|deciding)\b/i;
const ARGUE_BOTH_RE = /\bargue\b|\bboth sides\b|\bsteelman\b|\bmath it out\b|\bdo the math\b|\bshow your math\b/i;
const CODE_EDIT_RE = /\b(?:fix(?:es|ed|ing)?|refactor(?:s|ed|ing)?|renam(?:e|es|ed|ing)|debug(?:s|ged|ging)?)\b/i;
const CODE_DIAGNOSIS_RE = /\bwhy\b|\bwrong\b|\bbug\b|\bfail(?:s|ed|ing)?\b|\bresolv(?:e|es|ed|ing)?\b|\bbroken\b|\bnot work/i;
const CODE_CONTEXT_RE = /```|\bregexp?\b|(?:^|\n)\s*(?:traceback\b|(?:[a-z]+)?(?:error|exception):|at\s+\S+\s+\()/im;
const ERROR_EXPLAIN_RE = /\bexplain (?:this|the) error\b|\bwhat does (?:this|the) error mean\b/i;
// Yes/no capability checks are lookups even without a lookup keyword.
const YESNO_LOOKUP_RE = /^(?:does|is|are|can|do)\b/i;
// Tiny how-do-i asks are muscle-memory lookups; longer ones are advice.
const HOWTO_LOOKUP_RE = /^how (?:do|does|did) (?:i|we|you)\b/i;
const HOWTO_LOOKUP_MAX_CHARS = 40;
const YESNO_LOOKUP_MAX_CHARS = 80;
// Abstract topics have no cheap correct answer even when the ask is short.
const DEEP_TOPIC_RE = /\b(?:consciousness|free will|sentien\w*|computab\w*|meaning of life|the universe|morality|ethics of)\b/i;
// Troubleshooting language means advice, not recall: keep it out of fast.
const TROUBLE_RE = /\bfail(?:s|ed|ing)?\b|\bcrash(?:es|ed|ing)?\b|\bbroken\b|\bnot working\b/i;
const WEIGHING_WORD_RE = /\b(?:consider|weigh|rank|estimate|think (?:about|through))\b/i;
const WEIGHING_FACTOR_MIN_COMMAS = 2;
const TRANSFORM_START_RE = /^(?:convert|summarize|translate)\b/i;
// Reshaping pasted content is editing work, not analysis; question marks
// inside the paste do not make it a multi-question ask.
const TRANSFORM_INTENT_RE = /^(?:turn|clean up|rewrite|reword|compress|tighten|polish)\b/i;
// Possessives point at workspace context the model must gather first.
const OWN_CONTEXT_RE = /\b(?:our|my)\b/i;
const SPANISH_LOOKUP_RE = /^(?:que|qu\u00e9|cual|cu\u00e1l|quien|qui\u00e9n|cuando|cu\u00e1ndo|donde|d\u00f3nde|como|c\u00f3mo)\b/i;
const GREETING_RE = /^(?:hey|hi|hello|yo|thanks|thank you|ok|okay|cool|nice|got it|great|perfect|yep|no worries)\b/i;

function threshold(value, fallback) {
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function pickLane(message, opts = {}) {
  const text = String(message || '').trim();
  const shortLookupMaxChars = threshold(opts.shortLookupMaxChars, SHORT_LOOKUP_MAX_CHARS);
  const longInputMinChars = threshold(opts.longInputMinChars, LONG_INPUT_MIN_CHARS);
  const questionCount = (text.match(/\?/g) || []).length;
  const commaCount = (text.match(/,/g) || []).length;
  const hasCodeContext = CODE_CONTEXT_RE.test(text);

  if (text.length > longInputMinChars) {
    return { lane: 'max', reason: 'max fits this long input.' };
  }
  if (TRANSFORM_INTENT_RE.test(text) && !HEAVY_REASONING_RE.test(text)) {
    return { lane: 'pro', reason: 'pro fits reshaping the content you pasted.' };
  }
  if (questionCount > 1) {
    return { lane: 'max', reason: 'max fits a request with multiple questions.' };
  }
  if (ARGUE_BOTH_RE.test(text)
    || (DECISION_PHRASE_RE.test(text) && commaCount >= DECISION_FACTOR_MIN_COMMAS)
    || (WEIGHING_WORD_RE.test(text) && commaCount >= WEIGHING_FACTOR_MIN_COMMAS)) {
    return { lane: 'max', reason: 'max fits a decision weighing several factors.' };
  }
  if (HEAVY_REASONING_RE.test(text)) {
    return { lane: 'max', reason: 'max fits this reasoning-heavy request.' };
  }
  if (/\btrade[- ]?offs?\b/i.test(text) && text.length > TRADEOFF_DEPTH_MIN_CHARS) {
    return { lane: 'max', reason: 'max fits this tradeoff analysis.' };
  }
  if (hasCodeContext && (CODE_EDIT_RE.test(text) || CODE_DIAGNOSIS_RE.test(text))) {
    return { lane: 'code-fast', reason: 'code-fast fits this bounded code task.' };
  }
  if (ERROR_EXPLAIN_RE.test(text) && !hasCodeContext) {
    return { lane: 'fast', reason: 'fast fits a plain error explanation.' };
  }
  if (SPANISH_LOOKUP_RE.test(text) && text.length <= shortLookupMaxChars
    && !JUDGMENT_WORD_RE.test(text) && !TROUBLE_RE.test(text)) {
    return { lane: 'fast', reason: 'fast fits this short lookup.' };
  }
  if (TRANSFORM_START_RE.test(text) && text.length <= shortLookupMaxChars
    && !OWN_CONTEXT_RE.test(text)) {
    return { lane: 'fast', reason: 'fast fits this small transform.' };
  }
  if (GREETING_RE.test(text) && text.length <= GREETING_MAX_CHARS) {
    return { lane: 'fast', reason: 'fast fits a quick reply.' };
  }
  if (text.length > 0 && text.length <= TINY_MESSAGE_MAX_CHARS && !CODE_EDIT_RE.test(text)) {
    return { lane: 'fast', reason: 'fast fits this tiny message.' };
  }
  if (text.length <= HOWTO_LOOKUP_MAX_CHARS
    && HOWTO_LOOKUP_RE.test(text)
    && !JUDGMENT_WORD_RE.test(text)
    && !TROUBLE_RE.test(text)) {
    return { lane: 'fast', reason: 'fast fits this quick how-to.' };
  }
  if (text.length <= YESNO_LOOKUP_MAX_CHARS
    && YESNO_LOOKUP_RE.test(text)
    && !JUDGMENT_WORD_RE.test(text)
    && !TROUBLE_RE.test(text)
    && !DEEP_TOPIC_RE.test(text)) {
    return { lane: 'fast', reason: 'fast fits this yes or no lookup.' };
  }
  if (text.length <= shortLookupMaxChars
    && LOOKUP_START_RE.test(text)
    && !JUDGMENT_WORD_RE.test(text)
    && !TROUBLE_RE.test(text)
    && !DEEP_TOPIC_RE.test(text)) {
    return { lane: 'fast', reason: 'fast fits this short factual lookup.' };
  }
  return { lane: 'pro', reason: 'pro fits this general request.' };
}

module.exports = {
  LONG_INPUT_MIN_CHARS,
  SHORT_LOOKUP_MAX_CHARS,
  TINY_MESSAGE_MAX_CHARS,
  pickLane,
};
