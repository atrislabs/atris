const fs = require('fs');
const path = require('path');
const { stateHome } = require('../lib/state-home');
const { loadCredentials } = require('../utils/auth');
const { apiRequestJson } = require('../utils/api');
const {
  SIMULATE_USAGE,
  buildSimulationPlan,
  parseSimulationArgs,
  renderDryRun,
} = require('../lib/business-simulate');
const {
  BUSINESS_SHIP_USAGE,
  businessWorkspaceBase,
  slugify,
  isHelpToken,
  isAccidentalHelpBusiness,
  validateBusinessCreateName,
  parseBusinessShipArgs,
  shipTeamNames,
  shipTaskTitle,
  loadBusinesses,
  businessMatchesSlug,
  saveBusinesses,
  readBusinessFolderBindings,
  analyzeBusinessDoctor,
  parseCreateBusinessFlags,
  resolveWorkspaceRoot,
  createCanonicalBusinessWorkspace,
  collectBusinessShareState,
  renderBusinessCreatedNextSteps,
  startBusinessWorkspace,
  localDay,
  shareBusinessWorkspace,
  onboardBusiness,
  recordBusinessRun,
  detectBusinessSlug,
  relativeTime,
  activityBar,
  asRecord,
  firstString,
  normalizeOrdersPayload,
  readStorefront,
  readWalletNet,
  formatWalletNet,
  formatCents,
  renderOrderLine,
  parseBusinessStoreArgs,
  parseBusinessDoctorOptions,
  describeAccess,
  walkDir,
  findAtrisDir,
} = require('../lib/business-core');

async function findExistingBusinessBySlug(slug, token, { api = apiRequestJson, loadLocal = loadBusinesses } = {}) {
  if (!slug) return null;

  const local = loadLocal();
  const localMatch = local[slug]
    ? { id: local[slug].business_id, name: local[slug].name, slug, source: 'local' }
    : (() => {
      const v = Object.values(local).find((b) => businessMatchesSlug(b, slug));
      return v ? { id: v.business_id, name: v.name, slug, source: 'local' } : null;
    })();

  if (!token) return localMatch;

  // The cloud is the truth. The Mac's list can hold a business that was
  // deleted, and trusting it refused to recreate one that no longer existed.
  const direct = await api(`/business/by-slug/${encodeURIComponent(slug)}`, { method: 'GET', token });
  if (direct.ok && direct.data && direct.data.id) {
    return { id: direct.data.id, name: direct.data.name, slug: direct.data.slug || slug, source: 'cloud' };
  }

  const list = await api('/business/', { method: 'GET', token });
  if (list.ok && Array.isArray(list.data)) {
    const match = list.data.find(b => businessMatchesSlug(b, slug));
    if (match) return { id: match.id, name: match.name, slug: match.slug, source: 'cloud' };
    if (localMatch) {
      console.warn(`  Note: this Mac still lists "${slug}", but the cloud has no such business. Run: atris business doctor --fix`);
    }
    return null;
  }

  // Cloud unreachable: fall back to the Mac's list rather than risk a duplicate.
  return localMatch;
}

