/**
 * atris align <business> [--fix] [--from cloud|local] [--dry-run]
 *
 * Compare a business workspace's local files against its EC2 cloud state,
 * report drift, and optionally fix it.
 *
 * SAFETY:
 * - Always wakes the EC2 computer first (the rule: never operate on cache)
 * - Walks via the warm runner /files endpoint, NOT agent_files
 * - Refuses destructive ops without --fix
 * - Throttles API calls to avoid rate limit (60/min on /file DELETE)
 *
 * USAGE:
 *   atris align                    # auto-detect business from .atris/business.json
 *   atris align pallet             # explicit business slug
 *   atris align pallet --dry-run   # show diff, do nothing
 *   atris align pallet --fix       # local is canonical: delete EC2 extras, push local-only
 *   atris align pallet --fix --from cloud  # cloud is canonical: pull EC2-only, delete local extras
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { loadCredentials } = require('../utils/auth');
const { apiRequestJson } = require('../utils/api');
const { loadBusinesses, saveBusinesses } = require('./business');

const SKIP_DIRS = new Set([
  'node_modules', '__pycache__', '.git', 'venv', '.venv',
  'lost+found', '.cache', '.atris', '.claude', 'default',
  'Library', 'Applications', 'System',
]);

const SKIP_FILES = new Set(['.DS_Store', 'Thumbs.db']);

/**
 * Sleep for a given number of milliseconds.
 * @param {number} ms - Milliseconds to sleep
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Compute SHA-256 hash of content string.
 * @param {string} content - Content to hash
 * @returns {string} Hex-encoded hash
 */
function hashContent(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * Compute SHA-256 hash of a file.
 * @param {string} absPath - Absolute path to file
 * @returns {string|null} Hex-encoded hash, or null if file unreadable
 */
function hashFile(absPath) {
  try {
    const buf = fs.readFileSync(absPath);
    return crypto.createHash('sha256').update(buf).digest('hex');
  } catch {
    return null;
  }
}

/**
 * Walk a local directory and return { relPath: hash } map.
 */
function walkLocal(rootDir) {
  const out = {};
  function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.') && e.name !== '.atris' && e.name !== '.claude') continue;
      if (SKIP_DIRS.has(e.name)) continue;
      if (SKIP_FILES.has(e.name)) continue;
      if (e.name.endsWith('.remote')) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(full);
      } else if (e.isFile()) {
        const rel = path.relative(rootDir, full);
        const h = hashFile(full);
        if (h) out[rel] = h;
      }
    }
  }
  walk(rootDir);
  return out;
}

/**
 * Get EC2 file list via the /snapshot endpoint (1 API call, fast).
 * Returns { path: { hash, size } } map.
 *
 * Why this instead of recursive /files walk: the recursive walk is rate-limited
 * (60/min) and hangs on workspaces with many subdirs. The /snapshot endpoint
 * returns the full file tree in one call. Trade-off: snapshot can be incomplete
 * for very deep hierarchies (server-side bug we've seen) — but it's vastly faster
 * and we accept that risk in exchange for not hanging.
 */
