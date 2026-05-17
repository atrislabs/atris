/**
 * atris aeo — AI Engine Optimization commands
 *
 * Backend-routed (require EC2):
 *   atris aeo init                          # create entity-graph skeleton
 *   atris aeo draft "<topic>" [opts]        # generate citation-optimized article
 *
 * Local-read against ~/arena/atrisos-backend/atris/features/aeo/proof/:
 *   atris aeo log [--engine X] [--limit N]  # citation attempt log
 *   atris aeo status                        # engine + proof + buyer summary
 *   atris aeo packet <slug>                 # buyer packet for a surface
 *   atris aeo proofs [--filter X]           # list proof receipt categories
 *
 * Shell out to atrisos-backend/scripts/aeo_*.py:
 *   atris aeo discover <source> [...]       # discovery audit
 *   atris aeo audit <source> [...]          # agent-usability audit
 *
 * Backend root resolution: $ATRIS_BACKEND_ROOT or ~/arena/atrisos-backend.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { loadCredentials } = require('../utils/auth');
const { apiRequestJson } = require('../utils/api');
const { loadBusinesses, saveBusinesses } = require('./business');

function resolveBackendRoot() {
  const candidates = [
    process.env.ATRIS_BACKEND_ROOT,
    path.join(os.homedir(), 'arena', 'atrisos-backend'),
  ].filter(Boolean);
  for (const root of candidates) {
    if (fs.existsSync(path.join(root, 'atris', 'features', 'aeo'))) return root;
  }
  return null;
}

function requireBackendRoot() {
  const root = resolveBackendRoot();
  if (!root) {
    console.error('Cannot find atrisos-backend. Set $ATRIS_BACKEND_ROOT or clone to ~/arena/atrisos-backend.');
    process.exit(1);
  }
  return root;
}

function readJsonSafe(p) {
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (err) {
    console.error(`  warning: malformed JSON at ${p} (${err.message})`);
    return null;
  }
}

function pad(s, n) { s = String(s); return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length); }

function assertNoExtras(sub, args, allowedFlags) {
  const allowed = new Set(allowedFlags);
  const unknownFlags = args.filter((a) => a.startsWith('--') && !allowed.has(a));
  const positional = args.filter((a) => !a.startsWith('--'));
  if (unknownFlags.length) {
    console.error(`Unknown flag for aeo ${sub}: ${unknownFlags.join(' ')}. Supported: ${[...allowed].join(' ') || '(none)'}`);
    process.exit(1);
  }
  if (positional.length) {
    console.error(`Unexpected argument for aeo ${sub}: ${positional.join(' ')}`);
    process.exit(1);
  }
}

function readArg(args, ...keys) {
  for (const k of keys) {
    const eqIdx = args.findIndex((a) => a.startsWith(`${k}=`));
    if (eqIdx !== -1) {
      const v = args[eqIdx].slice(k.length + 1);
      args.splice(eqIdx, 1);
      return v;
    }
    const i = args.findIndex((a) => a === k);
    if (i === -1) continue;
    const v = args[i + 1];
    if (v === undefined || v.startsWith('--')) {
      console.error(`Flag ${k} requires a value.`);
      process.exit(1);
    }
    args.splice(i, 2);
    return v;
  }
  return null;
}

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
  console.log('  Backend / EC2:');
  console.log('    atris aeo init   [--workspace <slug>]');
  console.log('    atris aeo draft  "<topic>" [--workspace <slug>] [--queries q1,q2] [--slug X] [--url URL]');
  console.log('');
  console.log('  Local read (atris/features/aeo/proof/):');
  console.log('    atris aeo log    [--engine X] [--limit N] [--json]');
  console.log('    atris aeo status [--json]');
  console.log('    atris aeo packet <slug> [--json]');
  console.log('    atris aeo proofs [--filter X]');
  console.log('');
  console.log('  Script wrappers (scripts/aeo_*.py):');
  console.log('    atris aeo discover <source> [--question Q ...] [--canonical-url URL] [--out-dir DIR]');
  console.log('    atris aeo audit    <source> [--baseline B] [--canonical-url URL] [--out-dir DIR]');
  console.log('');
  console.log('Examples:');
  console.log('  atris aeo log --engine perplexity --limit 5');
  console.log('  atris aeo packet pallet');
  console.log('  atris aeo status');
  console.log('  atris aeo discover https://atris.ai/aeo --canonical-url https://atris.ai/aeo');
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

// ---------- LOCAL READ SUBCOMMANDS ----------

function loadCitationAttempts(root) {
  const dir = path.join(root, 'atris', 'features', 'aeo', 'proof', 'live-citation-attempts');
  if (!fs.existsSync(dir)) return [];
  const rows = [];
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.json')) continue;
    const data = readJsonSafe(path.join(dir, file));
    if (!data || !Array.isArray(data.attempts)) continue;
    for (const attempt of data.attempts) {
      if (!attempt || typeof attempt !== 'object') continue;
      const cited = attempt.answer_cites_target_url === true;
      const mentioned = attempt.answer_mentions_target_entity === true;
      let status;
      if (cited) status = 'verified';
      else if (mentioned) status = 'pending';
      else status = 'failed';
      const str = (v) => (typeof v === 'string' ? v : '');
      const arr = (v) => (Array.isArray(v) ? v : []);
      rows.push({
        file,
        attempted_at: str(data.attempted_at),
        engine: str(data.engine),
        prompt_id: str(attempt.prompt_id),
        prompt: str(attempt.exact_prompt),
        target_entity: str(data.target_entity),
        target_urls: arr(data.target_url_candidates),
        answer_evidence_uri: str(attempt.answer_evidence_uri),
        status,
        competitors: arr(attempt.observed_competitor_or_alternative_entities),
      });
    }
  }
  rows.sort((a, b) => (b.attempted_at || '').localeCompare(a.attempted_at || ''));
  return rows;
}

async function aeoLog(args) {
  const engine = readArg(args, '--engine', '-e');
  const limitRaw = readArg(args, '--limit', '-n');
  assertNoExtras('log', args, ['--json']);
  const wantJson = args.includes('--json');
  let limit = 20;
  if (limitRaw != null) {
    const trimmed = String(limitRaw).trim();
    const parsed = parseInt(trimmed, 10);
    if (!/^[+-]?\d+$/.test(trimmed) || !Number.isFinite(parsed) || parsed < 1) {
      console.error(`Invalid --limit value: "${limitRaw}". Expected a positive integer.`);
      process.exit(1);
    }
    limit = parsed;
  }
  const root = requireBackendRoot();
  let rows = loadCitationAttempts(root);
  if (engine) rows = rows.filter((r) => r.engine.toLowerCase() === engine.toLowerCase());
  rows = rows.slice(0, limit);

  if (wantJson) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }

  if (!rows.length) {
    console.log('No citation attempts found.');
    return;
  }

  const counts = rows.reduce((acc, r) => { acc[r.status] = (acc[r.status] || 0) + 1; return acc; }, {});
  console.log(`AEO citation log (${rows.length} attempt${rows.length === 1 ? '' : 's'})`);
  console.log(`  ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join('  ')}`);
  console.log('');
  console.log(`  ${pad('ts', 22)}${pad('engine', 12)}${pad('prompt_id', 26)}${pad('status', 10)}`);
  console.log(`  ${'-'.repeat(70)}`);
  for (const r of rows) {
    console.log(`  ${pad(r.attempted_at.slice(0, 19), 22)}${pad(r.engine, 12)}${pad(r.prompt_id, 26)}${pad(r.status, 10)}`);
  }
}

async function aeoStatus(args) {
  assertNoExtras('status', args, ['--json']);
  const wantJson = args.includes('--json');
  const root = requireBackendRoot();
  const proofRoot = path.join(root, 'atris', 'features', 'aeo', 'proof');

  const attempts = loadCitationAttempts(root);
  const enginesSeen = new Set(attempts.map((a) => a.engine).filter(Boolean));
  const verified = attempts.filter((a) => a.status === 'verified').length;
  const pending = attempts.filter((a) => a.status === 'pending').length;
  const failed = attempts.filter((a) => a.status === 'failed').length;

  const packets = [];
  if (fs.existsSync(proofRoot)) {
    for (const entry of fs.readdirSync(proofRoot)) {
      if (!entry.endsWith('-buyer-packet')) continue;
      const p = path.join(proofRoot, entry, 'packet.json');
      const data = readJsonSafe(p);
      if (!data) continue;
      packets.push({
        slug: entry.replace(/-buyer-packet$/, ''),
        surface: data.surface || entry,
        target_url: data.target_url || '',
        baseline: data?.agent_usability?.baseline_score ?? null,
        proposed: data?.agent_usability?.proposed_score ?? null,
        claim_status: data.claim_status || '',
      });
    }
  }

  const operator = readJsonSafe(path.join(proofRoot, 'live-citation-operator', 'live-citation-operator.json'));

  const proofDirs = fs.existsSync(proofRoot)
    ? fs.readdirSync(proofRoot).filter((e) => fs.statSync(path.join(proofRoot, e)).isDirectory()).length
    : 0;

  if (wantJson) {
    console.log(JSON.stringify({
      backend_root: root,
      proof_dirs: proofDirs,
      citation: { total: attempts.length, verified, pending, failed, engines: [...enginesSeen] },
      packets,
      operator_status: operator?.status || null,
      operator_blocker: operator?.current_blocker || null,
    }, null, 2));
    return;
  }

  console.log('Atris AEO status');
  console.log(`  backend root:      ${root}`);
  console.log(`  proof receipts:    ${proofDirs} categories`);
  console.log('');
  console.log('Live citations');
  console.log(`  attempts:          ${attempts.length}`);
  console.log(`  verified:          ${verified}`);
  console.log(`  pending:           ${pending}`);
  console.log(`  failed:            ${failed}`);
  console.log(`  engines observed:  ${[...enginesSeen].join(', ') || '(none)'}`);
  if (operator) {
    console.log(`  operator state:    ${operator.status || '?'} (blocker: ${operator.current_blocker || 'none'})`);
  }
  console.log('');
  console.log(`Buyer packets (${packets.length})`);
  for (const p of packets) {
    const delta = p.baseline != null && p.proposed != null ? `${p.baseline} → ${p.proposed}` : '?';
    console.log(`  ${pad(p.slug, 16)} ${pad(p.target_url || p.surface, 36)} ${pad(delta, 12)} ${p.claim_status}`);
  }
}

async function aeoPacket(args) {
  const known = new Set(['--json']);
  const positional = [];
  for (const a of args) {
    if (a.startsWith('--')) {
      if (!known.has(a)) {
        console.error(`Unknown flag: ${a}. Supported: --json`);
        process.exit(1);
      }
    } else {
      positional.push(a);
    }
  }
  if (positional.length === 0) {
    console.error('Missing slug. Usage: atris aeo packet <slug>');
    process.exit(1);
  }
  if (positional.length > 1) {
    console.error(`Too many arguments: ${positional.join(' ')}. Expected one slug.`);
    process.exit(1);
  }
  const slug = positional[0];
  const wantJson = args.includes('--json');
  const root = requireBackendRoot();
  const file = path.join(root, 'atris', 'features', 'aeo', 'proof', `${slug}-buyer-packet`, 'packet.json');
  const data = readJsonSafe(file);
  if (!data) {
    console.error(`Packet not found: ${file}`);
    process.exit(1);
  }

  if (wantJson) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  const u = (data && typeof data.agent_usability === 'object' && data.agent_usability) || {};
  const onlyObjects = (v) => (Array.isArray(v) ? v.filter((x) => x && typeof x === 'object') : []);
  const friction = onlyObjects(u.baseline_friction_points);
  const fixes = onlyObjects(u.fix_backlog);
  console.log(`AEO buyer packet — ${slug}`);
  console.log(`  surface:        ${data.surface || ''}`);
  console.log(`  target url:     ${data.target_url || ''}`);
  console.log(`  claim status:   ${data.claim_status || ''}`);
  console.log(`  positioning:    ${u.positioning || ''}`);
  console.log('');
  console.log('Agent usability scores');
  console.log(`  baseline:       ${u.baseline_score ?? '?'}`);
  console.log(`  proposed:       ${u.proposed_score ?? '?'}`);
  console.log(`  delta:          ${u.score_delta ?? '?'}`);
  console.log(`  verified:       ${u.movement_verified ? 'yes' : 'no'}`);
  console.log('');
  console.log(`Baseline friction (${friction.length})`);
  for (const f of friction) {
    console.log(`  [${f.severity || '?'}] ${f.stage || '?'}: ${f.missing_artifact || f.id || ''}`);
  }
  console.log('');
  console.log(`Fix backlog (${fixes.length})`);
  for (const f of fixes) {
    console.log(`  #${f.priority ?? '?'} ${f.stage || '?'}: ${f.action || ''}`);
  }
}

async function aeoProofs(args) {
  const filter = readArg(args, '--filter', '-f');
  assertNoExtras('proofs', args, []);
  const root = requireBackendRoot();
  const proofRoot = path.join(root, 'atris', 'features', 'aeo', 'proof');
  if (!fs.existsSync(proofRoot)) {
    console.error(`Proof root not found: ${proofRoot}`);
    process.exit(1);
  }
  const needle = filter ? filter.toLowerCase() : null;
  const entries = fs.readdirSync(proofRoot)
    .filter((e) => fs.statSync(path.join(proofRoot, e)).isDirectory())
    .filter((e) => !needle || e.toLowerCase().includes(needle))
    .sort();
  console.log(`AEO proof receipts at ${path.relative(process.cwd(), proofRoot)}`);
  console.log('');
  for (const e of entries) {
    const files = fs.readdirSync(path.join(proofRoot, e)).filter((f) => f.endsWith('.json'));
    console.log(`  ${pad(e, 44)} ${files.length} file${files.length === 1 ? '' : 's'}`);
  }
}

// ---------- SCRIPT WRAPPERS ----------

function runBackendScript(scriptName, args) {
  const root = requireBackendRoot();
  const script = path.join(root, 'scripts', scriptName);
  if (!fs.existsSync(script)) {
    console.error(`Script not found: ${script}`);
    process.exit(1);
  }
  const py = process.env.ATRIS_PYTHON || 'python3';
  const result = spawnSync(py, [script, ...args], { cwd: root, stdio: 'inherit' });
  if (result.error) {
    console.error(`Failed to spawn ${py}: ${result.error.message}`);
    process.exit(1);
  }
  if (result.signal) {
    const signum = os.constants?.signals?.[result.signal] ?? 0;
    console.error(`${scriptName} terminated by signal ${result.signal}`);
    process.exit(128 + signum);
  }
  process.exit(result.status ?? 1);
}

async function aeoDiscover(args) {
  if (!args.length || args[0] === '--help' || args[0] === '-h') {
    console.log('Usage: atris aeo discover <source> [--question Q]... [--canonical-url URL] [--out-dir DIR] [--json]');
    return;
  }
  runBackendScript('aeo_discovery_audit.py', args);
}

async function aeoAudit(args) {
  if (!args.length || args[0] === '--help' || args[0] === '-h') {
    console.log('Usage: atris aeo audit <source> [--baseline B] [--canonical-url URL] [--out-dir DIR] [--task T]');
    return;
  }
  runBackendScript('aeo_agent_usability_audit.py', args);
}

async function run(args = []) {
  const sub = args[0];
  if (!sub || sub === 'help' || sub === '--help' || sub === '-h') return printHelp();
  const rest = args.slice(1);
  if (sub === 'init') return aeoInit(rest);
  if (sub === 'draft') return aeoDraft(rest);
  if (sub === 'log') return aeoLog(rest);
  if (sub === 'status') return aeoStatus(rest);
  if (sub === 'packet') return aeoPacket(rest);
  if (sub === 'proofs') return aeoProofs(rest);
  if (sub === 'discover') return aeoDiscover(rest);
  if (sub === 'audit') return aeoAudit(rest);
  console.error(`Unknown aeo subcommand: ${sub}`);
  printHelp();
  process.exit(1);
}

module.exports = { run };
