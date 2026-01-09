const os = require('os');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');
const readline = require('readline');

function openBrowser(url) {
  const platform = os.platform();
  let command;

  if (platform === 'darwin') {
    command = `open "${url}"`;
  } else if (platform === 'win32') {
    command = `start "${url}"`;
  } else {
    command = `xdg-open "${url}"`;
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

// JWT helpers
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

function getTokenExpiryEpochSeconds(token) {
  const claims = decodeJwtClaims(token);
  if (!claims || typeof claims.exp !== 'number') {
    return null;
  }
  return claims.exp;
}

function shouldRefreshToken(token, bufferSeconds = TOKEN_REFRESH_BUFFER_SECONDS) {
  const exp = getTokenExpiryEpochSeconds(token);
  if (!exp) {
    return false;
  }
  const nowSeconds = Math.floor(Date.now() / 1000);
  return exp <= nowSeconds + bufferSeconds;
}

// Credentials management
function getCredentialsPath() {
  const homeDir = os.homedir();
  const atrisDir = path.join(homeDir, '.atris');

  if (!fs.existsSync(atrisDir)) {
    fs.mkdirSync(atrisDir, { recursive: true });
  }

  return path.join(atrisDir, 'credentials.json');
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
}

function loadCredentials() {
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
      updatedEmail !== credentials.email ||
      updatedProvider !== credentials.provider ||
      updatedUserId !== credentials.user_id
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
};
