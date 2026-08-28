#!/usr/bin/env node
'use strict';

// Race graded ytnotes engines. Reports only; never edits ytnotes.
// Usage: node scripts/det/ytrail-race.js [url] [engines-csv]
// Default url: https://www.youtube.com/watch?v=Z3JyAqh4ixg
// Default engines: haiku,grok,cursor,atris-fast

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_URL = 'https://www.youtube.com/watch?v=Z3JyAqh4ixg';
const DEFAULT_ENGINES = ['haiku', 'grok', 'cursor', 'atris-fast'];
const DEFAULT_TIMEOUT_MS = 300000;
const DEFAULT_ROOT = path.resolve(__dirname, '..', '..');
const EVAL_LINE = /ytrail (pass|fail) (\S+) ([\d.]+)s words=\d+ quotes=(\d+)\/(\d+) heading=(?:yes|no)/;

function parseArgs(argv) {
  const url = argv[0] || DEFAULT_URL;
  const engines = argv[1]
    ? String(argv[1]).split(',').map((name) => name.trim()).filter(Boolean)
    : DEFAULT_ENGINES.slice();
  return { url, engines };
}

function parseEvalLine(text) {
  const match = String(text || '').match(EVAL_LINE);
  if (!match) return null;
  return {
    engine: match[2],
    seconds: Number(match[3]),
    pass: match[1] === 'pass',
    quotesVerified: Number(match[4]),
    quotesTotal: Number(match[5]),
  };
}

function failedResult(engine, seconds) {
  return {
    engine,
    seconds: Number(seconds) || 0,
    pass: false,
    quotesVerified: 0,
    quotesTotal: 0,
  };
}

function createDefaultRunner(options = {}) {
  const root = options.root || DEFAULT_ROOT;
  const evalPath = options.evalPath || path.join(root, 'scripts', 'det', 'ytrail-eval.js');
  const cwd = options.cwd || root;
  const env = options.env || process.env;
  return function defaultRunner({ url, engine, timeoutMs }) {
    const run = spawnSync(process.execPath, [evalPath, url, engine], {
      encoding: 'utf8',
      cwd,
      env,
      timeout: timeoutMs,
    });
    return {
      stdout: String(run.stdout || ''),
      stderr: String(run.stderr || ''),
      status: run.status,
      error: run.error || null,
      timedOut: Boolean(run.error && run.error.code === 'ETIMEDOUT'),
    };
  };
}

function runOneEngine(engine, ctx) {
  let run;
  try {
    run = ctx.runner({
      url: ctx.url,
      engine,
      timeoutMs: ctx.timeoutMs,
    });
  } catch {
    return failedResult(engine, 0);
  }
  if (!run || run.timedOut) {
    return failedResult(engine, ctx.timeoutMs / 1000);
  }
  const parsed = parseEvalLine(run.stdout);
  if (!parsed) return failedResult(engine, 0);
  return {
    engine,
    seconds: parsed.seconds,
    pass: parsed.pass,
    quotesVerified: parsed.quotesVerified,
    quotesTotal: parsed.quotesTotal,
  };
}

function pickWinner(results) {
  return results
    .filter((row) => row.pass)
    .slice()
    .sort((a, b) => a.seconds - b.seconds)[0] || null;
}

function pad(value, width) {
  const text = String(value);
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

function formatTable(results) {
  const engineWidth = Math.max(6, ...results.map((row) => String(row.engine).length));
  const lines = [
    `${pad('engine', engineWidth)}  seconds  pass  quotes`,
  ];
  for (const row of results) {
    lines.push(
      `${pad(row.engine, engineWidth)}  ${pad(row.seconds, 7)}  ${pad(row.pass ? 'yes' : 'no', 4)}  ${row.quotesVerified}/${row.quotesTotal}`
    );
  }
  return lines.join('\n');
}

function formatVerdict(winner) {
  if (!winner) return 'race winner: none';
  return `race winner: ${winner.engine} (${winner.seconds}s, quotes ${winner.quotesVerified}/${winner.quotesTotal})`;
}

function writeLatest(root, report) {
  const outDir = path.join(root, 'atris', 'benchmarks');
  fs.mkdirSync(outDir, { recursive: true });
  const payload = {
    ts: report.ts,
    url: report.url,
    results: report.results,
    winner: report.winner,
  };
  fs.writeFileSync(
    path.join(outDir, 'ytrail-race-latest.json'),
    `${JSON.stringify(payload, null, 2)}\n`
  );
}

function runRace(options = {}) {
  const url = options.url || DEFAULT_URL;
  const engines = options.engines && options.engines.length
    ? options.engines.slice()
    : DEFAULT_ENGINES.slice();
  const timeoutMs = options.timeoutMs == null ? DEFAULT_TIMEOUT_MS : options.timeoutMs;
  const root = options.root || DEFAULT_ROOT;
  const runner = options.runner || createDefaultRunner({ root });
  const log = options.log || console.log;
  const ts = options.ts || new Date().toISOString();

  const results = [];
  for (const engine of engines) {
    results.push(runOneEngine(engine, { url, runner, timeoutMs }));
  }

  const winner = pickWinner(results);
  const report = { ts, url, results, winner };
  writeLatest(root, report);

  log(formatTable(results));
  log(formatVerdict(winner));

  return {
    ...report,
    exitCode: winner ? 0 : 1,
  };
}

function main(argv = process.argv.slice(2), options = {}) {
  const parsed = parseArgs(argv);
  const report = runRace({ ...options, ...parsed });
  return report.exitCode;
}

if (require.main === module) {
  process.exit(main());
}

module.exports = {
  DEFAULT_URL,
  DEFAULT_TIMEOUT_MS,
  parseArgs,
  parseEvalLine,
  runRace,
  main,
};
