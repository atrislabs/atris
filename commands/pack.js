'use strict';

const fs = require('fs');
const path = require('path');
const { getAppBaseUrl, httpRequest } = require('../utils/api');
const { loadCredentials } = require('../utils/auth');
const { createZipBuffer, readZipBuffer } = require('../lib/zip');
const { craftPack } = require('./pack-craft');

const REGISTRY_TIMEOUT_MS = 60000;

function showHelp() {
  console.log('usage: atris pack craft "<topic>" [--dir <target>] [--force]');
  console.log('       atris pack publish [--dir atris] [--slug <slug>] [--author "<name>"] [--notes "..."] [--minor|--major] [--out <file.zip>] [--push]');
  console.log('       atris pack install <file.zip|url|slug> [--dir <target>] [--force]');
  console.log('       atris pack pull [<slug>] [--dir <path>]');
  console.log('       atris pack status [--dir <path>]');
  console.log('       atris pack update [<dir>]');
  console.log('       atris pack list [--dir <path>]');
}

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

function parseSemver(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(value || ''));
  if (!match) return null;
  return match.slice(1).map((part) => Number(part));
}

function bumpVersion(current, bump) {
  const parsed = parseSemver(current);
  if (!parsed) return '0.1.0';
  const [major, minor, patch] = parsed;
  if (bump === 'major') return `${major + 1}.0.0`;
  if (bump === 'minor') return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

function comparePackVersions(left, right) {
  const leftParsed = parseSemver(left);
  const rightParsed = parseSemver(right);
  if (!leftParsed || !rightParsed) {
    return String(left || '') === String(right || '') ? 0 : null;
  }
  for (let i = 0; i < leftParsed.length; i += 1) {
    if (leftParsed[i] > rightParsed[i]) return 1;
    if (leftParsed[i] < rightParsed[i]) return -1;
  }
  return 0;
}

function readJson(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`could not read ${filePath}: ${error.message}`);
  }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function buildManifest(existing, options) {
  const existingManifest = existing && typeof existing === 'object' ? existing : {};
  const slug = slugify(options.slug || existingManifest.slug || options.fallbackSlug);
  const version = existingManifest.version
    ? bumpVersion(existingManifest.version, options.bump)
    : '0.1.0';
  const title = existingManifest.title || titleFromSlug(slug);
  const manifest = {
    name: existingManifest.name || slug,
    slug,
    title,
    description: existingManifest.description || `Atris pack for ${title}.`,
    author: (options.author && String(options.author).trim()) || existingManifest.author || '',
    tags: Array.isArray(existingManifest.tags) ? existingManifest.tags : [],
    version,
    versions: Array.isArray(existingManifest.versions) ? [...existingManifest.versions] : [],
  };
  manifest.versions.push({
    version,
    date: new Date().toISOString(),
    // the registry rejects entries with empty notes, so never write one
    notes: options.notes || 'version bump',
  });
  return manifest;
}

function shouldSkipRelative(relativePath, includeLogs) {
  const normalized = relativePath.replace(/\\/g, '/');
  const parts = normalized.split('/').filter(Boolean);
  const basename = parts[parts.length - 1] || '';
  const lowerBase = basename.toLowerCase();

  if (parts.includes('.git')) return true;
  for (let i = 0; i < parts.length - 1; i += 1) {
    if (parts[i] === '.atris' && parts[i + 1] === 'state') return true;
  }
  if (!includeLogs && parts[0] === 'logs') return true;
  if (lowerBase.startsWith('credentials')) return true;
  if (lowerBase.startsWith('.env')) return true;
  if (lowerBase.endsWith('.pem')) return true;
  if (lowerBase.endsWith('.key')) return true;
  if (lowerBase.startsWith('id_rsa')) return true;
  return false;
}

