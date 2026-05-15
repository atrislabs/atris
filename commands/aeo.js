/**
 * atris aeo — AI Engine Optimization commands
 *
 *   atris aeo init                          # create entity-graph skeleton in workspace
 *   atris aeo draft "<topic>" [opts]        # generate citation-optimized article (credit-metered)
 *
 * Hits the backend endpoints registered under:
 *   POST /api/business/{id}/workspaces/{ws}/aeo/init
 *   POST /api/business/{id}/workspaces/{ws}/aeo/draft
 *
 * Business resolution mirrors `atris terminal`: explicit --workspace slug,
 * else cwd .atris/business.json. The endpoint itself takes care of running
 * Claude Sonnet 4.6 with the 10 AEO rules and writing to /workspace/atris/aeo/drafts/.
 */

const fs = require('fs');
const path = require('path');
const { loadCredentials } = require('../utils/auth');
const { apiRequestJson } = require('../utils/api');
const { loadBusinesses, saveBusinesses } = require('./business');

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function ensureAwake(token, businessId, maxWaitSec = 90) {
  const status = await apiRequestJson(`/business/${businessId}/ai-computer/status`, { method: 'GET', token });
  if (status.ok && status.data && status.data.status === 'running' && status.data.endpoint) return true;
  process.stdout.write('  Waking EC2 computer... ');
  await apiRequestJson(`/business/${businessId}/ai-computer/wake`, { method: 'POST', token });
  const start = Date.now();
  while (Date.now() - start < maxWaitSec * 1000) {
    await sleep(3000);
    const s = await apiRequestJson(`/business/${businessId}/ai-computer/status`, { method: 'GET', token });
    if (s.ok && s.data && s.data.status === 'running' && s.data.endpoint) {
      console.log(`awake (${Math.floor((Date.now() - start) / 1000)}s)`);
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

function pickSlug(args) {
  const wsIdx = args.findIndex((a) => a === '--workspace' || a === '-w');
  if (wsIdx !== -1 && args[wsIdx + 1]) {
    const slug = args[wsIdx + 1];
    args.splice(wsIdx, 2);
    return slug;
  }
  const bizFile = path.join(process.cwd(), '.atris', 'business.json');
  if (fs.existsSync(bizFile)) {
    try { return JSON.parse(fs.readFileSync(bizFile, 'utf8')).slug; } catch { /* ignore */ }
  }
  return null;
}

function printHelp() {
  console.log('Usage:');
  console.log('  atris aeo init [--workspace <slug>]');
  console.log('  atris aeo draft "<topic>" [--workspace <slug>] [--queries q1,q2] [--slug X] [--url URL]');
  console.log('');
  console.log('Examples:');
  console.log('  atris aeo init');
  console.log('  atris aeo draft "what is acme" --queries "what is acme,best freight platform"');
  console.log('  atris aeo draft "how does atris work" --workspace doordash --slug atris-overview');
}

async function aeoInit(args) {
  const slug = pickSlug(args);
  if (!slug) {
    console.error('Cannot determine business. Pass --workspace <slug> or run from a workspace.');
    process.exit(1);
  }
  const creds = loadCredentials();
  if (!creds || !creds.token) { console.error('Not logged in. Run: atris login'); process.exit(1); }

  const biz = await resolveBusiness(creds.token, slug);
  if (!biz) { console.error(`Business "${slug}" not found.`); process.exit(1); }
  if (!biz.workspaceId) { console.error(`Business "${slug}" has no workspace.`); process.exit(1); }

  const awake = await ensureAwake(creds.token, biz.businessId);
  if (!awake) { console.error('  EC2 computer did not become ready in time.'); process.exit(1); }

  const result = await apiRequestJson(
    `/business/${biz.businessId}/workspaces/${biz.workspaceId}/aeo/init`,
    { method: 'POST', token: creds.token, body: {}, timeoutMs: 60000 }
  );
  if (!result.ok) {
    console.error(`✗ aeo init failed: ${result.errorMessage || result.error || result.status}`);
    process.exit(1);
  }
  const data = result.data || {};
  const created = data.created || [];
  const skipped = data.skipped || [];
  console.log(`✓ AEO entity graph @ ${data.dir}`);
  if (created.length) console.log(`  created: ${created.map((p) => p.split('/').pop()).join(', ')}`);
  if (skipped.length) console.log(`  existed: ${skipped.map((p) => p.split('/').pop()).join(', ')}`);
}

async function aeoDraft(args) {
  // Pull --slug, --url, --queries, --workspace; remainder is the topic.
  const opts = {};
  for (const k of ['slug', 'url', 'queries']) {
    const i = args.findIndex((a) => a === `--${k}`);
    if (i !== -1 && args[i + 1]) {
      opts[k] = args[i + 1];
      args.splice(i, 2);
    }
  }
  const slug = pickSlug(args);
  const topic = args.join(' ').trim();
  if (!topic) {
    console.error('Missing topic. Usage: atris aeo draft "<topic>"');
    process.exit(1);
  }
  if (!slug) {
    console.error('Cannot determine business. Pass --workspace <slug> or run from a workspace.');
    process.exit(1);
  }
  const creds = loadCredentials();
  if (!creds || !creds.token) { console.error('Not logged in. Run: atris login'); process.exit(1); }

  const biz = await resolveBusiness(creds.token, slug);
  if (!biz) { console.error(`Business "${slug}" not found.`); process.exit(1); }
  if (!biz.workspaceId) { console.error(`Business "${slug}" has no workspace.`); process.exit(1); }

  const awake = await ensureAwake(creds.token, biz.businessId);
  if (!awake) { console.error('  EC2 computer did not become ready in time.'); process.exit(1); }

  const body = { topic };
  if (opts.slug) body.slug = opts.slug;
  if (opts.url) body.target_url = opts.url;
  if (opts.queries) body.target_queries = opts.queries.split(',').map((s) => s.trim()).filter(Boolean);

  process.stdout.write(`Drafting "${topic}" for ${biz.businessName}... `);
  const t0 = Date.now();
  const result = await apiRequestJson(
    `/business/${biz.businessId}/workspaces/${biz.workspaceId}/aeo/draft`,
    { method: 'POST', token: creds.token, body, timeoutMs: 180000 }
  );
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  if (!result.ok) {
    console.log('failed');
    console.error(`✗ aeo draft failed (${result.status}): ${result.errorMessage || result.error}`);
    process.exit(1);
  }
  const data = result.data || {};
  console.log(`done (${elapsed}s)`);
  console.log('');
  console.log(`  path:           ${data.path}`);
  console.log(`  self-score:     ${data.self_score ?? '?'}/10`);
  console.log(`  credits:        ${data.credits_charged ?? '?'}`);
  console.log(`  tokens:         in=${data.tokens?.input ?? '?'} out=${data.tokens?.output ?? '?'}`);
  console.log(`  entity graph:   entities=${data.entity_graph?.has_entities ? 'y' : 'n'} defs=${data.entity_graph?.has_definitions ? 'y' : 'n'} stats=${data.entity_graph?.has_stats ? 'y' : 'n'}`);
  if (data.overlay_active) console.log(`  overlay:        active (${data.overlay_lines} lines)`);
  if (data.hint) console.log(`  hint:           ${data.hint}`);
}

async function run(args = []) {
  const sub = args[0];
  if (!sub || sub === 'help' || sub === '--help' || sub === '-h') return printHelp();
  const rest = args.slice(1);
  if (sub === 'init') return aeoInit(rest);
  if (sub === 'draft') return aeoDraft(rest);
  console.error(`Unknown aeo subcommand: ${sub}`);
  printHelp();
  process.exit(1);
}

module.exports = { run };
