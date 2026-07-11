#!/usr/bin/env node

const fs = require('node:fs');

const HTML_TAG_RE = /<!doctype\s+html|<\/?(?:html|head|body|div|section|article|main|table|thead|tbody|tr|td|th|p|br|span|h[1-6]|ul|ol|li|style|script|a|img|strong|em)\b[^>]*>/i;
const ENCODED_HTML_RE = /&lt;\/?(?:html|head|body|div|table|tr|td|p|span|h[1-6]|ul|ol|li|style|script|svg)\b/i;
const RENDERED_SOURCE_FENCE_RE = /```\s*(?:html|xml|jsx|tsx|css|svg|mermaid)\b/i;
const COACH_INTERNAL_RE = /(?:\b(?:CLI|WEB|BE)-\d+\b|\b[0-9A-HJKMNP-TV-Z]{26}\b|\bmission-[a-z0-9-]+|(?:^|\s)--[a-z][a-z-]*\b|(?:^|\s)(?:\.atris|atris\/runs)\/|(?:^|\s)\/(?:Users|home|workspace|tmp)\/\S+)/im;
const COACH_PRESSURE_RE = /\b(?:asap|urgent|time-sensitive|immediately|friendly reminder|just checking in|you still haven'?t|don'?t forget|why haven'?t you|you need to|productive day|great work|nice work|good job|keep the streak)\b/i;

const SLOP_RULES = [
  {
    id: 'copy-slop-corporate-filler',
    re: /\b(?:revolutionary|game[- ]changing|cutting[- ]edge|seamlessly|effortlessly|robust|powerful|comprehensive|leverage|utilize|facilitate|synergy|holistic|pivotal|crucial|unlock|supercharge)\b/i,
    message: 'copy contains corporate filler or hype',
  },
  {
    id: 'copy-slop-ai-tell',
    re: /\b(?:it'?s worth noting that|as you can see|in order to|at the end of the day|great question|absolutely)\b/i,
    message: 'copy contains an AI-tell phrase',
  },
  {
    id: 'copy-slop-punctuation',
    re: /[\u2014\u2728\u{1F680}\u{1F4A1}\u{1F3AF}]/u,
    message: 'copy contains punctuation or decorative symbols blocked by the anti-slop gate',
  },
];

const VALID_FORMATS = new Set(['plain', 'html', 'markdown', 'visual', 'source']);
const VALID_COACH_SURFACES = new Set(['morning', 'evening', 'warm-ping']);

function usage() {
  return [
    'Usage:',
    '  node scripts/outbound-artifact-gate.js --channel email --format plain --body-file body.txt',
    '  node scripts/outbound-artifact-gate.js --channel email --format html --body-file body.html --proof-file render.txt',
    '',
    'Options:',
    '  --channel <email|slack|doc|deck|web|other>',
    '  --format <plain|html|markdown|visual|source>',
    '  --body <text>',
    '  --body-file <path>',
    '  --proof-file <path>   Required for html and visual formats',
    '  --coach-surface <morning|evening|warm-ping>',
    '  --signal-proof <path> Required for a warm-ping coach surface',
    '  --visual              Require visual proof even when format is not visual',
    '  --allow-slop          Skip anti-slop copy checks',
  ].join('\n');
}

function parseArgs(argv) {
  const options = {
    channel: 'other',
    format: 'plain',
    body: '',
    bodyFile: null,
    proofFile: null,
    coachSurface: null,
    signalProof: null,
    visual: false,
    allowSlop: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      throw new Error(`Unexpected argument: ${arg}`);
    }

    const eq = arg.indexOf('=');
    const key = (eq === -1 ? arg.slice(2) : arg.slice(2, eq)).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const inlineValue = eq === -1 ? null : arg.slice(eq + 1);

    if (key === 'help') {
      options.help = true;
      continue;
    }
    if (key === 'visual' || key === 'allowSlop') {
      options[key] = true;
      continue;
    }

    const value = inlineValue !== null ? inlineValue : argv[i + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`Missing value for --${arg.slice(2)}`);
    }
    i += inlineValue === null ? 1 : 0;

    if (!Object.prototype.hasOwnProperty.call(options, key)) {
      throw new Error(`Unknown option: --${arg.slice(2)}`);
    }
    options[key] = value;
  }

  return options;
}

function readBody(options) {
  if (options.bodyFile) {
    return fs.readFileSync(options.bodyFile, 'utf8');
  }
  return String(options.body || '');
}

function proofExists(proofFile) {
  if (!proofFile) return false;
  try {
    fs.statSync(proofFile);
    return true;
  } catch (_err) {
    return false;
  }
}

function addError(errors, id, message) {
  errors.push({ id, message });
}

function scanOutboundArtifact(options, body) {
  const errors = [];
  const format = String(options.format || 'plain').toLowerCase();
  const channel = String(options.channel || 'other').toLowerCase();
  const coachSurface = options.coachSurface ? String(options.coachSurface).toLowerCase() : null;

  if (!VALID_FORMATS.has(format)) {
    addError(errors, 'invalid-format', `format must be one of ${Array.from(VALID_FORMATS).join(', ')}`);
    return errors;
  }

  if (coachSurface && !VALID_COACH_SURFACES.has(coachSurface)) {
    addError(errors, 'invalid-coach-surface', `coach surface must be one of ${Array.from(VALID_COACH_SURFACES).join(', ')}`);
  }

  const sendsSource = format === 'source';
  const needsRenderProof = format === 'html' || format === 'visual' || options.visual;

  if (format === 'plain' && (HTML_TAG_RE.test(body) || ENCODED_HTML_RE.test(body))) {
    addError(errors, 'raw-html-in-plain-body', 'plain body contains HTML source; send rendered HTML or rewrite as plain text');
  }

  if (!sendsSource && RENDERED_SOURCE_FENCE_RE.test(body)) {
    addError(errors, 'rendered-source-fence', 'body contains source that should be rendered before sending');
  }

  if (channel === 'email' && format === 'markdown' && RENDERED_SOURCE_FENCE_RE.test(body)) {
    addError(errors, 'markdown-email-source', 'email body contains fenced rendered source; attach source intentionally or render it first');
  }

  if (needsRenderProof && !proofExists(options.proofFile)) {
    addError(errors, 'render-proof-missing', 'HTML or visual sends need --proof-file with preview, screenshot, PDF, or rendered-email receipt');
  }

  if (coachSurface) {
    if (COACH_INTERNAL_RE.test(body)) {
      addError(errors, 'coach-internal-language', 'coach copy contains an internal id, flag, or path');
    }
    if (COACH_PRESSURE_RE.test(body)) {
      addError(errors, 'coach-pressure-language', 'coach copy contains urgency, guilt, nagging, or generic productivity praise');
    }
    if (coachSurface === 'warm-ping' && !proofExists(options.signalProof)) {
      addError(errors, 'coach-signal-proof-missing', 'warm pings need --signal-proof for the fresh human event');
    }
  }

  if (!options.allowSlop) {
    for (const rule of SLOP_RULES) {
      if (rule.re.test(body)) {
        addError(errors, rule.id, rule.message);
      }
    }
  }

  return errors;
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    console.error(usage());
    process.exitCode = 2;
    return;
  }

  if (options.help) {
    console.log(usage());
    return;
  }

  let body;
  try {
    body = readBody(options);
  } catch (err) {
    console.error(`failed to read body: ${err.message}`);
    process.exitCode = 2;
    return;
  }

  const errors = scanOutboundArtifact(options, body);
  if (errors.length) {
    console.error('outbound artifact gate failed');
    for (const error of errors) {
      console.error(`- ${error.id}: ${error.message}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log('outbound artifact gate passed');
}

if (require.main === module) {
  main();
}

module.exports = {
  HTML_TAG_RE,
  RENDERED_SOURCE_FENCE_RE,
  SLOP_RULES,
  COACH_INTERNAL_RE,
  COACH_PRESSURE_RE,
  parseArgs,
  scanOutboundArtifact,
};
