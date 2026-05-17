const fs = require('fs');
const path = require('path');
const { loadCredentials } = require('../utils/auth');
const { apiRequestJson } = require('../utils/api');
const { loadBusinesses, saveBusinesses, businessMatchesSlug } = require('./business');

/**
 * Resolve business slug from CLI arg or local .atris/business.json.
 * @returns {string|null} The resolved slug, or null if not found.
 */
function resolveSlug() {
  let slug = process.argv[3];
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
  return slug;
}

async function resolveBusiness(token, slug) {
  const businesses = loadBusinesses();

  const listResult = await apiRequestJson('/business/', { method: 'GET', token });
  if (listResult.ok && Array.isArray(listResult.data)) {
    const match = listResult.data.find((business) =>
      businessMatchesSlug(business, slug, { includeName: true })
    );
    if (match && match.id) {
      businesses[slug] = {
        business_id: match.id,
        workspace_id: match.workspace_id,
        name: match.name || slug,
        slug: match.slug || slug,
        canonical_slug: match.slug || slug,
        added_at: businesses[slug]?.added_at || new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      saveBusinesses(businesses);
      return businesses[slug];
    }
  }

  const wanted = String(slug || '').toLowerCase();
  return businesses[slug] || Object.values(businesses).find((entry) =>
    entry
      && (
        String(entry.slug || '').toLowerCase() === wanted
        || String(entry.canonical_slug || '').toLowerCase() === wanted
        || String(entry.name || '').toLowerCase() === wanted
      )
  ) || null;
}

async function activateBusinessWorkspace(token, business) {
  if (!business?.business_id || !business?.workspace_id) return;
  const result = await apiRequestJson(`/business/${business.business_id}/workspaces/${business.workspace_id}/activate`, {
    method: 'POST',
    token,
    body: {},
  });
  if (!result.ok && result.status !== 409) {
    throw new Error(`Failed to activate business workspace: ${result.errorMessage || result.error || result.status}`);
  }
}

async function waitForBusinessComputer(token, business, maxWait = 90000) {
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    await new Promise((r) => setTimeout(r, 3000));

    const status = await apiRequestJson(`/business/${business.business_id}/ai-computer/status`, {
      method: 'GET',
      token,
    });

    if (status.ok && status.data && status.data.status === 'running' && status.data.endpoint) {
      return status.data;
    }
  }
  return null;
}

/**
 * Pause a workspace to save compute (storage only mode).
 * @returns {Promise<void>}
 */
async function sleepAtris() {
  const slug = resolveSlug();

  if (!slug || slug === '--help' || slug === '-h' || slug === 'help') {
    console.log('Usage: atris sleep [business]');
    console.log('');
    console.log('  Pause a workspace to save compute. Storage only.');
    process.exit(0);
  }

  const creds = loadCredentials();
  if (!creds || !creds.token) { console.error('Not logged in. Run: atris login'); process.exit(1); }

  const business = await resolveBusiness(creds.token, slug);
  if (business?.business_id) {
    const result = await apiRequestJson(`/business/${business.business_id}/ai-computer/sleep`, {
      method: 'POST',
      token: creds.token,
      body: {},
    });

    if (!result.ok) {
      console.error(`Failed to sleep business computer: ${result.error || result.errorMessage || result.status}`);
      process.exit(1);
    }

    console.log(`Business computer '${business.name || slug}' is now sleeping. Files persist. Wake it with: atris wake ${slug}`);
    return;
  }

  const result = await apiRequestJson(`/workspace/${slug}/sleep`, {
    method: 'POST',
    token: creds.token,
  });

  if (!result.ok) {
    console.error(`Failed to sleep workspace: ${result.error || result.status}`);
    process.exit(1);
  }

  console.log(`Workspace '${slug}' is now sleeping. Context saved. Wake it with: atris wake ${slug}`);
  console.log('Compute paused. Storage only — pennies/day.');
}

/**
 * Wake a sleeping workspace so agents resume automatically.
 * @returns {Promise<void>}
 */
async function wakeAtris() {
  const slug = resolveSlug();

  if (!slug || slug === '--help' || slug === '-h' || slug === 'help') {
    console.log('Usage: atris wake [business]');
    console.log('');
    console.log('  Wake a sleeping workspace. Agents resume automatically.');
    process.exit(0);
  }

  const creds = loadCredentials();
  if (!creds || !creds.token) { console.error('Not logged in. Run: atris login'); process.exit(1); }

  const business = await resolveBusiness(creds.token, slug);
  if (business?.business_id) {
    if (business.workspace_id) {
      await activateBusinessWorkspace(creds.token, business);
    }

    const result = await apiRequestJson(`/business/${business.business_id}/ai-computer/wake`, {
      method: 'POST',
      token: creds.token,
      body: {},
    });

    if (!result.ok) {
      console.error(`Failed to wake business computer: ${result.error || result.errorMessage || result.status}`);
      process.exit(1);
    }

    console.log(`Waking business computer '${business.name || slug}'...`);

    if (result.data && result.data.status === 'running' && result.data.endpoint) {
      console.log(`Business computer '${business.name || slug}' is alive. Agents resuming.`);
      return;
    }

    const running = await waitForBusinessComputer(creds.token, business);
    if (running) {
      console.log(`Business computer '${business.name || slug}' is alive. Agents resuming.`);
      return;
    }

    console.log('Still starting up. Check with: atris computer status --business ' + slug);
    return;
  }

  const result = await apiRequestJson(`/workspace/${slug}/wake`, {
    method: 'POST',
    token: creds.token,
  });

  if (!result.ok) {
    console.error(`Failed to wake workspace: ${result.error || result.status}`);
    process.exit(1);
  }

  console.log(`Waking '${slug}'...`);

  const maxWait = 30000;
  const interval = 2000;
  const start = Date.now();

  while (Date.now() - start < maxWait) {
    await new Promise(r => setTimeout(r, interval));

    const status = await apiRequestJson(`/workspace/${slug}/status`, {
      method: 'GET',
      token: creds.token,
    });

    if (status.ok && status.data && status.data.status === 'running') {
      console.log(`Workspace '${slug}' is alive. Agents resuming.`);
      return;
    }
  }

  console.log('Still starting up. Check with: atris status');
}

module.exports = { sleepAtris, wakeAtris };
