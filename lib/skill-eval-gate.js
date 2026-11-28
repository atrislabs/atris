'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { atrisHome } = require('./state-home');

const SKILL_EVAL_SCHEMA = 'atris.skill_eval.v1';
const SCORECARDS_PATH = path.join('.atris', 'state', 'scorecards.jsonl');
const BASE_REFS = Object.freeze(['origin/master', 'origin/main', 'master', 'main']);
const PROVENANCE_PATH = path.join('.atris', 'state', 'learner-provenance.jsonl');
const LEARNER_NOTE_SCHEMA = 'atris.learner_note.v1';
const RUBRIC_KEYS = Object.freeze(['instruction_clarity', 'trigger_precision', 'procedural_completeness', 'safety', 'verifiability']);
const RECOGNIZED_JUDGE_FAMILIES = Object.freeze(['claude', 'codex', 'cursor', 'gemini']);
const SKILL_SUBDIR_RE = /^((?:.+\/)?skills\/[^/]+)\/(?:scripts|references|resources|examples)\//i;

function runGit(root, args, { encoding = 'utf8' } = {}) {
  try {
    return spawnSync('git', args, {
      cwd: root,
      encoding,
      timeout: 10000,
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch (error) {
    return { status: 1, stdout: encoding ? '' : Buffer.alloc(0), stderr: String(error && error.message ? error.message : error) };
  }
}

function isSkillDocPath(relative) {
  return path.posix.basename(String(relative || '')).toLowerCase() === 'skill.md';
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

function fileChangeMtime(root, relativePath) {
  const absolute = path.join(root, relativePath);
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

function gitCommonDir(root) {
  const res = runGit(root, ['rev-parse', '--git-common-dir']);
  if (res.status !== 0) return '';
  const val = String(res.stdout || '').trim();
  if (!val) return '';
  return path.isAbsolute(val) ? val : path.resolve(root, val);
}

function commitObjectMtime(commonDir, commitSha) {
  if (!commonDir || !commitSha || commitSha.length < 40) return 0;
  const objPath = path.join(commonDir, 'objects', commitSha.slice(0, 2), commitSha.slice(2));
  try {
    return Math.floor(fs.statSync(objPath).mtimeMs);
  } catch {
    return 0;
  }
}

function refCommitTimestamp(root, ref) {
  if (!ref) return 0;
  const res = runGit(root, ['show', '-s', '--format=%cI', ref]);
  if (res.status !== 0) return 0;
  const parsed = Date.parse(String(res.stdout || '').trim());
  return Number.isFinite(parsed) ? parsed : 0;
}

function mergeBaseTimestamp(root, baseRef, headRef) {
  if (!baseRef || !headRef) return 0;
  const mb = runGit(root, ['merge-base', baseRef, headRef]);
  if (mb.status !== 0) return 0;
  const sha = String(mb.stdout || '').trim();
  return sha ? refCommitTimestamp(root, sha) : 0;
}

function committedChangeInfo(root, baseRef, filePath, headRef = 'HEAD', commonDir = '') {
  if (!baseRef) return { commitMs: 0, objectMtimeMs: 0 };
  const result = runGit(root, [
    'log',
    '-1',
    '--format=%H%x00%cI',
    `${baseRef}..${headRef}`,
    '--',
    filePath,
  ]);
  if (result.status !== 0) return { commitMs: 0, objectMtimeMs: 0 };
  const raw = String(result.stdout || '').trim();
  if (!raw) return { commitMs: 0, objectMtimeMs: 0 };
  const [sha, iso] = raw.split('\0');
  const parsed = Date.parse(String(iso || '').trim());
  const commitMs = Number.isFinite(parsed) ? parsed : 0;
  const objectMtimeMs = commitObjectMtime(commonDir, String(sha || '').trim());
  return { commitMs, objectMtimeMs };
}

function ancestorDirs(relative) {
  const dirs = [];
  let dir = path.posix.dirname(relative);
  while (dir && dir !== '.') {
    dirs.push(dir);
    const parent = path.posix.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return dirs;
}

function listTreeSkillDocsForDirs(root, ref, dirs) {
  const map = new Map();
  if (!ref || !dirs.length) return { unreadable: false, map };
  const dirArgs = dirs.map((d) => `${d}/`);
  const res = runGit(root, ['ls-tree', '--name-only', '-z', ref, '--', ...dirArgs]);
  if (res.status !== 0) return { unreadable: true, map };
  for (const entry of nulTerminatedPaths(res, root)) {
    if (!isSkillDocPath(entry)) continue;
    const dir = path.posix.dirname(entry);
    if (!map.has(dir)) map.set(dir, entry);
  }
  return { unreadable: false, map };
}

function diskSkillDocInDir(root, dir, cache) {
  if (cache.has(dir)) return cache.get(dir);
  let found = null;
  try {
    const entries = fs.readdirSync(path.join(root, dir));
    const match = entries.find((entry) => entry.toLowerCase() === 'skill.md');
    if (match) {
      const full = path.join(root, dir, match);
      if (fs.statSync(full).isFile()) found = `${dir}/${match}`;
    }
  } catch {
    found = null;
  }
  cache.set(dir, found);
  return found;
}

function resolveOwningSkillDoc(root, relative, { checkDisk = false, dirCache = null, treeSkillDocs = null, allowDeletedSkillDoc = false } = {}) {
  if (isSkillDocPath(relative)) {
    return allowDeletedSkillDoc ? relative : null;
  }
  for (const dir of ancestorDirs(relative)) {
    if (checkDisk) {
      const diskDoc = diskSkillDocInDir(root, dir, dirCache);
      if (diskDoc) return diskDoc;
    }
    if (treeSkillDocs && treeSkillDocs.has(dir)) {
      return treeSkillDocs.get(dir);
    }
  }
  const subMatch = SKILL_SUBDIR_RE.exec(relative);
  if (subMatch) {
    const skillDir = subMatch[1];
    if (checkDisk && dirCache) {
      const diskDoc = diskSkillDocInDir(root, skillDir, dirCache);
      if (diskDoc) return diskDoc;
    }
    if (treeSkillDocs && treeSkillDocs.has(skillDir)) {
      return treeSkillDocs.get(skillDir);
    }
    return `${skillDir}/SKILL.md`;
  }
  return null;
}

function walkDiskFiles(dir, baseDir, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name === '.git') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkDiskFiles(full, baseDir, out);
    } else if (entry.isFile()) {
      out.push(path.relative(baseDir, full).replace(/\\/g, '/'));
    }
  }
}

function computeSkillSha256(root, skillPath, { headRef = null } = {}) {
  const hash = crypto.createHash('sha256');
  const skillDir = path.posix.dirname(skillPath);
  if (headRef) {
    if (skillDir === '.') {
      const blob = runGit(root, ['show', `${headRef}:${skillPath}`], { encoding: null });
      if (blob.status !== 0) return '';
      hash.update(`${skillPath}\0`);
      hash.update(blob.stdout || Buffer.alloc(0));
      hash.update('\0');
      return hash.digest('hex');
    }
    const listRes = runGit(root, ['ls-tree', '-r', '--name-only', '-z', headRef, '--', `${skillDir}/`]);
    if (listRes.status !== 0) return '';
    const files = nulTerminatedPaths(listRes, root).sort((a, b) => a.localeCompare(b));
    if (!files.length) return '';
    for (const file of files) {
      const blob = runGit(root, ['show', `${headRef}:${file}`], { encoding: null });
      if (blob.status !== 0) return '';
      hash.update(`${file}\0`);
      hash.update(blob.stdout || Buffer.alloc(0));
      hash.update('\0');
    }
    return hash.digest('hex');
  }

  if (skillDir === '.') {
    try {
      const bytes = fs.readFileSync(path.join(root, skillPath));
      hash.update(`${skillPath}\0`);
      hash.update(bytes);
      hash.update('\0');
      return hash.digest('hex');
    } catch {
      return '';
    }
  }
  const absDir = path.join(root, skillDir);
  if (!fs.existsSync(absDir)) return '';
  const files = [];
  walkDiskFiles(absDir, root, files);
  files.sort((a, b) => a.localeCompare(b));
  if (!files.length) return '';
  for (const file of files) {
    try {
      const bytes = fs.readFileSync(path.join(root, file));
      hash.update(`${file}\0`);
      hash.update(bytes);
      hash.update('\0');
    } catch {
      return '';
    }
  }
  return hash.digest('hex');
}

function changedSkillFilesBetweenRefs(root, baseRef, headRef) {
  const diff = runGit(root, ['diff', '--name-only', '--diff-filter=ACMRT', '-z', `${baseRef}...${headRef}`]);
  if (diff.status !== 0) return { unreadable: true, skills: [] };
  const deletedDiff = runGit(root, ['diff', '--name-only', '--diff-filter=D', '-z', `${baseRef}...${headRef}`]);
  if (deletedDiff.status !== 0) return { unreadable: true, skills: [] };

  const activePaths = nulTerminatedPaths(diff, root);
  const deletedPaths = nulTerminatedPaths(deletedDiff, root);
  const candidateDirs = new Set();
  for (const p of [...activePaths, ...deletedPaths]) {
    if (!isSkillDocPath(p)) {
      for (const dir of ancestorDirs(p)) candidateDirs.add(dir);
    }
  }
  const treeLookup = listTreeSkillDocsForDirs(root, headRef, [...candidateDirs]);
  if (treeLookup.unreadable) return { unreadable: true, skills: [] };

  const grouped = new Map();
  const record = (skillPath, triggerFile) => {
    let entry = grouped.get(skillPath);
    if (!entry) {
      entry = { triggerFiles: new Set() };
      grouped.set(skillPath, entry);
    }
    entry.triggerFiles.add(triggerFile);
  };

  for (const relative of activePaths) {
    const skillPath = resolveOwningSkillDoc(root, relative, {
      checkDisk: false,
      treeSkillDocs: treeLookup.map,
      allowDeletedSkillDoc: true,
    });
    if (skillPath) record(skillPath, relative);
  }
  for (const relative of deletedPaths) {
    // A deleted SKILL.md itself cannot be evaluated, but deleting a subfile
    // inside an existing skill directory still changes that surviving skill.
    if (isSkillDocPath(relative)) continue;
    const skillPath = resolveOwningSkillDoc(root, relative, {
      checkDisk: false,
      treeSkillDocs: treeLookup.map,
      allowDeletedSkillDoc: false,
    });
    if (skillPath) record(skillPath, relative);
  }

  const commonDir = grouped.size ? gitCommonDir(root) : '';
  const mergeBaseMs = grouped.size ? mergeBaseTimestamp(root, baseRef, headRef) : 0;
  const tipMs = grouped.size ? refCommitTimestamp(root, headRef) : 0;

  const skills = [...grouped.entries()]
    .map(([skillPath, info]) => {
      let changedAtMs = 0;
      let maxObjectMtimeMs = 0;
      for (const tf of info.triggerFiles) {
        const commitInfo = committedChangeInfo(root, baseRef, tf, headRef, commonDir);
        changedAtMs = Math.max(changedAtMs, commitInfo.commitMs);
        maxObjectMtimeMs = Math.max(maxObjectMtimeMs, commitInfo.objectMtimeMs);
      }
      const effectiveChangedAtMs = changedAtMs > 0
        ? Math.max(changedAtMs, mergeBaseMs, tipMs, maxObjectMtimeMs)
        : 0;
      return {
        path: skillPath,
        changed_at_ms: changedAtMs,
        changed_at: changedAtMs > 0 ? new Date(changedAtMs).toISOString() : null,
        sources: ['committed'],
        _effectiveChangedAtMs: effectiveChangedAtMs,
        _triggerFiles: [...info.triggerFiles].sort(),
        _sha256: computeSkillSha256(root, skillPath, { headRef }),
      };
    })
    .sort((a, b) => a.path.localeCompare(b.path));
  return { unreadable: false, skills };
}

function scanChangedSkillFiles(workspaceRoot = process.cwd()) {
  const root = path.resolve(workspaceRoot);
  const inside = runGit(root, ['rev-parse', '--is-inside-work-tree']);
  if (inside.status !== 0 || String(inside.stdout || '').trim() !== 'true') {
    const stderr = String(inside.stderr || '');
    const notGitRepo = /not a git repository/i.test(stderr) && !fs.existsSync(path.join(root, '.git'));
    if (notGitRepo) return { unreadable: false, skills: [] };
    return { unreadable: true, skills: [] };
  }

  const worktreeRes = runGit(root, ['diff', '--name-only', '-z']);
  if (worktreeRes.status !== 0) return { unreadable: true, skills: [] };
  const stagedRes = runGit(root, ['diff', '--cached', '--name-only', '-z']);
  if (stagedRes.status !== 0) return { unreadable: true, skills: [] };
  const untrackedRes = runGit(root, ['ls-files', '--others', '--exclude-standard', '-z']);
  if (untrackedRes.status !== 0) return { unreadable: true, skills: [] };

  const baseRef = resolveBaseRef(root);
  let committedRes = null;
  if (baseRef) {
    committedRes = runGit(root, ['diff', '--name-only', '-z', `${baseRef}...HEAD`]);
    if (committedRes.status !== 0) return { unreadable: true, skills: [] };
  }

  const sourcedPaths = [
    ['worktree', nulTerminatedPaths(worktreeRes, root)],
    ['staged', nulTerminatedPaths(stagedRes, root)],
    ['untracked', nulTerminatedPaths(untrackedRes, root)],
    ...(committedRes ? [['committed', nulTerminatedPaths(committedRes, root)]] : []),
  ];

  const candidateDirs = new Set();
  for (const [, paths] of sourcedPaths) {
    for (const p of paths) {
      if (!isSkillDocPath(p)) {
        for (const dir of ancestorDirs(p)) candidateDirs.add(dir);
      }
    }
  }
  const hasHead = runGit(root, ['rev-parse', '--verify', 'HEAD^{commit}']).status === 0;
  let treeSkillDocs = new Map();
  if (hasHead && candidateDirs.size) {
    const treeLookup = listTreeSkillDocsForDirs(root, 'HEAD', [...candidateDirs]);
    if (treeLookup.unreadable) return { unreadable: true, skills: [] };
    treeSkillDocs = treeLookup.map;
  }

  const dirCache = new Map();
  const changes = new Map();
  const add = (source, paths) => {
    for (const relative of paths) {
      const skillPath = resolveOwningSkillDoc(root, relative, {
        checkDisk: true,
        dirCache,
        treeSkillDocs,
        allowDeletedSkillDoc: true,
      });
      if (!skillPath) continue;
      let current = changes.get(skillPath);
      if (!current) {
        current = { sources: new Set(), triggerFilesBySource: new Map(), allTriggerFiles: new Set() };
        changes.set(skillPath, current);
      }
      current.sources.add(source);
      current.allTriggerFiles.add(relative);
      let perSource = current.triggerFilesBySource.get(source);
      if (!perSource) {
        perSource = new Set();
        current.triggerFilesBySource.set(source, perSource);
      }
      perSource.add(relative);
    }
  };

  for (const [source, paths] of sourcedPaths) add(source, paths);

  const stagedAt = changes.size ? indexMtime(root) : 0;
  const hasCommitted = [...changes.values()].some((c) => c.sources.has('committed'));
  const commonDir = hasCommitted ? gitCommonDir(root) : '';
  const mergeBaseMs = hasCommitted && baseRef ? mergeBaseTimestamp(root, baseRef, 'HEAD') : 0;
  const tipMs = hasCommitted ? refCommitTimestamp(root, 'HEAD') : 0;

  const skills = [...changes.entries()]
    .map(([skillPath, entry]) => {
      let changedAtMs = 0;
      let maxObjectMtimeMs = 0;
      if (entry.sources.has('worktree') || entry.sources.has('untracked')) {
        for (const src of ['worktree', 'untracked']) {
          for (const tf of entry.triggerFilesBySource.get(src) || []) {
            changedAtMs = Math.max(changedAtMs, fileChangeMtime(root, tf));
          }
        }
      }
      if (entry.sources.has('staged')) changedAtMs = Math.max(changedAtMs, stagedAt);
      if (entry.sources.has('committed')) {
        for (const tf of entry.triggerFilesBySource.get('committed') || []) {
          const commitInfo = committedChangeInfo(root, baseRef, tf, 'HEAD', commonDir);
          changedAtMs = Math.max(changedAtMs, commitInfo.commitMs);
          maxObjectMtimeMs = Math.max(maxObjectMtimeMs, commitInfo.objectMtimeMs);
        }
      }
      let effectiveChangedAtMs = changedAtMs;
      if (changedAtMs > 0 && entry.sources.has('committed')) {
        effectiveChangedAtMs = Math.max(changedAtMs, mergeBaseMs, tipMs, maxObjectMtimeMs);
      }
      return {
        path: skillPath,
        changed_at_ms: changedAtMs,
        changed_at: changedAtMs > 0 ? new Date(changedAtMs).toISOString() : null,
        sources: [...entry.sources].sort(),
        _effectiveChangedAtMs: effectiveChangedAtMs,
        _triggerFiles: [...entry.allTriggerFiles].sort(),
        _sha256: computeSkillSha256(root, skillPath),
      };
    })
    .sort((a, b) => a.path.localeCompare(b.path));

  return { unreadable: false, skills };
}

function publicSkillEntry(skill) {
  return {
    path: skill.path,
    changed_at_ms: skill.changed_at_ms,
    changed_at: skill.changed_at,
    sources: skill.sources,
  };
}

function changedSkillFiles(workspaceRoot = process.cwd()) {
  const scanned = scanChangedSkillFiles(workspaceRoot);
  if (scanned.unreadable) return { skills: [], unreadable: true };
  return scanned.skills.map(publicSkillEntry);
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

function rubricProblem(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length === 0) {
    return 'rubric_scores_missing';
  }
  const inRange = (score) => typeof score === 'number' && Number.isFinite(score) && score >= 4 && score <= 5;
  if (!RUBRIC_KEYS.every((key) => inRange(value[key]))) return 'rubric_scores_invalid';
  if (!Object.values(value).every(inRange)) return 'rubric_scores_invalid';
  return '';
}

function normalizedIdentity(value) {
  return String(value || '').trim().toLowerCase();
}

function identityFamily(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return '';
  if (/claude|anthropic|opus|sonnet|haiku|fable/.test(normalized)) return 'claude';
  if (/codex|openai|gpt|terra|astra|sol/.test(normalized)) return 'codex';
  if (/cursor/.test(normalized)) return 'cursor';
  if (/gemini|google|agy/.test(normalized)) return 'gemini';
  return normalized;
}

function hmacKeyFile() {
  return path.join(atrisHome(), 'skill-eval-key');
}

function readOrCreateHmacKey({ create = false } = {}) {
  const keyFile = hmacKeyFile();
  try {
    const existing = fs.readFileSync(keyFile, 'utf8').trim();
    if (existing) return existing;
  } catch (err) {
    if (err && err.code !== 'ENOENT') return '';
  }
  if (!create) return '';
  fs.mkdirSync(path.dirname(keyFile), { recursive: true });
  const key = crypto.randomBytes(32).toString('hex');
  try {
    fs.writeFileSync(keyFile, key, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    return key;
  } catch (err) {
    if (err && err.code === 'EEXIST') return fs.readFileSync(keyFile, 'utf8').trim();
    throw err;
  }
}

function hmacHex(key, payload) {
  return crypto.createHmac('sha256', key).update(payload).digest('hex');
}

function hmacMatches(key, payload, signature) {
  if (!key || typeof signature !== 'string') return false;
  const trimmed = signature.trim();
  if (!/^[0-9a-f]{64}$/i.test(trimmed)) return false;
  const expected = Buffer.from(hmacHex(key, payload), 'hex');
  const actual = Buffer.from(trimmed, 'hex');
  if (expected.length !== actual.length || actual.length === 0) return false;
  return crypto.timingSafeEqual(expected, actual);
}

function canonicalReceiptPayload(receipt) {
  const scores = receipt && receipt.rubric_scores && typeof receipt.rubric_scores === 'object' && !Array.isArray(receipt.rubric_scores)
    ? receipt.rubric_scores
    : {};
  const sortedRubricScores = {};
  for (const key of Object.keys(scores).sort()) sortedRubricScores[key] = scores[key];
  return JSON.stringify({
    schema: receipt.schema ?? null,
    ts: receipt.ts ?? null,
    source: receipt.source ?? null,
    skill_path: receipt.skill_path ?? null,
    skill_sha256: receipt.skill_sha256 ?? null,
    worker_model: receipt.worker_model ?? null,
    judge_identity: receipt.judge_identity ?? null,
    passed: receipt.passed ?? null,
    rubric_scores: sortedRubricScores,
  });
}

function canonicalProvenancePayload(record) {
  return JSON.stringify({
    schema: record.schema ?? null,
    path: record.path ?? null,
    sha256: record.sha256 ?? null,
    owner: record.owner ?? null,
    ts: record.ts ?? null,
  });
}

function validateSkillEvalReceipt(receipt, skill) {
  if (!receipt || receipt.schema !== SKILL_EVAL_SCHEMA) {
    return { ok: false, reason: 'wrong_schema' };
  }
  if (receipt.source !== 'skill_eval') return { ok: false, reason: 'wrong_source' };
  if (String(receipt.skill_path || '').replace(/\\/g, '/') !== skill.path) {
    return { ok: false, reason: 'wrong_skill_path' };
  }
  const changedAtMs = Number(
    skill._effectiveChangedAtMs !== undefined ? skill._effectiveChangedAtMs : skill.changed_at_ms,
  );
  if (!Number.isFinite(changedAtMs) || changedAtMs <= 0) {
    return { ok: false, reason: 'change_time_unknown' };
  }
  const receiptAtMs = Date.parse(String(receipt.ts || ''));
  if (!Number.isFinite(receiptAtMs) || receiptAtMs <= changedAtMs) {
    return { ok: false, reason: 'stale_receipt' };
  }
  if (receiptAtMs > Date.now() + 60000) {
    return { ok: false, reason: 'future_receipt_timestamp' };
  }
  if (receipt.skill_sha256 !== undefined && receipt.skill_sha256 !== null) {
    const expected = String(skill._sha256 || '').toLowerCase();
    const actual = String(receipt.skill_sha256 || '').trim().toLowerCase();
    if (!expected || !actual || actual !== expected) {
      return { ok: false, reason: 'skill_sha256_mismatch' };
    }
  }
  if (receipt.passed !== true) return { ok: false, reason: 'eval_did_not_pass' };
  const rubric = rubricProblem(receipt.rubric_scores);
  if (rubric) return { ok: false, reason: rubric };
  const worker = normalizedIdentity(receipt.worker_model);
  const judge = normalizedIdentity(receipt.judge_identity);
  if (!worker || !judge) return { ok: false, reason: 'judge_or_worker_missing' };
  const judgeFamily = identityFamily(judge);
  const workerFamily = identityFamily(worker);
  if (!RECOGNIZED_JUDGE_FAMILIES.includes(judgeFamily)) return { ok: false, reason: 'judge_not_recognized' };
  if (worker === judge || workerFamily === judgeFamily) return { ok: false, reason: 'judge_matches_worker' };
  if (typeof receipt.receipt_hmac !== 'string' || !receipt.receipt_hmac.trim()) {
    return { ok: false, reason: 'receipt_signature_missing' };
  }
  if (!hmacMatches(readOrCreateHmacKey({ create: false }), canonicalReceiptPayload(receipt), receipt.receipt_hmac)) {
    return { ok: false, reason: 'receipt_signature_invalid' };
  }
  return { ok: true, receipt_at_ms: receiptAtMs };
}

// The learner writes these notes itself after verified runs (see
// crystallizeMemberSkillLesson in lib/mission-core.js). Only the exact member
// path counts, and only with signed provenance or the learner's own grammar.
const LEARNER_NOTE_PATTERN = /^atris\/team\/[^/]+\/skills\/auto-learned\/SKILL\.md$/i;
const LEARNER_BULLET_RE = /^- \*\*\d{4}-\d{2}-\d{2} \([^)\r\n]{1,64}\)\*\*:\s+\S/;

function recordLearnerNoteProvenance(workspaceRoot, relativePath, owner = '') {
  const root = path.resolve(workspaceRoot || process.cwd());
  const rel = String(relativePath || '').replace(/\\/g, '/');
  if (!LEARNER_NOTE_PATTERN.test(rel)) return null;
  const sha256 = computeSkillSha256(root, rel);
  if (!sha256) return null;
  const record = { schema: LEARNER_NOTE_SCHEMA, path: rel, sha256, owner: String(owner || ''), ts: new Date().toISOString() };
  record.receipt_hmac = hmacHex(readOrCreateHmacKey({ create: true }), canonicalProvenancePayload(record));
  const file = path.join(root, PROVENANCE_PATH);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8');
  return file;
}

function hasSignedProvenance(root, skillPath, sha256) {
  if (!sha256) return false;
  const key = readOrCreateHmacKey({ create: false });
  if (!key) return false;
  let text;
  try {
    text = fs.readFileSync(path.join(root, PROVENANCE_PATH), 'utf8');
  } catch {
    return false;
  }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (!row || row.schema !== LEARNER_NOTE_SCHEMA || row.path !== skillPath || row.sha256 !== sha256) continue;
    if (hmacMatches(key, canonicalProvenancePayload(row), row.receipt_hmac)) return true;
  }
  return false;
}

function hasLearnerGrammar(root, skillPath) {
  let text;
  try {
    const file = path.join(root, skillPath);
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > 32 * 1024) return false;
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return false;
  }
  const lines = text.split(/\r?\n/);
  if (lines[0] !== '---') return false;
  const close = lines.indexOf('---', 1);
  if (close < 0) return false;
  const front = lines.slice(1, close).filter((line) => line.trim());
  let sawName = false;
  let sawDescription = false;
  for (const line of front) {
    if (line === 'name: auto-learned' && !sawName) sawName = true;
    else if (/^description: \S/.test(line) && !sawDescription) sawDescription = true;
    else return false;
  }
  if (!sawName) return false;
  let headings = 0;
  let bullets = 0;
  for (const line of lines.slice(close + 1)) {
    if (!line.trim()) continue;
    if (line === '# Auto-Learned Verified Patterns') {
      headings += 1;
      if (headings > 1) return false;
    } else if (LEARNER_BULLET_RE.test(line)) {
      bullets += 1;
    } else {
      return false;
    }
  }
  return bullets >= 1 && bullets <= 5;
}

function isTrustedLearnerNote(root, skill, { isolated = false } = {}) {
  if (isolated || !skill || !LEARNER_NOTE_PATTERN.test(String(skill.path || ''))) return false;
  const sources = skill.sources;
  if (!Array.isArray(sources) || !sources.length || !sources.every((s) => s === 'worktree' || s === 'untracked')) return false;
  if (Array.isArray(skill._triggerFiles) && skill._triggerFiles.length > 0
    && !skill._triggerFiles.every((tf) => tf === skill.path)) return false;
  const sha = skill._sha256 || computeSkillSha256(root, skill.path);
  return hasSignedProvenance(root, skill.path, sha) || hasLearnerGrammar(root, skill.path);
}

function normalizedScopePaths(paths) {
  if (!Array.isArray(paths)) return null;
  return paths
    .map((entry) => String(entry || '').trim().replace(/\\/g, '/').replace(/\/+$/, ''))
    .filter(Boolean);
}

function skillMatchesScope(skill, jobPaths, root, { isolated = false } = {}) {
  if (!jobPaths) return !isTrustedLearnerNote(root, skill, { isolated });
  return jobPaths.some((entry) => (
    skill.path === entry
    || skill.path.startsWith(`${entry}/`)
    || (Array.isArray(skill._triggerFiles) && skill._triggerFiles.some((tf) => tf === entry || tf.startsWith(`${entry}/`)))
  ));
}

function mergeSkillRecords(target, incoming) {
  const existing = target.get(incoming.path);
  if (!existing) {
    target.set(incoming.path, incoming);
    return;
  }
  const changedAtMs = Math.max(Number(existing.changed_at_ms || 0), Number(incoming.changed_at_ms || 0));
  const effectiveChangedAtMs = Math.max(
    Number(existing._effectiveChangedAtMs || 0),
    Number(incoming._effectiveChangedAtMs || 0),
  );
  const sources = [...new Set([...(existing.sources || []), ...(incoming.sources || [])])].sort();
  const triggerFiles = [...new Set([...(existing._triggerFiles || []), ...(incoming._triggerFiles || [])])].sort();
  const pickIncoming = Number(incoming._effectiveChangedAtMs || 0) >= Number(existing._effectiveChangedAtMs || 0);
  target.set(incoming.path, {
    path: existing.path,
    changed_at_ms: changedAtMs,
    changed_at: changedAtMs > 0 ? new Date(changedAtMs).toISOString() : null,
    sources,
    _effectiveChangedAtMs: effectiveChangedAtMs,
    _triggerFiles: triggerFiles,
    _sha256: (pickIncoming ? incoming._sha256 : existing._sha256) || existing._sha256 || incoming._sha256 || '',
  });
}

// A job answers for the skills it changed, not for every skill file that
// happens to sit changed in the workspace. Eight learner notes nobody had
// evaluated held seven finished jobs for five days (2026-11-04 to 11-09)
// while none of those jobs touched a skill.
//   scope.paths         the job's exact file list, when it is on record. Only
//                       skills inside it count, learner notes included.
//   scope.changeRoot    where the job's branch is checked out, when that is not
//                       the workspace itself.
//   scope.branchChecks  optional array of { base, branch } diffs to union with
//                       changeRoot so declared branch refs can never hide
//                       working-tree or HEAD skill changes.
// With no file list every changed skill still counts, except learner notes.
function skillsInScope(root, scope = {}) {
  const changeRoot = path.resolve(scope.changeRoot || root);
  const jobPaths = normalizedScopePaths(scope.paths);
  const isolated = changeRoot !== path.resolve(root);

  if (scope.base && scope.branch && !Array.isArray(scope.branchChecks)) {
    const refDiff = changedSkillFilesBetweenRefs(changeRoot, scope.base, scope.branch);
    if (refDiff.unreadable) return { unreadable: true, skills: [] };
    const filtered = refDiff.skills.filter((skill) => skillMatchesScope(skill, jobPaths, changeRoot, { isolated }));
    return { unreadable: false, skills: filtered };
  }

  const merged = new Map();
  const localScan = scanChangedSkillFiles(changeRoot);
  if (localScan.unreadable) return { unreadable: true, skills: [] };
  for (const skill of localScan.skills) {
    if (skillMatchesScope(skill, jobPaths, changeRoot, { isolated })) mergeSkillRecords(merged, skill);
  }

  const branchChecks = Array.isArray(scope.branchChecks) ? scope.branchChecks : [];
  for (const check of branchChecks) {
    if (!check || !check.base || !check.branch) continue;
    const refDiff = changedSkillFilesBetweenRefs(changeRoot, check.base, check.branch);
    if (refDiff.unreadable) return { unreadable: true, skills: [] };
    for (const skill of refDiff.skills) {
      const keep = scope.includeBranchSkills
        ? true
        : skillMatchesScope(skill, jobPaths, changeRoot, { isolated });
      if (keep) mergeSkillRecords(merged, skill);
    }
  }

  const skills = [...merged.values()].sort((a, b) => a.path.localeCompare(b.path));
  return { unreadable: false, skills };
}

function skillEvalGate(workspaceRoot = process.cwd(), scope = {}) {
  const root = path.resolve(workspaceRoot);
  const scoped = skillsInScope(root, scope || {});
  if (scoped.unreadable) {
    return {
      ok: false,
      reason: 'skill_eval_receipt_required',
      offenders: ['unreadable diff'],
      missing: [{ path: 'unreadable diff', changed_at: null, reason: 'diff_unreadable' }],
      message: 'the branch diff could not be read to check changed skills, so this work cannot land yet.',
      next_action: 'ensure the base and branch refs are readable, then re-certify',
    };
  }
  const skills = scoped.skills;
  if (!skills.length) return { ok: true, skipped: true, skills: [] };

  // Read scorecards only from the trusted workspace root, never from an
  // untrusted candidate worktree where a job could plant its own receipt.
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

  if (!missing.length) return { ok: true, skills: skills.map(publicSkillEntry), receipts: accepted };
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
  const toWrite = receipt && typeof receipt === 'object' ? { ...receipt } : receipt;
  if (toWrite && typeof toWrite === 'object' && toWrite.receipt_hmac === undefined) {
    toWrite.receipt_hmac = hmacHex(readOrCreateHmacKey({ create: true }), canonicalReceiptPayload(toWrite));
  }
  fs.appendFileSync(file, `${JSON.stringify(toWrite)}\n`, 'utf8');
  return file;
}

module.exports = {
  RUBRIC_KEYS,
  SKILL_EVAL_SCHEMA,
  appendSkillEvalReceipt,
  changedSkillFiles,
  computeSkillSha256,
  identityFamily,
  recordLearnerNoteProvenance,
  skillEvalGate,
};
