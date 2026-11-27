'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { acquireFileLock, pidAlive } = require('./file-lock');
const { isConductorUntracked } = require('./conductor-artifacts');
const { localDay } = require('./local-day');
const { runGit, listActiveProcessPaths, createAgentWorktree } = require('./worktree-core');

const DEFAULT_GRACE_MS = 30 * 60 * 1000;
const LOCK_DIR_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const FAT_FILE_BYTES = 50 * 1024 * 1024;
const CATALOG_RING_SIZE = 20;
const COMMAND_MAX_BUFFER_BYTES = 64 * 1024 * 1024;
const GIT_CHUNK_SIZE = 200;
const EMPTY_TREE_OID = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

const REGEN_ADAPTER_FILES = [
  'AGENTS.md',
  'CLAUDE.md',
  'GEMINI.md',
  '.atris/state/tasks.projection.json',
];

const SECRET_PATH = /(^|\/)(\.(aws|ssh|gnupg|docker|kube)\/|\.env(\.[^/]*)?$|\.npmrc$|\.netrc$|credentials?$|[^/]*credentials?[^/]*\.(json|ya?ml|txt)$|secrets?\.(json|ya?ml|txt|env)$|[^/]*\.(pem|key|p12|pfx)$|id_(rsa|ed25519|ecdsa)[^/]*$|service[-_]account[^/]*\.json$)/i;
const OS_JUNK_RE = /(?:^|\/)(?:\.DS_Store|Thumbs\.db|[^/]+\.sw[po]|__pycache__\/[^/]+\.pyc|\.pytest_cache\/.*|[^/]+\.tmp)$/;
const FAT_OR_DB_EXT_RE = /\.(?:safetensors|pt|pth|gguf|ckpt|onnx|bin|db|db-wal|db-shm|sqlite|sqlite3|duckdb)$/i;
const REGEN_TRACKED_SET = new Set([
  ...REGEN_ADAPTER_FILES,
  'atris/TODO.md',
  'atris/now.md',
  'atris/status/now.md',
  'atris/brain/STATUS.md',
  'atris/brain/state.json',
  'atris/brain/self_improvement_ledger.md',
  'atris/wiki/STATUS.md',
]);
const EXHAUST_PREFIX_RE = /^(?:atris\/(?:features|campaigns|night|rsi|experiments|research|brief|logs|wiki|team|benchmarks|security|qa|runs)\/|atris\/(?:ROSTER|personal_context)\.md$|notes\/|output\/|backend\/robinhood\/data\/|\.claude\/|\.codex\/agents\/)/;
const ROOT_SCRATCH_RE = /^[^/]+\.(?:html|txt|md|bak|old|tmp)$/i;
const LOCK_OR_WAL_NAME_RE = /(?:\.lock|-(?:wal|shm))$/i;

function toPosixPath(relPath) {
  return String(relPath || '').split(path.sep).join('/');
}

function canonicalPath(value) {
  try {
    return fs.realpathSync(value);
  } catch {
    return path.resolve(value);
  }
}

function safeLstat(filePath) {
  try {
    return fs.lstatSync(filePath);
  } catch {
    return null;
  }
}

function resolveExactGitRoot(cwd) {
  const res = runGit(['rev-parse', '--show-toplevel'], { cwd, check: false });
  if (res.status !== 0 || !String(res.stdout || '').trim()) return null;
  try {
    const top = fs.realpathSync(res.stdout.trim());
    return top === fs.realpathSync(cwd) ? top : null;
  } catch {
    return null;
  }
}

function bundleKeyFor(relPath) {
  const parts = toPosixPath(relPath).split('/');
  if (parts[0] === 'atris' && parts.length >= 3) return `${parts[0]}/${parts[1]}/${parts[2]}`;
  if (parts.length >= 2) return `${parts[0]}/${parts[1]}`;
  return '(root)';
}

function graceKeyFor(relPath) {
  const key = bundleKeyFor(relPath);
  return key === '(root)' ? toPosixPath(relPath) : key;
}

function todayJournalRelPath(date = new Date()) {
  const day = localDay(date);
  return `atris/logs/${day.slice(0, 4)}/${day}.md`;
}

function compactStamp(now = new Date()) {
  return now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '').replace('T', '-');
}

function parsePorcelainZ(stdout) {
  const fields = String(stdout || '').split('\0');
  const entries = [];
  for (let i = 0; i < fields.length; i += 1) {
    const row = fields[i];
    if (!row || row.length < 4) continue;
    const xy = row.slice(0, 2);
    const rawPath = row.slice(3);
    const isDirEntry = rawPath.endsWith('/');
    const relPath = toPosixPath(rawPath.replace(/\/+$/, ''));
    let origPath = null;
    if (xy[0] === 'R' || xy[0] === 'C') {
      origPath = toPosixPath(fields[i + 1] || '');
      i += 1;
    }
    if (!relPath) continue;
    entries.push({ xy, relPath, origPath, isDirEntry });
  }
  return entries;
}

function findUnprovablePaths(root, rawEntries) {
  const unprovable = new Set();
  const nonConductor = rawEntries.filter((e) => !(e.xy === '??' && isConductorUntracked(e.relPath)));
  if (!nonConductor.length) return unprovable;

  for (const e of nonConductor) {
    if (e.xy.includes('U') || e.xy === 'AA' || e.xy === 'DD') unprovable.add(e.relPath);
    if (e.isDirEntry || fs.existsSync(path.join(root, e.relPath, '.git'))) unprovable.add(e.relPath);
  }

  const flags = runGit(['ls-files', '-v', '-z'], { cwd: root, check: false });
  if (flags.status !== 0) {
    for (const e of nonConductor) unprovable.add(e.relPath);
    return unprovable;
  }
  for (const row of String(flags.stdout || '').split('\0')) {
    if (row && /^[a-zS]/.test(row)) unprovable.add(toPosixPath(row.slice(2)));
  }

  const conflicts = runGit(['ls-files', '-u', '-z'], { cwd: root, check: false });
  if (conflicts.status !== 0) {
    for (const e of nonConductor) unprovable.add(e.relPath);
    return unprovable;
  }
  for (const row of String(conflicts.stdout || '').split('\0')) {
    if (!row) continue;
    const tabIdx = row.indexOf('\t');
    if (tabIdx !== -1) unprovable.add(toPosixPath(row.slice(tabIdx + 1)));
  }

  const stageRows = runGit(['ls-files', '-s', '-z'], { cwd: root, check: false });
  if (stageRows.status === 0) {
    for (const row of String(stageRows.stdout || '').split('\0')) {
      const m = row.match(/^160000 [0-9a-f]+ \d\t(.+)$/);
      if (m) unprovable.add(toPosixPath(m[1]));
    }
  }

  const pathsToAttrCheck = nonConductor.map((e) => e.relPath).filter((p) => !unprovable.has(p));
  if (pathsToAttrCheck.length > 0) {
    const attrs = spawnSync('git', ['check-attr', 'filter', 'ident', 'working-tree-encoding', '-z', '--stdin'], {
      cwd: root,
      encoding: 'utf8',
      input: `${pathsToAttrCheck.join('\0')}\0`,
      maxBuffer: COMMAND_MAX_BUFFER_BYTES,
    });
    if (attrs.status !== 0) {
      for (const p of pathsToAttrCheck) unprovable.add(p);
    } else {
      const parts = String(attrs.stdout || '').split('\0');
      for (let i = 0; i + 2 < parts.length; i += 3) {
        const attrPath = toPosixPath(parts[i]);
        const value = parts[i + 2];
        if (value && value !== 'unspecified' && value !== 'unset') {
          unprovable.add(attrPath);
        }
      }
    }
  }

  return unprovable;
}

