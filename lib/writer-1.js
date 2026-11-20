'use strict';

// writer-1: a compound writing model built on Atris's three-tier harness.
//
//   Stage 1 (pro  / Terra low):          fast compute action & repo/context gather
//   Stage 2 (max  / Neon low):           writes the real piece & drives flow beats fast
//   Stage 3 (fast / atris:fast):         light grammar & typo pass only (1.8s)
//   Stage 4 (local slop gate):           deterministic prose lint (zero latency)
//
// Hard anti-over-correction guard: if the light editor rewrites voice beyond
// maxEditRatio (default 0.15) or swings length by >25%, keep Neon's draft and
// run only deterministic prose cleanup. No weird rewrite loops.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { WRITER_1_DEFAULT_MODELS, currentClaudeModel } = require('./model-names');

const WRITER_1_STAGES = Object.freeze({
  gather: Object.freeze({
    name: 'gather',
    tier: 'pro',
    engine: 'codex',
    model: WRITER_1_DEFAULT_MODELS.gather,
    effort: 'low',
    timeoutMs: 90000,
  }),
  write: Object.freeze({
    name: 'write',
    tier: 'max',
    engine: 'agy',
    model: WRITER_1_DEFAULT_MODELS.write,
    effort: '',
    timeoutMs: 120000,
  }),
  edit: Object.freeze({
    name: 'edit',
    tier: 'fast',
    engine: 'atris-fast',
    model: 'atris:fast',
    effort: '',
    timeoutMs: 45000,
  }),
});

const DEFAULT_MAX_EDIT_RATIO = 0.15;
const DEFAULT_MAX_LENGTH_DRIFT = 0.25;

// Deterministic prose slop patterns aligned with commands/slop.js and atris/policies/writing.md.
const HYPE_COPY_RE = new RegExp(
  '\\b(' + [
    'boost your produc' + 'tivity',
    'super' + 'charge',
    'un' + 'leash',
    'game[- ]?chang(?:er|ing)',
    'seam' + 'lessly',
    'effort' + 'lessly',
    'revolution' + 'iz(?:e|ing)',
    'take your .{1,30} to the ' + 'next level',
    'elevate ' + 'your',
    'cutting[- ]' + 'edge',
    'powered by ' + 'ai',
    'next[- ]gener' + 'ation',
  ].join('|') + ')\\b',
  'gi'
);
const EM_DASH_RE = /\s*\u2014\s*/g;
const COMMA_JOIN_RE = /,(\s+)(and|but|so)\b/gi;
const HEDGE_RE = /\b(sort of|kind of|in a way|basically|actually|really|just|very)\b/gi;
const FILLER_RE = /\b(it(?:'s| is) worth noting(?: that)?|at the end of the day|needless to say|in today(?:'s|s) world|in conclusion|to be honest)\b/gi;
const CORPORATE_RE = /\b(leverage|synergy|optimize|streamline|holistic|ecosystem|paradigm|actionable insights)\b/gi;
const AI_TELL_RE = /\b(i(?:'d| would) be happy to|great question|let me know if|here(?:'s| is) the thing|delve into)\b/gi;
const RUN_ON_WORD_LIMIT = 35;

