const fs = require('fs');
const path = require('path');
const { loadCredentials } = require('../utils/auth');
const { apiRequestJson } = require('../utils/api');

function getBusinessConfigPath() {
  const home = require('os').homedir();
  const dir = path.join(home, '.atris');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'businesses.json');
}

function loadBusinesses() {
  const p = getBusinessConfigPath();
  if (!fs.existsSync(p)) return {};
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return {}; }
}

function saveBusinesses(data) {
  fs.writeFileSync(getBusinessConfigPath(), JSON.stringify(data, null, 2));
}

async function addBusiness(slug) {
  if (!slug) {
    console.error('Usage: atris business add <slug>');
    process.exit(1);
  }

  const creds = loadCredentials();
  if (!creds || !creds.token) {
    console.error('Not logged in. Run: atris login');
    process.exit(1);
  }

  // Resolve slug to business
  const result = await apiRequestJson(`/business/by-slug/${slug}`, {
    method: 'GET',
    token: creds.token,
  });

  if (!result.ok) {
    // Try listing all and matching
    const listResult = await apiRequestJson('/business/', { method: 'GET', token: creds.token });
    if (listResult.ok && Array.isArray(listResult.data)) {
      const match = listResult.data.find(b => b.slug === slug || b.name.toLowerCase() === slug.toLowerCase());
      if (match) {
        const businesses = loadBusinesses();
        businesses[slug] = {
          business_id: match.id,
          workspace_id: match.workspace_id,
          name: match.name,
          slug: match.slug,
          added_at: new Date().toISOString(),
        };
        saveBusinesses(businesses);
        console.log(`\nAdded "${match.name}" (${match.slug})`);
        return;
      }
    }
    console.error(`Business "${slug}" not found.`);
    process.exit(1);
  }

  const biz = result.data;
  const businesses = loadBusinesses();
  businesses[slug] = {
    business_id: biz.id,
    workspace_id: biz.workspace_id,
    name: biz.name,
    slug: biz.slug,
    added_at: new Date().toISOString(),
  };
  saveBusinesses(businesses);
  console.log(`\nAdded "${biz.name}" (${biz.slug})`);
}

async function listBusinesses() {
  const businesses = loadBusinesses();
  const slugs = Object.keys(businesses);

  if (slugs.length === 0) {
    console.log('\nNo businesses connected. Run: atris business add <slug>');
    return;
  }

  console.log('\nConnected businesses:\n');
  for (const slug of slugs) {
    const b = businesses[slug];
    console.log(`  ${b.name || slug} (${b.slug || slug})`);
    console.log(`    ID: ${b.business_id}`);
    console.log(`    Added: ${b.added_at || 'unknown'}`);
    console.log('');
  }
}

async function removeBusiness(slug) {
  if (!slug) {
    console.error('Usage: atris business remove <slug>');
    process.exit(1);
  }

  const businesses = loadBusinesses();
  if (!businesses[slug]) {
    console.error(`Business "${slug}" not connected.`);
    process.exit(1);
  }

  const name = businesses[slug].name || slug;
  delete businesses[slug];
  saveBusinesses(businesses);
  console.log(`\nRemoved "${name}"`);
}

