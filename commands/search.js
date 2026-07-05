'use strict';

const fs = require('fs');
const path = require('path');
const { ensureIndex, search } = require('../lib/search-db');

function printHelp() {
  console.log('Usage: atris search <keyword> [--limit N] [--json] [--reindex]');
  console.log('Example: atris search pulse cycle --limit 5');
}

function findWorkspaceRoot(start) {
  let cur = path.resolve(start || process.cwd());
  for (let i = 0; i < 64; i++) {
    const atrisDir = path.join(cur, 'atris');
    if (fs.existsSync(atrisDir) && fs.statSync(atrisDir).isDirectory()) return cur;
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return null;
}

function parseArgs(argv) {
  const query = [];
  let limit = 10;
  let json = false;
  let reindex = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h' || arg === 'help') {
      return { help: true };
    }
    if (arg === '--json') {
      json = true;
    } else if (arg === '--reindex') {
      reindex = true;
    } else if (arg === '--limit') {
      const raw = argv[++i];
      const parsed = Number.parseInt(raw, 10);
      if (!Number.isFinite(parsed) || parsed < 1) throw new Error('--limit requires a positive integer');
      limit = parsed;
    } else if (arg.startsWith('--limit=')) {
      const parsed = Number.parseInt(arg.slice('--limit='.length), 10);
      if (!Number.isFinite(parsed) || parsed < 1) throw new Error('--limit requires a positive integer');
      limit = parsed;
    } else if (arg.startsWith('--')) {
      throw new Error(`unknown flag: ${arg}`);
    } else {
      query.push(arg);
    }
  }

  return {
    query: query.join(' ').trim(),
    limit,
    json,
    reindex,
  };
}

async function searchCommand(argv) {
  const args = parseArgs(argv || []);
  if (args.help) {
    printHelp();
    return 0;
  }
  if (!args.query) {
    printHelp();
    return 1;
  }

  const root = findWorkspaceRoot(process.cwd());
  if (!root) {
    throw new Error('No atris/ directory found in this directory or its parents.');
  }

  const stats = ensureIndex(root, { force: args.reindex });
  const started = process.hrtime.bigint();
  const hits = search(root, args.query, args.limit);
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  const queryMs = Number(elapsedMs.toFixed(3));

  if (args.json) {
    console.log(JSON.stringify({
      hits,
      stats: {
        files: stats.files,
        sections: stats.sections,
        query_ms: queryMs,
      },
    }));
    return 0;
  }

  for (const hit of hits) {
    console.log(`${hit.path}:${hit.line}  ${hit.heading} — ${hit.snippet}`);
  }
  console.error(`indexed ${stats.files} files, ${stats.sections} sections, query ${queryMs}ms`);
  return 0;
}

module.exports = {
  searchCommand,
};
