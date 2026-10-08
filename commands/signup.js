// atris signup <handle>
//
// One-call seedless agent signup. A brand-new agent with no account hits
// POST /api/auth/agent/signup (unauthenticated) and gets back a real, INERT
// Atris identity + token, then we write the active profile so `atris play`
// works on the very next command. This closes the install -> signup -> play
// seam: `npm i -g atris && atris signup x && atris play`.
//
// The account is born inert by design (0 credits, no executing agent, external
// mail paid-gated), identity is free, capability is earned via AgentXP.
// Backend: backend/routers/agent_auth_router.py (POST /auth/agent/signup).

const crypto = require('crypto');
const fs = require('fs');
const { apiRequestJson, getApiBaseUrl } = require('../utils/api');
const { saveCredentials, saveProfile, saveAgentClientCredentials, getCredentialsPath } = require('../utils/auth');
const agentClient = require('../utils/agent-client');
const { argsWantHelp, isHelpToken } = require('../lib/noninteractive');

// Mirror the server rule exactly (^[a-z0-9]{3,30}$) so we fail fast and friendly
// before spending a network round trip / a rate-limit slot.
const HANDLE_RE = /^[a-z0-9]{3,30}$/;

// Proof-of-work: mirror the server (agent_auth_router.py). The signup endpoint
// requires a nonce whose sha256(prefix:handle:bucket:nonce) has DIFFICULTY_BITS
// leading zero bits. Bucket = current 5-min window. Solved locally (~1s) so
// signup stays a single call; this is the cost that makes mass-minting expensive.
const POW_PREFIX = 'atris-signup-v1';
const POW_WINDOW_S = 300;
const POW_DIFFICULTY_BITS = 20;

function solvePow(handle) {
  const bucket = Math.floor(Date.now() / 1000 / POW_WINDOW_S);
  const fullBytes = Math.floor(POW_DIFFICULTY_BITS / 8);
  const remBits = POW_DIFFICULTY_BITS % 8;
  for (let n = 0; ; n++) {
    const d = crypto.createHash('sha256').update(`${POW_PREFIX}:${handle}:${bucket}:${n}`).digest();
    let ok = true;
    for (let i = 0; i < fullBytes; i++) { if (d[i] !== 0) { ok = false; break; } }
    if (ok && remBits && (d[fullBytes] >> (8 - remBits)) !== 0) ok = false;
    if (ok) return String(n);
  }
}

function parseHandle(args = []) {
  const positional = args.find((a) => a && !a.startsWith('-') && !isHelpToken(a));
  return (positional || '').trim().toLowerCase();
}

// Newer servers also hand back an agent client (id + secret) so the agent can
// renew its own login forever. Store it the way `atris login` does with the
// secret in ATRIS_CLIENT_SECRET: a private 0600 copy under
// ~/.atris/agent-clients/, then make the client the active login. The 30-day
// token just saved stays reachable as a profile named after the handle.
// Returns { ok: true } or { ok: false, secretFile, clientId }. Never throws,
// never prints the secret or a token.
async function adoptSignupClient(client, handle, deps = {}) {
  const clientId = client && typeof client.client_id === 'string' ? client.client_id.trim() : '';
  const secret = client && typeof client.client_secret === 'string' ? client.client_secret.trim() : '';
  if (!clientId.startsWith(agentClient.CLIENT_ID_PREFIX) || !secret) return { ok: false };

  let secretFile = null;
  try {
    const target = agentClient.managedSecretPath(clientId);
    agentClient.writeFileAtomic(target, `${secret}\n`);
    secretFile = target;
    const entry = await agentClient.requestClientToken({ clientId, secret, scope: null }, deps);

    // Keep the 30-day login as a profile named after the handle, then switch.
    const fallback = JSON.parse(fs.readFileSync(getCredentialsPath(), 'utf8'));
    saveProfile(handle, fallback);
    saveAgentClientCredentials({ client_id: clientId, client_secret_file: secretFile, scope: null });
    agentClient.writeTokenCache(clientId, entry);
    return { ok: true, clientId };
  } catch (error) {
    return { ok: false, clientId, secretFile, reason: agentClient.scrub(error && error.message, [secret]) };
  }
}

function printSignupUsage() {
  console.error('Usage: atris signup <handle>');
  console.error('  handle: 3–30 characters, lowercase letters and digits only.');
}

async function signupCommand(args = []) {
  if (argsWantHelp(args)) {
    printSignupUsage();
    return 2;
  }
  const handle = parseHandle(args);

  if (!handle) {
    printSignupUsage();
    return 1;
  }
  if (!HANDLE_RE.test(handle)) {
    console.error(`✗ Invalid handle "${handle}".`);
    console.error('  Must be 3–30 characters, lowercase letters and digits (a–z, 0–9). No spaces or symbols.');
    return 1;
  }

  console.log(`Claiming @${handle} … (solving proof-of-work)`);
  const pow = solvePow(handle);

  const res = await apiRequestJson('/auth/agent/signup', {
    method: 'POST',
    body: { handle, pow },
  });

  if (res.ok && res.data && res.data.token) {
    const { token, email, user_id: userId } = res.data;
    const identity = email || `${handle}@atrismail.com`;
    saveCredentials(token, null, identity, userId || null, 'atrisos');
    const hasClient = Boolean(res.data.client);
    const adopted = hasClient ? await adoptSignupClient(res.data.client, handle) : { ok: false };
    console.log(`\n✓ You're in: ${identity}`);
    if (adopted.ok) console.log('This agent renews its own login; no human needed.');
    console.log('  Inert starter account (0 credits): identity is free, capability is earned.');
    console.log('  Saved to your active profile.');
    if (adopted.ok) {
      console.log(`  The 30-day login is kept as a backup. switch to it: atris switch ${handle} --global`);
    } else if (hasClient && adopted.secretFile) {
      console.log(`  Could not sign in with the agent client yet${adopted.reason ? ` (${adopted.reason})` : ''}. Using the 30-day login for now.`);
      console.log(`  Try again: atris login --client-id ${adopted.clientId} --client-secret-file ${adopted.secretFile}`);
    } else if (hasClient || typeof res.data.client_error === 'string') {
      console.log('  This login lasts 30 days; after that, renewing it will need a fresh signup login.');
    }
    console.log('\nNext:');
    console.log('  atris play     # claim a starter mission and earn your first proof-backed rep');
    console.log('  atris xp       # see where you stand on the board');
    return 0;
  }

  // Friendly, actionable errors, no stack traces for expected cases.
  if (res.status === 409) {
    console.error(`✗ "${handle}" is already taken or reserved. Try a different handle.`);
    return 1;
  }
  if (res.status === 429) {
    console.error('✗ Too many signups right now. Wait a minute and try again.');
    return 1;
  }
  if (res.status === 404) {
    console.error('✗ Seedless signup isn’t available on this backend yet.');
    console.error('  Use `atris login` for now, or try again after the next deploy.');
    return 1;
  }
  console.error(`✗ Signup failed: ${res.error || 'unknown error'} (status ${res.status}).`);
  console.error(`  API: ${getApiBaseUrl()}`);
  return 1;
}

module.exports = { signupCommand, parseHandle, HANDLE_RE, adoptSignupClient };
