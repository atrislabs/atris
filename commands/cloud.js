const fs = require('fs');
const path = require('path');
const { loadCredentials } = require('../utils/auth');
const { apiRequestJson } = require('../utils/api');
const { loadBusinesses, saveBusinesses, businessMatchesSlug } = require('./business');
const { computeLocalHashes, isIgnoredSyncPath } = require('../lib/manifest');
const { assertSafeWorkspaceRoot } = require('../lib/workspace-safety');
const { isMassDeletePlan } = require('./push');

const DEFAULT_DEPS = {
  loadCredentials,
  apiRequestJson,
  loadBusinesses,
  saveBusinesses,
  computeLocalHashes,
  isMassDeletePlan,
};

function parseCloudCleanArgs(args = []) {
  const positional = args.filter((arg) => arg && !arg.startsWith('-'));
  const help = args.includes('--help') || args.includes('-h') || positional[0] === 'help';
  const subcommand = positional[0] || (help ? 'help' : 'clean');
  const slug = positional[1] || null;
  const dryRun = args.includes('--dry-run');
  const yes = args.includes('--yes') || args.includes('-y');
  const deleteAll = args.includes('--delete-all');
  return { subcommand, slug, dryRun, yes, deleteAll, help };
}

function readCloudCleanSlug(cwd, args) {
  const parsed = parseCloudCleanArgs(args);
  if (parsed.slug) return parsed.slug;
  const bizFile = path.join(cwd, '.atris', 'business.json');
  if (fs.existsSync(bizFile)) {
    try {
      const biz = JSON.parse(fs.readFileSync(bizFile, 'utf8'));
      return biz.slug || biz.name || null;
    } catch {
      return null;
    }
  }
  return null;
}

async function resolveBusinessWorkspace(token, slug, deps = {}) {
  const d = { ...DEFAULT_DEPS, ...deps };
  const businesses = d.loadBusinesses();
  const listResult = await d.apiRequestJson('/business/', { method: 'GET', token });
  if (listResult.ok) {
    const match = (listResult.data || []).find((b) => businessMatchesSlug(b, slug, { includeName: true }));
    if (!match) return null;
    const { id: businessId, workspace_id: workspaceId, name: businessName, slug: resolvedSlug } = match;
    businesses[slug] = {
      business_id: businessId,
      workspace_id: workspaceId,
      name: businessName,
      slug: resolvedSlug,
      added_at: new Date().toISOString(),
    };
    d.saveBusinesses(businesses);
    return { businessId, workspaceId, businessName, resolvedSlug };
  }
  if (businesses[slug]) {
    return {
      businessId: businesses[slug].business_id,
      workspaceId: businesses[slug].workspace_id,
      businessName: businesses[slug].name || slug,
      resolvedSlug: businesses[slug].slug || slug,
    };
  }
  return null;
}

function normalizeCloudPath(p) {
  const s = String(p || '').replace(/\\/g, '/');
  return s.startsWith('/') ? s : `/${s}`;
}

async function collectCloudOrphans(cwd, slug, deps = {}) {
  const d = { ...DEFAULT_DEPS, ...deps };
  const credentials = d.loadCredentials();
  if (!credentials || !credentials.token) {
    throw new Error('Not logged in. Run: atris login');
  }
  assertSafeWorkspaceRoot(cwd, { op: 'cloud clean' });
  const resolvedSlug = slug || readCloudCleanSlug(cwd, []);
  if (!resolvedSlug) {
    throw new Error('No business workspace found. Run inside a business workspace or pass a business slug.');
  }
  const biz = await resolveBusinessWorkspace(credentials.token, resolvedSlug, d);
  if (!biz) {
    throw new Error(`Business "${resolvedSlug}" not found.`);
  }
  const localFiles = d.computeLocalHashes(cwd);
  const result = await d.apiRequestJson(
    `/business/${biz.businessId}/workspaces/${biz.workspaceId}/snapshot?include_content=false`,
    { method: 'GET', token: credentials.token, timeoutMs: 120000 }
  );
  if (!result.ok) {
    throw new Error(`could not list cloud files: ${result.error || result.status}`);
  }
  const cloudFiles = (result.data && Array.isArray(result.data.files)) ? result.data.files : [];
  const cloudPaths = new Set();
  for (const f of cloudFiles) {
    if (!f || f.binary) continue;
    const normalized = normalizeCloudPath(f.path);
    if (!normalized) continue;
    if (isIgnoredSyncPath(normalized)) continue;
    if (path.basename(normalized).startsWith('.')) continue;
    cloudPaths.add(normalized);
  }
  const orphanPaths = [];
  for (const p of cloudPaths) {
    if (!localFiles[p]) {
      orphanPaths.push(p);
    }
  }
  orphanPaths.sort();
  return {
    orphanPaths,
    localCount: Object.keys(localFiles).length,
    cloudCount: cloudPaths.size,
    ...biz,
  };
}

