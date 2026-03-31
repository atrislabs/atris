const { loadCredentials, saveCredentials, deleteCredentials, getCredentialsPath, openBrowser, promptUser, displayAccountSummary, loadProfile, listProfiles, profileNameFromEmail, deleteProfile, getTerminalSessionId, setSessionProfile, getSessionProfile, clearSessionProfile, cleanStaleSessions } = require('../utils/auth');
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
      const label = existing.email || existing.user_id || 'unknown';
      const profiles = listProfiles();
      console.log(`Currently signed in as: ${label}`);
      if (profiles.length > 1) {
        console.log(`${profiles.length} accounts saved. Use "atris switch" to change.\n`);
      }
      console.log('  1. Add another account');
      console.log('  2. Re-login to current account');
      console.log('  3. Cancel\n');

      const choice = await promptUser('Choice (1-3): ');
      if (choice === '3' || (!choice)) {
        console.log('Cancelled.');
        process.exit(0);
      }
      // Both 1 and 2 proceed to OAuth — the difference is just the prompt
    } else if (!existing) {
      console.log('Welcome to Atris! Let\'s get you signed in.\n');
    }

    console.log('Choose login method:');
    console.log('  1. Browser OAuth (recommended)');
    console.log('  2. Paste existing API token');
    console.log('  3. Cancel');

    const methodChoice = await promptUser('\nEnter choice (1-3): ');

    if (methodChoice === '1') {
      const loginUrl = `${getAppBaseUrl()}/auth/cli`;
      console.log('\nOpening browser…');
      console.log('If it doesn\'t open, visit:');
      console.log(`  ${loginUrl}\n`);
      console.log('After signing in, paste the CLI code shown in the browser.\n');

      openBrowser(loginUrl);

      const code = await promptUser('CLI code: ');
      if (!code) {
        console.error('Error: Code is required.');
        process.exit(1);
      }

      const exchange = await apiRequestJson('/auth/cli/exchange', {
        method: 'POST',
        body: { code: code.trim() },
      });

      if (!exchange.ok || !exchange.data) {
        console.error(`Error: ${exchange.error || 'Invalid or expired code'}`);
        process.exit(1);
      }

      const payload = exchange.data;
      const token = payload.token;
      const refreshToken = payload.refresh_token;

      if (!token || !refreshToken) {
        console.error('Error: Backend did not return tokens. Try again.');
        process.exit(1);
      }

      const email = payload.email || null;
      const userId = payload.user_id || null;
      const provider = payload.provider || 'atris';

      saveCredentials(token, refreshToken, email, userId, provider);
      const name = profileNameFromEmail(email);
      console.log(`\n✓ Signed in as ${email || 'unknown'}${name ? ` (profile: ${name})` : ''}`);
      await displayAccountSummary(apiRequestJson);
      process.exit(0);
    } else if (methodChoice === '2') {
      console.log('\nGet your token from: https://atris.ai/auth/cli\n');

      const tokenInput = await promptUser('API token: ');

      if (!tokenInput) {
        console.error('Error: Token is required.');
        process.exit(1);
      }

      const trimmed = tokenInput.trim();
      saveCredentials(trimmed, null, existing?.email || null, existing?.user_id || null, existing?.provider || 'manual');
      console.log('\nValidating…\n');

      const summary = await displayAccountSummary(apiRequestJson);
      if (summary.error) {
        console.log('\n⚠️ Token saved, but validation failed.');
      } else {
        console.log('\n✓ Token validated.');
      }

      process.exit(0);
    } else {
      console.log('Cancelled.');
      process.exit(0);
    }
  } catch (error) {
    console.error(`\nLogin failed: ${error.message || error}`);
    process.exit(1);
  }
}

function logoutAtris() {
  const credentials = loadCredentials();

  if (!credentials) {
    console.log('Not signed in.');
    process.exit(0);
  }

  const profiles = listProfiles();
  const currentName = profileNameFromEmail(credentials?.email);

  deleteCredentials();
  console.log(`✓ Signed out from ${credentials.email || 'current account'}`);

  // Remind about other profiles
  const remaining = profiles.filter(p => p !== currentName);
  if (remaining.length > 0) {
    console.log(`\n${remaining.length} other account${remaining.length > 1 ? 's' : ''} saved.`);
    console.log(`Switch to one: atris switch ${remaining[0]}`);
    console.log('Or remove all: atris accounts remove --all');
  }
}