function collectAtrisEntries(sourceDir, includeLogs) {
  const entries = [];

  function walk(dir, relativeDir = '') {
    const names = fs.readdirSync(dir).sort();
    for (const name of names) {
      const abs = path.join(dir, name);
      const rel = relativeDir ? path.join(relativeDir, name) : name;
      if (shouldSkipRelative(rel, includeLogs)) continue;
      const stat = fs.statSync(abs);
      if (stat.isDirectory()) {
        walk(abs, rel);
      } else if (stat.isFile()) {
        entries.push({
          name: `atris/${rel.replace(/\\/g, '/')}`,
          data: fs.readFileSync(abs),
          mtime: stat.mtime,
        });
      }
    }
  }

  walk(sourceDir);
  return entries;
}

// A crafted pack keeps wiki/, README.md, and friends at the pack root, so a
// root publish must ship the whole folder, not just atris/ (2026-07-09: the
// first dogfooded pack shipped without its research).
function collectPackRootEntries(rootDir, includeLogs) {
  const entries = [];

  function walk(dir, relativeDir = '') {
    const names = fs.readdirSync(dir).sort();
    for (const name of names) {
      const abs = path.join(dir, name);
      const rel = relativeDir ? path.join(relativeDir, name) : name;
      const normalized = rel.replace(/\\/g, '/');
      if (normalized === 'pack.json') continue;
      if (normalized === '.upstream' || normalized.startsWith('.upstream/')) continue;
      if (name === 'node_modules' || name === '.atris' || name === '.DS_Store') continue;
      if (normalized === 'atris/logs' || normalized.startsWith('atris/logs/')) {
        if (!includeLogs) continue;
      }
      if (shouldSkipRelative(normalized, includeLogs)) continue;
      const stat = fs.statSync(abs);
      if (stat.isDirectory()) {
        walk(abs, rel);
      } else if (stat.isFile()) {
        entries.push({ name: normalized, data: fs.readFileSync(abs), mtime: stat.mtime });
      }
    }
  }

  walk(rootDir);
  return entries;
}

function parseJsonBody(buffer) {
  const text = Buffer.isBuffer(buffer) ? buffer.toString('utf8') : String(buffer || '');
  if (!text.trim()) return { data: null, text };
  try {
    return { data: JSON.parse(text), text };
  } catch {
    return { data: null, text };
  }
}

function responseErrorText(response, fallback) {
  const parsed = parseJsonBody(response.body);
  const data = parsed.data;
  if (data && typeof data === 'object') {
    const message = data.error || data.message || data.detail;
    if (message) return String(message);
  }
  if (parsed.text.trim()) return parsed.text.trim();
  return fallback;
}

function registryUrl(pathname, deps = {}) {
  const appBase = (deps.getAppBaseUrl || getAppBaseUrl)();
  const cleanBase = String(appBase || '').replace(/\/+$/, '');
  return `${cleanBase}${pathname}`;
}

// The web app's CSRF gate only trusts requests whose Origin matches its own
// url; bearer-token CLI posts are not a CSRF vector, so we present the app
// origin we are posting to (2026-07-09: prod publish --push failed 403 while
// every test passed against a bare local server).
function registryOrigin(deps = {}) {
  const appBase = (deps.getAppBaseUrl || getAppBaseUrl)();
  try {
    return new URL(String(appBase)).origin;
  } catch {
    return '';
  }
}

function optionalAuthHeaders(deps = {}) {
  const readCredentials = deps.loadCredentials || loadCredentials;
  const credentials = readCredentials();
  return credentials && credentials.token ? { Authorization: `Bearer ${credentials.token}` } : {};
}

function requiredAuthHeaders(deps = {}) {
  const headers = optionalAuthHeaders(deps);
  if (!headers.Authorization) {
    throw new Error('not logged in. run atris login first to publish packs.');
  }
  return headers;
}

async function postPackToRegistry(manifest, zipBuffer, deps = {}) {
  const request = deps.httpRequest || httpRequest;
  const url = registryUrl('/api/pack/registry', deps);
  const body = JSON.stringify({ manifest, zipBase64: zipBuffer.toString('base64') });
  const authHeaders = requiredAuthHeaders(deps);
  if (!manifest.author || !String(manifest.author).trim()) {
    throw new Error('registry packs need an author. re-run with --author "<your name>" (or set "author" in pack.json).');
  }
  let response;
  try {
    response = await request(url, {
      method: 'POST',
      timeoutMs: REGISTRY_TIMEOUT_MS,
      headers: {
        ...authHeaders,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...(registryOrigin(deps) ? { Origin: registryOrigin(deps) } : {}),
      },
      body,
    });
  } catch {
    throw new Error('could not reach pack registry. check your connection and try again.');
  }

  const parsed = parseJsonBody(response.body);
  if (response.status < 200 || response.status >= 300) {
    throw new Error(responseErrorText(response, `registry publish failed with status ${response.status}`));
  }
  if (!parsed.data || typeof parsed.data !== 'object' || parsed.data.ok === false) {
    throw new Error(responseErrorText(response, 'registry publish failed'));
  }
  return parsed.data;
}