function renderCloudCleanSummary(orphanPaths, { dryRun = false, deleted = null, failed = null, localCount = 0 } = {}) {
  const count = orphanPaths.length;
  if (count === 0) {
    return 'No cloud orphans found.\n';
  }
  const fileLabel = count === 1 ? 'file' : 'files';
  const label = dryRun ? 'cloud clean (dry run):' : 'cloud clean:';
  const lines = [
    `${label} ${count} cloud ${fileLabel} not present locally:`,
    ...orphanPaths.map((p) => `  - ${p.replace(/^\//, '')}`),
    '',
  ];
  if (dryRun) {
    lines.push('pass --yes to delete these cloud files.');
  } else if (deleted !== null) {
    const parts = [];
    if (deleted > 0) parts.push(`${deleted} deleted`);
    if (failed > 0) parts.push(`${failed} failed`);
    if (parts.length === 0) parts.push(`${count} deleted`);
    lines.push(`${parts.join(', ')}. local files: ${localCount}`);
  } else {
    lines.push('pass --yes to delete these cloud files.');
  }
  return lines.join('\n') + '\n';
}

async function cloudClean(args = [], cwd = process.cwd(), deps = {}) {
  const d = { ...DEFAULT_DEPS, ...deps };
  const options = parseCloudCleanArgs(args);
  if (options.help || options.subcommand === 'help') {
    return {
      ok: true,
      output: [
        'Usage: atris cloud clean [business] [--dry-run] [--yes] [--delete-all]',
        '',
        'List or delete cloud files that are not present locally.',
        '',
        '  --dry-run     Preview which cloud files would be deleted',
        '  --yes         Delete the listed cloud files',
        '  --delete-all  Confirm a mass delete (required with --yes for large cleanups)',
        '',
      ].join('\n') + '\n',
    };
  }
  if (options.subcommand !== 'clean') {
    throw new Error(`Unknown cloud subcommand: ${options.subcommand}. Try: atris cloud clean --help`);
  }
  const slug = options.slug || readCloudCleanSlug(cwd, args);
  if (!slug) {
    throw new Error('No business workspace found. Run inside a business workspace or pass a business slug.');
  }
  const { orphanPaths, localCount, businessId, workspaceId } = await collectCloudOrphans(cwd, slug, d);
  if (orphanPaths.length === 0) {
    return { ok: true, output: 'No cloud orphans found.\n' };
  }
  if (!options.yes) {
    return {
      ok: true,
      output: renderCloudCleanSummary(orphanPaths, { dryRun: options.dryRun, localCount }),
    };
  }
  if (isMassDeletePlan({ deletedPaths: orphanPaths, filesToPush: [], unchangedCount: localCount }) && !options.deleteAll) {
    throw new Error(
      `mass delete guard: ${orphanPaths.length} cloud files would be deleted with only ${localCount} local files present.\n` +
      'this looks like a wrong source root or empty local copy. pass --delete-all with --yes to confirm.'
    );
  }
  let deleted = 0;
  let failed = 0;
  const credentials = d.loadCredentials();
  for (let i = 0; i < orphanPaths.length; i++) {
    const filePath = orphanPaths[i];
    if (i > 0) {
      await new Promise((r) => setTimeout(r, 600));
    }
    let result = await d.apiRequestJson(
      `/business/${businessId}/workspaces/${workspaceId}/file?path=${encodeURIComponent(filePath)}`,
      { method: 'DELETE', token: credentials.token }
    );
    if (result.status === 429) {
      await new Promise((r) => setTimeout(r, 20000));
      result = await d.apiRequestJson(
        `/business/${businessId}/workspaces/${workspaceId}/file?path=${encodeURIComponent(filePath)}`,
        { method: 'DELETE', token: credentials.token }
      );
    }
    if (result.ok || result.status === 404) {
      deleted++;
    } else {
      failed++;
    }
  }
  return {
    ok: failed === 0,
    output: renderCloudCleanSummary(orphanPaths, { dryRun: false, deleted, failed, localCount }),
  };
}

function cloudAtris() {
  const args = process.argv.slice(3);
  cloudClean(args, process.cwd())
    .then((result) => {
      process.stdout.write(result.output || '');
      process.exit(result.ok ? 0 : 1);
    })
    .catch((err) => {
      console.error(`\n✗ Error: ${err.message || err}`);
      process.exit(1);
    });
}

module.exports = {
  cloudAtris,
  cloudClean,
  collectCloudOrphans,
  parseCloudCleanArgs,
  readCloudCleanSlug,
  renderCloudCleanSummary,
};
