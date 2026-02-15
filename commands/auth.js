const { loadCredentials, saveCredentials, deleteCredentials, getCredentialsPath, openBrowser, promptUser, displayAccountSummary, loadProfile, listProfiles, profileNameFromEmail } = require('../utils/auth');
const { getAppBaseUrl, apiRequestJson } = require('../utils/api');
const fs = require('fs');
const path = require('path');

async function loginAtris(options = {}) {
  // Support: atris login --token <token> --force
  const args = process.argv.slice(3);
  const forceFlag = args.includes('--force') || args.includes('-f') || options.force;
  const tokenIndex = args.indexOf('--token');
  const directToken = tokenIndex !== -1 ? args[tokenIndex + 1] : options.token;

  try {
    console.log('🔐 Login to AtrisOS\n');

    const existing = loadCredentials();

    // Direct token mode (non-interactive)
    if (directToken) {
      const trimmed = directToken.trim();
      saveCredentials(trimmed, null, existing?.email || null, existing?.user_id || null, existing?.provider || 'manual');
      console.log('Token saved. Validating…\n');
      const summary = await displayAccountSummary(apiRequestJson);
      if (summary.error) {
        console.log('\n⚠️ Token saved, but validation failed.');
        process.exit(1);
      }
      console.log('\n✓ Logged in successfully.');
      process.exit(0);
    }

    if (existing && !forceFlag) {
      const label = existing.email || existing.user_id || 'unknown user';
      console.log(`Already logged in as: ${label}`);
      const confirm = await promptUser('Do you want to login again? (y/N): ');
      if (confirm.toLowerCase() !== 'y') {
        console.log('Login cancelled.');
        process.exit(0);
      }
    }

    console.log('Choose login method:');
    console.log('  1. Browser OAuth (recommended)');
    console.log('  2. Paste existing API token');
    console.log('  3. Cancel');

    const choice = await promptUser('\nEnter choice (1-3): ');

    if (choice === '1') {
      const loginUrl = `${getAppBaseUrl()}/auth/cli`;
      console.log('\n🌐 Opening browser for OAuth login…');
      console.log('If it does not open automatically, visit:');
      console.log(loginUrl);
      console.log('\nAfter signing in, copy the CLI code shown in the browser and paste it below.');
      console.log('Codes expire after five minutes.\n');

      openBrowser(loginUrl);

      const code = await promptUser('Paste the CLI code here: ');
      if (!code) {
        console.error('✗ Error: Code is required');
        process.exit(1);
      }

      const exchange = await apiRequestJson('/auth/cli/exchange', {
        method: 'POST',
        body: { code: code.trim() },
      });

      if (!exchange.ok || !exchange.data) {
        console.error(`✗ Error: ${exchange.error || 'Invalid or expired code'}`);
        process.exit(1);
      }

      const payload = exchange.data;
      const token = payload.token;
      const refreshToken = payload.refresh_token;

      if (!token || !refreshToken) {
        console.error('✗ Error: Backend did not return tokens. Please try again.');
        process.exit(1);
      }

      const email = payload.email || existing?.email || null;
      const userId = payload.user_id || existing?.user_id || null;
      const provider = payload.provider || 'atris';

      saveCredentials(token, refreshToken, email, userId, provider);
      console.log('\n✓ Successfully logged in!');
      await displayAccountSummary(apiRequestJson);
      console.log('\nYou can now use cloud features with atris commands.');
      process.exit(0);
    } else if (choice === '2') {
      console.log('\n📋 Manual Token Entry');
      console.log('Get your token from: https://atris.ai/auth/cli\n');

      const tokenInput = await promptUser('Paste your API token: ');

      if (!tokenInput) {
        console.error('✗ Error: Token is required');
        process.exit(1);
      }

      const trimmed = tokenInput.trim();
      saveCredentials(trimmed, null, existing?.email || null, existing?.user_id || null, existing?.provider || 'manual');
      console.log('\nAttempting to validate token…\n');

      const summary = await displayAccountSummary(apiRequestJson);
      if (summary.error) {
        console.log('\n⚠️ Token saved, but validation failed. You may need to relogin.');
      } else {
        console.log('\n✓ Token validated successfully.');
      }

      console.log('\nYou can now use cloud features with atris commands.');
      process.exit(0);
    } else {
      console.log('Login cancelled.');
      process.exit(0);
    }
  } catch (error) {
    console.error(`\n✗ Login failed: ${error.message || error}`);
    process.exit(1);
  }
}

