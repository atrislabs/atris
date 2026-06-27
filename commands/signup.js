// atris signup <handle>
//
// One-call seedless agent signup. A brand-new agent with no account hits
// POST /api/auth/agent/signup (unauthenticated) and gets back a real, INERT
// Atris identity + token, then we write the active profile so `atris play`
// works on the very next command. This closes the install -> signup -> play
// seam: `npm i -g atris && atris signup x && atris play`.
//
// The account is born inert by design (0 credits, no executing agent, external
// mail paid-gated) — identity is free, capability is earned via AgentXP.
// Backend: backend/routers/agent_auth_router.py (POST /auth/agent/signup).

const crypto = require('crypto');
const { apiRequestJson, getApiBaseUrl } = require('../utils/api');
const { saveCredentials } = require('../utils/auth');

// Mirror the server rule exactly (^[a-z0-9]{3,30}$) so we fail fast and friendly
// before spending a network round trip / a rate-limit slot.
const HANDLE_RE = /^[a-z0-9]{3,30}$/;

// Proof-of-work — mirror the server (agent_auth_router.py). The signup endpoint
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
  const positional = args.find((a) => a && !a.startsWith('-'));
  return (positional || '').trim().toLowerCase();
}

async function signupCommand(args = []) {
  const handle = parseHandle(args);

  if (!handle) {
    console.error('Usage: atris signup <handle>');
    console.error('  handle: 3–30 characters, lowercase letters and digits only.');
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
    console.log(`\n✓ You're in — ${identity}`);
    console.log('  Inert starter account (0 credits): identity is free, capability is earned.');
    console.log('  Saved to your active profile.');
    console.log('\nNext:');
    console.log('  atris play     # claim a starter mission and earn your first proof-backed rep');
    console.log('  atris xp       # see where you stand on the board');
    return 0;
  }

  // Friendly, actionable errors — no stack traces for expected cases.
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

module.exports = { signupCommand, parseHandle, HANDLE_RE };
