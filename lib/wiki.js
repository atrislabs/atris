const fs = require('fs');
const path = require('path');

const WIKI_ROOT = 'atris/wiki';
const LEGACY_WIKI_ROOT = 'wiki';
const WIKI_BRIEFS_SUBDIR = 'briefs';
const LEGACY_WIKI_BRIEFS_SUBDIR = 'syntheses';
const WIKI_SUBDIRS = ['people', 'systems', 'concepts', WIKI_BRIEFS_SUBDIR];
const WIKI_STATUS_FILE = 'STATUS.md';
const WIKI_CONTENT_SUBDIRS = WIKI_SUBDIRS.map((subdir) => path.join(WIKI_ROOT, subdir));

function today() {
  return new Date().toISOString().slice(0, 10);
}

function nowTime() {
  return new Date().toTimeString().slice(0, 5);
}

function protocolMarkdown() {
  return `# Atris Wiki Protocol

This wiki lives in \`${WIKI_ROOT}/\`.

## Purpose

Turn raw project context into a living memory the next agent can pick up cold.

## Shape

- \`${WIKI_ROOT}/wiki.md\` - this protocol
- \`${WIKI_ROOT}/index.md\` - catalog grouped by page type
- \`${WIKI_ROOT}/log.md\` - append-only ingest and lint history
- \`${WIKI_ROOT}/STATUS.md\` - plain-English health summary
- \`${WIKI_ROOT}/people/\` - humans (employees, contacts, stakeholders)
- \`${WIKI_ROOT}/systems/\` - tools, tables, dashboards, services, products
- \`${WIKI_ROOT}/concepts/\` - patterns, frameworks, recurring ideas
- \`${WIKI_ROOT}/${WIKI_BRIEFS_SUBDIR}/\` - multi-page briefs and cross-cutting analysis

## Rules

- Read the full source before writing.
- Merge new facts into existing pages. Do not overwrite history blindly.
- Add cross-references with \`[[atris/wiki/...]]\` links.
- Keep \`index.md\`, \`log.md\`, and \`STATUS.md\` in sync with page changes.
- If something is unclear or contradictory, say so directly.
`;
}

function indexMarkdown() {
  return `# Atris Wiki Index

## People

## Systems

## Concepts

## Briefs
`;
}

function logMarkdown() {
  return `# Atris Wiki Log

## ${today()}
`;
}

function statusMarkdown() {
  return `# Atris Wiki Status

- Last ingest: never
- Last lint: never
- Last loop: never
- Health: wiki scaffold created, no pages yet
- Next move: run \`atris ingest <path>\`
`;
}

function ensureFile(filePath, content) {
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, content, 'utf8');
  }
}

function isDirectoryEmpty(dir) {
  try {
    return fs.readdirSync(dir).length === 0;
  } catch {
    return true;
  }
}

function mergeLegacyDirectory(sourceDir, targetDir) {
  if (!fs.existsSync(sourceDir)) return;
  fs.mkdirSync(targetDir, { recursive: true });

  const entries = fs.readdirSync(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);

    if (entry.isDirectory()) {
      mergeLegacyDirectory(sourcePath, targetPath);
      if (isDirectoryEmpty(sourcePath)) {
        fs.rmdirSync(sourcePath);
      }
      continue;
    }

    if (!fs.existsSync(targetPath)) {
      fs.renameSync(sourcePath, targetPath);
      continue;
    }

    const sourceContent = fs.readFileSync(sourcePath, 'utf8');
    const targetContent = fs.readFileSync(targetPath, 'utf8');
    if (sourceContent === targetContent) {
      fs.rmSync(sourcePath, { force: true });
    }
  }
}

