const os = require('os');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');
const readline = require('readline');

/**
 * Open a URL in the system's default browser.
 * @param {string} url - URL to open
 */
function openBrowser(url) {
  const platform = os.platform();
  // Sanitize URL to prevent shell injection — only allow valid URL characters
  const sanitizedUrl = url.replace(/[^a-zA-Z0-9\-._~:/?#\[\]@!$&'()*+,;=%]/g, '');
  let command;

  if (platform === 'darwin') {
    command = `open "${sanitizedUrl}"`;
  } else if (platform === 'win32') {
    command = `start "" "${sanitizedUrl}"`;
  } else {
    command = `xdg-open "${sanitizedUrl}"`;
  }

  exec(command, (error) => {
    if (error) {
      console.log(`\nCouldn't open browser automatically. Please visit:\n${url}`);
    }
  });
}

// Shared readline for piped input
let sharedRl = null;
let inputLines = [];
let inputIndex = 0;

/**
 * Prompt the user for input, handling both TTY and piped input.
 * @param {string} question - Prompt text to display
 * @returns {Promise<string>} User's input
 */
function promptUser(question) {
  // If stdin is not a TTY (piped input), read all lines upfront
  if (!process.stdin.isTTY && inputLines.length === 0 && !sharedRl) {
    return new Promise((resolve) => {
      let data = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', chunk => data += chunk);
      process.stdin.on('end', () => {
        inputLines = data.trim().split('\n');
        process.stdout.write(question);
        const answer = inputLines[inputIndex++] || '';
        console.log(answer);
        resolve(answer.trim());
      });
      process.stdin.resume();
    });
  }

  // If we already have buffered lines from piped input
  if (inputLines.length > 0 && inputIndex < inputLines.length) {
    return new Promise((resolve) => {
      process.stdout.write(question);
      const answer = inputLines[inputIndex++] || '';
      console.log(answer);
      resolve(answer.trim());
    });
  }

  // Interactive TTY mode - create readline per prompt
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

const TOKEN_REFRESH_BUFFER_SECONDS = 300;

/**
 * Decode and parse the claims from a JWT token.
 * @param {string} token - JWT token string
 * @returns {Object|null} Decoded claims or null if invalid
 */
function decodeJwtClaims(token) {
  if (!token || typeof token !== 'string') {
    return null;
  }
  const parts = token.split('.');
  if (parts.length < 2) {
    return null;
  }
  try {
    const normalized = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), '=');
    const decoded = Buffer.from(padded, 'base64').toString('utf8');
    return JSON.parse(decoded);
  } catch {
    return null;
  }
}

/**
 * Get the expiration time of a JWT token in epoch seconds.
 * @param {string} token - JWT token string
 * @returns {number|null} Expiry epoch seconds or null if invalid
 */
function getTokenExpiryEpochSeconds(token) {
  const claims = decodeJwtClaims(token);
  if (!claims || typeof claims.exp !== 'number') {
    return null;
  }
  return claims.exp;
}

/**
 * Check if a JWT token should be refreshed based on expiry.
 * @param {string} token - JWT token string
 * @param {number} [bufferSeconds=300] - Seconds before expiry to trigger refresh
 * @returns {boolean} True if token needs refresh
 */
function shouldRefreshToken(token, bufferSeconds = TOKEN_REFRESH_BUFFER_SECONDS) {
  const exp = getTokenExpiryEpochSeconds(token);
  if (!exp) {
    return false;
  }
  const nowSeconds = Math.floor(Date.now() / 1000);
  return exp <= nowSeconds + bufferSeconds;
}

// Credentials management
function getAtrisDir() {
  const homeDir = os.homedir();
  const atrisDir = path.join(homeDir, '.atris');
  if (!fs.existsSync(atrisDir)) {
    fs.mkdirSync(atrisDir, { recursive: true });
  }
  return atrisDir;
}

function getCredentialsPath() {
  return path.join(getAtrisDir(), 'credentials.json');
}

function getSessionsDir() {
  const dir = path.join(getAtrisDir(), 'sessions');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function getTerminalSessionId() {
  // Unique per terminal window/tab — works across macOS terminals, tmux, VS Code, Ghostty
  const envId = process.env.TERM_SESSION_ID     // macOS Terminal.app
    || process.env.ITERM_SESSION_ID              // iTerm2
    || process.env.TMUX_PANE                     // tmux pane
    || process.env.WT_SESSION                    // Windows Terminal
    || process.env.WEZTERM_PANE;                 // WezTerm
  if (envId) return envId;

  // Universal fallback: TTY device name (unique per terminal tab on macOS/Linux)
  // Each Ghostty/iTerm/Terminal tab gets a unique /dev/ttysNNN
  try {
    // Method 1: check if stdin is a TTY and resolve its path
    if (process.stdin.isTTY) {
      const resolved = fs.realpathSync('/dev/stdin');
      if (resolved && resolved.startsWith('/dev/tty')) return resolved;
    }
  } catch {}

  try {
    // Method 2: shell out to tty command
    const { execSync } = require('child_process');
    const tty = execSync('tty', { encoding: 'utf8', stdio: ['inherit', 'pipe', 'pipe'] }).trim();
    if (tty && tty !== 'not a tty' && tty.startsWith('/dev/')) return tty;
  } catch {}

  return null;
}

function sanitizeSessionId(id) {
  // Make filesystem-safe: replace non-alphanumeric with dashes, truncate
  return id.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 64);
}

function getSessionFilePath() {
  const sessionId = getTerminalSessionId();
  if (!sessionId) return null;
  return path.join(getSessionsDir(), `${sanitizeSessionId(sessionId)}.json`);
}

function setSessionProfile(profileName) {
  const sessionPath = getSessionFilePath();
  if (!sessionPath) {
    // No terminal session ID — fall back to global switch
    return false;
  }
  fs.writeFileSync(sessionPath, JSON.stringify({
    profile: profileName,
    set_at: new Date().toISOString(),
  }));
  return true;
}

function getSessionProfile() {
  const sessionPath = getSessionFilePath();
  if (!sessionPath || !fs.existsSync(sessionPath)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
    return data.profile || null;
  } catch {
    return null;
  }
}

function clearSessionProfile() {
  const sessionPath = getSessionFilePath();
  if (sessionPath && fs.existsSync(sessionPath)) {
    fs.unlinkSync(sessionPath);
  }
}

function cleanStaleSessions() {
  // Remove session files older than 7 days
  const dir = path.join(getAtrisDir(), 'sessions');
  if (!fs.existsSync(dir)) return;
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  try {
    for (const f of fs.readdirSync(dir)) {
      const fp = path.join(dir, f);
      try {
        const stat = fs.statSync(fp);
        if (stat.mtimeMs < cutoff) fs.unlinkSync(fp);
      } catch {}
    }
  } catch {}
}

function getProfilesDir() {
  const dir = path.join(getAtrisDir(), 'profiles');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function profileNameFromEmail(email) {
  if (!email) return null;
  // "keshav@atrislabs.com" → "keshav"
  const name = email.split('@')[0].toLowerCase().replace(/[^a-z0-9_-]/g, '-');
  return name || null; // Guard against emails like "@domain.com"
}

function saveProfile(name, credentials) {
  const profilePath = path.join(getProfilesDir(), `${name}.json`);
  fs.writeFileSync(profilePath, JSON.stringify(credentials, null, 2));
  try { fs.chmodSync(profilePath, 0o600); } catch {}
}

function loadProfile(name) {
  const profilePath = path.join(getProfilesDir(), `${name}.json`);
  if (!fs.existsSync(profilePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(profilePath, 'utf8'));
  } catch {
    return null;
  }
}

function listProfiles() {
  const dir = getProfilesDir();
  try {
    return fs.readdirSync(dir)
      .filter(f => f.endsWith('.json'))
      .map(f => f.replace('.json', ''));
  } catch {
    return [];
  }
}

function deleteProfile(name) {
  const profilePath = path.join(getProfilesDir(), `${name}.json`);
  if (fs.existsSync(profilePath)) {
    fs.unlinkSync(profilePath);
    return true;
  }
  return false;
}

function autoSaveProfile(credentials) {
  const name = profileNameFromEmail(credentials?.email);
  if (name) {
    saveProfile(name, credentials);
  }
}

function saveCredentials(token, refreshToken, email, userId, provider) {
  const credentialsPath = getCredentialsPath();
  const credentials = {
    token,
    refresh_token: refreshToken || null,
    email: email || null,
    user_id: userId || null,
    provider: provider || null,
    saved_at: new Date().toISOString()
  };

  fs.writeFileSync(credentialsPath, JSON.stringify(credentials, null, 2));
  try {
    fs.chmodSync(credentialsPath, 0o600);
  } catch {
    // Best effort: permissions may be unsupported on this platform.
  }

  // Auto-save as named profile
  autoSaveProfile(credentials);
}

function loadCredentials() {
  // Priority: ATRIS_TOKEN env var → ATRIS_PROFILE env var → per-terminal session file → global credentials.json

  // 0. Raw token injection. Headless boxes (cloud business computers) have no
  //    browser for `atris login`; the runner injects a scoped token as env
  //    instead, so no credentials file ever lands on disk.
  const envToken = process.env.ATRIS_TOKEN;
  if (envToken && envToken.trim()) {
    return { token: envToken.trim(), provider: null, source: 'env' };
  }

  // 1. Explicit env var override
  const profileOverride = process.env.ATRIS_PROFILE;
  if (profileOverride) {
    const profile = loadProfile(profileOverride);
    if (profile) return profile;
    const profiles = listProfiles();
    const q = profileOverride.toLowerCase();
    const match = profiles.find(p => p.toLowerCase() === q)
      || profiles.find(p => p.toLowerCase().startsWith(q))
      || profiles.find(p => p.toLowerCase().includes(q));
    if (match) {
      const matched = loadProfile(match);
      if (matched) return matched;
    }
  }

  // 2. Per-terminal session override (set by atris switch)
  const sessionProfile = getSessionProfile();
  if (sessionProfile) {
    const profile = loadProfile(sessionProfile);
    if (profile) return profile;
  }

  // 3. Global credentials.json
  const credentialsPath = getCredentialsPath();

  if (!fs.existsSync(credentialsPath)) {
    return null;
  }

  try {
    const data = fs.readFileSync(credentialsPath, 'utf8');
    const parsed = JSON.parse(data);
    if (!parsed.provider) {
      parsed.provider = null;
    }
    if (!parsed.saved_at && parsed.created_at) {
      parsed.saved_at = parsed.created_at;
    }
    return parsed;
  } catch (error) {
    return null;
  }
}

function deleteCredentials() {
  const credentialsPath = getCredentialsPath();

  if (fs.existsSync(credentialsPath)) {
    fs.unlinkSync(credentialsPath);
  }
}

// Token validation and refresh
async function validateAccessToken(token, apiRequestJson) {
  if (!token) {
    return { ok: false, status: 0, error: 'Missing token' };
  }
  return apiRequestJson('/auth/validate', {
    method: 'POST',
    body: { token },
    token,
  });
}

async function refreshAccessToken(refreshToken, provider, apiRequestJson) {
  if (!refreshToken) {
    return { ok: false, status: 0, error: 'Missing refresh token' };
  }
  const body = { refresh_token: refreshToken };
  if (provider) {
    body.provider = provider;
  }
  return apiRequestJson('/auth/refresh', {
    method: 'POST',
    body,
  });
}

async function performTokenRefresh(credentials, apiRequestJson) {
  if (!credentials || !credentials.refresh_token) {
    return { ok: false, error: 'missing_refresh_token' };
  }

  const refreshed = await refreshAccessToken(credentials.refresh_token, credentials.provider, apiRequestJson);
  if (!refreshed.ok) {
    return { ok: false, error: refreshed.error || 'Refresh request failed' };
  }

  const accessToken = refreshed.data?.access_token;
  if (!accessToken) {
    return { ok: false, error: 'No access token returned by refresh API' };
  }

  const newRefreshToken = refreshed.data?.refresh_token || credentials.refresh_token;
  const refreshUser = refreshed.data?.user || null;
  const provider = refreshed.data?.provider || credentials.provider;
  const email = refreshUser?.email || credentials.email;
  const userId = refreshUser?.id || credentials.user_id;

  saveCredentials(accessToken, newRefreshToken, email, userId, provider);
  let latestCreds = loadCredentials();

  const validation = await validateAccessToken(accessToken, apiRequestJson);
  let finalUser = refreshUser;

  if (validation.ok && validation.data?.valid) {
    finalUser = validation.data.user || refreshUser || null;
    const updatedEmail = finalUser?.email || latestCreds?.email || email;
    const updatedProvider = finalUser?.provider || latestCreds?.provider || provider;
    const updatedUserId = finalUser?.id || latestCreds?.user_id || userId;

    if (
      !latestCreds ||
      updatedEmail !== latestCreds.email ||
      updatedProvider !== latestCreds.provider ||
      updatedUserId !== latestCreds.user_id
    ) {
      saveCredentials(accessToken, newRefreshToken, updatedEmail, updatedUserId, updatedProvider);
      latestCreds = loadCredentials();
    }
  }

  return {
    ok: true,
    payload: {
      credentials: latestCreds || loadCredentials(),
      user: finalUser,
      source: 'refreshed',
    },
  };
}

async function ensureValidCredentials(apiRequestJson, options = {}) {
  let credentials = loadCredentials();
  if (!credentials || !credentials.token) {
    return { error: 'not_logged_in' };
  }

  if (credentials.refresh_token && shouldRefreshToken(credentials.token)) {
    const proactive = await performTokenRefresh(credentials, apiRequestJson);
    if (proactive.ok) {
      return proactive.payload;
    }
    credentials = loadCredentials() || credentials;
  }

  const validation = await validateAccessToken(credentials.token, apiRequestJson);
  if (validation.ok && validation.data?.valid) {
    const user = validation.data.user || null;
    const updatedEmail = user?.email || credentials.email;
    const updatedProvider = user?.provider || credentials.provider;
    const updatedUserId = user?.id || credentials.user_id;

    if (
      credentials.source !== 'env' &&
      (updatedEmail !== credentials.email ||
        updatedProvider !== credentials.provider ||
        updatedUserId !== credentials.user_id)
    ) {
      saveCredentials(
        credentials.token,
        credentials.refresh_token,
        updatedEmail,
        updatedUserId,
        updatedProvider
      );
    }

    return {
      credentials: loadCredentials(),
      user,
      source: 'access_token',
    };
  }

  if (!credentials.refresh_token) {
    return { error: 'token_invalid', detail: validation.error || 'Token expired' };
  }

  const refreshed = await performTokenRefresh(credentials, apiRequestJson);
  if (!refreshed.ok) {
    return { error: 'refresh_failed', detail: refreshed.error };
  }

  return refreshed.payload;
}

async function fetchMyAgents(token, apiRequestJson) {
  if (!token) {
    return null;
  }

  const response = await apiRequestJson('/agent/my-agents', {
    method: 'GET',
    token,
  });

  if (!response.ok) {
    if (response.status === 404) {
      return null;
    }
    throw new Error(response.error || 'Failed to fetch agents');
  }

  return response.data;
}

async function displayAccountSummary(apiRequestJson) {
  const ensured = await ensureValidCredentials(apiRequestJson);

  if (ensured.error) {
    console.log('Status: Not logged in');
    if (ensured.detail) {
      console.log(`Reason: ${ensured.detail}`);
    }
    return { error: ensured.error, detail: ensured.detail };
  }

  const { credentials, user } = ensured;
  const email = user?.email || credentials?.email || 'unknown';
  const userId = user?.id || credentials?.user_id || 'unknown';
  const provider = user?.provider || credentials?.provider || 'unknown';
  const savedAt = credentials?.saved_at || 'unknown';

  console.log('Status: Logged in ✓');
  console.log(`Email: ${email}`);
  console.log(`User ID: ${userId}`);
  console.log(`Provider: ${provider}`);
  console.log(`Credentials saved: ${savedAt}`);
  console.log(`Credential file: ${getCredentialsPath()}`);

  try {
    const agentsResponse = await fetchMyAgents(credentials.token, apiRequestJson);
    if (agentsResponse && agentsResponse.my_agents) {
      const agents = agentsResponse.my_agents;
      const total = agentsResponse.total ?? agents.length;
      console.log(`Agents: ${total}`);
      agents.slice(0, 5).forEach((agent) => {
        const name = agent.name || agent.id || 'Unnamed agent';
        console.log(`  • ${name}`);
      });
      if (total > 5) {
        console.log(`  …and ${total - 5} more`);
      }
    }
  } catch (error) {
    console.log(`Agents: Unable to load (${error.message})`);
  }

  return { credentials, user };
}

module.exports = {
  decodeJwtClaims,
  getTokenExpiryEpochSeconds,
  shouldRefreshToken,
  getCredentialsPath,
  saveCredentials,
  loadCredentials,
  deleteCredentials,
  openBrowser,
  promptUser,
  validateAccessToken,
  refreshAccessToken,
  performTokenRefresh,
  ensureValidCredentials,
  fetchMyAgents,
  displayAccountSummary,
  // Profile switching
  saveProfile,
  loadProfile,
  listProfiles,
  deleteProfile,
  profileNameFromEmail,
  autoSaveProfile,
  // Per-terminal sessions
  getTerminalSessionId,
  getSessionsDir,
  setSessionProfile,
  getSessionProfile,
  clearSessionProfile,
  cleanStaleSessions,
};