function isLockFileActive(absPath, nowMs) {
  const st = safeLstat(absPath);
  if (!st || !st.isFile()) return false;
  if (st.size > 0 && st.size <= 4096) {
    try {
      const raw = fs.readFileSync(absPath, 'utf8').trim();
      if (/^\d+$/.test(raw)) {
        if (pidAlive(Number(raw))) return true;
      } else if (raw.startsWith('{')) {
        const parsed = JSON.parse(raw);
        if (parsed && Number.isInteger(Number(parsed.pid)) && Number(parsed.pid) > 0) {
          if (pidAlive(Number(parsed.pid))) return true;
        }
      }
    } catch {
      // Binary or non-JSON WAL/lock content falls back to mtime window.
    }
  }
  return nowMs - st.mtimeMs < LOCK_DIR_MAX_AGE_MS;
}

function findActiveLockDirs(root, rawEntries, nowMs) {
  const lockedDirs = new Set();
  const checkedDirs = new Set();

  for (const e of rawEntries) {
    if (e.xy === '??' && isConductorUntracked(e.relPath)) continue;
    const dir = toPosixPath(path.posix.dirname(e.relPath));
    if (dir === '.atris' || dir.startsWith('.atris/')) continue;
    if (checkedDirs.has(dir)) continue;
    checkedDirs.add(dir);

    const absDir = dir === '.' ? root : path.join(root, dir);
    let names;
    try {
      names = fs.readdirSync(absDir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!LOCK_OR_WAL_NAME_RE.test(name)) continue;
      if (isLockFileActive(path.join(absDir, name), nowMs)) {
        lockedDirs.add(dir);
        break;
      }
    }
  }
  return lockedDirs;
}

function inLockedDir(relPath, lockedDirs) {
  if (!lockedDirs || lockedDirs.size === 0) return false;
  for (const d of lockedDirs) {
    if (d === '.') {
      if (!relPath.includes('/')) return true;
    } else if (relPath === d || relPath.startsWith(`${d}/`)) {
      return true;
    }
  }
  return false;
}

function classifyEntry(entry, ctx = {}) {
  const relPath = toPosixPath(ctx.relPath || entry.relPath || entry.path || '');
  const xy = ctx.xy || entry.xy || '??';
  const {
    root = '',
    stat0 = entry.stat0 || null,
    unprovableSet = new Set(),
    openFiles = null,
    lockedDirs = new Set(),
    bundleNewest = new Map(),
    nowMs = Date.now(),
    graceMs = DEFAULT_GRACE_MS,
    todayJournal = todayJournalRelPath(new Date(nowMs)),
  } = ctx;

  if (xy === '??' && isConductorUntracked(relPath)) return 'CONDUCTOR_PLUMBING';
  if (unprovableSet.has(relPath)) return 'UNPROVABLE_KEEP';
  if (relPath === todayJournal) return 'ACTIVE_IN_FLIGHT';
  if (openFiles && root) {
    const abs = path.join(root, relPath);
    if (openFiles.has(abs) || openFiles.has(canonicalPath(abs))) return 'ACTIVE_IN_FLIGHT';
  }
  if (inLockedDir(relPath, lockedDirs)) return 'ACTIVE_IN_FLIGHT';
  if (graceMs > 0 && (bundleNewest.get(graceKeyFor(relPath)) || 0) > nowMs - graceMs) {
    return 'ACTIVE_IN_FLIGHT';
  }

  if (
    SECRET_PATH.test(relPath)
    || /owner_wallets\.json$/i.test(relPath)
    || (stat0 && stat0.size > FAT_FILE_BYTES)
    || FAT_OR_DB_EXT_RE.test(relPath)
  ) {
    return 'SECRET_OR_FAT_QUARANTINE';
  }
  if (xy === '??' && OS_JUNK_RE.test(relPath)) return 'OS_BYTECODE_JUNK';
  if (xy !== '??' && (REGEN_TRACKED_SET.has(relPath) || /^atris\/team\/[^/]+\/now\.md$/.test(relPath))) {
    return 'REGEN_CHURN';
  }
  if (EXHAUST_PREFIX_RE.test(relPath)) return 'AGENT_EXHAUST';
  if (xy === '??' && !relPath.includes('/') && ROOT_SCRATCH_RE.test(relPath)) return 'LOOSE_SCRATCH';
  return 'UNFINISHED_CODE';
}

