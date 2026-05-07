const { loadCredentials } = require('../utils/auth');
const { apiRequestJson } = require('../utils/api');
const { loadBusinesses, saveBusinesses } = require('./business');

// Junk detection patterns
const JUNK_PATTERNS = {
  emptyFiles: (file) => (file.size || 0) <= 1,
  versionedDuplicates: (file) => /_v\d+\.\w+$/.test(file.path),
  actionQueues: (file) => /action_queue\.json$/.test(file.path),
  agentOutputDumps: (file) => /^\/?(agents\/[^/]+\/output\/)/.test(file.path),
  researchDumps: (file) => /^\/?(agents\/[^/]+\/research\/)/.test(file.path),
};

const JUNK_LABELS = {
  emptyFiles: 'Empty files (size <= 1 byte)',
  versionedDuplicates: 'Versioned duplicates (*_v1, *_v2, etc.)',
  actionQueues: 'Action queue files',
  agentOutputDumps: 'Agent output dumps (agents/*/output/)',
  researchDumps: 'Research dumps (agents/*/research/)',
};

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
}

async function cleanWorkspace() {
  const slug = process.argv[3];
  const autoConfirm = process.argv.includes('--yes');

  if (!slug || slug === '--help' || slug === '-h' || slug === 'help') {
    console.log('');
    console.log('Usage: atris clean-workspace <business-slug> [--yes]');
    console.log('');
    console.log('Analyzes a workspace for junk files and shows a cleanup report.');
    console.log('Pass --yes to actually delete the detected junk.');
    console.log('');
    console.log('Detects:');
    console.log('  - Empty files (0-1 bytes)');
    console.log('  - Versioned duplicates (*_v1.md, *_v2.md, etc.)');
    console.log('  - action_queue.json files');
    console.log('  - Agent output dumps (agents/*/output/)');
    console.log('  - Research dumps (agents/*/research/)');
    console.log('');
    return;
  }

  // Auth
  const creds = loadCredentials();
  if (!creds || !creds.token) {
    console.error('Not logged in. Run: atris login');
    process.exit(1);
  }

  // Resolve business
  let businessId, workspaceId, businessName;
  const businesses = loadBusinesses();

  if (businesses[slug]) {
    businessId = businesses[slug].business_id;
    workspaceId = businesses[slug].workspace_id;
    businessName = businesses[slug].name || slug;
  } else {
    const listResult = await apiRequestJson('/business/', { method: 'GET', token: creds.token });
    if (!listResult.ok) {
      console.error(`Failed to fetch businesses: ${listResult.error || listResult.status}`);
      process.exit(1);
    }
    const match = (listResult.data || []).find(
      b => b.slug === slug || b.name.toLowerCase() === slug.toLowerCase()
    );
    if (!match) {
      console.error(`Business "${slug}" not found.`);
      process.exit(1);
    }
    businessId = match.id;
    workspaceId = match.workspace_id;
    businessName = match.name;

    // Cache for next time
    businesses[slug] = {
      business_id: businessId,
      workspace_id: workspaceId,
      name: businessName,
      slug: match.slug,
      added_at: new Date().toISOString(),
    };
    saveBusinesses(businesses);
  }

  if (!workspaceId) {
    console.error(`Business "${slug}" has no workspace.`);
    process.exit(1);
  }

  // Fetch snapshot (metadata only)
  console.log('');
  console.log(`Scanning ${businessName}...`);

  const result = await apiRequestJson(
    `/business/${businessId}/workspaces/${workspaceId}/snapshot?include_content=false`,
    { method: 'GET', token: creds.token, timeoutMs: 60000 }
  );

  if (!result.ok) {
    const msg = result.error || `HTTP ${result.status}`;
    if (result.status === 409) {
      console.error('\n  Computer is sleeping. Wake it first.');
    } else if (result.status === 403) {
      console.error(`\n  Access denied for "${slug}".`);
    } else if (result.status === 404) {
      console.error(`\n  Business "${slug}" not found.`);
    } else {
      console.error(`\n  Failed: ${msg}`);
    }
    process.exit(1);
  }

  const files = result.data.files || [];
  if (files.length === 0) {
    console.log('  Workspace is empty. Nothing to clean.');
    return;
  }

  // Analyze workspace
  const totalSize = files.reduce((sum, f) => sum + (f.size || 0), 0);

  // Directory breakdown
  const dirStats = {};
  for (const file of files) {
    const p = (file.path || '').replace(/^\//, '');
    const topDir = p.includes('/') ? p.split('/')[0] : '(root)';
    if (!dirStats[topDir]) dirStats[topDir] = { count: 0, size: 0 };
    dirStats[topDir].count++;
    dirStats[topDir].size += file.size || 0;
  }

  // Detect junk
  const junkByCategory = {};
  const allJunkPaths = new Set();

  for (const [key, testFn] of Object.entries(JUNK_PATTERNS)) {
    const matches = files.filter(testFn);
    if (matches.length > 0) {
      junkByCategory[key] = matches;
      for (const m of matches) allJunkPaths.add(m.path);
    }
  }

  const junkSize = files
    .filter(f => allJunkPaths.has(f.path))
    .reduce((sum, f) => sum + (f.size || 0), 0);

  // Print report
  console.log('');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  Workspace: ${businessName}`);
  console.log(`  Total files: ${files.length}    Total size: ${formatBytes(totalSize)}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  // Directory breakdown
  console.log('');
  console.log('  Files by directory:');
  const sortedDirs = Object.entries(dirStats).sort((a, b) => b[1].size - a[1].size);
  for (const [dir, stats] of sortedDirs) {
    const pct = totalSize > 0 ? ((stats.size / totalSize) * 100).toFixed(0) : 0;
    console.log(`    ${dir.padEnd(30)} ${String(stats.count).padStart(5)} files  ${formatBytes(stats.size).padStart(10)}  (${pct}%)`);
  }

  // Junk report
  console.log('');
  if (allJunkPaths.size === 0) {
    console.log('  No junk detected. Workspace is clean.');
    console.log('');
    return;
  }

  console.log('  Junk detected:');
  console.log('');

  for (const [key, matches] of Object.entries(junkByCategory)) {
    const catSize = matches.reduce((sum, f) => sum + (f.size || 0), 0);
    console.log(`    ${JUNK_LABELS[key]}  (${matches.length} files, ${formatBytes(catSize)})`);

    // Show up to 10 example paths
    const show = matches.slice(0, 10);
    for (const f of show) {
      console.log(`      - ${(f.path || '').replace(/^\//, '')}  (${formatBytes(f.size || 0)})`);
    }
    if (matches.length > 10) {
      console.log(`      ... and ${matches.length - 10} more`);
    }
    console.log('');
  }

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  Would remove: ${allJunkPaths.size} files (${formatBytes(junkSize)})`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('');

  if (!autoConfirm) {
    console.log('  Run with --yes to clean up:');
    console.log(`    atris clean-workspace ${slug} --yes`);
    console.log('');
    return;
  }

  // Delete junk by syncing empty content
  console.log('  Cleaning...');

  const filesToDelete = Array.from(allJunkPaths).map(p => ({ path: p, content: '' }));

  // Batch in chunks of 50 to avoid huge payloads
  const BATCH_SIZE = 50;
  let deleted = 0;

  for (let i = 0; i < filesToDelete.length; i += BATCH_SIZE) {
    const batch = filesToDelete.slice(i, i + BATCH_SIZE);

    const syncResult = await apiRequestJson(
      `/business/${businessId}/workspaces/${workspaceId}/sync`,
      {
        method: 'POST',
        token: creds.token,
        body: { files: batch },
        headers: { 'X-Atris-Actor-Source': 'cli' },
      }
    );

    if (!syncResult.ok) {
      const msg = syncResult.error || `HTTP ${syncResult.status}`;
      console.error(`\n  Cleanup failed at batch ${Math.floor(i / BATCH_SIZE) + 1}: ${msg}`);
      process.exit(1);
    }

    deleted += batch.length;
    if (filesToDelete.length > BATCH_SIZE) {
      console.log(`    ${deleted}/${filesToDelete.length} files processed...`);
    }
  }

  console.log('');
  console.log(`  Done. Removed ${deleted} junk files (${formatBytes(junkSize)}).`);
  console.log('');
}

module.exports = { cleanWorkspace };