async function fetchRegistryZip(slug, deps = {}) {
  const request = deps.httpRequest || httpRequest;
  const url = registryUrl(`/api/pack/registry/${encodeURIComponent(slug)}`, deps);
  let response;
  try {
    response = await request(url, {
      method: 'GET',
      timeoutMs: REGISTRY_TIMEOUT_MS,
      headers: optionalAuthHeaders(deps),
    });
  } catch {
    throw new Error('could not reach pack registry. check your connection and try again.');
  }
  if (response.status < 200 || response.status >= 300) {
    throw new Error(responseErrorText(response, `registry lookup failed for ${slug} with status ${response.status}`));
  }
  if (!response.body || response.body.length === 0) {
    throw new Error(`registry returned an empty zip for ${slug}`);
  }
  return response.body;
}

async function publishPack(rawArgs, cwd = process.cwd(), options = {}) {
  const args = [...rawArgs];
  const dirArg = takeValue(args, '--dir');
  const packRootMode = !dirArg && fs.existsSync(path.join(cwd, 'pack.json'));
  const sourceDir = packRootMode ? path.resolve(cwd) : path.resolve(cwd, dirArg || 'atris');
  const slug = takeValue(args, '--slug');
  const author = takeValue(args, '--author');
  const notes = takeValue(args, '--notes') || '';
  const out = takeValue(args, '--out');
  const includeLogs = takeFlag(args, '--include-logs');
  const major = takeFlag(args, '--major');
  const minor = takeFlag(args, '--minor');
  const push = takeFlag(args, '--push');
  if (major && minor) throw new Error('choose either --major or --minor, not both');
  if (args.length) throw new Error(`unknown pack publish argument: ${args.join(' ')}`);
  if (!fs.existsSync(sourceDir) || !fs.statSync(sourceDir).isDirectory()) {
    throw new Error(`pack source not found: ${path.relative(cwd, sourceDir) || sourceDir}`);
  }

  const manifestPath = packRootMode
    ? path.join(sourceDir, 'pack.json')
    : path.join(path.dirname(sourceDir), 'pack.json');
  const existing = readJson(manifestPath);
  const manifest = buildManifest(existing, {
    slug,
    author,
    notes,
    bump: major ? 'major' : minor ? 'minor' : 'patch',
    fallbackSlug: packRootMode
      ? path.basename(sourceDir)
      : path.basename(path.dirname(sourceDir)) || path.basename(sourceDir),
  });
  writeJson(manifestPath, manifest);

  const entries = [
    { name: 'pack.json', data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8'), mtime: new Date() },
    ...(packRootMode
      ? collectPackRootEntries(sourceDir, includeLogs)
      : collectAtrisEntries(sourceDir, includeLogs)),
  ];
  const zipBuffer = out || push ? createZipBuffer(entries) : null;
  if (out) {
    const outPath = path.resolve(cwd, out);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, zipBuffer);
    console.log(`packed ${manifest.slug} ${manifest.version} -> ${path.relative(cwd, outPath) || outPath}`);
  }
  if (push) {
    const result = await postPackToRegistry(manifest, zipBuffer, options.deps || {});
    const publishedSlug = result.slug || manifest.slug;
    const publishedVersion = result.version || manifest.version;
    console.log(`published ${publishedSlug} ${publishedVersion}`);
    console.log(`install with: atris pack install ${publishedSlug}`);
  }
  if (!out && !push) {
    console.log(`wrote pack.json for ${manifest.slug} ${manifest.version}`);
    console.log('share with: atris pack publish --out <file.zip> or atris pack publish --push');
  }
  return 0;
}

