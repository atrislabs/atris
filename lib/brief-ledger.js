'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const LEDGER_FILE = path.join('.atris', 'state', 'briefs.jsonl');
const OUTCOMES = new Set(['pass', 'fail', 'partial']);
const VERIFY_PATTERNS = Object.freeze([
  /\bnode --test(?:\s+[^\n.;]*)?/i,
  /\bnpm (?:test|run test)(?:\s+[^\n.;]*)?/i,
  /\bpnpm (?:test|run test)(?:\s+[^\n.;]*)?/i,
  /\byarn (?:test|run test)(?:\s+[^\n.;]*)?/i,
  /\bbun test(?:\s+[^\n.;]*)?/i,
  /\bpytest(?:\s+[^\n.;]*)?/i,
  /\bgo test(?:\s+[^\n.;]*)?/i,
  /\bcargo test(?:\s+[^\n.;]*)?/i,
  /\bgit diff --check\b/i,
]);
const BOUNDED_SLICE_PATTERN = /\b(done criteria|done requires|exit criteria|acceptance criteria|check:|verify:|stop when|bounded|one bounded|smallest diff|only touch|do not touch|files changed)\b/i;

function ledgerPath(root = process.cwd()) {
  return path.join(root, LEDGER_FILE);
}

function isoStamp(now = new Date()) {
  return now instanceof Date ? now.toISOString() : new Date(now).toISOString();
}

function briefId(now = new Date()) {
  const compact = isoStamp(now).replace(/[-:.]/g, '').replace('T', '-').replace('Z', '');
  return `brief-${compact}-${crypto.randomBytes(4).toString('hex')}`;
}

function cleanString(value, fallback = '') {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text || fallback;
}

function appendJsonl(file, record) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8');
}

function currentGitValue(cwd, args) {
  try {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    return result.status === 0 ? String(result.stdout || '').trim() : '';
  } catch {
    return '';
  }
}

function worktreeBaseRef(worktree, fallback = '') {
  const wt = String(worktree || '').trim();
  if (!wt || !fs.existsSync(wt)) return fallback || '';
  try {
    const sidecar = JSON.parse(fs.readFileSync(path.join(wt, '.atris', 'agent-worktree.json'), 'utf8'));
    if (sidecar.base) return String(sidecar.base);
    if (sidecar.checkout_base) return String(sidecar.checkout_base);
  } catch {}
  const branch = currentGitValue(wt, ['branch', '--show-current']);
  if (branch) {
    const configured = currentGitValue(wt, ['config', '--get', `branch.${branch}.atris-base`]);
    if (configured) return configured;
  }
  return fallback || currentGitValue(wt, ['rev-parse', '--abbrev-ref', 'HEAD']) || '';
}

function authorFromWorktree(worktree, fallback = 'orb') {
  const wt = String(worktree || '').trim();
  if (!wt || !fs.existsSync(wt)) return fallback;
  try {
    const sidecar = JSON.parse(fs.readFileSync(path.join(wt, '.atris', 'agent-worktree.json'), 'utf8'));
    return cleanString(sidecar.owner || sidecar.member || sidecar.agent, fallback);
  } catch {}
  const branch = currentGitValue(wt, ['branch', '--show-current']);
  if (branch) {
    const configured = currentGitValue(wt, ['config', '--get', `branch.${branch}.atris-owner`]);
    if (configured) return cleanString(configured, fallback);
  }
  return fallback;
}

function normalizeRecord(input = {}, { now = new Date() } = {}) {
  const context = input.context && typeof input.context === 'object' ? input.context : {};
  const worktree = cleanString(context.worktree || input.worktree || process.cwd(), process.cwd());
  return {
    brief_id: cleanString(input.brief_id, briefId(now)),
    ts: cleanString(input.ts, isoStamp(now)),
    author: cleanString(input.author, authorFromWorktree(worktree, 'orb')),
    engine: cleanString(input.engine, 'unknown'),
    ...(input.task_id ? { task_id: cleanString(input.task_id) } : {}),
    ...(input.mission_id ? { mission_id: cleanString(input.mission_id) } : {}),
    prompt_text: String(input.prompt_text || ''),
    context: {
      worktree,
      base_ref: cleanString(context.base_ref || input.base_ref, worktreeBaseRef(worktree, '')),
    },
    outcome: input.outcome || null,
  };
}

