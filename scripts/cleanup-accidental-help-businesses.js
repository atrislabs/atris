#!/usr/bin/env node
'use strict';

// Remove April 2026 ghost businesses created when `atris business init --help`
// was treated as a create request (--help, help, help-1, help-2, ...).
//
// Dry-run by default. Pass --apply to DELETE matching cloud rows (owner only).

const { loadCredentials } = require('../utils/auth');
const { apiRequestJson } = require('../utils/api');
const { isAccidentalHelpBusiness, loadBusinesses, saveBusinesses } = require('../commands/business');

function usage() {
  console.log('Usage: node scripts/cleanup-accidental-help-businesses.js [--apply] [--json]');
  console.log('');
  console.log('Lists accidental help businesses in cloud + local cache.');
  console.log('--apply deletes matching cloud rows and purges local cache keys.');
  console.log('Requires: atris login');
}

function isJunkBusiness(business) {
  return isAccidentalHelpBusiness(business?.name) || isAccidentalHelpBusiness(business?.slug);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg === '--help' || arg === '-h')) {
    usage();
    return 0;
  }

  const apply = args.includes('--apply');
  const json = args.includes('--json');
  const creds = loadCredentials();
  if (!creds || !creds.token) {
    console.error('Not logged in. Run: atris login');
    return 1;
  }

  const listResult = await apiRequestJson('/business/', { method: 'GET', token: creds.token });
  if (!listResult.ok || !Array.isArray(listResult.data)) {
    console.error(`Failed to list businesses: ${listResult.errorMessage || listResult.error || listResult.status}`);
    return 1;
  }

  const junk = listResult.data.filter(isJunkBusiness);
  const cache = loadBusinesses();
  const cacheKeys = Object.keys(cache).filter((key) => {
    const entry = cache[key];
    const cloudMatch = junk.find((row) => row.id === entry?.business_id);
    return isAccidentalHelpBusiness(key)
      || isAccidentalHelpBusiness(entry?.name)
      || isAccidentalHelpBusiness(entry?.slug)
      || Boolean(cloudMatch);
  });

  if (json) {
    console.log(JSON.stringify({
      apply,
      cloud: junk.map((row) => ({ id: row.id, name: row.name, slug: row.slug })),
      cache_keys: cacheKeys,
    }, null, 2));
    if (!apply) return 0;
  } else {
    console.log('');
    console.log('Accidental help businesses');
    console.log('--------------------------');
    if (junk.length === 0) console.log('cloud: none');
    else {
      for (const row of junk) {
        console.log(`  cloud  ${row.slug || row.name}  id=${row.id}`);
      }
    }
    if (cacheKeys.length === 0) console.log('cache: none');
    else {
      for (const key of cacheKeys) console.log(`  cache  ${key}`);
    }
    console.log('');
    if (!apply) {
      console.log('Dry run only. Re-run with --apply to delete cloud rows and purge cache keys.');
      console.log('');
      return junk.length > 0 || cacheKeys.length > 0 ? 0 : 0;
    }
  }

  const deleted = [];
  const failed = [];
  for (const row of junk) {
    const result = await apiRequestJson(`/business/${row.id}`, { method: 'DELETE', token: creds.token });
    if (result.ok) deleted.push(row.slug || row.id);
    else failed.push({ slug: row.slug, id: row.id, error: result.errorMessage || result.error || result.status });
  }

  if (cacheKeys.length > 0) {
    for (const key of cacheKeys) delete cache[key];
    saveBusinesses(cache);
  }

  if (json) {
    console.log(JSON.stringify({ deleted, failed, cache_removed: cacheKeys }, null, 2));
  } else {
    if (deleted.length) console.log(`Deleted cloud rows: ${deleted.join(', ')}`);
    if (cacheKeys.length) console.log(`Removed cache keys: ${cacheKeys.join(', ')}`);
    if (failed.length) {
      console.error('Failed deletes:');
      for (const row of failed) console.error(`  ${row.slug || row.id}: ${row.error}`);
    }
    console.log('');
  }

  return failed.length > 0 ? 1 : 0;
}

if (require.main === module) {
  main().then((code) => process.exit(code)).catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}

module.exports = { isJunkBusiness, main };
