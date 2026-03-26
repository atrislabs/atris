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

async function pullAtris() {
  const arg = process.argv[3];

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

  const force = process.argv.includes('--force');

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
  } else {
    const atrisDir = path.join(process.cwd(), 'atris');
    if (fs.existsSync(atrisDir)) {
      outputDir = path.join(atrisDir, slug);
    } else {
      outputDir = path.join(process.cwd(), slug);
    }
  }

  // Resolve business ID — always refresh from API to avoid stale workspace_id
  let businessId, workspaceId, businessName, resolvedSlug;
  const businesses = loadBusinesses();

  const listResult = await apiRequestJson('/businesses/', { method: 'GET', token: creds.token });
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

  // Get remote snapshot — pass --only prefixes to server for faster response
  let snapshotUrl = `/businesses/${businessId}/workspaces/${workspaceId}/snapshot?include_content=true`;
  if (onlyPrefixes) {
    snapshotUrl += `&paths=${encodeURIComponent(onlyPrefixes.map(p => p.replace(/\/$/, '')).join(','))}`;
  }
  const result = await apiRequestJson(snapshotUrl, { method: 'GET', token: creds.token, timeoutMs });

  clearInterval(loading);
  const totalSec = Math.floor((Date.now() - startTime) / 1000);
  process.stdout.write(`\r  Fetched in ${totalSec}s.${' '.repeat(20)}\n`);

  if (!result.ok) {
    const msg = result.errorMessage || result.error || `HTTP ${result.status}`;
    if (result.status === 0 || (typeof msg === 'string' && msg.toLowerCase().includes('timeout'))) {
      console.error(`\n  Workspace timed out (large workspaces can take 60s+). Try: atris pull ${slug} --timeout=600`);
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
    return;
  }

  console.log(`  Processing ${files.length} files...`);

  // Apply --only filter if specified
  if (onlyPrefixes) {
    files = files.filter(file => {
      if (!file.path) return false;
      const rel = file.path.replace(/^\//, '');
      return onlyPrefixes.some(prefix => rel.startsWith(prefix));
    });
    if (files.length === 0) {
      console.log(`  No files matched --only filter: ${onlyPrefixes.join(', ')}`);
      return;
    }
    console.log(`  Filtered to ${files.length} files matching: ${onlyPrefixes.join(', ')}`);
  }

  // Build remote file map {path: {hash, size, content}}
  const remoteFiles = {};
  const remoteContent = {};
  for (const file of files) {
    if (!file.path || file.binary || file.content === null || file.content === undefined) continue;
    // Skip empty files (deleted files that were blanked out)
    if (file.content === '') continue;
    // Compute hash from content bytes (matches computeLocalHashes raw byte hashing)
    const crypto = require('crypto');
    const rawBytes = Buffer.from(file.content, 'utf-8');
    remoteFiles[file.path] = { hash: crypto.createHash('sha256').update(rawBytes).digest('hex'), size: rawBytes.length };
    remoteContent[file.path] = file.content;
  }

  // Compute local file hashes
  const localFiles = fs.existsSync(outputDir) ? computeLocalHashes(outputDir) : {};

  // If output dir is empty (fresh clone) or --force, treat as first sync — pull everything
  const effectiveManifest = (Object.keys(localFiles).length === 0 || force) ? null : manifest;

  // Three-way compare
  const diff = threeWayCompare(localFiles, remoteFiles, effectiveManifest);

  // Apply changes
  let pulled = 0;
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

  // Warn about remote deletions
  for (const p of diff.deletedRemote) {
    console.log(`  - ${p.replace(/^\//, '')}  deleted on computer`);
  }

  // Show unchanged
  if (unchangedCount > 0 && pulled === 0 && conflictCount === 0 && diff.deletedRemote.length === 0) {
    console.log('  Already up to date.');
  }

  // Summary
  console.log('');
  const parts = [];
  if (pulled > 0) parts.push(`${pulled} pulled`);
  if (diff.newRemote.length > 0 && !parts.some(p => p.includes('pulled'))) parts.push(`${diff.newRemote.length} new`);
  if (unchangedCount > 0) parts.push(`${unchangedCount} unchanged`);
  if (conflictCount > 0) parts.push(`${conflictCount} conflict${conflictCount > 1 ? 's' : ''}`);
  if (diff.deletedRemote.length > 0) parts.push(`${diff.deletedRemote.length} deleted remotely`);
  if (parts.length > 0) console.log(`  ${parts.join(', ')}.`);

  // Get current commit hash from remote (for manifest)
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
    // Git might not be initialized yet — that's fine
  }

  // Save manifest — when using --only, merge into existing manifest to avoid data loss
  let manifestFiles = remoteFiles;
  if (onlyPrefixes && manifest && manifest.files) {
    manifestFiles = { ...manifest.files, ...remoteFiles };
  }
  const newManifest = buildManifest(manifestFiles, commitHash);
  saveManifest(resolvedSlug || slug, newManifest);
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