function summarizeTopBundles(entries, limit = 5) {
  const counts = new Map();
  for (const e of entries) {
    const b = e.bundle || bundleKeyFor(e.relPath);
    counts.set(b, (counts.get(b) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([bundle, count]) => ({ bundle, count }))
    .sort((a, b) => b.count - a.count || a.bundle.localeCompare(b.bundle))
    .slice(0, limit);
}

function scanGitHygiene(cwd, options = {}) {
  const {
    graceMs = DEFAULT_GRACE_MS,
    nowMs = Date.now(),
    requireProcessScan = false,
    probeProcesses = true,
    listActivePaths = listActiveProcessPaths,
  } = options;

  const root = resolveExactGitRoot(cwd);
  if (!root) {
    return {
      isGitRepo: false,
      dirtyCount: 0,
      actionableCount: 0,
      remainingDirty: 0,
      byClass: {},
      entries: [],
      topBundles: [],
    };
  }

  const rawEntries = parsePorcelainZ(
    runGit(['status', '--porcelain=v1', '-z', '-uall'], { cwd: root }).stdout
  );
  if (!rawEntries.length) {
    return {
      isGitRepo: true,
      root,
      dirtyCount: 0,
      actionableCount: 0,
      remainingDirty: 0,
      byClass: {},
      entries: [],
      topBundles: [],
    };
  }

  const unprovableSet = findUnprovablePaths(root, rawEntries);
  let openFiles = null;
  if (probeProcesses || requireProcessScan) {
    const activePaths = listActivePaths();
    if (requireProcessScan && !Array.isArray(activePaths)) {
      throw new Error('Active process scan (lsof) failed; refusing destructive clean.');
    }
    if (Array.isArray(activePaths)) {
      openFiles = new Set(activePaths.map((p) => canonicalPath(p)));
    }
  }

  const lockedDirs = findActiveLockDirs(root, rawEntries, nowMs);
  const stats = new Map();
  const bundleNewest = new Map();
  for (const e of rawEntries) {
    if (e.xy === '??' && isConductorUntracked(e.relPath)) continue;
    const st = safeLstat(path.join(root, e.relPath));
    stats.set(e.relPath, st);
    const key = graceKeyFor(e.relPath);
    if (st) bundleNewest.set(key, Math.max(bundleNewest.get(key) || 0, st.mtimeMs));
  }

  const todayJournal = todayJournalRelPath(new Date(nowMs));
  const entries = [];
  const byClass = {};
  for (const e of rawEntries) {
    const cls = classifyEntry(e, {
      root,
      relPath: e.relPath,
      xy: e.xy,
      stat0: stats.get(e.relPath) || null,
      unprovableSet,
      openFiles,
      lockedDirs,
      bundleNewest,
      nowMs,
      graceMs,
      todayJournal,
    });
    if (cls === 'CONDUCTOR_PLUMBING') continue;
    const item = {
      ...e,
      cls,
      stat0: stats.get(e.relPath) || null,
      bundle: bundleKeyFor(e.relPath),
    };
    entries.push(item);
    byClass[cls] = (byClass[cls] || 0) + 1;
  }

  const actionable = entries.filter((e) => !['UNPROVABLE_KEEP', 'ACTIVE_IN_FLIGHT'].includes(e.cls));
  return {
    isGitRepo: true,
    root,
    dirtyCount: entries.length,
    actionableCount: actionable.length,
    remainingDirty: entries.length,
    byClass,
    entries,
    topBundles: summarizeTopBundles(entries),
  };
}

function writeFileAtomic(filePath, content, mode) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  const fd = fs.openSync(tmp, 'w', mode ?? 0o644);
  try {
    fs.writeFileSync(fd, content, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, filePath);
}

function writeJsonAtomic(filePath, data) {
  writeFileAtomic(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.allocUnsafe(65536);
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      hash.update(buf.subarray(0, n));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function chmodHierarchy(baseDir, targetDir, mode) {
  const rel = path.relative(baseDir, targetDir);
  if (!rel || rel.startsWith('..')) return;
  let current = baseDir;
  try { fs.chmodSync(current, mode); } catch {}
  for (const part of rel.split(path.sep)) {
    current = path.join(current, part);
    try { fs.chmodSync(current, mode); } catch {}
  }
}

function defaultQuarantineBase(quarantineRoot) {
  return quarantineRoot || path.join(os.homedir(), '.atris', 'quarantine');
}

function stageQuarantineFiles(root, vaultId, items, quarantineRoot) {
  const base = defaultQuarantineBase(quarantineRoot);
  const repoName = path.basename(root);
  const destRoot = path.join(base, repoName, vaultId);
  fs.mkdirSync(destRoot, { recursive: true, mode: 0o700 });
  chmodHierarchy(base, destRoot, 0o700);

  for (const item of items) {
    const src = path.join(root, item.relPath);
    const st = safeLstat(src);
    if (!st) continue;
    const dest = path.resolve(destRoot, item.relPath);
    if (dest !== destRoot && !dest.startsWith(destRoot + path.sep)) {
      throw new Error(`Unsafe quarantine path: ${item.relPath}`);
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
    chmodHierarchy(destRoot, path.dirname(dest), 0o700);

    if (st.isSymbolicLink()) {
      fs.symlinkSync(fs.readlinkSync(src), dest);
      continue;
    }

    const srcHash = sha256File(src);
    fs.copyFileSync(src, dest);
    const fd = fs.openSync(dest, 'r+');
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.chmodSync(dest, 0o600);
    const destStat = fs.lstatSync(dest);
    const destHash = sha256File(dest);
    if (destStat.size !== st.size || destHash !== srcHash) {
      throw new Error(`Quarantine verification mismatch for ${item.relPath}`);
    }
  }
  return destRoot;
}

function commitIdentityEnv(root, baseEnv = process.env) {
  const email = runGit(['config', 'user.email'], { cwd: root, check: false });
  const name = runGit(['config', 'user.name'], { cwd: root, check: false });
  const env = { ...baseEnv };
  if (email.status !== 0 || !String(email.stdout || '').trim()) {
    env.GIT_AUTHOR_EMAIL = '299057014+atris-builder[bot]@users.noreply.github.com';
    env.GIT_COMMITTER_EMAIL = env.GIT_AUTHOR_EMAIL;
  }
  if (name.status !== 0 || !String(name.stdout || '').trim()) {
    env.GIT_AUTHOR_NAME = 'atris-clean-vault';
    env.GIT_COMMITTER_NAME = env.GIT_AUTHOR_NAME;
  }
  return env;
}

function buildTreeWithTempIndex(root, tmpIndex, headOid, items) {
  try { fs.rmSync(tmpIndex, { force: true }); } catch {}
  const env = { ...process.env, GIT_INDEX_FILE: tmpIndex };
  const gitIdx = (args, input) => {
    const res = spawnSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      env,
      input,
      maxBuffer: COMMAND_MAX_BUFFER_BYTES,
    });
    if (res.status !== 0) {
      throw new Error(String(res.stderr || res.stdout || `git ${args.join(' ')} failed`).trim());
    }
    return String(res.stdout || '').trim();
  };

  if (headOid) gitIdx(['read-tree', headOid]);

  const present = [];
  const absent = [];
  for (const item of items) {
    const abs = path.join(root, item.relPath);
    if (item.origPath && item.origPath !== item.relPath) absent.push(item.origPath);
    if (safeLstat(abs)) present.push(item.relPath);
    else absent.push(item.relPath);
  }

  if (present.length) {
    gitIdx(['update-index', '--add', '--replace', '-z', '--stdin'], `${present.join('\0')}\0`);
  }
  if (absent.length) {
    gitIdx(['update-index', '--force-remove', '-z', '--stdin'], `${absent.join('\0')}\0`);
  }
  return gitIdx(['write-tree']);
}

function parseLsTreeZ(root, treeOrCommitOid, pathPrefixes = []) {
  const args = ['ls-tree', '-r', '-z', treeOrCommitOid];
  if (pathPrefixes.length) args.push('--', ...pathPrefixes);
  const res = runGit(args, { cwd: root });
  const map = new Map();
  for (const record of String(res.stdout || '').split('\0')) {
    if (!record) continue;
    const tabIdx = record.indexOf('\t');
    if (tabIdx === -1) continue;
    const meta = record.slice(0, tabIdx).split(' ');
    const relPath = toPosixPath(record.slice(tabIdx + 1));
    map.set(relPath, { mode: meta[0], type: meta[1], oid: meta[2], relPath });
  }
  return map;
}

function verifyMerkleTree(root, fullTreeOid, vaultable) {
  const treeMap = parseLsTreeZ(root, fullTreeOid);
  const regularFiles = [];

  for (const item of vaultable) {
    const abs = path.join(root, item.relPath);
    const st = safeLstat(abs);
    if (!st) {
      if (treeMap.has(item.relPath)) {
        throw new Error(`Merkle proof failed: deleted path ${item.relPath} still present in vault tree`);
      }
      continue;
    }
    const treeEntry = treeMap.get(item.relPath);
    if (!treeEntry) {
      throw new Error(`Merkle proof failed: ${item.relPath} missing from vault tree`);
    }
    if (st.isSymbolicLink()) {
      if (treeEntry.mode !== '120000') {
        throw new Error(`Merkle proof failed: symlink mode mismatch for ${item.relPath}`);
      }
      const linkTarget = fs.readlinkSync(abs);
      const hashed = spawnSync('git', ['hash-object', '--stdin'], {
        cwd: root,
        encoding: 'utf8',
        input: linkTarget,
        maxBuffer: COMMAND_MAX_BUFFER_BYTES,
      });
      if (hashed.status !== 0 || hashed.stdout.trim() !== treeEntry.oid) {
        throw new Error(`Merkle proof failed: symlink OID mismatch for ${item.relPath}`);
      }
    } else {
      regularFiles.push(item.relPath);
    }
  }

  const safeBatch = regularFiles.filter((p) => !p.includes('\n'));
  const newlineFiles = regularFiles.filter((p) => p.includes('\n'));

  for (let i = 0; i < safeBatch.length; i += GIT_CHUNK_SIZE) {
    const chunk = safeBatch.slice(i, i + GIT_CHUNK_SIZE);
    const hashed = spawnSync('git', ['hash-object', '--stdin-paths'], {
      cwd: root,
      encoding: 'utf8',
      input: `${chunk.join('\n')}\n`,
      maxBuffer: COMMAND_MAX_BUFFER_BYTES,
    });
    if (hashed.status !== 0) {
      throw new Error(`git hash-object failed: ${String(hashed.stderr || '').trim()}`);
    }
    const oids = String(hashed.stdout || '').trim().split(/\r?\n/);
    if (oids.length !== chunk.length) {
      throw new Error('Merkle proof failed: hash-object output count mismatch');
    }
    for (let j = 0; j < chunk.length; j += 1) {
      const relPath = chunk[j];
      if (treeMap.get(relPath).oid !== oids[j]) {
        throw new Error(`Merkle proof failed: OID mismatch for ${relPath}`);
      }
    }
  }

  for (const relPath of newlineFiles) {
    const hashed = runGit(['hash-object', '--', relPath], { cwd: root });
    if (treeMap.get(relPath).oid !== hashed.stdout.trim()) {
      throw new Error(`Merkle proof failed: OID mismatch for ${relPath}`);
    }
  }
}

function createVaultCommit(root, { treeOid, headOid, vaultId, slice, paths, quarantinePaths }) {
  const args = ['commit-tree', treeOid];
  if (headOid) args.push('-p', headOid);
  const meta = { vaultId, slice, paths, quarantine: quarantinePaths };
  const message = `atris vault snapshot ${vaultId} (${slice})\n\natris.vault.v1: ${JSON.stringify(meta)}`;
  args.push('-m', message);
  const res = spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    env: commitIdentityEnv(root),
    maxBuffer: COMMAND_MAX_BUFFER_BYTES,
  });
  if (res.status !== 0) {
    throw new Error(String(res.stderr || res.stdout || 'git commit-tree failed').trim());
  }
  return res.stdout.trim();
}

function buildAndVerifyVaultRefs(root, {
  vaultId,
  headOid,
  vaultable,
  codeItems,
  exhaustItems,
  quarantineItems,
  beforeMerkleVerify,
}) {
  const tmpIndex = path.join(
    os.tmpdir(),
    `atris-vault-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.index`
  );
  try {
    let headTreeOid = EMPTY_TREE_OID;
    if (headOid) {
      headTreeOid = runGit(['rev-parse', `${headOid}^{tree}`], { cwd: root }).stdout.trim();
    }

    const quarantinePaths = quarantineItems.map((e) => e.relPath);
    const realIndex = String(
      runGit(['rev-parse', '--path-format=absolute', '--git-path', 'index'], { cwd: root, check: false }).stdout || ''
    ).trim();
    let stagedTreeOid = null;
    if (realIndex && fs.existsSync(realIndex)) {
      fs.copyFileSync(realIndex, tmpIndex);
      const tmpEnv = { ...process.env, GIT_INDEX_FILE: tmpIndex };
      if (quarantinePaths.length > 0) {
        for (let i = 0; i < quarantinePaths.length; i += GIT_CHUNK_SIZE) {
          const chunk = quarantinePaths.slice(i, i + GIT_CHUNK_SIZE);
          spawnSync('git', ['rm', '--cached', '--ignore-unmatch', '-q', '--', ...chunk], {
            cwd: root,
            encoding: 'utf8',
            env: tmpEnv,
            maxBuffer: COMMAND_MAX_BUFFER_BYTES,
          });
        }
      }
      const wt = spawnSync('git', ['write-tree'], {
        cwd: root,
        encoding: 'utf8',
        env: tmpEnv,
      });
      if (wt.status === 0) {
        const candidate = wt.stdout.trim();
        if (candidate && candidate !== headTreeOid) stagedTreeOid = candidate;
      }
    }

    const fullTreeOid = vaultable.length
      ? buildTreeWithTempIndex(root, tmpIndex, headOid, vaultable)
      : headTreeOid;
    if (typeof beforeMerkleVerify === 'function') beforeMerkleVerify({ root, vaultId, fullTreeOid });
    if (vaultable.length) verifyMerkleTree(root, fullTreeOid, vaultable);

    const codeTreeOid = codeItems.length
      ? buildTreeWithTempIndex(root, tmpIndex, headOid, codeItems)
      : null;
    const exhaustTreeOid = exhaustItems.length
      ? buildTreeWithTempIndex(root, tmpIndex, headOid, exhaustItems)
      : null;

    const refCommits = new Map();
    const fullRef = `refs/atris/vault/${vaultId}/full`;
    refCommits.set(fullRef, createVaultCommit(root, {
      treeOid: fullTreeOid,
      headOid,
      vaultId,
      slice: 'full',
      paths: vaultable.map((e) => e.relPath),
      quarantinePaths,
    }));

    if (stagedTreeOid) {
      const stagedPaths = parseDiffPaths(root, headTreeOid, stagedTreeOid);
      refCommits.set(`refs/atris/vault/${vaultId}/staged`, createVaultCommit(root, {
        treeOid: stagedTreeOid,
        headOid,
        vaultId,
        slice: 'staged',
        paths: stagedPaths,
        quarantinePaths: [],
      }));
    }

    if (codeTreeOid) {
      refCommits.set(`refs/atris/vault/${vaultId}/code`, createVaultCommit(root, {
        treeOid: codeTreeOid,
        headOid,
        vaultId,
        slice: 'code',
        paths: codeItems.map((e) => e.relPath),
        quarantinePaths: [],
      }));
    }

    if (exhaustTreeOid) {
      refCommits.set(`refs/atris/vault/${vaultId}/exhaust`, createVaultCommit(root, {
        treeOid: exhaustTreeOid,
        headOid,
        vaultId,
        slice: 'exhaust',
        paths: exhaustItems.map((e) => e.relPath),
        quarantinePaths: [],
      }));
    }

    const txLines = ['start'];
    for (const [refName, commitOid] of refCommits) {
      txLines.push(`create ${refName} ${commitOid}`);
    }
    txLines.push('prepare', 'commit', '');

    const updated = spawnSync('git', ['update-ref', '--stdin'], {
      cwd: root,
      encoding: 'utf8',
      input: txLines.join('\n'),
    });
    if (updated.status !== 0) {
      throw new Error(`git update-ref --stdin failed: ${String(updated.stderr || updated.stdout || '').trim()}`);
    }

    const refs = {};
    for (const [refName] of refCommits) {
      const slice = refName.split('/').pop();
      refs[slice] = refName;
    }
    return refs;
  } finally {
    try { fs.rmSync(tmpIndex, { force: true }); } catch {}
  }
}

function parseDiffPaths(root, baseTreeOid, targetTreeOid) {
  const res = runGit(['diff-tree', '-r', '-z', '--name-only', baseTreeOid, targetTreeOid], { cwd: root, check: false });
  if (res.status !== 0) return [];
  return String(res.stdout || '').split('\0').filter(Boolean).map(toPosixPath);
}

function readIndexRecords(root) {
  const indexPath = path.join(root, '.atris', 'state', 'vault-index.jsonl');
  if (!fs.existsSync(indexPath)) return [];
  const records = [];
  for (const line of fs.readFileSync(indexPath, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && parsed.id) records.push(parsed);
    } catch {
      // Ignore partial lines.
    }
  }
  return records;
}

