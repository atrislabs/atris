'use strict';

const fs = require('fs');
const path = require('path');

const MEMORY_LAYERS = [
  { key: 'features', dir: path.join('atris', 'features') },
  { key: 'team', dir: path.join('atris', 'team') },
  { key: 'wiki', dir: path.join('atris', 'wiki') },
  { key: 'logs', dir: path.join('atris', 'logs') },
];

const SOURCE_DIRS = ['bin', 'commands', 'lib', 'utils', 'scripts'];
const SOURCE_EXTS = new Set(['.js', '.mjs', '.cjs', '.ts', '.sh', '.md']);

const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'for', 'from', 'in', 'is', 'it',
  'of', 'on', 'or', 'the', 'to', 'where', 'who',
]);

const SYNONYM_MAP = {
  billing: ['credits', 'stripe', 'subscription', 'connect', 'treasury'],
  payments: ['credits', 'stripe', 'subscription', 'connect', 'treasury'],
  payment: ['credits', 'stripe', 'subscription', 'connect', 'treasury'],
  money: ['credits', 'stripe', 'subscription', 'connect', 'treasury'],
  auth: ['oauth', 'identity', 'jwt', 'security', 'access'],
  login: ['auth', 'oauth', 'identity', 'jwt', 'security', 'access'],
  email: ['mail', 'inbox', 'ses', 'agent-mail', 'atrismail', 'postman'],
  agents: ['agent', 'pulse', 'autopilot', 'fleet', 'member', 'persona', 'architect'],
  database: ['db', 'schema', 'migration', 'supabase', 'sql'],
  db: ['database', 'schema', 'migration', 'supabase', 'sql'],
  slack: ['messaging', 'integration', 'integrations'],
  messaging: ['slack', 'integration', 'integrations'],
  pulse: ['autopilot', 'proactive-ops', 'autonomous'],
  autonomous: ['pulse', 'autopilot', 'proactive-ops'],
  browser: ['scraper', 'automation', 'browser-lead'],
  tools: ['tool', 'toolkit', 'skill', 'skills'],
  toolkit: ['tool', 'tools', 'skill', 'skills'],
  apps: ['app', 'builder', 'workflow', 'create-app', 'app-pm', 'block-builder'],
  workflow: ['app', 'apps', 'builder', 'create-app', 'app-pm', 'block-builder'],
};

function showSearchHelp() {
  console.log('Usage: atris search <keyword> [--raw] [--memory-only]');
  console.log('Example: atris search auth');
  console.log('  --raw          Print the full file:line dump instead of the compact answer');
  console.log('  --memory-only  Search atris/features, team, wiki, logs only (skip source + MAP)');
}

function normalizeText(value) {
  return String(value || '').toLowerCase().trim();
}

function toRelative(root, filePath) {
  return path.relative(root, filePath).split(path.sep).join('/');
}

function queryTerms(query) {
  const terms = new Set();
  const normalized = normalizeText(query);
  if (normalized) terms.add(normalized);

  const tokens = normalized
    .split(/[^a-z0-9._/-]+/)
    .map(token => token.trim())
    .filter(token => token && !STOPWORDS.has(token));

  for (const token of tokens) {
    terms.add(token);
    if (token.endsWith('s') && token.length > 3) {
      terms.add(token.slice(0, -1));
    } else if (token.length > 3) {
      terms.add(`${token}s`);
    }
    for (const synonym of SYNONYM_MAP[token] || []) {
      terms.add(synonym);
    }
  }

  return Array.from(terms)
    .filter(Boolean)
    .sort((a, b) => b.length - a.length || a.localeCompare(b));
}

function hasTerm(value, terms) {
  const text = normalizeText(value);
  return terms.some(term => text.includes(term));
}

function listMarkdownFiles(rootDir) {
  if (!fs.existsSync(rootDir)) return [];
  const files = [];

  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    entries
      .sort((a, b) => a.name.localeCompare(b.name))
      .forEach((entry) => {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(fullPath);
          return;
        }
        if (!entry.isFile()) return;
        if (/\.md$/i.test(entry.name)) files.push(fullPath);
      });
  }

  walk(rootDir);
  return files;
}

function listSourceFiles(root, dirs = SOURCE_DIRS) {
  const files = [];

  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries
      .sort((a, b) => a.name.localeCompare(b.name))
      .forEach((entry) => {
        if (entry.name === 'node_modules' || entry.name === '.git') return;
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(fullPath);
          return;
        }
        if (!entry.isFile()) return;
        if (SOURCE_EXTS.has(path.extname(entry.name).toLowerCase())) files.push(fullPath);
      });
  }

  for (const rel of dirs) {
    const abs = path.join(root, rel);
    if (fs.existsSync(abs)) walk(abs);
  }
  return files;
}