function appendBriefRecord(root = process.cwd(), input = {}, options = {}) {
  const record = normalizeRecord(input, options);
  appendJsonl(ledgerPath(root), record);
  return record;
}

function mirrorBriefRecord(worktree, record) {
  const wt = String(worktree || '').trim();
  if (!wt || !fs.existsSync(wt)) return false;
  const root = path.resolve(wt);
  try {
    appendJsonl(ledgerPath(root), record);
    return true;
  } catch {
    return false;
  }
}

function readBriefLedger(root = process.cwd()) {
  const file = ledgerPath(root);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function latestBriefs(records = []) {
  const byId = new Map();
  for (const record of records) {
    if (!record || !record.brief_id) continue;
    byId.set(record.brief_id, record);
  }
  return [...byId.values()].sort((a, b) => Date.parse(b.outcome?.ts || b.ts || 0) - Date.parse(a.outcome?.ts || a.ts || 0));
}

function normalizeOutcome(outcome = {}, { now = new Date() } = {}) {
  const result = cleanString(outcome.result).toLowerCase();
  if (!OUTCOMES.has(result)) throw new Error(`brief outcome result must be one of ${[...OUTCOMES].join(', ')}`);
  return {
    result,
    note: cleanString(outcome.note, ''),
    ts: cleanString(outcome.ts, isoStamp(now)),
  };
}

function stampBriefOutcome(root = process.cwd(), id, outcome = {}, options = {}) {
  const records = readBriefLedger(root);
  const current = latestBriefs(records).find((record) => record.brief_id === id);
  if (!current) return { ok: false, error: `brief not found: ${id}` };
  const next = {
    ...current,
    outcome: normalizeOutcome(outcome, options),
  };
  appendJsonl(ledgerPath(root), next);
  return { ok: true, record: next };
}

function samePath(a, b) {
  if (!a || !b) return false;
  try {
    return fs.realpathSync(a) === fs.realpathSync(b);
  } catch {
    return path.resolve(a) === path.resolve(b);
  }
}

function stampLatestOpenBriefForWorktree(root = process.cwd(), outcome = {}, options = {}) {
  const target = options.worktree || root;
  const current = latestBriefs(readBriefLedger(root))
    .find((record) => !record.outcome && samePath(record.context?.worktree, target));
  if (!current) return { ok: false, error: 'no open brief for this worktree' };
  return stampBriefOutcome(root, current.brief_id, outcome, options);
}

function findVerifyCommand(prompt) {
  const text = String(prompt || '');
  for (const pattern of VERIFY_PATTERNS) {
    const match = text.match(pattern);
    if (match) return match[0].trim();
  }
  return '';
}

function wordCount(text) {
  const words = String(text || '').trim().match(/\S+/g);
  return words ? words.length : 0;
}

function elapsedMs(start, end) {
  const a = Date.parse(start || '');
  const b = Date.parse(end || '');
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return null;
  return b - a;
}

function briefSignals(record) {
  const prompt = String(record?.prompt_text || '');
  const verifyCommand = findVerifyCommand(prompt);
  const hasBoundedSlice = BOUNDED_SLICE_PATTERN.test(prompt);
  const outcomeTs = record?.outcome?.ts || '';
  return {
    prompt_chars: prompt.length,
    prompt_words: wordCount(prompt),
    verify_command: verifyCommand || null,
    has_named_verify: Boolean(verifyCommand),
    has_bounded_slice: hasBoundedSlice,
    had_exit_criteria: Boolean(verifyCommand || hasBoundedSlice),
    engine: cleanString(record?.engine, 'unknown'),
    time_to_land_ms: record?.outcome?.result === 'pass' ? elapsedMs(record.ts, outcomeTs) : null,
  };
}

function reviewItem(record) {
  return {
    ...record,
    outcome_group: record?.outcome?.result || 'open',
    signals: briefSignals(record),
  };
}

function groupReviewItems(items) {
  const groups = { pass: [], partial: [], fail: [], open: [] };
  for (const item of items) {
    const key = groups[item.outcome_group] ? item.outcome_group : 'open';
    groups[key].push(item);
  }
  return groups;
}

function landCount(items) {
  return items.filter((item) => item.outcome?.result === 'pass').length;
}

function lessonLine(items, label) {
  return `${label} land ${landCount(items)} of ${items.length}.`;
}

function booleanLessons(items, field, withLabel, withoutLabel) {
  const yes = items.filter((item) => item.signals[field]);
  const no = items.filter((item) => !item.signals[field]);
  const lines = [];
  if (yes.length >= 5 && no.length >= 5) {
    lines.push(`${withLabel} land ${landCount(yes)} of ${yes.length}; ${withoutLabel} land ${landCount(no)} of ${no.length}.`);
  } else {
    if (yes.length >= 5) lines.push(lessonLine(yes, withLabel));
    if (no.length >= 5) lines.push(lessonLine(no, withoutLabel));
  }
  return lines;
}

function buildLessons(items) {
  const lessons = [
    ...booleanLessons(items, 'has_named_verify', 'briefs with a named verify command', 'briefs without a named verify command'),
    ...booleanLessons(items, 'has_bounded_slice', 'briefs with bounded slice language', 'briefs without bounded slice language'),
    ...booleanLessons(items, 'had_exit_criteria', 'briefs with exit criteria', 'briefs without exit criteria'),
  ];
  const byEngine = new Map();
  for (const item of items) {
    const engine = item.signals.engine || 'unknown';
    byEngine.set(engine, [...(byEngine.get(engine) || []), item]);
  }
  for (const [engine, bucket] of byEngine.entries()) {
    if (bucket.length >= 5) lessons.push(lessonLine(bucket, `${engine} briefs`));
  }
  return lessons;
}

function buildBriefReview(root = process.cwd(), { limit = 20, lessons = false } = {}) {
  const all = latestBriefs(readBriefLedger(root)).map(reviewItem);
  const recent = all.slice(0, Math.max(1, Number(limit) || 20));
  const groups = groupReviewItems(recent);
  return {
    schema: 'atris.brief.review.v1',
    generated_at: isoStamp(),
    count: recent.length,
    groups,
    ...(lessons ? { lessons: buildLessons(recent) } : {}),
  };
}

function compactTitle(record) {
  const prompt = String(record?.prompt_text || '').replace(/\s+/g, ' ').trim();
  const fromTask = record?.task_id ? `task ${record.task_id}` : '';
  const fromMission = record?.mission_id ? `mission ${record.mission_id}` : '';
  const title = fromTask || fromMission || prompt.slice(0, 72) || 'untitled brief';
  return title.length > 72 ? `${title.slice(0, 69)}...` : title;
}

function durationLabel(ms) {
  if (ms === null || ms === undefined) return 'not landed';
  const minutes = Math.round(ms / 60000);
  if (minutes < 1) return 'under 1m';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

function renderBriefReview(review = {}, { lessons = false } = {}) {
  const groups = review.groups || {};
  const counts = ['pass', 'partial', 'fail', 'open'].map((key) => `${key} ${(groups[key] || []).length}`).join(', ');
  const lines = [`brief review: ${review.count || 0} recent briefs | ${counts}`];
  for (const key of ['pass', 'partial', 'fail', 'open']) {
    const items = groups[key] || [];
    lines.push('');
    lines.push(`${key}: ${items.length ? 'recorded' : 'none'}`);
    for (const item of items.slice(0, 5)) {
      const signals = item.signals || {};
      lines.push(`- ${signals.engine || item.engine || 'unknown'} | ${signals.prompt_words || 0} words | verify ${signals.has_named_verify ? 'yes' : 'no'} | exit ${signals.had_exit_criteria ? 'yes' : 'no'} | land ${durationLabel(signals.time_to_land_ms)} | ${compactTitle(item)}`);
    }
  }
  if (lessons) {
    lines.push('');
    const found = Array.isArray(review.lessons) ? review.lessons : [];
    lines.push(found.length ? 'lessons:' : 'lessons: not enough data yet');
    for (const lesson of found) lines.push(`- ${lesson}`);
  }
  return lines.join('\n');
}

module.exports = {
  LEDGER_FILE,
  OUTCOMES,
  appendBriefRecord,
  authorFromWorktree,
  briefSignals,
  buildBriefReview,
  buildLessons,
  ledgerPath,
  latestBriefs,
  mirrorBriefRecord,
  normalizeRecord,
  readBriefLedger,
  renderBriefReview,
  stampBriefOutcome,
  stampLatestOpenBriefForWorktree,
  worktreeBaseRef,
};