function renderCatalogMarkdown(records) {
  const recent = records.slice(-CATALOG_RING_SIZE).reverse();
  const lines = [`# Vault Catalog (latest ${CATALOG_RING_SIZE} epochs)`, ''];
  for (const r of recent) {
    const day = String(r.at || '').slice(0, 10) || 'unknown';
    const codeList = r.code_files || [];
    const codeSample = codeList.length
      ? ` (${codeList.slice(0, 2).join(', ')}${codeList.length > 2 ? ', ...' : ''})`
      : '';
    const exhaustCount = (r.counts_by_class && r.counts_by_class.AGENT_EXHAUST) || (r.exhaust_files || []).length || 0;
    const bundleSummary = (r.top_bundles || [])
      .slice(0, 3)
      .map((b) => `${b.bundle} ${b.count}`)
      .join(', ');
    const exhaustNote = bundleSummary ? ` (${bundleSummary})` : '';
    lines.push(`- **${r.id}** (${day}), code: ${codeList.length} files${codeSample}, exhaust: ${exhaustCount} files${exhaustNote}`);
    lines.push(`  Restore code flight: \`atris restore ${r.id} --slice code --worktree\` | Restore path: \`atris restore ${r.id} <path>\``);
  }
  return `${lines.join('\n')}\n`;
}