async function whoamiAtris() {
  const { apiRequestJson } = require('../utils/api');

  try {
    const summary = await displayAccountSummary(apiRequestJson);
    if (summary.error) {
      console.log('\nRun "atris login" to sign in.');
      process.exit(1);
    }
    process.exit(0);
  } catch (error) {
    console.error(`Failed to fetch account: ${error.message || error}`);
    process.exit(1);
  }
}

async function switchAccount() {
  const args = process.argv.slice(3);
  const globalFlag = args.includes('--global') || args.includes('-g');
  const targetName = args.filter(a => !a.startsWith('-'))[0];

  // Clean up stale session files in the background
  cleanStaleSessions();

  const profiles = listProfiles();
  if (profiles.length === 0) {
    console.log('No saved accounts. Run "atris login" to add one.');
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
      const marker = name === currentName ? '  ← active' : '';
      console.log(`  ${i + 1}. ${name} — ${email}${marker}`);
    });
    console.log(`  ${profiles.length + 1}. Add new account`);
    console.log(`  ${profiles.length + 2}. Cancel`);

    const choice = await promptUser(`\nChoice (1-${profiles.length + 2}): `);
    const idx = parseInt(choice, 10) - 1;

    if (idx === profiles.length) {
      // Add new account
      return loginAtris({ force: true });
    }

    if (isNaN(idx) || idx < 0 || idx >= profiles.length) {
      console.log('Cancelled.');
      process.exit(0);
    }

    const chosen = profiles[idx];
    return activateProfile(chosen, currentName, { global: globalFlag });
  }

  // Direct: atris switch <name>
  // Fuzzy match: exact → startsWith → substring → email substring
  const q = targetName.toLowerCase();
  const match = profiles.find(p => p.toLowerCase() === q)
    || profiles.find(p => p.toLowerCase().startsWith(q))
    || profiles.find(p => p.toLowerCase().includes(q))
    || profiles.find(p => {
      const profile = loadProfile(p);
      return profile?.email?.toLowerCase().includes(q);
    });

  if (!match) {
    console.error(`No account matching "${targetName}".`);
    console.log(`Available: ${profiles.join(', ')}`);
    process.exit(1);
  }

  return activateProfile(match, currentName, { global: globalFlag });
}

function activateProfile(name, currentName, { global = false } = {}) {
  if (name === currentName) {
    console.log(`Already on "${name}".`);
    process.exit(0);
  }

  const profile = loadProfile(name);
  if (!profile || !profile.token) {
    console.error(`Profile "${name}" is corrupted. Run "atris login" to fix.`);
    process.exit(1);
  }

  if (global || !getTerminalSessionId()) {
    // Global switch — write to credentials.json (affects all terminals)
    const credentialsPath = getCredentialsPath();
    fs.writeFileSync(credentialsPath, JSON.stringify(profile, null, 2));
    try { fs.chmodSync(credentialsPath, 0o600); } catch {}
    console.log(`Switched to ${profile.email || name} (global — all terminals)`);
  } else {
    // Per-terminal switch — write session file (only this terminal)
    setSessionProfile(name);
    console.log(`Switched to ${profile.email || name}`);
  }
}