function shellQuote(value) {
  const text = String(value || '.');
  if (/^[A-Za-z0-9_./:-]+$/.test(text)) return text;
  return `'${text.replace(/'/g, "'\\''")}'`;
}

function fallbackSlugFromZipPath(zipPath) {
  return slugify(path.basename(zipPath, path.extname(zipPath)), 'atris-pack');
}

async function loadZipPayload(source, cwd, deps = {}) {
  const request = deps.httpRequest || httpRequest;
  if (/^https?:\/\//i.test(source)) {
    const response = await request(source, { method: 'GET' });
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`download failed with status ${response.status}`);
    }
    const urlPath = new URL(source).pathname;
    return {
      buffer: response.body,
      fallbackSlug: fallbackSlugFromZipPath(urlPath || 'atris-pack.zip'),
      sourceType: 'url',
      sourceUrl: source,
    };
  }

  const localPath = path.resolve(cwd, source);
  if (fs.existsSync(localPath) || source.toLowerCase().endsWith('.zip')) {
    if (!fs.existsSync(localPath)) throw new Error(`zip file not found: ${source}`);
    return {
      buffer: fs.readFileSync(localPath),
      fallbackSlug: fallbackSlugFromZipPath(localPath),
      sourceType: 'file',
    };
  }

  const slug = slugify(source);
  const readCredentials = deps.loadCredentials || loadCredentials;
  const credentials = readCredentials();
  const headers = credentials && credentials.token ? { Authorization: `Bearer ${credentials.token}` } : {};
  const apiBaseUrl = deps.getAppBaseUrl || getAppBaseUrl;
  const url = `${apiBaseUrl()}/api/pack/registry/${encodeURIComponent(slug)}`;
  const response = await request(url, { method: 'GET', headers });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`registry lookup failed for ${slug} with status ${response.status}`);
  }
  return { buffer: response.body, fallbackSlug: slug, sourceType: 'registry', sourceSlug: slug };
}

function parseManifest(entries, fallbackSlug) {
  const manifestEntry = entries.find((entry) => entry.name === 'pack.json');
  if (!manifestEntry) return { slug: fallbackSlug };
  try {
    const parsed = JSON.parse(manifestEntry.data.toString('utf8'));
    return parsed && typeof parsed === 'object' ? parsed : { slug: fallbackSlug };
  } catch {
    return { slug: fallbackSlug };
  }
}

function manifestVersion(manifest) {
  return manifest.version
    || (Array.isArray(manifest.versions) && manifest.versions[0] && manifest.versions[0].version)
    || 'unknown';
}

function upstreamStatePath(packDir) {
  return path.join(packDir, '.upstream', 'STATE.json');
}

function buildUpstreamState(slug, localVersion, remoteVersion) {
  return {
    slug,
    localVersion,
    remoteVersion,
    pulledAt: new Date().toISOString(),
  };
}

function writeUpstreamState(packDir, state) {
  writeJson(upstreamStatePath(packDir), state);
}

function writeUpstreamZip(entries, packDir, state) {
  const upstreamDir = path.join(packDir, '.upstream');
  fs.rmSync(upstreamDir, { recursive: true, force: true });
  fs.mkdirSync(upstreamDir, { recursive: true });
  writeZipEntries(entries, upstreamDir);
  writeUpstreamState(packDir, state);
}