function recencyMs(relativePath, stat) {
  const match = relativePath.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (match) {
    const ms = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    if (Number.isFinite(ms)) return ms;
  }
  return Number(stat && stat.mtimeMs) || 0;
}

function emptyLayerResult(key, dir) {
  return {
    key,
    dir,
    exists: false,
    fileHits: [],
    lineHits: [],
  };
}

function scanFiles(root, key, dirLabel, files, terms) {
  const result = {
    key,
    dir: dirLabel,
    exists: files.length > 0,
    fileHits: [],
    lineHits: [],
  };

  for (const filePath of files) {
    let stat;
    let content;
    try {
      stat = fs.statSync(filePath);
      content = fs.readFileSync(filePath, 'utf8');
    } catch {
      continue;
    }

    const relativePath = toRelative(root, filePath);
    const fileRecency = recencyMs(relativePath, stat);
    const pathMatched = hasTerm(relativePath, terms);
    const fileLineHits = [];

    content.split(/\r?\n/).forEach((line, index) => {
      if (!hasTerm(line, terms)) return;
      const hit = {
        layer: key,
        file: relativePath,
        line: index + 1,
        content: line.trim(),
        recencyMs: fileRecency,
        pathOnly: false,
      };
      fileLineHits.push(hit);
      result.lineHits.push(hit);
    });

    if (pathMatched || fileLineHits.length > 0) {
      result.fileHits.push({
        layer: key,
        file: relativePath,
        pathMatched,
        lineHits: fileLineHits,
        recencyMs: fileRecency,
      });
    }
  }

  return result;
}

function scanLayer(root, layer, terms) {
  const dir = path.join(root, layer.dir);
  if (!fs.existsSync(dir)) {
    return emptyLayerResult(layer.key, layer.dir.split(path.sep).join('/'));
  }
  return scanFiles(root, layer.key, layer.dir.split(path.sep).join('/'), listMarkdownFiles(dir), terms);
}

function scanMap(root, terms) {
  const mapPath = path.join(root, 'atris', 'MAP.md');
  if (!fs.existsSync(mapPath)) return emptyLayerResult('map', 'atris/MAP.md');
  return scanFiles(root, 'map', 'atris/MAP.md', [mapPath], terms);
}

function scanSource(root, terms) {
  const files = listSourceFiles(root);
  if (!files.length) return emptyLayerResult('source', 'bin,commands,lib,utils,scripts');
  return scanFiles(root, 'source', 'bin,commands,lib,utils,scripts', files, terms);
}

function compareByRecency(a, b) {
  return (b.recencyMs || 0) - (a.recencyMs || 0)
    || a.file.localeCompare(b.file)
    || (a.line || 0) - (b.line || 0);
}

function sortedFileHits(layerResult) {
  return [...(layerResult.fileHits || [])].sort(compareByRecency);
}

function sortedLineHits(layerResult) {
  return [...(layerResult.lineHits || [])].sort(compareByRecency);
}

function layerKeys(results) {
  return Object.keys(results.layers || {});
}

function collectSearchResults(root, query, options = {}) {
  const terms = queryTerms(query);
  const layers = {};
  for (const layer of MEMORY_LAYERS) {
    layers[layer.key] = scanLayer(root, layer, terms);
  }
  if (!options.memoryOnly) {
    layers.map = scanMap(root, terms);
    layers.source = scanSource(root, terms);
  }
  return { query, terms, layers, memoryOnly: Boolean(options.memoryOnly) };
}

function featurePath(file) {
  const parts = file.split('/');
  const index = parts.indexOf('features');
  const slug = index >= 0 ? parts[index + 1] : null;
  if (slug && slug !== 'README.md') return `atris/features/${slug}/`;
  return file;
}

function ownerPath(root, file) {
  const parts = file.split('/');
  const index = parts.indexOf('team');
  const member = index >= 0 && parts[index + 1]
    ? `atris/team/${parts[index + 1]}/MEMBER.md`
    : null;
  if (member && fs.existsSync(path.join(root, member))) return member;
  return path.basename(file) === 'MEMBER.md' ? file : null;
}

function selectedFeature(results) {
  const hit = sortedFileHits(results.layers.features || emptyLayerResult('features', 'atris/features'))[0];
  return hit ? featurePath(hit.file) : 'none';
}

function selectedOwner(root, results) {
  for (const hit of sortedFileHits(results.layers.team || emptyLayerResult('team', 'atris/team'))) {
    const member = ownerPath(root, hit.file);
    if (member) return member;
  }
  return 'none';
}

function selectedWiki(results) {
  const hit = sortedFileHits(results.layers.wiki || emptyLayerResult('wiki', 'atris/wiki'))[0];
  return hit ? hit.file : 'gap - not indexed yet';
}

function selectedMap(results) {
  if (!results.layers.map) return null;
  const hit = sortedLineHits(results.layers.map)[0] || sortedFileHits(results.layers.map)[0];
  if (!hit) return 'none';
  return hit.line ? `${hit.file}:${hit.line}` : hit.file;
}

