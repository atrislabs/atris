'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const cliPath = path.join(__dirname, '..', 'bin', 'atris.js');

function makeTempDir(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function git(cwd, ...args) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(res.status, 0, `git ${args.join(' ')} failed: ${res.stderr || res.stdout}`);
  return res.stdout.trim();
}

function runCli(args, cwd, homeDir) {
  const env = {
    ...process.env,
    HOME: homeDir,
    ATRIS_SKIP_UPDATE_CHECK: '1',
    ATRIS_NONINTERACTIVE: '1',
  };
  for (const key of Object.keys(env)) {
    if (key.startsWith('ATRIS_') && key !== 'ATRIS_SKIP_UPDATE_CHECK' && key !== 'ATRIS_NONINTERACTIVE') {
      delete env[key];
    }
  }
  const res = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: 'utf8',
    env,
  });
  if (res.error) throw res.error;
  return res;
}

function makeDirtyRepo(t, { ageHours = 2 } = {}) {
  const dir = makeTempDir('atris-clean-git-repo-');
  const home = makeTempDir('atris-clean-git-home-');
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  });

  git(dir, 'init', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test User');

  fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'atris', 'MAP.md'), '# MAP\n');
  fs.writeFileSync(path.join(dir, 'atris', 'TODO.md'), '# TODO\n');
  fs.writeFileSync(path.join(dir, 'src', 'app.py'), 'print("v1")\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');

  const dirtyFiles = [
    ['backend/services/trace_capture.py', 'def trace():\n    return "ok"\n'],
    ['atris/features/old-feat/spec.md', '# old spec\n'],
    ['synth.html', '<html>scratch</html>\n'],
    ['src/app.py', 'print("v2")\n'],
  ];
  const mtime = new Date(Date.now() - ageHours * 60 * 60 * 1000);
  for (const [rel, content] of dirtyFiles) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
    fs.utimesSync(abs, mtime, mtime);
  }

  return { dir, home };
}

test('atris clean --dry-run --json and default clean report categorized git dirt without claiming Target state: 0', (t) => {
  const { dir, home } = makeDirtyRepo(t);

  const dryJson = runCli(['clean', '--dry-run', '--json'], dir, home);
  assert.equal(dryJson.status, 0, dryJson.stderr);
  assert.doesNotMatch(dryJson.stdout, /Target state:\s*0/);
  const payload = JSON.parse(dryJson.stdout);
  assert.equal(payload.ok, false);
  assert.equal(payload.dry_run, true);
  assert.ok(payload.target_state > 0);
  assert.equal(payload.results.git_hygiene.is_git_repo, true);
  assert.equal(payload.results.git_hygiene.dirty_count, 4);
  assert.equal(payload.results.git_hygiene.actionable_count, 4);
  assert.equal(payload.results.git_hygiene.remaining_dirty, 4);
  assert.equal(payload.results.git_hygiene.by_class.UNFINISHED_CODE, 2);
  assert.equal(payload.results.git_hygiene.by_class.AGENT_EXHAUST, 1);
  assert.equal(payload.results.git_hygiene.by_class.LOOSE_SCRATCH, 1);
  assert.ok(payload.manual_action.some((line) => /atris clean --apply/.test(line)));

  // Default read-only `atris clean` (no --apply) must not clean git files or print Target state: 0
  const textClean = runCli(['clean'], dir, home);
  assert.equal(textClean.status, 0, textClean.stderr);
  assert.doesNotMatch(textClean.stdout, /Target state:\s*0/);
  assert.match(textClean.stdout, /4 dirty git files/);
  assert.match(textClean.stdout, /UNFINISHED_CODE: 2/);
  assert.match(textClean.stdout, /AGENT_EXHAUST: 1/);
  assert.match(textClean.stdout, /LOOSE_SCRATCH: 1/);
  assert.match(textClean.stdout, /atris clean --apply/);
  assert.equal(fs.existsSync(path.join(dir, 'backend/services/trace_capture.py')), true);
  assert.equal(fs.existsSync(path.join(dir, 'synth.html')), true);
});

