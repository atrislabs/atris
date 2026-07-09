const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  parseCloudCleanArgs,
  collectCloudOrphans,
  cloudClean,
  renderCloudCleanSummary,
} = require('../commands/cloud');
const {
  businessSync,
  parseBusinessSyncArgs,
  renderLocalSyncStatus,
  renderBusinessSyncHelp,
} = require('../commands/business-sync');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-clean-'));
}

function fakeCloudDeps(overrides = {}) {
  const calls = [];
  const cloudFiles = overrides.cloudFiles || [];
  const listData = overrides.listData || [{ id: 'biz-1', workspace_id: 'ws-1', name: 'Example Co', slug: 'example-co' }];
  return {
    calls,
    deps: {
      loadCredentials: () => ({ token: 'test-token' }),
      apiRequestJson: async (pathname, options) => {
        calls.push({ pathname, options });
        if (pathname === '/business/') {
          return { ok: true, status: 200, data: listData };
        }
        if (pathname === '/business/biz-1/workspaces/ws-1/snapshot?include_content=false') {
          return { ok: true, status: 200, data: { files: cloudFiles } };
        }
        if (pathname.startsWith('/business/biz-1/workspaces/ws-1/file')) {
          return overrides.deleteResult
            ? overrides.deleteResult(pathname, options)
            : { ok: true, status: 200, data: {} };
        }
        return { ok: true, status: 200, data: {} };
      },
      loadBusinesses: () => ({}),
      saveBusinesses: () => {},
      computeLocalHashes: overrides.computeLocalHashes || (() => ({})),
      ...overrides.extraDeps,
    },
  };
}

test('parseCloudCleanArgs recognizes clean subcommand and flags', () => {
  assert.deepEqual(parseCloudCleanArgs(['clean', 'example-co', '--dry-run']), {
    subcommand: 'clean',
    slug: 'example-co',
    dryRun: true,
    yes: false,
    deleteAll: false,
    help: false,
  });
  assert.deepEqual(parseCloudCleanArgs(['--help']), {
    subcommand: 'help',
    slug: null,
    dryRun: false,
    yes: false,
    deleteAll: false,
    help: true,
  });
});

test('parseBusinessSyncArgs recognizes --show-orphans', () => {
  const options = parseBusinessSyncArgs(['--status', '--show-orphans']);
  assert.equal(options.status, true);
  assert.equal(options.showOrphans, true);
});

