const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { loadCredentials } = require('../utils/auth');
const { apiRequestJson } = require('../utils/api');
const { loadBusinesses, saveBusinesses } = require('./business');
const { loadManifest, saveManifest, buildManifest, computeLocalHashes } = require('../lib/manifest');
const { normalizeWikiOnlyPrefix } = require('../lib/wiki');

async function pushAtris() {
  let slug = process.argv[3];

  // Auto-detect business from .atris/business.json in current dir
  if (!slug || slug.startsWith('-')) {
    const bizFile = path.join(process.cwd(), '.atris', 'business.json');
    if (fs.existsSync(bizFile)) {
      try {
        const biz = JSON.parse(fs.readFileSync(bizFile, 'utf8'));
        slug = biz.slug || biz.name;
      } catch {}
    }
    if (!slug || slug.startsWith('-')) slug = null;
  }

  if (!slug || slug === '--help') {
    console.log('Usage: atris push [business] [--from <path>] [--only <prefix>] [--force]');
    console.log('');
    console.log('  atris push                   Push from current folder (auto-detect business)');
    console.log('  atris push pallet            Push pallet/ or atris/pallet/');
    console.log('  atris push pallet --only team/nate   Only push files in team/nate/');
    console.log('  atris push --force           Override conflicts');
    process.exit(0);
  }

  const force = process.argv.includes('--force');
  const dryRun = process.argv.includes('--dry-run');

  // Parse --only
  let onlyRaw = null;
  const onlyEq = process.argv.find(a => a.startsWith('--only='));
  if (onlyEq) onlyRaw = onlyEq.slice(7);
  else {
    const oi = process.argv.indexOf('--only');
    if (oi !== -1 && process.argv[oi + 1] && !process.argv[oi + 1].startsWith('-')) onlyRaw = process.argv[oi + 1];
  }
  const onlyPrefixes = onlyRaw
    ? onlyRaw.split(',').map(p => {
        const wikiPrefix = normalizeWikiOnlyPrefix(p);
        if (wikiPrefix) return `/${wikiPrefix.replace(/^\//, '')}`;
        let n = '/' + p.replace(/^\//, '');
        if (!n.endsWith('/') && !n.includes('.')) n += '/';
        return n;
      })
    : null;

  const creds = loadCredentials();
  if (!creds || !creds.token) { console.error('Not logged in. Run: atris login'); process.exit(1); }

  // Determine source directory
  const fromIdx = process.argv.indexOf('--from');
  let sourceDir;
  if (fromIdx !== -1 && process.argv[fromIdx + 1]) {
    sourceDir = path.resolve(process.argv[fromIdx + 1]);
  } else if (fs.existsSync(path.join(process.cwd(), '.atris', 'business.json'))) {
    sourceDir = process.cwd();
  } else {
    const atrisDir = path.join(process.cwd(), 'atris', slug);
    const cwdDir = path.join(process.cwd(), slug);
    if (fs.existsSync(atrisDir)) sourceDir = atrisDir;
    else if (fs.existsSync(cwdDir)) sourceDir = cwdDir;
    else {
      console.error(`No local folder found for "${slug}".`);
      console.error('Run from inside a pulled folder, or: atris push pallet --from ./path');
      process.exit(1);
    }
  }

  if (!fs.existsSync(sourceDir)) { console.error(`Source not found: ${sourceDir}`); process.exit(1); }

  // Resolve business — always refresh from API
  let businessId, workspaceId, businessName, resolvedSlug;
  const businesses = loadBusinesses();
  const listResult = await apiRequestJson('/business/', { method: 'GET', token: creds.token });
  if (listResult.ok) {
    const match = (listResult.data || []).find(b => b.slug === slug || b.name.toLowerCase() === slug.toLowerCase());
    if (!match) { console.error(`Business "${slug}" not found.`); process.exit(1); }
    businessId = match.id;
    workspaceId = match.workspace_id;
    businessName = match.name;
    resolvedSlug = match.slug;
    businesses[slug] = { business_id: businessId, workspace_id: workspaceId, name: businessName, slug: match.slug, added_at: new Date().toISOString() };
    saveBusinesses(businesses);
  } else if (businesses[slug]) {
    businessId = businesses[slug].business_id;
    workspaceId = businesses[slug].workspace_id;
    businessName = businesses[slug].name || slug;
    resolvedSlug = businesses[slug].slug || slug;
  } else {
    console.error(`Failed to reach API and no cached business for "${slug}".`);
    process.exit(1);
  }

  if (!workspaceId) { console.error(`Business "${slug}" has no workspace.`); process.exit(1); }

  // Load manifest and compute local hashes
  const manifest = loadManifest(resolvedSlug || slug);
  const localFiles = computeLocalHashes(sourceDir);

  if (Object.keys(localFiles).length === 0) {
    console.log(`\nNo files to push from ${sourceDir}`);
    return;
  }

  console.log('');
  console.log(`Pushing to ${businessName}...`);

  // Compare local hashes to manifest — NO server call needed
  // Files where local hash differs from manifest = changed locally
  const baseFiles = (manifest && manifest.files) ? manifest.files : {};
  const filesToPush = [];
  const deletedPaths = [];

  for (const [filePath, fileInfo] of Object.entries(localFiles)) {
    if (onlyPrefixes && !onlyPrefixes.some(p => filePath.startsWith(p))) continue;
    const baseHash = baseFiles[filePath] ? baseFiles[filePath].hash : null;
    if (!baseHash || fileInfo.hash !== baseHash) {
      // Changed or new — push it
      const localPath = path.join(sourceDir, filePath.replace(/^\//, ''));
      try {
        const content = fs.readFileSync(localPath, 'utf8');
        filesToPush.push({ path: filePath, content });
      } catch {}
    }
  }

  for (const filePath of Object.keys(baseFiles)) {
    if (onlyPrefixes && !onlyPrefixes.some(p => filePath.startsWith(p))) continue;
    if (!localFiles[filePath]) {
      deletedPaths.push(filePath);
    }
  }

  const filteredLocalCount = Object.keys(localFiles).filter(filePath => {
    if (!onlyPrefixes) return true;
    return onlyPrefixes.some(prefix => filePath.startsWith(prefix));
  }).length;
  const unchangedCount = Math.max(0, filteredLocalCount - filesToPush.length);

  if (filesToPush.length === 0 && deletedPaths.length === 0) {
    console.log('\n  Already up to date.\n');
    return;
  }

  // Dry run — show what would be pushed without pushing
  if (dryRun) {
    console.log('');
    for (const f of filesToPush) {
      const isNew = !baseFiles[f.path];
      console.log(`  ${isNew ? '+' : '\u2191'} ${f.path.replace(/^\//, '')}  ${isNew ? 'new file' : 'updated'}  (dry run)`);
    }
    for (const filePath of deletedPaths) {
      console.log(`  x ${filePath.replace(/^\//, '')}  deleted  (dry run)`);
    }
    const parts = [];
    if (filesToPush.length > 0) parts.push(`${filesToPush.length} would be pushed`);
    if (deletedPaths.length > 0) parts.push(`${deletedPaths.length} would be deleted`);
    if (unchangedCount > 0) parts.push(`${unchangedCount} unchanged`);
    console.log(`\n  ${parts.join(', ')}. (--dry-run, nothing sent)\n`);
    return;
  }

  let pushed = 0;
  let deleted = 0;
  let skipped = [];
  let result = { ok: true };

  if (filesToPush.length > 0) {
    // Push files to server
    result = await apiRequestJson(
      `/business/${businessId}/workspaces/${workspaceId}/sync`,
      { method: 'POST', token: creds.token, body: { files: filesToPush }, headers: { 'X-Atris-Actor-Source': 'cli' } }
    );

    if (!result.ok) {
      if (result.status === 403) {
        // Permission denied — retry with only team/ and journal/ files
        const allowed = filesToPush.filter(f => f.path.startsWith('/team/') || f.path.startsWith('/journal/'));
        skipped = filesToPush.filter(f => !f.path.startsWith('/team/') && !f.path.startsWith('/journal/'));

        if (allowed.length > 0) {
          const retry = await apiRequestJson(
            `/business/${businessId}/workspaces/${workspaceId}/sync`,
            { method: 'POST', token: creds.token, body: { files: allowed }, headers: { 'X-Atris-Actor-Source': 'cli' } }
          );
          if (retry.ok) {
            pushed = allowed.length;
          } else {
            console.error(`\n  Push failed: ${retry.errorMessage || retry.error || retry.status}`);
            process.exit(1);
          }
        } else {
          console.error('\n  Access denied: you can only push to your team/ folder.');
          process.exit(1);
        }
      } else if (result.status === 409) {
        console.error('\n  Computer is sleeping. Wake it first.');
        process.exit(1);
      } else {
        console.error(`\n  Push failed: ${result.errorMessage || result.error || result.status}`);
        process.exit(1);
      }
    } else {
      pushed = filesToPush.length;
    }
  }

  for (const filePath of deletedPaths) {
    const deleteResult = await apiRequestJson(
      `/business/${businessId}/workspaces/${workspaceId}/file?path=${encodeURIComponent(filePath)}`,
      { method: 'DELETE', token: creds.token }
    );
    if (!deleteResult.ok && deleteResult.status !== 404) {
      console.error(`\n  Delete failed for ${filePath.replace(/^\//, '')}: ${deleteResult.error || deleteResult.status}`);
      process.exit(1);
    }
    deleted++;
  }

  // Display results
  console.log('');
  for (const f of filesToPush) {
    if (skipped.includes(f)) continue;
    const isNew = !baseFiles[f.path];
    console.log(`  ${isNew ? '+' : '\u2191'} ${f.path.replace(/^\//, '')}  ${isNew ? 'new file' : 'updated'}`);
  }
  for (const f of skipped) {
    console.log(`  - ${f.path.replace(/^\//, '')}  skipped (no permission)`);
  }
  for (const filePath of deletedPaths) {
    console.log(`  x ${filePath.replace(/^\//, '')}  deleted`);
  }

  // Summary
  console.log('');
  const parts = [];
  if (pushed > 0) parts.push(`${pushed} pushed`);
  if (deleted > 0) parts.push(`${deleted} deleted`);
  if (unchangedCount > 0) parts.push(`${unchangedCount} unchanged`);
  if (skipped.length > 0) parts.push(`${skipped.length} skipped`);
  console.log(`  ${parts.join(', ')}.`);

  // Update manifest — mark pushed files with their new hash
  const updatedFiles = { ...baseFiles };
  for (const f of filesToPush) {
    if (!skipped.includes(f)) {
      updatedFiles[f.path] = localFiles[f.path];
    }
  }
  for (const filePath of deletedPaths) {
    delete updatedFiles[filePath];
  }
  saveManifest(resolvedSlug || slug, buildManifest(updatedFiles, null));
}

module.exports = { pushAtris };
