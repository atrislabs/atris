#!/usr/bin/env node
// det/cpu-hotspots.js - where does an atris command spend its time?
// Runs one command under `node --cpu-prof` in a temp profile dir, then prints
// the total profiled ms, the top self-time hotspots, and the top call chains
// that end in spawnSync (application frames only, so node internals and
// node_modules drop out). Optional plain wall-clock runs give a median.
//
// Usage:
//   node scripts/det/cpu-hotspots.js [options] -- <script.js> [args...]
//   node scripts/det/cpu-hotspots.js --cwd ../repo -- bin/atris.js atris.md
//   node scripts/det/cpu-hotspots.js --wall 5 --top 15 -- bin/atris.js team
//
// Options:
//   --cwd <dir>     working directory for the profiled command (default: here)
//   --top <n>       rows per table (default 10)
//   --wall <n>      also time n unprofiled runs and print the median wall ms
//   --app <dir>     frames under this dir count as application frames
//                   (default: the repo that holds this script)
//   --keep          keep the temp profile dir and print its path
//   --json          structured output
//
// The command's own stdout is discarded; its exit code is reported.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const DEFAULT_APP_ROOT = path.resolve(__dirname, '..', '..');

function parseArgs(argv) {
  const opts = { cwd: process.cwd(), top: 10, wall: 0, app: DEFAULT_APP_ROOT, keep: false, json: false, command: [] };
  const sep = argv.indexOf('--');
  const head = sep === -1 ? argv : argv.slice(0, sep);
  opts.command = sep === -1 ? [] : argv.slice(sep + 1);
  for (let i = 0; i < head.length; i += 1) {
    const arg = head[i];
    if (arg === '--cwd') opts.cwd = path.resolve(head[++i] || '.');
    else if (arg === '--top') opts.top = Math.max(1, Number(head[++i]) || 10);
    else if (arg === '--wall') opts.wall = Math.max(0, Number(head[++i]) || 0);
    else if (arg === '--app') opts.app = path.resolve(head[++i] || '.');
    else if (arg === '--keep') opts.keep = true;
    else if (arg === '--json') opts.json = true;
    else if (arg === '-h' || arg === '--help') opts.help = true;
    else opts.command.push(arg);
  }
  return opts;
}

