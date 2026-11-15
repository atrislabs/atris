'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { restoreCommand, parseRestoreArgs, showRestoreHelp } = require('../commands/restore');

function captureOutput(fn) {
  const out = [];
  const err = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...parts) => out.push(parts.join(' '));
  console.error = (...parts) => err.push(parts.join(' '));
  try {
    const code = fn();
    return { code, out: out.join('\n'), err: err.join('\n') };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-restore-cmd-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('showRestoreHelp and help flags print usage and take precedence without calling vaultLib', () => {
  const expected = captureOutput(() => showRestoreHelp()).out;
  assert.match(expected, /Usage: atris restore \[--list\] \[--json\]/);
  assert.match(expected, /--slice <name>/);
  assert.match(expected, /--worktree, -w/);

  let called = false;
  const untouchedVaultLib = {
    listVaultSnapshots() { called = true; return []; },
    restoreFromVault() { called = true; return { ok: true }; },
  };

  for (const args of [
    ['--help'],
    ['-h'],
    ['help'],
    ['20261112-204500-a1b2c3', '--worktree', '--help'],
    ['--list', '-h'],
  ]) {
    const res = captureOutput(() => restoreCommand(args, { vaultLib: untouchedVaultLib }));
    assert.strictEqual(res.code, 0, JSON.stringify(args));
    assert.strictEqual(res.out, expected, JSON.stringify(args));
    assert.strictEqual(called, false, JSON.stringify(args));
  }
});

test('parseRestoreArgs handles list default, restore flags, inline syntax, and -- separator', () => {
  const bare = parseRestoreArgs([]);
  assert.strictEqual(bare.list, true);
  assert.strictEqual(bare.error, null);

  const explicitList = parseRestoreArgs(['--list', '--json']);
  assert.strictEqual(explicitList.list, true);
  assert.strictEqual(explicitList.json, true);
  assert.strictEqual(explicitList.error, null);

  const parsed = parseRestoreArgs([
    '20261112-204500-a1b2c3',
    'backend/services/trace_capture.py',
    'backend/tests/',
    '--slice', 'code',
    '--worktree',
    '--agent=restorer',
    '--dry-run',
    '--force',
    '--json',
  ]);
  assert.deepStrictEqual(parsed, {
    help: false,
    list: false,
    json: true,
    dryRun: true,
    force: true,
    worktree: true,
    slice: 'code',
    sliceExplicit: true,
    agent: 'restorer',
    vaultId: '20261112-204500-a1b2c3',
    paths: ['backend/services/trace_capture.py', 'backend/tests/'],
    error: null,
  });

  const withDashPath = parseRestoreArgs(['20261112-204500-a1b2c3', '--slice=exhaust', '--', '-weird-file.txt']);
  assert.strictEqual(withDashPath.slice, 'exhaust');
  assert.deepStrictEqual(withDashPath.paths, ['-weird-file.txt']);
  assert.strictEqual(withDashPath.error, null);
});

test('parseRestoreArgs rejects invalid flags, invalid slices, missing values, and missing vaultId for restore flags', () => {
  assert.match(parseRestoreArgs(['--bogus']).error, /Unknown option: --bogus/);
  assert.match(parseRestoreArgs(['v1', '--slice', 'bad']).error, /Invalid --slice "bad"/);
  assert.match(parseRestoreArgs(['v1', '--slice']).error, /--slice requires a value/);
  assert.match(parseRestoreArgs(['v1', '--slice=']).error, /--slice requires a value/);
  assert.match(parseRestoreArgs(['v1', '--agent']).error, /--agent requires a value/);
  assert.match(parseRestoreArgs(['--worktree']).error, /Missing <vault-id>/);
  assert.match(parseRestoreArgs(['--slice', 'code']).error, /Missing <vault-id>/);
  assert.match(parseRestoreArgs(['--force']).error, /Missing <vault-id>/);
  assert.match(parseRestoreArgs(['--dry-run']).error, /Missing <vault-id>/);
});

test('restoreCommand lists snapshots in text and --json (default when no vault-id and explicit --list)', () => {
  withTempDir((tmpDir) => {
    const snapshots = [
      {
        id: '20261112-204500-a1b2c3',
        at: '2026-11-12T20:45:00.000Z',
        counts_by_class: { UNFINISHED_CODE: 16, AGENT_EXHAUST: 1197 },
        refs: { full: 'refs/atris/vault/20261112-204500-a1b2c3/full', code: 'refs/atris/vault/20261112-204500-a1b2c3/code' },
        quarantine_path: '/tmp/q/20261112-204500-a1b2c3',
      },
    ];
    let seenCwd = null;
    const vaultLib = {
      listVaultSnapshots(cwd) {
        seenCwd = cwd;
        return snapshots;
      },
      restoreFromVault() {
        throw new Error('should not be called');
      },
    };

    const textRes = captureOutput(() => restoreCommand([], { cwd: tmpDir, vaultLib }));
    assert.strictEqual(textRes.code, 0);
    assert.strictEqual(seenCwd, path.resolve(tmpDir));
    assert.match(textRes.out, /Vault snapshots \(1\):/);
    assert.match(textRes.out, /20261112-204500-a1b2c3/);
    assert.match(textRes.out, /code: 16, exhaust: 1197/);
    assert.match(textRes.out, /quarantine: \/tmp\/q\/20261112-204500-a1b2c3/);

    const jsonRes = captureOutput(() => restoreCommand(['--list', '--json'], { cwd: tmpDir, vaultLib }));
    assert.strictEqual(jsonRes.code, 0);
    assert.deepStrictEqual(JSON.parse(jsonRes.out), {
      ok: true,
      action: 'restore_list',
      count: 1,
      snapshots,
    });
  });
});

test('restoreCommand handles empty snapshot lists cleanly', () => {
  withTempDir((tmpDir) => {
    const vaultLib = {
      listVaultSnapshots: () => ({ snapshots: [] }),
      restoreFromVault: () => ({ ok: true }),
    };
    const textRes = captureOutput(() => restoreCommand(['--list'], { cwd: tmpDir, vaultLib }));
    assert.strictEqual(textRes.code, 0);
    assert.match(textRes.out, /No vault snapshots found/);

    const jsonRes = captureOutput(() => restoreCommand(['--json'], { cwd: tmpDir, vaultLib }));
    assert.strictEqual(jsonRes.code, 0);
    assert.deepStrictEqual(JSON.parse(jsonRes.out), {
      ok: true,
      action: 'restore_list',
      count: 0,
      snapshots: [],
    });
  });
});

test('restoreCommand forwards paths, slice, dry-run, force, worktree, and agent to restoreFromVault', () => {
  withTempDir((tmpDir) => {
    const calls = [];
    const vaultLib = {
      listVaultSnapshots: () => [],
      restoreFromVault(cwd, opts) {
        calls.push({ cwd, opts });
        if (opts.worktree) {
          return {
            ok: true,
            vaultId: opts.vaultId,
            slice: opts.slice,
            dryRun: opts.dryRun,
            restored: ['backend/services/trace_capture.py', 'backend/tests/test_a.py'],
            worktreePath: '/tmp/wt/restore-code',
            branch: 'feat/restore-20261112',
          };
        }
        return {
          ok: true,
          vaultId: opts.vaultId,
          slice: opts.slice,
          dryRun: opts.dryRun,
          restored: opts.paths.length ? opts.paths : ['a.txt', 'b.txt'],
          quarantinedRestored: ['.env.local'],
          skipped: ['unchanged.txt'],
        };
      },
    };

    // Dry-run path restore
    const dryRes = captureOutput(() => restoreCommand([
      '20261112-204500-a1b2c3',
      'backend/services/trace_capture.py',
      '--slice', 'staged',
      '--dry-run',
      '--force',
    ], { cwd: tmpDir, vaultLib }));
    assert.strictEqual(dryRes.code, 0);
    assert.deepStrictEqual(calls[0], {
      cwd: path.resolve(tmpDir),
      opts: {
        vaultId: '20261112-204500-a1b2c3',
        paths: ['backend/services/trace_capture.py'],
        slice: 'staged',
        worktree: false,
        agent: null,
        dryRun: true,
        force: true,
      },
    });
    assert.match(dryRes.out, /Would restore 1 file from 20261112-204500-a1b2c3 \(slice: staged\)/);
    assert.match(dryRes.out, /Would restore 1 quarantined file/);
    assert.match(dryRes.out, /Skipped 1 file/);

    // Worktree + agent + json
    const wtRes = captureOutput(() => restoreCommand([
      '20261112-204500-a1b2c3',
      '--slice', 'code',
      '--worktree',
      '--agent', 'codex',
      '--json',
    ], { cwd: tmpDir, vaultLib }));
    assert.strictEqual(wtRes.code, 0);
    assert.deepStrictEqual(calls[1].opts, {
      vaultId: '20261112-204500-a1b2c3',
      paths: [],
      slice: 'code',
      worktree: true,
      agent: 'codex',
      dryRun: false,
      force: false,
    });
    assert.deepStrictEqual(JSON.parse(wtRes.out), {
      ok: true,
      action: 'restore',
      dry_run: false,
      vault_id: '20261112-204500-a1b2c3',
      slice: 'code',
      worktree: true,
      agent: 'codex',
      force: false,
      requested_paths: [],
      restored_count: 2,
      restored_files: ['backend/services/trace_capture.py', 'backend/tests/test_a.py'],
      quarantined_files: [],
      skipped_files: [],
      worktree_path: '/tmp/wt/restore-code',
      branch: 'feat/restore-20261112',
    });

    // Worktree text mode prints cd hint
    const wtText = captureOutput(() => restoreCommand([
      '20261112-204500-a1b2c3',
      '--slice', 'code',
      '--worktree',
    ], { cwd: tmpDir, vaultLib }));
    assert.strictEqual(wtText.code, 0);
    assert.match(wtText.out, /into worktree/);
    assert.match(wtText.out, /worktree: \/tmp\/wt\/restore-code/);
    assert.match(wtText.out, /branch:\s+feat\/restore-20261112/);
    assert.match(wtText.out, /next:\s+cd \/tmp\/wt\/restore-code/);
  });
});

test('restoreCommand truncates long file lists in text mode', () => {
  withTempDir((tmpDir) => {
    const manyFiles = Array.from({ length: 25 }, (_, i) => `file-${i + 1}.js`);
    const vaultLib = {
      listVaultSnapshots: () => [],
      restoreFromVault: () => ({ ok: true, restored: manyFiles }),
    };
    const res = captureOutput(() => restoreCommand(['v1', '--slice', 'full'], { cwd: tmpDir, vaultLib }));
    assert.strictEqual(res.code, 0);
    assert.match(res.out, /Restored 25 files from v1 \(slice: full\)/);
    assert.match(res.out, /\.\.\. and 5 more/);
  });
});

test('restoreCommand handles usage errors (exit 2) and vault errors/conflicts (exit 1)', () => {
  withTempDir((tmpDir) => {
    const badText = captureOutput(() => restoreCommand(['v1', '--slice', 'nope'], { cwd: tmpDir }));
    assert.strictEqual(badText.code, 2);
    assert.match(badText.err, /Invalid --slice "nope"/);
    assert.match(badText.err, /atris restore --help/);

    const badJson = captureOutput(() => restoreCommand(['--unknown', '--json'], { cwd: tmpDir }));
    assert.strictEqual(badJson.code, 2);
    assert.deepStrictEqual(JSON.parse(badJson.out), {
      ok: false,
      action: 'restore',
      error: 'Unknown option: --unknown',
    });

    // Thrown conflict error
    const conflictErr = Object.assign(new Error('Refusing to overwrite dirty local files'), {
      conflicts: ['a.js', 'b.js'],
    });
    const throwingVaultLib = {
      listVaultSnapshots() { throw new Error('git failed'); },
      restoreFromVault() { throw conflictErr; },
    };

    const errText = captureOutput(() => restoreCommand(['v1'], { cwd: tmpDir, vaultLib: throwingVaultLib }));
    assert.strictEqual(errText.code, 1);
    assert.match(errText.err, /Refusing to overwrite dirty local files/);
    assert.match(errText.err, /a\.js/);
    assert.match(errText.err, /Pass --force/);

    const errJson = captureOutput(() => restoreCommand(['v1', '--json'], { cwd: tmpDir, vaultLib: throwingVaultLib }));
    assert.strictEqual(errJson.code, 1);
    assert.deepStrictEqual(JSON.parse(errJson.out), {
      ok: false,
      action: 'restore',
      error: 'Refusing to overwrite dirty local files',
      conflicts: ['a.js', 'b.js'],
    });

    // Returned { ok: false, error }
    const failObjLib = {
      listVaultSnapshots: () => [],
      restoreFromVault: () => ({ ok: false, error: 'Snapshot not found: missing-id' }),
    };
    const failObjRes = captureOutput(() => restoreCommand(['missing-id'], { cwd: tmpDir, vaultLib: failObjLib }));
    assert.strictEqual(failObjRes.code, 1);
    assert.match(failObjRes.err, /Snapshot not found: missing-id/);

    // List error
    const listErrRes = captureOutput(() => restoreCommand(['--list', '--json'], { cwd: tmpDir, vaultLib: throwingVaultLib }));
    assert.strictEqual(listErrRes.code, 1);
    assert.deepStrictEqual(JSON.parse(listErrRes.out), {
      ok: false,
      action: 'restore_list',
      error: 'git failed',
    });
  });
});
