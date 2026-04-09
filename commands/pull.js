const fs = require('fs');
const path = require('path');
const { loadCredentials } = require('../utils/auth');
const { apiRequestJson } = require('../utils/api');
const { findAllMembers } = require('./member');
const { loadConfig } = require('../utils/config');
const { getLogPath } = require('../lib/file-ops');
const { parseJournalSections, mergeSections, reconstructJournal } = require('../lib/journal');
const { loadBusinesses } = require('./business');
const { loadManifest, saveManifest, computeFileHash, buildManifest, computeLocalHashes, threeWayCompare } = require('../lib/manifest');
const { normalizeWikiOnlyPrefix } = require('../lib/wiki');

function pruneEmptyParentDirs(filePath, stopDir) {
  let current = path.dirname(filePath);
  const boundary = path.resolve(stopDir);
  while (current.startsWith(boundary) && current !== boundary) {
    try {
      if (fs.readdirSync(current).length > 0) break;
      fs.rmdirSync(current);
      current = path.dirname(current);
    } catch {
      break;
    }
  }
}

async function pullAtris() {
  let arg = process.argv[3];

  if (arg === '--help') {
    console.log('Usage: atris pull [business] [--into <path>] [--only <prefix>] [--keep-local] [--timeout <seconds>]');
    console.log('');
    console.log('  Pull is force-overwrite by default. Cloud is the source of truth.');
    console.log('  Local files that conflict with cloud are replaced by the cloud version.');
    console.log('');
    console.log('  atris pull                   Pull into current business workspace');
    console.log('  atris pull doordash          Pull a business into ./doordash or --into <path>');
    console.log('  atris pull doordash --into /tmp/doordash');
    console.log('  atris pull doordash --only atris/wiki/');
    console.log('  atris pull --keep-local      Preserve conflicting local edits as .remote files (legacy)');
    return;
  }

  // Auto-detect business from .atris/business.json in current dir
  if (!arg || arg.startsWith('--')) {
    const bizFile = path.join(process.cwd(), '.atris', 'business.json');
    if (fs.existsSync(bizFile)) {
      try {
        const biz = JSON.parse(fs.readFileSync(bizFile, 'utf8'));
        if (biz.slug || biz.name) {
          return pullBusiness(biz.slug || biz.name);
        }
      } catch {}
    }
  }

  // If a business name is given, do a business pull
  if (arg && arg !== '--help' && !arg.startsWith('--')) {
    return pullBusiness(arg);
  }

  // Otherwise, do the existing journal pull
  const targetDir = path.join(process.cwd(), 'atris');

  if (!fs.existsSync(targetDir)) {
    console.error('atris/ folder not found. Run "atris init" first.');
    process.exit(1);
  }

  const creds = loadCredentials();
  if (!creds || !creds.token) {
    console.error('Not logged in. Run: atris login');
    process.exit(1);
  }

  console.log('');
  console.log('Pulling from cloud...');
  console.log('');

  let totalSynced = 0;

  // --- 1. General journal sync ---
  const config = loadConfig();
  if (config.agent_id) {
    const journalSynced = await pullGeneralJournal(creds.token, config.agent_id);
    totalSynced += journalSynced;
  } else {
    console.log('  Skip general journal (no agent selected, run "atris agent")');
  }

  // --- 2. Member journal sync ---
  const teamDir = path.join(targetDir, 'team');
  const members = findAllMembers(teamDir);
  const membersWithAgents = members.filter(m => m.frontmatter && m.frontmatter['agent-id']);

  if (membersWithAgents.length === 0) {
    console.log('  No members with cloud agents (run "atris member push <name>")');
  } else {
    for (const member of membersWithAgents) {
      const agentId = member.frontmatter['agent-id'];
      const synced = await pullMemberJournal(creds.token, agentId, member.name, member.dir);
      totalSynced += synced;
    }
  }

  // --- Summary ---
  console.log('');
  if (totalSynced > 0) {
    console.log(`Done. ${totalSynced} file${totalSynced > 1 ? 's' : ''} synced.`);
  } else {
    console.log('Everything up to date.');
  }
}