// Zero-latency deterministic writing craft analyzer aligned with atris/policies/writing.md.
// Reports rhythm metrics and concrete tells without ever altering the writer's words.
function analyzeWritingCraft(text) {
  const raw = String(text || '');
  const lines = raw.split('\n');
  let insideFence = false;
  const proseLines = [];
  const tells = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trimStart().startsWith('```')) {
      insideFence = !insideFence;
      continue;
    }
    if (insideFence) continue;
    const stripped = line.replace(/`[^`]*`/g, ' ');
    if (!stripped.trim() || /^#{1,6}\s/.test(stripped.trim())) continue;
    proseLines.push({ line: i + 1, text: stripped.trim() });

    const scan = (re, kind, note) => {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(stripped)) !== null) {
        tells.push({ kind, line: i + 1, match: m[0], note });
      }
    };
    scan(EM_DASH_RE, 'em-dash', 'use a period, colon or comma');
    scan(HYPE_COPY_RE, 'hype-copy', 'say the concrete thing instead');
    scan(COMMA_JOIN_RE, 'comma-join', 'drop the comma before the joining word');
    scan(FILLER_RE, 'filler', 'cut filler phrase');
    scan(CORPORATE_RE, 'corporate', 'use a plain everyday word');
    scan(AI_TELL_RE, 'ai-tell', 'cut generic assistant opener');
    scan(HEDGE_RE, 'hedge', 'consider cutting weak qualifier');
  }

  const sentences = [];
  for (const entry of proseLines) {
    const parts = entry.text
      .split(/(?<=[.!?])\s+/)
      .map((s) => s.trim())
      .filter((s) => tokenizeWords(s).length > 0);
    for (const part of parts) {
      sentences.push({ line: entry.line, text: part, words: tokenizeWords(part).length });
    }
  }

  const totalWords = sentences.reduce((sum, s) => sum + s.words, 0);
  const sentenceCount = sentences.length;
  const avgWordsPerSentence = sentenceCount ? Number((totalWords / sentenceCount).toFixed(1)) : 0;
  const readSeconds = totalWords ? Math.max(1, Math.round((totalWords / 200) * 60)) : 0;
  let longestSentence = null;
  for (const s of sentences) {
    if (!longestSentence || s.words > longestSentence.words) longestSentence = s;
    if (s.words > RUN_ON_WORD_LIMIT) {
      tells.push({
        kind: 'run-on',
        line: s.line,
        match: `${s.words} words`,
        note: `split sentence over ${RUN_ON_WORD_LIMIT} words`,
      });
    }
  }

  const hardTells = tells.filter((t) => t.kind !== 'hedge');
  return {
    words: totalWords,
    sentences: sentenceCount,
    avgWordsPerSentence,
    readSeconds,
    longestSentence,
    tells,
    hardTellCount: hardTells.length,
    hedgeCount: tells.length - hardTells.length,
  };
}

function tokenizeWords(text) {
  return String(text || '')
    .toLowerCase()
    .match(/[a-z0-9]+(?:'[a-z0-9]+)?/g) || [];
}

// Symmetric word-level change ratio in [0, 1]. Uses multiset difference plus
// order check on shared runs so both word swaps and rewrites register cleanly
// in O(n) without quadratic memory on long essays.
function wordDiffRatio(before, after) {
  const a = tokenizeWords(before);
  const b = tokenizeWords(after);
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0 || b.length === 0) return 1;

  const counts = new Map();
  for (const w of a) counts.set(w, (counts.get(w) || 0) + 1);
  let matched = 0;
  for (const w of b) {
    const n = counts.get(w) || 0;
    if (n > 0) {
      matched += 1;
      counts.set(w, n - 1);
    }
  }
  const denom = Math.max(a.length, b.length);
  return Number((1 - matched / denom).toFixed(4));
}

function lengthDriftRatio(before, after) {
  const a = String(before || '').trim().length;
  const b = String(after || '').trim().length;
  if (a === 0 && b === 0) return 0;
  if (a === 0 || b === 0) return 1;
  return Number((Math.abs(b - a) / a).toFixed(4));
}

// Deterministic prose cleanup that never alters voice: strips em dashes and
// commas before joining words outside fenced code blocks and inline code, and
// flags any remaining hype-copy phrases.
function cleanProseSlop(text) {
  const lines = String(text || '').split('\n');
  let insideFence = false;
  let fixedCount = 0;
  const findings = [];

  const cleaned = lines.map((line, idx) => {
    if (line.trimStart().startsWith('```')) {
      insideFence = !insideFence;
      return line;
    }
    if (insideFence) return line;

    const fixed = line.split(/(`[^`]*`)/).map((seg, segIdx) => {
      if (segIdx % 2 === 1) return seg;
      let next = seg;
      if (EM_DASH_RE.test(next)) {
        next = next.replace(EM_DASH_RE, ', ');
        fixedCount += 1;
      }
      if (COMMA_JOIN_RE.test(next)) {
        next = next.replace(COMMA_JOIN_RE, '$1$2');
        fixedCount += 1;
      }
      EM_DASH_RE.lastIndex = 0;
      COMMA_JOIN_RE.lastIndex = 0;
      return next;
    }).join('');

    const proseOnly = fixed.replace(/`[^`]*`/g, ' ');
    let match;
    HYPE_COPY_RE.lastIndex = 0;
    while ((match = HYPE_COPY_RE.exec(proseOnly)) !== null) {
      findings.push({
        rule: 'hype-copy',
        line: idx + 1,
        match: match[0],
      });
    }
    return fixed;
  });

  return {
    text: cleaned.join('\n').trim(),
    fixedCount,
    findings,
  };
}

// Guard the light editor: accept edits only when they stay within the grammar
// budget (word diff ratio and length drift). Otherwise preserve the writer's
// voice verbatim.
function evaluateLightEdit(draft, edited, options = {}) {
  const maxEditRatio = Number.isFinite(options.maxEditRatio) ? options.maxEditRatio : DEFAULT_MAX_EDIT_RATIO;
  const maxLengthDrift = Number.isFinite(options.maxLengthDrift) ? options.maxLengthDrift : DEFAULT_MAX_LENGTH_DRIFT;
  const rawDraft = String(draft || '').trim();
  const rawEdited = String(edited || '').trim();

  if (!rawEdited) {
    return {
      text: rawDraft,
      keptEditor: false,
      diffRatio: 1,
      lengthDrift: 1,
      reason: 'editor returned empty output, kept Neon draft',
    };
  }

  const diffRatio = wordDiffRatio(rawDraft, rawEdited);
  const lengthDrift = lengthDriftRatio(rawDraft, rawEdited);
  if (diffRatio > maxEditRatio || lengthDrift > maxLengthDrift) {
    return {
      text: rawDraft,
      keptEditor: false,
      diffRatio,
      lengthDrift,
      reason: `editor over-corrected (${Math.round(diffRatio * 100)}% word diff, ${Math.round(lengthDrift * 100)}% length drift), kept Neon draft`,
    };
  }

  return {
    text: rawEdited,
    keptEditor: true,
    diffRatio,
    lengthDrift,
    reason: diffRatio === 0 ? 'clean pass, no grammar fixes needed' : `applied light grammar pass (${Math.round(diffRatio * 100)}% word diff)`,
  };
}

