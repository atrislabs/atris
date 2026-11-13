'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  DEFAULT_GRACE_MS,
  classifyEntry,
  scanGitHygiene,
  vaultAndCleanCheckout,
  recoverInterruptedVault,
  listVaultSnapshots,
  restoreFromVault,
} = require('../lib/hygiene-vault');
const { acquireFileLock } = require('../lib/file-lock');
const { localDay } = require('../lib/local-day');

function run(cmd, args, cwd) {
  const res = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
  if (res.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} failed: ${res.stderr || res.stdout}`);
  }
  return res.stdout.trim();
}

function makeTempDir(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function makeGitRepo(files = { 'README.md': '# repo\n', 'src/app.py': 'print("ok")\n' }) {
  const dir = makeTempDir('atris-hv-repo-');
  run('git', ['init', '-b', 'main'], dir);
  run('git', ['config', 'user.email', 'test@example.com'], dir);
  run('git', ['config', 'user.name', 'Test User'], dir);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  }
  run('git', ['add', '-A'], dir);
  run('git', ['commit', '-m', 'init'], dir);
  return dir;
}

function writeRel(root, relPath, content, { ageMs = 2 * 60 * 60 * 1000, nowMs = Date.now(), mode } = {}) {
  const abs = path.join(root, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
  if (mode !== undefined) fs.chmodSync(abs, mode);
  const t = new Date(nowMs - ageMs);
  fs.utimesSync(abs, t, t);
  return abs;
}

function ageAllDirty(root, ageMs, nowMs) {
  const t = new Date(nowMs - ageMs);
  const out = run('git', ['status', '--porcelain=v1', '-uall'], root);
  for (const line of out.split('\n').filter(Boolean)) {
    const rel = line.slice(3).replace(/\/+$/, '');
    const abs = path.join(root, rel);
    try { fs.lutimesSync(abs, t, t); } catch {}
  }
}

test('non-git directory and clean git repo return clean empty scans', () => {
  const plainDir = makeTempDir('atris-hv-plain-');
  const gitDir = makeGitRepo();
  try {
    const plainScan = scanGitHygiene(plainDir, { listActivePaths: () => [] });
    assert.equal(plainScan.isGitRepo, false);
    assert.equal(plainScan.dirtyCount, 0);
    assert.equal(plainScan.actionableCount, 0);
    assert.equal(plainScan.remainingDirty, 0);

    const plainVault = vaultAndCleanCheckout(plainDir, { listActivePaths: () => [] });
    assert.equal(plainVault.applied, false);
    assert.equal(plainVault.reason, 'not_git_repo');

    const cleanScan = scanGitHygiene(gitDir, { listActivePaths: () => [] });
    assert.equal(cleanScan.isGitRepo, true);
    assert.equal(cleanScan.dirtyCount, 0);
    assert.equal(cleanScan.actionableCount, 0);

    const cleanVault = vaultAndCleanCheckout(gitDir, { listActivePaths: () => [] });
    assert.equal(cleanVault.applied, true);
    assert.equal(cleanVault.vaultId, null);
    assert.equal(DEFAULT_GRACE_MS, 30 * 60 * 1000);
  } finally {
    fs.rmSync(plainDir, { recursive: true, force: true });
    fs.rmSync(gitDir, { recursive: true, force: true });
  }
});

test('classifyEntry and scanGitHygiene cover all classification buckets and fences', () => {
  const nowMs = Date.now();
  const root = makeGitRepo({
    'AGENTS.md': '# agents\n',
    'atris/TODO.md': '# todo\n',
    'atris/team/executor/now.md': '# now\n',
    'src/app.py': 'print(1)\n',
    'src/assumed.py': 'print(2)\n',
    'src/filtered.bin': 'abc\n',
    '.gitattributes': 'src/filtered.bin filter=custom\n',
  });
  try {
    // 1. CONDUCTOR_PLUMBING (excluded from entries)
    writeRel(root, '.atris/fleet-prompt-1.md', 'prompt', { nowMs });
    writeRel(root, '.atris/tasks.db-wal', 'wal', { nowMs });
    writeRel(root, '.atris/state/engines.json', '{}', { nowMs });

    // 2. UNPROVABLE_KEEP: assume-unchanged, gitattributes filter, nested .git
    writeRel(root, 'src/assumed.py', 'print(999)\n', { nowMs });
    run('git', ['update-index', '--assume-unchanged', 'src/assumed.py'], root);
    writeRel(root, 'src/filtered.bin', 'xyz\n', { nowMs });
    const nestedDir = path.join(root, 'nested_subrepo');
    fs.mkdirSync(nestedDir);
    run('git', ['init'], nestedDir);
    fs.writeFileSync(path.join(nestedDir, 'file.txt'), 'nested');

    // 3. ACTIVE_IN_FLIGHT: open FD, active lock dir, 30-min bundle grace, today's journal
    const openAbs = writeRel(root, 'src/open_by_agent.py', 'running()', { nowMs });
    writeRel(root, 'backend/robinhood/data/stock_ideas.lock', String(process.pid), { ageMs: 5 * 60 * 1000, nowMs });
    writeRel(root, 'backend/robinhood/data/ideas.json', '{"a":1}', { nowMs });
    // Bundle-coherent grace: old file + fresh file share atris/features/fresh-bundle
    writeRel(root, 'atris/features/fresh-bundle/old.md', 'old', { ageMs: 3 * 60 * 60 * 1000, nowMs });
    writeRel(root, 'atris/features/fresh-bundle/new.md', 'new', { ageMs: 5 * 60 * 1000, nowMs });
    // Today's journal even if mtime > 30m
    const day = localDay(new Date(nowMs));
    const todayJournal = `atris/logs/${day.slice(0, 4)}/${day}.md`;
    writeRel(root, todayJournal, '# today', { ageMs: 2 * 60 * 60 * 1000, nowMs });

    // 4. SECRET_OR_FAT_QUARANTINE
    writeRel(root, '.env', 'API_KEY=secret\n', { nowMs });
    writeRel(root, 'config/owner_wallets.json', '{"k":"v"}', { nowMs });
    writeRel(root, 'data/local.sqlite', 'sqlitebytes', { nowMs });
    const fatPath = writeRel(root, 'models/weights.dat', 'x', { nowMs });
    fs.truncateSync(fatPath, 51 * 1024 * 1024);
    const oldTime = new Date(nowMs - 2 * 60 * 60 * 1000);
    fs.utimesSync(fatPath, oldTime, oldTime);

    // 5a. OS_BYTECODE_JUNK
    writeRel(root, '.DS_Store', 'ds', { nowMs });
    writeRel(root, 'src/__pycache__/app.cpython-312.pyc', 'pyc', { nowMs });
    writeRel(root, 'temp.tmp', '', { nowMs });

    // 5b. REGEN_CHURN
    writeRel(root, 'AGENTS.md', '# regenerated\n', { nowMs });
    writeRel(root, 'atris/TODO.md', '# regenerated\n', { nowMs });
    writeRel(root, 'atris/team/executor/now.md', '# regenerated\n', { nowMs });

    // 5c. LOOSE_SCRATCH
    writeRel(root, 'synth.html', '<html></html>', { nowMs });
    writeRel(root, 'round1-claude.md', '# notes', { nowMs });

    // 6. AGENT_EXHAUST
    writeRel(root, 'atris/features/old-feat/spec.md', 'spec', { nowMs });
    writeRel(root, 'atris/campaigns/camp1/plan.md', 'camp', { nowMs });
    writeRel(root, 'output/pdf/deliverable.pdf', '%PDF', { nowMs });

    // 7. UNFINISHED_CODE
    writeRel(root, 'backend/services/trace_capture.py', 'def trace(): pass\n', { nowMs });
    writeRel(root, 'backend/tests/test_trace.py', 'def test_t(): pass\n', { nowMs });
    writeRel(root, 'src/app.py', 'print("edited")\n', { nowMs });

    // Direct classifyEntry check
    assert.equal(
      classifyEntry({ relPath: '.atris/foo.json', xy: '??' }, { root, nowMs, graceMs: DEFAULT_GRACE_MS }),
      'CONDUCTOR_PLUMBING'
    );

    const scan = scanGitHygiene(root, {
      nowMs,
      graceMs: DEFAULT_GRACE_MS,
      listActivePaths: () => [openAbs],
    });

    const classOf = new Map(scan.entries.map((e) => [e.relPath, e.cls]));

    // Conductor plumbing excluded
    assert.equal(classOf.has('.atris/fleet-prompt-1.md'), false);
    assert.equal(classOf.has('.atris/tasks.db-wal'), false);
    assert.equal(classOf.has('.atris/state/engines.json'), false);

    // Unprovable
    assert.equal(classOf.get('src/filtered.bin'), 'UNPROVABLE_KEEP');
    assert.equal(classOf.get('nested_subrepo'), 'UNPROVABLE_KEEP');
    // assume-unchanged hides from `git status`, so not in rawEntries unless also modified elsewhere;
    // unmerge/filter/nested cover UNPROVABLE_KEEP in status.

    // Active in flight
    assert.equal(classOf.get('src/open_by_agent.py'), 'ACTIVE_IN_FLIGHT');
    assert.equal(classOf.get('backend/robinhood/data/ideas.json'), 'ACTIVE_IN_FLIGHT');
    assert.equal(classOf.get('atris/features/fresh-bundle/old.md'), 'ACTIVE_IN_FLIGHT');
    assert.equal(classOf.get('atris/features/fresh-bundle/new.md'), 'ACTIVE_IN_FLIGHT');
    assert.equal(classOf.get(todayJournal), 'ACTIVE_IN_FLIGHT');

    // Secret / Fat
    assert.equal(classOf.get('.env'), 'SECRET_OR_FAT_QUARANTINE');
    assert.equal(classOf.get('config/owner_wallets.json'), 'SECRET_OR_FAT_QUARANTINE');
    assert.equal(classOf.get('data/local.sqlite'), 'SECRET_OR_FAT_QUARANTINE');
    assert.equal(classOf.get('models/weights.dat'), 'SECRET_OR_FAT_QUARANTINE');

    // OS Junk
    assert.equal(classOf.get('.DS_Store'), 'OS_BYTECODE_JUNK');
    assert.equal(classOf.get('src/__pycache__/app.cpython-312.pyc'), 'OS_BYTECODE_JUNK');
    assert.equal(classOf.get('temp.tmp'), 'OS_BYTECODE_JUNK');

    // Regen churn
    assert.equal(classOf.get('AGENTS.md'), 'REGEN_CHURN');
    assert.equal(classOf.get('atris/TODO.md'), 'REGEN_CHURN');
    assert.equal(classOf.get('atris/team/executor/now.md'), 'REGEN_CHURN');

    // Loose scratch
    assert.equal(classOf.get('synth.html'), 'LOOSE_SCRATCH');
    assert.equal(classOf.get('round1-claude.md'), 'LOOSE_SCRATCH');

    // Agent exhaust
    assert.equal(classOf.get('atris/features/old-feat/spec.md'), 'AGENT_EXHAUST');
    assert.equal(classOf.get('atris/campaigns/camp1/plan.md'), 'AGENT_EXHAUST');
    assert.equal(classOf.get('output/pdf/deliverable.pdf'), 'AGENT_EXHAUST');

    // Unfinished code
    assert.equal(classOf.get('backend/services/trace_capture.py'), 'UNFINISHED_CODE');
    assert.equal(classOf.get('backend/tests/test_trace.py'), 'UNFINISHED_CODE');
    assert.equal(classOf.get('src/app.py'), 'UNFINISHED_CODE');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('fail-closed process scan refuses destructive clean when lsof returns null', () => {
  const root = makeGitRepo();
  try {
    writeRel(root, 'synth.html', '<p>hi</p>');
    assert.throws(
      () => scanGitHygiene(root, { requireProcessScan: true, listActivePaths: () => null }),
      /Active process scan/
    );
    assert.throws(
      () => vaultAndCleanCheckout(root, { graceMs: 0, listActivePaths: () => null }),
      /Active process scan/
    );
    assert.equal(fs.existsSync(path.join(root, 'synth.html')), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('vaultAndCleanCheckout creates sliced refs, quarantines secrets/fat, resets tree, and restores slices', () => {
  const now = new Date('2026-11-12T20:00:00.000Z');
  const nowMs = now.getTime();
  const root = makeGitRepo({
    'AGENTS.md': '# canonical\n',
    'src/app.py': 'print("v1")\n',
    'src/to_delete.py': 'delete me\n',
  });
  const quarantineRoot = makeTempDir('atris-hv-quarantine-');
  const worktreeBase = makeTempDir('atris-hv-wt-');
  try {
    writeRel(root, 'AGENTS.md', '# dirty adapter\n', { ageMs: 60 * 60 * 1000, nowMs });
    writeRel(root, 'synth.html', '<h1>scratch</h1>', { ageMs: 60 * 60 * 1000, nowMs });
    writeRel(root, 'atris/features/f1/note.md', '# feature note', { ageMs: 60 * 60 * 1000, nowMs });
    writeRel(root, 'backend/services/trace.py', 'def run():\n    return 42\n', { ageMs: 60 * 60 * 1000, nowMs });
    writeRel(root, 'backend/run.sh', '#!/bin/sh\necho ok\n', { ageMs: 60 * 60 * 1000, nowMs, mode: 0o755 });
    fs.symlinkSync('trace.py', path.join(root, 'backend/services/trace_link.py'));
    writeRel(root, 'src/app.py', 'print("v2")\n', { ageMs: 60 * 60 * 1000, nowMs });
    writeRel(root, 'src/staged_only.py', 'staged = True\n', { ageMs: 60 * 60 * 1000, nowMs });
    run('git', ['add', 'src/staged_only.py'], root);
    fs.unlinkSync(path.join(root, 'src/to_delete.py'));
    writeRel(root, '.DS_Store', 'junk', { ageMs: 60 * 60 * 1000, nowMs });
    writeRel(root, '.env', 'SECRET=12345\n', { ageMs: 60 * 60 * 1000, nowMs });
    const fat = writeRel(root, 'big.bin', 'bin', { ageMs: 60 * 60 * 1000, nowMs });
    fs.truncateSync(fat, 51 * 1024 * 1024);

    // Keep one active file so we prove partial clean leaves active untouched
    writeRel(root, 'backend/active.py', 'in_flight = True\n', { ageMs: 60 * 1000, nowMs });
    ageAllDirty(root, 60 * 60 * 1000, nowMs);
    // Re-touch active.py so it stays inside grace window
    const freshTime = new Date(nowMs - 60 * 1000);
    fs.utimesSync(path.join(root, 'backend/active.py'), freshTime, freshTime);

    const out = vaultAndCleanCheckout(root, {
      graceMs: DEFAULT_GRACE_MS,
      now,
      listActivePaths: () => [],
      quarantineRoot,
    });

    assert.equal(out.applied, true);
    assert.ok(out.vaultId);
    assert.ok(out.refs.full);
    assert.ok(out.refs.staged);
    assert.ok(out.refs.code);
    assert.ok(out.refs.exhaust);

    // Working tree reset assertions
    assert.equal(fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8'), '# canonical\n');
    assert.equal(fs.readFileSync(path.join(root, 'src/app.py'), 'utf8'), 'print("v1")\n');
    assert.equal(fs.readFileSync(path.join(root, 'src/to_delete.py'), 'utf8'), 'delete me\n');
    assert.equal(fs.existsSync(path.join(root, 'synth.html')), false);
    assert.equal(fs.existsSync(path.join(root, 'atris/features/f1/note.md')), false);
    assert.equal(fs.existsSync(path.join(root, 'backend/services/trace.py')), false);
    assert.equal(fs.existsSync(path.join(root, 'src/staged_only.py')), false);
    assert.equal(fs.existsSync(path.join(root, '.DS_Store')), false);
    assert.equal(fs.existsSync(path.join(root, '.env')), false);
    assert.equal(fs.existsSync(path.join(root, 'big.bin')), false);
    // Active file stayed on disk
    assert.equal(fs.existsSync(path.join(root, 'backend/active.py')), true);
    assert.equal(out.scan.remainingDirty, 1);

    // Quarantine assertions: 0700 dir, 0600 file, NOT in full git tree
    const qEnv = path.join(out.quarantineDir, '.env');
    assert.equal(fs.readFileSync(qEnv, 'utf8'), 'SECRET=12345\n');
    assert.equal(fs.statSync(out.quarantineDir).mode & 0o777, 0o700);
    assert.equal(fs.statSync(qEnv).mode & 0o777, 0o600);
    const fullTreeFiles = run('git', ['ls-tree', '-r', '--name-only', out.refs.full], root).split('\n');
    assert.equal(fullTreeFiles.includes('.env'), false);
    assert.equal(fullTreeFiles.includes('big.bin'), false);
    assert.equal(fullTreeFiles.includes('synth.html'), true);
    assert.equal(fullTreeFiles.includes('backend/services/trace.py'), true);

    // Code slice has ONLY UNFINISHED_CODE overlaid on HEAD
    const codeTreeFiles = run('git', ['ls-tree', '-r', '--name-only', out.refs.code], root).split('\n');
    assert.equal(codeTreeFiles.includes('backend/services/trace.py'), true);
    assert.equal(codeTreeFiles.includes('atris/features/f1/note.md'), false);
    assert.equal(codeTreeFiles.includes('synth.html'), false);

    // Exhaust slice has ONLY AGENT_EXHAUST overlaid on HEAD
    const exhaustTreeFiles = run('git', ['ls-tree', '-r', '--name-only', out.refs.exhaust], root).split('\n');
    assert.equal(exhaustTreeFiles.includes('atris/features/f1/note.md'), true);
    assert.equal(exhaustTreeFiles.includes('backend/services/trace.py'), false);

    // Catalog & index assertions
    const indexLines = fs.readFileSync(path.join(root, '.atris/state/vault-index.jsonl'), 'utf8').trim().split('\n');
    assert.equal(indexLines.length, 1);
    const catalog = fs.readFileSync(path.join(root, '.atris/state/vault-catalog.md'), 'utf8');
    assert.match(catalog, new RegExp(out.vaultId));

    // listVaultSnapshots
    const snaps = listVaultSnapshots(root);
    assert.equal(snaps.length, 1);
    assert.equal(snaps[0].id, out.vaultId);
    assert.deepEqual(new Set(snaps[0].slices), new Set(['full', 'staged', 'code', 'exhaust']));

    // Restore code slice into main root
    const codeRestored = restoreFromVault(root, { vaultId: out.vaultId, slice: 'code', quarantineRoot });
    assert.equal(codeRestored.ok, true);
    assert.equal(fs.readFileSync(path.join(root, 'backend/services/trace.py'), 'utf8'), 'def run():\n    return 42\n');
    assert.equal(fs.statSync(path.join(root, 'backend/run.sh')).mode & 0o111, 0o111);
    assert.equal(fs.lstatSync(path.join(root, 'backend/services/trace_link.py')).isSymbolicLink(), true);
    assert.equal(fs.existsSync(path.join(root, 'atris/features/f1/note.md')), false);

    // Non-clobbering conflict check + --dry-run + --force
    fs.writeFileSync(path.join(root, 'backend/services/trace.py'), 'local edit\n');
    const dryConflict = restoreFromVault(root, { vaultId: out.vaultId, slice: 'code', dryRun: true, quarantineRoot });
    assert.equal(dryConflict.ok, false);
    assert.ok(dryConflict.conflicts.includes('backend/services/trace.py'));

    assert.throws(
      () => restoreFromVault(root, { vaultId: out.vaultId, slice: 'code', quarantineRoot }),
      (err) => err.code === 'RESTORE_CONFLICT' && err.conflicts.includes('backend/services/trace.py')
    );

    const forced = restoreFromVault(root, { vaultId: out.vaultId, slice: 'code', force: true, quarantineRoot });
    assert.equal(forced.ok, true);
    assert.equal(fs.readFileSync(path.join(root, 'backend/services/trace.py'), 'utf8'), 'def run():\n    return 42\n');

    // Restore quarantined .env by path
    const envRestored = restoreFromVault(root, { vaultId: out.vaultId, paths: ['.env'], quarantineRoot });
    assert.deepEqual(envRestored.quarantinedRestored, ['.env']);
    assert.equal(fs.readFileSync(path.join(root, '.env'), 'utf8'), 'SECRET=12345\n');

    // Restore into isolated worktree (with injected createWorktree)
    const wtTarget = path.join(worktreeBase, 'wt-1');
    const wtRestore = restoreFromVault(root, {
      vaultId: out.vaultId,
      slice: 'code',
      worktree: true,
      agent: 'builder',
      createWorktree: ({ root: r, base }) => {
        run('git', ['worktree', 'add', '-b', 'restore-branch', wtTarget, base], r);
        return { path: wtTarget, branch: 'restore-branch' };
      },
    });
    assert.equal(wtRestore.worktree, true);
    assert.equal(wtRestore.worktreePath, wtTarget);
    assert.equal(fs.readFileSync(path.join(wtTarget, 'backend/services/trace.py'), 'utf8'), 'def run():\n    return 42\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(quarantineRoot, { recursive: true, force: true });
    fs.rmSync(worktreeBase, { recursive: true, force: true });
  }
});

test('Merkle verification aborts before update-ref and working tree mutation on OID mismatch', () => {
  const root = makeGitRepo();
  const quarantineRoot = makeTempDir('atris-hv-merkle-q-');
  try {
    writeRel(root, 'src/unfinished.py', 'v1\n', { ageMs: 60 * 60 * 1000 });
    assert.throws(
      () => vaultAndCleanCheckout(root, {
        graceMs: 0,
        listActivePaths: () => [],
        quarantineRoot,
        beforeMerkleVerify: () => {
          fs.writeFileSync(path.join(root, 'src/unfinished.py'), 'tampered mid-run!\n');
        },
      }),
      /Merkle proof failed/
    );
    // No vault refs created, tampered file remains on disk, no leftover WAL
    assert.deepEqual(listVaultSnapshots(root), []);
    assert.equal(fs.readFileSync(path.join(root, 'src/unfinished.py'), 'utf8'), 'tampered mid-run!\n');
    const walDir = path.join(root, '.atris/vault');
    assert.equal(fs.existsSync(walDir) ? fs.readdirSync(walDir).length : 0, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(quarantineRoot, { recursive: true, force: true });
  }
});

test('TOCTOU CAS skips file modified between snapshot and working tree reset', () => {
  const root = makeGitRepo();
  const quarantineRoot = makeTempDir('atris-hv-cas-q-');
  try {
    writeRel(root, 'src/a.py', 'a = 1\n', { ageMs: 60 * 60 * 1000 });
    writeRel(root, 'src/b.py', 'b = 1\n', { ageMs: 60 * 60 * 1000 });

    const out = vaultAndCleanCheckout(root, {
      graceMs: 0,
      listActivePaths: () => [],
      quarantineRoot,
      beforeReset: () => {
        fs.writeFileSync(path.join(root, 'src/b.py'), 'b = 2 # concurrent edit!\n');
      },
    });

    assert.equal(out.applied, true);
    assert.deepEqual(out.resetStats.skippedConcurrentEdit, ['src/b.py']);
    assert.equal(fs.existsSync(path.join(root, 'src/a.py')), false);
    assert.equal(fs.readFileSync(path.join(root, 'src/b.py'), 'utf8'), 'b = 2 # concurrent edit!\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(quarantineRoot, { recursive: true, force: true });
  }
});

test('recoverInterruptedVault cleans PREPARING WAL and replays VAULTED WAL with TOCTOU CAS', () => {
  const root = makeGitRepo();
  const quarantineRoot = makeTempDir('atris-hv-wal-q-');
  try {
    // 1. PREPARING WAL recovery
    const prepId = '20261112-010101-aaaaaa';
    const prepQ = path.join(quarantineRoot, path.basename(root), prepId);
    fs.mkdirSync(prepQ, { recursive: true });
    fs.writeFileSync(path.join(prepQ, '.env'), 'partial');
    const walDir = path.join(root, '.atris', 'vault');
    fs.mkdirSync(walDir, { recursive: true });
    fs.writeFileSync(
      path.join(walDir, `wal-${prepId}.json`),
      JSON.stringify({ vaultId: prepId, status: 'PREPARING', quarantineDir: prepQ })
    );

    const r1 = recoverInterruptedVault(root, { quarantineRoot });
    assert.equal(r1.recovered.length, 1);
    assert.equal(r1.recovered[0].action, 'aborted_preparing');
    assert.equal(fs.existsSync(prepQ), false);
    assert.equal(fs.existsSync(path.join(walDir, `wal-${prepId}.json`)), false);

    // 2. VAULTED WAL recovery: simulate crash after ref commit & before unlink
    const fileA = writeRel(root, 'src/crash_a.py', 'a', { ageMs: 60 * 60 * 1000 });
    const fileB = writeRel(root, 'src/crash_b.py', 'b', { ageMs: 60 * 60 * 1000 });
    const stA = fs.lstatSync(fileA);
    const stB = fs.lstatSync(fileB);
    const vaultedId = '20261112-020202-bbbbbb';
    const headTree = run('git', ['rev-parse', 'HEAD^{tree}'], root);
    const commitOid = run('git', ['commit-tree', headTree, '-m', 'vault'], root);
    run('git', ['update-ref', `refs/atris/vault/${vaultedId}/full`, commitOid], root);

    // Modify crash_b after crash so TOCTOU CAS preserves it
    fs.writeFileSync(fileB, 'edited after crash!');

    fs.writeFileSync(
      path.join(walDir, `wal-${vaultedId}.json`),
      JSON.stringify({
        vaultId: vaultedId,
        status: 'VAULTED',
        entries: [
          { relPath: 'src/crash_a.py', xy: '??', stat0: { ino: stA.ino, size: stA.size, mtimeMs: stA.mtimeMs } },
          { relPath: 'src/crash_b.py', xy: '??', stat0: { ino: stB.ino, size: stB.size, mtimeMs: stB.mtimeMs } },
        ],
      })
    );

    const r2 = recoverInterruptedVault(root, { quarantineRoot });
    assert.equal(r2.recovered.length, 1);
    assert.equal(r2.recovered[0].action, 'replayed_vaulted');
    assert.equal(fs.existsSync(fileA), false);
    assert.equal(fs.readFileSync(fileB, 'utf8'), 'edited after crash!');
    assert.equal(fs.existsSync(path.join(walDir, `wal-${vaultedId}.json`)), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(quarantineRoot, { recursive: true, force: true });
  }
});

test('vault-catalog.md stays ring-capped at K=20 epochs and respects clean lock mutex', () => {
  const root = makeGitRepo();
  const quarantineRoot = makeTempDir('atris-hv-ring-q-');
  try {
    const baseTime = Date.parse('2026-11-12T00:00:00.000Z');
    const ids = [];
    for (let i = 0; i < 23; i += 1) {
      writeRel(root, `scratch_${i}.txt`, `epoch ${i}`, { ageMs: 60 * 60 * 1000 });
      const res = vaultAndCleanCheckout(root, {
        graceMs: 0,
        now: new Date(baseTime + i * 60 * 1000),
        listActivePaths: () => [],
        quarantineRoot,
      });
      ids.push(res.vaultId);
    }

    const indexLines = fs.readFileSync(path.join(root, '.atris/state/vault-index.jsonl'), 'utf8').trim().split('\n');
    assert.equal(indexLines.length, 23);

    const catalog = fs.readFileSync(path.join(root, '.atris/state/vault-catalog.md'), 'utf8');
    // Oldest 3 evicted from catalog, newest 20 present
    for (let i = 0; i < 3; i += 1) assert.equal(catalog.includes(ids[i]), false);
    for (let i = 3; i < 23; i += 1) assert.equal(catalog.includes(ids[i]), true);
    assert.ok(catalog.split('\n').length <= 60);

    // Concurrent lock contention test
    const gitCommon = path.resolve(root, run('git', ['rev-parse', '--git-common-dir'], root));
    const held = acquireFileLock(path.join(gitCommon, 'atris-clean.lock'));
    assert.equal(held.ok, true);
    try {
      assert.throws(
        () => vaultAndCleanCheckout(root, { graceMs: 0, listActivePaths: () => [] }),
        /Another clean is running/
      );
    } finally {
      held.release();
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(quarantineRoot, { recursive: true, force: true });
  }
});

test('staged secrets are stripped from refs/atris/vault/<id>/staged and quarantine symlinks are preserved on restore', () => {
  const root = makeGitRepo();
  const quarantineRoot = makeTempDir('atris-hv-staged-secret-q-');
  try {
    // 1. Staged .env alongside staged code file -> staged ref keeps code, excludes .env
    const envAbs = writeRel(root, '.env', 'API_SECRET=hunter2\n', { ageMs: 60 * 60 * 1000 });
    const codeAbs = writeRel(root, 'src/staged_code.py', 'x = 1\n', { ageMs: 60 * 60 * 1000 });
    // Also a symlinked secret in quarantine (pointing to a non-existent target to catch dereferencing)
    const linkAbs = path.join(root, '.env.symlink');
    fs.symlinkSync('/nonexistent/secret-target', linkAbs);
    const oldTime = new Date(Date.now() - 60 * 60 * 1000);
    fs.lutimesSync(linkAbs, oldTime, oldTime);

    run('git', ['add', '.env', 'src/staged_code.py'], root);
    fs.utimesSync(envAbs, oldTime, oldTime);
    fs.utimesSync(codeAbs, oldTime, oldTime);

    const out = vaultAndCleanCheckout(root, {
      graceMs: 0,
      listActivePaths: () => [],
      quarantineRoot,
    });

    assert.equal(out.applied, true);
    assert.ok(out.refs.staged);
    const stagedFiles = run('git', ['ls-tree', '-r', '--name-only', out.refs.staged], root).split('\n');
    assert.equal(stagedFiles.includes('.env'), false);
    assert.equal(stagedFiles.includes('src/staged_code.py'), true);
    assert.equal(fs.existsSync(envAbs), false);
    assert.equal(fs.existsSync(codeAbs), false);
    assert.equal(fs.existsSync(path.join(out.quarantineDir, '.env')), true);
    assert.equal(fs.lstatSync(path.join(out.quarantineDir, '.env.symlink')).isSymbolicLink(), true);

    // Restoring quarantined symlink preserves symlink rather than dereferencing
    const restored = restoreFromVault(root, {
      vaultId: out.vaultId,
      paths: ['.env', '.env.symlink'],
      quarantineRoot,
    });
    assert.deepEqual(new Set(restored.quarantinedRestored), new Set(['.env', '.env.symlink']));
    assert.equal(fs.readFileSync(envAbs, 'utf8'), 'API_SECRET=hunter2\n');
    assert.equal(fs.lstatSync(linkAbs).isSymbolicLink(), true);
    assert.equal(fs.readlinkSync(linkAbs), '/nonexistent/secret-target');

    // Force-overwriting existing symlink also succeeds cleanly
    const forced = restoreFromVault(root, {
      vaultId: out.vaultId,
      paths: ['.env.symlink'],
      force: true,
      quarantineRoot,
    });
    assert.deepEqual(forced.quarantinedRestored, ['.env.symlink']);
    assert.equal(fs.readlinkSync(linkAbs), '/nonexistent/secret-target');

    // 2. When ONLY a secret is staged, no staged ref is created
    fs.rmSync(linkAbs, { force: true });
    fs.rmSync(envAbs, { force: true });
    writeRel(root, '.env', 'ONLY_SECRET=1\n', { ageMs: 60 * 60 * 1000 });
    run('git', ['add', '.env'], root);
    const onlySecretOut = vaultAndCleanCheckout(root, {
      graceMs: 0,
      listActivePaths: () => [],
      quarantineRoot,
    });
    assert.equal(onlySecretOut.applied, true);
    assert.equal(onlySecretOut.refs.staged, undefined);
    assert.equal(fs.existsSync(envAbs), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(quarantineRoot, { recursive: true, force: true });
  }
});
