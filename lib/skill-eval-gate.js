'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SKILL_EVAL_SCHEMA = 'atris.skill_eval.v1';
const SCORECARDS_PATH = path.join('.atris', 'state', 'scorecards.jsonl');
const BASE_REFS = Object.freeze(['origin/master', 'origin/main', 'master', 'main']);

function runGit(root, args) {
  try {
    return spawnSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      timeout: 10000,
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch (error) {
    return { status: 1, stdout: '', stderr: String(error && error.message ? error.message : error) };
  }
}

function normalizedRelativePath(root, value) {
  const text = String(value || '').trim().replace(/\\/g, '/');
  if (!text || text.includes('\0') || path.isAbsolute(text)) return null;
  const absolute = path.resolve(root, text);
  const relative = path.relative(root, absolute).replace(/\\/g, '/');
  if (!relative || relative === '..' || relative.startsWith('../')) return null;
  return relative;
}

function nulTerminatedPaths(result, root) {
  if (!result || result.status !== 0) return [];
  return String(result.stdout || '')
    .split('\0')
    .filter(Boolean)
    .map((entry) => normalizedRelativePath(root, entry))
    .filter(Boolean);
}

function resolveBaseRef(root) {
  const head = runGit(root, ['rev-parse', '--verify', 'HEAD^{commit}']);
  if (head.status !== 0) return null;
  for (const ref of BASE_REFS) {
    const candidate = runGit(root, ['rev-parse', '--verify', `${ref}^{commit}`]);
    if (candidate.status === 0) return ref;
  }
  return null;
}

function indexMtime(root) {
  const result = runGit(root, ['rev-parse', '--git-path', 'index']);
  if (result.status !== 0) return 0;
  const value = String(result.stdout || '').trim();
  const file = path.isAbsolute(value) ? value : path.resolve(root, value);
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

function fileChangeMtime(root, skillPath) {
  const absolute = path.join(root, skillPath);
  try {
    return fs.statSync(absolute).mtimeMs;
  } catch {
    try {
      return fs.statSync(path.dirname(absolute)).mtimeMs;
    } catch {
      return 0;
    }
  }
}

function committedChangeMtime(root, baseRef, skillPath) {
  if (!baseRef) return 0;
  const result = runGit(root, [
    'log',
    '-1',
    '--format=%cI',
    `${baseRef}..HEAD`,
    '--',
    skillPath,
  ]);
  if (result.status !== 0) return 0;
  const parsed = Date.parse(String(result.stdout || '').trim());
  return Number.isFinite(parsed) ? parsed : 0;
}

function changedSkillFiles(workspaceRoot = process.cwd()) {
  const root = path.resolve(workspaceRoot);
  const inside = runGit(root, ['rev-parse', '--is-inside-work-tree']);
  if (inside.status !== 0 || String(inside.stdout || '').trim() !== 'true') return [];

  const changes = new Map();
  const add = (source, paths) => {
    for (const relative of paths) {
      if (path.posix.basename(relative) !== 'SKILL.md') continue;
      const current = changes.get(relative) || new Set();
      current.add(source);
      changes.set(relative, current);
    }
  };

  add('worktree', nulTerminatedPaths(runGit(root, ['diff', '--name-only', '-z']), root));
  add('staged', nulTerminatedPaths(runGit(root, ['diff', '--cached', '--name-only', '-z']), root));
  add('untracked', nulTerminatedPaths(runGit(root, ['ls-files', '--others', '--exclude-standard', '-z']), root));

  const baseRef = resolveBaseRef(root);
  if (baseRef) {
    add('committed', nulTerminatedPaths(
      runGit(root, ['diff', '--name-only', '-z', `${baseRef}...HEAD`]),
      root,
    ));
  }

  const stagedAt = indexMtime(root);
  return [...changes.entries()]
    .map(([skillPath, sources]) => {
      let changedAtMs = 0;
      if (sources.has('worktree') || sources.has('untracked')) {
        changedAtMs = Math.max(changedAtMs, fileChangeMtime(root, skillPath));
      }
      if (sources.has('staged')) changedAtMs = Math.max(changedAtMs, stagedAt);
      if (sources.has('committed')) {
        changedAtMs = Math.max(changedAtMs, committedChangeMtime(root, baseRef, skillPath));
      }
      return {
        path: skillPath,
        changed_at_ms: changedAtMs,
        changed_at: changedAtMs > 0 ? new Date(changedAtMs).toISOString() : null,
        sources: [...sources].sort(),
      };
    })
    .sort((a, b) => a.path.localeCompare(b.path));
}

function readSkillEvalReceipts(workspaceRoot = process.cwd()) {
  const root = path.resolve(workspaceRoot);
  const file = path.join(root, SCORECARDS_PATH);
  if (!fs.existsSync(file)) return [];
  const rows = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const row = JSON.parse(trimmed);
      if (row && row.schema === SKILL_EVAL_SCHEMA) rows.push(row);
    } catch {
      // Foreign and malformed scorecard rows do not prove a skill evaluation.
    }
  }
  return rows;
}

