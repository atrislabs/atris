'use strict';

const fs = require('fs');
const path = require('path');

const LAYERS = [
  { key: 'features', dir: path.join('atris', 'features') },
  { key: 'team', dir: path.join('atris', 'team') },
  { key: 'wiki', dir: path.join('atris', 'wiki') },
  { key: 'logs', dir: path.join('atris', 'logs') },
];

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
  console.log('Usage: atris search <keyword> [--raw]');
  console.log('Example: atris search auth');
  console.log('  --raw  Print the full file:line dump instead of the compact answer');
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

function recencyMs(relativePath, stat) {
  const match = relativePath.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (match) {
    const ms = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    if (Number.isFinite(ms)) return ms;
  }
  return Number(stat && stat.mtimeMs) || 0;
}

function scanLayer(root, layer, terms) {
  const dir = path.join(root, layer.dir);
  const result = {
    key: layer.key,
    dir: layer.dir.split(path.sep).join('/'),
    exists: fs.existsSync(dir),
    fileHits: [],
    lineHits: [],
  };

  for (const filePath of listMarkdownFiles(dir)) {
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
        layer: layer.key,
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
        layer: layer.key,
        file: relativePath,
        pathMatched,
        lineHits: fileLineHits,
        recencyMs: fileRecency,
      });
    }
  }

  return result;
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

function collectSearchResults(root, query) {
  const terms = queryTerms(query);
  const layers = {};
  for (const layer of LAYERS) {
    layers[layer.key] = scanLayer(root, layer, terms);
  }
  return { query, terms, layers };
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
  const hit = sortedFileHits(results.layers.features)[0];
  return hit ? featurePath(hit.file) : 'none';
}

function selectedOwner(root, results) {
  for (const hit of sortedFileHits(results.layers.team)) {
    const member = ownerPath(root, hit.file);
    if (member) return member;
  }
  return 'none';
}

function selectedWiki(results) {
  const hit = sortedFileHits(results.layers.wiki)[0];
  return hit ? hit.file : 'gap - not indexed yet';
}

function hitCount(layerResult) {
  return (layerResult.fileHits || []).reduce((total, fileHit) => {
    if (fileHit.lineHits.length > 0) return total + fileHit.lineHits.length;
    return total + (fileHit.pathMatched ? 1 : 0);
  }, 0);
}

function totalHitCount(results) {
  return LAYERS.reduce((total, layer) => total + hitCount(results.layers[layer.key]), 0);
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

  const journalHits = sortedLineHits(results.layers.logs);
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
  for (const layer of LAYERS) {
    for (const fileHit of sortedFileHits(results.layers[layer.key])) {
      if (fileHit.lineHits.length > 0) {
        hits.push(...fileHit.lineHits.sort((a, b) => (a.line || 0) - (b.line || 0)));
      } else if (fileHit.pathMatched) {
        hits.push({
          layer: layer.key,
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
  const hits = rawHits(results);
  const lines = [
    `Searching for "${results.query}" in atris/features, atris/team, atris/wiki, atris/logs...`,
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
  const query = argv.filter(arg => arg !== '--raw' && arg !== '--help' && arg !== '-h').join(' ').trim();
  return { helpIndex, raw, query, argCount: argv.length };
}

function searchCommand(args = [], options = {}) {
  const { helpIndex, raw, query, argCount } = parseSearchArgs(args);

  if (helpIndex >= 0) {
    showSearchHelp();
    return argCount === 1 ? 0 : 1;
  }

  if (!query) {
    showSearchHelp();
    return 1;
  }

  const root = options.root || process.cwd();
  const results = collectSearchResults(root, query);
  const lines = [raw ? renderRawSearch(results) : renderCompactSearch(root, results)];
  if (totalHitCount(results) === 0 && !fs.existsSync(path.join(root, 'atris'))) {
    lines.push('No atris folder here. Run atris init to set one up.');
  }
  console.log(lines.join('\n'));
  return 0;
}

module.exports = {
  collectSearchResults,
  renderCompactSearch,
  renderRawSearch,
  searchCommand,
  showSearchHelp,
};
