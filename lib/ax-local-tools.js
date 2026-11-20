'use strict';

// Local workspace coding-agent tool executor for ax.
// Mirrors the backend/Desktop local_file_op contract (read, edit, write, append,
// delete, list, search, inspect, bash) with unified diffs, pre-edit checkpoints
// for /undo, and workspace-safe permission gating (plan / stage / auto).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { stateHome } = require('./state-home');

const IGNORED_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'out',
  'coverage',
  '.next',
  '.turbo',
  '__pycache__',
  '.venv',
  'venv',
  '.agent-worktrees',
]);

const READ_ONLY_OPS = new Set(['read', 'list', 'search', 'inspect']);
const MUTATING_OPS = new Set(['edit', 'write', 'append', 'delete', 'bash']);

const CATASTROPHIC_BASH_PATTERNS = [
  /\brm\s+(?:-\w*[rf]\w*\s+)+(?:\/|~|\$HOME|\*)(?:\s|$|\/)/i,
  /\bmkfs\b/i,
  /\bdd\s+if=.*of=\/dev\//i,
  /\bgit\s+push\s+[^\n]*--force(?:-with-lease)?\s+[^\n]*(?:main|master)\b/i,
  /\bgit\s+reset\s+--hard\s+origin\/(?:main|master)\b/i,
  /:\(\)\s*\{\s*:\|:\s*&\s*\}\s*;/,
];

const MAX_READ_BYTES = 128 * 1024;
const MAX_BASH_OUTPUT = 64 * 1024;
const DEFAULT_BASH_TIMEOUT_MS = 30000;

function canonicalWorkspaceRoot(workspaceRoot) {
  const abs = path.resolve(String(workspaceRoot || process.cwd()));
  try {
    return fs.realpathSync(abs);
  } catch {
    return abs;
  }
}