function useAccount() {
  const args = process.argv.slice(3);
  const targetName = args.filter(a => !a.startsWith('-'))[0];

  if (!targetName) {
    // Show current per-terminal override or global
    const envProfile = process.env.ATRIS_PROFILE;
    if (envProfile) {
      const profile = loadProfile(envProfile);
      const email = profile?.email || envProfile;
      console.log(`This terminal: ${email} (ATRIS_PROFILE=${envProfile})`);
    } else {
      const current = loadCredentials();
      if (current) {
        console.log(`Global: ${current.email || 'unknown'} (no per-terminal override)`);
      } else {
        console.log('Not signed in.');
      }
    }
    console.log('\nSet per-terminal account:');
    console.log('  eval "$(atris use <name>)"');
    console.log('\nOr manually:');
    console.log('  export ATRIS_PROFILE=<name>');
    process.exit(0);
  }

  // Fuzzy match the profile
  const profiles = listProfiles();
  const q = targetName.toLowerCase();
  const match = profiles.find(p => p.toLowerCase() === q)
    || profiles.find(p => p.toLowerCase().startsWith(q))
    || profiles.find(p => p.toLowerCase().includes(q))
    || profiles.find(p => {
      const profile = loadProfile(p);
      return profile?.email?.toLowerCase().includes(q);
    });

  if (!match) {
    console.error(`No account matching "${targetName}".`);
    console.error(`Available: ${profiles.join(', ')}`);
    process.exit(1);
  }

  const profile = loadProfile(match);
  const email = profile?.email || match;

  // If stdout is piped (eval mode), output just the export
  if (!process.stdout.isTTY) {
    process.stdout.write(`export ATRIS_PROFILE=${match}\n`);
  } else {
    // Interactive — print instructions
    console.log(`export ATRIS_PROFILE=${match}`);
    console.log(`\n# Run this to activate ${email} in this terminal:`);
    console.log(`#   eval "$(atris use ${targetName})"`);
    console.log(`# Or just copy the export line above.`);
  }
}

async function accountsCmd() {
  const args = process.argv.slice(3);
  const subCmd = args[0];

  if (subCmd === 'add' || subCmd === 'login') {
    return loginAtris({ force: true });
  }

  if (subCmd === 'remove' || subCmd === 'rm') {
    const target = args[1];
    if (target === '--all') {
      const profiles = listProfiles();
      if (profiles.length === 0) {
        console.log('No accounts to remove.');
        process.exit(0);
      }
      const confirm = await promptUser(`Remove all ${profiles.length} accounts? (y/N): `);
      if (confirm.toLowerCase() !== 'y') {
        console.log('Cancelled.');
        process.exit(0);
      }
      profiles.forEach(p => deleteProfile(p));
      deleteCredentials();
      console.log(`✓ Removed ${profiles.length} account(s).`);
      process.exit(0);
    }
    if (!target) {
      console.log('Usage: atris accounts remove <name>');
      console.log('       atris accounts remove --all');
      process.exit(1);
    }
    // Fuzzy match
    const profiles = listProfiles();
    const q = target.toLowerCase();
    const match = profiles.find(p => p.toLowerCase() === q)
      || profiles.find(p => p.toLowerCase().startsWith(q))
      || profiles.find(p => p.toLowerCase().includes(q));
    if (!match) {
      console.error(`No account matching "${target}".`);
      console.log(`Available: ${profiles.join(', ')}`);
      process.exit(1);
    }
    const profile = loadProfile(match);
    const email = profile?.email || 'unknown';
    const confirm = await promptUser(`Remove ${match} (${email})? (y/N): `);
    if (confirm.toLowerCase() !== 'y') {
      console.log('Cancelled.');
      process.exit(0);
    }
    deleteProfile(match);
    // If this was the active account, clear credentials
    const current = loadCredentials();
    if (current && profileNameFromEmail(current.email) === match) {
      deleteCredentials();
      const remaining = listProfiles();
      if (remaining.length > 0) {
        console.log(`✓ Removed ${email}. No active account.`);
        console.log(`Switch to another: atris switch ${remaining[0]}`);
      } else {
        console.log(`✓ Removed ${email}. No accounts remaining.`);
        console.log('Run "atris login" to add one.');
      }
    } else {
      console.log(`✓ Removed ${email}.`);
    }
    process.exit(0);
  }

  // Default: list accounts
  return listAccountsCmd();
}

function listAccountsCmd() {
  const profiles = listProfiles();
  if (profiles.length === 0) {
    console.log('No accounts saved. Run "atris login" to add one.');
    process.exit(0);
  }

  const current = loadCredentials();
  const currentUid = current?.user_id;
  // Also check which profile name is active (env var or session)
  const envProfile = process.env.ATRIS_PROFILE;
  const sessionProfile = getSessionProfile();

  console.log('\n  Accounts\n');
  profiles.forEach(name => {
    const profile = loadProfile(name);
    const email = profile?.email || 'unknown';
    const isActive = profile?.user_id === currentUid;
    if (isActive) {
      console.log(`  ● ${name}  ${email}`);
    } else {
      console.log(`    ${name}  ${email}`);
    }
  });
  console.log(`\n  Switch:  atris switch <name>`);
  console.log(`  Add:     atris accounts add`);
  console.log(`  Remove:  atris accounts remove <name>\n`);
}

