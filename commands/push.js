const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { loadCredentials } = require('../utils/auth');
const { apiRequestJson } = require('../utils/api');
const { loadBusinesses, saveBusinesses, businessMatchesSlug } = require('./business');
const { loadManifest, saveManifest, buildManifest, computeLocalHashes } = require('../lib/manifest');
const { normalizeWikiOnlyPrefix } = require('../lib/wiki');
const { emitSyncEvent, startTimer } = require('../lib/sync-telemetry');
const { assertSafeWorkspaceRoot } = require('../lib/workspace-safety');

async function pushAtris() {
  const elapsedMs = startTimer();
  let slug = process.argv[3];
  let _coldWake = false;

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

  // Refuse to walk/upload dangerous paths ($HOME, /, /Users, system dirs).
  assertSafeWorkspaceRoot(sourceDir, { slug, op: 'push from' });

  // Resolve business — always refresh from API
  let businessId, workspaceId, businessName, resolvedSlug;
  const businesses = loadBusinesses();
  const listResult = await apiRequestJson('/business/', { method: 'GET', token: creds.token });
  if (listResult.ok) {
    const match = (listResult.data || []).find(b => businessMatchesSlug(b, slug, { includeName: true }));
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

  // Telemetry helper — emits one event with the elapsed wall-clock time.
  // Awaited (not fire-and-forget) because process.exit kills in-flight requests.
  const emit = (outcome, extras = {}) =>
    emitSyncEvent(creds.token, businessId, workspaceId, 'push', outcome, elapsedMs(), extras);

  // Auto-wake the EC2 computer if --auto-wake is set, otherwise check status and warn.
  // Without this, push silently routes to agent_files cache when computer is asleep
  // (the silent fallback footgun from tonight's debugging).
  const autoWake = process.argv.includes('--auto-wake');
  if (autoWake) {
    const statusResult = await apiRequestJson(`/business/${businessId}/ai-computer/status`, { method: 'GET', token: creds.token });
    const computerStatus = statusResult.ok && statusResult.data ? statusResult.data.status : 'unknown';
    if (computerStatus !== 'running' || !(statusResult.data && statusResult.data.endpoint)) {
      process.stdout.write('  Waking EC2 computer... ');
      _coldWake = true;
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
        await emit('drift', { error_detail: `${driftFiles.length} file(s) drifted` });
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
      await emit('status_unknown', { error_detail: `snapshot status ${snapshotResult.status || 'unknown'}` });
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
    await emit('success', { files_unchanged: filteredLocalCount });
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
  // Files we sent that the server did not confirm as written/unchanged.
  // The /sync endpoint can silently drop files (role-based filters on the
  // business workspace route, path-rejection inside the warm runner, etc.)
  // and still return HTTP 200. If we don't cross-check per-file results,
  // the CLI prints "Pushed" for files that never actually landed — and
  // the manifest records a hash that makes the next push skip them too,
  // losing them permanently. `failedToLand` collects those casualties so
  // we can warn the user AND keep them out of the manifest update.
  let failedToLand = [];
  const landedPaths = new Set();
  let result = { ok: true };

  // Server-canonical path format for the /sync endpoint: NO leading slash.
  // The warm runner's _safe_path rejects `/atris/...` with "Absolute path
  // outside workspace" (it only accepts paths under `/workspace/...`). All
  // our internal bookkeeping uses a leading slash (manifest keys, localFiles
  // keys, snapshot response paths), so we strip only at the wire.
  const toWirePath = (p) => (p || '').replace(/^\/+/, '');
  const fromWirePath = (p) => {
    const s = String(p || '');
    return s.startsWith('/') ? s : `/${s}`;
  };
  const wireFiles = (files) => files.map((f) => ({ path: toWirePath(f.path), content: f.content }));

  // Inspect per-file results from a /sync response. Treat "written" and
  // "unchanged" as success; everything else (including missing-from-results,
  // which is how silent server-side drops look) is a failure.
  const recordSyncResults = (sentFiles, response) => {
    const resultsArr = response && response.data && Array.isArray(response.data.results)
      ? response.data.results
      : null;
    const seen = new Set();
    if (resultsArr) {
      for (const r of resultsArr) {
        if (!r || !r.path) continue;
        const status = String(r.status || '').toLowerCase();
        const canonical = fromWirePath(r.path);
        if (status === 'written' || status === 'unchanged') {
          landedPaths.add(canonical);
          seen.add(canonical);
        } else {
          failedToLand.push({ path: canonical, status: status || 'error', error: r.error || '' });
          seen.add(canonical);
        }
      }
    } else {
      // No results array in response — old server. Best-effort: assume
      // everything sent landed. This preserves existing behavior when
      // talking to a server that doesn't return per-file status.
      for (const f of sentFiles) {
        landedPaths.add(f.path);
        seen.add(f.path);
      }
    }
    // Any file we sent that the server didn't mention = silently dropped.
    for (const f of sentFiles) {
      if (!seen.has(f.path)) {
        failedToLand.push({ path: f.path, status: 'dropped', error: 'server did not confirm write' });
      }
    }
  };

  if (filesToPush.length > 0) {
    // Push files to server (strip leading slash — server requires workspace-relative paths)
    result = await apiRequestJson(
      `/business/${businessId}/workspaces/${workspaceId}/sync`,
      { method: 'POST', token: creds.token, body: { files: wireFiles(filesToPush) }, headers: { 'X-Atris-Actor-Source': 'cli' } }
    );

    if (!result.ok) {
      if (result.status === 403) {
        const detail = result.errorMessage || result.error || (result.data && result.data.detail) || '';
        if (detail && /plan required|business, max, or enterprise/i.test(detail)) {
          console.error(`\n  Access denied: ${detail}`);
          await emit('access_denied', { error_detail: detail });
          process.exit(1);
        }
        // Permission denied — retry with only team/ and journal/ files
        const allowed = filesToPush.filter(f => f.path.startsWith('/team/') || f.path.startsWith('/journal/'));
        skipped = filesToPush.filter(f => !f.path.startsWith('/team/') && !f.path.startsWith('/journal/'));

        if (allowed.length > 0) {
          const retry = await apiRequestJson(
            `/business/${businessId}/workspaces/${workspaceId}/sync`,
            { method: 'POST', token: creds.token, body: { files: wireFiles(allowed) }, headers: { 'X-Atris-Actor-Source': 'cli' } }
          );
          if (retry.ok) {
            recordSyncResults(allowed, retry);
            pushed = landedPaths.size;
          } else {
            console.error(`\n  Push failed: ${retry.errorMessage || retry.error || retry.status}`);
            await emit('access_denied', { error_detail: `403 retry failed: ${retry.status}` });
            process.exit(1);
          }
        } else {
          console.error('\n  Access denied: you can only push to your team/ folder.');
          await emit('access_denied');
          process.exit(1);
        }
      } else if (result.status === 409) {
        console.error('\n  Computer is sleeping. Wake it first.');
        await emit('cold_wake', { error_detail: 'computer sleeping (409)' });
        process.exit(1);
      } else {
        console.error(`\n  Push failed: ${result.errorMessage || result.error || result.status}`);
        await emit('status_unknown', { error_detail: `sync status ${result.status}` });
        process.exit(1);
      }
    } else {
      recordSyncResults(filesToPush, result);
      pushed = landedPaths.size;
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
  let _rateLimitedDeletes = 0;
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
      _rateLimitedDeletes++;
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

  // Display results — only for files the server confirmed as landed.
  // A non-technical user seeing "+ atris/ideas/foo.md new file" naturally
  // assumes foo.md is on cloud. So we only print that line when the server
  // actually confirmed it via per-file status. Anything else goes into the
  // loud failure block below.
  console.log('');
  for (const f of filesToPush) {
    if (skipped.includes(f)) continue;
    if (!landedPaths.has(f.path)) continue;
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

  // Loud failure block — files the server silently dropped or rejected.
  // These did NOT land on cloud even though the HTTP call returned 200.
  if (failedToLand.length > 0) {
    console.log('');
    console.log(`  ⚠ ${failedToLand.length} file(s) did NOT land on cloud (server returned 200 but`);
    console.log(`     dropped or rejected these files):`);
    const shown = failedToLand.slice(0, 15);
    for (const f of shown) {
      const detail = f.error ? ` — ${f.error}` : ` (${f.status})`;
      console.log(`    ✗ ${f.path.replace(/^\//, '')}${detail}`);
    }
    if (failedToLand.length > shown.length) {
      console.log(`    ... +${failedToLand.length - shown.length} more`);
    }
    console.log('');
    console.log('  Common causes: path is outside the workspace (e.g. absolute /Users/... path),');
    console.log('  your role lacks write permission for that folder, or warm runner returned an error.');
    console.log('  These files will appear as drift on your next push so you can retry.');
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
  //
  // CRITICAL: only record manifest entries for files the server confirmed as
  // landed (landedPaths). If we recorded the local hash for a file that the
  // server silently dropped, the next push would compare local==manifest and
  // skip it — the file would never land. Keeping it OUT of the manifest means
  // the next push sees it as new/changed and retries automatically.
  const updatedFiles = { ...baseFiles };
  for (const f of filesToPush) {
    if (skipped.includes(f)) continue;
    if (!landedPaths.has(f.path)) continue;
    updatedFiles[f.path] = localFiles[f.path];
  }
  for (const filePath of deletedConfirmed) {
    delete updatedFiles[filePath];
  }
  saveManifest(resolvedSlug || slug, buildManifest(updatedFiles, null));

  // Telemetry — outcome reflects actual run quality, not just exit-code-zero.
  // Partial delete failures or rate-limit retries mean the run was NOT a clean win;
  // labeling them success would poison the RL signal.
  const bytesChanged = filesToPush.reduce((acc, f) => acc + (f.content ? Buffer.byteLength(f.content, 'utf8') : 0), 0);
  let finalOutcome;
  let finalDetail;
  if (failedToLand.length > 0) {
    finalOutcome = 'status_unknown';
    finalDetail = `${failedToLand.length} file(s) silently dropped by server (statuses: ${[...new Set(failedToLand.map(f => f.status))].join(',')})`;
  } else if (deleteFailed.length > 0) {
    finalOutcome = 'status_unknown';
    finalDetail = `${deleteFailed.length} delete(s) failed (statuses: ${[...new Set(deleteFailed.map(f => f.status))].join(',')})`;
  } else if (_rateLimitedDeletes > 0) {
    finalOutcome = 'rate_limited';
    finalDetail = `${_rateLimitedDeletes} delete(s) hit 429 (recovered)`;
  } else if (_coldWake) {
    finalOutcome = 'cold_wake';
  } else {
    finalOutcome = 'success';
  }
  await emit(finalOutcome, {
    files_pushed: pushed,
    files_deleted: deleted,
    files_unchanged: unchangedCount,
    bytes_changed: bytesChanged,
    bytes_transferred: bytesChanged,
    error_detail: finalDetail,
  });
}

module.exports = { pushAtris };
