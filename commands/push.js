const fs = require('fs');
const path = require('path');
const { loadCredentials } = require('../utils/auth');
const { apiRequestJson } = require('../utils/api');
const { loadBusinesses, saveBusinesses } = require('./business');
const { loadManifest, saveManifest, computeFileHash, buildManifest, computeLocalHashes, threeWayCompare, SKIP_DIRS } = require('../lib/manifest');
const { sectionMerge } = require('../lib/section-merge');

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
  }

  if (!slug || slug === '--help') {
    console.log('Usage: atris push [business-slug] [--from <path>] [--force]');
    console.log('');
    console.log('Push local files to a Business Computer.');
    console.log('If run inside a pulled folder, business is auto-detected.');
    console.log('');
    console.log('Options:');
    console.log('  --from <path>   Push from a custom directory');
    console.log('  --force         Push everything, overwrite conflicts');
    console.log('');
    console.log('Examples:');
    console.log('  atris push                           Auto-detect from current folder');
    console.log('  atris push pallet                    Push from atris/pallet/ or ./pallet/');
    console.log('  atris push pallet --from ./my-dir/   Push from a custom directory');
    process.exit(0);
  }

  const force = process.argv.includes('--force');

  // Parse --only flag: filter which files to push
  let onlyRaw = null;
  const onlyEqArg = process.argv.find(a => a.startsWith('--only='));
  if (onlyEqArg) {
    onlyRaw = onlyEqArg.slice('--only='.length);
  } else {
    const onlyIdx = process.argv.indexOf('--only');
    if (onlyIdx !== -1 && process.argv[onlyIdx + 1] && !process.argv[onlyIdx + 1].startsWith('-')) {
      onlyRaw = process.argv[onlyIdx + 1];
    }
  }
  const onlyPrefixes = onlyRaw
    ? onlyRaw.split(',').map(p => {
        let norm = p.replace(/^\//, '');
        if (norm && !norm.endsWith('/') && !norm.includes('.')) norm += '/';
        return '/' + norm;
      }).filter(Boolean)
    : null;

  const creds = loadCredentials();
  if (!creds || !creds.token) {
    console.error('Not logged in. Run: atris login');
    process.exit(1);
  }

  // Determine source directory
  const fromIdx = process.argv.indexOf('--from');
  let sourceDir;
  if (fromIdx !== -1 && process.argv[fromIdx + 1]) {
    sourceDir = path.resolve(process.argv[fromIdx + 1]);
  } else if (fs.existsSync(path.join(process.cwd(), '.atris', 'business.json'))) {
    // Inside a pulled folder — push from here
    sourceDir = process.cwd();
  } else {
    const atrisDir = path.join(process.cwd(), 'atris', slug);
    const cwdDir = path.join(process.cwd(), slug);
    if (fs.existsSync(atrisDir)) {
      sourceDir = atrisDir;
    } else if (fs.existsSync(cwdDir)) {
      sourceDir = cwdDir;
    } else {
      console.error(`No local folder found for "${slug}".`);
      console.error(`Expected: atris/${slug}/ or ./${slug}/`);
      console.error('Or specify: atris push pallet --from ./path/to/folder');
      process.exit(1);
    }
  }

  if (!fs.existsSync(sourceDir)) {
    console.error(`Source directory not found: ${sourceDir}`);
    process.exit(1);
  }

  // Resolve business ID
  let businessId, workspaceId, businessName, resolvedSlug;
  const businesses = loadBusinesses();

  if (businesses[slug]) {
    businessId = businesses[slug].business_id;
    workspaceId = businesses[slug].workspace_id;
    businessName = businesses[slug].name || slug;
    resolvedSlug = businesses[slug].slug || slug;
  } else {
    const listResult = await apiRequestJson('/businesses/', { method: 'GET', token: creds.token });
    if (!listResult.ok) {
      console.error(`Failed to fetch businesses: ${listResult.errorMessage || listResult.status}`);
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
    resolvedSlug = match.slug;

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

  // Load manifest (last sync state)
  const manifest = loadManifest(resolvedSlug || slug);

  // Compute local file hashes
  const localFiles = computeLocalHashes(sourceDir);

  if (Object.keys(localFiles).length === 0) {
    console.log(`\nNo files to push from ${sourceDir}`);
    return;
  }

  // Get remote snapshot for three-way compare
  console.log('');
  console.log(`Pushing to ${businessName}...`);

  // Loading indicator
  const startTime = Date.now();
  const spinner = ['|', '/', '-', '\\'];
  let spinIdx = 0;
  const loading = setInterval(() => {
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    process.stdout.write(`\r  Comparing with remote... ${spinner[spinIdx++ % 4]} ${elapsed}s`);
  }, 250);

  const snapshotResult = await apiRequestJson(
    `/businesses/${businessId}/workspaces/${workspaceId}/snapshot?include_content=true`,
    { method: 'GET', token: creds.token, timeoutMs: 300000 }
  );

  clearInterval(loading);
  const totalSec = Math.floor((Date.now() - startTime) / 1000);
  process.stdout.write(`\r  Compared in ${totalSec}s.${' '.repeat(20)}\n`);

  let remoteFiles = {};
  const remoteContent = {};  // for section merge
  if (snapshotResult.ok && snapshotResult.data && snapshotResult.data.files) {
    for (const file of snapshotResult.data.files) {
      if (file.path && !file.binary && file.content != null) {
        const rawBytes = Buffer.from(file.content, 'utf-8');
        const hash = require('crypto').createHash('sha256').update(rawBytes).digest('hex');
        remoteFiles[file.path] = { hash, size: rawBytes.length };
        remoteContent[file.path] = file.content;
      }
    }
  }

  // Three-way compare
  const diff = threeWayCompare(localFiles, remoteFiles, manifest);

  // Check if user is a member (not owner) — if so, filter to allowed paths
  // Members can only push to /team/{name}/ and /journal/
  let skippedPermission = [];
  const role = snapshotResult.data?._role; // not available from snapshot, so we try the push and handle 403

  // Determine what to push
  const filesToPush = [];

  // Apply --only filter
  const matchesOnly = (filePath) => {
    if (!onlyPrefixes) return true;
    return onlyPrefixes.some(prefix => filePath.startsWith(prefix));
  };

  // Files we changed that remote didn't
  for (const p of [...diff.toPush, ...diff.newLocal]) {
    if (!matchesOnly(p)) continue;
    const localPath = path.join(sourceDir, p.replace(/^\//, ''));
    try {
      const content = fs.readFileSync(localPath, 'utf8');
      filesToPush.push({ path: p, content });
    } catch {
      // skip
    }
  }

  // Handle conflicts: try section-level merge first, then force, then flag
  const conflictPaths = [];
  const mergedPaths = [];
  for (const p of diff.conflicts) {
    const localPath = path.join(sourceDir, p.replace(/^\//, ''));
    let localContent;
    try { localContent = fs.readFileSync(localPath, 'utf8'); } catch { continue; }

    if (force) {
      filesToPush.push({ path: p, content: localContent });
      continue;
    }

    // Try section-level merge (only for .md files)
    if (p.endsWith('.md') && remoteContent[p] && manifest && manifest.files && manifest.files[p]) {
      // Get base content: we need what the file looked like at last sync.
      // We don't store content in manifest, so use remote as best-effort base
      // when manifest hash matches neither side (true conflict).
      // For now, attempt merge with remote content and see if sections differ.
      const remote = remoteContent[p];
      // Simple heuristic: if one side only added content (appended sections), merge works
      const result = sectionMerge(remote, localContent, remote);
      // A better merge needs the base version. For now, try local-as-changed vs remote-as-base:
      const mergeResult = sectionMerge(remote, localContent, remote);
      if (mergeResult.merged && mergeResult.conflicts.length === 0 && mergeResult.merged !== remote) {
        filesToPush.push({ path: p, content: mergeResult.merged });
        mergedPaths.push(p);
        continue;
      }
    }

    conflictPaths.push(p);
  }

  console.log('');

  if (filesToPush.length === 0 && conflictPaths.length === 0) {
    console.log('  Already up to date.');
    console.log('');
    return;
  }

  // Push the files
  let pushed = 0;
  if (filesToPush.length > 0) {
    const result = await apiRequestJson(
      `/businesses/${businessId}/workspaces/${workspaceId}/sync`,
      {
        method: 'POST',
        token: creds.token,
        body: { files: filesToPush },
        headers: { 'X-Atris-Actor-Source': 'cli' },
      }
    );

    if (!result.ok) {
      const msg = result.errorMessage || result.error || `HTTP ${result.status}`;
      if (result.status === 409) {
        console.error(`  Computer is sleeping. Wake it first, then push.`);
      } else if (result.status === 403) {
        // Member scoping — retry with only team/ and journal/ files
        const memberFiles = filesToPush.filter(f => f.path.startsWith('/team/') || f.path.startsWith('/journal/'));
        const blockedFiles = filesToPush.filter(f => !f.path.startsWith('/team/') && !f.path.startsWith('/journal/'));
        if (memberFiles.length > 0 && blockedFiles.length > 0) {
          console.log(`  You're a member — retrying with your team files only...`);
          if (blockedFiles.length > 0) {
            console.log(`  Skipped (no permission): ${blockedFiles.map(f => f.path.replace(/^\//, '')).join(', ')}`);
          }
          const retry = await apiRequestJson(
            `/businesses/${businessId}/workspaces/${workspaceId}/sync`,
            { method: 'POST', token: creds.token, body: { files: memberFiles }, headers: { 'X-Atris-Actor-Source': 'cli' } }
          );
          if (retry.ok) {
            for (const f of memberFiles) {
              console.log(`  \u2191 ${f.path.replace(/^\//, '')}  pushed`);
              pushed++;
            }
          } else {
            console.error(`  Push failed after retry: ${retry.errorMessage || retry.error || retry.status}`);
            process.exit(1);
          }
        } else {
          console.error(`  Access denied: you can only push to your own team/ folder.`);
          if (blockedFiles.length > 0) {
            console.error(`  Blocked: ${blockedFiles.map(f => f.path.replace(/^\//, '')).join(', ')}`);
          }
          process.exit(1);
        }
      } else {
        console.error(`  Push failed: ${msg}`);
      }
      process.exit(1);
    }

    // Display results
    for (const p of diff.toPush) {
      console.log(`  \u2191 ${p.replace(/^\//, '')}  pushing your changes`);
      pushed++;
    }
    for (const p of diff.newLocal) {
      console.log(`  + ${p.replace(/^\//, '')}  new file`);
      pushed++;
    }
    if (force) {
      for (const p of diff.conflicts) {
        console.log(`  ! ${p.replace(/^\//, '')}  overwritten (--force)`);
        pushed++;
      }
    }
    for (const p of mergedPaths) {
      console.log(`  \u2194 ${p.replace(/^\//, '')}  auto-merged (different sections)`);
      pushed++;
    }
  }

  // Show conflicts
  for (const p of conflictPaths) {
    console.log(`  \u26A0 ${p.replace(/^\//, '')}  CONFLICT \u2014 skipped (use --force to override)`);
  }

  // Show unchanged
  if (diff.unchanged.length > 0) {
    // Don't list them all, just count
  }

  // Summary
  console.log('');
  const parts = [];
  if (pushed > 0) parts.push(`${pushed} pushed`);
  if (diff.unchanged.length > 0) parts.push(`${diff.unchanged.length} unchanged`);
  if (conflictPaths.length > 0) parts.push(`${conflictPaths.length} conflict${conflictPaths.length > 1 ? 's' : ''}`);
  if (parts.length > 0) console.log(`  ${parts.join(', ')}.`);

  // Get commit hash after push
  let commitHash = null;
  try {
    const headResult = await apiRequestJson(
      `/businesses/${businessId}/workspaces/${workspaceId}/git/head`,
      { method: 'GET', token: creds.token }
    );
    if (headResult.ok && headResult.data && headResult.data.commit) {
      commitHash = headResult.data.commit;
    }
  } catch {
    // Git might not be initialized yet
  }

  // Update manifest with new state (merge local + remote)
  const mergedFiles = { ...remoteFiles };
  for (const p of Object.keys(localFiles)) {
    if (filesToPush.some(f => f.path === p)) {
      mergedFiles[p] = localFiles[p]; // we pushed this, so our hash is now the truth
    }
  }
  const newManifest = buildManifest(mergedFiles, commitHash);
  saveManifest(resolvedSlug || slug, newManifest);
}

module.exports = { pushAtris };