function resolveProfile() {
  // Hidden command: atris _resolve <query> → prints resolved profile name
  const query = process.argv[3];
  if (!query) { process.exit(1); }
  const profiles = listProfiles();
  const q = query.toLowerCase();
  const match = profiles.find(p => p.toLowerCase() === q)
    || profiles.find(p => p.toLowerCase().startsWith(q))
    || profiles.find(p => p.toLowerCase().includes(q))
    || profiles.find(p => {
      const profile = loadProfile(p);
      return profile?.email?.toLowerCase().includes(q);
    });
  if (match) {
    process.stdout.write(match);
    process.exit(0);
  }
  process.exit(1);
}

function profileEmail() {
  // Hidden command: atris _profile-email <name> → prints email
  const name = process.argv[3];
  if (!name) { process.exit(1); }
  const profile = loadProfile(name);
  if (profile?.email) {
    process.stdout.write(profile.email);
    process.exit(0);
  }
  process.exit(1);
}

function activateGlobal() {
  // Hidden command: atris _activate <name> → copy profile to credentials.json
  // Called by the shell wrapper so `atris switch` persists across terminals.
  const name = process.argv[3];
  if (!name) { process.exit(1); }
  const profile = loadProfile(name);
  if (!profile || !profile.token) { process.exit(1); }
  const credentialsPath = getCredentialsPath();
  fs.writeFileSync(credentialsPath, JSON.stringify(profile, null, 2));
  try { fs.chmodSync(credentialsPath, 0o600); } catch {}
  process.exit(0);
}

function shellInit() {
  // Output shell function for per-terminal account switching
  // Usage: eval "$(atris shell-init)"  (add to ~/.zshrc)
  // Use array join to avoid JS template literal parsing issues with ${}
  const lines = [
    '# Atris per-terminal account switching',
    '# Added by: eval "$(atris shell-init)"',
    'atris() {',
    '  if [[ "$1" == "switch" && -n "$2" && "$2" != "--"* ]]; then',
    '    local _profile',
    '    _profile=$(command atris _resolve "$2" 2>/dev/null)',
    '    if [[ $? -eq 0 && -n "$_profile" ]]; then',
    '      export ATRIS_PROFILE="$_profile"',
    '      command atris _activate "$_profile" 2>/dev/null',
    '      local _email',
    '      _email=$(command atris _profile-email "$_profile" 2>/dev/null)',
    '      echo "Switched to ${_email:-$_profile}"',
    '    else',
    '      echo "No account matching \'$2\'."',
    '      command atris accounts',
    '    fi',
    '  elif [[ "$1" == "switch" && $# -eq 1 ]]; then',
    '    command atris accounts',
    '    echo ""',
    '    printf "Switch to: "',
    '    read _pick',
    '    if [[ -n "$_pick" ]]; then',
    '      local _profile',
    '      _profile=$(command atris _resolve "$_pick" 2>/dev/null)',
    '      if [[ $? -eq 0 && -n "$_profile" ]]; then',
    '        export ATRIS_PROFILE="$_profile"',
    '        command atris _activate "$_profile" 2>/dev/null',
    '        local _email',
    '        _email=$(command atris _profile-email "$_profile" 2>/dev/null)',
    '        echo "Switched to ${_email:-$_profile}"',
    '      else',
    '        echo "No account matching \'$_pick\'."',
    '      fi',
    '    fi',
    '  else',
    '    command atris "$@"',
    '  fi',
    '}',
  ];
  console.log(lines.join('\n'));
}

module.exports = { loginAtris, logoutAtris, whoamiAtris, switchAccount, useAccount, accountsCmd, listAccountsCmd, resolveProfile, profileEmail, activateGlobal, shellInit };
