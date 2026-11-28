const fs = require('node:fs');
const path = require('node:path');
const { defaultTargets, validateTarget, measure, summarize, rankRuns } = require('../lib/perf');
const { renderHtml } = require('../lib/perf-html');
const { ensurePerfIgnore } = require('../lib/gitignore');
const { defaultRouteSource, validateRouteSource, rankRoutes, fetchRoutes, printRoutes } = require('../lib/perf-routes');

async function perfCommand(args = [], root = process.cwd()) {
  if (args.includes('--help') || args.includes('-h') || args[0] === 'help') {
    console.log('usage: atris perf [add <name> <url> [--weight n] | list | remove <name> | run [--samples n] [--target name] [--timeout ms] | routes [--top n] | report [--json] [--html [path]]]');
    return;
  }
  const dir = path.join(root, 'atris', 'perf');
  const targetsFile = path.join(dir, 'targets.json');
  const runsFile = path.join(dir, 'runs.jsonl');
  const routesFile = path.join(dir, 'routes.jsonl');
  const readEntries = ({ urlOnly = false, routeCollection = false } = {}) => {
    const targets = fs.existsSync(targetsFile) ? JSON.parse(fs.readFileSync(targetsFile, 'utf8')) : [];
    if (!Array.isArray(targets)) throw new Error('targets must be a list');
    if (routeCollection && targets.filter(t => t.type === 'routes').length > 1) {
      throw new Error('configure only one backend route source');
    }
    const entries = urlOnly ? targets.filter(t => t.type !== 'routes') : targets;
    const valid = entries.map(t => t.type === 'routes' ? t : validateTarget(t));
    if (new Set(valid.map(t => t.name)).size !== valid.length) throw new Error('target names must be unique');
    return valid;
  };
  const readTargets = () => readEntries({ urlOnly: true });
  const saveTargets = targets => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(targetsFile, JSON.stringify(targets, null, 2) + '\n');
  };
  const option = (flag, fallback) => {
    const index = args.indexOf(flag);
    if (index < 0) return fallback;
    if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`value required for ${flag}`);
    return args[index + 1];
  };
  const action = args[0]?.startsWith('--') ? undefined : args[0];
  if (action === 'add') {
    const targets = readEntries();
    const target = validateTarget({ name: args[1], url: args[2], weight: Number(option('--weight', 1)) });
    if (target.name === defaultRouteSource.name) throw new Error('routes is reserved for the backend route source');
    if (targets.some(t => t.name === target.name)) throw new Error('target already exists; remove it before adding it again');
    saveTargets([...targets, target]);
    console.log(`added ${target.name}`);
    return;
  }
  if (action === 'list') {
    const targets = readEntries();
    console.log(targets.map(t => t.type === 'routes' ? `routes: ${t.url}` : `${t.name}: ${t.method} ${t.url} (weight ${t.weight})`).join('\n') || 'no targets yet');
    return;
  }
  if (action === 'remove') {
    const targets = readEntries();
    if (!targets.some(t => t.name === args[1])) throw new Error('target not found');
    saveTargets(targets.filter(t => t.name !== args[1]));
    console.log(`removed ${args[1]}`);
    return;
  }
  if (action && !['run', 'report', 'routes'].includes(action)) throw new Error('unknown perf subcommand; use atris perf --help');
  const top = Number(option('--top', 10));
  if (!Number.isSafeInteger(top) || top < 1) throw new Error('top must be a positive integer');
  const collectRoutes = async () => {
    if (!process.env.ATRIS_INTERNAL_SECRET) {
      console.log('set the atris_internal_secret environment variable (uppercase) to enable backend route rankings');
      return false;
    }
    try {
      const entries = readEntries({ routeCollection: true });
      const envRouteUrl = String(process.env.ATRIS_PERF_ROUTES_URL || '').trim();
      const options = { allowCustomOrigin: Boolean(envRouteUrl) };
      const source = validateRouteSource(envRouteUrl ? { name: 'routes', type: 'routes', url: envRouteUrl } : entries.find(t => t.type === 'routes') || defaultRouteSource, options);
      const snapshot = await fetchRoutes(source, process.env.ATRIS_INTERNAL_SECRET, 15000, options);
      fs.mkdirSync(dir, { recursive: true });
      ensurePerfIgnore(root);
      fs.appendFileSync(routesFile, JSON.stringify({ timestamp: new Date().toISOString(), source: source.url, ...snapshot }) + '\n');
      printRoutes(snapshot, top);
      return true;
    } catch (error) {
      console.log(error.message);
      return false;
    }
  };
  if (action === 'routes') {
    if (!await collectRoutes()) process.exitCode = 1;
    return;
  }
  if (!action || action === 'run') {
    const count = Number(option('--samples', 10));
    const timeout = Number(option('--timeout', 15000));
    if (!Number.isSafeInteger(count) || count < 1 || count > 10000) throw new Error('samples must be an integer from 1 to 10000');
    if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 2147483647) throw new Error('timeout must be positive milliseconds up to 2147483647');
    if (!fs.existsSync(targetsFile)) saveTargets([...defaultTargets, defaultRouteSource]);
    let targets = readTargets();
    const name = option('--target', null);
    if (name) {
      targets = targets.filter(t => t.name === name);
      if (!targets.length) throw new Error('target not found');
    }
    const timestamp = new Date().toISOString();
    for (const target of targets) {
      const samples = [];
      for (let i = 0; i < count; i++) samples.push(await measure(target, timeout));
      const run = summarize(target, samples, timestamp);
      ensurePerfIgnore(root);
      fs.appendFileSync(runsFile, JSON.stringify(run) + '\n');
      console.log(`${target.name}: p95 ttfb ${run.ttfb.p95.toFixed(1)} ms; errors ${(run.errorRate * 100).toFixed(0)}%`);
    }
    if (action === 'run') return;
    await collectRoutes();
  }
  const runs = fs.existsSync(runsFile) ? fs.readFileSync(runsFile, 'utf8').split('\n').filter(line => line.trim()).map(line => JSON.parse(line)) : [];
  const ranked = rankRuns(runs);
  const routeHistory = (() => {
    try {
      return fs.readFileSync(routesFile, 'utf8').split('\n').flatMap(line => {
        try {
          const record = JSON.parse(line);
          return [{ ...record, ...rankRoutes(record) }];
        } catch {
          return [];
        }
      });
    } catch {
      return [];
    }
  })();
  const latestRoutes = routeHistory.at(-1);
  if (args.includes('--json')) console.log(JSON.stringify(ranked, null, 2));
  else {
    console.log('performance ranked by p95 ttfb × weight (milliseconds)');
    if (!ranked.length) console.log('no runs yet; use atris perf run');
    for (const r of ranked) {
      const change = r.delta == null ? 'first run' : `change ${r.delta >= 0 ? '+' : ''}${r.delta.toFixed(1)} ms (${r.deltaPercent?.toFixed(1) ?? 'n/a'}%)`;
      console.log(`${r.name}: ${r.provider}; p95 ${r.ttfb.p95.toFixed(1)} ms; score ${r.score.toFixed(1)}; ${change}; errors ${(r.errorRate * 100).toFixed(0)}%`);
      for (const f of r.findings) console.log(`  ${f.code}: ${f.fix}`);
    }
    if (action === 'report' && latestRoutes) printRoutes(latestRoutes, top);
  }
  if (args.includes('--html')) {
    const next = args[args.indexOf('--html') + 1];
    const file = next && !next.startsWith('--') ? path.resolve(root, next) : path.join(dir, 'report.html');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    ensurePerfIgnore(root);
    fs.writeFileSync(file, renderHtml(ranked, latestRoutes, top));
    if (!args.includes('--json')) console.log(`report saved to ${file}`);
  }
}
module.exports = { perfCommand };