function rewriteLegacyWikiReferences(wikiDir) {
  for (const filePath of walkMarkdownFiles(wikiDir)) {
    const current = fs.readFileSync(filePath, 'utf8');
    const updated = current
      .replace(/atris\/wiki\/syntheses\//g, `atris/wiki/${WIKI_BRIEFS_SUBDIR}/`)
      .replace(/\bsyntheses\//g, `${WIKI_BRIEFS_SUBDIR}/`)
      .replace(/^## Syntheses$/gm, '## Briefs')
      .replace(/^type:\s*synthesis$/m, 'type: brief');

    if (updated !== current) {
      fs.writeFileSync(filePath, updated, 'utf8');
    }
  }
}

function migrateLegacyBriefsDir(wikiDir) {
  const legacyDir = path.join(wikiDir, LEGACY_WIKI_BRIEFS_SUBDIR);
  const briefsDir = path.join(wikiDir, WIKI_BRIEFS_SUBDIR);

  if (!fs.existsSync(legacyDir)) return;

  if (!fs.existsSync(briefsDir)) {
    fs.renameSync(legacyDir, briefsDir);
  } else {
    mergeLegacyDirectory(legacyDir, briefsDir);
    if (isDirectoryEmpty(legacyDir)) {
      fs.rmdirSync(legacyDir);
    }
  }

  rewriteLegacyWikiReferences(wikiDir);
}

function ensureWikiScaffold(projectRoot = process.cwd()) {
  const wikiDir = path.join(projectRoot, WIKI_ROOT);
  fs.mkdirSync(wikiDir, { recursive: true });
  migrateLegacyBriefsDir(wikiDir);
  for (const subdir of WIKI_SUBDIRS) {
    fs.mkdirSync(path.join(wikiDir, subdir), { recursive: true });
  }

  ensureFile(path.join(wikiDir, 'wiki.md'), protocolMarkdown());
  ensureFile(path.join(wikiDir, 'index.md'), indexMarkdown());
  ensureFile(path.join(wikiDir, 'log.md'), logMarkdown());
  ensureFile(path.join(wikiDir, WIKI_STATUS_FILE), statusMarkdown());

  return wikiDir;
}

function findLocalWikiDir(projectRoot = process.cwd(), slug = null) {
  const tries = [
    path.join(projectRoot, WIKI_ROOT),
    path.join(projectRoot, LEGACY_WIKI_ROOT),
    slug && path.join(projectRoot, 'atris', slug, 'wiki'),
    slug && path.join(projectRoot, slug, 'wiki'),
  ].filter(Boolean);

  return tries.find((candidate) => fs.existsSync(candidate)) || null;
}

function normalizeWikiOnlyPrefix(prefix) {
  const trimmed = prefix.replace(/^\//, '');
  if (trimmed === 'wiki' || trimmed === 'wiki/' || trimmed === 'atris/wiki' || trimmed === 'atris/wiki/') {
    return 'atris/wiki/';
  }
  return null;
}

function readWikiStatus(projectRoot = process.cwd(), slug = null) {
  const wikiDir = findLocalWikiDir(projectRoot, slug);
  if (!wikiDir) return null;

  const statusPath = path.join(wikiDir, WIKI_STATUS_FILE);
  if (!fs.existsSync(statusPath)) {
    return {
      wikiDir,
      statusPath,
      bullets: [],
    };
  }

  const bullets = fs.readFileSync(statusPath, 'utf8')
    .split('\n')
    .filter((line) => line.startsWith('- '))
    .slice(0, 4);

  return {
    wikiDir,
    statusPath,
    bullets,
  };
}

function walkMarkdownFiles(dir, output = []) {
  if (!fs.existsSync(dir)) return output;

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkMarkdownFiles(fullPath, output);
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      output.push(fullPath);
    }
  }

  return output;
}

function parseInlineArray(rawValue) {
  return rawValue.slice(1, -1)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => item.replace(/^['"]|['"]$/g, ''));
}

function parseFrontmatter(content) {
  if (!content.startsWith('---\n')) return null;

  const endIndex = content.indexOf('\n---', 4);
  if (endIndex === -1) return null;

  const yaml = content.slice(4, endIndex);
  const frontmatter = {};
  let currentKey = null;

  for (const rawLine of yaml.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    const listMatch = line.match(/^\s+-\s+(.+)$/);
    if (listMatch && currentKey) {
      if (!Array.isArray(frontmatter[currentKey])) frontmatter[currentKey] = [];
      frontmatter[currentKey].push(listMatch[1].trim().replace(/^['"]|['"]$/g, ''));
      continue;
    }

    const keyValueMatch = line.match(/^([a-zA-Z0-9_-]+):\s*(.*)$/);
    if (!keyValueMatch) continue;

    currentKey = keyValueMatch[1];
    const value = keyValueMatch[2].trim();
    if (value === '') {
      frontmatter[currentKey] = [];
    } else if (value.startsWith('[') && value.endsWith(']')) {
      frontmatter[currentKey] = parseInlineArray(value);
    } else {
      frontmatter[currentKey] = value.replace(/^['"]|['"]$/g, '');
    }
  }

  return frontmatter;
}

function readWikiPages(projectRoot = process.cwd()) {
  const wikiDir = path.join(projectRoot, WIKI_ROOT);
  const pages = [];

  for (const subdir of WIKI_SUBDIRS) {
    const fullDir = path.join(wikiDir, subdir);
    for (const filePath of walkMarkdownFiles(fullDir)) {
      const content = fs.readFileSync(filePath, 'utf8');
      const frontmatter = parseFrontmatter(content) || {};
      pages.push({
        filePath,
        relativePath: path.relative(projectRoot, filePath).replace(/\\/g, '/'),
        content,
        frontmatter,
      });
    }
  }

  return pages;
}

function normalizeSourcePath(projectRoot, source) {
  if (!source || /^https?:\/\//i.test(source)) return null;
  if (path.isAbsolute(source)) return path.normalize(source);
  return path.normalize(path.join(projectRoot, source));
}

function findStaleWikiPages(projectRoot = process.cwd()) {
  return readWikiPages(projectRoot)
    .map((page) => {
      const sources = Array.isArray(page.frontmatter.sources) ? page.frontmatter.sources : [];
      if (sources.length === 0) return null;

      const lastCompiled = page.frontmatter.last_compiled;
      if (!lastCompiled) {
        return {
          page: page.relativePath,
          staleSource: sources[0],
          reason: 'missing last_compiled',
        };
      }

      const compiledDate = new Date(`${lastCompiled}T23:59:59`);
      for (const source of sources) {
        const normalized = normalizeSourcePath(projectRoot, source);
        if (!normalized) continue;
        if (!fs.existsSync(normalized)) {
          return {
            page: page.relativePath,
            staleSource: source,
            reason: 'missing source',
          };
        }

        const stat = fs.statSync(normalized);
        if (stat.mtime > compiledDate) {
          return {
            page: page.relativePath,
            staleSource: source,
            reason: 'source newer than last_compiled',
          };
        }
      }

      return null;
    })
    .filter(Boolean);
}

function extractWikiLinks(content) {
  const matches = content.match(/\[\[(atris\/wiki\/[^\]]+?)\]\]/g) || [];
  return matches.map((match) => match.slice(2, -2));
}

function findWikiOrphans(projectRoot = process.cwd()) {
  const pages = readWikiPages(projectRoot);
  const indexPath = path.join(projectRoot, WIKI_ROOT, 'index.md');
  const indexContent = fs.existsSync(indexPath) ? fs.readFileSync(indexPath, 'utf8') : '';

  const inboundLinks = new Map();
  for (const page of pages) {
    inboundLinks.set(page.relativePath, 0);
  }

  for (const page of pages) {
    const links = extractWikiLinks(page.content);
    for (const link of links) {
      const normalized = link.replace(/\\/g, '/');
      if (normalized !== page.relativePath && inboundLinks.has(normalized)) {
        inboundLinks.set(normalized, inboundLinks.get(normalized) + 1);
      }
    }
  }

  return pages
    .filter((page) => {
      const indexed = indexContent.includes(`[[${page.relativePath}]]`);
      const inboundCount = inboundLinks.get(page.relativePath) || 0;
      return !indexed && inboundCount === 0;
    })
    .map((page) => page.relativePath);
}

function findSuggestedSources(projectRoot = process.cwd(), limit = 3) {
  const candidates = [
    'README.md',
    'atris/CLAUDE.md',
    'atris/atris.md',
    'atris.md',
    'package.json',
    'commands/init.js',
    'commands/activate.js',
    'commands/wiki.js',
    'atris/team/navigator/MEMBER.md',
    'atris/team/executor/MEMBER.md',
    'atris/team/validator/MEMBER.md',
  ];

  const seen = new Set();
  for (const page of readWikiPages(projectRoot)) {
    const sources = Array.isArray(page.frontmatter.sources) ? page.frontmatter.sources : [];
    for (const source of sources) {
      const normalized = normalizeSourcePath(projectRoot, source);
      if (normalized) seen.add(normalized);
    }
  }

  const suggestions = [];
  for (const candidate of candidates) {
    const fullPath = path.join(projectRoot, candidate);
    if (!fs.existsSync(fullPath)) continue;
    if (seen.has(path.normalize(fullPath))) continue;
    suggestions.push(candidate);
    if (suggestions.length >= limit) break;
  }

  return suggestions;
}

function parseStatusBullets(content) {
  const bullets = new Map();
  for (const line of content.split('\n')) {
    const match = line.match(/^- ([^:]+):\s*(.*)$/);
    if (match) bullets.set(match[1], match[2]);
  }
  return bullets;
}

function writeWikiStatus(projectRoot = process.cwd(), report) {
  const wikiDir = ensureWikiScaffold(projectRoot);
  const statusPath = path.join(wikiDir, WIKI_STATUS_FILE);
  const existing = fs.existsSync(statusPath) ? fs.readFileSync(statusPath, 'utf8') : '';
  const bullets = parseStatusBullets(existing);

  const lines = [
    '# Atris Wiki Status',
    '',
    `- Last ingest: ${bullets.get('Last ingest') || 'never'}`,
    `- Last lint: ${bullets.get('Last lint') || 'never'}`,
    `- Last loop: ${today()} ${nowTime()}`,
    `- Health: ${report.health}`,
    `- Next move: ${report.nextMove}`,
    '',
  ];

  fs.writeFileSync(statusPath, lines.join('\n'), 'utf8');
  return statusPath;
}

function appendWikiLog(projectRoot = process.cwd(), summary, details = []) {
  const wikiDir = ensureWikiScaffold(projectRoot);
  const logPath = path.join(wikiDir, 'log.md');
  let content = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '# Atris Wiki Log\n';
  const dateHeader = `## ${today()}`;
  if (!content.includes(dateHeader)) {
    if (!content.endsWith('\n')) content += '\n';
    content += `\n${dateHeader}\n`;
  }

  if (!content.endsWith('\n')) content += '\n';
  content += `- ${nowTime()} LOOP ${summary}\n`;
  for (const detail of details) {
    content += `  - ${detail}\n`;
  }

  fs.writeFileSync(logPath, content, 'utf8');
  return logPath;
}

function formatSourceList(sourceValue) {
  return sourceValue
    .split(/\s+/)
    .filter(Boolean)
    .join(', ');
}

const WIKI_SCHEMA = `The wiki lives in ${WIKI_ROOT}/.

Structure:
- ${WIKI_ROOT}/wiki.md - protocol for future agents
- ${WIKI_ROOT}/index.md - catalog grouped by type
- ${WIKI_ROOT}/log.md - append-only activity log
- ${WIKI_ROOT}/STATUS.md - plain-English health summary
- ${WIKI_ROOT}/people/ - one page per human
- ${WIKI_ROOT}/systems/ - one page per tool, table, dashboard, service, or product
- ${WIKI_ROOT}/concepts/ - pattern and framework pages
- ${WIKI_ROOT}/${WIKI_BRIEFS_SUBDIR}/ - cross-cutting briefs referencing 3+ pages

Page format:
---
type: person | system | concept | brief
slug: short-id
title: Human Readable
sources: [path/to/source1.md]
last_compiled: YYYY-MM-DD
created: YYYY-MM-DD
updated: YYYY-MM-DD
tags: [tag1, tag2]
---
# Title
Body in markdown.
## Cross-References
- [[atris/wiki/people/related.md]] - why related

Rules:
- Read every listed source fully before writing
- Merge new info into existing pages instead of replacing them
- Keep index.md, log.md, and STATUS.md current
- Flag contradictions directly instead of smoothing them over
- Never modify the raw source documents you ingested`;

function buildIngestPrompt(sourceValue) {
  return `Atris wiki ingest: ${formatSourceList(sourceValue)}
${WIKI_SCHEMA}

Workflow:
1. Read every source in: ${sourceValue}
2. Ensure ${WIKI_ROOT}/ exists with wiki.md, index.md, log.md, STATUS.md, and the 3 page subfolders
3. Extract people, systems, and concepts worth preserving
4. Create or update pages under ${WIKI_ROOT}/, merging with existing facts instead of replacing them
5. Add cross-references using [[atris/wiki/...]] links
6. Update ${WIKI_ROOT}/index.md with one-line descriptions of touched pages
7. Append an INGEST entry to ${WIKI_ROOT}/log.md under today's date
8. Refresh ${WIKI_ROOT}/STATUS.md in plain English for a non-technical reader

Quality bar:
- Ask clarifying questions if the source is ambiguous
- Capture the important facts, not filler
- Say what is uncertain
- Leave the wiki sharper than you found it`;
}

function buildQueryPrompt(question) {
  return `Atris wiki query: ${question}

Read ${WIKI_ROOT}/index.md first, then the most relevant pages.
Answer from the wiki with direct references to page paths under ${WIKI_ROOT}/.
If the answer reveals a reusable insight, offer to save it as a brief page.`;
}

function buildLintPrompt() {
  return `Atris wiki lint pass

Read ${WIKI_ROOT}/index.md, crawl the referenced pages, and inspect the local wiki.

Checks:
1. Every page referenced by index.md exists
2. Cross-references resolve
3. Orphan pages are listed
4. Contradictions are called out plainly
5. Gaps worth ingesting next are listed concretely
6. ${WIKI_ROOT}/STATUS.md is rewritten in plain English
7. ${WIKI_ROOT}/log.md gets a LINT entry under today's date

Output:
- Clear summary for a non-technical reader
- Specific next ingest suggestions
- No hedging if the wiki is stale or messy`;
}

module.exports = {
  WIKI_ROOT,
  LEGACY_WIKI_ROOT,
  WIKI_SUBDIRS,
  WIKI_CONTENT_SUBDIRS,
  WIKI_SCHEMA,
  WIKI_STATUS_FILE,
  ensureWikiScaffold,
  findLocalWikiDir,
  normalizeWikiOnlyPrefix,
  readWikiStatus,
  readWikiPages,
  findStaleWikiPages,
  findWikiOrphans,
  findSuggestedSources,
  writeWikiStatus,
  appendWikiLog,
  buildIngestPrompt,
  buildQueryPrompt,
  buildLintPrompt,
};