async function pullPack(rawArgs, cwd = process.cwd(), options = {}) {
  const args = [...rawArgs];
  const packDir = path.resolve(cwd, takeValue(args, '--dir') || '.');
  const slugArg = args.shift() || null;
  if (args.length) throw new Error(`unknown pack pull argument: ${args.join(' ')}`);

  const existing = readPackManifestFromDir(packDir);
  const slug = slugify(slugArg || existing.slug);
  const zipBuffer = await fetchRegistryZip(slug, options.deps || {});
  const entries = readZipBuffer(zipBuffer);
  const remoteManifest = parseManifest(entries, slug);
  if (slugify(remoteManifest.slug || slug) !== slug) {
    throw new Error(`registry returned different slug: ${remoteManifest.slug}`);
  }

  const localVersion = manifestVersion(existing);
  const remoteVersion = manifestVersion(remoteManifest);
  const comparison = comparePackVersions(remoteVersion, localVersion);
  if (comparison === null) {
    throw new Error(`could not compare pack versions: local ${localVersion}, remote ${remoteVersion}`);
  }

  const state = buildUpstreamState(slug, localVersion, remoteVersion);
  if (comparison > 0) {
    writeUpstreamZip(entries, packDir, state);
    console.log(`pulled ${slug} local v${localVersion} -> remote v${remoteVersion}`);
    console.log('upstream lives in .upstream/ for a deliberate merge.');
    return { ok: true, upToDate: false, localVersion, remoteVersion, targetDir: packDir };
  }

  writeUpstreamState(packDir, state);
  if (comparison === 0) {
    console.log(`already up to date v${localVersion}`);
  } else {
    console.log(`local v${localVersion} is newer than remote v${remoteVersion}`);
  }
  return { ok: true, upToDate: true, localVersion, remoteVersion, targetDir: packDir };
}

function statusPack(rawArgs, cwd = process.cwd()) {
  const args = [...rawArgs];
  const packDir = path.resolve(cwd, takeValue(args, '--dir') || '.');
  if (args.length) throw new Error(`unknown pack status argument: ${args.join(' ')}`);

  const manifest = readPackManifestFromDir(packDir);
  const localVersion = manifestVersion(manifest);
  const state = readJson(upstreamStatePath(packDir));
  if (!state) {
    console.log(`${manifest.slug} local v${localVersion}, remote never pulled`);
    return { ok: true, manifest, state: null };
  }

  const remoteVersion = state.remoteVersion || 'unknown';
  console.log(`${state.slug || manifest.slug} local v${localVersion}, last pulled remote v${remoteVersion}`);
  if (state.pulledAt) console.log(`pulled at ${state.pulledAt}`);
  return { ok: true, manifest, state };
}

function originForPayload(payload) {
  if (payload.sourceType === 'registry') {
    return { type: 'registry', slug: payload.sourceSlug };
  }
  if (payload.sourceType === 'url') {
    return { type: 'url', url: payload.sourceUrl };
  }
  if (payload.sourceType === 'file') {
    return { type: 'file' };
  }
  return null;
}

function stampOriginInManifest(manifest, origin) {
  if (!origin || manifest.origin) return manifest;
  return { ...manifest, origin };
}

function writeInstalledPackJson(targetDir, manifest) {
  writeJson(path.join(targetDir, 'pack.json'), manifest);
}

function finalizeInstalledPack(targetDir, payload, preserveOrigin) {
  const manifest = readPackManifestFromDir(targetDir);
  let finalized;
  if (preserveOrigin) {
    finalized = { ...manifest, origin: preserveOrigin };
  } else {
    finalized = stampOriginInManifest(manifest, originForPayload(payload));
  }
  if (finalized !== manifest) {
    writeInstalledPackJson(targetDir, finalized);
  }
  return finalized;
}

function assertForceInstallAllowed(targetDir, slug) {
  if (!fs.existsSync(targetDir)) return null;
  const manifestPath = path.join(targetDir, 'pack.json');
  if (!fs.existsSync(manifestPath)) return null;
  const existing = readPackManifestFromDir(targetDir);
  if (slugify(existing.slug) !== slugify(slug)) {
    throw new Error(
      `refusing update: existing slug ${existing.slug} does not match ${slug}`,
    );
  }
  return existing;
}

function writeZipEntries(entries, targetDir) {
  const writes = [];
  for (const entry of entries) {
    if (!entry.name || entry.name.endsWith('/')) continue;
    writes.push({ destination: resolveEntryTarget(targetDir, entry.name), data: entry.data });
  }
  for (const write of writes) {
    fs.mkdirSync(path.dirname(write.destination), { recursive: true });
    fs.writeFileSync(write.destination, write.data);
  }
}