test('collectCloudOrphans returns cloud paths not present locally', async () => {
  const dir = makeTempDir();
  try {
    const { deps } = fakeCloudDeps({
      cloudFiles: [
        { path: '/atris/now.md', hash: 'a' },
        { path: '/atris/wiki/orphan.md', hash: 'b' },
      ],
      computeLocalHashes: () => ({
        '/atris/now.md': { hash: 'a', size: 1 },
      }),
    });
    const result = await collectCloudOrphans(dir, 'example-co', deps);
    assert.deepEqual(result.orphanPaths, ['/atris/wiki/orphan.md']);
    assert.equal(result.localCount, 1);
    assert.equal(result.cloudCount, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('collectCloudOrphans ignores binary and hidden cloud files', async () => {
  const dir = makeTempDir();
  try {
    const { deps } = fakeCloudDeps({
      cloudFiles: [
        { path: '/atris/visible.md', hash: 'a' },
        { path: '/.hidden.md', hash: 'b' },
        { path: '/binary.bin', hash: 'c', binary: true },
      ],
      computeLocalHashes: () => ({}),
    });
    const result = await collectCloudOrphans(dir, 'example-co', deps);
    assert.deepEqual(result.orphanPaths, ['/atris/visible.md']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('cloud clean --dry-run previews orphans without deleting', async () => {
  const dir = makeTempDir();
  try {
    const { deps, calls } = fakeCloudDeps({
      cloudFiles: [
        { path: '/local.md', hash: 'a' },
        { path: '/orphan.md', hash: 'b' },
      ],
      computeLocalHashes: () => ({ '/local.md': { hash: 'a', size: 1 } }),
    });
    const result = await cloudClean(['clean', 'example-co', '--dry-run'], dir, deps);
    assert.equal(result.ok, true);
    assert.match(result.output, /cloud clean \(dry run\): 1 cloud file not present locally:/);
    assert.match(result.output, /orphan\.md/);
    const deleteCalls = calls.filter((c) => c.options && c.options.method === 'DELETE');
    assert.equal(deleteCalls.length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('cloud clean without flags previews orphans', async () => {
  const dir = makeTempDir();
  try {
    const { deps } = fakeCloudDeps({
      cloudFiles: [{ path: '/orphan.md', hash: 'b' }],
      computeLocalHashes: () => ({}),
    });
    const result = await cloudClean(['clean', 'example-co'], dir, deps);
    assert.equal(result.ok, true);
    assert.match(result.output, /cloud clean: 1 cloud file not present locally:/);
    assert.match(result.output, /pass --yes to delete/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('cloud clean reports no orphans when cloud matches local', async () => {
  const dir = makeTempDir();
  try {
    const { deps } = fakeCloudDeps({
      cloudFiles: [{ path: '/local.md', hash: 'a' }],
      computeLocalHashes: () => ({ '/local.md': { hash: 'a', size: 1 } }),
    });
    const result = await cloudClean(['clean', 'example-co'], dir, deps);
    assert.equal(result.ok, true);
    assert.match(result.output, /No cloud orphans found/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('cloud clean --yes deletes orphan cloud files', async () => {
  const dir = makeTempDir();
  try {
    const { deps, calls } = fakeCloudDeps({
      cloudFiles: [
        { path: '/local.md', hash: 'a' },
        { path: '/orphan.md', hash: 'b' },
      ],
      computeLocalHashes: () => ({ '/local.md': { hash: 'a', size: 1 } }),
    });
    const result = await cloudClean(['clean', 'example-co', '--yes'], dir, deps);
    assert.equal(result.ok, true);
    assert.match(result.output, /1 deleted/);
    const deleteCalls = calls.filter((c) => c.options && c.options.method === 'DELETE');
    assert.equal(deleteCalls.length, 1);
    assert.ok(deleteCalls[0].pathname.includes('orphan.md'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('cloud clean --yes refuses mass delete without --delete-all', async () => {
  const dir = makeTempDir();
  try {
    const { deps } = fakeCloudDeps({
      cloudFiles: Array.from({ length: 12 }, (_, i) => ({ path: `/orphan-${i}.md`, hash: `h${i}` })),
      computeLocalHashes: () => ({}),
    });
    await assert.rejects(
      cloudClean(['clean', 'example-co', '--yes'], dir, deps),
      /mass delete guard/
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('cloud clean --yes --delete-all allows mass delete', async () => {
  const dir = makeTempDir();
  try {
    const { deps, calls } = fakeCloudDeps({
      cloudFiles: Array.from({ length: 12 }, (_, i) => ({ path: `/orphan-${i}.md`, hash: `h${i}` })),
      computeLocalHashes: () => ({}),
    });
    const result = await cloudClean(['clean', 'example-co', '--yes', '--delete-all'], dir, deps);
    assert.equal(result.ok, true);
    const deleteCalls = calls.filter((c) => c.options && c.options.method === 'DELETE');
    assert.equal(deleteCalls.length, 12);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('renderLocalSyncStatus shows orphan cloud files when present', () => {
  const rendered = renderLocalSyncStatus({
    slug: 'example-co',
    cwd: '/tmp',
    workspaceFileCount: 1,
    brainExists: true,
    lastSync: null,
    manifestRoot: null,
    manifestRootMatches: true,
    conflictCount: 0,
    warnings: [],
    heartbeat: null,
    orphanPaths: ['/atris/wiki/orphan.md'],
  });
  assert.match(rendered, /orphans: 1 cloud file not present locally/);
  assert.match(rendered, /atris\/wiki\/orphan\.md/);
});

test('renderLocalSyncStatus shows no orphans when list is empty', () => {
  const rendered = renderLocalSyncStatus({
    slug: 'example-co',
    cwd: '/tmp',
    workspaceFileCount: 0,
    brainExists: false,
    lastSync: null,
    manifestRoot: null,
    manifestRootMatches: true,
    conflictCount: 0,
    warnings: [],
    heartbeat: null,
    orphanPaths: [],
  });
  assert.match(rendered, /orphans: none/);
});

test('renderBusinessSyncHelp mentions --show-orphans', () => {
  assert.match(renderBusinessSyncHelp(), /--show-orphans/);
});

test('business sync --status --show-orphans lists cloud orphans', async () => {
  const dir = makeTempDir();
  let output = '';
  const originalWrite = process.stdout.write;
  process.stdout.write = (chunk) => {
    output += chunk;
    return true;
  };
  try {
    const { deps } = fakeCloudDeps({
      cloudFiles: [
        { path: '/atris/now.md', hash: 'a' },
        { path: '/atris/wiki/orphan.md', hash: 'b' },
      ],
      computeLocalHashes: () => ({ '/atris/now.md': { hash: 'a', size: 1 } }),
    });
    await businessSync(['example-co', '--status', '--show-orphans'], dir, deps);
    assert.match(output, /orphans: 1 cloud file not present locally/);
    assert.match(output, /atris\/wiki\/orphan\.md/);
  } finally {
    process.stdout.write = originalWrite;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('business sync --status --show-orphans surfaces cloud errors', async () => {
  const dir = makeTempDir();
  let output = '';
  const originalWrite = process.stdout.write;
  process.stdout.write = (chunk) => {
    output += chunk;
    return true;
  };
  try {
    const { deps } = fakeCloudDeps({
      apiRequestJson: async (pathname, options) => {
        if (pathname === '/business/') {
          return { ok: true, status: 200, data: [] };
        }
        return { ok: true, status: 200, data: {} };
      },
      computeLocalHashes: () => ({}),
    });
    await businessSync(['example-co', '--status', '--show-orphans'], dir, deps);
    assert.match(output, /orphans:/);
  } finally {
    process.stdout.write = originalWrite;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('renderCloudCleanSummary formats dry-run and delete results', () => {
  const dryRun = renderCloudCleanSummary(['/a.md', '/b.md'], { dryRun: true, localCount: 3 });
  assert.match(dryRun, /cloud clean \(dry run\): 2 cloud files not present locally:/);
  assert.match(dryRun, /a\.md/);
  assert.match(dryRun, /b\.md/);
  assert.match(dryRun, /pass --yes to delete/);

  const result = renderCloudCleanSummary(['/a.md'], { deleted: 1, failed: 0, localCount: 2 });
  assert.match(result, /1 deleted/);
  assert.match(result, /local files: 2/);
});
