const fs = require('node:fs');
const path = require('node:path');
const { defaultTargets, validateTarget, measure, summarize, rankRuns } = require('../lib/perf');
const { renderHtml } = require('../lib/perf-html');
const { ensurePerfIgnore } = require('../lib/gitignore');

async function perfCommand(args = [], root = process.cwd()) {
  if (args.includes('--help') || args.includes('-h') || args[0] === 'help') {
    console.log('usage: atris perf [add <name> <url> [--weight n] | list | remove <name> | run [--samples n] [--target name] [--timeout ms] | report [--json] [--html [path]]]');
    return;
  }
  const dir = path.join(root, 'atris', 'perf');
  const targetsFile = path.join(dir, 'targets.json');
  const runsFile = path.join(dir, 'runs.jsonl');
  const readTargets = () => {
    const targets = fs.existsSync(targetsFile) ? JSON.parse(fs.readFileSync(targetsFile, 'utf8')) : [];
    if (!Array.isArray(targets)) throw new Error('targets must be a list');
    const valid = targets.map(validateTarget);
    if (new Set(valid.map(t => t.name)).size !== valid.length) throw new Error('target names must be unique');
    return valid;
  };
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
  const action = args[0];
  if (action === 'add') {
    const targets = readTargets();
    const target = validateTarget({ name: args[1], url: args[2], weight: Number(option('--weight', 1)) });
    if (targets.some(t => t.name === target.name)) throw new Error('target already exists; remove it before adding it again');
    saveTargets([...targets, target]);
    console.log(`added ${target.name}`);
    return;
  }
  if (action === 'list') {
    const targets = readTargets();
    console.log(targets.map(t => `${t.name}: ${t.method} ${t.url} (weight ${t.weight})`).join('\n') || 'no targets yet');
    return;
  }
  if (action === 'remove') {
    const targets = readTargets();
    if (!targets.some(t => t.name === args[1])) throw new Error('target not found');
    saveTargets(targets.filter(t => t.name !== args[1]));
    console.log(`removed ${args[1]}`);
    return;
  }
  if (action && !['run', 'report'].includes(action)) throw new Error('unknown perf subcommand; use atris perf --help');
  if (!action || action === 'run') {
    const count = Number(option('--samples', 10));
    const timeout = Number(option('--timeout', 15000));
    if (!Number.isSafeInteger(count) || count < 1 || count > 10000) throw new Error('samples must be an integer from 1 to 10000');
    if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 2147483647) throw new Error('timeout must be positive milliseconds up to 2147483647');
    if (!fs.existsSync(targetsFile)) saveTargets(defaultTargets);
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
  }
  const runs = fs.existsSync(runsFile) ? fs.readFileSync(runsFile, 'utf8').split('\n').filter(line => line.trim()).map(line => JSON.parse(line)) : [];
  const ranked = rankRuns(runs);
  if (args.includes('--json')) console.log(JSON.stringify(ranked, null, 2));
  else {
    console.log('performance ranked by p95 ttfb × weight (milliseconds)');
    if (!ranked.length) console.log('no runs yet; use atris perf run');
    for (const r of ranked) {
      const change = r.delta == null ? 'first run' : `change ${r.delta >= 0 ? '+' : ''}${r.delta.toFixed(1)} ms (${r.deltaPercent?.toFixed(1) ?? 'n/a'}%)`;
      console.log(`${r.name}: ${r.provider}; p95 ${r.ttfb.p95.toFixed(1)} ms; score ${r.score.toFixed(1)}; ${change}; errors ${(r.errorRate * 100).toFixed(0)}%`);
      for (const f of r.findings) console.log(`  ${f.code}: ${f.fix}`);
    }
  }
  if (args.includes('--html')) {
    const next = args[args.indexOf('--html') + 1];
    const file = next && !next.startsWith('--') ? path.resolve(root, next) : path.join(dir, 'report.html');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    ensurePerfIgnore(root);
    fs.writeFileSync(file, renderHtml(ranked));
    if (!args.includes('--json')) console.log(`report saved to ${file}`);
  }
}
module.exports = { perfCommand };
