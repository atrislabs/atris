/**
 * atris fleet-report [business] [--all-alive] [--wake] [--dry-run]
 *
 * Deliver the daily report to business AI computers so every computer
 * that is alive can see it at /workspace/atris/reports/daily-YYYY-MM-DD.md.
 *
 * Why push from the fleet side instead of a cron on the box: computers
 * hold no API token on disk (Iron Dome P4 - /workspace persists, secrets
 * never touch disk), so the fleet layer fetches the report with the
 * owner token and writes it over the existing /terminal primitive.
 *
 *   atris fleet-report agentgrads --wake     # one computer, wake if asleep
 *   atris fleet-report --all-alive           # every running computer (cron mode)
 */

const { loadCredentials } = require('../utils/auth');
const { apiRequestJson } = require('../utils/api');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function listBusinesses(token) {
  const res = await apiRequestJson('/business/', { method: 'GET', token });
  if (!res.ok) throw new Error(`Could not list businesses: ${res.status || res.error}`);
  return res.data || [];
}

async function computerStatus(token, businessId) {
  const res = await apiRequestJson(`/business/${businessId}/ai-computer/status`, {
    method: 'GET',
    token,
  });
  return res.ok ? res.data : null;
}

async function wakeComputer(token, businessId, maxWaitSec = 90) {
  await apiRequestJson(`/business/${businessId}/ai-computer/wake`, { method: 'POST', token });
  const start = Date.now();
  while (Date.now() - start < maxWaitSec * 1000) {
    await sleep(3000);
    const status = await computerStatus(token, businessId);
    if (status && status.status === 'running' && status.endpoint) return true;
  }
  return false;
}

async function fetchDailyReport(token, businessId) {
  const res = await apiRequestJson(`/business/${businessId}/daily-report`, {
    method: 'GET',
    token,
    timeoutMs: 60000,
  });
  if (!res.ok) throw new Error(`daily-report fetch failed: ${res.status || res.error}`);
  return res.data;
}

async function writeReportToComputer(token, businessId, workspaceId, report) {
  const date = report.date || new Date().toISOString().slice(0, 10);
  const remotePath = `/workspace/atris/reports/daily-${date}.md`;
  const b64 = Buffer.from(report.markdown || '', 'utf8').toString('base64');
  const command =
    `mkdir -p /workspace/atris/reports && ` +
    `echo '${b64}' | base64 -d > ${remotePath} && ` +
    `ln -sf ${remotePath} /workspace/atris/reports/latest.md && ` +
    `echo WROTE:${remotePath}`;
  if (command.length > 10000) {
    throw new Error(`report too large for one terminal write (${command.length} chars)`);
  }
  const res = await apiRequestJson(`/business/${businessId}/workspaces/${workspaceId}/terminal`, {
    method: 'POST',
    token,
    body: { command, timeout: 30 },
    timeoutMs: 45000,
  });
  if (!res.ok) throw new Error(`terminal write failed: ${res.status || res.error}`);
  const out = (res.data && (res.data.stdout || res.data.output)) || '';
  if (!out.includes('WROTE:')) throw new Error(`terminal write not confirmed: ${out.slice(0, 200)}`);
  return remotePath;
}

async function deliverToBusiness(token, biz, { wake, dryRun }) {
  const label = biz.slug || biz.name || biz.id;
  const status = await computerStatus(token, biz.id);
  const running = status && status.status === 'running' && status.endpoint;

  if (!running && !wake) {
    console.log(`  ${label}: computer not alive, skipping`);
    return { business: label, delivered: false, reason: 'asleep' };
  }
  if (!running && wake) {
    process.stdout.write(`  ${label}: waking... `);
    const ok = await wakeComputer(token, biz.id);
    console.log(ok ? 'awake' : 'wake timeout');
    if (!ok) return { business: label, delivered: false, reason: 'wake-timeout' };
  }

  const report = await fetchDailyReport(token, biz.id);
  const board = report.scoreboard || null;
  const pnl = board
    ? ` | mrr $${board.revenue_mrr_usd} cost $${(board.compute_cost_usd + (board.ec2_cost_usd || 0)).toFixed(2)}/d profit $${board.profit_daily_usd}/d`
    : '';
  if (dryRun) {
    console.log(`  ${label}: dry-run, report ${String(report.markdown || '').length} chars${pnl}`);
    return { business: label, delivered: false, reason: 'dry-run', scoreboard: board };
  }
  const remotePath = await writeReportToComputer(token, biz.id, biz.workspace_id, report);
  console.log(`  ${label}: delivered ${remotePath}${pnl}`);
  return { business: label, delivered: true, path: remotePath, scoreboard: board };
}

async function fleetReport() {
  const args = process.argv.slice(3);
  const allAlive = args.includes('--all-alive');
  const wake = args.includes('--wake');
  const dryRun = args.includes('--dry-run');
  const slug = args.find((a) => !a.startsWith('--'));

  if (!allAlive && !slug) {
    console.log('Usage: atris fleet-report <business> [--wake] | --all-alive [--dry-run]');
    process.exit(1);
  }

  const creds = loadCredentials();
  if (!creds || !creds.token) {
    console.error('Not logged in. Run: atris login');
    process.exit(1);
  }
  const token = creds.token;

  const businesses = await listBusinesses(token);
  const targets = allAlive
    ? businesses
    : businesses.filter(
        (b) => b.slug === slug || (b.name || '').toLowerCase() === slug.toLowerCase()
      );
  if (targets.length === 0) {
    console.error(`No business matching "${slug}"`);
    process.exit(1);
  }

  console.log(`Fleet daily report - ${targets.length} target(s)`);
  const results = [];
  for (const biz of targets) {
    try {
      results.push(await deliverToBusiness(token, biz, { wake, dryRun }));
    } catch (err) {
      console.log(`  ${biz.slug || biz.name}: FAILED - ${err.message}`);
      results.push({ business: biz.slug || biz.name, delivered: false, reason: err.message });
    }
  }
  const delivered = results.filter((r) => r.delivered).length;
  const boards = results.map((r) => r.scoreboard).filter(Boolean);
  if (boards.length > 0) {
    const mrr = boards.reduce((s, b) => s + (b.revenue_mrr_usd || 0), 0);
    const profit = boards.reduce((s, b) => s + (b.profit_daily_usd || 0), 0);
    console.log(`Fleet: $${mrr} MRR, $${profit.toFixed(2)}/day profit across ${boards.length} scoreboards`);
  }
  console.log(`Done: ${delivered}/${targets.length} delivered`);
  process.exitCode = delivered > 0 || dryRun || results.every((r) => r.reason === 'asleep') ? 0 : 1;
}

module.exports = { fleetReport };
