/**
 * atris terminal <business> <command...> [--timeout N]
 *
 * Run a shell command directly on a business EC2 workspace via the warm runner.
 * This is the load-bearing primitive for fast bulk ops — one bash call beats
 * hundreds of rate-limited individual file API calls.
 *
 * SAFETY:
 * - Auto-wakes the EC2 computer (the rule: never operate on cache)
 * - Refuses commands longer than 10000 chars (matches backend limit)
 * - Caps timeout at 120s (matches backend limit)
 * - Prints stdout, stderr, and exit_code so the caller knows what happened
 *
 * USAGE:
 *   atris terminal acme "ls /workspace/atris/"
 *   atris terminal acme "find /workspace -name '*.md' | wc -l" --timeout 60
 *   atris terminal "rm -rf /workspace/cruft"   # auto-detects business from .atris/business.json
 *
 * Discovered the /terminal endpoint during overnight workspace cleanup - bulk
 * deleting 401 files via individual /file DELETE calls hit the rate limit
 * after request 60 and would have taken hours. One `rm -rf` via /terminal
 * finished in 1 second.
 */

const fs = require('fs');
const path = require('path');
const { loadCredentials } = require('../utils/auth');
const { apiRequestJson } = require('../utils/api');
const { loadBusinesses, saveBusinesses } = require('./business');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function ensureAwake(token, businessId, maxWaitSec = 90) {
  const status = await apiRequestJson(`/business/${businessId}/ai-computer/status`, { method: 'GET', token });
  if (status.ok && status.data && status.data.status === 'running' && status.data.endpoint) {
    return true;
  }
  process.stdout.write('  Waking EC2 computer... ');
  await apiRequestJson(`/business/${businessId}/ai-computer/wake`, { method: 'POST', token });
  const start = Date.now();
  while (Date.now() - start < maxWaitSec * 1000) {
    await sleep(3000);
    const s = await apiRequestJson(`/business/${businessId}/ai-computer/status`, { method: 'GET', token });
    if (s.ok && s.data && s.data.status === 'running' && s.data.endpoint) {
      const elapsed = Math.floor((Date.now() - start) / 1000);
      console.log(`awake (${elapsed}s)`);
      return true;
    }
  }
  console.log('timeout');
  return false;
}

async function resolveBusiness(token, slug) {
  const businesses = loadBusinesses();
  const list = await apiRequestJson('/business/', { method: 'GET', token });
  if (list.ok) {
    const match = (list.data || []).find(
      (b) => b.slug === slug || b.name.toLowerCase() === slug.toLowerCase()
    );
    if (!match) return null;
    businesses[slug] = {
      business_id: match.id,
      workspace_id: match.workspace_id,
      name: match.name,
      slug: match.slug,
      added_at: new Date().toISOString(),
    };
    saveBusinesses(businesses);
    return { businessId: match.id, workspaceId: match.workspace_id, businessName: match.name };
  }
  if (businesses[slug]) {
    return {
      businessId: businesses[slug].business_id,
      workspaceId: businesses[slug].workspace_id,
      businessName: businesses[slug].name || slug,
    };
  }
  return null;
}

async function terminalAtris() {
  // Parse args. Three forms:
  //   atris terminal <business> <command...>
  //   atris terminal <command...>          (auto-detect business)
  //   atris terminal --help
  const args = process.argv.slice(3);

  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    console.log('Usage: atris terminal [business] <command> [--timeout N]');
    console.log('');
    console.log('  atris terminal acme "ls /workspace/atris/"');
    console.log('  atris terminal "find /workspace -name \\"*.md\\""    # auto-detect business');
    console.log('  atris terminal acme "rm -rf /workspace/cruft" --timeout 30');
    console.log('');
    console.log('  --timeout N    seconds to wait for the command (default 30, max 120)');
    process.exit(0);
  }

  // Parse --timeout
  let timeoutSec = 30;
  const tIdx = args.indexOf('--timeout');
  if (tIdx !== -1 && args[tIdx + 1]) {
    const parsed = parseInt(args[tIdx + 1], 10);
    if (!isNaN(parsed)) timeoutSec = Math.min(120, Math.max(1, parsed));
    args.splice(tIdx, 2);
  }

  // Try to detect: if the first arg looks like a known slug (no quotes, no spaces),
  // treat it as the business and the rest as the command.
  // Otherwise auto-detect from .atris/business.json.
  let slug = null;
  let command = null;

  const bizFile = path.join(process.cwd(), '.atris', 'business.json');
  const cwdSlug = (() => {
    if (!fs.existsSync(bizFile)) return null;
    try { return JSON.parse(fs.readFileSync(bizFile, 'utf8')).slug; } catch { return null; }
  })();

  // If first arg is a single word with no shell metacharacters, it might be a slug
  const firstLooksLikeSlug = args[0] && /^[a-z0-9-]+$/i.test(args[0]) && !args[0].includes(' ');

  if (firstLooksLikeSlug && args.length > 1) {
    slug = args[0];
    command = args.slice(1).join(' ');
  } else if (cwdSlug) {
    slug = cwdSlug;
    command = args.join(' ');
  } else if (firstLooksLikeSlug && args.length === 1) {
    // First (and only) arg is a slug-shaped word — could be the slug with no command
    console.error('Missing command. Usage: atris terminal <business> <command>');
    process.exit(1);
  } else {
    console.error('Cannot determine business. Run from inside a workspace, or pass slug as first arg.');
    process.exit(1);
  }

  if (!command || command.length === 0) {
    console.error('Missing command. Usage: atris terminal <business> <command>');
    process.exit(1);
  }
  if (command.length > 10000) {
    console.error(`Command too long (${command.length} chars, max 10000)`);
    process.exit(1);
  }

  const creds = loadCredentials();
  if (!creds || !creds.token) { console.error('Not logged in. Run: atris login'); process.exit(1); }

  const biz = await resolveBusiness(creds.token, slug);
  if (!biz) { console.error(`Business "${slug}" not found.`); process.exit(1); }
  if (!biz.workspaceId) { console.error(`Business "${slug}" has no workspace.`); process.exit(1); }

  // Auto-wake (the rule)
  const awake = await ensureAwake(creds.token, biz.businessId);
  if (!awake) {
    console.error('  EC2 computer did not become ready in time. Aborting.');
    process.exit(1);
  }

  // Execute the command
  const result = await apiRequestJson(
    `/business/${biz.businessId}/workspaces/${biz.workspaceId}/terminal`,
    {
      method: 'POST',
      token: creds.token,
      body: { command, timeout: timeoutSec },
      timeoutMs: (timeoutSec + 10) * 1000,
    }
  );

  if (!result.ok) {
    console.error(`\n✗ Terminal call failed: ${result.errorMessage || result.error || result.status}`);
    process.exit(1);
  }

  const body = result.data || {};
  const stdout = body.stdout || '';
  const stderr = body.stderr || '';
  const exitCode = body.exit_code !== undefined ? body.exit_code : '?';
  const timedOut = body.timed_out === true;

  if (stdout) process.stdout.write(stdout);
  if (stderr) {
    if (stdout && !stdout.endsWith('\n')) process.stdout.write('\n');
    process.stderr.write(stderr);
    if (!stderr.endsWith('\n')) process.stderr.write('\n');
  }

  if (timedOut) {
    console.error(`\n[timed out after ${timeoutSec}s]`);
  }

  // Exit with the same code as the remote command (so shell pipelines work)
  process.exit(typeof exitCode === 'number' ? exitCode : 0);
}

module.exports = { terminalAtris };