// Fast deterministic compaction for clean mid-chat model swaps in ax.
// Preserves user goals, referenced file paths and the latest exchange without
// carrying foreign provider thinking blocks or tool-wire noise.
function buildSwapHandoff(history = [], fromMode = '', toMode = '') {
  if (!Array.isArray(history) || history.length === 0) return null;

  const userGoals = [];
  const files = new Set();
  const fileRe = /\b(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+(?:\.[A-Za-z0-9]+)?\b/g;

  for (const entry of history) {
    const content = String((entry && entry.content) || '').trim();
    if (!content) continue;
    if (entry.role === 'user') {
      const compact = content.replace(/\s+/g, ' ').slice(0, 180);
      userGoals.push(compact);
    }
    let m;
    fileRe.lastIndex = 0;
    while ((m = fileRe.exec(content)) !== null) {
      if (!m[0].startsWith('http://') && !m[0].startsWith('https://')) {
        files.add(m[0]);
      }
    }
  }

  const lastAssistant = [...history].reverse().find((item) => item && item.role === 'assistant' && String(item.content || '').trim());
  const lastSummary = lastAssistant
    ? String(lastAssistant.content).replace(/\s+/g, ' ').trim().slice(0, 320)
    : '';

  const lines = [
    `[Clean swap handoff: ${fromMode || 'previous'} -> ${toMode || 'next'} · ${history.length} prior messages compacted]`,
  ];
  if (userGoals.length) {
    lines.push(`User asks: ${userGoals.slice(-4).join(' | ')}`);
  }
  if (files.size) {
    lines.push(`Files in play: ${Array.from(files).slice(0, 10).join(', ')}`);
  }
  if (lastSummary) {
    lines.push(`Latest answer: ${lastSummary}`);
  }
  return {
    compactedCount: history.length,
    summary: lines.join('\n'),
  };
}

function buildGatherPrompt(userPrompt, contextHint = '') {
  return [
    'You are Stage 1 (Pro / Compute Action) of Atris writer-1.',
    'Read only what is needed in the current workspace to pull real, concrete facts for the writing task below.',
    'Do not edit any files. Return a tight factual brief (max 12 bullet facts, exact file names, commands, real behavior, zero fluff).',
    contextHint ? `Extra context:\n${contextHint}` : '',
    `Writing task:\n${userPrompt}`,
  ].filter(Boolean).join('\n\n');
}

function buildWritePrompt(userPrompt, brief = '', taste = '') {
  return [
    'You are Stage 2 (Max / Writer) of Atris writer-1.',
    'Write the finished piece in one strong shot. Give it your best shot, ready to publish.',
    'Style rules:',
    '- Plain, sharp, human words. Short common Anglo-Saxon words. Active voice.',
    '- Zero AI slop, zero marketing hype, zero jargon, zero em dashes.',
    '- Never put a comma before and, but or so.',
    '- Say what was built, what it actually does and why it matters. Ground every claim in the facts below.',
    '- Output ONLY the finished piece. No preamble, no meta commentary.',
    taste ? `Project taste:\n${taste}` : '',
    brief ? `Verified workspace facts from Stage 1 (Terra):\n${brief}` : '',
    `Writing task:\n${userPrompt}`,
  ].filter(Boolean).join('\n\n');
}

function buildEditPrompt(draft) {
  return [
    'You are Stage 3 (Fast / Light Editor) of Atris writer-1.',
    'Fix ONLY clear grammar, spelling, missing words or punctuation slips.',
    'HARD RULES:',
    '- Do NOT rewrite sentences, change voice, add hype, add intro/outro or expand length.',
    '- Do NOT add em dashes or commas before and, but or so.',
    '- Keep at least 90% of the exact original wording intact.',
    '- Return ONLY the edited text. No explanation, no notes, no markdown fences around the whole reply.',
    '',
    'Draft:',
    draft,
  ].join('\n');
}

// Run one stage against Atris Fast (in-process) or a local CLI (codex, agy, claude).
function runLocalStage({ engine, model, effort = '', prompt, cwd = process.cwd(), timeoutMs = 120000, onChunk = null }) {
  if (engine === 'atris-fast') {
    const startedAt = Date.now();
    const ax = require('../ax');
    return ax.runHeadlessTurn(prompt, { mode: 'fast', route: 'cloud', cwd }).then((res) => {
      if (!res || !res.ok) {
        throw new Error((res && res.error) || 'atris-fast stage failed');
      }
      const out = String(res.output || '').trim();
      if (typeof onChunk === 'function' && out) onChunk(out);
      return {
        output: out,
        durationMs: Number(res.durationMs || 0) || (Date.now() - startedAt),
        exitCode: 0,
      };
    });
  }
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    let bin = engine;
    let args = [];
    let outputFile = '';

    if (engine === 'codex') {
      outputFile = path.join(os.tmpdir(), `atris-writer1-codex-${process.pid}-${Date.now()}.txt`);
      bin = 'codex';
      args = ['exec', '--sandbox', 'read-only', '--skip-git-repo-check', '-o', outputFile];
      if (model) args.push('-m', model);
      if (effort) args.push('-c', `model_reasoning_effort=${effort}`);
      args.push(prompt);
    } else if (engine === 'agy') {
      bin = 'agy';
      args = ['--mode', 'ask', '--dangerously-skip-permissions'];
      if (model) args.push('--model', model);
      if (effort) args.push('--effort', effort);
      args.push('-p', prompt);
    } else if (engine === 'claude') {
      bin = 'claude';
      args = ['-p', '--output-format', 'text', '--setting-sources', ''];
      if (model) args.push('--model', model);
      if (effort) args.push('--effort', effort);
      args.push(prompt);
    } else {
      reject(new Error(`unsupported local writer-1 engine: ${engine}`));
      return;
    }

    const child = spawn(bin, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGTERM'); } catch {}
      if (outputFile) { try { fs.unlinkSync(outputFile); } catch {} }
      reject(new Error(`${engine} (${model || 'default'}) timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      stdout += text;
      if (typeof onChunk === 'function' && engine !== 'codex') onChunk(text);
    });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (outputFile) { try { fs.unlinkSync(outputFile); } catch {} }
      reject(err);
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      let text = stdout.trim();
      if (outputFile && fs.existsSync(outputFile)) {
        try {
          const fromFile = fs.readFileSync(outputFile, 'utf8').trim();
          if (fromFile) text = fromFile;
        } catch {}
        try { fs.unlinkSync(outputFile); } catch {}
      }

      if (code !== 0 && !text) {
        reject(new Error(`${engine} (${model || 'default'}) exited ${code}: ${stderr.trim().slice(-300) || 'no output'}`));
        return;
      }

      resolve({
        output: text,
        durationMs: Date.now() - startedAt,
        exitCode: code,
      });
    });
  });
}

function loadProjectTaste(cwd) {
  const candidates = [
    path.join(cwd, 'atris', 'taste', 'TASTE.md'),
    path.join(cwd, 'atris', 'PERSONA.md'),
  ];
  for (const file of candidates) {
    try {
      if (fs.existsSync(file)) {
        return fs.readFileSync(file, 'utf8').trim().slice(0, 1200);
      }
    } catch {}
  }
  return '';
}

// --- Flow Mode (co-writing with Neon as studio producer) -------------------

const LOCK_INTENT_RE = /^(?:\/lock|lock(?:\s+it|\s+draft|\s+this)?|ship\s+it|finalize|finish\s+draft)[.!?]*$/i;
const FACT_TRIGGER_RE = /(?:^|\s)(?:check:|fact:|@\S+|\b(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+(?:\.[A-Za-z0-9]+)?\b|`[^`]+`)/i;

function isLockIntent(message) {
  return LOCK_INTENT_RE.test(String(message || '').trim());
}

function needsFactGather(message) {
  return FACT_TRIGGER_RE.test(String(message || '').trim());
}

function createFlowSession(topic = '', slug = '') {
  return {
    schema: 'atris.writer_flow.v1',
    topic: String(topic || '').trim(),
    slug: String(slug || '').trim(),
    startedAt: new Date().toISOString(),
    beats: [],
    facts: [],
    locked: null,
  };
}

function flowSessionSlug(seed = '') {
  const clean = String(seed || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return clean || `flow-${new Date().toISOString().slice(0, 10)}`;
}

// Noteflow-compatible "Written by you" provenance record for any Flow session.
function formatWrittenByYouRecord(flowSession) {
  const beats = Array.isArray(flowSession && flowSession.beats) ? flowSession.beats : [];
  const totalWords = beats.reduce((sum, b) => sum + tokenizeWords(b.human).length, 0);
  const totalChars = beats.reduce((sum, b) => sum + String(b.human || '').length, 0);
  const title = (flowSession && flowSession.topic) || (beats[0] && beats[0].line) || 'Untitled';
  const started = (flowSession && flowSession.startedAt) || new Date().toISOString();
  const lines = [
    `# ${title}`,
    '',
    `Written by you, ${started.slice(0, 10)}`,
    `${totalWords} human words, ${totalChars} typed chars, 0 pasted, ${beats.length} flow beat${beats.length === 1 ? '' : 's'}`,
    '',
  ];
  beats.forEach((beat, idx) => {
    lines.push(`${idx + 1}. ${beat.human}`);
    if (beat.line) lines.push(`   pulled line: ${beat.line}`);
    if (beat.next) lines.push(`   question asked: ${beat.next}`);
  });
  if (flowSession && flowSession.locked) {
    lines.push('', '## Final locked draft', '', flowSession.locked);
  }
  return `${lines.join('\n')}\n`;
}

function saveFlowSession(flowSession, cwd = process.cwd()) {
  if (!flowSession) return null;
  if (!flowSession.slug) {
    const seed = flowSession.topic || (flowSession.beats[0] && flowSession.beats[0].human) || '';
    flowSession.slug = flowSessionSlug(seed);
  }
  if (!flowSession.topic && flowSession.beats[0]) {
    flowSession.topic = flowSession.beats[0].line || flowSession.beats[0].human.slice(0, 80);
  }
  const dir = path.join(cwd, 'atris', 'writing', flowSession.slug);
  fs.mkdirSync(dir, { recursive: true });
  const flowFile = path.join(dir, 'flow.json');
  fs.writeFileSync(flowFile, `${JSON.stringify({ ...flowSession, updatedAt: new Date().toISOString() }, null, 2)}\n`, 'utf8');
  const saved = { slug: flowSession.slug, dir, flowFile, draftFile: null, recordFile: null };
  if (flowSession.locked) {
    saved.draftFile = path.join(dir, 'draft.md');
    saved.recordFile = path.join(dir, 'record.md');
    fs.writeFileSync(saved.draftFile, `${flowSession.locked.trim()}\n`, 'utf8');
    fs.writeFileSync(saved.recordFile, formatWrittenByYouRecord(flowSession), 'utf8');
  }
  return saved;
}

function loadFlowSession(slug, cwd = process.cwd()) {
  const file = path.join(cwd, 'atris', 'writing', slug, 'flow.json');
  if (!fs.existsSync(file)) return null;
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  return {
    ...createFlowSession(parsed.topic || '', parsed.slug || slug),
    ...parsed,
    beats: Array.isArray(parsed.beats) ? parsed.beats : [],
    facts: Array.isArray(parsed.facts) ? parsed.facts : [],
  };
}

// --- Writer-1 Peer Reviewer (never rewrites prose) -------------------------

function buildReviewPrompt(draftText, craft) {
  return [
    'You are the Peer Reviewer in Atris writer-1.',
    'HARD RULES:',
    '- NEVER write, rewrite or offer replacement sentences for the draft.',
    '- Quote the writer\'s single strongest sentence VERBATIM from the draft.',
    '- Give 1 to 3 concrete margin critiques (at most 14 words each) naming what is vague, long or missing.',
    '- End with ONE concrete next move for the writer.',
    '- Plain everyday words. Zero em dashes. Never put a comma before and, but or so.',
    'Output EXACTLY this format:',
    'STRONGEST: <exact sentence copied verbatim from the draft>',
    'NOTE: <short concrete critique 1>',
    'NOTE: <short concrete critique 2>',
    'NEXT: <one concrete move>',
    '',
    `Craft stats: ${craft.words} words, ${craft.sentences} sentences, avg ${craft.avgWordsPerSentence} words/sentence, ${craft.hardTellCount} hard tells.`,
    '',
    'Draft:',
    draftText,
  ].join('\n');
}

function matchExactSentence(candidate, draftText) {
  const clean = String(candidate || '').trim().replace(/^["'“”]+|["'“”]+$/g, '').trim();
  if (!clean) return '';
  if (String(draftText || '').includes(clean)) return clean;
  const lower = String(draftText || '').toLowerCase();
  const idx = lower.indexOf(clean.toLowerCase());
  return idx >= 0 ? String(draftText).slice(idx, idx + clean.length) : '';
}

function parseReviewOutput(raw, draftText) {
  const lines = String(raw || '').split('\n').map((l) => l.trim()).filter(Boolean);
  let strongestLine = '';
  const notes = [];
  let nextMove = '';

  for (const line of lines) {
    const s = /^strongest\s*:\s*(.+)$/i.exec(line);
    if (s && !strongestLine) {
      strongestLine = matchExactSentence(s[1], draftText);
      continue;
    }
    const n = /^note\s*\d*\s*:\s*(.+)$/i.exec(line);
    if (n && notes.length < 3) {
      const note = cleanProseSlop(n[1].trim()).text;
      // Reject any note that quotes multi-word replacement phrasing.
      const quotedSpans = note.match(/["“'‘]([^"”'’]+)["”'’]/g) || [];
      const hasMultiWordQuote = quotedSpans.some((q) => q.slice(1, -1).trim().split(/\s+/).length > 1);
      if (note && note.split(/\s+/).length <= 16 && !hasMultiWordQuote) {
        notes.push(note);
      }
      continue;
    }
    const nx = /^next\s*:\s*(.+)$/i.exec(line);
    if (nx && !nextMove) {
      nextMove = cleanProseSlop(nx[1].trim()).text;
    }
  }

  return { strongestLine, notes, nextMove };
}

async function runWriterReview(draftText, options = {}) {
  const startedAt = Date.now();
  const text = String(draftText || '').trim();
  const craft = analyzeWritingCraft(text);
  const slop = cleanProseSlop(text);
  if (!text) {
    return {
      ok: false,
      model: 'atris:writer-1:review',
      strongestLine: '',
      notes: [],
      nextMove: 'Write at least one sentence first.',
      craft,
      slop: { fixedCount: 0, findings: [] },
      durationMs: Date.now() - startedAt,
      output: 'Nothing to review yet. Drop at least one thought first.',
    };
  }

  const stageRunner = options.stageRunner || runLocalStage;
  const writeStage = { ...WRITER_1_STAGES.write, ...(options.stages && options.stages.write) };
  let parsed = { strongestLine: '', notes: [], nextMove: '' };
  let stageStatus = 'ok';

  if (!options.offline) {
    try {
      const res = await stageRunner({
        ...writeStage,
        prompt: buildReviewPrompt(text, craft),
        cwd: options.cwd || process.cwd(),
      });
      parsed = parseReviewOutput((res && res.output) || '', text);
    } catch {
      stageStatus = 'offline';
    }
  } else {
    stageStatus = 'offline';
  }

  const outLines = [];
  if (parsed.strongestLine) outLines.push(`Strongest line: "${parsed.strongestLine}"`);
  for (const note of parsed.notes) outLines.push(`· ${note}`);
  if (parsed.nextMove) outLines.push(`Next move: ${parsed.nextMove}`);
  outLines.push(`Craft: ${craft.words} words · ${craft.sentences} sentences · avg ${craft.avgWordsPerSentence}w · ~${craft.readSeconds}s aloud · ${craft.hardTellCount} tells`);
  if (craft.tells.length) {
    for (const tell of craft.tells.slice(0, 5)) {
      outLines.push(`  line ${tell.line} (${tell.kind}): "${tell.match}" -> ${tell.note}`);
    }
  }

  return {
    ok: true,
    model: 'atris:writer-1:review',
    status: stageStatus,
    strongestLine: parsed.strongestLine,
    notes: parsed.notes,
    nextMove: parsed.nextMove,
    craft,
    slop: { fixedCount: slop.fixedCount, findings: slop.findings },
    durationMs: Date.now() - startedAt,
    output: outLines.join('\n'),
  };
}

// Run Stage 3 (Atris Fast grammar polish) with automatic Haiku fallback when offline.
async function runLightEditStage(draft, stageConfig, stageRunner, options = {}) {
  const cwd = options.cwd || process.cwd();
  const prompt = buildEditPrompt(draft);
  try {
    const editRes = await stageRunner({ ...stageConfig, prompt, cwd });
    return { editRes, usedStage: stageConfig };
  } catch (primaryErr) {
    if (stageRunner === runLocalStage && stageConfig.engine === 'atris-fast') {
      const fallbackStage = { ...stageConfig, engine: 'claude', model: currentClaudeModel('haiku') };
      const editRes = await stageRunner({ ...fallbackStage, prompt, cwd });
      return { editRes, usedStage: fallbackStage };
    }
    throw primaryErr;
  }
}

function formatFlowHistory(flowSession) {
  if (!flowSession || !Array.isArray(flowSession.beats) || flowSession.beats.length === 0) {
    return '';
  }
  return flowSession.beats
    .map((beat, idx) => {
      const parts = [`Beat ${idx + 1} (human): ${beat.human}`];
      if (beat.line) parts.push(`Beat ${idx + 1} (pulled line): ${beat.line}`);
      return parts.join('\n');
    })
    .join('\n\n');
}

function buildFlowBeatPrompt(humanInput, flowSession, factBrief = '', taste = '') {
  const prior = formatFlowHistory(flowSession);
  return [
    'You are Neon in Atris Flow Mode: a quiet, high-taste studio producer helping a human write in their own voice.',
    'YOUR JOB: keep the human in flow state. NEVER steal the pen. NEVER write the essay for them. NEVER lecture. NEVER give a list of options.',
    'Return EXACTLY two short lines in this format:',
    'Line: <the single sharpest true sentence already hiding inside their raw words, keeping their cadence>',
    'Next: <one short, concrete question that pulls the next true thought out of them>',
    'Rules:',
    '- Short, plain Anglo-Saxon words. Active voice.',
    '- Zero em dashes. Never put a comma before and, but or so.',
    '- Zero praise ("great point"), zero meta-talk, zero filler.',
    taste ? `Project taste:\n${taste}` : '',
    prior ? `Beats so far:\n${prior}` : '',
    factBrief ? `Silent fact note from Terra:\n${factBrief}` : '',
    `Human's raw thought:\n${humanInput}`,
  ].filter(Boolean).join('\n\n');
}

function parseFlowBeat(raw) {
  const text = String(raw || '').trim();
  const lineMatch = /^line\s*:\s*(.+)$/im.exec(text);
  const nextMatch = /^next\s*:\s*(.+)$/im.exec(text);
  const line = lineMatch ? cleanProseSlop(lineMatch[1].trim()).text : '';
  const next = nextMatch ? cleanProseSlop(nextMatch[1].trim()).text : '';
  if (line || next) {
    return {
      line,
      next,
      output: [line ? `Line: ${line}` : '', next ? `Next: ${next}` : ''].filter(Boolean).join('\n\n'),
    };
  }
  const cleaned = cleanProseSlop(text).text;
  const parts = cleaned.split(/\n+/).map((s) => s.trim()).filter(Boolean);
  return {
    line: parts[0] || '',
    next: parts[1] || '',
    output: cleaned,
  };
}

function buildFlowLockPrompt(flowSession, taste = '') {
  const prior = formatFlowHistory(flowSession);
  const facts = Array.isArray(flowSession && flowSession.facts) && flowSession.facts.length
    ? flowSession.facts.join('\n')
    : '';
  return [
    'You are Neon in Atris Flow Mode (Lock pass).',
    'Weave ONLY the human\'s own raw beats and pulled lines below into one clean, finished piece ready to publish.',
    'HARD RULES:',
    '- Keep the human\'s exact voice, phrasing and rhythm. Do NOT turn it into generic AI copy or release notes.',
    '- Do NOT invent new claims outside the human\'s beats and verified facts below.',
    '- Short, common Anglo-Saxon words. Active voice. Zero em dashes. Never put a comma before and, but or so.',
    '- Output ONLY the finished piece. No preamble, no notes.',
    taste ? `Project taste:\n${taste}` : '',
    facts ? `Verified facts gathered during flow:\n${facts}` : '',
    `Human beats:\n${prior}`,
  ].filter(Boolean).join('\n\n');
}

async function runFlowBeat(humanInput, flowSession = createFlowSession(), options = {}) {
  const startedAt = Date.now();
  const cwd = options.cwd || process.cwd();
  const stagesConfig = {
    gather: { ...WRITER_1_STAGES.gather, ...(options.stages && options.stages.gather) },
    write: { ...WRITER_1_STAGES.write, ...(options.stages && options.stages.write) },
  };
  const stageRunner = options.stageRunner || runLocalStage;
  const onStage = typeof options.onStage === 'function' ? options.onStage : () => {};
  const stages = [];

  let factBrief = String(options.factBrief || '').trim();
  const shouldGather = !options.skipGather && !factBrief && (options.alwaysGather || needsFactGather(humanInput));
  if (shouldGather) {
    onStage({ phase: 'start', stage: stagesConfig.gather });
    try {
      const gatherRes = await stageRunner({
        ...stagesConfig.gather,
        prompt: buildGatherPrompt(humanInput, 'Silent background fact check for Flow Mode. Return at most 5 concrete facts.'),
        cwd,
      });
      factBrief = String((gatherRes && gatherRes.output) || '').trim();
      if (factBrief) flowSession.facts.push(factBrief);
      stages.push({
        name: 'gather',
        tier: stagesConfig.gather.tier,
        engine: stagesConfig.gather.engine,
        model: stagesConfig.gather.model,
        durationMs: Number((gatherRes && gatherRes.durationMs) || 0),
        status: 'ok',
      });
      onStage({ phase: 'done', stage: stagesConfig.gather, durationMs: stages[stages.length - 1].durationMs });
    } catch (error) {
      stages.push({
        name: 'gather',
        tier: stagesConfig.gather.tier,
        engine: stagesConfig.gather.engine,
        model: stagesConfig.gather.model,
        durationMs: 0,
        status: 'skipped',
        error: String((error && error.message) || error),
      });
      onStage({ phase: 'fallback', stage: stagesConfig.gather, error: String((error && error.message) || error) });
    }
  }

  const taste = options.taste !== undefined ? String(options.taste) : loadProjectTaste(cwd);
  onStage({ phase: 'start', stage: stagesConfig.write });
  const beatRes = await stageRunner({
    ...stagesConfig.write,
    prompt: buildFlowBeatPrompt(humanInput, flowSession, factBrief, taste),
    cwd,
  });
  const parsed = parseFlowBeat((beatRes && beatRes.output) || '');
  if (!parsed.output) {
    throw new Error('writer-1 flow beat (Neon) returned empty output');
  }
  stages.push({
    name: 'flow-beat',
    tier: stagesConfig.write.tier,
    engine: stagesConfig.write.engine,
    model: stagesConfig.write.model,
    durationMs: Number((beatRes && beatRes.durationMs) || 0),
    status: 'ok',
  });
  onStage({ phase: 'done', stage: stagesConfig.write, durationMs: stages[stages.length - 1].durationMs });

  const beat = {
    human: String(humanInput || '').trim(),
    line: parsed.line,
    next: parsed.next,
    fact: factBrief,
  };
  flowSession.beats.push(beat);

  return {
    ok: true,
    phase: 'beat',
    model: 'atris:writer-1:flow',
    line: parsed.line,
    next: parsed.next,
    output: parsed.output,
    beatCount: flowSession.beats.length,
    durationMs: Date.now() - startedAt,
    stages,
  };
}

async function runFlowLock(flowSession, options = {}) {
  const startedAt = Date.now();
  if (!flowSession || !Array.isArray(flowSession.beats) || flowSession.beats.length === 0) {
    return {
      ok: false,
      phase: 'lock',
      model: 'atris:writer-1:flow',
      output: 'Drop at least one raw thought first, then type "lock it" when ready.',
      durationMs: Date.now() - startedAt,
      stages: [],
    };
  }

  const cwd = options.cwd || process.cwd();
  const stagesConfig = {
    write: { ...WRITER_1_STAGES.write, ...(options.stages && options.stages.write) },
    edit: { ...WRITER_1_STAGES.edit, ...(options.stages && options.stages.edit) },
  };
  const stageRunner = options.stageRunner || runLocalStage;
  const onStage = typeof options.onStage === 'function' ? options.onStage : () => {};
  const stages = [];
  const taste = options.taste !== undefined ? String(options.taste) : loadProjectTaste(cwd);

  onStage({ phase: 'start', stage: stagesConfig.write });
  const writeRes = await stageRunner({
    ...stagesConfig.write,
    prompt: buildFlowLockPrompt(flowSession, taste),
    cwd,
  });
  const wovenDraft = String((writeRes && writeRes.output) || '').trim();
  if (!wovenDraft) {
    throw new Error('writer-1 flow lock (Neon) returned empty output');
  }
  stages.push({
    name: 'flow-lock',
    tier: stagesConfig.write.tier,
    engine: stagesConfig.write.engine,
    model: stagesConfig.write.model,
    durationMs: Number((writeRes && writeRes.durationMs) || 0),
    status: 'ok',
  });
  onStage({ phase: 'done', stage: stagesConfig.write, durationMs: stages[stages.length - 1].durationMs });

  let guardResult = {
    text: wovenDraft,
    keptEditor: false,
    diffRatio: 0,
    lengthDrift: 0,
    reason: 'editor skipped',
  };

  if (!options.skipEdit) {
    onStage({ phase: 'start', stage: stagesConfig.edit });
    try {
      const { editRes, usedStage } = await runLightEditStage(wovenDraft, stagesConfig.edit, stageRunner, { cwd });
      const editedText = String((editRes && editRes.output) || '').trim();
      guardResult = evaluateLightEdit(wovenDraft, editedText, {
        maxEditRatio: options.maxEditRatio,
        maxLengthDrift: options.maxLengthDrift,
      });
      stages.push({
        name: 'edit',
        tier: usedStage.tier,
        engine: usedStage.engine,
        model: usedStage.model,
        durationMs: Number((editRes && editRes.durationMs) || 0),
        status: guardResult.keptEditor ? 'ok' : 'reverted',
        diffRatio: guardResult.diffRatio,
      });
      onStage({ phase: 'done', stage: usedStage, durationMs: stages[stages.length - 1].durationMs, guard: guardResult });
    } catch (error) {
      guardResult = {
        text: wovenDraft,
        keptEditor: false,
        diffRatio: 0,
        lengthDrift: 0,
        reason: `editor unavailable (${String((error && error.message) || error)}), kept Neon draft`,
      };
      stages.push({
        name: 'edit',
        tier: stagesConfig.edit.tier,
        engine: stagesConfig.edit.engine,
        model: stagesConfig.edit.model,
        durationMs: 0,
        status: 'skipped',
        error: String((error && error.message) || error),
      });
      onStage({ phase: 'fallback', stage: stagesConfig.edit, error: String((error && error.message) || error) });
    }
  }

  const slop = cleanProseSlop(guardResult.text);
  const craft = analyzeWritingCraft(slop.text);
  flowSession.locked = slop.text;
  const saved = options.persist ? saveFlowSession(flowSession, cwd) : null;

  return {
    ok: true,
    phase: 'lock',
    model: 'atris:writer-1:flow',
    output: slop.text,
    draft: wovenDraft,
    beatCount: flowSession.beats.length,
    durationMs: Date.now() - startedAt,
    stages,
    editGuard: {
      keptEditor: guardResult.keptEditor,
      diffRatio: guardResult.diffRatio,
      lengthDrift: guardResult.lengthDrift,
      reason: guardResult.reason,
    },
    slop: {
      fixedCount: slop.fixedCount,
      findings: slop.findings,
    },
    craft,
    saved,
  };
}

async function runFlowTurn(message, flowSession = createFlowSession(), options = {}) {
  const trimmed = String(message || '').trim();
  const lower = trimmed.toLowerCase();

  if (lower === 'beats' || lower === 'show beats') {
    const beats = Array.isArray(flowSession && flowSession.beats) ? flowSession.beats : [];
    const words = beats.reduce((sum, b) => sum + tokenizeWords(b.human).length, 0);
    const body = beats.length
      ? beats.map((b, i) => `${i + 1}. ${b.human}${b.line ? `\n   line: ${b.line}` : ''}`).join('\n')
      : 'No beats yet. Drop a raw thought to start.';
    return {
      ok: true,
      phase: 'beats',
      model: 'atris:writer-1:flow',
      beatCount: beats.length,
      output: `${beats.length} beat${beats.length === 1 ? '' : 's'} · ${words} human words\n${body}`,
      durationMs: 0,
      stages: [],
    };
  }

  if (lower === 'undo' || lower === 'undo beat') {
    const beats = Array.isArray(flowSession && flowSession.beats) ? flowSession.beats : [];
    if (!beats.length) {
      return {
        ok: true,
        phase: 'undo',
        model: 'atris:writer-1:flow',
        beatCount: 0,
        output: 'No beats to undo.',
        durationMs: 0,
        stages: [],
      };
    }
    const popped = beats.pop();
    if (options.persist) saveFlowSession(flowSession, options.cwd || process.cwd());
    return {
      ok: true,
      phase: 'undo',
      model: 'atris:writer-1:flow',
      beatCount: beats.length,
      output: `Dropped last beat ("${String(popped.human || '').slice(0, 60)}"). ${beats.length} beat${beats.length === 1 ? '' : 's'} left.`,
      durationMs: 0,
      stages: [],
    };
  }

  if (lower === 'review' || lower === 'review draft') {
    const draft = (flowSession && flowSession.locked)
      || (Array.isArray(flowSession && flowSession.beats) ? flowSession.beats.map((b) => b.human).join('\n\n') : '');
    const rev = await runWriterReview(draft, options);
    return { ...rev, phase: 'review', stages: [] };
  }

  if (isLockIntent(trimmed)) {
    return runFlowLock(flowSession, options);
  }
  const beatResult = await runFlowBeat(trimmed, flowSession, options);
  if (options.persist) {
    beatResult.saved = saveFlowSession(flowSession, options.cwd || process.cwd());
  }
  return beatResult;
}

async function runWriter1(prompt, options = {}) {
  const startedAt = Date.now();
  const cwd = options.cwd || process.cwd();
  const stagesConfig = {
    gather: { ...WRITER_1_STAGES.gather, ...(options.stages && options.stages.gather) },
    write: { ...WRITER_1_STAGES.write, ...(options.stages && options.stages.write) },
    edit: { ...WRITER_1_STAGES.edit, ...(options.stages && options.stages.edit) },
  };
  const stageRunner = options.stageRunner || runLocalStage;
  const onStage = typeof options.onStage === 'function' ? options.onStage : () => {};
  const stages = [];

  // Stage 1: Pro / Compute Action (GPT-6.1 Terra) gathers facts.
  let brief = String(options.brief || '').trim();
  if (!options.skipGather && !brief) {
    onStage({ phase: 'start', stage: stagesConfig.gather });
    try {
      const gatherRes = await stageRunner({
        ...stagesConfig.gather,
        prompt: buildGatherPrompt(prompt, options.contextHint || ''),
        cwd,
      });
      brief = String((gatherRes && gatherRes.output) || '').trim();
      stages.push({
        name: 'gather',
        tier: stagesConfig.gather.tier,
        engine: stagesConfig.gather.engine,
        model: stagesConfig.gather.model,
        durationMs: Number((gatherRes && gatherRes.durationMs) || 0),
        status: 'ok',
      });
      onStage({ phase: 'done', stage: stagesConfig.gather, durationMs: stages[stages.length - 1].durationMs });
    } catch (error) {
      stages.push({
        name: 'gather',
        tier: stagesConfig.gather.tier,
        engine: stagesConfig.gather.engine,
        model: stagesConfig.gather.model,
        durationMs: 0,
        status: 'skipped',
        error: String((error && error.message) || error),
      });
      onStage({ phase: 'fallback', stage: stagesConfig.gather, error: String((error && error.message) || error) });
    }
  }

  // Stage 2: Max / Writer (Neon) writes the piece.
  const taste = options.taste !== undefined ? String(options.taste) : loadProjectTaste(cwd);
  onStage({ phase: 'start', stage: stagesConfig.write });
  const writeRes = await stageRunner({
    ...stagesConfig.write,
    prompt: buildWritePrompt(prompt, brief, taste),
    cwd,
  });
  const neonDraft = String((writeRes && writeRes.output) || '').trim();
  if (!neonDraft) {
    throw new Error('writer-1 write stage (Neon) returned empty output');
  }
  stages.push({
    name: 'write',
    tier: stagesConfig.write.tier,
    engine: stagesConfig.write.engine,
    model: stagesConfig.write.model,
    durationMs: Number((writeRes && writeRes.durationMs) || 0),
    status: 'ok',
  });
  onStage({ phase: 'done', stage: stagesConfig.write, durationMs: stages[stages.length - 1].durationMs });

  // Stage 3: Fast / Light Editor (Claude Haiku) grammar-only check with hard anti-over-edit guard.
  let guardResult = {
    text: neonDraft,
    keptEditor: false,
    diffRatio: 0,
    lengthDrift: 0,
    reason: 'editor skipped',
  };

  if (!options.skipEdit) {
    onStage({ phase: 'start', stage: stagesConfig.edit });
    try {
      const { editRes, usedStage } = await runLightEditStage(neonDraft, stagesConfig.edit, stageRunner, { cwd });
      const editedText = String((editRes && editRes.output) || '').trim();
      guardResult = evaluateLightEdit(neonDraft, editedText, {
        maxEditRatio: options.maxEditRatio,
        maxLengthDrift: options.maxLengthDrift,
      });
      stages.push({
        name: 'edit',
        tier: usedStage.tier,
        engine: usedStage.engine,
        model: usedStage.model,
        durationMs: Number((editRes && editRes.durationMs) || 0),
        status: guardResult.keptEditor ? 'ok' : 'reverted',
        diffRatio: guardResult.diffRatio,
      });
      onStage({ phase: 'done', stage: usedStage, durationMs: stages[stages.length - 1].durationMs, guard: guardResult });
    } catch (error) {
      guardResult = {
        text: neonDraft,
        keptEditor: false,
        diffRatio: 0,
        lengthDrift: 0,
        reason: `editor unavailable (${String((error && error.message) || error)}), kept Neon draft`,
      };
      stages.push({
        name: 'edit',
        tier: stagesConfig.edit.tier,
        engine: stagesConfig.edit.engine,
        model: stagesConfig.edit.model,
        durationMs: 0,
        status: 'skipped',
        error: String((error && error.message) || error),
      });
      onStage({ phase: 'fallback', stage: stagesConfig.edit, error: String((error && error.message) || error) });
    }
  }

  // Stage 4: Deterministic prose slop + craft gate (zero latency).
  const slop = cleanProseSlop(guardResult.text);
  const craft = analyzeWritingCraft(slop.text);

  return {
    ok: true,
    model: 'atris:writer-1',
    output: slop.text,
    draft: neonDraft,
    brief,
    durationMs: Date.now() - startedAt,
    stages,
    editGuard: {
      keptEditor: guardResult.keptEditor,
      diffRatio: guardResult.diffRatio,
      lengthDrift: guardResult.lengthDrift,
      reason: guardResult.reason,
    },
    slop: {
      fixedCount: slop.fixedCount,
      findings: slop.findings,
    },
    craft,
  };
}

module.exports = {
  WRITER_1_STAGES,
  cleanProseSlop,
  analyzeWritingCraft,
  evaluateLightEdit,
  buildSwapHandoff,
  runLocalStage,
  runLightEditStage,
  runWriter1,
  isLockIntent,
  needsFactGather,
  createFlowSession,
  formatWrittenByYouRecord,
  loadFlowSession,
  runFlowTurn,
};
