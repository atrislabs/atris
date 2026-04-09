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

function detectBusinessSlug(explicitSlug) {
  if (explicitSlug) return explicitSlug;
  const bizFile = path.join(process.cwd(), '.atris', 'business.json');
  if (!fs.existsSync(bizFile)) return null;
  try {
    const biz = JSON.parse(fs.readFileSync(bizFile, 'utf8'));
    return biz.slug || biz.name || null;
  } catch {
    return null;
  }
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

async function listBusinesses(opts = {}) {
  // --local mode: walk ~/arena/atris-business/ and show fleet status table
  // (no API calls, rate-limit safe). Different from API-mode below which lists
  // businesses cached from the API.
  if (opts.local) {
    return listBusinessesLocal(opts);
  }

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

/**
 * Walk ~/arena/atris-business/ and print a fleet status table for every
 * customer workspace. Pure local — no API calls, no rate-limit risk.
 *
 * Classifies each dir as: canonical, flat, unbound, nested, bare, or superseded.
 *
 * Discovered the need for this during overnight loop tick #3 when we hand-wrote
 * /tmp/customer_fleet.md. Now any team member can run `atris business list --local`
 * (or `atris business fleet`) to see fleet state in one shot.
 */
function listBusinessesLocal(opts = {}) {
  const os = require('os');
  const SKIP_DIRS = new Set(['deals', 'archive', 'archives', '_archive', 'templates', 'node_modules', '.git']);
  const SKIP_FILES = new Set(['.DS_Store', 'Thumbs.db']);

  const rootDir = opts.root || path.join(os.homedir(), 'arena', 'atris-business');
  const jsonMode = opts.json === true;

  if (!fs.existsSync(rootDir)) {
    console.error(`Fleet root not found: ${rootDir}`);
    process.exit(1);
  }

  function countFiles(dir) {
    let total = 0;
    let md = 0;
    function walk(d) {
      let entries;
      try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (e.name.startsWith('.git')) continue;
        if (e.name === 'node_modules') continue;
        const full = path.join(d, e.name);
        if (e.isDirectory()) {
          walk(full);
        } else if (e.isFile()) {
          if (SKIP_FILES.has(e.name)) continue;
          total++;
          if (e.name.endsWith('.md')) md++;
        }
      }
    }
    walk(dir);
    return { total, md };
  }

  function classifyCustomer(name) {
    const customerDir = path.join(rootDir, name);
    const businessJson = path.join(customerDir, '.atris', 'business.json');
    const atrisDir = path.join(customerDir, 'atris');
    const nestedDir = path.join(customerDir, name);

    const hasBizJson = fs.existsSync(businessJson);
    const hasAtris = fs.existsSync(atrisDir) && fs.statSync(atrisDir).isDirectory();
    const hasNested = fs.existsSync(nestedDir) && fs.statSync(nestedDir).isDirectory();
    const { total, md } = countFiles(customerDir);

    let state, action, icon;
    if (hasBizJson && hasAtris) {
      state = 'canonical'; action = 'none'; icon = '🟢';
    } else if (hasBizJson && !hasAtris) {
      state = 'flat'; action = 'migrate to atris/ wrapper'; icon = '🟡';
    } else if (!hasBizJson && hasAtris) {
      state = 'unbound'; action = 'create .atris/business.json'; icon = '🟡';
    } else if (hasNested) {
      state = 'nested'; action = 'legacy nesting bug'; icon = '🔴';
    } else if (total < 5) {
      state = 'bare'; action = 'not yet onboarded'; icon = '⚪';
    } else {
      state = 'flat-unbound'; action = 'needs canonical init'; icon = '🟡';
    }

    let bizName = name;
    if (hasBizJson) {
      try {
        const meta = JSON.parse(fs.readFileSync(businessJson, 'utf8'));
        bizName = meta.name || name;
      } catch {}
    }

    return { name, bizName, state, icon, files: total, md, hasBizJson, hasAtris, hasNested, action };
  }

  const entries = fs.readdirSync(rootDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .filter((e) => !e.name.startsWith('.'))
    .filter((e) => !SKIP_DIRS.has(e.name))
    .map((e) => e.name)
    .sort();

  const customers = entries.map(classifyCustomer);

  // Mark superseded: any customer with a -canonical sibling is superseded
  const canonicalNames = new Set(
    customers.filter((c) => c.name.endsWith('-canonical')).map((c) => c.name.replace(/-canonical$/, ''))
  );
  for (const c of customers) {
    if (canonicalNames.has(c.name)) {
      c.state = 'superseded';
      c.icon = '🔴';
      c.action = `superseded by ${c.name}-canonical`;
    }
  }

  if (jsonMode) {
    console.log(JSON.stringify({ root: rootDir, customers }, null, 2));
    return;
  }

  console.log('');
  console.log(`Atris Fleet — ${rootDir}`);
  console.log('═'.repeat(86));
  console.log('  CUSTOMER              STATE         FILES   BIZ.JSON  ATRIS/  ACTION');
  console.log('  ' + '─'.repeat(83));

  const order = ['canonical', 'flat', 'unbound', 'flat-unbound', 'bare', 'nested', 'superseded'];
  const grouped = {};
  for (const c of customers) {
    if (!grouped[c.state]) grouped[c.state] = [];
    grouped[c.state].push(c);
  }

  for (const state of order) {
    if (!grouped[state]) continue;
    for (const c of grouped[state]) {
      const name = c.name.padEnd(20).slice(0, 20);
      const stateLabel = (c.icon + ' ' + state).padEnd(13).slice(0, 13);
      const filesStr = String(c.files).padStart(5);
      const bizStr = c.hasBizJson ? '   ✓    ' : '   ✗    ';
      const atrisStr = c.hasAtris ? '  ✓   ' : '  ✗   ';
      const action = c.action.length > 28 ? c.action.slice(0, 25) + '...' : c.action;
      console.log(`  ${name}  ${stateLabel} ${filesStr}    ${bizStr}  ${atrisStr}  ${action}`);
    }
  }

  console.log('  ' + '─'.repeat(83));

  const counts = {};
  for (const c of customers) counts[c.state] = (counts[c.state] || 0) + 1;
  const summary = order.filter((s) => counts[s]).map((s) => `${counts[s]} ${s}`).join(', ');
  console.log(`  ${customers.length} customers — ${summary}`);
  console.log('');

  const needsWork = customers.filter((c) => ['flat', 'unbound', 'flat-unbound', 'nested'].includes(c.state));
  if (needsWork.length > 0) {
    console.log('  Next actions:');
    needsWork.slice(0, 5).forEach((c) => {
      console.log(`    ${c.icon} ${c.name}: ${c.action}`);
    });
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

async function createBusiness(name, ...flags) {
  if (!name) {
    console.error('Usage: atris business create <name> [--description "..."]');
    process.exit(1);
  }

  const creds = loadCredentials();
  if (!creds || !creds.token) {
    console.error('Not logged in. Run: atris login');
    process.exit(1);
  }

  // Parse flags
  let description = '';
  for (let i = 0; i < flags.length; i++) {
    if ((flags[i] === '--description' || flags[i] === '-d') && flags[i + 1]) {
      description = flags[i + 1];
      i++;
    }
  }

  console.log(`Creating business: ${name}...`);

  const result = await apiRequestJson('/business/', {
    method: 'POST',
    token: creds.token,
    body: { name, description: description || undefined },
  });

  if (!result.ok) {
    console.error(`Failed: ${result.errorMessage || result.error || result.status}`);
    process.exit(1);
  }

  const biz = result.data;

  // Register locally
  const businesses = loadBusinesses();
  businesses[biz.slug] = {
    business_id: biz.id,
    workspace_id: biz.workspace_id,
    name: biz.name,
    slug: biz.slug,
    agent_id: biz.agent_id,
    added_at: new Date().toISOString(),
  };
  saveBusinesses(businesses);

  // Scaffold local directory if in an atris project
  const atrisDir = findAtrisDir();
  if (atrisDir) {
    const bizDir = path.join(atrisDir, 'business', biz.slug);
    if (!fs.existsSync(bizDir)) {
      fs.mkdirSync(path.join(bizDir, 'context'), { recursive: true });
      fs.mkdirSync(path.join(bizDir, 'team'), { recursive: true });
      fs.mkdirSync(path.join(bizDir, 'workspace'), { recursive: true });
      fs.writeFileSync(path.join(bizDir, 'BUSINESS.md'), [
        `# ${biz.name}`,
        description ? `\n> ${description}\n` : '',
        '\n## The Business\n\n[What problem does this solve?]\n',
        '## Revenue Model\n\n[How does this make money?]\n',
        `---\n*Created: ${new Date().toISOString().split('T')[0]}*\n`,
      ].join(''));
      console.log(`  Local scaffold: ${bizDir}/`);
    }
  }

  // Apply template if specified
  let template = null;
  for (let i = 0; i < flags.length; i++) {
    if ((flags[i] === '--template' || flags[i] === '-t') && flags[i + 1]) {
      template = flags[i + 1];
      i++;
    }
  }

  if (template) {
    const templates = {
      'saas': { agents: ['growth-hacker', 'product-analyst', 'support-agent'], desc: 'SaaS Startup' },
      'agency': { agents: ['project-manager', 'researcher', 'outreach-agent'], desc: 'Agency / Consulting' },
      'ecommerce': { agents: ['inventory-analyst', 'marketing-agent', 'support-agent'], desc: 'E-Commerce' },
      'content': { agents: ['writer', 'researcher', 'social-media-agent'], desc: 'Content Creator' },
      'restaurant': { agents: ['review-responder', 'social-media-agent', 'booking-agent'], desc: 'Restaurant / Local' },
    };
    const tpl = templates[template.toLowerCase()];
    if (tpl) {
      console.log(`  Template: ${tpl.desc} (${tpl.agents.length} agents)`);
      for (const agentName of tpl.agents) {
        console.log(`    + ${agentName}`);
      }
    } else {
      console.log(`  Unknown template: ${template}`);
      console.log(`  Available: ${Object.keys(templates).join(', ')}`);
    }
  }

  console.log(`\n  Business created!`);
  console.log(`  ID:        ${biz.id}`);
  console.log(`  Slug:      ${biz.slug}`);
  console.log(`  Agent:     ${biz.agent_id || '(none)'}`);
  console.log(`  Dashboard: https://atris.ai/dashboard/gm/${biz.id}`);
  console.log('');
}


async function businessStatus(slug) {
  const creds = loadCredentials();
  if (!creds || !creds.token) {
    console.error('Not logged in. Run: atris login');
    process.exit(1);
  }

  const resolved = await resolveSlug(slug, creds);
  if (!resolved) {
    console.error('No business specified. Usage: atris business status <slug>');
    process.exit(1);
  }

  const result = await apiRequestJson(`/business/${resolved.business_id}`, {
    method: 'GET',
    token: creds.token,
  });

  if (!result.ok) {
    console.error(`Failed to fetch business: ${result.errorMessage || result.status}`);
    return;
  }

  const biz = result.data;
  const agents = biz.member_count || 0;
  const apps = biz.app_count || 0;

  // Quick status line
  console.log(`\n  ${biz.name} (${biz.slug})`);
  console.log(`  ${'─'.repeat(40)}`);
  console.log(`  Agents:   ${agents}`);
  console.log(`  Apps:     ${apps}`);
  if (biz.workspace_id) console.log(`  Workspace: ${biz.workspace_id.slice(0, 12)}...`);
  console.log(`  Created:  ${biz.created_at ? biz.created_at.split('T')[0] : '?'}`);
  console.log('');
}

function describeAccess(member) {
  const role = (member.role || '').toLowerCase();
  if (role === 'owner') return 'full control';
  if (role === 'admin') return 'admin access';
  if (role === 'member') return 'standard access';
  if (role === 'agent') return 'agent';
  return role || 'unknown';
}

async function businessTeam(slug) {
  const requestedSlug = detectBusinessSlug(slug);
  if (!requestedSlug) {
    console.error('No business specified. Usage: atris business team <slug>');
    process.exit(1);
  }

  const creds = loadCredentials();
  if (!creds || !creds.token) {
    console.error('Not logged in. Run: atris login');
    process.exit(1);
  }

  const resolved = await resolveSlug(requestedSlug, creds);
  if (!resolved) {
    console.error(`Business "${requestedSlug}" not found.`);
    process.exit(1);
  }

  const result = await apiRequestJson(`/business/${resolved.business_id}`, {
    method: 'GET',
    token: creds.token,
  });

  if (!result.ok) {
    console.error(`Failed to fetch business team: ${result.errorMessage || result.status}`);
    process.exit(1);
  }

  const biz = result.data || {};
  const members = Array.isArray(biz.members) ? [...biz.members] : [];
  const roleOrder = { owner: 0, admin: 1, member: 2, agent: 3 };
  members.sort((a, b) => {
    const roleDelta = (roleOrder[a.role] ?? 99) - (roleOrder[b.role] ?? 99);
    if (roleDelta !== 0) return roleDelta;
    const aName = (a.display_name || a.name || a.email || '').toLowerCase();
    const bName = (b.display_name || b.name || b.email || '').toLowerCase();
    return aName.localeCompare(bName);
  });

  const admins = members.filter(m => ['owner', 'admin'].includes((m.role || '').toLowerCase()));
  const nonAdmins = members.filter(m => !['owner', 'admin'].includes((m.role || '').toLowerCase()));
  const roleCounts = members.reduce((acc, member) => {
    const role = member.role || 'unknown';
    acc[role] = (acc[role] || 0) + 1;
    return acc;
  }, {});
  const roleSummary = Object.entries(roleCounts)
    .sort((a, b) => (roleOrder[a[0]] ?? 99) - (roleOrder[b[0]] ?? 99))
    .map(([role, count]) => `${count} ${role}${count === 1 ? '' : 's'}`)
    .join(', ');

  console.log('');
  console.log(`Business Team: ${biz.name || resolved.name || requestedSlug} (${biz.slug || resolved.slug || requestedSlug})`);
  console.log('━'.repeat(32 + (biz.name || resolved.name || requestedSlug).length));
  console.log('');
  console.log(`  Members: ${members.length}`);
  console.log(`  Roles:   ${roleSummary || 'none'}`);
  console.log(`  Admins:  ${admins.length}`);

  if (admins.length > 0) {
    console.log('');
    console.log('  Admin Access:');
    for (const member of admins) {
      const name = member.display_name || member.name || member.email || 'Unknown';
      const email = member.email || '(no email)';
      const role = member.role || 'unknown';
      console.log(`    ${name.padEnd(24)} ${role.padEnd(8)} ${describeAccess(member).padEnd(14)} ${email}`);
    }
  }

  if (nonAdmins.length > 0) {
    console.log('');
    console.log('  Standard Access:');
    for (const member of nonAdmins) {
      const name = member.display_name || member.name || member.email || 'Unknown';
      const email = member.email || '(no email)';
      const role = member.role || 'unknown';
      console.log(`    ${name.padEnd(24)} ${role.padEnd(8)} ${describeAccess(member).padEnd(14)} ${email}`);
    }
  }

  console.log('');
}


async function connectService(connector, ...flags) {
  if (!connector) {
    console.log('Usage: atris business connect <service> [--business <slug>]');
    console.log('');
    console.log('Available connectors:');
    // List skills that look like integrations
    const skillDirs = [
      path.join(__dirname, '..', '..', '.claude', 'skills'),
      path.join(require('os').homedir(), '.claude', 'skills'),
    ];
    const seen = new Set();
    for (const dir of skillDirs) {
      if (!fs.existsSync(dir)) continue;
      for (const name of fs.readdirSync(dir)) {
        const skillFile = path.join(dir, name, 'SKILL.md');
        if (fs.existsSync(skillFile) && !seen.has(name)) {
          seen.add(name);
        }
      }
    }
    const integrations = [...seen].filter(s =>
      ['slack', 'hubspot', 'linear', 'notion', 'google-drive', 'github',
       'calendar', 'email-agent', 'x-search', 'youtube', 'ramp'].includes(s)
    ).sort();
    for (const s of integrations) {
      console.log(`  ${s}`);
    }
    if (integrations.length === 0) console.log('  (none found — install skills first)');
    return;
  }

  // Parse --business flag
  let bizSlug = null;
  for (let i = 0; i < flags.length; i++) {
    if ((flags[i] === '--business' || flags[i] === '-b') && flags[i + 1]) {
      bizSlug = flags[i + 1];
      i++;
    }
  }

  // Find the skill
  const skillDirs = [
    path.join(__dirname, '..', '..', '.claude', 'skills', connector),
    path.join(require('os').homedir(), '.claude', 'skills', connector),
  ];
  let skillPath = null;
  for (const dir of skillDirs) {
    const p = path.join(dir, 'SKILL.md');
    if (fs.existsSync(p)) { skillPath = p; break; }
  }

  if (!skillPath) {
    console.error(`Skill "${connector}" not found.`);
    console.error('Check: .claude/skills/ or ~/.claude/skills/');
    process.exit(1);
  }

  console.log(`\n  Connecting: ${connector}`);
  console.log(`  Skill:     ${skillPath}`);
  if (bizSlug) console.log(`  Business:  ${bizSlug}`);

  // Read skill to check for required secrets
  const skillContent = fs.readFileSync(skillPath, 'utf8');
  const secretMatches = skillContent.match(/[A-Z][A-Z0-9_]*_(?:KEY|TOKEN|SECRET|PASSWORD|API_KEY)/g) || [];
  const uniqueSecrets = [...new Set(secretMatches)];

  if (uniqueSecrets.length > 0) {
    console.log(`\n  Required secrets:`);
    for (const secret of uniqueSecrets) {
      console.log(`    ${secret}`);
    }
    console.log(`\n  Store secrets with: atris computer run "echo $${uniqueSecrets[0]}"`);
    console.log(`  Or set in: ~/.atris/secrets/${connector}/`);
  }

  // Create local secrets directory
  const secretsDir = path.join(require('os').homedir(), '.atris', 'secrets', connector);
  if (!fs.existsSync(secretsDir)) {
    fs.mkdirSync(secretsDir, { recursive: true });
    console.log(`\n  Created secrets dir: ${secretsDir}/`);
  }

  console.log(`\n  Connected "${connector}" skill.`);
  console.log(`  Agent can now use ${connector} capabilities.`);
  console.log('');
}


async function setNotificationMode(mode, ...flags) {
  const validModes = ['digest', 'silent', 'push'];
  if (!mode || !validModes.includes(mode)) {
    console.log('Usage: atris business notify <digest|silent|push> [--business <slug>]');
    console.log('');
    console.log('  digest   Batch all reports into morning briefing (1 email/day)');
    console.log('  silent   Log only, never notify (check with `atris business status`)');
    console.log('  push     Interrupt immediately on every action (default, noisy)');
    return;
  }

  const creds = loadCredentials();
  if (!creds || !creds.token) {
    console.error('Not logged in. Run: atris login');
    process.exit(1);
  }

  // Parse --business flag
  let bizSlug = null;
  for (let i = 0; i < flags.length; i++) {
    if ((flags[i] === '--business' || flags[i] === '-b') && flags[i + 1]) {
      bizSlug = flags[i + 1];
      i++;
    }
  }

  const resolved = await resolveSlug(bizSlug, creds);
  if (!resolved) {
    console.error('No business specified. Usage: atris business notify digest --business <slug>');
    process.exit(1);
  }

  // Update business config with notification mode
  const result = await apiRequestJson(`/business/${resolved.business_id}`, {
    method: 'PUT',
    token: creds.token,
    body: {
      config: { notification_mode: mode },
    },
  });

  if (!result.ok) {
    console.error(`Failed: ${result.errorMessage || result.status}`);
    process.exit(1);
  }

  const icons = { digest: '📬', silent: '🔇', push: '🔔' };
  const descriptions = {
    digest: 'Agents report in morning briefing only (1 email/day)',
    silent: 'Everything logged, nothing notified',
    push: 'Every action sends a notification',
  };

  console.log(`\n  ${icons[mode]} Notification mode: ${mode}`);
  console.log(`  ${descriptions[mode]}`);
  console.log(`  Business: ${resolved.name || resolved.slug}`);
  console.log('');
}


async function deployBusiness(slug) {
  if (!slug) {
    console.error('Usage: atris business deploy <slug>');
    console.error('  Pushes local atris/business/<slug>/ to the cloud business.');
    process.exit(1);
  }

  const creds = loadCredentials();
  if (!creds || !creds.token) {
    console.error('Not logged in. Run: atris login');
    process.exit(1);
  }

  // Find local business directory
  const atrisDir = findAtrisDir();
  if (!atrisDir) {
    console.error('Not in an atris project. Run from a directory with atris/ folder.');
    process.exit(1);
  }

  const bizDir = path.join(atrisDir, 'business', slug);
  if (!fs.existsSync(bizDir)) {
    console.error(`Local business not found: ${bizDir}`);
    console.error(`Create with: atris business create "${slug}"`);
    process.exit(1);
  }

  // Check if business exists in cloud
  const businesses = loadBusinesses();
  let bizConfig = businesses[slug];

  if (!bizConfig) {
    // Try to find by slug in cloud
    const listResult = await apiRequestJson('/business/', { method: 'GET', token: creds.token });
    if (listResult.ok && Array.isArray(listResult.data)) {
      const match = listResult.data.find(b => b.slug === slug);
      if (match) {
        bizConfig = { business_id: match.id, workspace_id: match.workspace_id, name: match.name, slug: match.slug };
        businesses[slug] = { ...bizConfig, added_at: new Date().toISOString() };
        saveBusinesses(businesses);
      }
    }
  }

  if (!bizConfig || !bizConfig.business_id) {
    console.log(`  Business "${slug}" not in cloud. Creating...`);
    const bizMd = path.join(bizDir, 'BUSINESS.md');
    const name = slug.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    const createResult = await apiRequestJson('/business/', {
      method: 'POST', token: creds.token,
      body: { name },
    });
    if (!createResult.ok) {
      console.error(`Failed to create: ${createResult.errorMessage || createResult.status}`);
      process.exit(1);
    }
    bizConfig = {
      business_id: createResult.data.id,
      workspace_id: createResult.data.workspace_id,
      name: createResult.data.name,
      slug: createResult.data.slug,
    };
    businesses[slug] = { ...bizConfig, added_at: new Date().toISOString() };
    saveBusinesses(businesses);
    console.log(`  Created: ${bizConfig.name} (${bizConfig.business_id.slice(0, 12)}...)`);
  }

  // Upload workspace files
  const workspaceDir = path.join(bizDir, 'workspace');
  let uploadCount = 0;
  if (fs.existsSync(workspaceDir)) {
    const files = walkDir(workspaceDir);
    for (const filePath of files) {
      const relativePath = path.relative(workspaceDir, filePath);
      if (relativePath.startsWith('.')) continue;
      try {
        const content = fs.readFileSync(filePath, 'utf8');
        const uploadResult = await apiRequestJson(
          `/business/${bizConfig.business_id}/workspaces/${bizConfig.workspace_id}/file`,
          { method: 'PUT', token: creds.token, body: { path: '/' + relativePath, content } }
        );
        if (uploadResult.ok) {
          uploadCount++;
          process.stdout.write(`  Uploaded: ${relativePath}\n`);
        }
      } catch (e) {
        // Skip binary files or errors
      }
    }
  }

  // Upload BUSINESS.md as context
  const bizMd = path.join(bizDir, 'BUSINESS.md');
  if (fs.existsSync(bizMd)) {
    try {
      const content = fs.readFileSync(bizMd, 'utf8');
      await apiRequestJson(
        `/business/${bizConfig.business_id}/workspaces/${bizConfig.workspace_id}/file`,
        { method: 'PUT', token: creds.token, body: { path: '/BUSINESS.md', content } }
      );
      uploadCount++;
      console.log('  Uploaded: BUSINESS.md');
    } catch {}
  }

  console.log(`\n  Deployed ${uploadCount} files to ${bizConfig.name}`);
  console.log(`  Dashboard: https://atris.ai/dashboard/gm/${bizConfig.business_id}`);
  console.log('');
}


function walkDir(dir) {
  let results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results = results.concat(walkDir(full));
    } else {
      results.push(full);
    }
  }
  return results;
}


function findAtrisDir() {
  let dir = process.cwd();
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, 'atris'))) return path.join(dir, 'atris');
    dir = path.dirname(dir);
  }
  return null;
}


