'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

function slugify(value, fallback = 'atris-pack') {
  return String(value || fallback)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || fallback;
}

function titleFromSlug(slug) {
  return String(slug || 'atris-pack')
    .split('-')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ') || 'Atris Pack';
}

function takeValue(args, name) {
  const prefix = `${name}=`;
  for (let i = 0; i < args.length; i += 1) {
    const arg = String(args[i]);
    if (arg.startsWith(prefix)) {
      args.splice(i, 1);
      return arg.slice(prefix.length);
    }
    if (arg === name) {
      const value = args[i + 1];
      if (value === undefined || String(value).startsWith('--')) {
        throw new Error(`${name} requires a value`);
      }
      args.splice(i, 2);
      return value;
    }
  }
  return null;
}

function takeFlag(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return false;
  args.splice(index, 1);
  return true;
}

function shellQuote(value) {
  const text = String(value || '.');
  if (/^[A-Za-z0-9_./:-]+$/.test(text)) return text;
  return `'${text.replace(/'/g, "'\\''")}'`;
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function isNonEmptyTarget(targetDir) {
  if (!fs.existsSync(targetDir)) return false;
  const stat = fs.statSync(targetDir);
  if (!stat.isDirectory()) return true;
  return fs.readdirSync(targetDir).length > 0;
}

// the registry requires a non-empty author, so fall back through the local
// login and finally a placeholder the filler agent is told to replace
function defaultAuthor() {
  try {
    const creds = JSON.parse(
      fs.readFileSync(path.join(os.homedir(), '.atris', 'credentials.json'), 'utf8')
    );
    if (creds && typeof creds.email === 'string' && creds.email.trim()) return creds.email.trim();
  } catch {
    // not logged in; use the placeholder
  }
  return 'unknown author';
}

function buildCraftManifest(topic, slug) {
  const title = titleFromSlug(slug);
  return {
    name: slug,
    slug,
    title,
    description: `research pack on ${topic}, in progress`,
    author: defaultAuthor(),
    tags: [],
    version: '0.0.1',
    versions: [],
  };
}

function buildAtrisBoot(topic) {
  return [
    '# research pack boot',
    '',
    `you are filling a research pack on ${topic}.`,
    '',
    'method:',
    '- gather sources',
    '- write wiki-style pages under wiki/ (one concept per file, sources cited inline as plain urls)',
    "- keep atris/now.md updated with what is done and what is next (next = researchable questions, not tasks)",
    '- never fabricate citations',
    '- prefer primary sources; a secondary source is fine when the primary is unreachable, but say so inline next to the citation',
    '- add a not-affiliated disclaimer in README.md if the topic is a person or company',
    '',
    'when the pack answers its topic well, bump pack.json to 0.1.0 and it is ready to publish with:',
    '',
    '    atris pack publish --push',
    '',
  ].join('\n');
}

function buildNowMd(topic) {
  return `nothing gathered yet. start with the 3 most load-bearing questions about ${topic}.\n`;
}

function buildReadme(topic, title) {
  return [
    `# ${title}`,
    '',
    `research pack on ${topic}.`,
    '',
    'run your agent in this folder.',
    '',
  ].join('\n');
}

function buildWikiIndex() {
  return [
    '# wiki index',
    '',
    'pages: none yet',
    '',
  ].join('\n');
}

function craftPack(rawArgs, cwd = process.cwd()) {
  const args = [...rawArgs];
  const topic = args.shift();
  if (!topic || topic === 'help' || topic === '--help' || topic === '-h') {
    return { needsHelp: true };
  }
  const targetArg = takeValue(args, '--dir');
  const force = takeFlag(args, '--force');
  if (args.length) throw new Error(`unknown pack craft argument: ${args.join(' ')}`);

  const slug = slugify(topic);
  const targetDir = path.resolve(cwd, targetArg || slug);
  if (isNonEmptyTarget(targetDir) && !force) {
    const displayTarget = path.relative(cwd, targetDir) || targetDir;
    throw new Error(`target is not empty: ${displayTarget}. rerun with --force to overwrite.`);
  }

  const manifest = buildCraftManifest(topic, slug);
  const title = manifest.title;

  fs.mkdirSync(path.join(targetDir, 'atris'), { recursive: true });
  fs.mkdirSync(path.join(targetDir, 'wiki'), { recursive: true });
  writeJson(path.join(targetDir, 'pack.json'), manifest);
  fs.writeFileSync(path.join(targetDir, 'atris', 'atris.md'), buildAtrisBoot(topic));
  fs.writeFileSync(path.join(targetDir, 'atris', 'now.md'), buildNowMd(topic));
  fs.writeFileSync(path.join(targetDir, 'README.md'), buildReadme(topic, title));
  fs.writeFileSync(path.join(targetDir, 'wiki', 'index.md'), buildWikiIndex());

  const displayTarget = path.relative(cwd, targetDir) || '.';
  console.log(`created ${slug} -> ${displayTarget}`);
  console.log(`cd ${shellQuote(displayTarget)} && claude`);
  return 0;
}

module.exports = {
  craftPack,
  slugify,
  isNonEmptyTarget,
  buildCraftManifest,
};