test('atris clean --apply --json vaults dirty files, cleans tree to remaining_dirty: 0, writes catalog, and restores via CLI', (t) => {
  const { dir, home } = makeDirtyRepo(t);

  const applyRes = runCli(['clean', '--apply', '--json'], dir, home);
  assert.equal(applyRes.status, 0, applyRes.stderr);
  const payload = JSON.parse(applyRes.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.apply, true);
  assert.equal(payload.target_state, 0);
  assert.deepEqual(payload.manual_action, []);

  const gh = payload.results.git_hygiene;
  assert.equal(gh.is_git_repo, true);
  assert.equal(gh.remaining_dirty, 0);
  assert.ok(gh.vault && gh.vault.applied === true);
  assert.ok(gh.vault.vault_id);
  assert.equal(gh.vault.vaulted_count, 4);
  assert.ok(gh.vault.refs && gh.vault.refs.full && gh.vault.refs.code && gh.vault.refs.exhaust);

  const vaultId = gh.vault.vault_id;
  const vaultRefs = git(dir, 'for-each-ref', '--format=%(refname)', 'refs/atris/vault');
  assert.match(vaultRefs, new RegExp(`refs/atris/vault/${vaultId}/full`));
  assert.match(vaultRefs, new RegExp(`refs/atris/vault/${vaultId}/code`));
  assert.match(vaultRefs, new RegExp(`refs/atris/vault/${vaultId}/exhaust`));

  // Working tree cleaned to canonical HEAD
  assert.equal(fs.existsSync(path.join(dir, 'backend/services/trace_capture.py')), false);
  assert.equal(fs.existsSync(path.join(dir, 'atris/features/old-feat/spec.md')), false);
  assert.equal(fs.existsSync(path.join(dir, 'synth.html')), false);
  assert.equal(fs.readFileSync(path.join(dir, 'src/app.py'), 'utf8'), 'print("v1")\n');

  // Vault catalog written and contains vaultId
  const catalogPath = path.join(dir, '.atris', 'state', 'vault-catalog.md');
  assert.equal(fs.existsSync(catalogPath), true);
  assert.match(fs.readFileSync(catalogPath, 'utf8'), new RegExp(vaultId));

  // Subsequent `atris clean` reports Target state: 0 cleanly
  const postText = runCli(['clean'], dir, home);
  assert.equal(postText.status, 0, postText.stderr);
  assert.match(postText.stdout, /Workspace is clean\. Target state: 0 ✓/);

  // End-to-end `atris restore --list --json` and `atris restore <vault-id> --slice code` via CLI
  const listRes = runCli(['restore', '--list', '--json'], dir, home);
  assert.equal(listRes.status, 0, listRes.stderr);
  const listPayload = JSON.parse(listRes.stdout);
  assert.equal(listPayload.ok, true);
  assert.equal(listPayload.count, 1);
  assert.equal(listPayload.snapshots[0].id, vaultId);

  const restoreRes = runCli(['restore', vaultId, '--slice', 'code'], dir, home);
  assert.equal(restoreRes.status, 0, restoreRes.stderr);
  assert.match(restoreRes.stdout, new RegExp(`Restored .* from ${vaultId} \\(slice: code\\)`));
  assert.equal(fs.readFileSync(path.join(dir, 'backend/services/trace_capture.py'), 'utf8'), 'def trace():\n    return "ok"\n');
  assert.equal(fs.readFileSync(path.join(dir, 'src/app.py'), 'utf8'), 'print("v2")\n');
  // Exhaust and scratch slices were NOT restored by `--slice code`
  assert.equal(fs.existsSync(path.join(dir, 'atris/features/old-feat/spec.md')), false);
  assert.equal(fs.existsSync(path.join(dir, 'synth.html')), false);
});

test('atris clean --vault and --grace-minutes preserve in-flight files when within grace window', (t) => {
  const { dir, home } = makeDirtyRepo(t, { ageHours: 2 });

  // Add one fresh file in its own bundle (within default 30-min grace window)
  const freshFile = path.join(dir, 'backend/active/in_flight.py');
  fs.mkdirSync(path.dirname(freshFile), { recursive: true });
  fs.writeFileSync(freshFile, 'active = True\n', 'utf8');

  const partial = runCli(['clean', '--vault'], dir, home);
  assert.equal(partial.status, 0, partial.stderr);
  assert.match(partial.stdout, /Vaulted 4 dirty git files/);
  assert.match(partial.stdout, /Preserved 1 in-flight\/unprovable file on disk:/);
  assert.match(partial.stdout, /backend\/active\/in_flight\.py \(ACTIVE_IN_FLIGHT\)/);
  assert.doesNotMatch(partial.stdout, /Target state:\s*0/);
  assert.equal(fs.existsSync(freshFile), true);
  assert.equal(fs.existsSync(path.join(dir, 'synth.html')), false);

  // Passing --grace-minutes 0 vaults the fresh file too and reaches Target state: 0
  const zeroGrace = runCli(['clean', '--apply', '--grace-minutes', '0'], dir, home);
  assert.equal(zeroGrace.status, 0, zeroGrace.stderr);
  assert.match(zeroGrace.stdout, /Vaulted 1 dirty git file/);
  assert.match(zeroGrace.stdout, /Workspace is clean\. Target state: 0 ✓/);
  assert.equal(fs.existsSync(freshFile), false);
});