function hasRubricScores(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const scores = Object.values(value);
  return scores.length > 0 && scores.every((score) => Number.isFinite(score));
}

function normalizedIdentity(value) {
  return String(value || '').trim().toLowerCase();
}

function validateSkillEvalReceipt(receipt, skill) {
  if (!receipt || receipt.schema !== SKILL_EVAL_SCHEMA) {
    return { ok: false, reason: 'wrong_schema' };
  }
  if (String(receipt.skill_path || '').replace(/\\/g, '/') !== skill.path) {
    return { ok: false, reason: 'wrong_skill_path' };
  }
  const receiptAtMs = Date.parse(String(receipt.ts || ''));
  if (!Number.isFinite(receiptAtMs) || receiptAtMs <= Number(skill.changed_at_ms || 0)) {
    return { ok: false, reason: 'stale_receipt' };
  }
  if (receipt.passed !== true) return { ok: false, reason: 'eval_did_not_pass' };
  if (!hasRubricScores(receipt.rubric_scores)) {
    return { ok: false, reason: 'rubric_scores_missing' };
  }
  const worker = normalizedIdentity(receipt.worker_model);
  const judge = normalizedIdentity(receipt.judge_identity);
  if (!worker || !judge) return { ok: false, reason: 'judge_or_worker_missing' };
  if (worker === judge) return { ok: false, reason: 'judge_matches_worker' };
  return { ok: true, receipt_at_ms: receiptAtMs };
}

function skillEvalGate(workspaceRoot = process.cwd()) {
  const root = path.resolve(workspaceRoot);
  const skills = changedSkillFiles(root);
  if (!skills.length) return { ok: true, skipped: true, skills: [] };

  const receipts = readSkillEvalReceipts(root);
  const missing = [];
  const accepted = [];
  for (const skill of skills) {
    const candidates = receipts.filter((receipt) => (
      String(receipt.skill_path || '').replace(/\\/g, '/') === skill.path
    ));
    const valid = candidates
      .map((receipt) => ({ receipt, result: validateSkillEvalReceipt(receipt, skill) }))
      .filter((entry) => entry.result.ok)
      .sort((a, b) => b.result.receipt_at_ms - a.result.receipt_at_ms)[0];
    if (valid) {
      accepted.push({ path: skill.path, receipt_ts: valid.receipt.ts });
      continue;
    }
    const latest = candidates
      .map((receipt) => ({ receipt, parsed: Date.parse(String(receipt.ts || '')) }))
      .filter((entry) => Number.isFinite(entry.parsed))
      .sort((a, b) => b.parsed - a.parsed)[0];
    const validation = latest ? validateSkillEvalReceipt(latest.receipt, skill) : null;
    missing.push({
      path: skill.path,
      changed_at: skill.changed_at,
      reason: validation ? validation.reason : 'receipt_missing',
    });
  }

  if (!missing.length) return { ok: true, skills, receipts: accepted };
  const commands = missing.map((entry) => `atris skill eval ${entry.path}`);
  return {
    ok: false,
    reason: 'skill_eval_receipt_required',
    offenders: missing.map((entry) => entry.path),
    missing,
    message: 'a changed skill has no fresh passing evaluation from a judge different from its worker model, so this work cannot land yet.',
    next_action: commands.length === 1
      ? `run \`${commands[0]}\`, then re-certify`
      : `run a fresh skill evaluation for each changed skill, then re-certify: ${commands.join(', ')}`,
  };
}

function appendSkillEvalReceipt(workspaceRoot, receipt) {
  const root = path.resolve(workspaceRoot || process.cwd());
  const file = path.join(root, SCORECARDS_PATH);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(receipt)}\n`, 'utf8');
  return file;
}

module.exports = {
  SKILL_EVAL_SCHEMA,
  appendSkillEvalReceipt,
  changedSkillFiles,
  skillEvalGate,
};