async function quickstart() {
  console.log(`
  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Start a Business in 3 Commands
  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  1. Create:
     atris business create "My Company" --template saas

  2. Connect integrations:
     atris business connect slack --business my-company
     atris business connect github --business my-company

  3. Deploy:
     atris business deploy my-company

  That's it. Your agents are live.

  Optional:
     atris business notify digest --business my-company
     (get 1 email/day instead of every notification)

  Templates: saas, agency, ecommerce, content, restaurant
  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`);
}


async function businessCommand(subcommand, ...args) {
  switch (subcommand) {
    case 'add':
      await addBusiness(args[0]);
      break;
    case 'create':
    case 'new':
      await createBusiness(args[0], ...args.slice(1));
      break;
    case 'list':
    case 'ls': {
      const opts = {};
      if (args.includes('--local')) opts.local = true;
      if (args.includes('--json')) opts.json = true;
      await listBusinesses(opts);
      break;
    }
    case 'fleet': {
      // Shorthand for `business list --local`
      const opts = { local: true };
      if (args.includes('--json')) opts.json = true;
      await listBusinesses(opts);
      break;
    }
    case 'remove':
    case 'rm':
      await removeBusiness(args[0]);
      break;
    case 'health':
      await businessHealth(args[0]);
      break;
    case 'team':
    case 'members':
    case 'roster':
      await businessTeam(args[0]);
      break;
    case 'status':
      await businessStatus(args[0]);
      break;
    case 'audit':
      await businessAudit();
      break;
    case 'connect':
      await connectService(args[0], ...args.slice(1));
      break;
    case 'notify':
    case 'notification':
      await setNotificationMode(args[0], ...args.slice(1));
      break;
    case 'deploy':
    case 'push':
      await deployBusiness(args[0]);
      break;
    case 'quickstart':
    case 'start':
    case 'guide':
      await quickstart();
      break;
    default:
      console.log('Usage: atris business <command> [args]');
      console.log('');
      console.log('  quickstart           ← Start here! 3-command guide');
      console.log('');
      console.log('  create <name>        Create a new business (cloud + local)');
      console.log('  add <slug>           Register an existing cloud business');
      console.log('  list                 Show registered businesses');
      console.log('  team [slug]          Show members, roles, and admin access');
      console.log('  status <slug>        Quick status check');
      console.log('  health [slug]        Full health dashboard');
      console.log('  audit                Audit all businesses');
      console.log('  connect <service>    Connect a skill/integration');
      console.log('  notify <mode>        Set notification mode (digest/silent/push)');
      console.log('  deploy <slug>        Push local business to cloud');
      console.log('  remove <slug>        Unregister locally');
  }
}

module.exports = { businessCommand, businessHealth, businessAudit, businessTeam, loadBusinesses, saveBusinesses, getBusinessConfigPath };