async function walkCloud(token, businessId, workspaceId) {
  const out = {};
  const errors = [];

  // First try the snapshot endpoint (1 call, much faster than walking)
  const snapshotResult = await apiRequestJson(
    `/business/${businessId}/workspaces/${workspaceId}/snapshot?include_content=false`,
    { method: 'GET', token, timeoutMs: 120000 }
  );

  if (snapshotResult.ok && snapshotResult.data && Array.isArray(snapshotResult.data.files)) {
    for (const f of snapshotResult.data.files) {
      const p = (f.path || '').replace(/^\//, '');
      if (!p) continue;
      const base = p.split('/').pop();
      if (SKIP_FILES.has(base)) continue;
      if (p.endsWith('.remote')) continue;
      // Check skip dirs
      const parts = p.split('/');
      if (parts.some((part) => SKIP_DIRS.has(part))) continue;
      out[p] = { hash: f.hash || null, size: f.size || 0 };
    }
    // CRITICAL: only return if snapshot actually had files. Empty snapshot is
    // a known server-side bug — fall back to recursive walk in that case so
    // we don't report every local file as "only on local" against a phantom empty cloud.
    if (Object.keys(out).length > 0) {
      return { files: out, errors };
    }
    errors.push({ path: '<snapshot>', status: 'empty', fallback: 'recursive walk' });
  } else {
    // Snapshot failed entirely — fall back to recursive walk
    errors.push({ path: '<snapshot>', status: snapshotResult.status, fallback: 'recursive walk' });
  }

  async function walk(dirPath, depth) {
    if (depth > 12) return;
    await sleep(300);
    let result = await apiRequestJson(
      `/business/${businessId}/workspaces/${workspaceId}/files${dirPath ? `?path=${encodeURIComponent(dirPath)}` : ''}`,
      { method: 'GET', token }
    );
    if (!result.ok && result.status === 429) {
      await sleep(15000);
      result = await apiRequestJson(
        `/business/${businessId}/workspaces/${workspaceId}/files${dirPath ? `?path=${encodeURIComponent(dirPath)}` : ''}`,
        { method: 'GET', token }
      );
    }
    if (!result.ok) {
      errors.push({ path: dirPath, status: result.status });
      return;
    }
    const entries = (result.data && result.data.files) || [];
    for (const entry of entries) {
      const name = entry.name || '';
      const fullPath = dirPath ? `${dirPath}/${name}` : name;
      if (entry.type === 'file') {
        if (SKIP_FILES.has(name)) continue;
        if (name.endsWith('.remote')) continue;
        out[fullPath] = { hash: entry.hash || null, size: entry.size || 0 };
      } else if (entry.type === 'dir') {
        if (SKIP_DIRS.has(name)) continue;
        await walk(fullPath, depth + 1);
      }
    }
  }
  await walk('', 0);
  return { files: out, errors };
}

/**
 * Get cloud file content (for hash computation when /files doesn't return hashes).
 */
async function fetchCloudFileHash(token, businessId, workspaceId, filePath) {
  const result = await apiRequestJson(
    `/business/${businessId}/workspaces/${workspaceId}/file?path=${encodeURIComponent(filePath)}`,
    { method: 'GET', token }
  );
  if (!result.ok) return null;
  const content = result.data && result.data.content;
  if (typeof content !== 'string') return null;
  return hashContent(Buffer.from(content, 'utf-8'));
}

/**
 * Wake the EC2 computer and wait until it's running.
 * Returns the endpoint URL or null on timeout.
 */
async function ensureAwake(token, businessId, maxWaitSec = 90) {
  const status = await apiRequestJson(`/business/${businessId}/ai-computer/status`, { method: 'GET', token });
  if (status.ok && status.data && status.data.status === 'running' && status.data.endpoint) {
    return status.data.endpoint;
  }

  process.stdout.write('  Waking EC2 computer... ');
  await apiRequestJson(`/business/${businessId}/ai-computer/wake`, { method: 'POST', token });

  const start = Date.now();
  while (Date.now() - start < maxWaitSec * 1000) {
    await sleep(3000);
    const s = await apiRequestJson(`/business/${businessId}/ai-computer/status`, { method: 'GET', token });
    if (s.ok && s.data && s.data.status === 'running' && s.data.endpoint) {
      const elapsed = Math.floor((Date.now() - start) / 1000);
      console.log(`awake (${elapsed}s)`);
      return s.data.endpoint;
    }
  }
  console.log('timeout');
  return null;
}

/**
 * Resolve business slug → { businessId, workspaceId, businessName }.
 */
async function resolveBusiness(token, slug) {
  const businesses = loadBusinesses();
  const list = await apiRequestJson('/business/', { method: 'GET', token });
  if (list.ok) {
    const match = (list.data || []).find(
      (b) => b.slug === slug || b.name.toLowerCase() === slug.toLowerCase()
    );
    if (!match) return null;
    businesses[slug] = {
      business_id: match.id,
      workspace_id: match.workspace_id,
      name: match.name,
      slug: match.slug,
      added_at: new Date().toISOString(),
    };
    saveBusinesses(businesses);
    return { businessId: match.id, workspaceId: match.workspace_id, businessName: match.name, resolvedSlug: match.slug };
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

/**
 * Push files via /sync (single batched call).
 *
 * The /sync endpoint writes each file to EC2 + DB sequentially server-side,
 * so wall time scales with batch size. Default node timeout (30s) is too
 * short for batches of more than ~15-20 files; pass an explicit timeoutMs.
 */
async function pushFiles(token, businessId, workspaceId, fileObjs, timeoutMs = 180000) {
  if (!fileObjs.length) return { ok: true, written: 0 };
  const result = await apiRequestJson(
    `/business/${businessId}/workspaces/${workspaceId}/sync`,
    {
      method: 'POST',
      token,
      body: { files: fileObjs },
      headers: { 'X-Atris-Actor-Source': 'cli-align' },
      timeoutMs,
    }
  );
  return result;
}

/**
 * Delete a file from EC2 via /file DELETE.
 */
async function deleteCloudFile(token, businessId, workspaceId, filePath) {
  return apiRequestJson(
    `/business/${businessId}/workspaces/${workspaceId}/file?path=${encodeURIComponent(filePath)}`,
    { method: 'DELETE', token }
  );
}

/**
 * --hard force-push: local is canonical, wipe cloud cruft + upload local.
 *
 * Strategy (deliberately simple, designed to finish in seconds not minutes):
 *   1. List top-level entries on cloud via /files?path= (1 API call).
 *   2. Compute top-level entries in local (1 fs read).
 *   3. For each top-level cloud entry NOT present in local: DELETE it.
 *      Server-side delete is recursive, so one call per top-level dir
 *      replaces hundreds of file-by-file deletes.
 *   4. Walk local once, push every file via /sync in 10-file batches.
 *   5. Save manifest so subsequent atris pull/push diffs work correctly.
 *
 * Why bypass the diff: in the bloated-cloud case the diff itself is the
 * slow part (cloud has hundreds of files local doesn't, walking them
 * times out). --hard just trusts local and overwrites cloud.
 */
async function alignHardLocalToCloud(token, biz, localDir) {
  const { businessId, workspaceId, businessName, resolvedSlug } = biz;
  const { buildManifest, saveManifest, computeLocalHashes } = require('../lib/manifest');

  // 1. List top-level entries on cloud via /files (1 fast API call).
  //    We deliberately AVOID /snapshot here — its hangs/timeouts on bloated
  //    workspaces are the whole reason --hard exists. /files at depth 0 is
  //    a single dir-listing call that returns reliably.
  //
  //    The /files endpoint shares a 60/min rate limit with the rest of the
  //    business workspace API, so a recent --hard run can leave us throttled.
  //    Retry once on 429 with a generous backoff before giving up.
  process.stdout.write('  Listing cloud top-level... ');
  let topResult;
  // Up to 3 attempts with 60s backoff between rate-limit retries. The
  // /files endpoint shares the global 60/min business API quota and a
  // recent --hard run can leave us heavily throttled.
  for (let attempt = 0; attempt < 3; attempt++) {
    topResult = await apiRequestJson(
      `/business/${businessId}/workspaces/${workspaceId}/files`,
      { method: 'GET', token }
    );
    if (topResult.ok || topResult.status !== 429) break;
    if (attempt < 2) {
      process.stdout.write(`rate-limited, waiting 60s (attempt ${attempt + 2}/3)... `);
      await sleep(60000);
    }
  }
  if (!topResult.ok) {
    console.log('failed');
    console.error(`  Could not list cloud workspace: ${topResult.errorMessage || topResult.status}`);
    process.exit(1);
  }
  const cloudTopEntries = (topResult.data && topResult.data.files) || [];
  console.log(`${cloudTopEntries.length} entries`);

  // The `workspace` top-level entry is the workspace root itself — it's
  // protected server-side (DELETE returns 400) and is NEVER cruft. Don't
  // try to delete it; pretend it isn't there for the diff.
  const PROTECTED_TOP = new Set(['workspace']);

  // 2. Top-level local entries — track names AND types so we can detect
  //    type-mismatch (cloud has file `foo`, local has dir `foo/`).
  const localTopByName = new Map(); // name -> 'dir' | 'file'
  for (const e of fs.readdirSync(localDir, { withFileTypes: true })) {
    if (e.name.startsWith('.') && e.name !== '.atris' && e.name !== '.claude') continue;
    if (SKIP_DIRS.has(e.name)) continue;
    if (SKIP_FILES.has(e.name)) continue;
    localTopByName.set(e.name, e.isDirectory() ? 'dir' : 'file');
  }

  // 3. Delete cloud top-level entries that aren't in local OR whose type
  //    differs from local. Type mismatch must be cleared so the bulk push
  //    can write the correct shape (otherwise pushing a file at a path
  //    occupied by a dir, or vice versa, will silently fail server-side).
  //
  // NOTE: --hard intentionally does NOT respect SKIP_DIRS/SKIP_FILES here.
  // Those skip lists exist for the diff/walk path so we don't enumerate
  // node_modules/venv/__pycache__ locally — they are NOT protections that
  // mean "don't delete on cloud." A bloated cloud workspace might genuinely
  // contain stale `default/`, `venv/`, `__pycache__/` etc that the user
  // wants nuked. --hard means "make cloud match local"; if local doesn't
  // walk into those names, cloud shouldn't have them either.
  //
  // Only PROTECTED_TOP (the workspace root) is preserved.
  const toDelete = cloudTopEntries.filter((entry) => {
    const name = entry.name || '';
    if (!name) return false;
    if (PROTECTED_TOP.has(name)) return false;
    const localType = localTopByName.get(name);
    if (!localType) return true; // not in local at all
    if (localType !== entry.type) return true; // type mismatch — must clear
    return false;
  });

  let deleteFailures = 0;
  if (toDelete.length > 0) {
    console.log(`  Deleting ${toDelete.length} cloud top-level entries (not present locally):`);
    for (const entry of toDelete) {
      const name = entry.name;
      const kind = entry.type === 'dir' ? 'dir' : 'file';
      process.stdout.write(`    - ${name}/  (${kind}) ... `);
      const r = await deleteCloudFile(token, businessId, workspaceId, '/' + name);
      let succeeded = r.ok || r.status === 404;
      if (succeeded) {
        console.log('gone');
      } else if (r.status === 429) {
        await sleep(20000);
        const r2 = await deleteCloudFile(token, businessId, workspaceId, '/' + name);
        succeeded = r2.ok || r2.status === 404;
        console.log(succeeded ? 'gone (after retry)' : `FAILED ${r2.status}`);
      } else {
        console.log(`FAILED ${r.status}`);
      }
      if (!succeeded) deleteFailures++;
      await sleep(400);
    }
  } else {
    console.log('  No cloud-only top-level entries to delete.');
  }

  // 4. Walk local + bulk-push every file
  const localFiles = computeLocalHashes(localDir);
  const localPaths = Object.keys(localFiles);
  console.log(`  Pushing ${localPaths.length} local files to cloud...`);

  const fileObjs = [];
  for (const p of localPaths) {
    try {
      const content = fs.readFileSync(path.join(localDir, p.replace(/^\//, '')), 'utf-8');
      fileObjs.push({ path: p, content });
    } catch {
      // skip unreadable
    }
  }

  // Batch size is intentionally small. The /sync endpoint writes files
  // sequentially on the server (warm runner + DB) so 50 files easily blows
  // past the default 30s HTTP timeout. 10 files per batch gives the server
  // ~3s/file headroom and keeps individual batch latency well under 30s.
  const BATCH = 10;
  let written = 0;
  let batchFailures = 0;
  let perFileErrors = 0;
  const failedPaths = [];
  for (let i = 0; i < fileObjs.length; i += BATCH) {
    const batch = fileObjs.slice(i, i + BATCH);
    const r = await pushFiles(token, businessId, workspaceId, batch, 180000);
    if (r.ok) {
      // The server returns SyncResponse{written, unchanged, errors, results}
      // inside a 200. A successful HTTP doesn't mean every file landed —
      // results can include status="error" entries (path-traversal attempts,
      // permission errors, full disk, etc). Trust the server's count and
      // record any per-file errors against batchFailures so we don't write
      // a manifest claiming files exist on cloud when they actually don't.
      const data = r.data || {};
      const serverWritten = (typeof data.written === 'number') ? data.written : 0;
      const serverUnchanged = (typeof data.unchanged === 'number') ? data.unchanged : 0;
      const serverErrors = (typeof data.errors === 'number') ? data.errors : 0;
      written += serverWritten + serverUnchanged;
      if (serverErrors > 0) {
        perFileErrors += serverErrors;
        for (const entry of (data.results || [])) {
          if (entry && entry.status === 'error') {
            failedPaths.push({ path: entry.path, error: entry.error || '' });
          }
        }
        console.log(`    [${Math.min(i + BATCH, fileObjs.length)}/${fileObjs.length}] partial: ${serverWritten + serverUnchanged} ok, ${serverErrors} errored`);
      } else {
        console.log(`    [${Math.min(i + BATCH, fileObjs.length)}/${fileObjs.length}] pushed`);
      }
    } else {
      batchFailures++;
      console.log(`    [${Math.min(i + BATCH, fileObjs.length)}/${fileObjs.length}] FAILED ${r.status} ${r.error || ''}`);
    }
    await sleep(500);
  }
  if (perFileErrors > 0) {
    console.log(`  ⚠ ${perFileErrors} per-file error(s) returned by server:`);
    failedPaths.slice(0, 8).forEach((f) => console.log(`      x ${f.path.replace(/^\//, '')}  ${f.error}`));
    if (failedPaths.length > 8) console.log(`      ... +${failedPaths.length - 8} more`);
  }

  // 5. Save manifest so subsequent push/pull diffs work — but ONLY if every
  //    batch, every per-file write, AND every cloud delete succeeded. If
  //    anything failed, leaving the manifest stale is safer than recording
  //    a mirror that doesn't actually exist on cloud (the manifest would
  //    then mask undeleted cruft and let regular push think everything is
  //    fine).
  console.log('');
  if (batchFailures > 0 || deleteFailures > 0 || perFileErrors > 0) {
    const parts = [];
    if (batchFailures > 0) parts.push(`${batchFailures} push batch failure(s)`);
    if (perFileErrors > 0) parts.push(`${perFileErrors} per-file write error(s)`);
    if (deleteFailures > 0) parts.push(`${deleteFailures} cloud delete failure(s)`);
    console.log(`  ⚠ Force-push partial: ${written}/${fileObjs.length} pushed, ${toDelete.length - deleteFailures}/${toDelete.length} cloud-only entries deleted, ${parts.join(', ')}.`);
    console.log(`  Manifest NOT updated. Re-run \`atris align ${resolvedSlug} --fix --hard\` to retry.`);
    process.exit(1);
  }
  saveManifest(resolvedSlug, buildManifest(localFiles, null, { workspaceRoot: localDir }));
  console.log(`  Force-push complete: ${written}/${fileObjs.length} pushed, ${toDelete.length} cloud-only entries deleted.`);
  console.log(`  ${businessName} is now mirrored from local.`);
}

async function alignAtris() {
  // Parse args
  let slug = process.argv[3];
  if (!slug || slug.startsWith('-')) {
    const bizFile = path.join(process.cwd(), '.atris', 'business.json');
    if (fs.existsSync(bizFile)) {
      try { slug = JSON.parse(fs.readFileSync(bizFile, 'utf8')).slug; } catch {}
    }
    if (!slug || slug.startsWith('-')) slug = null;
  }

  if (!slug || slug === '--help' || slug === '-h') {
    console.log('Usage: atris align [business] [--fix] [--hard] [--from cloud|local] [--dry-run]');
    console.log('');
    console.log('  atris align                   Diff current workspace against cloud (auto-detect)');
    console.log('  atris align pallet            Diff pallet workspace');
    console.log('  atris align pallet --fix      Fix drift (local is canonical by default)');
    console.log('  atris align pallet --fix --hard  Force-push: nuke cloud cruft, upload local. Skips diff. Fast.');
    console.log('  atris align pallet --fix --from cloud  Cloud is canonical: pull EC2-only, delete local extras');
    console.log('  atris align pallet --dry-run  Show what would change, do nothing');
    process.exit(0);
  }

  const fix = process.argv.includes('--fix');
  const dryRun = process.argv.includes('--dry-run');
  const hard = process.argv.includes('--hard');
  const fromIdx = process.argv.indexOf('--from');
  const fromSide = (fromIdx !== -1 && process.argv[fromIdx + 1]) ? process.argv[fromIdx + 1] : 'local';

  if (!['local', 'cloud'].includes(fromSide)) {
    console.error(`Invalid --from value: ${fromSide}. Use 'local' or 'cloud'.`);
    process.exit(1);
  }

  if (hard && fromSide !== 'local') {
    console.error('--hard only supported with --from local (the canonical force-push direction).');
    process.exit(1);
  }

  // Determine local dir
  let localDir;
  const bizFileCwd = path.join(process.cwd(), '.atris', 'business.json');
  if (fs.existsSync(bizFileCwd)) {
    localDir = process.cwd();
  } else if (fs.existsSync(path.join(process.cwd(), slug))) {
    localDir = path.join(process.cwd(), slug);
  } else {
    console.error(`Cannot find local workspace for "${slug}".`);
    console.error('Run from inside the workspace, or pass a slug whose folder exists in cwd.');
    process.exit(1);
  }

  const creds = loadCredentials();
  if (!creds || !creds.token) { console.error('Not logged in. Run: atris login'); process.exit(1); }

  console.log('');
  console.log(`Aligning ${slug}...`);

  // Resolve business
  const biz = await resolveBusiness(creds.token, slug);
  if (!biz) { console.error(`Business "${slug}" not found.`); process.exit(1); }
  if (!biz.workspaceId) { console.error(`Business "${slug}" has no workspace.`); process.exit(1); }

  // Wake EC2 (the rule)
  const endpoint = await ensureAwake(creds.token, biz.businessId);
  if (!endpoint) {
    console.error('  EC2 computer did not become ready in time. Aborting.');
    process.exit(1);
  }

  // --hard: skip the slow file-by-file walk. Nuke top-level cloud entries
  // not present locally (1 DELETE per top-level dir, recursive on the server),
  // then bulk-push every local file via /sync. Designed for "cloud is bloated,
  // local is canonical, just make them match" — the force-push escape hatch.
  if (hard && fix) {
    console.log(`  Local:  ${localDir}`);
    console.log(`  Cloud:  ${endpoint}`);
    console.log('  Mode:   --hard (force-push: wipe cloud cruft, upload local)');
    return alignHardLocalToCloud(creds.token, biz, localDir);
  }

  // Walk both sides in parallel
  console.log(`  Local:  ${localDir}`);
  console.log(`  Cloud:  ${endpoint}`);
  process.stdout.write('  Walking local + cloud...');

  const localFiles = walkLocal(localDir);
  const { files: cloudFiles, errors: walkErrors } = await walkCloud(
    creds.token, biz.businessId, biz.workspaceId
  );

  console.log(` local=${Object.keys(localFiles).length} cloud=${Object.keys(cloudFiles).length}`);
  if (walkErrors.length > 0) {
    console.log(`  ⚠ ${walkErrors.length} walk errors (some directories not read)`);
  }

  // Diff (path-based first; cloud /files doesn't always return hashes)
  const localPaths = new Set(Object.keys(localFiles));
  const cloudPaths = new Set(Object.keys(cloudFiles));
  const onlyLocal = [...localPaths].filter((p) => !cloudPaths.has(p)).sort();
  const onlyCloud = [...cloudPaths].filter((p) => !localPaths.has(p)).sort();
  const both = [...localPaths].filter((p) => cloudPaths.has(p));

  // Hash check for files that exist on both sides (only if cloud has hashes)
  const hashMismatches = [];
  for (const p of both) {
    const cHash = cloudFiles[p].hash;
    if (cHash && cHash !== localFiles[p]) hashMismatches.push(p);
  }

  // Report
  console.log('');
  console.log(`  Match:        ${both.length - hashMismatches.length}`);
  console.log(`  Hash differ:  ${hashMismatches.length}`);
  console.log(`  Only local:   ${onlyLocal.length}`);
  console.log(`  Only cloud:   ${onlyCloud.length}`);
  console.log('');

  if (onlyLocal.length === 0 && onlyCloud.length === 0 && hashMismatches.length === 0) {
    console.log('  ✓ Aligned. No drift.');
    return;
  }

  // Show samples (cap at 10 each so we don't drown the terminal)
  if (onlyLocal.length > 0) {
    console.log(`  Only on local (${onlyLocal.length}):`);
    onlyLocal.slice(0, 10).forEach((p) => console.log(`    + ${p}`));
    if (onlyLocal.length > 10) console.log(`    ... +${onlyLocal.length - 10} more`);
    console.log('');
  }
  if (onlyCloud.length > 0) {
    console.log(`  Only on cloud (${onlyCloud.length}):`);
    onlyCloud.slice(0, 10).forEach((p) => console.log(`    + ${p}`));
    if (onlyCloud.length > 10) console.log(`    ... +${onlyCloud.length - 10} more`);
    console.log('');
  }
  if (hashMismatches.length > 0) {
    console.log(`  Content differs (${hashMismatches.length}):`);
    hashMismatches.slice(0, 10).forEach((p) => console.log(`    ~ ${p}`));
    if (hashMismatches.length > 10) console.log(`    ... +${hashMismatches.length - 10} more`);
    console.log('');
  }

  if (dryRun) {
    console.log('  (--dry-run, no changes made)');
    return;
  }

  if (!fix) {
    console.log('  Run with --fix to align. Local is the default canonical side.');
    console.log(`  Use --from cloud to make cloud the canonical side instead.`);
    return;
  }

  // FIX MODE
  console.log(`  Fixing — ${fromSide} is canonical:`);

  if (fromSide === 'local') {
    // Delete cloud-only files (they're cruft)
    if (onlyCloud.length > 0) {
      console.log(`  Deleting ${onlyCloud.length} cloud-only files...`);
      let deleted = 0, failed = 0;
      for (let i = 0; i < onlyCloud.length; i++) {
        const p = onlyCloud[i];
        await sleep(700); // throttle to stay under 60/min
        const r = await deleteCloudFile(creds.token, biz.businessId, biz.workspaceId, p);
        if (r.ok) {
          deleted++;
        } else if (r.status === 429) {
          await sleep(20000);
          const r2 = await deleteCloudFile(creds.token, biz.businessId, biz.workspaceId, p);
          if (r2.ok) deleted++; else failed++;
        } else {
          failed++;
        }
        if ((i + 1) % 25 === 0) console.log(`    [${i + 1}/${onlyCloud.length}] ${deleted} deleted, ${failed} failed`);
      }
      console.log(`  Deleted ${deleted}/${onlyCloud.length} (${failed} failed)`);
    }

    // Push local-only + hash-mismatched files
    const toPush = [...onlyLocal, ...hashMismatches];
    if (toPush.length > 0) {
      console.log(`  Pushing ${toPush.length} local files to cloud...`);
      const fileObjs = [];
      for (const p of toPush) {
        try {
          const content = fs.readFileSync(path.join(localDir, p), 'utf-8');
          fileObjs.push({ path: '/' + p, content });
        } catch {}
      }
      // Push in batches of 50 to avoid huge payloads
      const BATCH = 50;
      let written = 0;
      for (let i = 0; i < fileObjs.length; i += BATCH) {
        const batch = fileObjs.slice(i, i + BATCH);
        const r = await pushFiles(creds.token, biz.businessId, biz.workspaceId, batch);
        if (r.ok && r.data) {
          written += (r.data.written || batch.length);
        }
        await sleep(500);
      }
      console.log(`  Pushed ${written}/${fileObjs.length}`);
    }
  } else {
    // fromSide === 'cloud': pull cloud-only + hash-mismatched, delete local-only
    console.log(`  Pulling ${onlyCloud.length + hashMismatches.length} files from cloud...`);
    let pulled = 0;
    for (const p of [...onlyCloud, ...hashMismatches]) {
      await sleep(300);
      const r = await apiRequestJson(
        `/business/${biz.businessId}/workspaces/${biz.workspaceId}/file?path=${encodeURIComponent(p)}`,
        { method: 'GET', token: creds.token }
      );
      if (r.ok && r.data && typeof r.data.content === 'string') {
        const local = path.join(localDir, p);
        try {
          fs.mkdirSync(path.dirname(local), { recursive: true });
          fs.writeFileSync(local, r.data.content);
          pulled++;
        } catch {}
      }
    }
    console.log(`  Pulled ${pulled}/${onlyCloud.length + hashMismatches.length}`);

    if (onlyLocal.length > 0) {
      console.log(`  Deleting ${onlyLocal.length} local-only files...`);
      let deleted = 0;
      for (const p of onlyLocal) {
        try { fs.unlinkSync(path.join(localDir, p)); deleted++; } catch {}
      }
      console.log(`  Deleted ${deleted}/${onlyLocal.length}`);
    }
  }

  // Re-walk to verify
  console.log('');
  console.log('  Re-walking to verify...');
  const localFiles2 = walkLocal(localDir);
  const { files: cloudFiles2 } = await walkCloud(
    creds.token, biz.businessId, biz.workspaceId
  );
  const lp2 = new Set(Object.keys(localFiles2));
  const cp2 = new Set(Object.keys(cloudFiles2));
  const stillOnlyLocal = [...lp2].filter((p) => !cp2.has(p)).length;
  const stillOnlyCloud = [...cp2].filter((p) => !lp2.has(p)).length;

  console.log(`  After fix: local=${lp2.size} cloud=${cp2.size} only-local=${stillOnlyLocal} only-cloud=${stillOnlyCloud}`);
  if (stillOnlyLocal === 0 && stillOnlyCloud === 0) {
    console.log('  ✅ Aligned.');
  } else {
    console.log('  ⚠ Drift remains. Run again with --fix or inspect manually.');
  }
}

module.exports = { alignAtris };