function resolveWorkspacePath(workspaceRoot, rawPath) {
  const root = canonicalWorkspaceRoot(workspaceRoot);
  const input = String(rawPath || '.').trim() || '.';
  const candidate = path.isAbsolute(input) ? path.resolve(input) : path.resolve(root, input);
  let resolved = candidate;
  try {
    resolved = fs.realpathSync(candidate);
  } catch {
    const parent = path.dirname(candidate);
    try {
      resolved = path.join(fs.realpathSync(parent), path.basename(candidate));
    } catch {
      resolved = candidate;
    }
  }
  const rel = path.relative(root, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Path escapes workspace: ${input}`);
  }
  return { root, fullPath: resolved, relPath: rel || '.' };
}

function checkpointsRoot(baseDir) {
  if (baseDir) return path.resolve(baseDir);
  return path.join(stateHome(), '.atris', 'checkpoints');
}

function sanitizeKey(value) {
  return String(value || 'default').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80) || 'default';
}

function createCheckpointContext({ sessionId = 'default', turnId = '', baseDir } = {}) {
  const id = sanitizeKey(turnId || `cp-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`);
  const dir = path.join(checkpointsRoot(baseDir), sanitizeKey(sessionId), id);
  return {
    sessionId: sanitizeKey(sessionId),
    checkpointId: id,
    dir,
    manifestPath: path.join(dir, 'manifest.json'),
    files: new Map(),
    createdAt: new Date().toISOString(),
  };
}

function recordCheckpointFile(ctx, workspaceRoot, fullPath, relPath) {
  if (!ctx || ctx.files.has(relPath)) return;
  fs.mkdirSync(ctx.dir, { recursive: true, mode: 0o700 });
  const existed = fs.existsSync(fullPath);
  const snapshotName = `${ctx.files.size}-${crypto.createHash('sha1').update(relPath).digest('hex').slice(0, 12)}.bak`;
  const snapshotPath = path.join(ctx.dir, snapshotName);
  if (existed) {
    fs.writeFileSync(snapshotPath, fs.readFileSync(fullPath), { mode: 0o600 });
  }
  ctx.files.set(relPath, {
    relPath,
    existed,
    snapshotName: existed ? snapshotName : null,
  });
  const manifest = {
    schema: 'atris.checkpoint.v1',
    sessionId: ctx.sessionId,
    checkpointId: ctx.checkpointId,
    workspaceRoot: canonicalWorkspaceRoot(workspaceRoot),
    createdAt: ctx.createdAt,
    files: Array.from(ctx.files.values()),
  };
  fs.writeFileSync(ctx.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
}

function listCheckpoints(sessionId, { baseDir } = {}) {
  const dir = path.join(checkpointsRoot(baseDir), sanitizeKey(sessionId));
  if (!fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory());
  const out = [];
  for (const entry of entries) {
    const manifestPath = path.join(dir, entry.name, 'manifest.json');
    try {
      const data = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      if (data && Array.isArray(data.files) && data.files.length > 0) {
        out.push({ ...data, dir: path.join(dir, entry.name) });
      }
    } catch {}
  }
  return out.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
}

function restoreLatestCheckpoint(sessionId, { checkpointId = '', baseDir } = {}) {
  const list = listCheckpoints(sessionId, { baseDir });
  if (!list.length) return { ok: false, error: 'No checkpoint available to undo.' };
  const target = checkpointId
    ? list.find((item) => item.checkpointId === checkpointId || item.checkpointId.startsWith(checkpointId))
    : list[0];
  if (!target) return { ok: false, error: `Checkpoint not found: ${checkpointId}` };
  const restored = [];
  for (const item of target.files) {
    const { fullPath } = resolveWorkspacePath(target.workspaceRoot, item.relPath);
    if (item.existed && item.snapshotName) {
      const snap = path.join(target.dir, item.snapshotName);
      if (fs.existsSync(snap)) {
        fs.mkdirSync(path.dirname(fullPath), { recursive: true });
        fs.writeFileSync(fullPath, fs.readFileSync(snap));
        restored.push({ file: item.relPath, action: 'restored' });
      }
    } else if (!item.existed) {
      if (fs.existsSync(fullPath)) {
        fs.unlinkSync(fullPath);
        restored.push({ file: item.relPath, action: 'removed' });
      }
    }
  }
  try {
    fs.rmSync(target.dir, { recursive: true, force: true });
  } catch {}
  return {
    ok: true,
    checkpointId: target.checkpointId,
    restored,
  };
}

// Compute a clean unified diff with up to 3 lines of surrounding context.
function buildUnifiedDiff(relPath, beforeText, afterText, contextLines = 3) {
  const a = String(beforeText || '').replace(/\r\n/g, '\n');
  const b = String(afterText || '').replace(/\r\n/g, '\n');
  if (a === b) return null;
  const oldLines = a ? a.split('\n') : [];
  const newLines = b ? b.split('\n') : [];

  let prefix = 0;
  const minLen = Math.min(oldLines.length, newLines.length);
  while (prefix < minLen && oldLines[prefix] === newLines[prefix]) prefix += 1;

  let suffix = 0;
  while (
    suffix < (oldLines.length - prefix)
    && suffix < (newLines.length - prefix)
    && oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const oldStart = Math.max(0, prefix - contextLines);
  const oldEnd = Math.min(oldLines.length, oldLines.length - suffix + contextLines);
  const newStart = Math.max(0, prefix - contextLines);
  const newEnd = Math.min(newLines.length, newLines.length - suffix + contextLines);

  const removed = oldLines.slice(prefix, oldLines.length - suffix);
  const added = newLines.slice(prefix, newLines.length - suffix);
  const preCtx = oldLines.slice(oldStart, prefix);
  const postCtx = oldLines.slice(oldLines.length - suffix, oldEnd);

  const hunkHeader = `@@ -${oldStart + 1},${Math.max(0, oldEnd - oldStart)} +${newStart + 1},${Math.max(0, newEnd - newStart)} @@`;
  const lines = [
    `--- a/${relPath}`,
    `+++ b/${relPath}`,
    hunkHeader,
    ...preCtx.map((l) => ` ${l}`),
    ...removed.map((l) => `-${l}`),
    ...added.map((l) => `+${l}`),
    ...postCtx.map((l) => ` ${l}`),
  ];

  const MAX_DIFF_LINES = 140;
  let patch = lines.slice(0, MAX_DIFF_LINES).join('\n');
  if (lines.length > MAX_DIFF_LINES) {
    patch += `\n... (${lines.length - MAX_DIFF_LINES} more diff lines)`;
  }

  return {
    file: relPath,
    added: added.length,
    removed: removed.length,
    patch,
  };
}

function renderUnifiedDiff(diff, options = {}) {
  if (!diff || !diff.patch) return '';
  const useColor = options.color !== false && (options.isTTY !== false);
  const paint = (text, code) => (useColor ? `\x1b[${code}m${text}\x1b[0m` : text);
  const header = `${paint(diff.file, '1')} ${paint(`+${diff.added}`, '32')} ${paint(`-${diff.removed}`, '31')}`;
  const body = String(diff.patch)
    .split('\n')
    .map((line) => {
      if (line.startsWith('+++') || line.startsWith('---')) return paint(line, '2');
      if (line.startsWith('@@')) return paint(line, '36');
      if (line.startsWith('+')) return paint(line, '32');
      if (line.startsWith('-')) return paint(line, '31');
      return paint(line, '2');
    })
    .join('\n');
  return `${header}\n${body}`;
}

function evaluateToolPermission(args, options = {}) {
  const op = String((args && (args.type || args.op)) || '').trim().toLowerCase();
  const planMode = Boolean(options.planMode);
  const approveMode = String(options.approveMode || 'stage');
  const allowedTools = Array.isArray(options.allowedTools) && options.allowedTools.length
    ? new Set(options.allowedTools.map((t) => String(t).trim().toLowerCase()))
    : null;

  if (allowedTools && !allowedTools.has(op) && !allowedTools.has('*') && !allowedTools.has('local_file_op')) {
    return { decision: 'deny', reason: `Tool "${op}" is not in --allowedTools.` };
  }

  if (op === 'bash') {
    const cmd = String((args && (args.command || args.cmd)) || '').trim();
    for (const pat of CATASTROPHIC_BASH_PATTERNS) {
      if (pat.test(cmd)) {
        return { decision: 'deny', reason: 'Refused catastrophic shell command.' };
      }
    }
  }

  if (planMode && MUTATING_OPS.has(op)) {
    return {
      decision: 'deny',
      reason: `Plan mode is read-only (blocked ${op}). Run /plan to exit plan mode before changing files or running commands.`,
    };
  }

  if (READ_ONLY_OPS.has(op)) {
    return { decision: 'allow', reason: 'read-only' };
  }

  if (approveMode === 'auto') {
    return { decision: 'allow', reason: 'bypass-permissions' };
  }

  const sessionGrants = options.sessionGrants instanceof Set ? options.sessionGrants : null;
  if (sessionGrants && (sessionGrants.has(op) || sessionGrants.has('*'))) {
    return { decision: 'allow', reason: 'session-grant' };
  }

  return { decision: 'ask', reason: `mutating op: ${op}` };
}

function walkWorkspaceFiles(root, relDir, { maxFiles = 200, maxDepth = 6 } = {}) {
  const results = [];
  const startDir = relDir && relDir !== '.' ? path.join(root, relDir) : root;
  const walk = (dir, depth) => {
    if (results.length >= maxFiles || depth > maxDepth) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (results.length >= maxFiles) break;
      if (IGNORED_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full).split(path.sep).join('/');
      if (entry.isDirectory()) {
        results.push(`${rel}/`);
        walk(full, depth + 1);
      } else if (entry.isFile()) {
        results.push(rel);
      }
    }
  };
  walk(startDir, 0);
  return results;
}

function searchWorkspaceFallback(root, relStart, pattern, { maxMatches = 80 } = {}) {
  let regex;
  try {
    regex = new RegExp(pattern, 'i');
  } catch {
    const escaped = String(pattern || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    regex = new RegExp(escaped, 'i');
  }
  const matches = [];
  const files = walkWorkspaceFiles(root, relStart, { maxFiles: 600, maxDepth: 8 });
  for (const rel of files) {
    if (matches.length >= maxMatches) break;
    if (rel.endsWith('/')) continue;
    const full = path.join(root, rel);
    let stat;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    if (stat.size > 512 * 1024) continue;
    let text;
    try {
      const buf = fs.readFileSync(full);
      if (buf.includes(0)) continue;
      text = buf.toString('utf8');
    } catch {
      continue;
    }
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length && matches.length < maxMatches; i += 1) {
      if (regex.test(lines[i])) {
        matches.push(`${rel}:${i + 1}:${lines[i].slice(0, 240)}`);
      }
    }
  }
  return matches;
}

function runBoundedBash(command, cwd, timeoutMs = DEFAULT_BASH_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const child = spawn(process.env.SHELL || '/bin/sh', ['-lc', command], {
      cwd,
      env: { ...process.env, PAGER: 'cat', GIT_PAGER: 'cat' },
    });
    const finish = (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const combined = [stdout, stderr].filter(Boolean).join(stdout && stderr && !stdout.endsWith('\n') ? '\n' : '');
      const truncated = combined.length > MAX_BASH_OUTPUT
        ? `${combined.slice(0, MAX_BASH_OUTPUT)}\n... (output truncated)`
        : combined;
      resolve({
        ok: !timedOut && code === 0,
        exit_code: timedOut ? 124 : (typeof code === 'number' ? code : 1),
        signal: signal || null,
        timed_out: timedOut,
        stdout: stdout.slice(0, MAX_BASH_OUTPUT),
        stderr: stderr.slice(0, MAX_BASH_OUTPUT),
        output: truncated,
      });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch {}
      finish(124, 'SIGKILL');
    }, Math.max(1000, Math.min(timeoutMs, 120000)));
    child.stdout.on('data', (chunk) => {
      if (stdout.length < MAX_BASH_OUTPUT + 4096) stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      if (stderr.length < MAX_BASH_OUTPUT + 4096) stderr += chunk.toString('utf8');
    });
    child.on('error', (err) => {
      stderr += String((err && err.message) || err);
      finish(1, null);
    });
    child.on('close', (code, signal) => finish(code, signal));
  });
}

async function executeLocalFileOp(rawArgs = {}, options = {}) {
  const args = rawArgs && typeof rawArgs === 'object' ? rawArgs : {};
  const op = String(args.type || args.op || '').trim().toLowerCase();
  const cwd = canonicalWorkspaceRoot(options.cwd || process.cwd());

  if (!op) {
    return { status: 'error', error: 'local_file_op requires type (read|edit|write|append|delete|list|search|inspect|bash).' };
  }

  const perm = evaluateToolPermission(args, options);
  if (perm.decision === 'deny') {
    return { status: 'error', error: perm.reason, denied: true };
  }
  if (perm.decision === 'ask') {
    if (typeof options.requestApproval === 'function') {
      const target = op === 'bash'
        ? String(args.command || args.cmd || '').slice(0, 120)
        : String(args.path || '.');
      const decision = await options.requestApproval({ op, target, args });
      if (decision === 'session' && options.sessionGrants instanceof Set) {
        options.sessionGrants.add(op);
      } else if (decision !== 'allow' && decision !== true) {
        return { status: 'error', error: `User denied ${op} on ${target}.`, denied: true };
      }
    } else if (options.nonInteractiveDeny !== false) {
      return {
        status: 'error',
        error: `Approval required for ${op}. Re-run with --dangerously-skip-permissions or approve interactively.`,
        denied: true,
      };
    }
  }

  try {
    if (op === 'read') {
      const { fullPath, relPath } = resolveWorkspacePath(cwd, args.path);
      if (!fs.existsSync(fullPath)) return { status: 'error', error: `File not found: ${relPath}` };
      const stat = fs.statSync(fullPath);
      if (stat.isDirectory()) return { status: 'error', error: `Path is a directory: ${relPath}` };
      const buf = fs.readFileSync(fullPath);
      if (buf.includes(0)) return { status: 'error', error: `Binary file cannot be read as text: ${relPath}` };
      const text = buf.slice(0, MAX_READ_BYTES).toString('utf8');
      const allLines = text.split(/\r?\n/);
      const startLine = Math.max(1, Number(args.start_line || args.offset || 1) || 1);
      const limit = Math.max(1, Number(args.limit || args.max_lines || 400) || 400);
      const endLine = args.end_line ? Math.min(allLines.length, Number(args.end_line)) : Math.min(allLines.length, startLine + limit - 1);
      const slice = allLines.slice(startLine - 1, endLine);
      const numbered = slice.map((line, i) => `${startLine + i}: ${line}`).join('\n');
      return {
        status: 'ok',
        path: relPath,
        total_lines: allLines.length,
        start_line: startLine,
        end_line: endLine,
        truncated: buf.length > MAX_READ_BYTES || endLine < allLines.length,
        content: numbered,
      };
    }

    if (op === 'list') {
      const { relPath } = resolveWorkspacePath(cwd, args.path || '.');
      const files = walkWorkspaceFiles(cwd, relPath, {
        maxFiles: Math.min(500, Number(args.limit || 200) || 200),
        maxDepth: Math.min(10, Number(args.max_depth || 6) || 6),
      });
      return { status: 'ok', path: relPath, count: files.length, entries: files };
    }

    if (op === 'search') {
      const pattern = String(args.pattern || args.query || '').trim();
      if (!pattern) return { status: 'error', error: 'search requires pattern.' };
      const { relPath } = resolveWorkspacePath(cwd, args.path || '.');
      const matches = searchWorkspaceFallback(cwd, relPath, pattern, {
        maxMatches: Math.min(150, Number(args.limit || 80) || 80),
      });
      return { status: 'ok', path: relPath, pattern, count: matches.length, matches };
    }

    if (op === 'inspect') {
      const { fullPath, relPath } = resolveWorkspacePath(cwd, args.path || '.');
      if (!fs.existsSync(fullPath)) return { status: 'ok', path: relPath, exists: false };
      const stat = fs.statSync(fullPath);
      if (stat.isDirectory()) {
        const entries = fs.readdirSync(fullPath).slice(0, 80);
        return { status: 'ok', path: relPath, exists: true, kind: 'directory', entries };
      }
      const lines = stat.size <= MAX_READ_BYTES
        ? fs.readFileSync(fullPath, 'utf8').split(/\r?\n/).length
        : null;
      return {
        status: 'ok',
        path: relPath,
        exists: true,
        kind: 'file',
        bytes: stat.size,
        lines,
        mtime: stat.mtime.toISOString(),
      };
    }

    if (op === 'write') {
      const { fullPath, relPath } = resolveWorkspacePath(cwd, args.path);
      const before = fs.existsSync(fullPath) ? fs.readFileSync(fullPath, 'utf8') : '';
      const after = String(args.content ?? '');
      recordCheckpointFile(options.checkpoint, cwd, fullPath, relPath);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, after, 'utf8');
      const diff = buildUnifiedDiff(relPath, before, after);
      if (diff && Array.isArray(options.diffs)) options.diffs.push(diff);
      return {
        status: 'ok',
        path: relPath,
        bytes: Buffer.byteLength(after, 'utf8'),
        diff,
      };
    }

    if (op === 'append') {
      const { fullPath, relPath } = resolveWorkspacePath(cwd, args.path);
      const before = fs.existsSync(fullPath) ? fs.readFileSync(fullPath, 'utf8') : '';
      const addition = String(args.content ?? '');
      const after = before + addition;
      recordCheckpointFile(options.checkpoint, cwd, fullPath, relPath);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, after, 'utf8');
      const diff = buildUnifiedDiff(relPath, before, after);
      if (diff && Array.isArray(options.diffs)) options.diffs.push(diff);
      return { status: 'ok', path: relPath, bytes: Buffer.byteLength(after, 'utf8'), diff };
    }

    if (op === 'edit') {
      const { fullPath, relPath } = resolveWorkspacePath(cwd, args.path);
      if (!fs.existsSync(fullPath)) return { status: 'error', error: `File not found: ${relPath}` };
      const find = String(args.find ?? args.old_string ?? '');
      const replace = String(args.replace ?? args.new_string ?? '');
      if (!find) return { status: 'error', error: 'edit requires find/old_string.' };
      const before = fs.readFileSync(fullPath, 'utf8');
      const firstIdx = before.indexOf(find);
      if (firstIdx === -1) {
        return { status: 'error', error: `Target text not found in ${relPath}.` };
      }
      const replaceAll = Boolean(args.replace_all);
      const secondIdx = before.indexOf(find, firstIdx + find.length);
      if (!replaceAll && secondIdx !== -1) {
        return {
          status: 'error',
          error: `Target text appears multiple times in ${relPath}. Provide more surrounding context or set replace_all.`,
        };
      }
      const after = replaceAll
        ? before.split(find).join(replace)
        : before.slice(0, firstIdx) + replace + before.slice(firstIdx + find.length);
      recordCheckpointFile(options.checkpoint, cwd, fullPath, relPath);
      fs.writeFileSync(fullPath, after, 'utf8');
      const diff = buildUnifiedDiff(relPath, before, after);
      if (diff && Array.isArray(options.diffs)) options.diffs.push(diff);
      return {
        status: 'ok',
        path: relPath,
        replacements: replaceAll ? before.split(find).length - 1 : 1,
        diff,
      };
    }

    if (op === 'delete') {
      const { fullPath, relPath } = resolveWorkspacePath(cwd, args.path);
      if (!fs.existsSync(fullPath)) return { status: 'error', error: `File not found: ${relPath}` };
      const before = fs.readFileSync(fullPath, 'utf8');
      recordCheckpointFile(options.checkpoint, cwd, fullPath, relPath);
      fs.unlinkSync(fullPath);
      const diff = buildUnifiedDiff(relPath, before, '');
      if (diff && Array.isArray(options.diffs)) options.diffs.push(diff);
      return { status: 'ok', path: relPath, deleted: true, diff };
    }

    if (op === 'bash') {
      const cmd = String(args.command || args.cmd || '').trim();
      if (!cmd) return { status: 'error', error: 'bash requires command.' };
      const runDir = args.cwd ? resolveWorkspacePath(cwd, args.cwd).fullPath : cwd;
      const timeoutMs = Number(args.timeout_ms || args.timeoutMs || DEFAULT_BASH_TIMEOUT_MS);
      const res = await runBoundedBash(cmd, runDir, timeoutMs);
      return {
        status: res.ok ? 'ok' : 'error',
        exit_code: res.exit_code,
        timed_out: res.timed_out,
        output: res.output,
      };
    }

    return { status: 'error', error: `Unsupported local_file_op type: ${op}` };
  } catch (error) {
    return { status: 'error', error: String((error && error.message) || error) };
  }
}

module.exports = {
  createCheckpointContext,
  listCheckpoints,
  restoreLatestCheckpoint,
  renderUnifiedDiff,
  evaluateToolPermission,
  executeLocalFileOp,
};
