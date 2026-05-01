const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  buildConflictReviewPacket,
  classifyBrainSync,
  classifyPath,
  readBaseContent,
  renderSyncSummary,
  removeBaseContents,
  writeBaseContents,
  writeConflictReviewPacket,
} = require('../lib/company-brain-sync');

const h = (hash) => ({ hash, size: hash.length });

test('classifies clean local and remote company brain changes', () => {
  const plan = classifyBrainSync({
    baseFiles: {
      '/atris/MAP.md': h('a'),
      '/atris/wiki/index.md': h('b'),
      '/README.md': h('outside'),
    },
    localFiles: {
      '/atris/MAP.md': h('a2'),
      '/atris/wiki/index.md': h('b'),
      '/atris/wiki/new-local.md': h('c'),
      '/README.md': h('outside2'),
    },
    remoteFiles: {
      '/atris/MAP.md': h('a'),
      '/atris/wiki/index.md': h('b2'),
      '/atris/wiki/new-remote.md': h('d'),
      '/README.md': h('outside3'),
    },
  });

  assert.deepEqual(plan.changes.map((c) => [c.path, c.status, c.action]), [
    ['/atris/MAP.md', 'local_updated', 'push'],
    ['/atris/wiki/index.md', 'remote_updated', 'pull'],
    ['/atris/wiki/new-local.md', 'local_created', 'push'],
    ['/atris/wiki/new-remote.md', 'remote_created', 'pull'],
  ]);
  assert.deepEqual(plan.summary, {
    push: 2,
    pull: 2,
    review: 0,
    holdDelete: 0,
    unchanged: 0,
  });
});

test('classifies both-changed files as review conflicts', () => {
  assert.deepEqual(
    classifyPath({
      path: '/atris/wiki/concepts/wbr.md',
      base: h('base'),
      local: h('local'),
      remote: h('remote'),
    }),
    {
      path: '/atris/wiki/concepts/wbr.md',
      status: 'conflict_updated',
      action: 'review',
    }
  );
});

test('holds local deletes instead of deleting cloud by default', () => {
  assert.deepEqual(
    classifyPath({
      path: '/atris/TODO.md',
      base: h('base'),
      local: null,
      remote: h('base'),
    }),
    {
      path: '/atris/TODO.md',
      status: 'local_deleted',
      action: 'hold_delete',
    }
  );
});

test('remote delete plus local update requires review', () => {
  assert.deepEqual(
    classifyPath({
      path: '/atris/reports/wbr.md',
      base: h('base'),
      local: h('local'),
      remote: null,
    }),
    {
      path: '/atris/reports/wbr.md',
      status: 'conflict_remote_deleted_local_updated',
      action: 'review',
    }
  );
});

test('classifies the safe and unsafe merge matrix for company brain docs', () => {
  const cases = [
    {
      name: 'same final content records convergence',
      input: { base: h('base'), local: h('same'), remote: h('same') },
      expected: ['converged', 'record'],
    },
    {
      name: 'cloud-only delete pulls delete locally',
      input: { base: h('base'), local: h('base'), remote: null },
      expected: ['remote_deleted', 'pull_delete'],
    },
    {
      name: 'both deleted records convergence',
      input: { base: h('base'), local: null, remote: null },
      expected: ['deleted_both', 'record'],
    },
    {
      name: 'local delete plus cloud edit needs review',
      input: { base: h('base'), local: null, remote: h('remote') },
      expected: ['conflict_local_deleted_remote_updated', 'review'],
    },
    {
      name: 'new local and cloud files with different content need review',
      input: { base: null, local: h('local'), remote: h('remote') },
      expected: ['conflict_created', 'review'],
    },
  ];

  for (const item of cases) {
    const result = classifyPath({
      path: '/atris/wiki/ops.md',
      ...item.input,
    });
    assert.deepEqual([result.status, result.action], item.expected, item.name);
  }
});

test('renders conflict summary for operator review', () => {
  const plan = classifyBrainSync({
    baseFiles: { '/atris/wiki/a.md': h('base') },
    localFiles: { '/atris/wiki/a.md': h('local') },
    remoteFiles: { '/atris/wiki/a.md': h('remote') },
  });

  const summary = renderSyncSummary(plan);
  assert.match(summary, /Company brain sync/);
  assert.match(summary, /review: 1/);
  assert.match(summary, /atris\/wiki\/a\.md \(conflict_updated\)/);
});

test('builds conflict review packet with local and remote artifacts', () => {
  const plan = classifyBrainSync({
    baseFiles: { '/atris/wiki/a.md': h('base') },
    localFiles: { '/atris/wiki/a.md': h('local') },
    remoteFiles: { '/atris/wiki/a.md': h('remote') },
  });

  const packet = buildConflictReviewPacket({
    plan,
    baseContents: { '/atris/wiki/a.md': 'base truth\n' },
    localContents: { '/atris/wiki/a.md': 'local draft\n' },
    remoteContents: { '/atris/wiki/a.md': 'cloud truth\n' },
    timestamp: '2026-05-01T12-00-00Z',
  });

  assert.equal(packet.conflicts.length, 1);
  assert.equal(
    packet.files['.atris/sync/conflicts/2026-05-01T12-00-00Z/atris/wiki/a.md.base'],
    'base truth\n'
  );
  assert.equal(
    packet.files['.atris/sync/conflicts/2026-05-01T12-00-00Z/atris/wiki/a.md.local'],
    'local draft\n'
  );
  assert.equal(
    packet.files['.atris/sync/conflicts/2026-05-01T12-00-00Z/atris/wiki/a.md.remote'],
    'cloud truth\n'
  );
  assert.match(
    packet.files['.atris/sync/conflicts/2026-05-01T12-00-00Z/summary.md'],
    /base: \.atris\/sync\/conflicts\/2026-05-01T12-00-00Z\/atris\/wiki\/a\.md\.base/
  );
});

test('writes conflict review packet to disk', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-sync-review-'));
  try {
    const packet = {
      files: {
        '.atris/sync/conflicts/t/atris/wiki/a.md.local': 'local\n',
        '.atris/sync/conflicts/t/atris/wiki/a.md.remote': 'remote\n',
        '.atris/sync/conflicts/t/summary.md': '# Summary\n',
      },
    };

    const written = writeConflictReviewPacket(dir, packet);
    assert.equal(written.length, 3);
    assert.equal(fs.readFileSync(path.join(dir, '.atris/sync/conflicts/t/atris/wiki/a.md.local'), 'utf8'), 'local\n');
    assert.equal(fs.readFileSync(path.join(dir, '.atris/sync/conflicts/t/summary.md'), 'utf8'), '# Summary\n');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('stores base contents for future semantic conflict resolution', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-sync-base-'));
  try {
    const written = writeBaseContents(dir, {
      '/atris/wiki/a.md': 'base\n',
      'atris/wiki/b.md': 'base b\n',
    });
    assert.equal(written.length, 2);
    assert.equal(readBaseContent(dir, '/atris/wiki/a.md'), 'base\n');
    assert.equal(readBaseContent(dir, 'atris/wiki/b.md'), 'base b\n');

    removeBaseContents(dir, ['/atris/wiki/a.md']);
    assert.equal(readBaseContent(dir, '/atris/wiki/a.md'), null);
    assert.equal(readBaseContent(dir, 'atris/wiki/b.md'), 'base b\n');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