function logoutAtris() {
  const credentials = loadCredentials();

  if (!credentials) {
    console.log('Not currently logged in.');
    process.exit(0);
  }

  deleteCredentials();
  console.log('✓ Successfully logged out');
  console.log(`✓ Removed credentials from ${getCredentialsPath()}`);
}

async function whoamiAtris() {
  const { apiRequestJson } = require('../utils/api');
  
  try {
    const summary = await displayAccountSummary(apiRequestJson);
    if (summary.error) {
      console.log('\nRun "atris login" to authenticate with AtrisOS.');
      process.exit(1);
    }
    process.exit(0);
  } catch (error) {
    console.error(`✗ Failed to fetch account details: ${error.message || error}`);
    process.exit(1);
  }
}

async function switchAccount() {
  const args = process.argv.slice(3);
  const targetName = args.filter(a => !a.startsWith('-'))[0];

  const profiles = listProfiles();
  if (profiles.length === 0) {
    console.log('No saved profiles. Log in with different accounts to create profiles.');
    console.log('Profiles are auto-saved on login.');
    process.exit(1);
  }

  const current = loadCredentials();
  const currentName = profileNameFromEmail(current?.email);

  if (!targetName) {
    // Interactive: show list and let user pick
    console.log('Switch account:\n');
    profiles.forEach((name, i) => {
      const profile = loadProfile(name);
      const email = profile?.email || 'unknown';
      const marker = name === currentName ? ' (active)' : '';
      console.log(`  ${i + 1}. ${name} — ${email}${marker}`);
    });
    console.log(`  ${profiles.length + 1}. Cancel`);

    const choice = await promptUser(`\nEnter choice (1-${profiles.length + 1}): `);
    const idx = parseInt(choice, 10) - 1;

    if (isNaN(idx) || idx < 0 || idx >= profiles.length) {
      console.log('Cancelled.');
      process.exit(0);
    }

    const chosen = profiles[idx];
    return activateProfile(chosen, currentName);
  }

  // Direct: atris switch <name>
  // Fuzzy match: allow partial names
  const exact = profiles.find(p => p === targetName);
  const partial = !exact ? profiles.find(p => p.startsWith(targetName)) : null;
  const match = exact || partial;

  if (!match) {
    console.error(`Profile "${targetName}" not found.`);
    console.log(`Available: ${profiles.join(', ')}`);
    process.exit(1);
  }

  return activateProfile(match, currentName);
}

function activateProfile(name, currentName) {
  if (name === currentName) {
    console.log(`Already on "${name}".`);
    process.exit(0);
  }

  const profile = loadProfile(name);
  if (!profile || !profile.token) {
    console.error(`Profile "${name}" is corrupted. Login again to fix it.`);
    process.exit(1);
  }

  // Copy profile to credentials.json
  const credentialsPath = getCredentialsPath();
  fs.writeFileSync(credentialsPath, JSON.stringify(profile, null, 2));
  try { fs.chmodSync(credentialsPath, 0o600); } catch {}

  console.log(`Switched to "${name}" (${profile.email || 'unknown'})`);
}

function listAccountsCmd() {
  const profiles = listProfiles();
  if (profiles.length === 0) {
    console.log('No saved profiles. Profiles are auto-saved on login.');
    process.exit(0);
  }

  const current = loadCredentials();
  const currentName = profileNameFromEmail(current?.email);

  console.log('Accounts:\n');
  profiles.forEach(name => {
    const profile = loadProfile(name);
    const email = profile?.email || 'unknown';
    const marker = name === currentName ? ' *' : '';
    console.log(`  ${name} — ${email}${marker}`);
  });
  console.log('\n* = active');
  console.log('\nSwitch: atris switch <name>');
}

module.exports = { loginAtris, logoutAtris, whoamiAtris, switchAccount, listAccountsCmd };