function resolveEntryTarget(targetDir, entryName) {
  const normalized = String(entryName || '').replace(/\\/g, '/');
  const parts = normalized.split('/').filter(Boolean);
  if (!normalized || normalized.startsWith('/') || path.isAbsolute(normalized) || parts.includes('..')) {
    throw new Error(`refusing zip entry outside target: ${entryName}`);
  }
  const targetRoot = path.resolve(targetDir);
  const destination = path.resolve(targetRoot, ...parts);
  const rootWithSep = `${targetRoot}${path.sep}`;
  if (destination !== targetRoot && !destination.startsWith(rootWithSep)) {
    throw new Error(`refusing zip entry outside target: ${entryName}`);
  }
  return destination;
}

async function installPack(rawArgs, cwd = process.cwd(), options = {}) {
  const args = [...rawArgs];
  const source = args.shift();
  if (!source || source === 'help' || source === '--help' || source === '-h') {
    showHelp();
    return source ? 0 : 2;
  }
  const targetArg = takeValue(args, '--dir');
  const force = takeFlag(args, '--force');
  if (args.length) throw new Error(`unknown pack install argument: ${args.join(' ')}`);

  const payload = await loadZipPayload(source, cwd, options.deps || {});
  const entries = readZipBuffer(payload.buffer);
  const zipManifest = parseManifest(entries, payload.fallbackSlug);
  const slug = slugify(zipManifest.slug || payload.fallbackSlug);
  const targetDir = path.resolve(cwd, targetArg || slug);
  if (fs.existsSync(path.join(targetDir, 'atris')) && !force) {
    throw new Error(`target already contains atris/: ${path.relative(cwd, targetDir) || targetDir}. rerun with --force to overwrite.`);
  }

  const existing = force ? assertForceInstallAllowed(targetDir, slug) : null;
  const preserveOrigin = existing && existing.origin ? existing.origin : null;

  writeZipEntries(entries, targetDir);
  const manifest = finalizeInstalledPack(targetDir, payload, preserveOrigin);

  if (force && existing) {
    const oldVersion = manifestVersion(existing);
    const newVersion = manifestVersion(manifest);
    console.log(`updated v${oldVersion} -> v${newVersion}`);
  }

  const displayTarget = path.relative(cwd, targetDir) || '.';
  console.log(`installed ${slug} -> ${displayTarget}`);
  console.log(`cd ${shellQuote(displayTarget)} && claude`);
  return 0;
}

async function updatePack(rawArgs, cwd = process.cwd(), options = {}) {
  const args = [...rawArgs];
  const packDir = args.shift() || '.';
  if (args.length) throw new Error(`unknown pack update argument: ${args.join(' ')}`);

  const resolved = path.resolve(cwd, packDir);
  const existing = readPackManifestFromDir(resolved);
  const origin = existing.origin;

  if (!origin || typeof origin !== 'object' || !origin.type) {
    throw new Error('pack.json is missing origin; reinstall or use pack install --force');
  }
  if (origin.type === 'file') {
    throw new Error(
      'this pack was installed from a local zip; update it with: atris pack install <zip> --dir <path> --force',
    );
  }
  if (origin.type !== 'registry' && origin.type !== 'url') {
    throw new Error(`unsupported origin type: ${origin.type}`);
  }

  const deps = options.deps || {};
  const request = deps.httpRequest || httpRequest;
  const url = origin.type === 'registry'
    ? `${(deps.getAppBaseUrl || getAppBaseUrl)()}/api/pack/registry/${encodeURIComponent(origin.slug)}`
    : origin.url;
  const readCredentials = deps.loadCredentials || loadCredentials;
  const credentials = readCredentials();
  const headers = credentials && credentials.token ? { Authorization: `Bearer ${credentials.token}` } : {};
  const response = await request(url, { method: 'GET', headers });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`download failed with status ${response.status}`);
  }

  const entries = readZipBuffer(response.body);
  const zipManifest = parseManifest(entries, existing.slug);
  if (slugify(zipManifest.slug) !== slugify(existing.slug)) {
    throw new Error(`download returned different slug: ${zipManifest.slug}`);
  }

  const oldVersion = manifestVersion(existing);
  const newVersion = manifestVersion(zipManifest);
  if (oldVersion === newVersion) {
    console.log(`already up to date v${oldVersion}`);
    return { ok: true, upToDate: true, manifest: existing, targetDir: resolved };
  }

  writeZipEntries(entries, resolved);
  const installed = readPackManifestFromDir(resolved);
  const manifest = { ...installed, origin: existing.origin };
  writeInstalledPackJson(resolved, manifest);
  console.log(`updated v${oldVersion} -> v${newVersion}`);
  return { ok: true, upToDate: false, manifest, targetDir: resolved };
}