test('atris clean --help, atris restore --help, and invalid --grace-minutes behave cleanly', (t) => {
  const dir = makeTempDir('atris-clean-help-');
  const home = makeTempDir('atris-clean-help-home-');
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  });

  const cleanHelp = runCli(['clean', '--help'], dir, home);
  assert.equal(cleanHelp.status, 0, cleanHelp.stderr);
  assert.match(cleanHelp.stdout, /--apply, --vault/);
  assert.match(cleanHelp.stdout, /--grace-minutes/);

  const restoreHelp = runCli(['restore', '--help'], dir, home);
  assert.equal(restoreHelp.status, 0, restoreHelp.stderr);
  assert.match(restoreHelp.stdout, /Usage: atris restore/);
  assert.match(restoreHelp.stdout, /--slice <name>/);

  const badGrace = runCli(['clean', '--grace-minutes', 'not-a-number', '--json'], dir, home);
  assert.equal(badGrace.status, 2);
  const badPayload = JSON.parse(badGrace.stdout);
  assert.equal(badPayload.ok, false);
  assert.match(badPayload.error, /--grace-minutes/);
});

test('atris clean --apply recovers crashed VAULTED WAL even when files fall inside the grace window', (t) => {
  const { dir, home } = makeDirtyRepo(t, { ageHours: 0 });
  const freshRel = 'backend/services/crashed_fresh.py';
  const freshAbs = path.join(dir, freshRel);
  fs.mkdirSync(path.dirname(freshAbs), { recursive: true });
  fs.writeFileSync(freshAbs, 'crashed = True\n', 'utf8');
  const st = fs.lstatSync(freshAbs);

  // Remove the aged dirty files so ONLY the fresh crashed file remains (actionableCount === 0 under 30m grace)
  fs.rmSync(path.join(dir, 'backend/services/trace_capture.py'));
  fs.rmSync(path.join(dir, 'atris/features/old-feat/spec.md'));
  fs.rmSync(path.join(dir, 'synth.html'));
  git(dir, 'checkout', '-q', '--', 'src/app.py');

  const vaultId = '20261112-211500-walrec';
  const headTree = git(dir, 'rev-parse', 'HEAD^{tree}');
  const commitOid = git(dir, 'commit-tree', headTree, '-m', 'crashed vault');
  git(dir, 'update-ref', `refs/atris/vault/${vaultId}/full`, commitOid);

  const walDir = path.join(dir, '.atris', 'vault');
  fs.mkdirSync(walDir, { recursive: true });
  const walPath = path.join(walDir, `wal-${vaultId}.json`);
  fs.writeFileSync(walPath, JSON.stringify({
    vaultId,
    status: 'VAULTED',
    entries: [
      { relPath: freshRel, xy: '??', stat0: { ino: st.ino, size: st.size, mtimeMs: st.mtimeMs } },
    ],
  }));

  // Dry-run stays read-only: WAL and fresh file remain intact
  const dryRes = runCli(['clean', '--dry-run', '--json'], dir, home);
  assert.equal(dryRes.status, 0, dryRes.stderr);
  assert.equal(fs.existsSync(walPath), true);
  assert.equal(fs.existsSync(freshAbs), true);

  // Apply with default 30m grace (actionableCount === 0) replays VAULTED WAL and cleans up
  const applyRes = runCli(['clean', '--apply', '--json'], dir, home);
  assert.equal(applyRes.status, 0, applyRes.stderr);
  const payload = JSON.parse(applyRes.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.target_state, 0);
  assert.equal(payload.results.git_hygiene.remaining_dirty, 0);
  assert.equal(fs.existsSync(walPath), false);
  assert.equal(fs.existsSync(freshAbs), false);
});