// ---------------------------------------------------------------------------
// Resolve a slug to a business ID using local cache or API lookup
// ---------------------------------------------------------------------------
async function resolveSlug(slug, creds) {
  // Check local cache first
  const businesses = loadBusinesses();
  if (businesses[slug]) {
    return businesses[slug];
  }

  // Try by-slug endpoint
  const result = await apiRequestJson(`/business/by-slug/${slug}/`, {
    method: 'GET',
    token: creds.token,
  });
  if (result.ok && result.data) {
    return { business_id: result.data.id, workspace_id: result.data.workspace_id, name: result.data.name, slug: result.data.slug };
  }

  // Fallback: list all and match
  const listResult = await apiRequestJson('/business/', { method: 'GET', token: creds.token });
  if (listResult.ok && Array.isArray(listResult.data)) {
    const match = listResult.data.find(b => b.slug === slug || b.name.toLowerCase() === slug.toLowerCase());
    if (match) {
      return { business_id: match.id, workspace_id: match.workspace_id, name: match.name, slug: match.slug };
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Helper: format relative time
// ---------------------------------------------------------------------------
function relativeTime(dateStr) {
  if (!dateStr) return 'unknown';
  const diff = Date.now() - new Date(dateStr).getTime();
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  if (days <= 0) return 'today';
  if (days === 1) return '1d ago';
  return `${days}d ago`;
}

// ---------------------------------------------------------------------------
// Helper: activity bar
// ---------------------------------------------------------------------------
function activityBar(daysSinceActive, width = 10) {
  const filled = Math.max(0, Math.min(width, width - Math.floor(daysSinceActive / 3)));
  return '\u2501'.repeat(filled) + '\u2591'.repeat(width - filled);
}

// ---------------------------------------------------------------------------
// atris business health <slug>
// ---------------------------------------------------------------------------
async function businessHealth(slug) {
  if (!slug) {
    console.error('Usage: atris business health <slug>');
    process.exit(1);
  }

  const creds = loadCredentials();
  if (!creds || !creds.token) {
    console.error('Not logged in. Run: atris login');
    process.exit(1);
  }

  const biz = await resolveSlug(slug, creds);
  if (!biz) {
    console.error(`Business "${slug}" not found.`);
    process.exit(1);
  }

  const bizId = biz.business_id;
  const wsId = biz.workspace_id;

  // Fetch dashboard and workspace snapshot in parallel
  const fetchOpts = { method: 'GET', token: creds.token, timeoutMs: 120000 };
  const [dashResult, wsResult] = await Promise.all([
    apiRequestJson(`/business/${bizId}/dashboard/`, fetchOpts),
    wsId
      ? apiRequestJson(`/business/${bizId}/workspaces/${wsId}/snapshot?include_content=false`, fetchOpts)
      : Promise.resolve({ ok: false }),
  ]);

  const dashboard = dashResult.ok ? dashResult.data : null;
  const workspace = wsResult.ok ? wsResult.data : null;

  const name = dashboard?.business?.name || biz.name || slug;

  console.log('');
  console.log(`Business Health: ${name}`);
  console.log('\u2501'.repeat(26 + name.length));
  console.log('');

  // Workspace stats
  const files = workspace?.files || [];
  const totalSize = files.reduce((sum, f) => sum + (f.size || 0), 0);
  const fileSizeStr = totalSize > 1024 ? `${Math.round(totalSize / 1024)}KB` : `${totalSize}B`;
  console.log(`  Workspace:  ${files.length} files, ${fileSizeStr}`);

  // Members
  const members = dashboard?.roster?.members || dashboard?.members || dashboard?.business?.members || [];
  const humanMembers = members.filter(m => !m.is_agent && m.role !== 'agent');
  const agentMembers = members.filter(m => m.is_agent || m.role === 'agent');
  const memberCountStr = members.length > 0
    ? `${members.length} (${humanMembers.length} human, ${agentMembers.length} agent)`
    : `${members.length}`;
  console.log(`  Members:    ${memberCountStr}`);

  // Apps
  const apps = dashboard?.business?.apps || dashboard?.apps || [];
  console.log(`  Apps:       ${Array.isArray(apps) ? apps.length : 0}`);

  // Status
  const status = dashboard?.business?.status || dashboard?.status || 'unknown';
  console.log(`  Status:     ${status}`);

  // Member activity
  if (members.length > 0) {
    console.log('');
    console.log('  Member Activity:');
    for (const m of members) {
      const memberName = m.display_name || m.name || m.email || 'Unknown';
      const role = m.role || 'member';
      const lastActive = m.atris?.last_active || m.last_active || m.last_login || m.joined_at || m.created_at;
      const daysSince = lastActive ? Math.floor((Date.now() - new Date(lastActive).getTime()) / (1000 * 60 * 60 * 24)) : 999;
      const bar = activityBar(daysSince);
      const label = daysSince <= 1 ? 'active' : `last active ${relativeTime(lastActive)}`;
      console.log(`    ${memberName.padEnd(18)} ${role.padEnd(8)} ${bar} ${label}`);
    }
  }

  // Workspace breakdown by directory
  if (files.length > 0) {
    console.log('');
    console.log('  Workspace Breakdown:');
    const dirSizes = {};
    for (const f of files) {
      const filePath = f.path || f.name || '';
      const dir = filePath.includes('/') ? filePath.split('/')[0] + '/' : '/';
      dirSizes[dir] = (dirSizes[dir] || 0) + (f.size || 0);
    }
    const maxDirSize = Math.max(...Object.values(dirSizes), 1);
    const sortedDirs = Object.entries(dirSizes).sort((a, b) => b[1] - a[1]);
    for (const [dir, size] of sortedDirs) {
      const sizeStr = size > 1024 ? `${Math.round(size / 1024)}KB` : `${size}B`;
      const barLen = Math.max(1, Math.round((size / maxDirSize) * 10));
      console.log(`    ${dir.padEnd(12)} ${sizeStr.padStart(5)}   ${'█'.repeat(barLen)}`);
    }
  }

  // Issues
  console.log('');
  console.log('  Issues:');
  let hasIssues = false;
  const humanMembers2 = members.filter(m => m.role !== 'agent');
  for (const m of humanMembers2) {
    const lastActive = m.atris?.last_active || m.last_active || m.last_login || m.joined_at || m.created_at;
    const daysSince = lastActive ? Math.floor((Date.now() - new Date(lastActive).getTime()) / (1000 * 60 * 60 * 24)) : 999;
    if (daysSince >= 30) {
      const memberName = m.display_name || m.name || m.email || 'Unknown';
      console.log(`    \u26A0 ${memberName} inactive for ${daysSince}+ days`);
      hasIssues = true;
    }
  }

  // Check for workspace bloat (arbitrary threshold: >500KB or >100 files)
  if (totalSize > 500 * 1024) {
    console.log(`    \u26A0 Workspace large (${fileSizeStr})`);
    hasIssues = true;
  }
  if (files.length > 100) {
    console.log(`    \u26A0 Workspace has ${files.length} files (consider cleanup)`);
    hasIssues = true;
  }
  if (!hasIssues) {
    console.log('    \u2713 Workspace clean (no bloat detected)');
  }

  console.log('');
}

// ---------------------------------------------------------------------------
// atris business audit
// ---------------------------------------------------------------------------
async function businessAudit() {
  const creds = loadCredentials();
  if (!creds || !creds.token) {
    console.error('Not logged in. Run: atris login');
    process.exit(1);
  }

  const listResult = await apiRequestJson('/business/', { method: 'GET', token: creds.token });
  if (!listResult.ok || !Array.isArray(listResult.data)) {
    console.error(`Failed to fetch businesses: ${listResult.error || 'unknown error'}`);
    process.exit(1);
  }

  const businesses = listResult.data;

  console.log('');
  console.log('Business Audit');
  console.log('\u2501'.repeat(14));
  console.log('');

  for (const biz of businesses) {
    const name = biz.name || biz.slug || 'Unknown';
    const memberCount = typeof biz.member_count === 'number' ? biz.member_count : (Array.isArray(biz.members) ? biz.members.length : 0);
    const appCount = typeof biz.app_count === 'number' ? biz.app_count : (Array.isArray(biz.apps) ? biz.apps.length : 0);

    // Determine activity status
    const status = biz.status || 'unknown';
    const isActive = status === 'active' || (memberCount > 1 && appCount > 0);
    const hasContent = memberCount > 1 || appCount > 0;

    let icon, activityLabel;
    if (isActive) {
      icon = '\u2713';
      activityLabel = appCount > 0 ? 'active' : 'idle';
    } else if (hasContent) {
      icon = '\u26A0';
      activityLabel = 'inactive';
    } else {
      icon = '\u25CB';
      activityLabel = 'inactive';
    }

    const memberStr = memberCount === 1 ? '1 member' : `${memberCount} members`;
    const appStr = appCount === 1 ? '1 app' : `${appCount} apps`;

    console.log(`  ${icon} ${name.padEnd(16)} ${memberStr.padEnd(12)} ${appStr.padEnd(8)} ${activityLabel}`);
  }

  console.log('');
}

async function businessCommand(subcommand, ...args) {
  switch (subcommand) {
    case 'add':
      await addBusiness(args[0]);
      break;
    case 'list':
    case 'ls':
      await listBusinesses();
      break;
    case 'remove':
    case 'rm':
      await removeBusiness(args[0]);
      break;
    case 'health':
      await businessHealth(args[0]);
      break;
    case 'audit':
      await businessAudit();
      break;
    default:
      console.log('Usage: atris business <add|list|remove|health|audit> [slug]');
  }
}

module.exports = { businessCommand, businessHealth, businessAudit, loadBusinesses, saveBusinesses, getBusinessConfigPath };
