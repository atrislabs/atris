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
    console.log('  Push requires a fresh pull. If cloud has changed since your last pull,');
    console.log('  the push will be blocked until you run `atris pull`. Use --force to override.');
    console.log('');
    console.log('  atris push                   Push from current folder (auto-detect business)');
    console.log('  atris push pallet            Push pallet/ or atris/pallet/');
    console.log('  atris push pallet --only team/nate   Only push files in team/nate/');
    console.log('  atris push --force           Bypass freshness check (force-push, may overwrite cloud changes)');
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

  // Auto-wake the EC2 computer if --auto-wake is set, otherwise check status and warn.
  // Without this, push silently routes to agent_files cache when computer is asleep
  // (the silent fallback footgun from tonight's debugging).
  const autoWake = process.argv.includes('--auto-wake');
  if (autoWake) {
    const statusResult = await apiRequestJson(`/business/${businessId}/ai-computer/status`, { method: 'GET', token: creds.token });
    const computerStatus = statusResult.ok && statusResult.data ? statusResult.data.status : 'unknown';
    if (computerStatus !== 'running' || !(statusResult.data && statusResult.data.endpoint)) {
      process.stdout.write('  Waking EC2 computer... ');
      await apiRequestJson(`/business/${businessId}/ai-computer/wake`, { method: 'POST', token: creds.token });
      const wakeStart = Date.now();
      while (Date.now() - wakeStart < 90000) {
        await new Promise((r) => setTimeout(r, 3000));
        const s = await apiRequestJson(`/business/${businessId}/ai-computer/status`, { method: 'GET', token: creds.token });
        if (s.ok && s.data && s.data.status === 'running' && s.data.endpoint) {
          const elapsed = Math.floor((Date.now() - wakeStart) / 1000);
          console.log(`awake (${elapsed}s)`);
          break;
        }
      }
    }
  }

  // Load manifest and compute local hashes
  const manifest = loadManifest(resolvedSlug || slug);
  const localFiles = computeLocalHashes(sourceDir);

  if (Object.keys(localFiles).length === 0) {
    console.log(`\nNo files to push from ${sourceDir}`);
    return;
  }

  console.log('');
  console.log(`Pushing to ${businessName}...`);

  // ───────────────────────────────────────────────────────────────────
  // FRESHNESS CHECK — pull-before-push enforcement.
  // ───────────────────────────────────────────────────────────────────
  // Compare cloud's current state to our local manifest. If cloud has any
  // file the manifest doesn't know about, OR a file with a different hash
  // than what we last pulled, the user is out of date and MUST pull first.
  // This prevents stale local state from clobbering fresh cloud changes —
  // the "lagging version push" footgun. Use --force to bypass (e.g., for
  // genuine local-canonical pushes like align --hard).
  if (!force) {
    process.stdout.write('  Checking cloud freshness... ');
    const snapshotResult = await apiRequestJson(
      `/business/${businessId}/workspaces/${workspaceId}/snapshot?include_content=false`,
      { method: 'GET', token: creds.token, timeoutMs: 60000 }
    );
    if (snapshotResult.ok && snapshotResult.data && Array.isArray(snapshotResult.data.files)) {
      const cloudHashes = {};
      for (const f of snapshotResult.data.files) {
        if (f.path && f.hash) cloudHashes[f.path] = f.hash;
      }
      const manifestFiles = (manifest && manifest.files) || {};
      const driftFiles = [];
      // Direction 1: cloud has files the manifest doesn't know about, OR
      // cloud's hash differs from what we last pulled (someone changed it).
      for (const [p, hash] of Object.entries(cloudHashes)) {
        // Apply --only filter to drift detection too: if user is scoping the
        // push to a subtree, only block on drift inside that subtree.
        if (onlyPrefixes && !onlyPrefixes.some((pref) => p.startsWith(pref))) continue;
        const manifestEntry = manifestFiles[p];
        if (!manifestEntry || manifestEntry.hash !== hash) {
          driftFiles.push(p);
        }
      }
      // Direction 2: manifest has files the cloud no longer has (someone
      // deleted them). Without this check, we'd silently re-push deleted
      // files on the next push, undoing the deletion.
      //
      // CAVEAT: the warm runner's snapshot endpoint deliberately hides certain
      // basenames (CLAUDE.md, .* dotfiles, node_modules, __pycache__, .git) —
      // see ecs_warm_runner.py _snapshot_dir. They CAN exist on cloud but
      // never appear in cloudHashes. Skip them in the missing-side check or
      // every CLAUDE.md push will be flagged as drift forever.
      const SERVER_HIDDEN_BASENAMES = new Set(['CLAUDE.md']);
      const cloudPathSet = new Set(Object.keys(cloudHashes));
      for (const p of Object.keys(manifestFiles)) {
        if (onlyPrefixes && !onlyPrefixes.some((pref) => p.startsWith(pref))) continue;
        const idx = p.lastIndexOf('/');
        const base = idx === -1 ? p : p.slice(idx + 1);
        if (SERVER_HIDDEN_BASENAMES.has(base)) continue;
        if (!cloudPathSet.has(p)) {
          driftFiles.push(p);
        }
      }
      if (driftFiles.length > 0) {
        console.log(`drift detected (${driftFiles.length} file${driftFiles.length === 1 ? '' : 's'})`);
        console.log('');
        console.log(`  ✗ Cloud has changed since your last pull. Refusing to push stale state.`);
        console.log('');
        console.log('    Files that differ on cloud:');
        driftFiles.slice(0, 8).forEach((p) => console.log(`      ~ ${p.replace(/^\//, '')}`));
        if (driftFiles.length > 8) console.log(`      ... +${driftFiles.length - 8} more`);
        console.log('');
        console.log('    Run `atris pull` first, then push your changes.');
        console.log('    To override (force-push, may clobber cloud edits): atris push --force');
        process.exit(1);
      }
      console.log('fresh');
    } else {
      // Snapshot fetch failed — fail closed. The whole point of the freshness
      // check is to prevent accidental stale pushes; if we can't verify cloud
      // state, we don't push. Use --force to bypass when you know what you're
      // doing (e.g., the workspace is genuinely unhealthy and you have a clean
      // local copy you need to recover from).
      console.log(`failed (status ${snapshotResult.status || 'unknown'})`);
      console.log('');
      console.log('  ✗ Could not verify cloud freshness. Refusing to push.');
      console.log('    The workspace may be unreachable or the snapshot endpoint is broken.');
      console.log('    To bypass and force-push anyway: atris push --force');
      process.exit(1);
    }
  }

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

  // Delete loop — throttled, 429-aware, tracks per-file success/failure.
  // Earlier bug: bulk deletes hit rate limit (60/min default) at request 60,
  // then process.exit'd, leaving partial state and a manifest that thought
  // everything was deleted. New behavior:
  //   - 600ms throttle between deletes (≈100/min, safe under default rate limit)
  //   - 429 → wait 20s, retry once
  //   - 404 → counted as success (file already gone)
  //   - other failures → collected, reported at end, do NOT exit
  //   - manifest update only counts confirmed-deleted paths
  const deletedConfirmed = [];
  const deleteFailed = [];
  for (let i = 0; i < deletedPaths.length; i++) {
    const filePath = deletedPaths[i];
    if (i > 0) {
      // sleep 600ms between deletes
      await new Promise((r) => setTimeout(r, 600));
    }
    let deleteResult = await apiRequestJson(
      `/business/${businessId}/workspaces/${workspaceId}/file?path=${encodeURIComponent(filePath)}`,
      { method: 'DELETE', token: creds.token }
    );
    if (deleteResult.status === 429) {
      // Rate limit — wait 20s, retry once
      await new Promise((r) => setTimeout(r, 20000));
      deleteResult = await apiRequestJson(
        `/business/${businessId}/workspaces/${workspaceId}/file?path=${encodeURIComponent(filePath)}`,
        { method: 'DELETE', token: creds.token }
      );
    }
    if (deleteResult.ok || deleteResult.status === 404) {
      deletedConfirmed.push(filePath);
      deleted++;
    } else {
      deleteFailed.push({ path: filePath, status: deleteResult.status, error: deleteResult.error });
    }
    // Show progress for large batches
    if (deletedPaths.length > 20 && (i + 1) % 20 === 0) {
      console.log(`  [delete ${i + 1}/${deletedPaths.length}] ${deletedConfirmed.length} ok, ${deleteFailed.length} failed`);
    }
  }
  if (deleteFailed.length > 0) {
    console.log('');
    console.log(`  ⚠ ${deleteFailed.length} delete(s) failed (NOT marked as deleted in manifest):`);
    deleteFailed.slice(0, 10).forEach((f) => console.log(`    ${f.status} ${f.path.replace(/^\//, '')}`));
    if (deleteFailed.length > 10) console.log(`    ... +${deleteFailed.length - 10} more`);
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
  // Only print confirmed deletes (not failed ones — they were reported above)
  for (const filePath of deletedConfirmed) {
    console.log(`  x ${filePath.replace(/^\//, '')}  deleted`);
  }

  // Summary
  console.log('');
  const parts = [];
  if (pushed > 0) parts.push(`${pushed} pushed`);
  if (deleted > 0) parts.push(`${deleted} deleted`);
  if (deleteFailed.length > 0) parts.push(`${deleteFailed.length} delete failed`);
  if (unchangedCount > 0) parts.push(`${unchangedCount} unchanged`);
  if (skipped.length > 0) parts.push(`${skipped.length} skipped`);
  console.log(`  ${parts.join(', ')}.`);

  // Update manifest — mark pushed files with their new hash, drop ONLY confirmed deletes.
  // Failed deletes stay in the manifest so the next push will retry them.
  const updatedFiles = { ...baseFiles };
  for (const f of filesToPush) {
    if (!skipped.includes(f)) {
      updatedFiles[f.path] = localFiles[f.path];
    }
  }
  for (const filePath of deletedConfirmed) {
    delete updatedFiles[filePath];
  }
  saveManifest(resolvedSlug || slug, buildManifest(updatedFiles, null));
}

module.exports = { pushAtris };