async function pullBusiness(slug) {
  const creds = loadCredentials();
  if (!creds || !creds.token) {
    console.error('Not logged in. Run: atris login');
    process.exit(1);
  }

  // Pull is force-overwrite by default (cloud = source of truth).
  // --keep-local opts back into the legacy three-way merge with .remote conflict files.
  // --force is still accepted as an alias for the default for muscle-memory.
  const force = !process.argv.includes('--keep-local');

  // Parse --only flag: comma-separated directory prefixes to filter
  // Supports both --only=team/,context/ and --only team/,context/
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
        const wikiPrefix = normalizeWikiOnlyPrefix(norm);
        if (wikiPrefix) return wikiPrefix;
        if (norm && !norm.endsWith('/') && !norm.includes('.')) norm += '/';
        return norm;
      }).filter(Boolean)
    : null;

  // Parse --timeout flag: override default 300s timeout
  // Supports both --timeout=60 and --timeout 60
  let timeoutSec = 300;
  const timeoutEqArg = process.argv.find(a => a.startsWith('--timeout='));
  if (timeoutEqArg) {
    timeoutSec = parseInt(timeoutEqArg.slice('--timeout='.length), 10);
  } else {
    const timeoutIdx = process.argv.indexOf('--timeout');
    if (timeoutIdx !== -1 && process.argv[timeoutIdx + 1]) {
      timeoutSec = parseInt(process.argv[timeoutIdx + 1], 10);
    }
  }
  const timeoutMs = timeoutSec * 1000;

  // Determine output directory
  const intoIdx = process.argv.indexOf('--into');
  let outputDir;
  if (intoIdx !== -1 && process.argv[intoIdx + 1]) {
    outputDir = path.resolve(process.argv[intoIdx + 1]);
  } else if (fs.existsSync(path.join(process.cwd(), '.atris', 'business.json'))) {
    // Inside a pulled workspace — pull into current dir (no nesting)
    outputDir = process.cwd();
  } else if (fs.existsSync(path.join(process.cwd(), 'atris')) && fs.statSync(path.join(process.cwd(), 'atris')).isDirectory()) {
    // Inside an atris init'd workspace — merge business into current dir
    outputDir = process.cwd();
  } else {
    // Default: ./{slug}/ in current directory
    outputDir = path.join(process.cwd(), slug);
  }

  // Resolve business ID — always refresh from API to avoid stale workspace_id
  let businessId, workspaceId, businessName, resolvedSlug;
  const businesses = loadBusinesses();

  const listResult = await apiRequestJson('/business/', { method: 'GET', token: creds.token });
  if (!listResult.ok) {
    // Fall back to local cache if API fails
    if (businesses[slug]) {
      businessId = businesses[slug].business_id;
      workspaceId = businesses[slug].workspace_id;
      businessName = businesses[slug].name || slug;
      resolvedSlug = businesses[slug].slug || slug;
    } else {
      console.error(`Failed to fetch businesses: ${listResult.errorMessage || listResult.status}`);
      process.exit(1);
    }
  } else {
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

    // Update local cache
    businesses[slug] = {
      business_id: businessId,
      workspace_id: workspaceId,
      name: businessName,
      slug: match.slug,
      added_at: new Date().toISOString(),
    };
    const { saveBusinesses } = require('./business');
    saveBusinesses(businesses);
  }

  if (!workspaceId) {
    console.error(`Business "${slug}" has no workspace. Set one up first.`);
    process.exit(1);
  }

  // Auto-wake the EC2 computer if --auto-wake is set.
  // Without this, pull silently serves stale data from agent_files cache when
  // the computer is asleep — the bug that confused us all night.
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

  // Load manifest (last sync state)
  const manifest = loadManifest(resolvedSlug || slug);
  const timeSince = manifest ? _timeSince(manifest.last_sync) : null;

  console.log('');
  console.log(`Pulling ${businessName}...` + (timeSince ? `  (last synced ${timeSince})` : ''));

  // Loading indicator with elapsed time
  const startTime = Date.now();
  const spinner = ['|', '/', '-', '\\'];
  let spinIdx = 0;
  const loading = setInterval(() => {
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    process.stdout.write(`\r  Fetching workspace... ${spinner[spinIdx++ % 4]} ${elapsed}s`);
  }, 250);

  // Smart pull: if we have a manifest (not first sync), fetch hashes first, then only changed content
  const hasManifest = manifest && manifest.files && Object.keys(manifest.files).length > 0 && !force;
  let result;

  const pathsParam = onlyPrefixes ? `&paths=${encodeURIComponent(onlyPrefixes.map(p => p.replace(/\/$/, '')).join(','))}` : '';

  if (hasManifest) {
    // Phase 1: fetch hashes only (fast — no file content transferred)
    const hashUrl = `/business/${businessId}/workspaces/${workspaceId}/snapshot?include_content=false${pathsParam}`;
    const hashResult = await apiRequestJson(hashUrl, { method: 'GET', token: creds.token, timeoutMs });

    if (hashResult.ok && hashResult.data && hashResult.data.files) {
      // Diff against manifest to find changed files
      const remoteHashes = {};
      for (const f of hashResult.data.files) {
        if (f.path && f.hash) remoteHashes[f.path] = f.hash;
      }
      const changedPaths = [];
      const manifestFiles = manifest.files || {};
      for (const [p, hash] of Object.entries(remoteHashes)) {
        const prev = manifestFiles[p];
        if (!prev || prev.hash !== hash) changedPaths.push(p);
      }

      if (changedPaths.length === 0) {
        clearInterval(loading);
        process.stdout.write(`\r  Checked ${Object.keys(remoteHashes).length} files in ${Math.floor((Date.now() - startTime) / 1000)}s.${' '.repeat(10)}\n`);
        // Still need full result for diff logic below — build it from hash-only data
        result = { ok: true, data: { files: hashResult.data.files } };
      } else {
        // Phase 2: fetch ONLY changed files via batch endpoint (not full snapshot)
        clearInterval(loading);
        const checkSec = Math.floor((Date.now() - startTime) / 1000);
        console.log(`\r  Checked in ${checkSec}s — ${changedPaths.length} changed, ${Object.keys(remoteHashes).length - changedPaths.length} unchanged.${' '.repeat(10)}`);

        const startPhase2 = Date.now();
        const loading2 = setInterval(() => {
          const elapsed = Math.floor((Date.now() - startPhase2) / 1000);
          process.stdout.write(`\r  Fetching ${changedPaths.length} changed files... ${spinner[spinIdx++ % 4]} ${elapsed}s`);
        }, 250);

        // Try batch file read first (fast — only changed files)
        const batchUrl = `/business/${businessId}/workspaces/${workspaceId}/files/batch`;
        const batchResult = await apiRequestJson(batchUrl, {
          method: 'POST',
          token: creds.token,
          body: { paths: changedPaths },
          timeoutMs,
        });

        clearInterval(loading2);
        const phase2Sec = Math.floor((Date.now() - startPhase2) / 1000);

        if (batchResult.ok && batchResult.data && batchResult.data.files) {
          process.stdout.write(`\r  Fetched ${batchResult.data.files.length} files in ${phase2Sec}s.${' '.repeat(10)}\n`);
          // Merge: hash-only results + content for changed files
          const contentMap = {};
          for (const f of batchResult.data.files) {
            if (f.path) contentMap[f.path] = f;
          }
          // Build merged file list: all hash-only entries + inject content for changed ones
          const mergedFiles = hashResult.data.files.map(f => {
            const withContent = contentMap[f.path];
            return withContent || f;
          });
          result = { ok: true, data: { files: mergedFiles } };
        } else {
          // Batch not available — fall back to full snapshot
          process.stdout.write(`\r  Batch unavailable, fetching full snapshot...${' '.repeat(10)}\n`);
          const contentUrl = `/business/${businessId}/workspaces/${workspaceId}/snapshot?include_content=true${pathsParam}`;
          result = await apiRequestJson(contentUrl, { method: 'GET', token: creds.token, timeoutMs });
          const fullSec = Math.floor((Date.now() - startPhase2) / 1000);
          process.stdout.write(`\r  Fetched in ${fullSec}s.${' '.repeat(20)}\n`);
        }
      }
    } else {
      // Hash-only fetch failed — fall back to full snapshot
      const fullUrl = `/business/${businessId}/workspaces/${workspaceId}/snapshot?include_content=true${pathsParam}`;
      result = await apiRequestJson(fullUrl, { method: 'GET', token: creds.token, timeoutMs });
      clearInterval(loading);
      process.stdout.write(`\r  Fetched in ${Math.floor((Date.now() - startTime) / 1000)}s.${' '.repeat(20)}\n`);
    }
  } else {
    // First sync or --force — full snapshot with content
    const snapshotUrl = `/business/${businessId}/workspaces/${workspaceId}/snapshot?include_content=true${pathsParam}`;
    result = await apiRequestJson(snapshotUrl, { method: 'GET', token: creds.token, timeoutMs });
    clearInterval(loading);
    const totalSec = Math.floor((Date.now() - startTime) / 1000);
    process.stdout.write(`\r  Fetched in ${totalSec}s.${' '.repeat(20)}\n`);
  }

  if (!result.ok) {
    const msg = result.errorMessage || result.error || `HTTP ${result.status}`;
    if (result.status === 0 || (typeof msg === 'string' && msg.toLowerCase().includes('timeout'))) {
      console.error(`\n  Workspace timed out (large workspaces can take 60s+). Try: atris pull ${slug} --timeout=600`);
    } else if (result.status === 502) {
      console.error(`\n  Computer didn't respond in time. It may be waking up or the workspace is large.`);
      console.error(`  Try again in 30s, or use: atris pull ${slug} --only=team/,context/`);
    } else if (result.status === 409) {
      console.error(`\n  Computer is sleeping. Wake it first, then pull again.`);
    } else if (result.status === 403) {
      console.error(`\n  Access denied. You're not a member of "${slug}".`);
    } else if (result.status === 404) {
      console.error(`\n  Business "${slug}" not found.`);
    } else {
      console.error(`\n  Pull failed: ${msg}`);
    }
    process.exit(1);
  }

  let files = result.data.files || [];
  if (files.length === 0) {
    console.log('  Workspace is empty.');
    // Don't early-return in force mode: we still need to fall through to the
    // mirror sweep so a genuinely-emptied cloud can clear local files. The
    // sweep itself has a safety guard that refuses to wipe local content
    // when remote reports empty (the snapshot-glitch case), so this is safe.
    if (!force) return;
  } else {
    console.log(`  Processing ${files.length} files...`);
  }

  // Apply --only filter if specified
  if (onlyPrefixes) {
    files = files.filter(file => {
      if (!file.path) return false;
      const rel = file.path.replace(/^\//, '');
      return onlyPrefixes.some(prefix => rel.startsWith(prefix));
    });
    if (files.length === 0) {
      console.log(`  No files matched --only filter: ${onlyPrefixes.join(', ')}`);
      // Don't early-return: we still need to update the manifest so paths
      // that USED to be in the scoped subtree but were deleted on cloud
      // get evicted from the manifest. Without this, the next push freshness
      // check would forever flag those paths as drift and demand a pull —
      // but the pull would early-return again, creating a deadlock.
    } else {
      console.log(`  Filtered to ${files.length} files matching: ${onlyPrefixes.join(', ')}`);
    }
  }

  // Build remote file map {path: {hash, size}} and content map {path: content}.
  //
  // CRITICAL: smart-pull (hash-only fetch) returns files with `path`+`hash`+`size`
  // but no `content`. Phase-2 batch fetch only adds content for CHANGED files —
  // unchanged files stay hash-only. We must include hash-only entries in remoteFiles
  // so threeWayCompare doesn't see them as missing-from-remote (deletedRemote).
  // The previous version skipped any file without content, which caused every
  // smart-pull to mark every unchanged file as deleted-on-cloud and rmSync them.
  const remoteFiles = {};
  const remoteContent = {};
  const crypto = require('crypto');
  for (const file of files) {
    if (!file.path || file.binary) continue;
    // An empty string IS valid content (a real, zero-byte file). The earlier
    // version excluded `content === ''` from the hasContent path, which made
    // empty files masquerade as hash-only entries; they'd then be recorded in
    // the manifest (with the empty-string hash) but never written to disk.
    // A subsequent push would compare local (file missing) to manifest (file
    // present) and try to delete the file from cloud — silently undoing the
    // very thing the user just pulled.
    const hasContent = file.content !== null && file.content !== undefined && typeof file.content === 'string';
    if (hasContent) {
      // Full content available — hash from raw bytes (matches computeLocalHashes)
      const rawBytes = Buffer.from(file.content, 'utf-8');
      remoteFiles[file.path] = { hash: crypto.createHash('sha256').update(rawBytes).digest('hex'), size: rawBytes.length };
      remoteContent[file.path] = file.content;
    } else if (file.hash) {
      // Hash-only entry from smart pull — trust the cloud-reported hash
      remoteFiles[file.path] = { hash: file.hash, size: file.size || 0 };
    }
  }

  // Compute local file hashes
  const localFiles = fs.existsSync(outputDir) ? computeLocalHashes(outputDir) : {};

  // If output dir is empty (fresh clone) or --force, treat as first sync — pull everything
  const effectiveManifest = (Object.keys(localFiles).length === 0 || force) ? null : manifest;

  // Three-way compare
  const diff = threeWayCompare(localFiles, remoteFiles, effectiveManifest);

  // Apply changes
  let pulled = 0;
  let deleted = 0;
  let conflictCount = 0;
  let unchangedCount = diff.unchanged.length;

  console.log('');

  // Pull files that changed remotely (and we didn't change locally)
  for (const p of [...diff.toPull, ...diff.newRemote]) {
    const content = remoteContent[p];
    if (!content && content !== '') continue;
    const localPath = path.join(outputDir, p.replace(/^\//, ''));
    fs.mkdirSync(path.dirname(localPath), { recursive: true });
    fs.writeFileSync(localPath, content);
    const label = diff.newRemote.includes(p) ? 'new on computer' : 'updated on computer';
    const icon = diff.newRemote.includes(p) ? '+' : '\u2193';
    console.log(`  ${icon} ${p.replace(/^\//, '')}  ${label}`);
    pulled++;
  }

  // Handle conflicts
  for (const p of diff.conflicts) {
    if (force) {
      // Force mode: pull remote version, overwrite local
      const content = remoteContent[p];
      if (!content && content !== '') continue;
      const localPath = path.join(outputDir, p.replace(/^\//, ''));
      fs.mkdirSync(path.dirname(localPath), { recursive: true });
      fs.writeFileSync(localPath, content);
      console.log(`  ! ${p.replace(/^\//, '')}  overwritten (--force)`);
      pulled++;
    } else {
      // Save remote version alongside local
      const content = remoteContent[p];
      if (content || content === '') {
        const localPath = path.join(outputDir, p.replace(/^\//, '') + '.remote');
        fs.mkdirSync(path.dirname(localPath), { recursive: true });
        fs.writeFileSync(localPath, content);
      }
      console.log(`  \u26A0 ${p.replace(/^\//, '')}  CONFLICT \u2014 both you and the computer changed this`);
      console.log(`    \u2192 Remote version saved as ${p.replace(/^\//, '')}.remote`);
      conflictCount++;
    }
  }

  // Apply remote deletions
  for (const p of diff.deletedRemote) {
    const baseHash = effectiveManifest && effectiveManifest.files && effectiveManifest.files[p]
      ? effectiveManifest.files[p].hash
      : null;
    const localHash = localFiles[p] ? localFiles[p].hash : null;
    const localChanged = Boolean(baseHash && localHash && localHash !== baseHash);

    if (force || !localChanged) {
      const localPath = path.join(outputDir, p.replace(/^\//, ''));
      fs.rmSync(localPath, { force: true });
      pruneEmptyParentDirs(localPath, outputDir);
      console.log(`  - ${p.replace(/^\//, '')}  deleted on computer`);
      deleted++;
    } else {
      console.log(`  \u26A0 ${p.replace(/^\//, '')}  deleted on computer, but you changed it locally`);
      conflictCount++;
    }
  }

  // FORCE MIRROR SWEEP — local must EXACTLY match cloud after a force pull.
  // The threeWayCompare path with effectiveManifest=null only computes
  // newLocal/conflicts/newRemote and never marks files as deletedRemote, so
  // local-only files (created locally, never on cloud) survive a force pull.
  // That breaks the "cloud is the source of truth" promise. Sweep them now.
  //
  // SAFETY GUARDS — without these the sweep can wipe an entire local copy:
  //   • Scope the sweep: when --only is set, only sweep paths INSIDE the
  //     prefix(es). Out-of-scope local files must be left alone — the user
  //     asked for a partial pull, not a workspace-wide reset.
  //   • Skip when remoteFiles is empty AND local has in-scope content: the
  //     snapshot endpoint has a known server-side bug where it returns 0
  //     files for healthy workspaces. If cloud reports empty but local has
  //     in-scope content we refuse to sweep — the user can re-run with
  //     --keep-local and investigate, or run `atris align --hard` for an
  //     explicit nuke.
  //   • Skip files the server's snapshot filter hides. The warm runner's
  //     _snapshot_dir (ecs_warm_runner.py) deliberately omits CLAUDE.md and
  //     other names from snapshots, so they never appear in remoteFiles even
  //     when they DO exist on cloud. Sweeping them would delete server-managed
  //     files that aren't actually missing on cloud.
  const SERVER_HIDDEN_BASENAMES = new Set(['CLAUDE.md']);
  function basename(p) {
    const idx = p.lastIndexOf('/');
    return idx === -1 ? p : p.slice(idx + 1);
  }
  function isInScope(p) {
    if (!onlyPrefixes) return true;
    const rel = p.replace(/^\//, '');
    return onlyPrefixes.some((pref) => rel.startsWith(pref));
  }
  if (force) {
    const remotePathSet = new Set(Object.keys(remoteFiles));
    const inScopeLocal = Object.keys(localFiles).filter(isInScope);
    if (remotePathSet.size === 0 && inScopeLocal.length > 0) {
      console.log('');
      console.log('  ⚠ Cloud reported zero files but local has in-scope content. Refusing to sweep.');
      console.log('    This usually means the snapshot endpoint glitched. Try again,');
      console.log('    or run `atris align --hard` if you really want to nuke local.');
    } else {
      for (const p of inScopeLocal) {
        if (remotePathSet.has(p)) continue;
        if (SERVER_HIDDEN_BASENAMES.has(basename(p))) continue;
        const localPath = path.join(outputDir, p.replace(/^\//, ''));
        try {
          fs.rmSync(localPath, { force: true });
          pruneEmptyParentDirs(localPath, outputDir);
          console.log(`  - ${p.replace(/^\//, '')}  not on cloud, removed locally`);
          deleted++;
        } catch {
          // ignore — file might already be gone
        }
      }
    }
  }

  // Show unchanged
  if (unchangedCount > 0 && pulled === 0 && deleted === 0 && conflictCount === 0) {
    console.log('  Already up to date.');
  }

  // Summary
  console.log('');
  const parts = [];
  if (pulled > 0) parts.push(`${pulled} pulled`);
  if (deleted > 0) parts.push(`${deleted} deleted`);
  if (diff.newRemote.length > 0 && !parts.some(p => p.includes('pulled'))) parts.push(`${diff.newRemote.length} new`);
  if (unchangedCount > 0) parts.push(`${unchangedCount} unchanged`);
  if (conflictCount > 0) parts.push(`${conflictCount} conflict${conflictCount > 1 ? 's' : ''}`);
  if (parts.length > 0) console.log(`  ${parts.join(', ')}.`);

  // Get current commit hash from remote (for manifest)
  let commitHash = null;
  try {
    const headResult = await apiRequestJson(
      `/business/${businessId}/workspaces/${workspaceId}/git/head`,
      { method: 'GET', token: creds.token }
    );
    if (headResult.ok && headResult.data && headResult.data.commit) {
      commitHash = headResult.data.commit;
    }
  } catch {
    // Git might not be initialized yet — that's fine
  }

  // ANTI-WIPE GUARD: if cloud reported zero in-scope files but local still
  // has in-scope content (i.e. the sweep refused), don't overwrite the
  // manifest with empty data for the scoped subtree. The manifest is the
  // authoritative record of what we last knew was on cloud — wiping it
  // because of a transient empty snapshot would force every subsequent
  // push to flag every file as drift. Better to leave the manifest stale
  // than to record a never-actually-true "cloud is empty" state.
  //
  // Applies to both whole-workspace pulls and scoped (--only) pulls.
  {
    const inScopeLocalCount = onlyPrefixes
      ? Object.keys(localFiles).filter((p) => onlyPrefixes.some((pref) => p.replace(/^\//, '').startsWith(pref))).length
      : Object.keys(localFiles).length;
    if (Object.keys(remoteFiles).length === 0 && inScopeLocalCount > 0) {
      return;
    }
  }

  // Save manifest — when using --only, merge into existing manifest so paths
  // OUTSIDE the scoped prefix don't get dropped. Inside the scoped prefix,
  // however, we must replace (not merge) so that files deleted on cloud
  // since the last sync get evicted from the manifest. Without this, the
  // push freshness check would forever flag those paths as "deleted on
  // cloud" drift, blocking pushes for no reason.
  let manifestFiles = remoteFiles;
  if (onlyPrefixes && manifest && manifest.files) {
    const merged = {};
    // 1. Keep paths from old manifest that are OUTSIDE the scoped prefix.
    for (const [p, info] of Object.entries(manifest.files)) {
      const inScope = onlyPrefixes.some((pref) => p.replace(/^\//, '').startsWith(pref));
      if (!inScope) merged[p] = info;
    }
    // 2. Overwrite the in-scope subtree with what we just pulled (cloud truth).
    for (const [p, info] of Object.entries(remoteFiles)) {
      merged[p] = info;
    }
    manifestFiles = merged;
  }
  const newManifest = buildManifest(manifestFiles, commitHash);
  saveManifest(resolvedSlug || slug, newManifest);

  // Save business config in the output dir so push/status work without args
  const atrisDir = path.join(outputDir, '.atris');
  fs.mkdirSync(atrisDir, { recursive: true });
  fs.writeFileSync(path.join(atrisDir, 'business.json'), JSON.stringify({
    slug: resolvedSlug || slug,
    business_id: businessId,
    workspace_id: workspaceId,
    name: businessName,
  }, null, 2));

  // Wire skills → .claude/skills/ so they work as slash commands
  const skillsDir = path.join(outputDir, 'skills');
  const claudeSkillsDir = path.join(outputDir, '.claude', 'skills');

  if (fs.existsSync(skillsDir)) {
    fs.mkdirSync(claudeSkillsDir, { recursive: true });

    // Recursively find all skill folders (any dir containing SKILL.md, at any depth)
    const wireSkills = (dir, relPrefix) => {
      const entries = fs.readdirSync(dir);
      for (const entry of entries) {
        const fullPath = path.join(dir, entry);
        if (!fs.statSync(fullPath).isDirectory()) continue;
        if (entry === 'README.md' || entry.startsWith('.')) continue;

        const skillFile = path.join(fullPath, 'SKILL.md');
        if (fs.existsSync(skillFile)) {
          // This is a leaf skill — wire it
          const skillName = relPrefix ? `${relPrefix}-${entry}` : entry;
          const symlinkPath = path.join(claudeSkillsDir, skillName);
          const relativePath = path.relative(path.dirname(symlinkPath), fullPath);

          // Business skills override init skills (remove existing symlink if present)
          if (fs.existsSync(symlinkPath)) {
            try {
              const stat = fs.lstatSync(symlinkPath);
              if (stat.isSymbolicLink()) fs.unlinkSync(symlinkPath);
              else continue; // Don't overwrite real directories
            } catch { continue; }
          }
          try {
            fs.symlinkSync(relativePath, symlinkPath);
          } catch (e) {
            // Fallback: copy
            fs.mkdirSync(symlinkPath, { recursive: true });
            fs.copyFileSync(skillFile, path.join(symlinkPath, 'SKILL.md'));
          }
        }

        // Recurse into subdirectories (e.g. skills/executive/pipeline-health/)
        wireSkills(fullPath, relPrefix ? `${relPrefix}-${entry}` : entry);
      }
    };

    wireSkills(skillsDir, '');

    // Count wired skills
    const wiredSkills = fs.readdirSync(claudeSkillsDir).filter(f => {
      const p = path.join(claudeSkillsDir, f);
      return fs.statSync(p).isDirectory();
    });
    if (wiredSkills.length > 0) {
      console.log(`  Wired ${wiredSkills.length} skills → .claude/skills/`);
    }
  }

}


function _timeSince(isoString) {
  if (!isoString) return null;
  const diff = Date.now() - new Date(isoString).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}


async function pullGeneralJournal(token, agentId) {
  // Pull today's journal and recent days
  const today = new Date();
  const dates = [];
  for (let i = 0; i < 3; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    dates.push(d.toISOString().split('T')[0]);
  }

  let synced = 0;

  for (const date of dates) {
    const result = await apiRequestJson(`/agents/${agentId}/journal/${date}`, {
      method: 'GET',
      token,
    });

    if (!result.ok || !result.data || !result.data.content) continue;

    const remoteContent = result.data.content;
    const { logFile, yearDir } = getLogPath(date);

    if (!fs.existsSync(yearDir)) {
      fs.mkdirSync(yearDir, { recursive: true });
    }

    const localContent = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';

    if (localContent.trim() === remoteContent.trim()) continue;

    if (!localContent || localContent.trim() === '') {
      // No local — just write remote
      fs.writeFileSync(logFile, remoteContent);
      console.log(`  Journal ${date} pulled`);
      synced++;
    } else {
      // Both exist and differ — merge
      try {
        const localSections = parseJournalSections(localContent);
        const remoteSections = parseJournalSections(remoteContent);
        const { merged, conflicts } = mergeSections(localSections, remoteSections);

        if (conflicts.length === 0) {
          const mergedContent = reconstructJournal(merged);
          fs.writeFileSync(logFile, mergedContent);
          console.log(`  Journal ${date} merged`);
          synced++;
        } else {
          // Conflicts — keep local, warn
          console.log(`  Journal ${date} has conflicts (kept local, run "atris log sync" to resolve)`);
        }
      } catch {
        console.log(`  Journal ${date} differs (run "atris log sync" to resolve)`);
      }
    }
  }

  if (synced === 0) {
    console.log('  General journal: up to date');
  }

  return synced;
}

async function pullMemberJournal(token, agentId, memberName, memberDir) {
  const result = await apiRequestJson(`/agent/${agentId}/export-journal`, {
    method: 'GET',
    token,
  });

  if (!result.ok || !result.data || !result.data.files) {
    console.log(`  ${memberName}: no journal entries`);
    return 0;
  }

  const files = result.data.files;
  let synced = 0;

  for (const file of files) {
    if (!file.path || !file.content) continue;

    const localPath = path.resolve(memberDir, file.path);
    if (!localPath.startsWith(path.resolve(memberDir))) continue;
    const localContent = fs.existsSync(localPath) ? fs.readFileSync(localPath, 'utf8') : '';

    if (localContent.trim() === file.content.trim()) continue;

    fs.mkdirSync(path.dirname(localPath), { recursive: true });
    fs.writeFileSync(localPath, file.content);
    synced++;
  }

  if (synced > 0) {
    console.log(`  ${memberName}: ${synced} journal ${synced === 1 ? 'entry' : 'entries'} pulled`);
  } else {
    console.log(`  ${memberName}: up to date`);
  }

  return synced;
}

module.exports = { pullAtris };