function appendVaultDigest(root, {
  vaultId,
  now,
  headOid,
  refs,
  quarantineDir,
  scan,
  vaultable,
  codeItems,
  exhaustItems,
  quarantineItems,
}) {
  const stateDir = path.join(root, '.atris', 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const indexPath = path.join(stateDir, 'vault-index.jsonl');
  const existing = readIndexRecords(root);
  if (existing.some((r) => r.id === vaultId)) {
    return existing.find((r) => r.id === vaultId);
  }

  const receipt = {
    id: vaultId,
    at: now.toISOString(),
    head_oid: headOid,
    refs,
    counts_by_class: scan.byClass,
    top_bundles: scan.topBundles,
    code_files: codeItems.map((e) => e.relPath),
    exhaust_files: exhaustItems.map((e) => e.relPath),
    vaulted_files: vaultable.map((e) => e.relPath),
    quarantine_files: quarantineItems.map((e) => e.relPath),
    quarantine_path: quarantineDir,
    restore_cmds: {
      list: 'atris restore --list',
      code_worktree: `atris restore ${vaultId} --slice code --worktree`,
      full: `atris restore ${vaultId}`,
    },
  };

  fs.appendFileSync(indexPath, `${JSON.stringify(receipt)}\n`, 'utf8');
  const allRecords = [...existing, receipt];
  writeFileAtomic(path.join(stateDir, 'vault-catalog.md'), renderCatalogMarkdown(allRecords));
  return receipt;
}

function casMatches(root, entry) {
  const abs = path.join(root, entry.relPath);
  const stNow = safeLstat(abs);
  const st0 = entry.stat0;
  if (!st0) return stNow === null;
  if (!stNow) return false;
  return stNow.ino === st0.ino && stNow.size === st0.size && stNow.mtimeMs === st0.mtimeMs;
}

function pruneEmptyParentDirs(root, startDirs) {
  const realRoot = canonicalPath(root);
  const queue = [...new Set(startDirs)].sort((a, b) => b.length - a.length);
  for (const dir of queue) {
    let cur = dir;
    while (cur && canonicalPath(cur) !== realRoot) {
      const rel = toPosixPath(path.relative(root, cur));
      if (!rel || rel.startsWith('..') || rel === '.git' || rel === '.atris') break;
      try {
        if (fs.readdirSync(cur).length > 0) break;
        fs.rmdirSync(cur);
        cur = path.dirname(cur);
      } catch {
        break;
      }
    }
  }
}

function runGitChunked(root, baseArgs, paths) {
  for (let i = 0; i < paths.length; i += GIT_CHUNK_SIZE) {
    const chunk = paths.slice(i, i + GIT_CHUNK_SIZE);
    runGit([...baseArgs, '--', ...chunk], { cwd: root });
  }
}

function executeCasWorkingTreeReset(root, entries, { hasHead = true } = {}) {
  const skippedConcurrentEdit = [];
  const skippedPermissionLocked = [];
  const untrackedToUnlink = [];
  const stagedAddedToDrop = [];
  const stagedToReset = [];
  const trackedToCheckout = [];
  const renamesToRestore = [];

  for (const entry of entries) {
    if (!casMatches(root, entry)) {
      skippedConcurrentEdit.push(entry.relPath);
      continue;
    }
    const xy = entry.xy || '??';
    if (xy === '??') {
      untrackedToUnlink.push(entry.relPath);
    } else if (xy[0] === 'A' || xy[1] === 'A') {
      stagedAddedToDrop.push(entry.relPath);
    } else if (xy[0] === 'R') {
      renamesToRestore.push(entry);
    } else if (xy[0] === 'C') {
      stagedAddedToDrop.push(entry.relPath);
    } else {
      if (xy[0] !== ' ') stagedToReset.push(entry.relPath);
      trackedToCheckout.push(entry.relPath);
    }
  }

  if (stagedAddedToDrop.length) {
    runGitChunked(root, ['rm', '-q', '-f', '--cached'], stagedAddedToDrop);
    for (const rel of stagedAddedToDrop) untrackedToUnlink.push(rel);
  }

  if (renamesToRestore.length) {
    const renamePaths = [];
    for (const r of renamesToRestore) {
      if (r.origPath) renamePaths.push(r.origPath);
      renamePaths.push(r.relPath);
    }
    if (hasHead) runGitChunked(root, ['reset', '-q', 'HEAD'], renamePaths);
    for (const r of renamesToRestore) {
      if (r.origPath) trackedToCheckout.push(r.origPath);
      if (r.relPath !== r.origPath) untrackedToUnlink.push(r.relPath);
    }
  }

  if (stagedToReset.length && hasHead) {
    runGitChunked(root, ['reset', '-q', 'HEAD'], stagedToReset);
  }

  if (trackedToCheckout.length && hasHead) {
    runGitChunked(root, ['checkout', '-q', 'HEAD'], [...new Set(trackedToCheckout)]);
  }

  let unlinkedCount = 0;
  const prunedParents = [];
  for (const rel of untrackedToUnlink) {
    const abs = path.join(root, rel);
    if (safeLstat(abs)) {
      try {
        fs.unlinkSync(abs);
        unlinkedCount += 1;
        prunedParents.push(path.dirname(abs));
      } catch (err) {
        if (err && (err.code === 'EPERM' || err.code === 'EACCES')) {
          skippedPermissionLocked.push(rel);
          continue;
        }
        throw err;
      }
    }
  }
  pruneEmptyParentDirs(root, prunedParents);

  return {
    resetCount: stagedToReset.length + trackedToCheckout.length + stagedAddedToDrop.length + renamesToRestore.length,
    unlinkedCount,
    skippedConcurrentEdit,
    skippedPermissionLocked,
  };
}

function recoverInterruptedVault(cwd, options = {}) {
  const root = resolveExactGitRoot(cwd);
  if (!root) return { recovered: [] };
  const walDir = path.join(root, '.atris', 'vault');
  if (!fs.existsSync(walDir)) return { recovered: [] };

  const walFiles = fs.readdirSync(walDir)
    .filter((f) => /^wal-.*\.json$/.test(f))
    .sort();
  const recovered = [];

  for (const name of walFiles) {
    const walPath = path.join(walDir, name);
    let wal = null;
    try {
      wal = JSON.parse(fs.readFileSync(walPath, 'utf8'));
    } catch {
      fs.rmSync(walPath, { force: true });
      continue;
    }
    const vaultId = wal && wal.vaultId;
    if (!vaultId) {
      fs.rmSync(walPath, { force: true });
      continue;
    }

    const fullRef = `refs/atris/vault/${vaultId}/full`;
    const hasFullRef = runGit(['rev-parse', '--verify', `${fullRef}^{commit}`], { cwd: root, check: false }).status === 0;

    if (wal.status === 'VAULTED' && hasFullRef) {
      const hasHead = runGit(['rev-parse', '--verify', 'HEAD'], { cwd: root, check: false }).status === 0;
      const entries = Array.isArray(wal.entries) ? wal.entries : [];
      if (wal.digest) {
        appendVaultDigest(root, {
          vaultId,
          now: new Date(wal.digest.at || wal.createdAt || Date.now()),
          headOid: wal.digest.headOid || null,
          refs: wal.refs || {},
          quarantineDir: wal.quarantineDir || null,
          scan: wal.digest.scan || { byClass: {}, topBundles: [] },
          vaultable: wal.digest.vaultable || [],
          codeItems: wal.digest.codeItems || [],
          exhaustItems: wal.digest.exhaustItems || [],
          quarantineItems: wal.digest.quarantineItems || [],
        });
      }
      const resetStats = executeCasWorkingTreeReset(root, entries, { hasHead });
      fs.rmSync(walPath, { force: true });
      recovered.push({ vaultId, action: 'replayed_vaulted', resetStats });
    } else {
      const qDir = wal.quarantineDir || path.join(defaultQuarantineBase(options.quarantineRoot), path.basename(root), vaultId);
      if (qDir && fs.existsSync(qDir)) {
        fs.rmSync(qDir, { recursive: true, force: true });
      }
      fs.rmSync(walPath, { force: true });
      recovered.push({ vaultId, action: 'aborted_preparing' });
    }
  }

  return { recovered };
}

function vaultAndCleanCheckout(cwd, options = {}) {
  const {
    graceMs = DEFAULT_GRACE_MS,
    now = new Date(),
    listActivePaths = listActiveProcessPaths,
    quarantineRoot,
    beforeMerkleVerify,
    beforeReset,
  } = options;

  const root = resolveExactGitRoot(cwd);
  if (!root) return { applied: false, reason: 'not_git_repo' };
  const nowDate = now instanceof Date ? now : new Date(now);
  const gitCommon = path.resolve(root, runGit(['rev-parse', '--git-common-dir'], { cwd: root }).stdout.trim());
  const lock = acquireFileLock(path.join(gitCommon, 'atris-clean.lock'), { staleAfterMs: 15 * 60 * 1000 });
  if (!lock.ok) throw new Error(`Another clean is running (pid ${lock.holder?.pid || '?'})`);

  try {
    recoverInterruptedVault(root, { quarantineRoot });
    const scan = scanGitHygiene(root, {
      graceMs,
      nowMs: nowDate.getTime(),
      requireProcessScan: true,
      listActivePaths,
    });
    if (scan.actionableCount === 0) return { applied: true, vaultId: null, scan };

    const vaultId = `${compactStamp(nowDate)}-${crypto.randomBytes(3).toString('hex')}`;
    const walPath = path.join(root, '.atris', 'vault', `wal-${vaultId}.json`);
    const qDirCandidate = path.join(defaultQuarantineBase(quarantineRoot), path.basename(root), vaultId);
    writeJsonAtomic(walPath, {
      vaultId,
      status: 'PREPARING',
      createdAt: nowDate.toISOString(),
      quarantineDir: qDirCandidate,
    });

    const quarantineItems = scan.entries.filter((e) => e.cls === 'SECRET_OR_FAT_QUARANTINE');
    let quarantineDir = null;
    const vaultable = scan.entries.filter((e) =>
      ['REGEN_CHURN', 'LOOSE_SCRATCH', 'AGENT_EXHAUST', 'UNFINISHED_CODE'].includes(e.cls)
    );
    const codeItems = vaultable.filter((e) => e.cls === 'UNFINISHED_CODE');
    const exhaustItems = vaultable.filter((e) => e.cls === 'AGENT_EXHAUST');

    const headRes = runGit(['rev-parse', '--verify', 'HEAD'], { cwd: root, check: false });
    const headOid = headRes.status === 0 ? headRes.stdout.trim() : null;
    let refs;
    try {
      quarantineDir = quarantineItems.length
        ? stageQuarantineFiles(root, vaultId, quarantineItems, quarantineRoot)
        : null;
      refs = buildAndVerifyVaultRefs(root, {
        vaultId,
        headOid,
        vaultable,
        codeItems,
        exhaustItems,
        quarantineItems,
        beforeMerkleVerify,
      });
    } catch (err) {
      if (quarantineDir && fs.existsSync(quarantineDir)) {
        try { fs.rmSync(quarantineDir, { recursive: true, force: true }); } catch {}
      }
      try { fs.rmSync(walPath, { force: true }); } catch {}
      throw err;
    }

    const actionable = scan.entries.filter((e) => !['UNPROVABLE_KEEP', 'ACTIVE_IN_FLIGHT'].includes(e.cls));
    writeJsonAtomic(walPath, {
      vaultId,
      status: 'VAULTED',
      refs,
      quarantineDir,
      entries: actionable,
      digest: {
        at: nowDate.toISOString(),
        headOid,
        scan: { byClass: scan.byClass, topBundles: scan.topBundles },
        vaultable: vaultable.map((e) => ({ relPath: e.relPath })),
        codeItems: codeItems.map((e) => ({ relPath: e.relPath })),
        exhaustItems: exhaustItems.map((e) => ({ relPath: e.relPath })),
        quarantineItems: quarantineItems.map((e) => ({ relPath: e.relPath })),
      },
    });

    const receipt = appendVaultDigest(root, {
      vaultId,
      now: nowDate,
      headOid,
      refs,
      quarantineDir,
      scan,
      vaultable,
      codeItems,
      exhaustItems,
      quarantineItems,
    });

    if (typeof beforeReset === 'function') beforeReset({ root, vaultId, refs });
    const resetStats = executeCasWorkingTreeReset(root, actionable, { hasHead: Boolean(headOid) });
    fs.rmSync(walPath, { force: true });

    const postScan = scanGitHygiene(root, {
      graceMs,
      nowMs: nowDate.getTime(),
      requireProcessScan: false,
      probeProcesses: false,
    });
    return {
      applied: true,
      vaultId,
      refs,
      quarantineDir,
      receipt,
      resetStats,
      scan: { ...scan, remainingDirty: postScan.dirtyCount },
    };
  } finally {
    lock.release();
  }
}

function readCommitVaultMeta(root, commitRef) {
  const res = runGit(['show', '-s', '--format=%B', commitRef], { cwd: root, check: false });
  if (res.status !== 0) return null;
  const match = String(res.stdout || '').match(/^atris\.vault\.v1:\s*(\{.*\})\s*$/m);
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

function listVaultSnapshots(cwd) {
  const root = resolveExactGitRoot(cwd);
  if (!root) return [];

  const indexMap = new Map();
  for (const rec of readIndexRecords(root)) {
    indexMap.set(rec.id, rec);
  }

  const refOut = runGit(
    ['for-each-ref', '--format=%(refname)\t%(objectname)\t%(creatordate:iso-strict)', 'refs/atris/vault'],
    { cwd: root, check: false }
  );
  const byId = new Map();
  if (refOut.status === 0) {
    for (const line of String(refOut.stdout || '').split(/\r?\n/)) {
      if (!line.trim()) continue;
      const [refName, oid, creatorDate] = line.split('\t');
      const m = refName.match(/^refs\/atris\/vault\/([^/]+)\/([^/]+)$/);
      if (!m) continue;
      const [, vaultId, slice] = m;
      if (!byId.has(vaultId)) {
        byId.set(vaultId, { id: vaultId, vaultId, at: creatorDate || null, refs: {}, commits: {} });
      }
      const item = byId.get(vaultId);
      item.refs[slice] = refName;
      item.commits[slice] = oid;
    }
  }

  const snapshots = [];
  for (const [vaultId, refInfo] of byId) {
    const rec = indexMap.get(vaultId) || null;
    const meta = !rec && refInfo.refs.full ? readCommitVaultMeta(root, refInfo.refs.full) : null;
    const codeFiles = rec ? (rec.code_files || []) : (refInfo.refs.code ? (readCommitVaultMeta(root, refInfo.refs.code)?.paths || []) : []);
    const exhaustFiles = rec ? (rec.exhaust_files || []) : (refInfo.refs.exhaust ? (readCommitVaultMeta(root, refInfo.refs.exhaust)?.paths || []) : []);
    const vaultedFiles = rec ? (rec.vaulted_files || []) : (meta?.paths || []);
    const quarantineFiles = rec ? (rec.quarantine_files || []) : (meta?.quarantine || []);
    snapshots.push({
      id: vaultId,
      vaultId,
      at: rec?.at || refInfo.at,
      headOid: rec?.head_oid || null,
      refs: refInfo.refs,
      slices: Object.keys(refInfo.refs),
      countsByClass: rec?.counts_by_class || {},
      codeCount: codeFiles.length,
      exhaustCount: exhaustFiles.length,
      vaultedCount: vaultedFiles.length,
      quarantineCount: quarantineFiles.length,
      quarantinePath: rec?.quarantine_path || null,
      topBundles: rec?.top_bundles || [],
      codeFiles,
      exhaustFiles,
      vaultedFiles,
      quarantineFiles,
    });
  }

  return snapshots.sort((a, b) => String(b.id).localeCompare(String(a.id)));
}

function matchesPrefixFilter(relPath, prefixes) {
  if (!prefixes || prefixes.length === 0) return true;
  return prefixes.some((raw) => {
    const clean = toPosixPath(raw).replace(/\/+$/, '');
    if (!clean) return true;
    return relPath === clean || relPath.startsWith(`${clean}/`);
  });
}

function materializeTreeEntries(root, targetDir, commitRef, entriesToRestore) {
  const restored = [];
  for (const entry of entriesToRestore) {
    const dest = path.resolve(targetDir, entry.relPath);
    if (dest !== targetDir && !dest.startsWith(targetDir + path.sep)) {
      throw new Error(`Unsafe restore path: ${entry.relPath}`);
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const existing = safeLstat(dest);
    if (existing) {
      if (existing.isDirectory()) fs.rmSync(dest, { recursive: true, force: true });
      else fs.unlinkSync(dest);
    }
    if (entry.mode === '120000') {
      const linkTarget = spawnSync('git', ['cat-file', 'blob', `${commitRef}:${entry.relPath}`], {
        cwd: root,
        encoding: 'utf8',
        maxBuffer: COMMAND_MAX_BUFFER_BYTES,
      });
      if (linkTarget.status !== 0) throw new Error(`Failed reading symlink blob ${entry.relPath}`);
      fs.symlinkSync(linkTarget.stdout, dest);
    } else {
      const blob = spawnSync('git', ['cat-file', 'blob', entry.oid], {
        cwd: root,
        encoding: null,
        maxBuffer: COMMAND_MAX_BUFFER_BYTES,
      });
      if (blob.status !== 0) throw new Error(`Failed reading blob ${entry.relPath}`);
      fs.writeFileSync(dest, blob.stdout);
      if (entry.mode === '100755') fs.chmodSync(dest, 0o755);
    }
    restored.push(entry.relPath);
  }
  return restored;
}

function restoreQuarantineEntries(quarantineDir, targetDir, quarantineFiles, prefixes) {
  if (!quarantineDir || !fs.existsSync(quarantineDir)) return [];
  const restored = [];
  for (const relPath of quarantineFiles) {
    if (!matchesPrefixFilter(relPath, prefixes)) continue;
    const src = path.join(quarantineDir, relPath);
    const st = safeLstat(src);
    if (!st) continue;
    const dest = path.resolve(targetDir, relPath);
    if (dest !== targetDir && !dest.startsWith(targetDir + path.sep)) continue;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const existing = safeLstat(dest);
    if (existing) {
      if (existing.isDirectory()) fs.rmSync(dest, { recursive: true, force: true });
      else fs.unlinkSync(dest);
    }
    if (st.isSymbolicLink()) {
      fs.symlinkSync(fs.readlinkSync(src), dest);
    } else {
      fs.copyFileSync(src, dest);
      fs.chmodSync(dest, 0o600);
    }
    restored.push(relPath);
  }
  return restored;
}

function restoreFromVault(cwd, options = {}) {
  const {
    vaultId,
    paths = [],
    slice = 'full',
    worktree = false,
    agent = '',
    dryRun = false,
    force = false,
    createWorktree = createAgentWorktree,
    quarantineRoot,
  } = options;

  const root = resolveExactGitRoot(cwd);
  if (!root) throw new Error('Not a git repository root');

  const validSlices = new Set(['full', 'code', 'exhaust', 'staged']);
  if (!validSlices.has(slice)) {
    throw new Error(`Invalid vault slice "${slice}". Expected one of: full, code, exhaust, staged`);
  }

  const snapshots = listVaultSnapshots(root);
  const resolvedId = vaultId === 'latest' && snapshots.length ? snapshots[0].id : vaultId;
  const snapshot = snapshots.find((s) => s.id === resolvedId);
  if (!snapshot) {
    throw new Error(`Vault snapshot not found: ${vaultId}`);
  }

  const targetRef = snapshot.refs[slice];
  if (!targetRef) {
    throw new Error(`Slice "${slice}" not present in vault ${resolvedId}`);
  }

  const meta = readCommitVaultMeta(root, targetRef);
  let slicePaths = meta && Array.isArray(meta.paths) ? meta.paths : null;
  if (!slicePaths) {
    if (slice === 'code') slicePaths = snapshot.codeFiles;
    else if (slice === 'exhaust') slicePaths = snapshot.exhaustFiles;
    else if (slice === 'full') slicePaths = snapshot.vaultedFiles;
    else {
      const parentCheck = runGit(['rev-parse', '--verify', `${targetRef}^1`], { cwd: root, check: false });
      slicePaths = parentCheck.status === 0 ? parseDiffPaths(root, `${targetRef}^1`, targetRef) : [];
    }
  }

  const prefixes = Array.isArray(paths) ? paths.filter(Boolean) : [paths].filter(Boolean);
  const treeMap = parseLsTreeZ(root, targetRef);
  const wantedPaths = slicePaths.filter((p) => matchesPrefixFilter(p, prefixes));
  const entriesToRestore = [];
  for (const relPath of wantedPaths) {
    const entry = treeMap.get(relPath);
    if (entry) entriesToRestore.push(entry);
  }

  const qDir = snapshot.quarantinePath
    || path.join(defaultQuarantineBase(quarantineRoot), path.basename(root), resolvedId);
  const wantQuarantine = slice === 'full'
    ? (snapshot.quarantineFiles || []).filter((p) => matchesPrefixFilter(p, prefixes) && safeLstat(path.join(qDir, p)))
    : [];

  const allTargetPaths = [...entriesToRestore.map((e) => e.relPath), ...wantQuarantine];

  if (worktree) {
    if (dryRun) {
      return {
        ok: true,
        dryRun: true,
        vaultId: resolvedId,
        slice,
        worktree: true,
        paths: allTargetPaths,
        restored: [],
        quarantinedRestored: [],
        conflicts: [],
      };
    }
    const wt = createWorktree({
      root,
      agent: agent || 'restore',
      task: `restore-${resolvedId}`,
      base: snapshot.headOid || 'HEAD',
    });
    const restored = materializeTreeEntries(root, wt.path, targetRef, entriesToRestore);
    const quarantinedRestored = restoreQuarantineEntries(qDir, wt.path, wantQuarantine, prefixes);
    return {
      ok: true,
      dryRun: false,
      vaultId: resolvedId,
      slice,
      worktree: true,
      worktreePath: wt.path,
      branch: wt.branch,
      restored,
      quarantinedRestored,
      conflicts: [],
    };
  }

  const dirtyEntries = parsePorcelainZ(
    runGit(['status', '--porcelain=v1', '-z', '-uall'], { cwd: root }).stdout
  );
  const dirtySet = new Set(dirtyEntries.map((e) => e.relPath));
  const conflicts = allTargetPaths.filter((p) => dirtySet.has(p));

  if (dryRun) {
    return {
      ok: conflicts.length === 0 || force,
      dryRun: true,
      vaultId: resolvedId,
      slice,
      worktree: false,
      paths: allTargetPaths,
      restored: [],
      quarantinedRestored: [],
      conflicts,
    };
  }

  if (conflicts.length > 0 && !force) {
    const err = new Error(
      `Refusing to overwrite ${conflicts.length} dirty local file(s): ${conflicts.slice(0, 5).join(', ')}. Pass --force to overwrite.`
    );
    err.code = 'RESTORE_CONFLICT';
    err.conflicts = conflicts;
    throw err;
  }

  const restored = materializeTreeEntries(root, root, targetRef, entriesToRestore);
  const quarantinedRestored = restoreQuarantineEntries(qDir, root, wantQuarantine, prefixes);
  return {
    ok: true,
    dryRun: false,
    vaultId: resolvedId,
    slice,
    worktree: false,
    restored,
    quarantinedRestored,
    conflicts: [],
  };
}

module.exports = {
  DEFAULT_GRACE_MS,
  classifyEntry,
  scanGitHygiene,
  vaultAndCleanCheckout,
  recoverInterruptedVault,
  listVaultSnapshots,
  restoreFromVault,
};
