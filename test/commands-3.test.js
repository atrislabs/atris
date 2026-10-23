// Part 3 of 8 of the commands suite, split so node --test runs them in parallel.
// Shared imports and fixture helpers live in test/helpers/commands-fixtures.js.
const test = require('node:test');
const {
  assert,
  fs,
  path,
  spawnSync,
  formatLocalDate,
  buildPullConflictReviewPacket,
  mergeSmartPullFiles,
  normalizePullFilePath,
  collectState,
  canPreviewPush,
  collectBrainSnapshot,
  collectLocalSyncStatus,
  collectWorkspaceWarnings,
  describeWatchFailure,
  renderBusinessSyncHelp,
  renderLatestConflictReview,
  renderLocalSyncStatus,
  safeLineMerge,
  safeMarkdownMerge,
  shouldIgnoreWatchPath,
  brainSnapshotsDiffer,
  writeSyncStatus,
  writeBaseContents,
  writeConflictReviewPacket,
  cliPath,
  makeTempDir,
  cleanupTempDir,
  runCli,
  hasNodeSqlite,
  runGit,
  seedBrainWorkspace,
  assertAdvertisedAtrisPathsExist,
} = require('./helpers/commands-fixtures');

test('business sync safe merge refuses overlapping conflict artifacts', () => {
  const merge = safeLineMerge(
    'A\nB\nC\n',
    'A\nlocal B\nC\n',
    'A\ncloud B\nC\n'
  );
  assert.equal(merge.ok, false);
  assert.match(merge.reason, /overlap/);
});

test('business sync markdown merge accepts different section edits', () => {
  const base = '# Ops\n\n## Sales\n\nOld sales.\n\nMiddle note.\n\n## Support\n\nOld support.\n';
  const local = '# Ops\n\n## Sales\n\nNew sales.\n\nMiddle note.\n\n## Support\n\nOld support.\n';
  const remote = '# Ops\n\n## Sales\n\nOld sales.\n\nMiddle note changed.\n\n## Support\n\nNew support.\n';

  const merge = safeMarkdownMerge(base, local, remote);
  assert.equal(merge.ok, true);
  assert.equal(merge.content, '# Ops\n\n## Sales\n\nNew sales.\n\nMiddle note changed.\n\n## Support\n\nNew support.\n');
});

test('business sync markdown merge refuses same section edits', () => {
  const base = '# Ops\n\n## Sales\n\nOld sales.\n';
  const local = '# Ops\n\n## Sales\n\nLocal sales.\n';
  const remote = '# Ops\n\n## Sales\n\nCloud sales.\n';

  const merge = safeMarkdownMerge(base, local, remote);
  assert.equal(merge.ok, false);
  assert.match(merge.reason, /sales/);
});