function selectedSource(results) {
  if (!results.layers.source) return null;
  const hit = sortedLineHits(results.layers.source)[0] || sortedFileHits(results.layers.source)[0];
  if (!hit) return 'none';
  return hit.line ? `${hit.file}:${hit.line}` : hit.file;
}

function hitCount(layerResult) {
  return (layerResult.fileHits || []).reduce((total, fileHit) => {
    if (fileHit.lineHits.length > 0) return total + fileHit.lineHits.length;
    return total + (fileHit.pathMatched ? 1 : 0);
  }, 0);
}

function totalHitCount(results) {
  return layerKeys(results).reduce((total, key) => total + hitCount(results.layers[key]), 0);
}

function truncateLine(value, max = 140) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 3))}...`;
}

function renderCompactSearch(root, results) {
  const lines = [
    `Feature: ${selectedFeature(results)}`,
    `Owner: ${selectedOwner(root, results)}`,
    `Wiki: ${selectedWiki(results)}`,
  ];
  if (results.layers.map) lines.push(`Map: ${selectedMap(results)}`);
  if (results.layers.source) lines.push(`Source: ${selectedSource(results)}`);

  const journalHits = sortedLineHits(results.layers.logs || emptyLayerResult('logs', 'atris/logs'));
  if (totalHitCount(results) === 0) {
    lines.push('No matches found.');
  }
  if (journalHits.length === 0) {
    lines.push('Journal: none');
    return lines.join('\n');
  }

  const total = totalHitCount(results);
  const limit = total > 5 ? 3 : 5;
  lines.push(`Found ${journalHits.length} match${journalHits.length === 1 ? '' : 'es'}.`);
  lines.push('Journal:');
  for (const hit of journalHits.slice(0, limit)) {
    lines.push(`- ${hit.file}:${hit.line}: ${truncateLine(hit.content)}`);
  }
  if (journalHits.length > limit) {
    lines.push(`(${journalHits.length - limit} more journal hits; use --raw for full dump)`);
  }
  return lines.join('\n');
}

function rawHits(results) {
  const hits = [];
  for (const key of layerKeys(results)) {
    for (const fileHit of sortedFileHits(results.layers[key])) {
      if (fileHit.lineHits.length > 0) {
        hits.push(...fileHit.lineHits.sort((a, b) => (a.line || 0) - (b.line || 0)));
      } else if (fileHit.pathMatched) {
        hits.push({
          layer: key,
          file: fileHit.file,
          line: 1,
          content: `(path match) ${fileHit.file}`,
          recencyMs: fileHit.recencyMs,
          pathOnly: true,
        });
      }
    }
  }
  return hits;
}

function renderRawSearch(results) {
  const scope = results.memoryOnly
    ? 'atris/features, atris/team, atris/wiki, atris/logs'
    : 'source, atris/MAP.md, atris/features, atris/team, atris/wiki, atris/logs';
  const hits = rawHits(results);
  const lines = [
    `Searching for "${results.query}" in ${scope}...`,
    '',
  ];

  if (hits.length === 0) {
    lines.push('No matches found.');
    return lines.join('\n');
  }

  lines.push(`Found ${hits.length} match${hits.length === 1 ? '' : 'es'}:`);
  lines.push('');
  for (const hit of hits) {
    lines.push(`${hit.file}:${hit.line}`);
    lines.push(`  ${truncateLine(hit.content, 100)}`);
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

function parseSearchArgs(args) {
  const argv = Array.isArray(args) ? args : [];
  const helpIndex = argv.findIndex(arg => arg === '--help' || arg === '-h');
  const raw = argv.includes('--raw');
  const memoryOnly = argv.includes('--memory-only');
  const query = argv
    .filter(arg => arg !== '--raw' && arg !== '--help' && arg !== '-h' && arg !== '--memory-only')
    .join(' ')
    .trim();
  return { helpIndex, raw, memoryOnly, query, argCount: argv.length };
}

function searchCommand(args = [], options = {}) {
  const { helpIndex, raw, memoryOnly, query, argCount } = parseSearchArgs(args);

  if (helpIndex >= 0) {
    showSearchHelp();
    return argCount === 1 ? 0 : 1;
  }

  if (!query) {
    showSearchHelp();
    return 1;
  }

  const root = options.root || process.cwd();
  const results = collectSearchResults(root, query, { memoryOnly });
  if (totalHitCount(results) === 0 && !fs.existsSync(path.join(root, 'atris'))) {
    console.log('No atris folder here. Run atris init to set one up.');
    return 0;
  }
  console.log(raw ? renderRawSearch(results) : renderCompactSearch(root, results));
  return 0;
}

module.exports = {
  searchCommand,
  showSearchHelp,
  collectSearchResults,
};