async function addBusiness(slug) {
  if (!slug || isHelpToken(slug)) {
    console.error('Usage: atris business add <slug>');
    process.exit(1);
  }
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
      const match = listResult.data.find(b => businessMatchesSlug(b, slug, { includeName: true }));
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
  // --local mode: walk the configured business workspace folder
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
 * Walk the configured business folder and print a fleet status table for every
 * customer workspace. Pure local, no API calls, no rate-limit risk.
 *
 * Classifies each dir as: ready, flat, unbound, nested, bare, or superseded.
 *
 * Discovered the need for this during overnight loop tick #3 when we hand-wrote
 * /tmp/customer_fleet.md. Now any team member can run `atris business list --local`
 * (or `atris business fleet`) to see fleet state in one shot.
 */
function listBusinessesLocal(opts = {}) {
  const SKIP_DIRS = new Set(['deals', 'archive', 'archives', '_archive', 'templates', 'node_modules', '.git']);
  const SKIP_FILES = new Set(['.DS_Store', 'Thumbs.db']);

  const rootDir = opts.root || businessWorkspaceBase();
  const jsonMode = opts.json === true;

  if (!fs.existsSync(rootDir)) {
    console.error(`Fleet root not found: ${rootDir}`);
    process.exit(1);
  }

  function countCustomerFiles(dir) {
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
    const { total, md } = countCustomerFiles(customerDir);

    let state, action, icon;
    if (hasBizJson && hasAtris) {
      state = 'ready'; action = 'none'; icon = '🟢';
    } else if (hasBizJson && !hasAtris) {
      state = 'flat'; action = 'migrate to atris/ wrapper'; icon = '🟡';
    } else if (!hasBizJson && hasAtris) {
      state = 'unbound'; action = 'create .atris/business.json'; icon = '🟡';
    } else if (hasNested) {
      state = 'nested'; action = 'legacy nesting bug'; icon = '🔴';
    } else if (total < 5) {
      state = 'bare'; action = 'not yet onboarded'; icon = '⚪';
    } else {
      state = 'flat-unbound'; action = 'needs business init'; icon = '🟡';
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
  console.log(`Atris Fleet: ${rootDir}`);
  console.log('═'.repeat(86));
  console.log('  CUSTOMER              STATE         FILES   BIZ.JSON  ATRIS/  ACTION');
  console.log('  ' + '─'.repeat(83));

  const order = ['ready', 'flat', 'unbound', 'flat-unbound', 'bare', 'nested', 'superseded'];
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
  console.log(`  ${customers.length} customers: ${summary}`);
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
  if (!slug || isHelpToken(slug)) {
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
    const match = listResult.data.find(b => businessMatchesSlug(b, slug, { includeName: true }));
    if (match) {
      return { business_id: match.id, workspace_id: match.workspace_id, name: match.name, slug: match.slug };
    }
  }

  return null;
}

function businessOperationError(message) {
  console.error(message);
  process.exitCode = 1;
  return null;
}

async function resolveBusinessOperation(slug, usage) {
  const requestedSlug = detectBusinessSlug(slug);
  if (!requestedSlug) return businessOperationError(`No business specified. Usage: ${usage}`);

  const creds = loadCredentials();
  if (!creds || !creds.token) return businessOperationError('Not logged in. Run: atris login');

  const resolved = await resolveSlug(requestedSlug, creds);
  if (!resolved) return businessOperationError(`Business "${requestedSlug}" not found.`);
  return { requestedSlug, resolved, token: creds.token };
}

async function fetchBusinessDashboard(context) {
  const result = await apiRequestJson(`/business/${context.resolved.business_id}/dashboard`, {
    method: 'GET',
    token: context.token,
    timeoutMs: 120000,
  });
  if (!result.ok) {
    const detail = result.errorMessage || result.error || `HTTP ${result.status}`;
    return businessOperationError(`Could not load business room: ${detail}`);
  }
  return result.data || {};
}

async function fetchBusinessOrders(context, limit = 50) {
  return apiRequestJson(`/storefront/${context.resolved.business_id}/orders?limit=${limit}`, {
    method: 'GET',
    token: context.token,
    timeoutMs: 120000,
  });
}

async function businessRoom(slug) {
  const context = await resolveBusinessOperation(slug, 'atris business room <slug>');
  if (!context) return;

  const [dashboard, ordersResult] = await Promise.all([
    fetchBusinessDashboard(context),
    fetchBusinessOrders(context, 5),
  ]);
  if (!dashboard) return;

  const business = asRecord(dashboard.business);
  const roster = asRecord(dashboard.roster);
  const members = Array.isArray(roster.members)
    ? roster.members
    : (Array.isArray(business.members) ? business.members : []);
  const storefront = readStorefront(business);
  const orders = ordersResult.ok ? normalizeOrdersPayload(ordersResult.data).orders.slice(0, 5) : [];
  const name = business.name || context.resolved.name || context.requestedSlug;
  const appCount = Number.isFinite(business.app_count)
    ? business.app_count
    : (Array.isArray(business.apps) ? business.apps.length : 0);

  console.log('');
  console.log(`business room: ${name}`);
  console.log(`wallet/net: ${formatWalletNet(readWalletNet(business))}`);
  console.log(`members: ${members.length}`);
  for (const member of members) {
    const agent = asRecord(member.atris);
    const memberName = firstString(member.display_name, agent.agent_name, member.name, member.email) || 'unknown';
    console.log(`  ${memberName} (${member.role || 'member'})`);
  }
  console.log(`apps: ${appCount}`);
  console.log(`store: ${storefront.enabled ? 'enabled' : 'disabled'}, ${storefront.products.length} products`);
  console.log('recent orders:');
  if (!ordersResult.ok) {
    const detail = ordersResult.errorMessage || ordersResult.error || `HTTP ${ordersResult.status}`;
    console.log(`  unavailable: ${detail}`);
    process.exitCode = 1;
  } else if (orders.length === 0) {
    console.log('  none');
  } else {
    orders.forEach(order => console.log(renderOrderLine(order)));
  }
  console.log('');
}

async function businessProducts(slug) {
  const context = await resolveBusinessOperation(slug, 'atris business products <slug>');
  if (!context) return;
  const dashboard = await fetchBusinessDashboard(context);
  if (!dashboard) return;

  const business = asRecord(dashboard.business);
  const storefront = readStorefront(business);
  const name = business.name || context.resolved.name || context.requestedSlug;
  console.log('');
  console.log(`products: ${name} (${storefront.products.length})`);
  if (storefront.products.length === 0) {
    console.log('  none');
  } else {
    for (const product of storefront.products) {
      const productName = firstString(product.name) || 'unnamed product';
      const productId = firstString(product.id) || 'no id';
      console.log(`  ${productName} (${productId}): ${formatCents(product.price_cents, product.currency)}`);
    }
  }
  console.log('');
}

async function businessOrders(slug) {
  const context = await resolveBusinessOperation(slug, 'atris business orders <slug>');
  if (!context) return;
  const result = await fetchBusinessOrders(context, 50);
  if (!result.ok) {
    const detail = result.errorMessage || result.error || `HTTP ${result.status}`;
    businessOperationError(`Could not load orders: ${detail}`);
    return;
  }

  const data = normalizeOrdersPayload(result.data);
  const name = context.resolved.name || context.requestedSlug;
  console.log('');
  console.log(`orders: ${name} (${data.orders.length})`);
  console.log(`revenue: ${formatCents(data.revenueCents)}`);
  console.log(`paid orders: ${data.paidOrders}`);
  console.log(`pending revenue: ${formatCents(data.pendingRevenueCents)}`);
  if (data.orders.length === 0) {
    console.log('  none');
  } else {
    data.orders.forEach(order => console.log(renderOrderLine(order)));
  }
  console.log('');
}

async function businessStore(args = []) {
  const { action, slug } = parseBusinessStoreArgs(args);
  if (action === 'off' || action === 'disable') {
    businessOperationError('The production store API does not support disabling stores yet.');
    return;
  }

  const context = await resolveBusinessOperation(slug, 'atris business store <on|status> [slug]');
  if (!context) return;
  const dashboard = await fetchBusinessDashboard(context);
  if (!dashboard) return;

  const business = asRecord(dashboard.business);
  const storefront = readStorefront(business);
  const name = business.name || context.resolved.name || context.requestedSlug;
  if (action === 'status') {
    console.log(`store: ${storefront.enabled ? 'enabled' : 'disabled'} for ${name}, ${storefront.products.length} products`);
    return;
  }
  if (storefront.enabled) {
    console.log(`store: already enabled for ${name}, ${storefront.products.length} products`);
    return;
  }

  const result = await apiRequestJson(`/storefront/${context.resolved.business_id}/products`, {
    method: 'PUT',
    token: context.token,
    body: { products: storefront.products },
    timeoutMs: 120000,
  });
  if (!result.ok) {
    const detail = result.errorMessage || result.error || `HTTP ${result.status}`;
    businessOperationError(`Could not enable store: ${detail}`);
    return;
  }
  const enabledProducts = Array.isArray(result.data?.products) ? result.data.products.length : storefront.products.length;
  console.log(`store: enabled for ${name}, ${enabledProducts} products`);
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

function printBusinessDoctorHelp() {
  console.log('Usage: atris business doctor [--fix] [--root <dir>] [--json]');
  console.log('');
  console.log('Checks cloud-active businesses against:');
  console.log('  - ~/.atris/businesses.json');
  console.log(`  - ${businessWorkspaceBase()}/*/.atris/business.json`);
  console.log('  - canonical slug + alias bindings');
  console.log('');
  console.log('--fix rewrites only safe local cache entries. It does not rename folders or touch cloud data.');
}

async function businessDoctor(...args) {
  if (args.some(isHelpToken)) {
    printBusinessDoctorHelp();
    return;
  }

  const options = parseBusinessDoctorOptions(args);
  const creds = loadCredentials();
  if (!creds || !creds.token) {
    console.error('Not logged in. Run: atris login');
    process.exit(1);
  }

  const listResult = await apiRequestJson('/business/', { method: 'GET', token: creds.token });
  if (!listResult.ok || !Array.isArray(listResult.data)) {
    console.error(`Failed to fetch businesses: ${listResult.errorMessage || listResult.error || listResult.status || 'unknown error'}`);
    process.exit(1);
  }

  let cache = loadBusinesses();
  const folderBindings = readBusinessFolderBindings(options.root);
  let analysis = analyzeBusinessDoctor({
    cache,
    cloudBusinesses: listResult.data,
    folderBindings,
  });

  const cacheUpdateKeys = Object.keys(analysis.cacheUpdates);
  const cacheRemovalKeys = analysis.cacheRemovals || [];
  let fixed = [];
  if (options.fix && (cacheUpdateKeys.length > 0 || cacheRemovalKeys.length > 0)) {
    if (cacheUpdateKeys.length > 0) {
      cache = { ...cache, ...analysis.cacheUpdates };
    }
    for (const key of cacheRemovalKeys) {
      delete cache[key];
      fixed.push(`removed:${key}`);
    }
    if (cacheUpdateKeys.length > 0) {
      fixed.push(...cacheUpdateKeys);
    }
    saveBusinesses(cache);
    analysis = analyzeBusinessDoctor({
      cache,
      cloudBusinesses: listResult.data,
      folderBindings,
    });
  }

  if (options.json) {
    console.log(JSON.stringify({
      root: options.root,
      stats: analysis.stats,
      fixed,
      issues: analysis.issues,
    }, null, 2));
  } else {
    console.log('');
    console.log('Business Doctor');
    console.log('---------------');
    console.log(`cloud active: ${analysis.stats.cloud_active}`);
    console.log(`cache entries: ${analysis.stats.cache_entries}`);
    console.log(`folders scanned: ${analysis.stats.folders}`);
    if (fixed.length > 0) console.log(`fixed cache entries: ${fixed.join(', ')}`);
    console.log('');

    if (analysis.issues.length === 0) {
      console.log('OK no business binding drift found.');
    } else {
      for (const issue of analysis.issues) {
        const label = issue.level === 'fail' ? 'FAIL' : 'WARN';
        const fixHint = issue.fixable ? ' (run with --fix)' : '';
        console.log(`${label} ${issue.code}: ${issue.message}${fixHint}`);
      }
    }
    console.log('');
  }

  const failures = analysis.issues.filter((issue) => issue.level === 'fail');
  if (failures.length > 0) process.exitCode = 1;
}

async function createBusinessInternal(name, flags = [], mode = 'auto') {
  const validation = validateBusinessCreateName(name);
  if (!validation.ok) {
    console.error(validation.usage);
    if (validation.detail) console.error(`\n  ${validation.detail}`);
    process.exit(1);
  }

  const creds = loadCredentials();
  if (!creds || !creds.token) {
    console.error('Not logged in. Run: atris login');
    process.exit(1);
  }

  const options = parseCreateBusinessFlags(flags);
  const description = options.description;
  const force = flags.includes('--force') || flags.includes('--allow-duplicate');

  // Pre-flight: refuse to create a duplicate by slug. The backend will silently
  // suffix `-1`, `-2`, etc., which produces ghost businesses when users actually
  // wanted to attach to an existing one. Guide them to `atris pull` instead.
  if (!force) {
    const desiredSlug = slugify(name);
    if (desiredSlug) {
      const existing = await findExistingBusinessBySlug(desiredSlug, creds.token);
      if (existing) {
        console.error(`\nA business with slug "${desiredSlug}" already exists.`);
        console.error(`  Name: ${existing.name || desiredSlug}`);
        if (existing.id) console.error(`  ID:   ${existing.id}`);
        console.error('');
        console.error('To set up a local workspace for it, run:');
        console.error(`  atris pull ${desiredSlug}                       # into ./${desiredSlug}`);
        console.error(`  atris pull ${desiredSlug} --into <path>         # into a custom path`);
        console.error('');
        console.error(`To create a NEW business anyway (will be slugged "${desiredSlug}-1"), pass --force.`);
        process.exit(1);
      }
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

  const shouldCreateCanonicalWorkspace = !options.noLocal && (
    mode === 'canonical' ||
    options.workspace ||
    options.here ||
    Boolean(options.root)
  );
  let workspaceRoot = null;

  // Scaffold legacy local directory if in an atris project
  const atrisDir = !shouldCreateCanonicalWorkspace ? findAtrisDir() : null;
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
        `---\n*Created: ${localDay()}*\n`,
      ].join(''));
      console.log(`  Local scaffold: ${bizDir}/`);
    }
  } else if (shouldCreateCanonicalWorkspace) {
    workspaceRoot = resolveWorkspaceRoot(biz.slug, options);
    const scaffold = createCanonicalBusinessWorkspace(workspaceRoot, {
      business_id: biz.id,
      workspace_id: biz.workspace_id,
      name: biz.name,
      slug: biz.slug,
      owner_email: options.ownerEmail,
    }, { here: options.here });
    console.log(`  Local workspace: ${scaffold.targetRoot}/`);
  } else if (!options.noLocal) {
    console.log('  Tip: run `atris business init "<name>"` or add `--workspace` for a local business environment.');
  }

  const template = options.template;

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
  if (shouldCreateCanonicalWorkspace) {
    console.log(renderBusinessCreatedNextSteps(biz, workspaceRoot));
  }
  console.log('');
  return { business: biz, workspaceRoot };
}

async function createBusiness(name, ...flags) {
  return createBusinessInternal(name, flags, 'auto');
}

async function initBusinessWorkspace(name, ...flags) {
  return createBusinessInternal(name, flags, 'canonical');
}

function printBusinessShipHelp() {
  console.log(BUSINESS_SHIP_USAGE);
  console.log('');
  console.log('Create a live business from one paragraph.');
  console.log('  --name <name>     Optional business name');
  console.log('  --email <email>   Optional customer email');
  console.log('  --yes             Required to POST /business/ship');
}

async function shipBusiness(...args) {
  if (args.some(isHelpToken)) {
    printBusinessShipHelp();
    return;
  }

  if (!args.includes('--yes') && !args.includes('-y')) {
    console.error(BUSINESS_SHIP_USAGE);
    console.error('Pass --yes to create a live business.');
    process.exit(2);
  }

  const parsed = parseBusinessShipArgs(args);
  if (!parsed.ok) {
    console.error(parsed.usage);
    if (parsed.detail) console.error(`\n  ${parsed.detail}`);
    process.exit(1);
  }

  const creds = loadCredentials();
  if (!creds || !creds.token) {
    console.error('Not logged in. Run: atris login');
    process.exit(1);
  }

  const body = { description: parsed.description };
  if (parsed.name) body.name = parsed.name;
  if (parsed.email) body.customer_email = parsed.email;

  console.log(`Shipping business: ${parsed.name || parsed.description}...`);

  const result = await apiRequestJson('/business/ship', {
    method: 'POST',
    token: creds.token,
    body,
  });

  if (!result.ok) {
    console.error(`Failed: ${result.errorMessage || result.error || result.status}`);
    process.exit(1);
  }

  const payload = result.data || {};
  const slug = payload.slug || '';
  const label = payload.name || parsed.name || slug || 'business';
  const pageUrl = payload.public_page_url || '';
  const names = shipTeamNames(payload.team);
  const firstTask = shipTaskTitle(payload.seeded_task);

  console.log('');
  console.log(`  ${label}${slug ? ` (${slug})` : ''}`);
  if (pageUrl) console.log(`  Public page: ${pageUrl}`);
  if (names.length > 0) console.log(`  Team: ${names.join(', ')}`);
  if (firstTask) console.log(`  First task: ${firstTask}`);
  console.log('');
  return payload;
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
      const match = listResult.data.find(b => businessMatchesSlug(b, slug));
      if (match) {
        bizConfig = { business_id: match.id, workspace_id: match.workspace_id, name: match.name, slug: match.slug };
        businesses[slug] = { ...bizConfig, added_at: new Date().toISOString() };
        saveBusinesses(businesses);
      }
    }
  }

  if (!bizConfig || !bizConfig.business_id) {
    console.log(`  Business "${slug}" not in cloud. Creating...`);
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
  let uploadFailureCount = 0;
  let uploadTotal = 0;
  if (fs.existsSync(workspaceDir)) {
    const files = walkDir(workspaceDir);
    for (const filePath of files) {
      const relativePath = path.relative(workspaceDir, filePath);
      if (relativePath.startsWith('.')) continue;
      uploadTotal++;
      try {
        const content = fs.readFileSync(filePath, 'utf8');
        const uploadResult = await apiRequestJson(
          `/business/${bizConfig.business_id}/workspaces/${bizConfig.workspace_id}/file`,
          { method: 'PUT', token: creds.token, body: { path: '/' + relativePath, content } }
        );
        if (uploadResult.ok) {
          uploadCount++;
          process.stdout.write(`  Uploaded: ${relativePath}\n`);
        } else {
          uploadFailureCount++;
          const detail = uploadResult.errorMessage || uploadResult.error || uploadResult.status || 'unknown error';
          console.log(`  Failed: ${relativePath} (${detail})`);
        }
      } catch (e) {
        uploadFailureCount++;
        console.log(`  Failed: ${relativePath} (${e.message || String(e)})`);
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
  if (uploadFailureCount > 0) {
    console.log(`  ${uploadFailureCount} of ${uploadTotal} files failed to upload`);
    process.exitCode = 1;
  }
  console.log('');
}

function printBusinessSimulateHelp() {
  console.log(SIMULATE_USAGE);
  console.log('');
  console.log('Creates a business workspace, four simulation members, their missions, and atris/ENDGAME.md.');
  console.log('Use --dry-run to preview every simulation file without cloud calls or writes.');
}

async function simulateBusiness(args = [], dependencies = {}) {
  const options = parseSimulationArgs(args);
  const createdAt = new Date().toISOString();
  const preview = buildSimulationPlan({
    idea: options.idea,
    businessName: options.businessName,
    roleNames: options.roleNames,
    createdAt,
  });

  if (options.dryRun) {
    console.log(renderDryRun(preview));
    return preview;
  }

  const init = dependencies.initBusinessWorkspace || initBusinessWorkspace;
  const runMemberCommand = dependencies.memberCommand || require('./member').memberCommand;
  const initialized = await init(options.businessName);
  const business = initialized?.business || {};
  const workspaceRoot = initialized?.workspaceRoot
    || resolveWorkspaceRoot(business.slug || options.businessSlug, {});
  const plan = buildSimulationPlan({
    idea: options.idea,
    businessName: business.name || options.businessName,
    businessSlug: business.slug || options.businessSlug,
    roleNames: options.roleNames,
    createdAt,
    workspacePath: workspaceRoot,
  });

  const businessJson = path.join(workspaceRoot, '.atris', 'business.json');
  if (!fs.existsSync(businessJson)) {
    throw new Error(`Business init did not create the expected workspace: ${workspaceRoot}`);
  }

  const originalCwd = process.cwd();
  try {
    process.chdir(workspaceRoot);

    const endgame = plan.files.find((file) => file.kind === 'endgame');
    fs.writeFileSync(path.join(workspaceRoot, endgame.path), endgame.content, 'utf8');

    for (const role of plan.roles) {
      const memberDir = path.join(workspaceRoot, 'atris', 'team', role.name);
      const memberFile = path.join(memberDir, 'MEMBER.md');
      if (!fs.existsSync(memberFile)) {
        await runMemberCommand(
          'create',
          role.name,
          `--role=${role.title}`,
          `--description=${role.description}`,
        );
      } else {
        console.log(`Using existing team/${role.name}/ scaffold from business init.`);
      }

      for (const directory of ['skills', 'tools', 'context', 'logs']) {
        fs.mkdirSync(path.join(memberDir, directory), { recursive: true });
      }

      const roleFiles = plan.files.filter((file) => file.role?.name === role.name);
      for (const file of roleFiles) {
        fs.writeFileSync(path.join(workspaceRoot, file.path), file.content, 'utf8');
      }

      await runMemberCommand('push', role.name);
    }
  } finally {
    process.chdir(originalCwd);
  }

  console.log('');
  console.log('business simulation ready');
  console.log(`workspace: ${workspaceRoot}`);
  console.log('roster:');
  for (const role of plan.roles) {
    console.log(`  - ${role.name}: ${role.role}`);
  }
  console.log('next: open an agent session in the workspace and run the loop against atris/ENDGAME.md');
  console.log('');
  return plan;
}

async function quickstart() {
  console.log(`
  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Start a Business With An Operating Loop
  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  1. Create:
     atris business init "My Company" --template saas

  2. Open the local workspace:
     cd ${businessWorkspaceBase()}/my-company

  3. See what Atris knows:
     atris
     atris business start
     atris radar

  4. Claim the first real action:
     atris task next
     atris member activate operator
     atris mission status --status active --json

  5. If no active mission exists:
     atris mission start "Run the first useful loop for My Company" --owner operator --runner codex_goal --lane business --verify "atris business check" --stop "first proof recap recorded"
     atris member goal-from-mission operator

  6. Seed onboarding context:
     atris business onboard --website https://example.com --contact "Founder Name" --note "what they do"

  7. Do one useful loop:
     atris do
     atris business record atris/reports/YYYY-MM-DD-your-recap.md --outcome mixed --metric "operator speed"

  8. Write the handoff before sharing:
     atris business share --write

  9. Push local state to cloud:
     atris sync --dry-run
     atris sync

  Repeat:
     atris radar -> atris task next -> atris do -> record -> share

  Optional:
     atris sync --watch
     atris business connect slack --business my-company
     atris business connect github --business my-company

     atris business notify digest --business my-company
     (get 1 email/day instead of every notification)

  Templates: saas, agency, ecommerce, content, restaurant

  Rule of thumb:
     atris business init "<name>"    = cloud + local business computer workspace
     atris business create "<name>"  = cloud-only unless you pass --workspace
  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`);
}

function printBusinessHelp() {
  console.log('Usage: atris business <command> [args]');
  console.log('');
  console.log('  quickstart           ← Start here! 3-command guide');
  console.log('');
  console.log('  init <name>          RECOMMENDED: create a business environment (cloud + local)');
  console.log('  workspace <name>     Alias for init');
  console.log('  create <name>        Cloud-only business record; add --workspace to also scaffold local');
  console.log('  ship "<paragraph>"   One paragraph, live business (optional --name, --email; --yes required)');
  console.log('  simulate <idea>      Create a business, four-role team, missions, and endgame loop');
  console.log('  add <slug>           Register an existing cloud business');
  console.log('  list                 Show registered businesses');
  console.log('  room [slug]          Show wallet, members, apps, store, and recent orders');
  console.log('  scoreboard [slug]    Revenue, orders, visitors, credits and your own numbers as one board (--doc, --json, add, set, layout)');
  console.log('  products [slug]      List store products');
  console.log('  orders [slug]        List store orders');
  console.log('  store on [slug]      Enable the store with its current catalog');
  console.log('  team [slug]          Show members, roles, and admin access');
  console.log('  status <slug>        Quick status check');
  console.log('  health [slug]        Full health dashboard');
  console.log('  audit                Audit all businesses');
  console.log('  doctor [--fix]       Find stale business cache, alias, and folder bindings');
  console.log('  connect [service]    See or make a business connection (slack, telegram, discord, whatsapp, google-drive, hubspot)');
  console.log('  notify <mode>        Set notification mode (digest/silent/push)');
  console.log('  deploy <slug>        Push local business to cloud');
  console.log('  onboard              Seed brief, person, first loop, safe next action, and one-pager from sparse input');
  console.log('  start                Check a received business workspace and show the first loop');
  console.log('  check                Alias for start');
  console.log('  share                Print/write a collaborator handoff for this business workspace');
  console.log('  record <report>      Append recap state into events, episodes, and scorecards');
  console.log('  remove <slug>        Unregister locally');
  console.log('');
  console.log('  Already-attached business? Run `atris pull <slug>` to scaffold a local workspace.');
}

async function businessCommand(subcommand, ...args) {
  // Help intercept, without this, `atris business init --help` would treat
  // `--help` as a business name and create one. Same for any subcommand that
  // takes a positional name/slug.
  if (!subcommand || isHelpToken(subcommand)) {
    printBusinessHelp();
    return;
  }
  if (subcommand === 'simulate' && args.some(isHelpToken)) {
    printBusinessSimulateHelp();
    return;
  }
  if (subcommand === 'ship' && args.some(isHelpToken)) {
    printBusinessShipHelp();
    return;
  }
  const nameTakingSubcommands = new Set(['create', 'new', 'init', 'workspace', 'ship']);
  if (nameTakingSubcommands.has(subcommand) && args.some(isHelpToken)) {
    printBusinessHelp();
    return;
  }
  if (args.length > 0 && isHelpToken(args[0]) && subcommand !== 'doctor') {
    printBusinessHelp();
    return;
  }

  switch (subcommand) {
    case 'add':
      await addBusiness(args[0]);
      break;
    case 'create':
    case 'new':
      await createBusiness(args[0], ...args.slice(1));
      break;
    case 'ship':
      await shipBusiness(...args);
      break;
    case 'init':
    case 'workspace':
      await initBusinessWorkspace(args[0], ...args.slice(1));
      break;
    case 'simulate':
      await simulateBusiness(args);
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
    case 'room':
      await businessRoom(args[0]);
      break;
    case 'scoreboard':
    case 'board':
    case 'numbers': {
      const code = await require('./business-scoreboard').scoreboardCommand(args);
      if (code) process.exitCode = code;
      break;
    }
    case 'products':
    case 'product':
      await businessProducts(args[0]);
      break;
    case 'orders':
    case 'order':
      await businessOrders(args[0]);
      break;
    case 'store':
    case 'storefront':
      await businessStore(args);
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
    case 'doctor':
      await businessDoctor(...args);
      break;
    case 'connect':
      process.exitCode = await require('./business-connect').connectCommand(args);
      break;
    case 'notify':
    case 'notification':
      await setNotificationMode(args[0], ...args.slice(1));
      break;
    case 'deploy':
    case 'push':
      await deployBusiness(args[0]);
      break;
    case 'record':
    case 'record-recap':
      await recordBusinessRun(args[0], ...args.slice(1));
      break;
    case 'onboard':
      await onboardBusiness(...args);
      break;
    case 'start':
    case 'check':
    case 'ready':
      await startBusinessWorkspace(...args);
      break;
    case 'share':
    case 'handoff':
      await shareBusinessWorkspace(...args);
      break;
    case 'quickstart':
    case 'guide':
      await quickstart();
      break;
    default:
      console.error(`Unknown subcommand: ${subcommand}`);
      console.error('');
      printBusinessHelp();
      process.exitCode = 1;
  }
}

module.exports = {
  findExistingBusinessBySlug,
  businessCommand,
  businessWorkspaceBase,
  loadBusinesses,
  saveBusinesses,
  businessMatchesSlug,
  isAccidentalHelpBusiness,
  validateBusinessCreateName,
  parseBusinessShipArgs,
  shipTeamNames,
  shipTaskTitle,
  analyzeBusinessDoctor,
  createCanonicalBusinessWorkspace,
  onboardBusiness,
  shareBusinessWorkspace,
  collectBusinessShareState,
  renderBusinessCreatedNextSteps,
  recordBusinessRun,
  normalizeOrdersPayload,
  parseBusinessStoreArgs,
  readStorefront,
  readWalletNet,
};