test('business sync resolve command is local-only and works without credentials', () => {
  const dir = makeTempDir();
  try {
    const packetDir = path.join(dir, '.atris', 'sync', 'conflicts', '2026-05-01T12-00-00Z', 'atris', 'wiki');
    fs.mkdirSync(packetDir, { recursive: true });
    fs.mkdirSync(path.join(dir, '.atris'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.atris', 'business.json'), JSON.stringify({ slug: 'example-co' }), 'utf8');
    fs.writeFileSync(path.join(packetDir, 'a.md.base'), 'A\nB\nC\n', 'utf8');
    fs.writeFileSync(path.join(packetDir, 'a.md.local'), 'A\nB local\nC\n', 'utf8');
    fs.writeFileSync(path.join(packetDir, 'a.md.remote'), 'A\nB\nC cloud\n', 'utf8');
    fs.writeFileSync(path.join(dir, '.atris', 'sync', 'conflicts', '2026-05-01T12-00-00Z', 'summary.md'), '# Review\n', 'utf8');

    const res = runCli(['sync', '--resolve', 'merge'], { cwd: dir, env: { ATRIS_TOKEN: '' } });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Resolved 1 conflict/);
    assert.match(res.stdout, /safe merge/);
    assert.equal(fs.readFileSync(path.join(dir, 'atris', 'wiki', 'a.md'), 'utf8'), 'A\nB local\nC cloud\n');
  } finally {
    cleanupTempDir(dir);
  }
});

test('business sync resolve can target one conflict path at a time', () => {
  const dir = makeTempDir();
  try {
    const conflictRoot = path.join(dir, '.atris', 'sync', 'conflicts', '2026-05-01T12-00-00Z');
    const packetDir = path.join(conflictRoot, 'atris', 'wiki');
    fs.mkdirSync(packetDir, { recursive: true });
    fs.writeFileSync(path.join(conflictRoot, 'summary.md'), '# Review\n', 'utf8');
    fs.writeFileSync(path.join(packetDir, 'a.md.local'), 'a local\n', 'utf8');
    fs.writeFileSync(path.join(packetDir, 'a.md.remote'), 'a cloud\n', 'utf8');
    fs.writeFileSync(path.join(packetDir, 'b.md.local'), 'b local\n', 'utf8');
    fs.writeFileSync(path.join(packetDir, 'b.md.remote'), 'b cloud\n', 'utf8');

    const cloud = runCli(['sync', '--resolve', 'cloud', '--path', 'atris/wiki/a.md'], { cwd: dir, env: { ATRIS_TOKEN: '' } });
    assert.equal(cloud.status, 0, cloud.stderr);
    assert.match(cloud.stdout, /Resolved 1 conflict/);
    assert.match(cloud.stdout, /atris\/wiki\/a\.md/);
    assert.doesNotMatch(cloud.stdout, /atris\/wiki\/b\.md/);
    assert.equal(fs.readFileSync(path.join(dir, 'atris', 'wiki', 'a.md'), 'utf8'), 'a cloud\n');
    assert.equal(fs.existsSync(path.join(packetDir, 'a.md.local')), false);
    assert.equal(fs.existsSync(path.join(packetDir, 'a.md.remote')), false);
    assert.ok(fs.existsSync(path.join(packetDir, 'b.md.local')));
    assert.ok(fs.existsSync(path.join(conflictRoot, 'summary.md')));
    assert.match(renderLatestConflictReview(dir), /Latest sync conflict review/);

    const local = runCli(['sync', '--resolve', 'local', '--path', 'atris/wiki/b.md'], { cwd: dir, env: { ATRIS_TOKEN: '' } });
    assert.equal(local.status, 0, local.stderr);
    assert.match(local.stdout, /Resolved 1 conflict/);
    assert.match(local.stdout, /atris\/wiki\/b\.md/);
    assert.equal(fs.readFileSync(path.join(dir, 'atris', 'wiki', 'b.md'), 'utf8'), 'b local\n');
    assert.equal(fs.existsSync(path.join(conflictRoot, 'summary.md')), false);
    assert.equal(renderLatestConflictReview(dir), 'No sync conflicts need review.\n');
  } finally {
    cleanupTempDir(dir);
  }
});

test('business sync final resolve records pending pull manifest', () => {
  const dir = makeTempDir();
  const home = path.join(dir, 'home');
  try {
    const conflictRoot = path.join(dir, '.atris', 'sync', 'conflicts', '2026-05-01T12-00-00Z');
    const packetDir = path.join(conflictRoot, 'atris', 'wiki');
    fs.mkdirSync(packetDir, { recursive: true });
    fs.mkdirSync(path.join(dir, '.atris'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.atris', 'business.json'), JSON.stringify({ slug: 'acme' }), 'utf8');
    fs.writeFileSync(path.join(conflictRoot, 'summary.md'), '# Review\n', 'utf8');
    fs.writeFileSync(path.join(packetDir, 'a.md.local'), 'a local\n', 'utf8');
    fs.writeFileSync(path.join(packetDir, 'a.md.remote'), 'a cloud\n', 'utf8');
    fs.writeFileSync(path.join(packetDir, 'b.md.local'), 'b local\n', 'utf8');
    fs.writeFileSync(path.join(packetDir, 'b.md.remote'), 'b cloud\n', 'utf8');
    fs.writeFileSync(path.join(conflictRoot, 'manifest.json'), `${JSON.stringify({
      slug: 'acme',
      manifest: {
        last_sync: '2026-05-01T12:00:00.000Z',
        last_commit: 'commit123',
        workspace_root: dir,
        files: {
          '/atris/wiki/a.md': { hash: 'cloud-a', size: 8 },
          '/atris/wiki/b.md': { hash: 'cloud-b', size: 8 },
        },
      },
      baseContents: {
        '/atris/wiki/a.md': 'a cloud\n',
        '/atris/wiki/b.md': 'b cloud\n',
      },
      deletedRemote: ['/atris/wiki/old.md'],
    }, null, 2)}\n`, 'utf8');
    const oldBase = path.join(dir, '.atris', 'sync', 'base', 'atris', 'wiki', 'old.md');
    fs.mkdirSync(path.dirname(oldBase), { recursive: true });
    fs.writeFileSync(oldBase, 'old base\n', 'utf8');

    const first = runCli(['sync', '--resolve', 'cloud', '--path', 'atris/wiki/a.md'], { cwd: dir, env: { HOME: home, ATRIS_TOKEN: '' } });
    assert.equal(first.status, 0, first.stderr);
    assert.ok(fs.existsSync(path.join(conflictRoot, 'summary.md')));
    assert.equal(fs.existsSync(path.join(home, '.atris', 'businesses', 'acme', 'manifest.json')), false);

    const second = runCli(['sync', '--resolve', 'local', '--path', 'atris/wiki/b.md'], { cwd: dir, env: { HOME: home, ATRIS_TOKEN: '' } });
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stdout, /Updated sync manifest for acme/);
    assert.equal(fs.existsSync(path.join(conflictRoot, 'summary.md')), false);
    const manifest = JSON.parse(fs.readFileSync(path.join(home, '.atris', 'businesses', 'acme', 'manifest.json'), 'utf8'));
    assert.equal(manifest.files['/atris/wiki/a.md'].hash, 'cloud-a');
    assert.equal(manifest.files['/atris/wiki/b.md'].hash, 'cloud-b');
    assert.equal(fs.readFileSync(path.join(dir, '.atris', 'sync', 'base', 'atris', 'wiki', 'a.md'), 'utf8'), 'a cloud\n');
    assert.equal(fs.readFileSync(path.join(dir, '.atris', 'sync', 'base', 'atris', 'wiki', 'b.md'), 'utf8'), 'b cloud\n');
    assert.equal(fs.existsSync(oldBase), false);
  } finally {
    cleanupTempDir(dir);
  }
});

test('business sync local safety commands do not require business slug detection', () => {
  const dir = makeTempDir();
  try {
    const packetDir = path.join(dir, '.atris', 'sync', 'conflicts', '2026-05-01T12-00-00Z', 'atris', 'wiki');
    fs.mkdirSync(packetDir, { recursive: true });
    fs.mkdirSync(path.join(dir, 'atris', 'wiki'), { recursive: true });
    fs.writeFileSync(path.join(packetDir, 'a.md.local'), 'local copy\n', 'utf8');
    fs.writeFileSync(path.join(packetDir, 'a.md.remote'), 'cloud copy\n', 'utf8');
    fs.writeFileSync(path.join(dir, '.atris', 'sync', 'conflicts', '2026-05-01T12-00-00Z', 'summary.md'), '# Review\n\n- atris/wiki/a.md\n', 'utf8');

    const status = runCli(['sync', '--status'], { cwd: dir, env: { ATRIS_TOKEN: '' } });
    assert.equal(status.status, 0, status.stderr);
    assert.doesNotMatch(status.stdout, /skills updated/);
    assert.match(status.stdout, /business: not detected/);
    assert.match(status.stdout, /conflicts: 1 review packet/);

    const review = runCli(['sync', '--review'], { cwd: dir, env: { ATRIS_TOKEN: '' } });
    assert.equal(review.status, 0, review.stderr);
    assert.doesNotMatch(review.stdout, /skills updated/);
    assert.match(review.stdout, /Latest sync conflict review/);

    const resolve = runCli(['sync', '--resolve', 'both'], { cwd: dir, env: { ATRIS_TOKEN: '' } });
    assert.equal(resolve.status, 0, resolve.stderr);
    assert.doesNotMatch(resolve.stdout, /skills updated/);
    assert.match(resolve.stdout, /both versions/);
    assert.equal(fs.readFileSync(path.join(dir, 'atris', 'wiki', 'a.md'), 'utf8'), 'local copy\n');
    assert.equal(fs.readFileSync(path.join(dir, 'atris', 'wiki', 'a.md.cloud'), 'utf8'), 'cloud copy\n');
  } finally {
    cleanupTempDir(dir);
  }
});

test('business sync review prints the latest conflict packet without cloud calls', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, '.atris', 'sync', 'conflicts', '2026-05-01T12-00-00Z'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.atris', 'sync', 'conflicts', '2026-05-01T12-00-00Z', 'summary.md'), '# Review\n\n- atris/wiki/a.md\n', 'utf8');

    const rendered = renderLatestConflictReview(dir);
    assert.match(rendered, /Latest sync conflict review/);
    assert.match(rendered, /# Review/);
    assert.match(rendered, /atris\/wiki\/a\.md/);
    assert.match(rendered, /atris sync --dry-run/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('business pull conflict packet includes base, local, and remote artifacts', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris', 'wiki'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'atris', 'wiki', 'a.md'), 'local edit\n', 'utf8');
    writeBaseContents(dir, { '/atris/wiki/a.md': 'base copy\n' });

    const packet = buildPullConflictReviewPacket(
      dir,
      [{ path: '/atris/wiki/a.md', status: 'conflict_updated', action: 'review' }],
      { '/atris/wiki/a.md': 'cloud edit\n' },
      '2026-05-01T12-00-00Z'
    );
    writeConflictReviewPacket(dir, packet);

    const packetDir = path.join(dir, '.atris', 'sync', 'conflicts', '2026-05-01T12-00-00Z', 'atris', 'wiki');
    assert.equal(fs.readFileSync(path.join(packetDir, 'a.md.base'), 'utf8'), 'base copy\n');
    assert.equal(fs.readFileSync(path.join(packetDir, 'a.md.local'), 'utf8'), 'local edit\n');
    assert.equal(fs.readFileSync(path.join(packetDir, 'a.md.remote'), 'utf8'), 'cloud edit\n');
    assert.match(
      fs.readFileSync(path.join(dir, '.atris', 'sync', 'conflicts', '2026-05-01T12-00-00Z', 'summary.md'), 'utf8'),
      /a\.md\.base/
    );
  } finally {
    cleanupTempDir(dir);
  }
});

test('pull normalizes cloud file paths to manifest keys', () => {
  assert.equal(normalizePullFilePath('atris/now.md'), '/atris/now.md');
  assert.equal(normalizePullFilePath('/atris/now.md'), '/atris/now.md');
  assert.equal(normalizePullFilePath('///workspace/sales/notes.md'), '/workspace/sales/notes.md');
  assert.equal(normalizePullFilePath(''), null);
});

test('pull smart merge fails closed when batch omits changed content', () => {
  const merged = mergeSmartPullFiles(
    [
      { path: 'atris/wiki/a.md', hash: 'hash-a', size: 10 },
      { path: 'atris/wiki/b.md', hash: 'hash-b', size: 10 },
    ],
    [
      { path: 'atris/wiki/a.md', content: 'A\n' },
    ],
    ['/atris/wiki/a.md', '/atris/wiki/b.md'],
  );

  assert.equal(merged.ok, false);
  assert.deepEqual(merged.missingContent, ['/atris/wiki/b.md']);

  const complete = mergeSmartPullFiles(
    [
      { path: 'atris/wiki/a.md', hash: 'hash-a', size: 10 },
      { path: 'atris/wiki/b.md', hash: 'hash-b', size: 10 },
    ],
    [
      { path: 'atris/wiki/a.md', content: 'A\n' },
      { path: 'atris/wiki/b.md', content: '' },
    ],
    ['/atris/wiki/a.md', '/atris/wiki/b.md'],
  );
  assert.equal(complete.ok, true);
  assert.equal(complete.files[1].content, '');
});

test('business sync review command is local-only and works without credentials', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, '.atris', 'sync', 'conflicts', '2026-05-01T12-00-00Z'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.atris', 'business.json'), JSON.stringify({ slug: 'example-co' }), 'utf8');
    fs.writeFileSync(path.join(dir, '.atris', 'sync', 'conflicts', '2026-05-01T12-00-00Z', 'summary.md'), '# Review\n\n- atris/wiki/a.md\n', 'utf8');

    const res = runCli(['sync', '--review'], { cwd: dir, env: { ATRIS_TOKEN: '' } });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Latest sync conflict review/);
    assert.match(res.stdout, /# Review/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('business sync status renders a nonengineer-safe local brain readout', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, '.atris'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'atris', 'wiki'), { recursive: true });
    fs.mkdirSync(path.join(dir, '.atris', 'sync', 'conflicts', '2026-05-01T12-00-00Z'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.atris', 'business.json'), JSON.stringify({ slug: 'example-co' }), 'utf8');
    fs.writeFileSync(path.join(dir, 'atris', 'wiki', 'index.md'), '# Index\n', 'utf8');
    fs.writeFileSync(path.join(dir, '.atris', 'sync', 'conflicts', '2026-05-01T12-00-00Z', 'summary.md'), '# Review\n', 'utf8');
    writeSyncStatus(dir, { slug: 'example-co', state: 'current', mode: 'watch' });

    const status = collectLocalSyncStatus(dir, { slug: 'example-co' });
    assert.equal(status.slug, 'example-co');
    assert.equal(status.brainExists, true);
    assert.equal(status.brainFileCount, 1);
    assert.equal(status.conflictCount, 1);
    assert.match(status.latestConflict, /summary\.md$/);

    const rendered = renderLocalSyncStatus(status);
    assert.match(rendered, /Business workspace sync status/);
    assert.match(rendered, /business: example-co/);
    assert.match(rendered, /workspace: 1 file \(atris\/ present\)/);
    assert.match(rendered, /conflicts: 1 review packet/);
    assert.match(rendered, /warnings: none/);
    assert.match(rendered, /watcher: last heartbeat/);
    assert.match(rendered, /atris sync --dry-run/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('business sync status warns about nested workspace pollution', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'acme', 'atris'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'acme', 'atris', 'now.md'), '# now\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'CLAUDE.md.remote'), 'cloud copy\n', 'utf8');

    const warnings = collectWorkspaceWarnings(dir, 'acme');
    assert.equal(warnings.length, 2);
    assert.match(warnings[0], /nested workspace folder: acme\//);
    assert.match(warnings[1], /sync review artifacts/);

    const rendered = renderLocalSyncStatus({
      slug: 'acme',
      cwd: dir,
      workspaceFileCount: 3,
      brainExists: true,
      lastSync: null,
      manifestRoot: dir,
      manifestRootMatches: true,
      conflictCount: 0,
      warnings,
    });
    assert.match(rendered, /warnings: 2/);
    assert.match(rendered, /nested workspace folder/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('business sync status command is local-only and works without credentials', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, '.atris'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'atris', 'wiki'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.atris', 'business.json'), JSON.stringify({ slug: 'example-co' }), 'utf8');
    fs.writeFileSync(path.join(dir, 'atris', 'wiki', 'index.md'), '# Index\n', 'utf8');

    const res = runCli(['sync', '--status'], { cwd: dir, env: { ATRIS_TOKEN: '' } });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Business workspace sync status/);
    assert.match(res.stdout, /business: example-co/);
    assert.match(res.stdout, /Next: run `atris sync --dry-run`/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('business sync help is read-only and names the safety gates', () => {
  const help = renderBusinessSyncHelp();
  assert.match(help, /Pull -> Review -> Publish/);
  assert.match(help, /Large unscoped pushes/);

  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, '.atris'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.atris', 'business.json'), JSON.stringify({ slug: 'example-co' }), 'utf8');

    const res = runCli(['sync', '--help'], { cwd: dir, env: { ATRIS_TOKEN: '' } });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Usage: atris sync/);
    assert.match(res.stdout, /Pull -> Review -> Publish/);
    assert.doesNotMatch(res.stdout, /Syncing .* business workspace/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('business sync watch failures retry instead of killing the alive loop', () => {
  const transient = describeWatchFailure(new Error('network timeout'));
  assert.equal(transient.state, 'retrying');
  assert.match(transient.detail, /still running/);

  const conflictErr = new Error('atris pull example-co exited 2');
  conflictErr.status = 2;
  const conflict = describeWatchFailure(conflictErr);
  assert.equal(conflict.state, 'conflict');
  assert.match(conflict.detail, /review packet/);
});

test('business sync watch snapshot detects workspace changes and ignores runtime state', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris', 'wiki'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'workspace', 'sales'), { recursive: true });
    fs.mkdirSync(path.join(dir, '.atris', 'state'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'atris', 'wiki', 'a.md'), 'one\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'workspace', 'sales', 'notes.md'), 'one\n', 'utf8');
    fs.writeFileSync(path.join(dir, '.atris', 'state', 'ignored.json'), '{}', 'utf8');

    const before = collectBrainSnapshot(dir);
    fs.writeFileSync(path.join(dir, '.atris', 'state', 'ignored.json'), '{"x":1}', 'utf8');
    assert.equal(brainSnapshotsDiffer(before, collectBrainSnapshot(dir)), false);

    fs.writeFileSync(path.join(dir, 'atris', 'wiki', 'a.md'), 'two longer\n', 'utf8');
    assert.equal(brainSnapshotsDiffer(before, collectBrainSnapshot(dir)), true);

    const afterAtris = collectBrainSnapshot(dir);
    fs.writeFileSync(path.join(dir, 'workspace', 'sales', 'notes.md'), 'two longer\n', 'utf8');
    assert.equal(brainSnapshotsDiffer(afterAtris, collectBrainSnapshot(dir)), true);
  } finally {
    cleanupTempDir(dir);
  }
});

test('business sync watch ignore rules skip runtime and OS files', () => {
  assert.equal(shouldIgnoreWatchPath(path.join('.atris', 'state.json')), true);
  assert.equal(shouldIgnoreWatchPath(path.join('.next', 'cache', 'bundle.js')), true);
  assert.equal(shouldIgnoreWatchPath(path.join('dist', 'bundle.js')), true);
  assert.equal(shouldIgnoreWatchPath(path.join('venv', 'bin', 'python')), true);
  assert.equal(shouldIgnoreWatchPath('.DS_Store'), true);
  assert.equal(shouldIgnoreWatchPath(path.join('wiki', 'index.md')), false);
});

test('business sync push preview is skipped when manifest belongs to another folder', () => {
  const dir = makeTempDir();
  try {
    assert.equal(canPreviewPush(dir, 'definitely-missing-test-business'), true);
  } finally {
    cleanupTempDir(dir);
  }
});

test('brain compile writes loadable status and ledger artifacts', () => {
  const dir = makeTempDir();
  try {
    seedBrainWorkspace(dir);
    const res = runCli(['brain', 'compile', '--yes', '--root', dir, '--verify'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Atris brain compiled/);
    assert.match(res.stdout, /State rows: 1 raw \/ 1 valid/);
    assert.equal(fs.existsSync(path.join(dir, 'atris', 'brain', 'STATUS.md')), true);
    assert.equal(fs.existsSync(path.join(dir, 'atris', 'brain', 'self_improvement_ledger.md')), true);
    assert.equal(fs.existsSync(path.join(dir, 'atris', 'now.md')), true);
    const status = fs.readFileSync(path.join(dir, 'atris', 'brain', 'STATUS.md'), 'utf8');
    assert.match(status, /Now loaded: yes \(now\)/);
    assert.match(status, /atris\/MAP\.md/);
    assert.match(status, /atris\/TODO\.md/);
    assert.doesNotMatch(status, /sync-language\.md|activation\/SKILL\.md/);
    assert.match(status, /First-message rule/);
    assertAdvertisedAtrisPathsExist(dir, status);
    const agents = fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8');
    assert.match(agents, /Atris Brain Compile/);
    assert.doesNotMatch(agents, /sync-language\.md|activation\/SKILL\.md/);
    assertAdvertisedAtrisPathsExist(dir, agents);
    const state = collectState(dir);
    assert.equal(state.totalRows, 1);
    assert.equal(state.validRows, 1);
    assert.equal(state.hasNow, true);
  } finally {
    cleanupTempDir(dir);
  }
});

test('brain compile includes chat scan load pointer when present', () => {
  const dir = makeTempDir();
  try {
    seedBrainWorkspace(dir);
    fs.writeFileSync(path.join(dir, '.atris', 'state', 'chat_scan.latest.json'), JSON.stringify({
      generated_at: '2026-06-28T00:00:00.000Z',
      next_command: 'atris member wake auto-improver --execute --confirm-autonomy-policy',
    }) + '\n', 'utf8');
    const res = runCli(['brain', 'compile', '--yes', '--root', dir, '--verify'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    const claude = fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8');
    assert.match(claude, /`\.atris\/state\/chat_scan\.latest\.json`/);
    const agents = fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8');
    assert.match(agents, /`\.atris\/state\/chat_scan\.latest\.json`/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('brain compile includes primary checkout chat scan pointer from worktrees', () => {
  const dir = makeTempDir();
  let worktreePath;
  try {
    seedBrainWorkspace(dir);
    assert.equal(runGit(['init', '-b', 'main'], dir).status, 0);
    assert.equal(runGit(['config', 'user.email', 'test@example.com'], dir).status, 0);
    assert.equal(runGit(['config', 'user.name', 'Test User'], dir).status, 0);
    assert.equal(runGit(['add', '.'], dir).status, 0);
    assert.equal(runGit(['commit', '-m', 'seed'], dir).status, 0);
    fs.mkdirSync(path.join(dir, '.atris', 'state'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.atris', 'state', 'chat_scan.latest.json'), JSON.stringify({
      generated_at: '2026-06-28T00:00:00.000Z',
      next_command: 'atris member wake auto-improver --execute --confirm-autonomy-policy',
    }) + '\n', 'utf8');
    worktreePath = path.join(dir, '..', `${path.basename(dir)}-brain-load-order-worktree`);
    assert.equal(runGit(['worktree', 'add', '-q', '--detach', worktreePath, 'HEAD'], dir).status, 0);

    const res = runCli(['brain', 'compile', '--yes', '--root', worktreePath, '--verify'], { cwd: worktreePath });
    assert.equal(res.status, 0, res.stderr);
    const agents = fs.readFileSync(path.join(worktreePath, 'AGENTS.md'), 'utf8');
    assert.match(agents, /`\.atris\/state\/chat_scan\.latest\.json`/);
    const status = fs.readFileSync(path.join(worktreePath, 'atris', 'brain', 'STATUS.md'), 'utf8');
    assert.match(status, /`\.atris\/state\/chat_scan\.latest\.json`/);
  } finally {
    if (worktreePath) cleanupTempDir(worktreePath);
    cleanupTempDir(dir);
  }
});

test('brain compile refreshes stale now.md before collecting state', () => {
  const dir = makeTempDir();
  try {
    seedBrainWorkspace(dir);
    fs.writeFileSync(path.join(dir, 'atris', 'TODO.md'), [
      '# TODO.md',
      '',
      '## Backlog',
      '',
      '- **[P-1]** Fresh task [probe]',
      '',
    ].join('\n'), 'utf8');
    const today = formatLocalDate(new Date());
    const journalDir = path.join(dir, 'atris', 'logs', today.slice(0, 4));
    fs.mkdirSync(journalDir, { recursive: true });
    fs.writeFileSync(path.join(journalDir, `${today}.md`), [
      '# Log',
      '',
      '## Notes',
      '',
      '- 9:00 am',
      '  Proof: compiled fresh now state.',
      '',
    ].join('\n'), 'utf8');
    fs.writeFileSync(path.join(dir, 'atris', 'now.md'), [
      '# now',
      '',
      'Last updated: 1999-01-01',
      '',
      'Open TODO items: 0',
      'Completed receipts today: 0',
      '',
    ].join('\n'), 'utf8');

    const res = runCli(['brain', 'compile', '--yes', '--root', dir, '--verify'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    const now = fs.readFileSync(path.join(dir, 'atris', 'now.md'), 'utf8');
    assert.match(now, new RegExp(`Last updated: ${today}`));
    assert.match(now, /Open TODO items: 1/);
    assert.match(now, /Completed receipts today: 1/);
    assert.doesNotMatch(now, /1999-01-01|Open TODO items: 0|Completed receipts today: 0/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('brain compile preserves a custom now.md front door', () => {
  const dir = makeTempDir();
  try {
    seedBrainWorkspace(dir);
    const customNow = [
      '# FairPlay Now',
      '',
      '## What Matters Now',
      '',
      'FairPlay should feel like a playable autonomous org.',
      '',
      '## Current Priority',
      '',
      'Run the overnight readiness gate before deploying tokens.',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(dir, 'atris', 'now.md'), customNow, 'utf8');

    const res = runCli(['brain', 'compile', '--yes', '--root', dir, '--verify'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);

    const now = fs.readFileSync(path.join(dir, 'atris', 'now.md'), 'utf8');
    assert.equal(now, customNow);

    const status = fs.readFileSync(path.join(dir, 'atris', 'brain', 'STATUS.md'), 'utf8');
    assert.match(status, /Now loaded: yes \(FairPlay Now\)/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('brain compile --json returns machine-readable missing-workspace errors', () => {
  const dir = makeTempDir();
  try {
    const res = runCli(['brain', 'compile', '--yes', '--root', dir, '--verify', '--json'], { cwd: dir });
    assert.notEqual(res.status, 0);
    assert.equal(res.stderr, '');
    const body = JSON.parse(res.stdout);
    assert.equal(body.ok, false);
    assert.match(body.error, /atris\/ folder not found/);
    assert.doesNotMatch(res.stdout + res.stderr, /at ensureAtrisDir|Node\.js/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('brain unknown --json returns machine-readable usage errors', () => {
  const dir = makeTempDir();
  try {
    seedBrainWorkspace(dir);
    const res = runCli(['brain', 'nope', '--root', dir, '--json'], { cwd: dir });
    assert.notEqual(res.status, 0);
    assert.equal(res.stderr, '');
    const body = JSON.parse(res.stdout);
    assert.equal(body.ok, false);
    assert.equal(body.error, 'unknown brain subcommand: nope');
    assert.ok(Array.isArray(body.usage));
    assert.ok(body.usage.some(line => line.includes('atris brain compile')));
  } finally {
    cleanupTempDir(dir);
  }
});

test('brain state counts rendered executable TODO rows without counting blocked or completed rows', () => {
  const dir = makeTempDir();
  try {
    seedBrainWorkspace(dir);
    fs.writeFileSync(path.join(dir, 'atris', 'TODO.md'), [
      '# TODO.md',
      '',
      '## Backlog',
      '',
      '(Empty)',
      '',
      '## In Progress',
      '',
      '- **[CLI-2]** Active task [brain]',
      '',
      '## Blocked',
      '',
      '- **[CLI-3]** Blocked task [brain]',
      '',
      '## Completed',
      '',
      '- **[CLI-1]** Completed task [brain]',
      '',
    ].join('\n'), 'utf8');

    const state = collectState(dir);

    assert.equal(state.todo.open, 1);
    assert.equal(state.todo.done, 1);
    assert.equal(state.todo.titled, 3);
  } finally {
    cleanupTempDir(dir);
  }
});

test('brain state prefers task projection for executable work counts', () => {
  const dir = makeTempDir();
  try {
    seedBrainWorkspace(dir);
    fs.writeFileSync(path.join(dir, 'atris', 'TODO.md'), [
      '# TODO.md',
      '',
      '## Backlog',
      '',
      '(Empty)',
      '',
      '## Blocked',
      '',
      '- **[CLI-3]** Blocked fallback row [brain]',
      '',
    ].join('\n'), 'utf8');
    fs.writeFileSync(path.join(dir, '.atris', 'state', 'tasks.projection.json'), JSON.stringify({
      tasks: [
        { display_id: 'CLI-1', status: 'open' },
        { display_id: 'CLI-2', status: 'claimed' },
        { display_id: 'CLI-3', status: 'blocked' },
        { display_id: 'CLI-4', status: 'review' },
        { display_id: 'CLI-5', status: 'done' },
      ],
    }), 'utf8');

    const state = collectState(dir);

    assert.equal(state.todo.open, 2);
    assert.equal(state.todo.done, 1);
    assert.equal(state.todo.titled, 5);
  } finally {
    cleanupTempDir(dir);
  }
});

test('brain compile counts task review episodes as learning state', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1' };
  try {
    seedBrainWorkspace(dir);
    fs.rmSync(path.join(dir, '.atris', 'state', 'agent_mail.jsonl'), { force: true });

    const add = runCli(['task', 'add', 'Teach brain about reviewed tasks', '--json'], { cwd: dir, env });
    assert.equal(add.status, 0, add.stderr);
    const ref = JSON.parse(add.stdout).task.display_id;
    assert.equal(runCli(['task', 'done', ref, '--proof', 'node --test test/commands.test.js passed'], { cwd: dir, env }).status, 0);

    const review = runCli([
      'task', 'review', ref,
      '--reward', '1',
      '--lesson', 'Task episodes should feed brain compile',
      '--proof', 'node --test',
      '--as', 'codex',
    ], { cwd: dir, env });
    assert.equal(review.status, 0, review.stderr);

    const res = runCli(['brain', 'compile', '--yes', '--root', dir, '--verify'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /State rows: \d+ raw \/ \d+ valid/);
    assert.match(res.stdout, /Turn existing episode rows into the first scorecard/);

    const state = JSON.parse(fs.readFileSync(path.join(dir, 'atris', 'brain', 'state.json'), 'utf8'));
    const taskEpisodes = state.stateFiles.find(item => item.path.endsWith('task_episodes.jsonl'));
    assert.equal(taskEpisodes.rows, 2);
    assert.equal(taskEpisodes.validRows, 2);

    const status = fs.readFileSync(path.join(dir, 'atris', 'brain', 'STATUS.md'), 'utf8');
    assert.match(status, /2 episode row\(s\) are available/);
    assert.doesNotMatch(status, /Capture one operator approval/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('brain scorecard derives deduped scorecards from task review episodes', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1' };
  try {
    seedBrainWorkspace(dir);
    fs.rmSync(path.join(dir, '.atris', 'state', 'agent_mail.jsonl'), { force: true });

    const add = runCli(['task', 'add', 'Score reviewed task episodes', '--tag', 'rsi', '--json'], { cwd: dir, env });
    assert.equal(add.status, 0, add.stderr);
    const ref = JSON.parse(add.stdout).task.display_id;
    assert.equal(runCli(['task', 'done', ref, '--proof', 'node --test test/commands.test.js passed'], { cwd: dir, env }).status, 0);

    const review = runCli([
      'task', 'review', ref,
      '--reward', '2',
      '--lesson', 'Scorecards need task episode rewards',
      '--proof', 'node --test',
      '--as', 'codex',
    ], { cwd: dir, env });
    assert.equal(review.status, 0, review.stderr);

    const scorecard = runCli(['brain', 'scorecard', '--root', dir, '--verify', '--json'], { cwd: dir });
    assert.equal(scorecard.status, 0, scorecard.stderr);
    const payload = JSON.parse(scorecard.stdout);
    assert.equal(payload.taskEpisodes, 2);
    assert.equal(payload.written, 1);
    assert.equal(payload.scorecards[0].schema, 'atris.brain.task_scorecard.v1');
    assert.equal(payload.scorecards[0].type, 'scorecard');
    assert.equal(payload.scorecards[0].reward, 2);
    assert.equal(payload.scorecards[0].source, 'task_review_episode');
    assert.equal(payload.scorecards[0].task_title, 'Score reviewed task episodes');
    assert.equal(payload.scorecards[0].workspace, 'demo-lab');

    const repeat = runCli(['brain', 'scorecard', '--root', dir, '--verify', '--json'], { cwd: dir });
    assert.equal(repeat.status, 0, repeat.stderr);
    assert.equal(JSON.parse(repeat.stdout).written, 0);

    const compile = runCli(['brain', 'compile', '--yes', '--root', dir, '--verify'], { cwd: dir });
    assert.equal(compile.status, 0, compile.stderr);
    assert.match(compile.stdout, /State rows: \d+ raw \/ \d+ valid/);
    assert.doesNotMatch(compile.stdout, /Turn existing episode rows into the first scorecard/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('brain scorecard carries task landing quality and human outcome', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1' };
  try {
    seedBrainWorkspace(dir);
    fs.rmSync(path.join(dir, '.atris', 'state', 'agent_mail.jsonl'), { force: true });

    const acceptedAdd = runCli(['task', 'add', 'Landing accepted task', '--tag', 'approval', '--json'], { cwd: dir, env });
    assert.equal(acceptedAdd.status, 0, acceptedAdd.stderr);
    const acceptedRef = JSON.parse(acceptedAdd.stdout).task.display_id;
    assert.equal(runCli(['task', 'claim', acceptedRef, '--as', 'codex'], { cwd: dir, env }).status, 0);
    const acceptedReady = runCli([
      'task', 'ready', acceptedRef,
      '--proof', 'node --check test/commands.test.js passed and diff reviewed',
      '--happened', 'Operators can now read the approval receipt without opening raw proof, saving time at the human gate.',
      '--checked', 'I checked the task page Result block.',
      '--tested', 'I ran the focused regression.',
      '--decision', 'Accept if the receipt is clear.',
      '--as', 'codex',
      '--json',
    ], { cwd: dir, env });
    assert.equal(acceptedReady.status, 0, acceptedReady.stderr);
    const accepted = runCli(['task', 'accept', acceptedRef, '--as', 'keshav', '--json'], { cwd: dir, env });
    assert.equal(accepted.status, 0, accepted.stderr);
    const acceptedPayload = JSON.parse(accepted.stdout);
    assert.equal(acceptedPayload.episode.review_landing.happened, 'Operators can now read the approval receipt without opening raw proof, saving time at the human gate.');
    assert.equal(acceptedPayload.episode.landing_quality.completeness, 1);
    assert.equal(acceptedPayload.episode.human_feedback.approval_status, 'accepted');
    const episodePath = path.join(dir, '.atris', 'state', 'task_episodes.jsonl');
    const episodeRows = fs.readFileSync(episodePath, 'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line));
    for (const row of episodeRows) {
      if (row.task_id !== acceptedPayload.task_id) continue;
      delete row.review_landing;
      delete row.landing_quality;
      delete row.human_feedback;
      if (row.rl) {
        delete row.rl.landing_completeness;
        delete row.rl.approval_status;
      }
    }
	    fs.writeFileSync(episodePath, `${episodeRows.map(row => JSON.stringify(row)).join('\n')}\n`, 'utf8');

    const revisedAdd = runCli(['task', 'add', 'Landing reworked task', '--tag', 'approval', '--json'], { cwd: dir, env });
    assert.equal(revisedAdd.status, 0, revisedAdd.stderr);
    const revisedRef = JSON.parse(revisedAdd.stdout).task.display_id;
    assert.equal(runCli(['task', 'claim', revisedRef, '--as', 'codex'], { cwd: dir, env }).status, 0);
    const revisedReady = runCli([
      'task', 'ready', revisedRef,
      '--proof', 'node --check test/commands.test.js passed but receipt was vague',
      '--happened', 'Operators can now inspect the updated result before approval, reducing the risk of accepting vague proof.',
      '--checked', 'I checked something.',
      '--tested', 'I ran tests.',
      '--decision', 'Accept if useful.',
      '--as', 'codex',
      '--json',
    ], { cwd: dir, env });
    assert.equal(revisedReady.status, 0, revisedReady.stderr);
    const revised = runCli(['task', 'revise', revisedRef, '--as', 'keshav', '--note', 'Decision line was too vague', '--json'], { cwd: dir, env });
    assert.equal(revised.status, 0, revised.stderr);
	    const revisedPayload = JSON.parse(revised.stdout);
	    assert.equal(revisedPayload.episode.rl.label, 'rework_requested');
	    assert.equal(revisedPayload.episode.review_landing.decision, 'Accept if useful.');
	    assert.equal(revisedPayload.episode.human_feedback.human_revision_note, 'Decision line was too vague');
	    const scorecardsPath = path.join(dir, '.atris', 'state', 'scorecards.jsonl');
	    const scorecardRows = fs.readFileSync(scorecardsPath, 'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line))
	      .filter(row => row.task_id !== acceptedPayload.task_id && row.task_id !== revisedPayload.task_id);
	    fs.writeFileSync(scorecardsPath, `${scorecardRows.map(row => JSON.stringify(row)).join('\n')}\n`, 'utf8');

	    const scorecard = runCli(['brain', 'scorecard', '--root', dir, '--verify', '--json'], { cwd: dir });
    assert.equal(scorecard.status, 0, scorecard.stderr);
    const payload = JSON.parse(scorecard.stdout);
    const acceptedCard = payload.scorecards.find(row => row.task_title === 'Landing accepted task');
    const revisedCard = payload.scorecards.find(row => row.task_title === 'Landing reworked task');
    assert.equal(acceptedCard.review_landing.happened, 'Operators can now read the approval receipt without opening raw proof.');
    assert.equal(acceptedCard.review_landing.reason, 'it saves time at the human gate.');
    assert.equal(acceptedCard.landing_quality.completeness, 1);
    assert.equal(acceptedCard.approval_status, 'accepted');
    assert.equal(acceptedCard.rl_label, 'accepted');
    assert.equal(revisedCard.review_landing.decision, 'Accept if useful.');
    assert.equal(revisedCard.human_feedback.human_revision_note, 'Decision line was too vague');
    assert.equal(revisedCard.approval_status, 'revise');
    assert.equal(revisedCard.rl_label, 'rework_requested');
  } finally {
    cleanupTempDir(dir);
  }
});

test('brain scorecard uses latest review episode per task', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1' };
  try {
    seedBrainWorkspace(dir);
    fs.rmSync(path.join(dir, '.atris', 'state', 'agent_mail.jsonl'), { force: true });

    const add = runCli(['task', 'add', 'Avoid duplicate task scorecards', '--json'], { cwd: dir, env });
    assert.equal(add.status, 0, add.stderr);
    const ref = JSON.parse(add.stdout).task.display_id;

    const done = runCli(['task', 'done', ref, '--proof', 'first validation passed'], { cwd: dir, env });
    assert.equal(done.status, 0, done.stderr);

    const review = runCli([
      'task', 'review', ref,
      '--reward', '5',
      '--lesson', 'Latest review is the task outcome',
      '--proof', 'final validation passed',
      '--next', 'Draft the Acme Co operator one-pager from the latest recap',
      '--as', 'codex',
    ], { cwd: dir, env });
    assert.equal(review.status, 0, review.stderr);

    const scorecard = runCli(['brain', 'scorecard', '--root', dir, '--verify', '--json'], { cwd: dir });
    assert.equal(scorecard.status, 0, scorecard.stderr);
    const payload = JSON.parse(scorecard.stdout);
    assert.equal(payload.taskEpisodes, 2);
    assert.equal(payload.written, 1);
    assert.equal(payload.scorecards[0].reward, 5);
    assert.equal(payload.scorecards[0].lesson, 'Latest review is the task outcome');
    assert.equal(payload.scorecards[0].proof, 'final validation passed');
    assert.equal(payload.scorecards[0].next_task_suggestion, 'Draft the Acme Co operator one-pager from the latest recap');

    fs.writeFileSync(path.join(dir, 'atris', 'TODO.md'), '# TODO\n\n## Backlog\n\n(empty)\n', 'utf8');
    const compile = runCli(['brain', 'compile', '--yes', '--root', dir, '--verify'], { cwd: dir });
    assert.equal(compile.status, 0, compile.stderr);
    assert.match(compile.stdout, /Draft the Acme Co operator one-pager from the latest recap/);
    assert.doesNotMatch(compile.stdout, /Run a business loop/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('brain scorecard uses primary checkout state from thin worktrees', () => {
  const dir = makeTempDir();
  let worktreePath;
  try {
    seedBrainWorkspace(dir);
    assert.equal(runGit(['init', '-q'], dir).status, 0);
    assert.equal(runGit(['config', 'user.email', 'test@example.com'], dir).status, 0);
    assert.equal(runGit(['config', 'user.name', 'Test User'], dir).status, 0);
    assert.equal(runGit(['add', '.'], dir).status, 0);
    assert.equal(runGit(['commit', '-qm', 'init'], dir).status, 0);

    worktreePath = path.join(dir, '..', `${path.basename(dir)}-brain-worktree`);
    assert.equal(runGit(['worktree', 'add', '-q', '--detach', worktreePath, 'HEAD'], dir).status, 0);

    const taskEpisodes = [
      {
        schema: 'atris.task_episode.v1',
        episode_id: 'episode-done',
        task_id: 'task-primary-state',
        created_at: '2026-06-01T00:00:00.000Z',
        state: { title: 'Score worktree brain state', tag: 'brain' },
        action: { actor: 'researcher', type: 'done' },
        reward: { value: 0, source: 'task_done' },
        proof: 'initial proof',
      },
      {
        schema: 'atris.task_episode.v1',
        episode_id: 'episode-review',
        task_id: 'task-primary-state',
        created_at: '2026-06-01T00:01:00.000Z',
        state: { title: 'Score worktree brain state', tag: 'brain' },
        action: { actor: 'validator', type: 'review' },
        reward: { value: 4, source: 'task_review' },
        lesson: 'Thin worktrees should read the primary state ledger.',
        proof: 'review proof',
        next_task_suggestion: 'Use the primary state root for brain reward signals',
      },
    ];
    fs.writeFileSync(
      path.join(dir, '.atris', 'state', 'task_episodes.jsonl'),
      taskEpisodes.map(row => JSON.stringify(row)).join('\n') + '\n',
      'utf8'
    );
    const localStateDir = path.join(worktreePath, '.atris', 'state');
    fs.mkdirSync(localStateDir, { recursive: true });
    fs.writeFileSync(
      path.join(localStateDir, 'task_episodes.jsonl'),
      [
        {
          schema: 'atris.task_episode.v1',
          episode_id: 'episode-local-duplicate',
          task_id: 'task-primary-state',
          created_at: '2026-06-01T00:02:00.000Z',
          state: { title: 'Score worktree brain state', tag: 'brain' },
          action: { actor: 'local', type: 'review' },
          reward: { value: 1, source: 'local_duplicate' },
          proof: 'stale local duplicate',
        },
        {
          schema: 'atris.task_episode.v1',
          episode_id: 'episode-local-review',
          task_id: 'task-local-state',
          created_at: '2026-06-01T00:03:00.000Z',
          state: { title: 'Score local worktree-only state', tag: 'brain' },
          action: { actor: 'local', type: 'review' },
          reward: { value: 3, source: 'task_review' },
          proof: 'local worktree proof',
        },
      ].map(row => JSON.stringify(row)).join('\n') + '\n',
      'utf8'
    );

    const scorecard = runCli(['brain', 'scorecard', '--root', worktreePath, '--verify', '--json'], { cwd: worktreePath });
    assert.equal(scorecard.status, 0, scorecard.stderr);
    const payload = JSON.parse(scorecard.stdout);
    assert.equal(fs.realpathSync(payload.stateRoot), fs.realpathSync(dir));
    assert.equal(payload.taskEpisodes, 4);
    assert.equal(payload.written, 2);
    assert.equal(payload.scorecards[0].source_episode_id, 'episode-review');
    assert.equal(payload.scorecards[0].reward, 4);
    assert.equal(payload.scorecards[1].source_episode_id, 'episode-local-review');
    assert.equal(payload.scorecards[1].reward, 3);
    assert.equal(payload.scorecards[0].workspace, 'demo-lab');

    assert.equal(fs.existsSync(path.join(dir, '.atris', 'state', 'scorecards.jsonl')), true);
    assert.equal(fs.existsSync(path.join(worktreePath, '.atris', 'state', 'scorecards.jsonl')), false);

    const compile = runCli(['brain', 'compile', '--yes', '--root', worktreePath, '--verify'], { cwd: worktreePath });
    assert.equal(compile.status, 0, compile.stderr);
    assert.match(compile.stdout, /State rows: 8 raw \/ 8 valid/);
    assert.doesNotMatch(compile.stdout, /Turn existing episode rows into the first scorecard/);

    const status = fs.readFileSync(path.join(worktreePath, 'atris', 'brain', 'STATUS.md'), 'utf8');
    assert.match(status, new RegExp(`State root: ${payload.stateRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\(primary checkout\\)`));
    const state = collectState(worktreePath);
    assert.equal(fs.realpathSync(state.stateRoot), fs.realpathSync(dir));
    assert.deepEqual(
      state.stateRoots.map(item => fs.realpathSync(item)),
      [fs.realpathSync(worktreePath), fs.realpathSync(dir)]
    );
    assert.equal(state.totalRows, 8);
  } finally {
    if (worktreePath) cleanupTempDir(worktreePath);
    cleanupTempDir(dir);
  }
});

test('brain compile rejects meta scorecard next suggestions', () => {
  const dir = makeTempDir();
  try {
    seedBrainWorkspace(dir);
    fs.rmSync(path.join(dir, '.atris', 'state', 'agent_mail.jsonl'), { force: true });
    fs.writeFileSync(path.join(dir, 'atris', 'TODO.md'), '# TODO\n\n## Backlog\n\n(empty)\n', 'utf8');

    fs.writeFileSync(path.join(dir, '.atris', 'state', 'episodes.jsonl'), JSON.stringify({
      schema: 'atris.brain.episode.v1',
      type: 'episode',
      ts: '2026-05-10T00:00:00.000Z',
      summary: 'previous business loop',
    }) + '\n', 'utf8');

    const metaSuggestion = 'Run the compiled business reward next task instead of repeating the completed business loop.';
    fs.writeFileSync(path.join(dir, '.atris', 'state', 'scorecards.jsonl'), JSON.stringify({
      schema: 'atris.brain.scorecard.v1',
      type: 'scorecard',
      ts: '2026-05-10T00:01:00.000Z',
      reward: 5,
      task_title: 'Previous business loop',
      next_task_suggestion: metaSuggestion,
    }) + '\n', 'utf8');

    const compile = runCli(['brain', 'compile', '--yes', '--root', dir, '--verify'], { cwd: dir });
    assert.equal(compile.status, 0, compile.stderr);
    assert.doesNotMatch(compile.stdout, /Run the compiled business reward next task/);
    assert.match(compile.stdout, /atris brain activate --member <name>/);
    assert.doesNotMatch(compile.stdout, /Run a business loop/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('brain compile rejects brain housekeeping next suggestions', () => {
  const dir = makeTempDir();
  try {
    seedBrainWorkspace(dir);
    fs.rmSync(path.join(dir, '.atris', 'state', 'agent_mail.jsonl'), { force: true });
    fs.writeFileSync(path.join(dir, 'atris', 'TODO.md'), '# TODO\n\n## Backlog\n\n(empty)\n', 'utf8');
    fs.writeFileSync(path.join(dir, '.atris', 'state', 'episodes.jsonl'), JSON.stringify({
      type: 'episode',
      ts: '2026-05-10T00:00:00.000Z',
    }) + '\n', 'utf8');

    const suggestion = 'Run brain scorecard and compile, then pick the next bounded verifier-backed mission step.';
    fs.writeFileSync(path.join(dir, '.atris', 'state', 'scorecards.jsonl'), JSON.stringify({
      type: 'scorecard',
      ts: '2026-05-10T00:01:00.000Z',
      reward: 5,
      next_task_suggestion: suggestion,
    }) + '\n', 'utf8');

    const compile = runCli(['brain', 'compile', '--yes', '--root', dir, '--verify'], { cwd: dir });
    assert.equal(compile.status, 0, compile.stderr);
    assert.doesNotMatch(compile.stdout, /Run brain scorecard and compile/);
    assert.match(compile.stdout, /atris brain activate --member <name>/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('brain compile rejects completion-audit next suggestions', () => {
  const dir = makeTempDir();
  try {
    seedBrainWorkspace(dir);
    fs.rmSync(path.join(dir, '.atris', 'state', 'agent_mail.jsonl'), { force: true });
    fs.writeFileSync(path.join(dir, 'atris', 'TODO.md'), '# TODO\n\n## Backlog\n\n(empty)\n', 'utf8');
    fs.writeFileSync(path.join(dir, '.atris', 'state', 'episodes.jsonl'), JSON.stringify({
      type: 'episode',
      ts: '2026-05-10T00:00:00.000Z',
    }) + '\n', 'utf8');

    const suggestion = 'Run one final completion audit across pull state, task queue, verifier, front-door signals, and dirty worktree before taking new work.';
    fs.writeFileSync(path.join(dir, '.atris', 'state', 'scorecards.jsonl'), JSON.stringify({
      type: 'scorecard',
      ts: '2026-05-10T00:01:00.000Z',
      reward: 5,
      next_task_suggestion: suggestion,
    }) + '\n', 'utf8');

    const compile = runCli(['brain', 'compile', '--yes', '--root', dir, '--verify'], { cwd: dir });
    assert.equal(compile.status, 0, compile.stderr);
    assert.doesNotMatch(compile.stdout, /Run one final completion audit/);
    assert.match(compile.stdout, /atris brain activate --member <name>/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('brain compile rejects process-work next suggestions', () => {
  const dir = makeTempDir();
  try {
    seedBrainWorkspace(dir);
    fs.rmSync(path.join(dir, '.atris', 'state', 'agent_mail.jsonl'), { force: true });
    fs.writeFileSync(path.join(dir, 'atris', 'TODO.md'), '# TODO\n\n## Backlog\n\n(empty)\n', 'utf8');
    fs.writeFileSync(path.join(dir, '.atris', 'state', 'episodes.jsonl'), JSON.stringify({
      type: 'episode',
      ts: '2026-05-10T00:00:00.000Z',
    }) + '\n', 'utf8');

    const suggestion = 'Activate the validator/reviewer path only when there is a new concrete artifact to review; otherwise stop creating process work.';
    fs.writeFileSync(path.join(dir, '.atris', 'state', 'scorecards.jsonl'), JSON.stringify({
      type: 'scorecard',
      ts: '2026-05-10T00:01:00.000Z',
      reward: 5,
      next_task_suggestion: suggestion,
    }) + '\n', 'utf8');

    const compile = runCli(['brain', 'compile', '--yes', '--root', dir, '--verify'], { cwd: dir });
    assert.equal(compile.status, 0, compile.stderr);
    assert.doesNotMatch(compile.stdout, /Activate the validator\/reviewer path/);
    assert.match(compile.stdout, /atris brain activate --member <name>/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('brain compile accepts concrete replace or retire next suggestions', () => {
  const dir = makeTempDir();
  try {
    seedBrainWorkspace(dir);
    fs.rmSync(path.join(dir, '.atris', 'state', 'agent_mail.jsonl'), { force: true });
    fs.writeFileSync(path.join(dir, 'atris', 'TODO.md'), '# TODO\n\n## Backlog\n\n(empty)\n', 'utf8');
    fs.writeFileSync(path.join(dir, '.atris', 'state', 'episodes.jsonl'), JSON.stringify({
      type: 'episode',
      ts: '2026-05-10T00:00:00.000Z',
    }) + '\n', 'utf8');

    const suggestion = 'Replace or retire placeholder member profiles before assigning them work';
    fs.writeFileSync(path.join(dir, '.atris', 'state', 'scorecards.jsonl'), JSON.stringify({
      type: 'scorecard',
      ts: '2026-05-10T00:01:00.000Z',
      reward: 5,
      next_task_suggestion: suggestion,
    }) + '\n', 'utf8');

    const compile = runCli(['brain', 'compile', '--yes', '--root', dir, '--verify'], { cwd: dir });
    assert.equal(compile.status, 0, compile.stderr);
    assert.match(compile.stdout, /Replace or retire placeholder member profiles before assigning them work/);
    assert.doesNotMatch(compile.stdout, /atris brain activate --member <name>/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('brain compile lets newer operator feedback supersede stale task next moves', () => {
  const dir = makeTempDir();
  try {
    seedBrainWorkspace(dir);
    fs.rmSync(path.join(dir, '.atris', 'state', 'agent_mail.jsonl'), { force: true });
    fs.writeFileSync(path.join(dir, 'atris', 'TODO.md'), '# TODO\n\n## Backlog\n\n(empty)\n', 'utf8');
    fs.writeFileSync(path.join(dir, '.atris', 'state', 'episodes.jsonl'), JSON.stringify({
      type: 'episode',
      ts: '2026-05-10T00:00:00.000Z',
    }) + '\n', 'utf8');

    const staleSuggestion = 'Run one final completion audit across pull state, task queue, verifier, front-door signals, and dirty worktree before taking new work.';
    fs.writeFileSync(path.join(dir, '.atris', 'state', 'scorecards.jsonl'), [
      JSON.stringify({
        type: 'scorecard',
        ts: '2026-05-10T00:01:00.000Z',
        reward: 5,
        next_task_suggestion: staleSuggestion,
      }),
      JSON.stringify({
        schema: 'atris.brain.scorecard.v1',
        ts: '2026-05-10T00:02:00.000Z',
        recommendation: staleSuggestion,
        human_rating: 'approve',
        human_note: 'Audit completed with verifier proof.',
        reward: 1,
        source: 'operator_feedback',
      }),
      '',
    ].join('\n'), 'utf8');

    const compile = runCli(['brain', 'compile', '--yes', '--root', dir, '--verify'], { cwd: dir });
    assert.equal(compile.status, 0, compile.stderr);
    assert.doesNotMatch(compile.stdout, /Run one final completion audit/);
    assert.match(compile.stdout, /atris brain activate --member <name>/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('brain activate prints a mission card from the compiled brain', () => {
  const dir = makeTempDir();
  try {
    seedBrainWorkspace(dir);
    const res = runCli(['brain', 'activate', '--yes', '--root', dir, '--verify'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /CONTEXT: Demo Lab Brain/);
    assert.match(res.stdout, /OPERATOR: unknown/);
    assert.match(res.stdout, /NEXT MOVE: Tell Atris who is operating/);
    assert.match(res.stdout, /PROOF: Activation re-runs with a known operator/);
    assert.match(res.stdout, /FEEDBACK: yes \/ edit \/ no/);
    assert.match(res.stdout, /VERIFY: brain artifacts present/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('brain activate can target a member and print their next work block', () => {
  const dir = makeTempDir();
  try {
    seedBrainWorkspace(dir);
    runCli(['brain', 'compile', '--yes', '--root', dir, '--verify'], { cwd: dir });
    const res = runCli(['brain', 'activate', '--yes', '--member', 'justin', '--root', dir, '--verify'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /CONTEXT: Demo Lab Brain/);
    assert.match(res.stdout, /OPERATOR: Justin McDonald/);
    assert.match(res.stdout, /NEXT MOVE: Justin McDonald: run one customer-moving GTM rep/);
    assert.match(res.stdout, /FEEDBACK: yes \/ edit \/ no/);
    const remembered = JSON.parse(fs.readFileSync(path.join(dir, '.atris', 'state', 'operator.json'), 'utf8'));
    assert.equal(remembered.member, 'justin');
  } finally {
    cleanupTempDir(dir);
  }
});

test('brain activate --verify fails with a missing member setup card instead of scorecard next move', () => {
  const dir = makeTempDir();
  try {
    seedBrainWorkspace(dir);
    fs.rmSync(path.join(dir, '.atris', 'state', 'agent_mail.jsonl'), { force: true });
    fs.writeFileSync(path.join(dir, 'atris', 'TODO.md'), '# TODO\n\n## Backlog\n\n(empty)\n', 'utf8');
    fs.writeFileSync(path.join(dir, '.atris', 'state', 'episodes.jsonl'), JSON.stringify({
      type: 'episode',
      ts: '2026-05-10T00:00:00.000Z',
    }) + '\n', 'utf8');
    fs.writeFileSync(path.join(dir, '.atris', 'state', 'scorecards.jsonl'), JSON.stringify({
      type: 'scorecard',
      ts: '2026-05-10T00:01:00.000Z',
      reward: 5,
      next_task_suggestion: 'Draft the customer one-pager from the latest recap',
    }) + '\n', 'utf8');

    const res = runCli(['brain', 'activate', '--yes', '--member', 'missing-one', '--root', dir, '--verify'], { cwd: dir });
    assert.notEqual(res.status, 0);
    assert.match(res.stdout, /OPERATOR: missing-one \(missing\)/);
    assert.match(res.stdout, /NEXT MOVE: Create atris\/team\/missing-one\/MEMBER\.md or rerun with an existing member/);
    assert.match(res.stdout, /AVAILABLE MEMBERS: justin, keshav/);
    assert.doesNotMatch(res.stdout, /Draft the customer one-pager/);
    assert.match(res.stderr, /brain activate non-executable member activation card: missing-one \(missing\)/);
    assert.doesNotMatch(res.stderr, /at verifyActivationCard|Node\.js/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('brain activate --json --verify returns machine-readable readiness failures', () => {
  const dir = makeTempDir();
  try {
    seedBrainWorkspace(dir);

    const missing = runCli(['brain', 'activate', '--yes', '--member', 'missing-one', '--root', dir, '--verify', '--json'], { cwd: dir });
    assert.notEqual(missing.status, 0);
    assert.equal(missing.stderr, '');
    const missingBody = JSON.parse(missing.stdout);
    assert.equal(missingBody.ok, false);
    assert.match(missingBody.error, /brain activate non-executable member activation card: missing-one \(missing\)/);
    assert.match(missingBody.card, /OPERATOR: missing-one \(missing\)/);
    assert.match(missingBody.card, /AVAILABLE MEMBERS: justin, keshav/);

    const memberDir = path.join(dir, 'atris', 'team', 'placeholder');
    fs.mkdirSync(memberDir, { recursive: true });
    fs.writeFileSync(path.join(memberDir, 'MEMBER.md'), [
      '# Placeholder Member',
      '',
      '## Persona',
      '',
      '(Define how this member communicates, their tone, and decision-making style)',
      '',
    ].join('\n'), 'utf8');

    const notReady = runCli(['brain', 'activate', '--yes', '--member', 'placeholder', '--root', dir, '--verify', '--json'], { cwd: dir });
    assert.notEqual(notReady.status, 0);
    assert.equal(notReady.stderr, '');
    const notReadyBody = JSON.parse(notReady.stdout);
    assert.equal(notReadyBody.ok, false);
    assert.match(notReadyBody.error, /brain activate non-executable member activation card: Placeholder Member \(not ready\)/);
    assert.match(notReadyBody.card, /PROFILE ISSUES: persona is still template text/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('brain activate --verify fails with a placeholder member readiness card', () => {
  const dir = makeTempDir();
  try {
    seedBrainWorkspace(dir);
    const memberDir = path.join(dir, 'atris', 'team', 'placeholder');
    fs.mkdirSync(memberDir, { recursive: true });
    fs.writeFileSync(path.join(memberDir, 'MEMBER.md'), [
      '# Placeholder Member',
      '',
      '## Persona',
      '',
      '(Define how this member communicates, their tone, and decision-making style)',
      '',
      '## Workflow',
      '',
      '1. Step one',
      '',
      '## Rules',
      '',
      '1. Rule one',
      '',
    ].join('\n'), 'utf8');

    const res = runCli(['brain', 'activate', '--yes', '--member', 'placeholder', '--root', dir, '--verify'], { cwd: dir });
    assert.notEqual(res.status, 0);
    assert.match(res.stdout, /OPERATOR: Placeholder Member \(not ready\)/);
    assert.match(res.stdout, /NEXT MOVE: Replace placeholder sections in atris\/team\/placeholder\/MEMBER\.md/);
    assert.match(res.stdout, /PROFILE ISSUES: persona is still template text; workflow is still template text; rules are still template text/);
    assert.doesNotMatch(res.stdout, /use your START_HERE/);
    assert.match(res.stderr, /brain activate non-executable member activation card: Placeholder Member \(not ready\)/);
    assert.doesNotMatch(res.stderr, /at verifyActivationCard|Node\.js/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('brain activate --verify fails with a member missing START_HERE readiness card', () => {
  const dir = makeTempDir();
  try {
    seedBrainWorkspace(dir);
    const memberDir = path.join(dir, 'atris', 'team', 'executor');
    fs.mkdirSync(memberDir, { recursive: true });
    fs.writeFileSync(path.join(memberDir, 'MEMBER.md'), '# Executor\n\nBuilder with real workflow text.\n', 'utf8');

    const res = runCli(['brain', 'activate', '--yes', '--member', 'executor', '--root', dir, '--verify'], { cwd: dir });
    assert.notEqual(res.status, 0);
    assert.match(res.stdout, /OPERATOR: Executor \(not ready\)/);
    assert.match(res.stdout, /NEXT MOVE: Create atris\/team\/executor\/START_HERE\.md/);
    assert.match(res.stdout, /first concrete work block, verifier, and proof target/);
    assert.doesNotMatch(res.stdout, /use your START_HERE/);
    assert.match(res.stderr, /brain activate non-executable member activation card: Executor \(not ready\)/);
    assert.doesNotMatch(res.stderr, /at verifyActivationCard|Node\.js/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('brain activate routes validator members to concrete review work', () => {
  const dir = makeTempDir();
  try {
    seedBrainWorkspace(dir);
    const memberDir = path.join(dir, 'atris', 'team', 'validator');
    fs.mkdirSync(memberDir, { recursive: true });
    fs.writeFileSync(path.join(memberDir, 'MEMBER.md'), '# Validator — Reviewer\n\nValidates execution and blocks weak proof.\n', 'utf8');
    fs.writeFileSync(path.join(memberDir, 'START_HERE.md'), 'Review the highest-risk task and name residual risk.\n', 'utf8');

    const res = runCli(['brain', 'activate', '--yes', '--member', 'validator', '--root', dir, '--verify'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Validator — Reviewer: review the highest-risk open or recently completed task/);
    assert.match(res.stdout, /name residual risk/);
    assert.doesNotMatch(res.stdout, /\(not ready\)/);
    assert.doesNotMatch(res.stdout, /use your START_HERE/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('brain activate routes validator away from fake review work when nothing is reviewable', () => {
  const dir = makeTempDir();
  try {
    seedBrainWorkspace(dir);
    fs.writeFileSync(path.join(dir, 'atris', 'TODO.md'), '# TODO\n\n## Backlog\n\n(empty)\n', 'utf8');
    const memberDir = path.join(dir, 'atris', 'team', 'validator');
    fs.mkdirSync(memberDir, { recursive: true });
    fs.writeFileSync(path.join(memberDir, 'MEMBER.md'), '# Validator — Reviewer\n\nValidates execution and blocks weak proof.\n', 'utf8');
    fs.writeFileSync(path.join(memberDir, 'START_HERE.md'), 'Review the highest-risk task and name residual risk.\n', 'utf8');

    const res = runCli(['brain', 'activate', '--yes', '--member', 'validator', '--root', dir, '--verify'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Validator — Reviewer: wait for one concrete artifact or ask Navigator to create a reviewable task/);
    assert.doesNotMatch(res.stdout, /review the highest-risk open or recently completed task/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('brain activate routes executor members to concrete build work', () => {
  const dir = makeTempDir();
  try {
    seedBrainWorkspace(dir);
    const memberDir = path.join(dir, 'atris', 'team', 'executor');
    fs.mkdirSync(memberDir, { recursive: true });
    fs.writeFileSync(path.join(memberDir, 'MEMBER.md'), '# Executor — Builder\n\nBuilds scoped tasks from proof targets.\n', 'utf8');
    fs.writeFileSync(path.join(memberDir, 'START_HERE.md'), 'Execute one scoped patch and run the verifier.\n', 'utf8');

    const res = runCli(['brain', 'activate', '--yes', '--member', 'executor', '--root', dir, '--verify'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Executor — Builder: execute the highest-leverage claimed task one scoped step at a time/);
    assert.match(res.stdout, /hand off proof for review/);
    assert.doesNotMatch(res.stdout, /\(not ready\)/);
    assert.doesNotMatch(res.stdout, /use your START_HERE/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('brain activate routes executor away from fake build work when no task is open', () => {
  const dir = makeTempDir();
  try {
    seedBrainWorkspace(dir);
    fs.writeFileSync(path.join(dir, 'atris', 'TODO.md'), '# TODO\n\n## Backlog\n\n(empty)\n', 'utf8');
    const memberDir = path.join(dir, 'atris', 'team', 'executor');
    fs.mkdirSync(memberDir, { recursive: true });
    fs.writeFileSync(path.join(memberDir, 'MEMBER.md'), '# Executor — Builder\n\nBuilds scoped tasks from proof targets.\n', 'utf8');
    fs.writeFileSync(path.join(memberDir, 'START_HERE.md'), 'Execute one scoped patch and run the verifier.\n', 'utf8');

    const res = runCli(['brain', 'activate', '--yes', '--member', 'executor', '--root', dir, '--verify'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Executor — Builder: ask Navigator to create one bounded task with files, verifier, and stop rule before making a patch/);
    assert.doesNotMatch(res.stdout, /execute the highest-leverage claimed task/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('brain activate routes executor to certified review before creating work', () => {
  const dir = makeTempDir();
  try {
    seedBrainWorkspace(dir);
    fs.writeFileSync(path.join(dir, 'atris', 'TODO.md'), '# TODO\n\n## Backlog\n\n(empty)\n', 'utf8');
    fs.writeFileSync(path.join(dir, '.atris', 'state', 'tasks.projection.json'), JSON.stringify({
      tasks: [
        {
          display_id: 'CLI-9',
          title: 'Certified checkpoint',
          status: 'review',
          metadata: {
            agent_certified: true,
            agent_review_pass_count: 2,
          },
        },
      ],
    }), 'utf8');
    const memberDir = path.join(dir, 'atris', 'team', 'executor');
    fs.mkdirSync(memberDir, { recursive: true });
    fs.writeFileSync(path.join(memberDir, 'MEMBER.md'), '# Executor — Builder\n\nBuilds scoped tasks from proof targets.\n', 'utf8');
    fs.writeFileSync(path.join(memberDir, 'START_HERE.md'), 'Execute one scoped patch and run the verifier.\n', 'utf8');

    const res = runCli(['brain', 'activate', '--yes', '--member', 'executor', '--root', dir, '--verify'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Executor — Builder: hand off certified review CLI-9 to the operator/);
    assert.match(res.stdout, /atris task accept CLI-9/);
    assert.match(res.stdout, /atris task revise CLI-9 --note "<what must change>"/);
    assert.doesNotMatch(res.stdout, /ask Navigator to create one bounded task/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('brain activate lets codex executor continue when review is human-only', () => {
  const dir = makeTempDir();
  try {
    seedBrainWorkspace(dir);
    fs.writeFileSync(path.join(dir, 'atris', 'TODO.md'), [
      '# TODO',
      '',
      '## Endgame',
      '',
      '**Slug:** runner-swap-safe',
      '**Horizon:** runner swaps should be config-only, not overnight outages',
      '',
      '## Backlog',
      '',
      '(empty)',
      '',
    ].join('\n'), 'utf8');
    fs.writeFileSync(path.join(dir, '.atris', 'state', 'tasks.projection.json'), JSON.stringify({
      tasks: [
        {
          display_id: 'CLI-9',
          title: 'Certified checkpoint',
          status: 'review',
          metadata: {
            approval_status: 'pending',
            agent_certified: true,
            agent_review_pass_count: 2,
          },
        },
      ],
    }), 'utf8');
    const memberDir = path.join(dir, 'atris', 'team', 'codex-executor');
    fs.mkdirSync(memberDir, { recursive: true });
    fs.writeFileSync(path.join(memberDir, 'MEMBER.md'), '# Codex Executor — Builder\n\nBuilds scoped tasks from proof targets.\n', 'utf8');
    fs.writeFileSync(path.join(memberDir, 'START_HERE.md'), 'Execute one scoped patch and run the verifier.\n', 'utf8');

    const res = runCli(['brain', 'activate', '--yes', '--member', 'codex-executor', '--root', dir, '--verify'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Codex Executor — Builder: certified reviews CLI-9 are human-only/);
    assert.match(res.stdout, /Create the next bounded Codex task from Endgame runner-swap-safe/);
    assert.match(res.stdout, /runner swaps should be config-only/);
    assert.match(res.stdout, /do not accept XP/);
    assert.doesNotMatch(res.stdout, /atris task accept CLI-9/);
    assert.doesNotMatch(res.stdout, /do not create new work until this checkpoint is clear/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('brain activate routes executor to agent-safe review before human accept rows', () => {
  const dir = makeTempDir();
  try {
    seedBrainWorkspace(dir);
    fs.writeFileSync(path.join(dir, 'atris', 'TODO.md'), '# TODO\n\n## Backlog\n\n(empty)\n', 'utf8');
    fs.writeFileSync(path.join(dir, '.atris', 'state', 'tasks.projection.json'), JSON.stringify({
      tasks: [
        {
          display_id: 'CLI-8',
          title: 'Needs agent review',
          status: 'review',
          metadata: {
            approval_status: 'pending',
            agent_review_pass_count: 1,
          },
        },
        {
          display_id: 'CLI-9',
          title: 'Certified checkpoint',
          status: 'review',
          metadata: {
            approval_status: 'pending',
            agent_certified: true,
            agent_review_pass_count: 2,
          },
        },
      ],
    }), 'utf8');
    const memberDir = path.join(dir, 'atris', 'team', 'executor');
    fs.mkdirSync(memberDir, { recursive: true });
    fs.writeFileSync(path.join(memberDir, 'MEMBER.md'), '# Executor — Builder\n\nBuilds scoped tasks from proof targets.\n', 'utf8');
    fs.writeFileSync(path.join(memberDir, 'START_HERE.md'), 'Execute one scoped patch and run the verifier.\n', 'utf8');

    const res = runCli(['brain', 'activate', '--yes', '--member', 'executor', '--root', dir, '--verify'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Executor — Builder: run the agent-safe review lane for CLI-8/);
    assert.match(res.stdout, /atris task review-chat CLI-8 --as codex-review/);
    assert.doesNotMatch(res.stdout, /hand off certified review CLI-9/);
    assert.doesNotMatch(res.stdout, /atris task accept CLI-9/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('brain activate routes navigator members to concrete planning work', () => {
  const dir = makeTempDir();
  try {
    seedBrainWorkspace(dir);
    const memberDir = path.join(dir, 'atris', 'team', 'navigator');
    fs.mkdirSync(memberDir, { recursive: true });
    fs.writeFileSync(path.join(memberDir, 'MEMBER.md'), '# Navigator — Planner\n\nPlans scoped work from MAP evidence.\n', 'utf8');
    fs.writeFileSync(path.join(memberDir, 'START_HERE.md'), 'Plan one scoped task with files, exit, verify, and rollback.\n', 'utf8');

    const res = runCli(['brain', 'activate', '--yes', '--member', 'navigator', '--root', dir, '--verify'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Navigator — Planner: turn one messy or unclaimed intent into a MAP-backed plan/);
    assert.match(res.stdout, /review-ready task/);
    assert.doesNotMatch(res.stdout, /\(not ready\)/);
    assert.doesNotMatch(res.stdout, /use your START_HERE/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('brain activate routes launcher members to concrete closeout work', () => {
  const dir = makeTempDir();
  try {
    seedBrainWorkspace(dir);
    fs.writeFileSync(path.join(dir, 'atris', 'TODO.md'), [
      '# TODO.md',
      '',
      '## Completed',
      '',
      '- **[CLI-1]** Completed task [brain]',
      '',
    ].join('\n'), 'utf8');
    const memberDir = path.join(dir, 'atris', 'team', 'launcher');
    fs.mkdirSync(memberDir, { recursive: true });
    fs.writeFileSync(path.join(memberDir, 'MEMBER.md'), '# Launcher — The Closer\n\nCloses validated work into release notes and proof.\n', 'utf8');
    fs.writeFileSync(path.join(memberDir, 'START_HERE.md'), 'Close one validated task into release-ready proof.\n', 'utf8');

    const res = runCli(['brain', 'activate', '--yes', '--member', 'launcher', '--root', dir, '--verify'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Launcher — The Closer: close one validated task into release-ready proof/);
    assert.match(res.stdout, /name the publish step/);
    assert.doesNotMatch(res.stdout, /\(not ready\)/);
    assert.doesNotMatch(res.stdout, /use your START_HERE/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('brain activate routes launcher away from fake closeout work when no task receipt exists', () => {
  const dir = makeTempDir();
  try {
    seedBrainWorkspace(dir);
    fs.writeFileSync(path.join(dir, 'atris', 'TODO.md'), '# TODO\n\n## Backlog\n\n(empty)\n', 'utf8');
    const memberDir = path.join(dir, 'atris', 'team', 'launcher');
    fs.mkdirSync(memberDir, { recursive: true });
    fs.writeFileSync(path.join(memberDir, 'MEMBER.md'), '# Launcher — The Closer\n\nCloses validated work into release notes and proof.\n', 'utf8');
    fs.writeFileSync(path.join(memberDir, 'START_HERE.md'), 'Close one validated task into release-ready proof.\n', 'utf8');

    const res = runCli(['brain', 'activate', '--yes', '--member', 'launcher', '--root', dir, '--verify'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Launcher — The Closer: wait for one validated task receipt before closeout/);
    assert.doesNotMatch(res.stdout, /close one validated task into release-ready proof/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('brain activate routes launcher to certified review before closeout fallback', () => {
  const dir = makeTempDir();
  try {
    seedBrainWorkspace(dir);
    fs.writeFileSync(path.join(dir, 'atris', 'TODO.md'), '# TODO\n\n## Backlog\n\n(empty)\n', 'utf8');
    fs.writeFileSync(path.join(dir, '.atris', 'state', 'tasks.projection.json'), JSON.stringify({
      tasks: [
        {
          display_id: 'CLI-10',
          title: 'Certified launch checkpoint',
          status: 'review',
          review: {
            agent_certified: true,
            agent_review_pass_count: 2,
          },
        },
      ],
    }), 'utf8');
    const memberDir = path.join(dir, 'atris', 'team', 'launcher');
    fs.mkdirSync(memberDir, { recursive: true });
    fs.writeFileSync(path.join(memberDir, 'MEMBER.md'), '# Launcher — The Closer\n\nCloses validated work into release notes and proof.\n', 'utf8');
    fs.writeFileSync(path.join(memberDir, 'START_HERE.md'), 'Close one validated task into release-ready proof.\n', 'utf8');

    const res = runCli(['brain', 'activate', '--yes', '--member', 'launcher', '--root', dir, '--verify'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Launcher — The Closer: hand off certified review CLI-10 to the operator/);
    assert.match(res.stdout, /atris task accept CLI-10/);
    assert.doesNotMatch(res.stdout, /wait for one validated task receipt before closeout/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('brain activate routes brainstormer members to concrete idea-shaping work', () => {
  const dir = makeTempDir();
  try {
    seedBrainWorkspace(dir);
    const memberDir = path.join(dir, 'atris', 'team', 'brainstormer');
    fs.mkdirSync(memberDir, { recursive: true });
    fs.writeFileSync(path.join(memberDir, 'MEMBER.md'), '# Brainstormer — Idea & Reality Shaper\n\nShapes raw ideas before planning.\n', 'utf8');
    fs.writeFileSync(path.join(memberDir, 'START_HERE.md'), 'Shape one raw idea into a navigator-ready vision.\n', 'utf8');

    const res = runCli(['brain', 'activate', '--yes', '--member', 'brainstormer', '--root', dir, '--verify'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Brainstormer — Idea & Reality Shaper: shape one raw idea into a concise vision/);
    assert.match(res.stdout, /navigator-ready next step/);
    assert.doesNotMatch(res.stdout, /\(not ready\)/);
    assert.doesNotMatch(res.stdout, /use your START_HERE/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('brain activate routes researcher members to concrete research work', () => {
  const dir = makeTempDir();
  try {
    seedBrainWorkspace(dir);
    const memberDir = path.join(dir, 'atris', 'team', 'researcher');
    fs.mkdirSync(memberDir, { recursive: true });
    fs.writeFileSync(path.join(memberDir, 'MEMBER.md'), '# Researcher — Deep Researcher\n\nFinds primary-source truth.\n', 'utf8');
    fs.writeFileSync(path.join(memberDir, 'START_HERE.md'), 'Answer one explicit research question with sources.\n', 'utf8');

    const res = runCli(['brain', 'activate', '--yes', '--member', 'researcher', '--root', dir, '--verify'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Researcher — Deep Researcher: answer one explicit research question with primary sources/);
    assert.match(res.stdout, /unverified gaps/);
    assert.doesNotMatch(res.stdout, /\(not ready\)/);
    assert.doesNotMatch(res.stdout, /use your START_HERE/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('brain activate routes mission and overnight members to concrete work blocks', () => {
  const dir = makeTempDir();
  try {
    seedBrainWorkspace(dir);
    const missionDir = path.join(dir, 'atris', 'team', 'mission-lead');
    fs.mkdirSync(missionDir, { recursive: true });
    fs.writeFileSync(path.join(missionDir, 'MEMBER.md'), '# Mission Lead\n\nCoordinates bounded mission ticks.\n', 'utf8');
    fs.writeFileSync(path.join(missionDir, 'START_HERE.md'), 'Pick one bounded mission step with a verifier and proof target.\n', 'utf8');

    const opusDir = path.join(dir, 'atris', 'team', 'opus-overnight');
    fs.mkdirSync(opusDir, { recursive: true });
    fs.writeFileSync(path.join(opusDir, 'MEMBER.md'), '# Opus Overnight Worker\n\nRuns the rl-exp2 loop without spending money.\n', 'utf8');
    fs.writeFileSync(path.join(opusDir, 'START_HERE.md'), 'Pick the next zero-spend rl-exp2 tick and name the 1% delta.\n', 'utf8');

    const mission = runCli(['brain', 'activate', '--yes', '--member', 'mission-lead', '--root', dir, '--verify'], { cwd: dir });
    assert.equal(mission.status, 0, mission.stderr);
    assert.match(mission.stdout, /Mission Lead: choose or create one bounded mission step, run its verifier/);

    const opus = runCli(['brain', 'activate', '--yes', '--member', 'opus-overnight', '--root', dir, '--verify'], { cwd: dir });
    assert.equal(opus.status, 0, opus.stderr);
    assert.match(opus.stdout, /Opus Overnight Worker: run the next zero-spend `rl-exp2` tick/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('brain activate remembers the last operator after the first member run', () => {
  const dir = makeTempDir();
  try {
    seedBrainWorkspace(dir);
    runCli(['brain', 'activate', '--yes', '--member', 'justin', '--root', dir, '--verify'], { cwd: dir });
    const res = runCli(['brain', 'activate', '--yes', '--root', dir, '--verify'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /OPERATOR: Justin McDonald/);
    assert.match(res.stdout, /NEXT MOVE: Justin McDonald: run one customer-moving GTM rep/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('brain gallery previews activation cards for every team member', () => {
  const dir = makeTempDir();
  try {
    seedBrainWorkspace(dir);
    const res = runCli(['brain', 'gallery', '--yes', '--root', dir, '--verify'], { cwd: dir, env: { ATRIS_OPERATOR: 'keshav' } });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /OPERATOR: Justin McDonald/);
    assert.match(res.stdout, /OPERATOR: Keshav Rao/);
    assert.match(res.stdout, /Justin McDonald: run one customer-moving GTM rep/);
    assert.match(res.stdout, /Keshav Rao: act as Customer 0/);
    assert.match(res.stdout, /---/);
    assert.match(res.stdout, /VERIFY: brain artifacts and member readiness present/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('brain activation does not treat a generic operator member as the owner', () => {
  const dir = makeTempDir();
  try {
    seedBrainWorkspace(dir);
    const memberDir = path.join(dir, 'atris', 'team', 'operator');
    fs.mkdirSync(memberDir, { recursive: true });
    fs.writeFileSync(path.join(memberDir, 'MEMBER.md'), '# Operator\n\nBusiness operator\n');
    fs.writeFileSync(path.join(memberDir, 'START_HERE.md'), '# Start Here\n\nRun the business loop.\n');
    const result = runCli(['brain', 'activate', '--yes', '--member', 'operator', '--root', dir], {
      cwd: dir,
      env: { ATRIS_OPERATOR: 'alex' },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /Operator: act as Customer 0/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('brain gallery does not overwrite the remembered operator', () => {
  const dir = makeTempDir();
  try {
    seedBrainWorkspace(dir);
    const operatorPath = path.join(dir, '.atris', 'state', 'operator.json');
    const activate = runCli(['brain', 'activate', '--yes', '--member', 'justin', '--root', dir, '--verify'], { cwd: dir });
    assert.equal(activate.status, 0, activate.stderr);
    assert.equal(JSON.parse(fs.readFileSync(operatorPath, 'utf8')).member, 'justin');

    const res = runCli(['brain', 'gallery', '--yes', '--root', dir, '--verify'], { cwd: dir, env: { ATRIS_OPERATOR: 'keshav' } });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /OPERATOR: Keshav Rao/);
    assert.equal(JSON.parse(fs.readFileSync(operatorPath, 'utf8')).member, 'justin');
  } finally {
    cleanupTempDir(dir);
  }
});

test('brain gallery --verify fails on not-ready member cards', () => {
  const dir = makeTempDir();
  try {
    seedBrainWorkspace(dir);
    const memberDir = path.join(dir, 'atris', 'team', 'executor');
    fs.mkdirSync(memberDir, { recursive: true });
    fs.writeFileSync(path.join(memberDir, 'MEMBER.md'), '# Executor\n\nBuilder with real workflow text.\n', 'utf8');

    const res = runCli(['brain', 'gallery', '--yes', '--root', dir, '--verify'], { cwd: dir });
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /brain gallery not-ready member activation cards: Executor/);
    assert.doesNotMatch(res.stderr, /at verifyActivationGallery|Node\.js/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('brain gallery --json --verify returns machine-readable readiness failures', () => {
  const dir = makeTempDir();
  try {
    seedBrainWorkspace(dir);
    const memberDir = path.join(dir, 'atris', 'team', 'executor');
    fs.mkdirSync(memberDir, { recursive: true });
    fs.writeFileSync(path.join(memberDir, 'MEMBER.md'), '# Executor\n\nBuilder with real workflow text.\n', 'utf8');

    const res = runCli(['brain', 'gallery', '--yes', '--root', dir, '--verify', '--json'], { cwd: dir });
    assert.notEqual(res.status, 0);
    assert.equal(res.stderr, '');
    const body = JSON.parse(res.stdout);
    assert.equal(body.ok, false);
    assert.match(body.error, /brain gallery not-ready member activation cards: Executor \(not ready\)/);
    assert.deepEqual(body.members, ['executor', 'justin', 'keshav']);
    assert.match(body.gallery, /OPERATOR: Executor \(not ready\)/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('brain activate shows Keshav Customer 0 score context when present', () => {
  const dir = makeTempDir();
  try {
    seedBrainWorkspace(dir);
    fs.mkdirSync(path.join(dir, 'atris', 'state'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'atris', 'state', 'contribution-score.md'), `# Contribution Score

| Operator | Mode | Visible score signal | Current signal | Needed to count today |
|---|---|---|---|---|
| Keshav | Customer 0 / system leverage | Level 1: Customer 0 loop started | Member surface defines the first-run loop | Close one receipt with proof and next owner |

## Keshav Profile Scoring Contract

Source profile: atris/team/keshav/MEMBER.md

## Keshav Customer 0 Card

\`\`\`text
operator: Keshav
current_score_signal: Level 1 - Customer 0 loop started
why: member identity, first screen, and score surface agree
next_rep: log one receipt with evidence and next owner
proof_needed: leave a receipt in contribution-score
\`\`\`
`, 'utf8');
    const res = runCli(['brain', 'activate', '--yes', '--member', 'keshav', '--root', dir, '--verify'], { cwd: dir, env: { ATRIS_OPERATOR: 'keshav' } });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /OPERATOR: Keshav Rao/);
    assert.match(res.stdout, /NEXT MOVE: Keshav Rao: act as Customer 0/);
    assert.match(res.stdout, /SCORE: Level 1 - Customer 0 loop started/);
    assert.match(res.stdout, /NEXT REP: log one receipt with evidence and next owner/);
    assert.match(res.stdout, /PROOF: leave a receipt in contribution-score/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('brain activate supports founder lab mode for Keshav', () => {
  const dir = makeTempDir();
  try {
    seedBrainWorkspace(dir);
    const res = runCli([
      'brain', 'activate',
      '--member', 'keshav',
      '--mode', 'founder-lab',
      '--root', dir,
      '--verify',
      '--yes',
    ], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /OPERATOR: Keshav Rao/);
    assert.match(res.stdout, /MODE: founder lab/);
    assert.match(res.stdout, /crazy company idea/);
    assert.match(res.stdout, /customer wedge hypothesis/);
    assert.match(res.stdout, /delegated next action/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('brain feedback appends linked scorecard and episode rows', () => {
  const dir = makeTempDir();
  try {
    seedBrainWorkspace(dir);
    runCli(['brain', 'compile', '--yes', '--root', dir, '--verify'], { cwd: dir });
    const res = runCli([
      'brain', 'feedback',
      '--root', dir,
      '--rating', 'edit',
      '--recommendation', 'Send the customer follow-up',
      '--note', 'Tone was right, pricing was stale',
      '--verify',
    ], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Atris brain feedback recorded/);

    const scorecard = JSON.parse(fs.readFileSync(path.join(dir, '.atris', 'state', 'scorecards.jsonl'), 'utf8').trim());
    const episode = JSON.parse(fs.readFileSync(path.join(dir, '.atris', 'state', 'episodes.jsonl'), 'utf8').trim());
    assert.equal(scorecard.human_rating, 'edit');
    assert.equal(scorecard.reward, 0.5);
    assert.equal(episode.episode_id, scorecard.decision_id);
    assert.equal(episode.feedback.note, 'Tone was right, pricing was stale');
  } finally {
    cleanupTempDir(dir);
  }
});

test('brain yes records approval with a plain note', () => {
  const dir = makeTempDir();
  try {
    seedBrainWorkspace(dir);
    runCli(['brain', 'compile', '--yes', '--root', dir, '--verify'], { cwd: dir });
    const res = runCli([
      'brain', 'yes',
      'ship the simple version',
      '--root', dir,
      '--verify',
    ], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Rating: approve/);
    assert.match(res.stdout, /Next: atris brain compile/);

    const scorecard = JSON.parse(fs.readFileSync(path.join(dir, '.atris', 'state', 'scorecards.jsonl'), 'utf8').trim());
    assert.equal(scorecard.human_rating, 'approve');
    assert.equal(scorecard.human_note, 'ship the simple version');
    assert.equal(scorecard.reward, 1);
  } finally {
    cleanupTempDir(dir);
  }
});

test('brain go records an approval row without writing feedback rows', () => {
  const dir = makeTempDir();
  try {
    seedBrainWorkspace(dir);
    runCli(['brain', 'compile', '--yes', '--root', dir, '--verify'], { cwd: dir });
    const res = runCli([
      'brain', 'go',
      'proceed with contract engineering unblock',
      '--root', dir,
      '--recommendation', 'Justin: unblock contract engineering',
      '--verify',
    ], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Atris brain approval recorded/);
    assert.match(res.stdout, /Decision: go/);
    assert.match(res.stdout, /Status: approved_to_proceed/);

    const approval = JSON.parse(fs.readFileSync(path.join(dir, '.atris', 'state', 'approvals.jsonl'), 'utf8').trim());
    assert.equal(approval.human_decision, 'go');
    assert.equal(approval.recommendation, 'Justin: unblock contract engineering');
    assert.equal(approval.human_note, 'proceed with contract engineering unblock');
    assert.equal(fs.existsSync(path.join(dir, '.atris', 'state', 'scorecards.jsonl')), false);
    assert.equal(fs.existsSync(path.join(dir, '.atris', 'state', 'episodes.jsonl')), false);
  } finally {
    cleanupTempDir(dir);
  }
});

test('brain approval edit records approval edit without changing brain edit feedback', () => {
  const dir = makeTempDir();
  try {
    seedBrainWorkspace(dir);
    runCli(['brain', 'compile', '--yes', '--root', dir, '--verify'], { cwd: dir });
    const res = runCli([
      'brain', 'approval', 'edit',
      'change the owner before proceeding',
      '--root', dir,
      '--recommendation', 'Justin: unblock contract engineering',
      '--verify',
    ], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Decision: edit/);
    assert.match(res.stdout, /Status: needs_adjustment_before_action/);

    const approval = JSON.parse(fs.readFileSync(path.join(dir, '.atris', 'state', 'approvals.jsonl'), 'utf8').trim());
    assert.equal(approval.human_decision, 'edit');
    assert.equal(approval.human_note, 'change the owner before proceeding');

    const feedback = runCli([
      'brain', 'edit',
      'tone needs work',
      '--root', dir,
      '--verify',
    ], { cwd: dir });
    assert.equal(feedback.status, 0, feedback.stderr);
    assert.match(feedback.stdout, /Atris brain feedback recorded/);
    assert.match(feedback.stdout, /Rating: edit/);
    assert.equal(fs.existsSync(path.join(dir, '.atris', 'state', 'scorecards.jsonl')), true);
  } finally {
    cleanupTempDir(dir);
  }
});

// ============================================
// task
// ============================================

test('task command adds, claims, and completes workspace-scoped rows', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });

    const add = runCli(['task', 'add', 'Ship task plane', '--tag', 'launch', '--json'], { cwd: dir, env });
    assert.equal(add.status, 0, add.stderr);
    const addPayload = JSON.parse(add.stdout);
    const id = addPayload.task_id;
    const ref = addPayload.task.display_id;
    assert.match(id, /^[0-9A-Z]{26}$/);
    assert.match(ref, /^[A-Z0-9]{3}-1$/);

    const open = runCli(['task', 'list'], { cwd: dir, env });
    assert.equal(open.status, 0, open.stderr);
    assert.match(open.stdout, /^What changes: Ship task plane\./);
    assert.match(open.stdout, new RegExp(`open\\s+${ref}`));
    assert.match(open.stdout, new RegExp(`open\\s+${ref}\\s+#launch`));
    assert.match(open.stdout, new RegExp(`Technical details: atris task show ${ref}`));

    const claim = runCli(['task', 'claim', ref, '--as', 'codex'], { cwd: dir, env });
    assert.equal(claim.status, 0, claim.stderr);
    assert.match(claim.stdout, new RegExp(`claimed ${ref} as codex`));
    assert.match(claim.stdout, new RegExp(`Next: make the change, then run: atris task ready ${ref} --verify "git diff --check"`));
    assert.match(claim.stdout, /--landing "<what someone can do now>"/);
    assert.match(claim.stdout, /Use a different verifier only if autoland can rerun it/);
    assert.match(claim.stdout, /Then: atris autoland tick/);

    const claimed = runCli(['task', 'list', '--status', 'claimed'], { cwd: dir, env });
    assert.equal(claimed.status, 0, claimed.stderr);
    assert.match(claimed.stdout, new RegExp(`claimed\\s+${ref}\\s+\\[codex\\]`));

    const done = runCli(['task', 'done', id.slice(0, 8), '--proof', 'node --test test/commands.test.js passed'], { cwd: dir, env });
    assert.equal(done.status, 0, done.stderr);
    assert.match(done.stdout, new RegExp(`done ${ref}`));

    const completed = runCli(['task', 'list', '--status', 'done'], { cwd: dir, env });
    assert.equal(completed.status, 0, completed.stderr);
    assert.match(completed.stdout, new RegExp(`done\\s+${ref}`));

    const events = runCli(['task', 'events', id], { cwd: dir, env });
    assert.equal(events.status, 0, events.stderr);
    assert.match(events.stdout, new RegExp(`1\\tcreated\\t${ref}`));
    assert.match(events.stdout, new RegExp(`2\\tclaimed\\t${ref}`));
    assert.match(events.stdout, new RegExp(`3\\tcompleted\\t${ref}`));

    const todoPath = path.join(dir, 'atris', 'TODO.md');
    fs.writeFileSync(todoPath, 'clobbered\n', 'utf8');
    const render = runCli(['task', 'render', '--out', 'atris/TODO.md'], { cwd: dir, env });
    assert.equal(render.status, 0, render.stderr);
    assert.match(render.stdout, /rendered TODO\.md/);
    assert.match(render.stdout, /Backlog: empty/);
    assert.match(render.stdout, /Done saved: 1/);
    const regenerated = fs.readFileSync(todoPath, 'utf8');
    assert.match(regenerated, /Regenerated from durable Atris task state/);
    assert.match(regenerated, new RegExp(`\\*\\*\\[${ref}\\]\\*\\* Ship task plane`));
    assert.match(regenerated, /## Completed/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('task next and list honor tag scope before mutating tasks', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });

    const loopCreated = runCli([
      'task',
      'new',
      'Loop janitor keeps unrelated work visible to operators',
      '--tag',
      'loop',
      '--json',
    ], { cwd: dir, env });
    assert.equal(loopCreated.status, 0, loopCreated.stderr);
    const loopTask = JSON.parse(loopCreated.stdout).task;
    const loopClaim = runCli(['task', 'claim', loopTask.display_id, '--as', 'onboarding'], { cwd: dir, env });
    assert.equal(loopClaim.status, 0, loopClaim.stderr);

    const noMatch = runCli(['task', 'next', '--tag', 'golden-path', '--as', 'onboarding', '--json'], { cwd: dir, env });
    assert.equal(noMatch.status, 0, noMatch.stderr);
    const noMatchPayload = JSON.parse(noMatch.stdout);
    assert.equal(noMatchPayload.action, 'none');
    assert.equal(noMatchPayload.command, 'atris task new');
    assert.equal(noMatchPayload.task_id, null);
    assert.equal(noMatchPayload.scope.tag, 'golden-path');

    const loopAfterNoMatch = JSON.parse(runCli(['task', 'show', loopTask.display_id, '--json'], { cwd: dir, env }).stdout);
    assert.equal(loopAfterNoMatch.status, 'claimed');
    assert.equal(loopAfterNoMatch.claimed_by, 'onboarding');
    assert.equal(loopAfterNoMatch.tag, 'loop');

    const goldenCreated = runCli([
      'task',
      'new',
      'Golden path work keeps first-run onboarding focused',
      '--tag',
      'golden-path',
      '--json',
    ], { cwd: dir, env });
    assert.equal(goldenCreated.status, 0, goldenCreated.stderr);
    const goldenTask = JSON.parse(goldenCreated.stdout).task;

    const scopedNext = runCli(['task', 'next', '--tag', 'golden-path', '--as', 'onboarding', '--json'], { cwd: dir, env });
    assert.equal(scopedNext.status, 0, scopedNext.stderr);
    const scopedNextPayload = JSON.parse(scopedNext.stdout);
    assert.equal(scopedNextPayload.action, 'claim');
    assert.equal(scopedNextPayload.command, `atris task claim ${goldenTask.display_id} --as onboarding`);
    assert.equal(scopedNextPayload.task_id, goldenTask.id);
    assert.equal(scopedNextPayload.task.tag, 'golden-path');
    assert.equal(JSON.parse(runCli(['task', 'show', goldenTask.display_id, '--json'], { cwd: dir, env }).stdout).status, 'open');

    const filteredList = runCli(['task', 'list', '--tag', 'golden-path'], { cwd: dir, env });
    assert.equal(filteredList.status, 0, filteredList.stderr);
    assert.match(filteredList.stdout, /#golden-path/);
    assert.match(filteredList.stdout, /Golden path work keeps first-run onboarding focused/);
    assert.doesNotMatch(filteredList.stdout, /Loop janitor/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('task current picks earlier golden-path pass step over a later one touched more recently', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });

    const pass1aCreated = runCli([
      'task',
      'new',
      'Golden path pass 1a: fresh install prints one next command',
      '--tag',
      'golden-path',
      '--json',
    ], { cwd: dir, env });
    assert.equal(pass1aCreated.status, 0, pass1aCreated.stderr);
    const pass1aTask = JSON.parse(pass1aCreated.stdout).task;

    const pass1aPlanned = runCli(['task', 'plan', pass1aTask.display_id, '--goal', 'ship pass 1a', '--exit', 'pass 1a lands', '--proof-needed', 'node --test', '--as', 'onboarding', '--json'], { cwd: dir, env });
    assert.equal(pass1aPlanned.status, 0, pass1aPlanned.stderr);

    const pass2Created = runCli([
      'task',
      'new',
      'Golden path pass 2: mission tick recovery is actionable',
      '--tag',
      'golden-path',
      '--json',
    ], { cwd: dir, env });
    assert.equal(pass2Created.status, 0, pass2Created.stderr);
    const pass2Task = JSON.parse(pass2Created.stdout).task;

    // Plan the later pass step *after* pass 1a, so it has a newer updated_at.
    // This mirrors the real report: a later pass step gets planned/re-touched
    // after the fact and would win under newest-first ordering.
    const pass2Planned = runCli(['task', 'plan', pass2Task.display_id, '--goal', 'ship pass 2', '--exit', 'pass 2 lands', '--proof-needed', 'node --test', '--as', 'onboarding', '--json'], { cwd: dir, env });
    assert.equal(pass2Planned.status, 0, pass2Planned.stderr);

    const scopedCurrent = runCli(['task', 'current', '--tag', 'golden-path', '--as', 'onboarding', '--json'], { cwd: dir, env });
    assert.equal(scopedCurrent.status, 0, scopedCurrent.stderr);
    const scopedPayload = JSON.parse(scopedCurrent.stdout);
    assert.equal(scopedPayload.current.selected_reason, 'plan_ready');
    assert.equal(scopedPayload.current.selected_task_id, pass1aTask.id);
    assert.equal(scopedPayload.current.selected_ref, pass1aTask.display_id);
  } finally {
    cleanupTempDir(dir);
  }
});

test('task add warns when title lacks operator-ready plain why', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });

    const warned = runCli(['task', 'add', 'Refactor task title warning', '--json'], { cwd: dir, env });
    assert.equal(warned.status, 0, warned.stderr);
    assert.match(warned.stderr, /Warning: put the why in this task title in plain words/);
    const warnedPayload = JSON.parse(warned.stdout);
    assert.equal(warnedPayload.action, 'created');
    assert.match(warnedPayload.operator_title_warning, /what it buys or costs/);

    const quiet = runCli(['task', 'add', 'Slow setup costs users time: cache the workspace scan', '--json'], { cwd: dir, env });
    assert.equal(quiet.status, 0, quiet.stderr);
    assert.equal(quiet.stderr, '');
    const quietPayload = JSON.parse(quiet.stdout);
    assert.equal(quietPayload.action, 'created');
    assert.equal(quietPayload.operator_title_warning, null);
  } finally {
    cleanupTempDir(dir);
  }
});

test('task display refs use semantic IDs and collision-safe legacy prefixes', () => {
  if (!hasNodeSqlite()) return;
  const taskDb = require('../lib/task-db');
  const rows = taskDb.withTaskDisplayRefs([
    { id: '01KQMBKFFGKW9T4DGQ5BKW9T4D', title: 'First collision', workspace_root: '/tmp/project-obelisk', created_at: 1 },
    { id: '01KQMBKFFGCMZQVCDFPECMZQVC', title: 'Second collision', workspace_root: '/tmp/project-obelisk', created_at: 2 },
    { id: '01ABCDE1FGCMZQVCDFPECMZQVC', title: 'Plain legacy', workspace_root: '/tmp/project-obelisk', created_at: 3 },
    { id: '01CUST01FGCMZQVCDFPECMZQVC', title: 'Other obelisk', workspace_root: '/tmp/customer-obelisk', created_at: 1 },
  ]);

  assert.deepEqual(rows.map(row => row.display_id), ['OBL-1', 'OBL-2', 'OBL-3', 'COB-1']);
  assert.equal(rows[2].legacy_ref, '01ABCDE1');
  assert.notEqual(rows[0].legacy_ref, rows[1].legacy_ref);
  assert.ok(rows[0].legacy_ref.startsWith('01KQMBKF'));
  assert.ok(rows[1].legacy_ref.startsWith('01KQMBKF'));
});

test('task render preserves Endgame metadata and drops markdown-only rows', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    const todoPath = path.join(dir, 'atris', 'TODO.md');
    fs.writeFileSync(todoPath, [
      '# TODO.md',
      '',
      '## Endgame',
      '',
      '**Slug:** renderer-horizon',
      '**Picked:** 2026-05-15 10:00',
      '**Horizon:** Keep the playable horizon visible.',
      '**Source:** test',
      '',
      '## Backlog',
      '',
      '- **T1:** Keep markdown horizon [endgame] [execute]',
      '  **Verify:** test -f horizon.txt',
      '',
      '## In Progress',
      '',
      '## Review',
      '',
      '- **[T2]** Pending human approval [agent]',
      '  **Verify:** test -f approval.txt',
      '',
      '## Completed',
      '',
    ].join('\n'), 'utf8');
    const created = runCli(['task', 'new', 'DB state task', '--tag', 'agent', '--json'], { cwd: dir, env });
    assert.equal(created.status, 0, created.stderr);
    const createdTask = JSON.parse(created.stdout).task;

    const render = runCli(['task', 'render', '--out', 'atris/TODO.md'], { cwd: dir, env });
    assert.equal(render.status, 0, render.stderr);
    const regenerated = fs.readFileSync(todoPath, 'utf8');
    assert.match(regenerated, /## Endgame/);
    assert.match(regenerated, /\*\*Slug:\*\* renderer-horizon/);
    assert.doesNotMatch(regenerated, /Keep markdown horizon|Pending human approval|horizon\.txt|approval\.txt/);
    assert.match(regenerated, /DB state task \[agent\]/);
    assert.match(regenerated, new RegExp(`\\*\\*\\[${createdTask.display_id}\\]\\*\\* DB state task \\[agent\\]`));
    assert.doesNotMatch(regenerated, /Technical details:/);
    const showByRenderedRef = runCli(['task', 'show', createdTask.display_id, '--json'], { cwd: dir, env });
    assert.equal(showByRenderedRef.status, 0, showByRenderedRef.stderr);
    assert.equal(JSON.parse(showByRenderedRef.stdout).id, createdTask.id);

    const renderAgain = runCli(['task', 'render', '--out', 'atris/TODO.md'], { cwd: dir, env });
    assert.equal(renderAgain.status, 0, renderAgain.stderr);
    const second = fs.readFileSync(todoPath, 'utf8');
    assert.equal((second.match(/## Endgame/g) || []).length, 1);
    assert.equal((second.match(/Keep markdown horizon/g) || []).length, 0);
    assert.equal((second.match(/Pending human approval/g) || []).length, 0);
    assert.equal((second.match(/DB state task/g) || []).length, 1);
    assert.match(second, new RegExp(`\\*\\*\\[${createdTask.display_id}\\]\\*\\* DB state task \\[agent\\]`));
    assert.doesNotMatch(second, /Technical details:/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('task render drops stale generated markdown rows for DB-backed tasks', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    const todoPath = path.join(dir, 'atris', 'TODO.md');
    const created = runCli(['task', 'new', 'Move review work forward', '--tag', 'task-plane', '--json'], { cwd: dir, env });
    assert.equal(created.status, 0, created.stderr);
    const ref = JSON.parse(created.stdout).task.display_id;
    assert.equal(runCli(['task', 'claim', ref, '--as', 'codex'], { cwd: dir, env }).status, 0);
    assert.equal(runCli(['task', 'ready', ref, '--proof', 'render smoke passed', '--as', 'codex'], { cwd: dir, env }).status, 0);

    fs.writeFileSync(todoPath, [
      '# TODO.md',
      '',
      '## Backlog',
      '',
      '- **[T9]** Legacy migration row [agent-xp]',
      '',
      '## In Progress',
      '',
      `- **[${ref}]** Move review work forward [task-plane]`,
      '  **Claimed by:** codex',
      '',
      '## Review',
      '',
      `- **[${ref}]** Move review work forward [task-plane]`,
      '',
      '## Completed',
      '',
    ].join('\n'), 'utf8');

    const legacyRender = runCli(['task', 'render', '--out', 'atris/TODO.md'], { cwd: dir, env });
    assert.equal(legacyRender.status, 0, legacyRender.stderr);
    const legacy = fs.readFileSync(todoPath, 'utf8');
    assert.match(legacy, /Legacy migration row \[agent-xp\]/);
    assert.doesNotMatch(legacy, /Technical details:/);
    assert.equal((legacy.match(new RegExp(`\\*\\*\\[${ref}\\]\\*\\* Move review work forward`, 'g')) || []).length, 1);
    assert.doesNotMatch(legacy, new RegExp(`## In Progress\\n\\n- \\*\\*\\[${ref}\\]\\*\\* Move review work forward`));

    const generatedRender = runCli(['task', 'render', '--out', 'atris/TODO.md'], { cwd: dir, env });
    assert.equal(generatedRender.status, 0, generatedRender.stderr);
    assert.match(generatedRender.stdout, /Backlog: empty/);
    assert.match(generatedRender.stdout, /Review: 1/);
    const generated = fs.readFileSync(todoPath, 'utf8');
    assert.match(generated, /## Backlog\n\n\(Empty\)/);
    assert.doesNotMatch(generated, /Legacy migration row/);
    assert.equal((generated.match(new RegExp(`\\*\\*\\[${ref}\\]\\*\\* Move review work forward`, 'g')) || []).length, 1);
    assert.match(generated, new RegExp(`## Review\\n\\n- \\*\\*\\[${ref}\\]\\*\\* Move review work forward ·`));
    assert.match(generated, /\*\*Done looks like:\*\*/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('task import preserves markdown Review rows as review tasks', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    const todoPath = path.join(dir, 'atris', 'TODO.md');
    fs.writeFileSync(todoPath, [
      '# TODO.md',
      '',
      '## Backlog',
      '',
      '## In Progress',
      '',
      '(Empty)',
      '',
      '## Review',
      '',
      '- **[T9]** Pending human proof [agent]',
      '  **Claimed by:** codex',
      '  **Verify:** npm test',
      '',
      '## Completed',
      '',
    ].join('\n'), 'utf8');

    const imported = runCli(['task', 'import', 'atris/TODO.md', '--json'], { cwd: dir, env });
    assert.equal(imported.status, 0, imported.stderr);
    assert.equal(JSON.parse(imported.stdout).inserted, 1);

    const review = runCli(['task', 'list', '--status', 'review', '--json'], { cwd: dir, env });
    assert.equal(review.status, 0, review.stderr);
    const payload = JSON.parse(review.stdout);
    assert.equal(payload.tasks.length, 1);
    assert.equal(payload.tasks[0].status, 'review');
    assert.equal(payload.tasks[0].title, 'Pending human proof');
    assert.equal(payload.tasks[0].claimed_by, 'codex');
    assert.equal(payload.tasks[0].metadata.verify, 'npm test');

    const revise = runCli(['task', 'revise', payload.tasks[0].display_id, '--note', 'tighten proof', '--json'], { cwd: dir, env });
    assert.equal(revise.status, 0, revise.stderr);
    assert.equal(JSON.parse(revise.stdout).task.status, 'claimed');
  } finally {
    cleanupTempDir(dir);
  }
});

test('task display refs stay stable in filtered list views', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });

    const older = JSON.parse(runCli(['task', 'add', 'Older closed task', '--json'], { cwd: dir, env }).stdout);
    const current = JSON.parse(runCli(['task', 'add', 'Current open task', '--json'], { cwd: dir, env }).stdout);
    assert.equal(runCli(['task', 'done', older.task.display_id, '--proof', 'node --test test/commands.test.js passed'], { cwd: dir, env }).status, 0);

    const open = runCli(['task', 'list', '--status', 'open'], { cwd: dir, env });
    assert.equal(open.status, 0, open.stderr);
    assert.match(open.stdout, /^What changes: Current open task\./);
    assert.match(open.stdout, new RegExp(`open\\s+${current.task.display_id}`));
    assert.match(open.stdout, new RegExp(`Technical details: atris task show ${current.task.display_id}`));
    assert.doesNotMatch(open.stdout, new RegExp(older.task.display_id));

    const done = runCli(['task', 'list', '--status', 'done'], { cwd: dir, env });
    assert.equal(done.status, 0, done.stderr);
    assert.match(done.stdout, /^What changes: Older closed task\./);
    assert.match(done.stdout, new RegExp(`done\\s+${older.task.display_id}`));
    assert.match(done.stdout, new RegExp(`Technical details: atris task show ${older.task.display_id}`));

    const openJson = runCli(['task', 'list', '--status', 'open', '--json'], { cwd: dir, env });
    assert.equal(openJson.status, 0, openJson.stderr);
    assert.equal(JSON.parse(openJson.stdout).tasks[0].display_id, current.task.display_id);
  } finally {
    cleanupTempDir(dir);
  }
});

test('task display refs stay stable when compact projection is capped', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const taskDb = require('../lib/task-db');
  taskDb.close();
  try {
    const db = taskDb.open(dbPath);
    const ws = path.join(dir, 'project-obelisk');
    const createdIds = [];
    for (let i = 0; i < 505; i += 1) {
      createdIds.push(taskDb.addTask(db, {
        title: `Task ${i + 1}`,
        workspaceRoot: ws,
      }).id);
    }

    const newestId = createdIds[createdIds.length - 1];
    const fullRefById = new Map(taskDb.withTaskDisplayRefs(
      taskDb.listTasks(db, { workspaceRoot: ws })
    ).map(task => [task.id, task.display_id]));
    const compact = taskDb.taskProjection(db, { workspaceRoot: ws, limit: 500 });
    assert.equal(compact.tasks.length, 500);
    const newestCompact = compact.tasks.find(task => task.id === newestId);
    assert.ok(newestCompact, 'newest task should be present in capped compact projection');
    assert.equal(newestCompact.display_id, fullRefById.get(newestId));

    const direct = taskDb.taskProjection(db, { taskId: newestId }).tasks[0];
    assert.equal(direct.display_id, newestCompact.display_id);
    assert.equal(direct.legacy_ref, newestCompact.legacy_ref);
  } finally {
    taskDb.close();
    cleanupTempDir(dir);
  }
});

test('task render keeps display refs stable when compact TODO view is capped', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const taskDb = require('../lib/task-db');
  taskDb.close();
  try {
    fs.mkdirSync(path.join(dir, 'project-obelisk', 'atris'), { recursive: true });
    const db = taskDb.open(dbPath);
    const ws = fs.realpathSync(path.join(dir, 'project-obelisk'));
    for (let i = 0; i < 505; i += 1) {
      taskDb.addTask(db, {
        title: `Task ${i + 1}`,
        workspaceRoot: ws,
      });
    }
    const compactRows = taskDb.listTasks(db, { workspaceRoot: ws, limit: 500 });
    const fullById = new Map(taskDb.withTaskDisplayRefs(
      taskDb.listTasks(db, { workspaceRoot: ws })
    ).map(task => [task.id, task.display_id]));
    const compactOnlyById = new Map(taskDb.withTaskDisplayRefs(compactRows)
      .map(task => [task.id, task.display_id]));
    const target = compactRows.find(task => fullById.get(task.id) !== compactOnlyById.get(task.id));
    assert.ok(target, 'fixture should expose a compact-row display ref drift');
    const expectedRef = fullById.get(target.id);
    const staleRef = compactOnlyById.get(target.id);
    taskDb.close();

    const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1' };
    const render = runCli(['task', 'render', '--out', 'atris/TODO.md'], { cwd: ws, env });
    assert.equal(render.status, 0, render.stderr);
    const regenerated = fs.readFileSync(path.join(ws, 'atris', 'TODO.md'), 'utf8');
    assert.match(regenerated, new RegExp(`\\*\\*\\[${expectedRef}\\]\\*\\* ${target.title}`));
    assert.doesNotMatch(regenerated, new RegExp(`\\*\\*\\[${staleRef}\\]\\*\\* ${target.title}`));
  } finally {
    taskDb.close();
    cleanupTempDir(dir);
  }
});

test('task help flags never render the live desk', () => {
  const dir = makeTempDir();
  try {
    const rootHelp = runCli(['task', '--help'], { cwd: dir });
    assert.equal(rootHelp.status, 0, rootHelp.stderr);
    assert.match(rootHelp.stdout, /atris task - durable local task state/);
    assert.match(rootHelp.stdout, /atris task capabilities \[--json\]/);
    assert.match(rootHelp.stdout, /atris task capabilities-check \[--json\]/);
    assert.match(rootHelp.stdout, /atris task review-lane-drain \[--json\]/);
    assert.match(rootHelp.stdout, /atris task review-lane-act \[--json\]/);
    assert.match(rootHelp.stdout, /atris task review-lane-loop \[--json\]/);
    assert.match(rootHelp.stdout, /atris task review-lane-run \[--json\]/);
    assert.match(rootHelp.stdout, /atris task list \[--all\] \[--everywhere\] \[--status <s>\]/);
    assert.match(rootHelp.stdout, /--all stays in this workspace; --everywhere spans workspaces/);
    assert.match(rootHelp.stdout, /atris task reviews \[--all\|--limit <n>\] \[--verbose\]/);
    assert.match(rootHelp.stdout, /atris task current .*--review-state <lane>/);
    assert.match(rootHelp.stdout, /atris task queue .*--review-state <lane>/);
    assert.match(rootHelp.stdout, /atris task current-step .*--review-state <lane>/);
    assert.match(rootHelp.stdout, /review-state lanes: needs-agent, continue-work, human-accept-waiting, certified/);
    assert.doesNotMatch(rootHelp.stdout, /TASK DESK/);

    const eventsHelp = runCli(['task', 'events', '--help'], { cwd: dir });
    assert.equal(eventsHelp.status, 0, eventsHelp.stderr);
    assert.match(eventsHelp.stdout, /atris task events --all/);
    assert.match(eventsHelp.stdout, /atris task events --everywhere/);
    assert.doesNotMatch(eventsHelp.stdout, /TASK EVENTS/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('task capabilities returns the standalone read-only task capability contract', () => {
  const dir = makeTempDir();
  try {
    const caps = runCli(['task', 'capabilities', '--json'], { cwd: dir });
    assert.equal(caps.status, 0, caps.stderr);
    const payload = JSON.parse(caps.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.action, 'capabilities');
    assert.equal(payload.capabilities.schema, 'atris.task_capabilities.v1');
    assert.match(payload.capabilities.read_only_semantics, /no task DB mutation/);
    assert.equal(payload.safety.read_only, true);
    assert.equal(payload.safety.claims_work, false);
    assert.equal(payload.safety.human_accept, false);
    assert.equal(payload.safety.xp_after_human_accept, true);
    assert.equal(payload.capabilities.surfaces.capabilities.read_only, true);
    assert.deepEqual(payload.capabilities.surfaces.capabilities.api, { method: 'GET', path: '/api/tasks/capabilities' });
    assert.equal(payload.capabilities.surfaces.capabilities.mutates_task_db, false);
    assert.equal(payload.capabilities.surfaces.capabilities.writes_projection, false);
    assert.deepEqual(payload.capabilities.surfaces.capabilities.requires_task_db, {
      cli: false,
      api_route_handler: false,
      api_server: true,
    });
    assert.equal(payload.capabilities.surfaces.capabilities_check.read_only, true);
    assert.equal(payload.capabilities.surfaces.capabilities_check.mutates_task_db, false);
    assert.equal(payload.capabilities.surfaces.capabilities_check.writes_projection, true);
    assert.equal(payload.capabilities.surfaces.capabilities_check.requires_task_db, true);
    assert.deepEqual(payload.capabilities.surfaces.capabilities_check.api, { method: 'GET', path: '/api/tasks/capabilities/check' });
    assert.equal(payload.capabilities.surfaces.review_lane_drain.read_only, true);
    assert.equal(payload.capabilities.surfaces.review_lane_drain.mutates_task_db, false);
    assert.equal(payload.capabilities.surfaces.review_lane_drain.writes_projection, true);
    assert.equal(payload.capabilities.surfaces.review_lane_drain.requires_task_db, true);
    assert.equal(payload.capabilities.surfaces.review_lane_drain.skips_existing_follow_up_children, true);
    assert.deepEqual(payload.capabilities.surfaces.review_lane_drain.output_fields.identity, ['selected_task_id', 'selected_ref', 'selected_next_key']);
    assert.deepEqual(payload.capabilities.surfaces.review_lane_drain.api, { method: 'GET', path: '/api/tasks/review-lane-drain' });
    assert.equal(payload.capabilities.surfaces.review_lane_act.read_only, false);
    assert.equal(payload.capabilities.surfaces.review_lane_act.mutates_task_db, 'conditional');
    assert.equal(payload.capabilities.surfaces.review_lane_act.writes_projection, true);
    assert.equal(payload.capabilities.surfaces.review_lane_act.requires_task_db, true);
    assert.equal(payload.capabilities.surfaces.review_lane_act.dry_run_flag, '--dry-run');
    assert.deepEqual(payload.capabilities.surfaces.review_lane_act.api, { method: 'POST', path: '/api/tasks/review-lane-act' });
    assert.deepEqual(payload.capabilities.surfaces.review_lane_act.allowed_actions, ['review_chat', 'continue_work']);
    assert.ok(payload.capabilities.surfaces.review_lane_act.blocked_actions.includes('human_accept_waiting'));
    assert.deepEqual(payload.capabilities.surfaces.review_lane_act.output_fields.identity, ['selected_task_id', 'selected_ref', 'selected_next_key']);
    assert.equal(payload.capabilities.surfaces.review_lane_loop.read_only, false);
    assert.equal(payload.capabilities.surfaces.review_lane_loop.mutates_task_db, 'conditional');
    assert.equal(payload.capabilities.surfaces.review_lane_loop.writes_projection, true);
    assert.equal(payload.capabilities.surfaces.review_lane_loop.requires_task_db, true);
    assert.equal(payload.capabilities.surfaces.review_lane_loop.dry_run_flag, '--dry-run');
    assert.equal(payload.capabilities.surfaces.review_lane_loop.max_steps_flag, '--max-steps <n>');
    assert.equal(payload.capabilities.surfaces.review_lane_loop.default_max_steps, 3);
    assert.equal(payload.capabilities.surfaces.review_lane_loop.max_steps_cap, 10);
    assert.equal(payload.capabilities.surfaces.review_lane_loop.orchestrates, 'review_lane_act');
    assert.deepEqual(payload.capabilities.surfaces.review_lane_loop.api, { method: 'POST', path: '/api/tasks/review-lane-loop' });
    assert.deepEqual(payload.capabilities.surfaces.review_lane_loop.allowed_actions, ['review_chat', 'continue_work']);
    assert.ok(payload.capabilities.surfaces.review_lane_loop.stopped_by.includes('human_accept_waiting_is_human_only'));
    assert.ok(payload.capabilities.surfaces.review_lane_loop.stopped_by.includes('pending_review_chat_waiting_for_agent_review'));
    assert.ok(payload.capabilities.surfaces.review_lane_loop.stopped_by.includes('capabilities_check_failed'));
    assert.ok(payload.capabilities.surfaces.review_lane_loop.stopped_by.includes('repeat_selection'));
    assert.equal(payload.capabilities.surfaces.review_lane_run.read_only, false);
    assert.equal(payload.capabilities.surfaces.review_lane_run.mutates_task_db, 'conditional');
    assert.equal(payload.capabilities.surfaces.review_lane_run.writes_projection, true);
    assert.equal(payload.capabilities.surfaces.review_lane_run.writes_receipt, true);
    assert.equal(payload.capabilities.surfaces.review_lane_run.requires_task_db, true);
    assert.equal(payload.capabilities.surfaces.review_lane_run.dry_run_flag, '--dry-run');
    assert.equal(payload.capabilities.surfaces.review_lane_run.max_runs_flag, '--max-runs <n>');
    assert.equal(payload.capabilities.surfaces.review_lane_run.max_steps_flag, '--max-steps <n>');
    assert.equal(payload.capabilities.surfaces.review_lane_run.default_max_runs, 3);
    assert.equal(payload.capabilities.surfaces.review_lane_run.max_runs_cap, 20);
    assert.equal(payload.capabilities.surfaces.review_lane_run.default_max_steps, 3);
    assert.equal(payload.capabilities.surfaces.review_lane_run.max_steps_cap, 10);
    assert.equal(payload.capabilities.surfaces.review_lane_run.orchestrates, 'review_lane_loop');
    assert.deepEqual(payload.capabilities.surfaces.review_lane_run.api, { method: 'POST', path: '/api/tasks/review-lane-run' });
    assert.deepEqual(payload.capabilities.surfaces.review_lane_run.allowed_actions, ['review_chat', 'continue_work']);
    assert.equal(payload.capabilities.surfaces.review_lane_run.receipt_path, '.atris/state/review-lane-runs.jsonl');
    assert.equal(payload.capabilities.surfaces.review_lane_run.latest_receipt_path, '.atris/state/review-lane-run.latest.json');
    assert.ok(payload.capabilities.surfaces.review_lane_run.stopped_by.includes('continue_work_reused_existing_follow_up'));
    assert.ok(payload.capabilities.surfaces.review_lane_run.stopped_by.includes('human_accept_waiting_is_human_only'));
    assert.ok(payload.capabilities.surfaces.review_lane_run.stopped_by.includes('pending_review_chat_waiting_for_agent_review'));
    assert.ok(payload.capabilities.surfaces.review_lane_run.stopped_by.includes('capabilities_check_failed'));
    assert.ok(payload.capabilities.surfaces.review_lane_run.stopped_by.includes('max_runs_reached'));
    assert.equal(payload.capabilities.surfaces.current.read_only, true);
    assert.equal(payload.capabilities.surfaces.current.mutates_task_db, false);
    assert.equal(payload.capabilities.surfaces.current.writes_projection, true);
    assert.equal(payload.capabilities.surfaces.current.requires_task_db, true);
    assert.deepEqual(payload.capabilities.surfaces.current.output_fields.identity, ['selected_task_id', 'selected_ref', 'selected_next_key']);
    assert.equal(payload.capabilities.surfaces.queue.read_only, true);
    assert.equal(payload.capabilities.surfaces.queue.mutates_task_db, false);
    assert.equal(payload.capabilities.surfaces.queue.writes_projection, true);
    assert.equal(payload.capabilities.surfaces.queue.requires_task_db, true);
    assert.deepEqual(payload.capabilities.surfaces.queue.output_fields.identity, ['selected_task_id', 'selected_ref', 'selected_next_key']);
    assert.deepEqual(payload.capabilities.filters.review_state.accepted, ['needs-agent', 'continue-work', 'proof-boundary-blocked', 'human-accept-waiting', 'certified']);
    assert.equal(payload.capabilities.commands.capabilities, 'atris task capabilities --json');
    assert.equal(payload.capabilities.commands.capabilities_check, 'atris task capabilities-check --json');
    assert.equal(payload.capabilities.commands.review_lane_drain, 'atris task review-lane-drain --json');
    assert.equal(payload.capabilities.commands.review_lane_act, 'atris task review-lane-act --json');
    assert.equal(payload.capabilities.commands.review_lane_loop, 'atris task review-lane-loop --json');
    assert.equal(payload.capabilities.commands.review_lane_run, 'atris task review-lane-run --json');
    assert.equal(payload.capabilities.commands.current, 'atris task current --review-state <lane> --json');
    assert.equal(payload.capabilities.commands.queue, 'atris task queue --review-state <lane> --json');
    assert.equal(payload.capabilities.commands.current_step, 'atris task current-step --review-state <lane> --json');
    assert.equal(payload.capabilities.current_step.api.path, '/api/tasks/current/step?review_state=<lane>');
    assert.deepEqual(payload.capabilities.current_step.output_fields.identity, ['selected_task_id', 'selected_ref', 'selected_next_key']);
    assert.equal(payload.capabilities.current_step.safety.claims_work, 'conditional');
    assert.equal(payload.capabilities.current_step.lanes['continue-work'].creates_or_reuses_follow_up, true);
    assert.equal(payload.capabilities.current_step.lanes['human-accept-waiting'].safe_for_agent, false);
    assert.equal(payload.projection_path, undefined);

    const home = path.join(dir, 'home');
    fs.mkdirSync(path.join(home, '.atris'), { recursive: true });
    fs.writeFileSync(path.join(home, '.atris', '.update-check'), JSON.stringify({
      lastCheck: new Date().toISOString(),
      latestVersion: '99.99.99',
    }, null, 2));
    const noisyEnv = { ...process.env, HOME: home };
    delete noisyEnv.ATRIS_SKIP_UPDATE_CHECK;
    delete noisyEnv.NO_UPDATE_NOTIFIER;
    const cleanJsonCaps = spawnSync(process.execPath, [cliPath, 'task', 'capabilities', '--json'], {
      cwd: dir,
      encoding: 'utf8',
      timeout: 15000,
      env: noisyEnv,
    });
    assert.equal(cleanJsonCaps.status, 0, cleanJsonCaps.stderr);
    assert.doesNotMatch(cleanJsonCaps.stdout, /Update available/);
    assert.deepEqual(JSON.parse(cleanJsonCaps.stdout).capabilities, payload.capabilities);

    const textCaps = runCli(['task', 'caps'], { cwd: dir });
    assert.equal(textCaps.status, 0, textCaps.stderr);
    assert.match(textCaps.stdout, /atris.task_capabilities.v1/);
    assert.match(textCaps.stdout, /review-state lanes: needs-agent, continue-work, proof-boundary-blocked, human-accept-waiting, certified/);
    assert.doesNotMatch(textCaps.stdout, /TASK QUEUE|TASK CURRENT/);
  } finally {
    cleanupTempDir(dir);
  }
});
