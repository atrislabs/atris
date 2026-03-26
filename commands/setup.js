const fs = require('fs');
const path = require('path');
const { loadCredentials, promptUser } = require('../utils/auth');
const { apiRequestJson } = require('../utils/api');

async function setupAtris() {
  console.log('');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  Atris Setup');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('');

  // Step 1: Check Node version
  const nodeVersion = process.versions.node;
  const major = parseInt(nodeVersion.split('.')[0], 10);
  if (major < 18) {
    console.error(`Node.js ${nodeVersion} is too old. Atris requires Node.js 18 or newer.`);
    console.error('');
    console.error('Update Node.js:');
    console.error('  macOS:   brew install node');
    console.error('  or visit https://nodejs.org/en/download');
    process.exit(1);
  }
  console.log(`  [1/4] Node.js ${nodeVersion} ... OK`);

  // Step 2: Check login status
  let creds = loadCredentials();
  if (creds && creds.token) {
    const label = creds.email || creds.user_id || 'unknown';
    console.log(`  [2/4] Logged in as ${label} ... OK`);
  } else {
    console.log('  [2/4] Not logged in. Starting login...');
    console.log('');
    const { loginAtris } = require('./auth');
    // loginAtris calls process.exit, so we override it temporarily
    const originalExit = process.exit;
    let loginCompleted = false;
    process.exit = (code) => {
      if (code === 0) {
        loginCompleted = true;
        return; // Suppress exit on success so setup can continue
      }
      // On failure, actually exit
      originalExit(code);
    };
    try {
      await loginAtris();
    } finally {
      process.exit = originalExit;
    }

    if (!loginCompleted) {
      console.error('\nLogin failed. Run "atris setup" again after fixing the issue.');
      process.exit(1);
    }

    // Reload credentials after login
    creds = loadCredentials();
    if (!creds || !creds.token) {
      console.error('\nLogin did not produce credentials. Run "atris login" manually, then "atris setup" again.');
      process.exit(1);
    }
    console.log('');
    console.log(`  [2/4] Logged in ... OK`);
  }

  // Step 3: Fetch businesses
  console.log('  [3/4] Fetching your businesses...');
  let businesses = [];
  try {
    const result = await apiRequestJson('/businesses/', {
      method: 'GET',
      token: creds.token,
    });

    if (!result.ok) {
      console.error(`\n  Could not fetch businesses: ${result.error || 'Unknown error'}`);
      console.error('  You can add one later with: atris business add <slug>');
      console.log('');
      printFinished();
      return;
    }

    businesses = Array.isArray(result.data) ? result.data : [];
  } catch (err) {
    console.error(`\n  Could not fetch businesses: ${err.message || err}`);
    console.error('  You can add one later with: atris business add <slug>');
    console.log('');
    printFinished();
    return;
  }

  if (businesses.length === 0) {
    console.log('\n  No businesses found on your account.');
    console.log('  Create one at https://atris.ai or ask your team admin for access.');
    console.log('');
    printFinished();
    return;
  }

  // Step 4: List businesses and let user pick
  console.log('');
  console.log('  Your businesses:');
  businesses.forEach((b, i) => {
    const name = b.name || b.slug || 'Unnamed';
    const slug = b.slug || b.id || '';
    console.log(`    ${i + 1}. ${name} (${slug})`);
  });
  console.log('');

  const answer = await promptUser('  Which business to pull? (number or slug, or "skip"): ');

  if (!answer || answer.toLowerCase() === 'skip') {
    console.log('  Skipped. You can pull a business later with: atris pull <slug>');
    console.log('');
    printFinished();
    return;
  }

  // Resolve selection — try number first, then slug match
  let selected = null;
  const num = parseInt(answer, 10);
  if (!isNaN(num) && num >= 1 && num <= businesses.length) {
    selected = businesses[num - 1];
  } else {
    // Try slug or name match
    const q = answer.toLowerCase();
    selected = businesses.find(b => (b.slug || '').toLowerCase() === q)
      || businesses.find(b => (b.name || '').toLowerCase() === q)
      || businesses.find(b => (b.slug || '').toLowerCase().includes(q))
      || businesses.find(b => (b.name || '').toLowerCase().includes(q));
  }

  if (!selected) {
    console.error(`\n  Could not find a business matching "${answer}".`);
    console.log('  Run "atris pull <slug>" to pull manually.');
    console.log('');
    printFinished();
    return;
  }

  const slug = selected.slug || selected.id;
  console.log(`\n  [4/4] Pulling "${selected.name || slug}"...`);

  try {
    const { pullAtris } = require('./pull');
    // Set the arg so pullAtris picks it up
    const originalArgv = process.argv.slice();
    process.argv[3] = slug;
    const originalExit = process.exit;
    process.exit = (code) => {
      if (code === 0) return;
      originalExit(code);
    };
    try {
      await pullAtris();
    } finally {
      process.exit = originalExit;
      process.argv = originalArgv;
    }
    console.log(`  Pulled "${selected.name || slug}" ... OK`);
  } catch (err) {
    console.error(`\n  Pull failed: ${err.message || err}`);
    console.log(`  You can try again with: atris pull ${slug}`);
  }

  console.log('');
  printFinished();
}

function printFinished() {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  You\'re all set! Run `atris activate` to start.');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('');
}

module.exports = { setupAtris };
