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
  const result = await apiRequestJson(`/businesses/by-slug/${slug}`, {
    method: 'GET',
    token: creds.token,
  });

  if (!result.ok) {
    // Try listing all and matching
    const listResult = await apiRequestJson('/businesses/', { method: 'GET', token: creds.token });
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
    default:
      console.log('Usage: atris business <add|list|remove> [slug]');
  }
}

module.exports = { businessCommand, loadBusinesses, saveBusinesses, getBusinessConfigPath };