function frameFile(url) {
  return String(url || '').replace(/^file:\/\//, '');
}

function isAppFrame(frame, appRoot) {
  const file = frameFile(frame.url);
  if (!file || !file.startsWith(appRoot)) return false;
  return !file.includes(`${path.sep}node_modules${path.sep}`);
}

function frameLabel(frame, appRoot) {
  const file = frameFile(frame.url);
  const rel = appRoot && file.startsWith(appRoot) ? path.relative(appRoot, file) : (file || '(native)');
  const name = frame.functionName || '(anonymous)';
  return `${name} ${rel}:${Number(frame.lineNumber) + 1}`;
}

// Pure core: a parsed .cpuprofile in, tables out. Unit-testable.
function analyzeProfile(profile, { appRoot = DEFAULT_APP_ROOT, top = 10 } = {}) {
  const nodes = new Map();
  const parent = new Map();
  for (const node of profile.nodes || []) {
    nodes.set(node.id, node);
    for (const child of node.children || []) parent.set(child, node.id);
  }
  const selfUs = new Map();
  const samples = profile.samples || [];
  const deltas = profile.timeDeltas || [];
  for (let i = 0; i < samples.length; i += 1) {
    const dt = Math.max(0, Number(deltas[i]) || 0);
    selfUs.set(samples[i], (selfUs.get(samples[i]) || 0) + dt);
  }
  const totalUs = [...selfUs.values()].reduce((a, b) => a + b, 0)
    || Math.max(0, Number(profile.endTime) - Number(profile.startTime)) || 0;

  const byFrame = new Map();
  for (const [id, us] of selfUs) {
    const node = nodes.get(id);
    if (!node) continue;
    const label = frameLabel(node.callFrame || {}, appRoot);
    byFrame.set(label, (byFrame.get(label) || 0) + us);
  }
  const hotspots = [...byFrame.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, top)
    .map(([frame, us]) => ({ frame, ms: Math.round(us / 1000) }));

  // Time under each spawnSync node = self time of every descendant sample.
  const subtreeUs = new Map();
  for (const [id, us] of selfUs) {
    let cur = id;
    const seen = new Set();
    while (cur !== undefined && !seen.has(cur)) {
      seen.add(cur);
      subtreeUs.set(cur, (subtreeUs.get(cur) || 0) + us);
      cur = parent.get(cur);
    }
  }
  const chains = new Map();
  for (const node of nodes.values()) {
    const fn = node.callFrame && node.callFrame.functionName;
    if (fn !== 'spawnSync') continue;
    // Only the outermost spawnSync on a path counts (child_process wraps an
    // internal spawnSync of the same name).
    let up = parent.get(node.id);
    let nested = false;
    while (up !== undefined) {
      const upNode = nodes.get(up);
      if (upNode && upNode.callFrame && upNode.callFrame.functionName === 'spawnSync') { nested = true; break; }
      up = parent.get(up);
    }
    if (nested) continue;
    const us = subtreeUs.get(node.id) || 0;
    if (!us) continue;
    const frames = [];
    let cur = parent.get(node.id);
    while (cur !== undefined) {
      const n = nodes.get(cur);
      if (n && n.callFrame && isAppFrame(n.callFrame, appRoot)) frames.push(frameLabel(n.callFrame, appRoot));
      cur = parent.get(cur);
    }
    const key = frames.slice(0, 6).join(' < ') || '(no app frames)';
    chains.set(key, (chains.get(key) || 0) + us);
  }
  const spawnTotalUs = [...chains.values()].reduce((a, b) => a + b, 0);
  const spawnChains = [...chains.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, top)
    .map(([chain, us]) => ({ chain, ms: Math.round(us / 1000) }));
  return { total_ms: Math.round(totalUs / 1000), spawn_ms: Math.round(spawnTotalUs / 1000), hotspots, spawn_chains: spawnChains };
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

function timeRun(command, cwd, extraArgs = []) {
  const start = process.hrtime.bigint();
  const result = spawnSync(process.execPath, [...extraArgs, ...command], { cwd, stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8' });
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  return { ms: Math.round(ms), status: result.status, stderr: result.stderr || '' };
}

function resolveCommand(command) {
  if (!command.length) return command;
  const [script, ...rest] = command;
  const abs = path.isAbsolute(script) ? script : path.resolve(process.cwd(), script);
  return [fs.existsSync(abs) ? abs : script, ...rest];
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help || !opts.command.length) {
    process.stderr.write('usage: node scripts/det/cpu-hotspots.js [--cwd dir] [--top n] [--wall n] [--json] -- <script.js> [args...]\n');
    return opts.help ? 0 : 2;
  }
  const command = resolveCommand(opts.command);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-cpu-prof-'));
  const profiled = timeRun(command, opts.cwd, ['--cpu-prof', `--cpu-prof-dir=${dir}`]);
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.cpuprofile'))
    .map((f) => path.join(dir, f))
    .sort((a, b) => fs.statSync(b).size - fs.statSync(a).size);
  if (!files.length) {
    process.stderr.write(`no profile written (exit ${profiled.status})\n${profiled.stderr.slice(0, 800)}`);
    return 1;
  }
  const report = analyzeProfile(JSON.parse(fs.readFileSync(files[0], 'utf8')), { appRoot: opts.app, top: opts.top });
  report.command = command.join(' ');
  report.exit_code = profiled.status;
  report.profiled_wall_ms = profiled.ms;
  if (opts.wall) {
    const walls = [];
    for (let i = 0; i < opts.wall; i += 1) walls.push(timeRun(command, opts.cwd).ms);
    report.wall_runs_ms = walls;
    report.wall_median_ms = median(walls);
  }
  if (opts.keep) report.profile_dir = dir;
  else fs.rmSync(dir, { recursive: true, force: true });

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return 0;
  }
  const out = [];
  out.push(`command: ${report.command} (exit ${report.exit_code})`);
  out.push(`profiled: ${report.total_ms} ms cpu profile, ${report.profiled_wall_ms} ms wall, ${report.spawn_ms} ms in spawnSync`);
  if (opts.wall) out.push(`wall median of ${opts.wall}: ${report.wall_median_ms} ms (${report.wall_runs_ms.join(', ')})`);
  out.push('');
  out.push('top self time:');
  for (const row of report.hotspots) out.push(`  ${String(row.ms).padStart(6)} ms  ${row.frame}`);
  out.push('');
  out.push('top spawnSync chains:');
  if (!report.spawn_chains.length) out.push('  (none)');
  for (const row of report.spawn_chains) out.push(`  ${String(row.ms).padStart(6)} ms  ${row.chain}`);
  if (report.profile_dir) out.push('', `profile dir: ${report.profile_dir}`);
  process.stdout.write(`${out.join('\n')}\n`);
  return 0;
}

if (require.main === module) process.exitCode = main();

module.exports = { analyzeProfile, median, parseArgs };