function readPackManifestFromDir(packDir) {
  const manifest = readJson(path.join(packDir, 'pack.json'));
  if (!manifest || typeof manifest !== 'object' || !manifest.slug) {
    throw new Error(`pack.json is missing slug: ${packDir}`);
  }
  return manifest;
}

function collectPackDirs(root, found, seen, depth = 0) {
  const resolved = path.resolve(root);
  if (seen.has(resolved) || depth > 4) return;
  seen.add(resolved);

  let entries;
  try {
    entries = fs.readdirSync(resolved, { withFileTypes: true });
  } catch {
    return;
  }

  const hasPackJson = entries.some((entry) => entry.isFile() && entry.name === 'pack.json');
  if (hasPackJson) {
    try {
      found.push({ dir: resolved, manifest: readPackManifestFromDir(resolved) });
    } catch {
      // Ignore malformed pack folders while listing installed packs.
    }
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '.atris') continue;
    collectPackDirs(path.join(resolved, entry.name), found, seen, depth + 1);
  }
}

function listInstalledPacks(cwd = process.cwd()) {
  const root = path.resolve(cwd);
  const found = [];
  const seen = new Set();
  collectPackDirs(root, found, seen);
  collectPackDirs(path.join(root, 'packs'), found, seen);

  found.sort((a, b) => {
    const left = String(a.manifest.title || a.manifest.name || a.manifest.slug);
    const right = String(b.manifest.title || b.manifest.name || b.manifest.slug);
    return left.localeCompare(right);
  });

  if (!found.length) {
    console.log('no packs found under this directory');
    return { packs: [] };
  }

  for (const item of found) {
    const title = item.manifest.title || item.manifest.name || item.manifest.slug;
    const version = item.manifest.version || 'unknown';
    const displayPath = path.relative(root, item.dir) || '.';
    console.log(`${item.manifest.slug}  ${title}  v${version}  ${displayPath}`);
  }
  return { packs: found };
}

function listPackCommand(rawArgs, cwd = process.cwd()) {
  const args = [...rawArgs];
  const dir = takeValue(args, '--dir');
  if (args.length) throw new Error(`unknown pack list argument: ${args.join(' ')}`);
  return listInstalledPacks(dir ? path.resolve(cwd, dir) : cwd);
}

async function run(argv = []) {
  const [subcommand, ...args] = argv;
  try {
    if (!subcommand || subcommand === 'help' || subcommand === '--help' || subcommand === '-h') {
      showHelp();
      return subcommand ? 0 : 2;
    }
    if (subcommand === 'craft') {
      const result = craftPack(args);
      if (result && result.needsHelp) {
        showHelp();
        return 0;
      }
      return result;
    }
    if (subcommand === 'publish') return await publishPack(args);
    if (subcommand === 'install') return await installPack(args);
    if (subcommand === 'pull') return await pullPack(args);
    if (subcommand === 'status') return statusPack(args);
    if (subcommand === 'update') return await updatePack(args);
    if (subcommand === 'list') return listPackCommand(args);
    console.error(`unknown pack command: ${subcommand}`);
    showHelp();
    return 2;
  } catch (error) {
    console.error(error.message || String(error));
    return 1;
  }
}

module.exports = {
  run,
  craftPack,
  publishPack,
  installPack,
  pullPack,
  statusPack,
  updatePack,
  listInstalledPacks,
  loadZipPayload,
  buildManifest,
  comparePackVersions,
  readPackManifestFromDir,
  shouldSkipRelative,
  resolveEntryTarget,
  manifestVersion,
  originForPayload,
  stampOriginInManifest,
  assertForceInstallAllowed,
  writeZipEntries,
};
