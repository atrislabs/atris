'use strict';

// The one Claude login a sealed build may use. A sealed build hides the real
// home, and the normal Claude login lives in the macOS keychain and refreshes
// itself, so a build cannot borrow it. `atris idea login` runs Claude's own
// `claude setup-token` (a long-lived login on the same subscription), keeps the
// token in a file only the owner can read, and the sealed build passes it in.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { atrisHome } = require('./state-home');

const TOKEN_PATTERN = /sk-ant-oat\d{2}-[A-Za-z0-9_-]{20,}/g;

function tokenFile(env = process.env) {
  return path.join(atrisHome(env), 'secrets', 'claude-oauth-token');
}

// The token from a recording of `claude setup-token`, colors and cursor moves
// stripped. The last one wins, since the screen may redraw.
function findToken(text) {
  const plain = String(text || '').replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b[\]P][^\x07\x1b]*(\x07|\x1b\\)/g, '');
  const hits = plain.match(TOKEN_PATTERN);
  return hits ? hits[hits.length - 1] : '';
}

function savedToken(env = process.env) {
  try {
    return fs.readFileSync(tokenFile(env), 'utf8').trim();
  } catch {
    return '';
  }
}

function saveToken(token, env = process.env) {
  const file = tokenFile(env);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.dirname(file), 0o700);
  fs.writeFileSync(file, `${token}\n`, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return file;
}

function forgetToken(env = process.env) {
  const file = tokenFile(env);
  if (!fs.existsSync(file)) return false;
  fs.rmSync(file, { force: true });
  return true;
}

// Runs `claude setup-token` on the person's own terminal while `script`
// records what it prints, then reads the recording and deletes it.
function recordSetupToken({ spawn = spawnSync, platform = process.platform } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-login-'));
  fs.chmodSync(dir, 0o700);
  const log = path.join(dir, 'screen');
  try {
    const args = platform === 'darwin'
      ? ['-q', log, 'claude', 'setup-token']
      : ['-q', '-c', 'claude setup-token', log];
    const result = spawn('script', args, { stdio: 'inherit' });
    const text = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
    return { status: result.status, text };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// When the token cannot be read off the screen, the person pastes it once,
// without it showing on screen.
function askToken({ spawn = spawnSync } = {}) {
  const script = 'printf "paste the token claude printed (it stays hidden): " >&2; stty -echo; read -r t; stty echo; printf "\\n" >&2; printf %s "$t"';
  const result = spawn('sh', ['-c', script], { stdio: ['inherit', 'pipe', 'inherit'], encoding: 'utf8' });
  return String(result.stdout || '').trim();
}

// Signs in the way a sealed build does: a blank home, no keychain, only the
// token. Returns { ok, detail }.
function checkToken(token, { spawn = spawnSync } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-login-check-'));
  try {
    const result = spawn('claude', ['-p', 'Reply with the single word ok.', '--model', 'haiku',
      '--settings', JSON.stringify({ disableAllHooks: true }), '--strict-mcp-config', '--tools', ''], {
      cwd: home,
      encoding: 'utf8',
      timeout: 120000,
      env: {
        PATH: process.env.PATH || '',
        HOME: home,
        CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
        CLAUDE_CODE_OAUTH_TOKEN: token,
        ANTHROPIC_API_KEY: '',
      },
    });
    const out = `${result.stdout || ''}${result.stderr || ''}`.trim();
    const ok = result.status === 0 && /\bok\b/i.test(result.stdout || '');
    return { ok, detail: ok ? '' : (out.split('\n').pop() || `exit ${result.status}`).slice(0, 200) };
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

module.exports = { findToken, savedToken, saveToken, forgetToken, recordSetupToken, askToken, checkToken };
