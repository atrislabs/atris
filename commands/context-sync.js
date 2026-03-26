const fs = require('fs');
const path = require('path');
const { loadCredentials } = require('../utils/auth');
const { apiRequestJson } = require('../utils/api');
const { loadBusinesses } = require('./business');
const { loadManifest, computeLocalHashes, threeWayCompare } = require('../lib/manifest');

/**
 * Resolve a business slug to its IDs. Shared helper.
 */
async function resolveBusiness(slug) {
  const creds = loadCredentials();
  if (!creds || !creds.token) {
    console.error('Not logged in. Run: atris login');
    process.exit(1);
  }

  const businesses = loadBusinesses();
  if (businesses[slug]) {
    return {
      businessId: businesses[slug].business_id,
      workspaceId: businesses[slug].workspace_id,
      name: businesses[slug].name || slug,
      slug: businesses[slug].slug || slug,
      token: creds.token,
    };
  }

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
  return {
    businessId: match.id,
    workspaceId: match.workspace_id,
    name: match.name,
    slug: match.slug,
    token: creds.token,
  };
}


/**
 * atris status <business-slug>
 * Shows what's different locally vs remote without transferring.
 */
async function businessStatus(slug) {
  const biz = await resolveBusiness(slug);

  if (!biz.workspaceId) {
    console.error(`Business "${slug}" has no workspace.`);
    process.exit(1);
  }

  const manifest = loadManifest(biz.slug);
  const timeSince = manifest ? _timeSince(manifest.last_sync) : null;

  console.log('');
  console.log(`${biz.name}` + (timeSince ? ` \u2014 last synced ${timeSince}` : ' \u2014 never synced'));

  // Determine local directory
  const atrisDir = path.join(process.cwd(), 'atris', slug);
  const cwdDir = path.join(process.cwd(), slug);
  let localDir = null;
  if (fs.existsSync(atrisDir)) localDir = atrisDir;
  else if (fs.existsSync(cwdDir)) localDir = cwdDir;

  // Get remote snapshot with content (needed for reliable hash computation)
  const result = await apiRequestJson(
    `/businesses/${biz.businessId}/workspaces/${biz.workspaceId}/snapshot?include_content=true`,
    { method: 'GET', token: biz.token, timeoutMs: 120000 }
  );

  if (!result.ok) {
    if (result.status === 409) {
      console.log('  Computer is sleeping. Wake it first.');
    } else {
      console.error(`  Failed to get remote state: ${result.errorMessage || result.status}`);
    }
    process.exit(1);
  }

  const remoteFiles = {};
  const crypto = require('crypto');
  for (const file of (result.data.files || [])) {
    if (file.path && !file.binary && file.content != null) {
      const rawBytes = Buffer.from(file.content, 'utf-8');
      remoteFiles[file.path] = { hash: crypto.createHash('sha256').update(rawBytes).digest('hex'), size: rawBytes.length };
    }
  }

  const localFiles = localDir ? computeLocalHashes(localDir) : {};
  const diff = threeWayCompare(localFiles, remoteFiles, manifest);

  console.log('');

  // You changed
  const youChanged = [...diff.toPush, ...diff.newLocal];
  if (youChanged.length > 0) {
    console.log('  You changed:');
    for (const p of youChanged) {
      const label = diff.newLocal.includes(p) ? '(new)' : '';
      console.log(`    ${p.replace(/^\//, '')} ${label}`);
    }
  }

  // Computer changed
  const computerChanged = [...diff.toPull, ...diff.newRemote];
  if (computerChanged.length > 0) {
    console.log('  Computer changed:');
    for (const p of computerChanged) {
      const label = diff.newRemote.includes(p) ? '(new)' : '';
      console.log(`    ${p.replace(/^\//, '')} ${label}`);
    }
  }

  // Conflicts
  if (diff.conflicts.length > 0) {
    console.log('  Conflicts:');
    for (const p of diff.conflicts) {
      console.log(`    ${p.replace(/^\//, '')}`);
    }
  } else if (youChanged.length > 0 || computerChanged.length > 0) {
    console.log('  Conflicts:          (none)');
  }

  // Remote deletions
  if (diff.deletedRemote.length > 0) {
    console.log('  Deleted on computer:');
    for (const p of diff.deletedRemote) {
      console.log(`    ${p.replace(/^\//, '')}`);
    }
  }

  if (youChanged.length === 0 && computerChanged.length === 0 && diff.conflicts.length === 0) {
    if (!localDir) {
      console.log('  No local copy found. Run: atris pull ' + slug);
    } else {
      console.log('  Everything up to date.');
    }
  }

  console.log('');
}


/**
 * atris log <business-slug>
 * Shows human-readable commit history.
 */
async function businessLog(slug) {
  const biz = await resolveBusiness(slug);

  if (!biz.workspaceId) {
    console.error(`Business "${slug}" has no workspace.`);
    process.exit(1);
  }

  const limit = 20;
  const pathFilter = process.argv.includes('--path') ? process.argv[process.argv.indexOf('--path') + 1] : null;

  const params = `limit=${limit}` + (pathFilter ? `&path=${encodeURIComponent(pathFilter)}` : '');
  const result = await apiRequestJson(
    `/businesses/${biz.businessId}/workspaces/${biz.workspaceId}/git/log?${params}`,
    { method: 'GET', token: biz.token }
  );

  if (!result.ok) {
    if (result.status === 409) {
      console.log('\n  Computer is sleeping. Wake it first.\n');
    } else {
      console.error(`\n  Failed to get history: ${result.errorMessage || result.status}\n`);
    }
    process.exit(1);
  }

  const commits = result.data.commits || [];
  if (commits.length === 0) {
    console.log(`\n  ${biz.name} \u2014 no history yet.\n`);
    return;
  }

  console.log(`\n  ${biz.name} \u2014 history\n`);

  for (const commit of commits) {
    const date = _timeSince(commit.date) || commit.date;
    const msg = commit.message || '';

    // Parse actor from message format "actor/name: message"
    const colonIdx = msg.indexOf(': ');
    let actor = '';
    let description = msg;
    if (colonIdx > 0 && colonIdx < 40) {
      actor = msg.substring(0, colonIdx);
      description = msg.substring(colonIdx + 2);
    }

    const actorDisplay = actor ? `  ${actor}` : '';
    console.log(`  ${date.padEnd(12)} ${actorDisplay}`);
    console.log(`               ${description}`);
    console.log('');
  }
}


function _timeSince(isoString) {
  if (!isoString) return null;
  const diff = Date.now() - new Date(isoString).getTime();
  if (diff < 0) return 'just now';
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}


module.exports = { businessStatus, businessLog };
