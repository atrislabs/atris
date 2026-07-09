const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const {
  applyReviewChoice,
  buildConflictMarkers,
  collectConflictResolutionEntries,
  listConflictFiles,
  parseBusinessSyncArgs,
  runSyncReview,
} = require('../commands/business-sync');

function makeWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-sync-review-'));
  fs.mkdirSync(path.join(dir, 'atris', 'wiki'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.atris', 'sync', 'conflicts', '2026-07-09T10-00-00Z', 'atris', 'wiki'), {
    recursive: true,
  });
  return dir;
}

function writeConflictPacket(dir, files) {
  const stamp = '2026-07-09T10-00-00Z';
  const packetRoot = path.join(dir, '.atris', 'sync', 'conflicts', stamp);
  const summary = ['# Company Brain Sync Review', '', `${files.length} files need review before publishing.`, ''];
  for (const file of files) {
    const packetDir = path.join(packetRoot, path.dirname(file.rel));
    fs.mkdirSync(packetDir, { recursive: true });
    const baseName = path.basename(file.rel);
    if (file.base != null) fs.writeFileSync(path.join(packetDir, `${baseName}.base`), file.base, 'utf8');
    fs.writeFileSync(path.join(packetDir, `${baseName}.local`), file.local, 'utf8');
    fs.writeFileSync(path.join(packetDir, `${baseName}.remote`), file.remote, 'utf8');
    // Workspace still holds the local snapshot the operator was editing.
    const workspacePath = path.join(dir, file.rel);
    fs.mkdirSync(path.dirname(workspacePath), { recursive: true });
    fs.writeFileSync(workspacePath, file.local, 'utf8');
    summary.push(`- ${file.rel}`);
  }
  fs.writeFileSync(path.join(packetRoot, 'summary.md'), `${summary.join('\n')}\n`, 'utf8');
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

test('parseBusinessSyncArgs reads --take local|cloud for review', () => {
  const local = parseBusinessSyncArgs(['--review', '--take', 'local']);
  assert.equal(local.review, true);
  assert.equal(local.take, 'local');

  const cloudEq = parseBusinessSyncArgs(['--review', '--take=cloud']);
  assert.equal(cloudEq.take, 'cloud');
});

test('buildConflictMarkers writes standard git-style markers', () => {
  const markers = buildConflictMarkers('local line\n', 'cloud line\n');
  assert.equal(
    markers,
    '<<<<<<< local\nlocal line\n=======\ncloud line\n>>>>>>> cloud\n'
  );
});

test('listConflictFiles names every conflict path', () => {
  const listed = listConflictFiles([
    { targetRel: 'atris/wiki/a.md' },
    { targetRel: 'atris/wiki/b.md' },
  ]);
  assert.match(listed, /2 files conflict/);
  assert.match(listed, /1\. atris\/wiki\/a\.md/);
  assert.match(listed, /2\. atris\/wiki\/b\.md/);
  assert.match(listed, /--take local/);
  assert.doesNotMatch(listed, /—/);
});

test('runSyncReview --take local keeps local content and removes packet artifacts', async () => {
  const dir = makeWorkspace();
  try {
    writeConflictPacket(dir, [
      { rel: 'atris/wiki/a.md', local: 'local a\n', remote: 'cloud a\n', base: 'base a\n' },
      { rel: 'atris/wiki/b.md', local: 'local b\n', remote: 'cloud b\n' },
    ]);

    const result = await runSyncReview(dir, { take: 'local' });
    assert.equal(result.exitCode, 0);
    assert.deepEqual(result.resolved, ['atris/wiki/a.md', 'atris/wiki/b.md']);
    assert.equal(fs.readFileSync(path.join(dir, 'atris/wiki/a.md'), 'utf8'), 'local a\n');
    assert.equal(fs.readFileSync(path.join(dir, 'atris/wiki/b.md'), 'utf8'), 'local b\n');
    assert.equal(fs.existsSync(path.join(dir, 'atris/wiki/a.md.remote')), false);
    assert.equal(collectConflictResolutionEntries(dir).length, 0);
    assert.match(result.message, /taking|resolved|local/i);
  } finally {
    cleanup(dir);
  }
});

test('runSyncReview --take cloud keeps cloud content without workspace .remote dumps', async () => {
  const dir = makeWorkspace();
  try {
    writeConflictPacket(dir, [
      { rel: 'atris/wiki/a.md', local: 'local a\n', remote: 'cloud a\n' },
    ]);

    const result = await runSyncReview(dir, { take: 'cloud' });
    assert.equal(result.exitCode, 0);
    assert.equal(fs.readFileSync(path.join(dir, 'atris/wiki/a.md'), 'utf8'), 'cloud a\n');
    assert.equal(fs.existsSync(path.join(dir, 'atris/wiki/a.md.remote')), false);
    assert.equal(fs.existsSync(path.join(dir, 'atris/wiki/a.md.local')), false);
    assert.match(result.message, /1 file conflict/);
    assert.match(result.message, /cloud/);
  } finally {
    cleanup(dir);
  }
});

test('interactive merge writes conflict markers into the target file', async () => {
  const dir = makeWorkspace();
  try {
    writeConflictPacket(dir, [
      { rel: 'atris/wiki/a.md', local: 'local only\n', remote: 'cloud only\n' },
    ]);

    const answers = ['merge'];
    const result = await runSyncReview(dir, {
      ask: async () => answers.shift(),
    });
    assert.equal(result.exitCode, 0);
    assert.deepEqual(result.choices, [{ path: 'atris/wiki/a.md', choice: 'merge' }]);
    const body = fs.readFileSync(path.join(dir, 'atris/wiki/a.md'), 'utf8');
    assert.equal(body, buildConflictMarkers('local only\n', 'cloud only\n'));
    assert.equal(fs.existsSync(path.join(dir, 'atris/wiki/a.md.remote')), false);
  } finally {
    cleanup(dir);
  }
});

test('applyReviewChoice merge never dumps .remote beside the workspace file', () => {
  const dir = makeWorkspace();
  try {
    writeConflictPacket(dir, [
      { rel: 'atris/wiki/a.md', local: 'L\n', remote: 'C\n' },
    ]);
    const [entry] = collectConflictResolutionEntries(dir);
    applyReviewChoice(dir, entry, 'merge');
    assert.equal(fs.existsSync(path.join(dir, 'atris/wiki/a.md.remote')), false);
    assert.match(fs.readFileSync(path.join(dir, 'atris/wiki/a.md'), 'utf8'), /<<<<<<< local/);
  } finally {
    cleanup(dir);
  }
});

test('invalid --take is rejected without mutating files', async () => {
  const dir = makeWorkspace();
  try {
    writeConflictPacket(dir, [
      { rel: 'atris/wiki/a.md', local: 'local a\n', remote: 'cloud a\n' },
    ]);
    const before = fs.readFileSync(path.join(dir, 'atris/wiki/a.md'), 'utf8');
    const result = await runSyncReview(dir, { take: 'merge' });
    assert.equal(result.exitCode, 1);
    assert.match(result.message, /--take local or --take cloud/);
    assert.equal(fs.readFileSync(path.join(dir, 'atris/wiki/a.md'), 'utf8'), before);
    assert.equal(collectConflictResolutionEntries(dir).length, 1);
  } finally {
    cleanup(dir);
  }
});

test('per-file interactive choices can mix local and cloud', async () => {
  const dir = makeWorkspace();
  try {
    writeConflictPacket(dir, [
      { rel: 'atris/wiki/a.md', local: 'local a\n', remote: 'cloud a\n' },
      { rel: 'atris/wiki/b.md', local: 'local b\n', remote: 'cloud b\n' },
    ]);
    const answers = ['local', 'cloud'];
    const result = await runSyncReview(dir, {
      ask: async () => answers.shift(),
    });
    assert.equal(result.exitCode, 0);
    assert.equal(fs.readFileSync(path.join(dir, 'atris/wiki/a.md'), 'utf8'), 'local a\n');
    assert.equal(fs.readFileSync(path.join(dir, 'atris/wiki/b.md'), 'utf8'), 'cloud b\n');
  } finally {
    cleanup(dir);
  }
});
