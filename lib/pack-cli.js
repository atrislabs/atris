'use strict';

const fs = require('fs');
const path = require('path');
const { strFromU8, strToU8, unzipSync, zipSync } = require('fflate');
const { getAppBaseUrl, httpRequest } = require('../utils/api');

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

function readOptionArg(args, name) {
  const prefix = `${name}=`;
  const inline = args.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = args.indexOf(name);
  if (index !== -1 && index < args.length - 1 && !String(args[index + 1]).startsWith('--')) {
    return args[index + 1];
  }
  return null;
}

function parsePackArgs(args = []) {
  const help = args.includes('--help') || args.includes('-h') || args[0] === 'help';
  const positional = args.filter((arg) => arg && !arg.startsWith('-'));
  const subcommand = positional[0] || (help ? 'help' : '');
  const target = positional[1] || null;
  const dir = readOptionArg(args, '--dir');
  return { subcommand, target, dir, help };
}

function isUnsafeZipEntry(entryName) {
  const normalized = String(entryName || '').replace(/\\/g, '/');
  if (!normalized || normalized === '/') return true;
  if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) return true;
  return normalized.split('/').some((part) => part === '..');
}

function normalizeZipEntryName(entryName) {
  return String(entryName || '').replace(/\\/g, '/').replace(/^\/+/, '');
}

function findPackJsonEntry(entries) {
  const names = Object.keys(entries);
  if (entries['pack.json']) return 'pack.json';
  const nested = names.find((name) => name.endsWith('/pack.json') && !name.includes('..'));
  return nested || null;
}

function readManifestFromZipEntries(entries) {
  const packJsonName = findPackJsonEntry(entries);
  if (!packJsonName) {
    throw new Error('zip is missing pack.json');
  }
  let raw;
  try {
    raw = strFromU8(entries[packJsonName]);
  } catch (err) {
    throw new Error(`could not read pack.json: ${err.message || err}`);
  }
  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch {
    throw new Error('pack.json is not valid json');
  }
  if (!manifest || typeof manifest !== 'object') {
    throw new Error('pack.json must be an object');
  }
  if (!manifest.slug || !SLUG_RE.test(String(manifest.slug))) {
    throw new Error('pack.json is missing a valid slug');
  }
  return manifest;
}

function assertDirEmpty(targetDir) {
  if (!fs.existsSync(targetDir)) return;
  const entries = fs.readdirSync(targetDir);
  if (entries.length > 0) {
    throw new Error(`refusing to overwrite non-empty directory: ${targetDir}`);
  }
}

function extractZipEntries(entries, targetDir) {
  fs.mkdirSync(targetDir, { recursive: true });
  for (const [entryName, data] of Object.entries(entries)) {
    const rel = normalizeZipEntryName(entryName);
    if (!rel || rel.endsWith('/')) continue;
    if (isUnsafeZipEntry(rel)) {
      throw new Error(`unsafe zip entry rejected: ${entryName}`);
    }
    const outPath = path.join(targetDir, rel);
    const parent = path.dirname(outPath);
    fs.mkdirSync(parent, { recursive: true });
    fs.writeFileSync(outPath, Buffer.from(data));
  }
}

function unzipBufferToDir(zipBuffer, targetDir) {
  let entries;
  try {
    entries = unzipSync(new Uint8Array(zipBuffer));
  } catch (err) {
    throw new Error(`could not unzip archive: ${err.message || err}`);
  }
  const manifest = readManifestFromZipEntries(entries);
  assertDirEmpty(targetDir);
  extractZipEntries(entries, targetDir);
  return manifest;
}

function classifyInstallSource(source, cwd = process.cwd()) {
  const raw = String(source || '').trim();
  if (!raw) return { kind: 'missing' };
  if (/^https?:\/\//i.test(raw)) return { kind: 'url', value: raw };
  const resolved = path.resolve(cwd, raw);
  if (raw.endsWith('.zip') || resolved.endsWith('.zip')) {
    if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
      return { kind: 'zip', value: resolved };
    }
    return { kind: 'zip-missing', value: resolved };
  }
  if (SLUG_RE.test(raw) && !raw.includes('/') && !raw.includes('\\')) {
    return { kind: 'slug', value: raw };
  }
  return { kind: 'unknown', value: raw };
}

function registryPackUrl(slug) {
  const base = getAppBaseUrl().replace(/\/$/, '');
  return `${base}/api/pack/registry/${encodeURIComponent(slug)}`;
}

async function fetchZipBuffer(url, deps = {}) {
  const request = deps.httpRequest || httpRequest;
  const result = await request(url, { method: 'GET', timeoutMs: 60000 });
  if (result.status === 404) {
    throw new Error(`pack not found: ${url}`);
  }
  if (result.status < 200 || result.status >= 300) {
    throw new Error(`download failed (${result.status}): ${url}`);
  }
  if (!result.body || !result.body.length) {
    throw new Error(`download returned an empty zip: ${url}`);
  }
  return result.body;
}

function defaultInstallDir(manifest, cwd = process.cwd()) {
  return path.join(cwd, `${manifest.slug}-pack`);
}

function printInstallSummary(manifest, targetDir) {
  const title = manifest.title || manifest.name || manifest.slug;
  const version = manifest.version || (Array.isArray(manifest.versions) && manifest.versions[0] && manifest.versions[0].version) || 'unknown';
  const description = manifest.description || '';
  console.log(`installed ${title} v${version}`);
  if (description) console.log(description);
  console.log(`path: ${targetDir}`);
  console.log('boot it: open this folder in any coding agent');
}

async function installPack(source, options = {}) {
  const cwd = options.cwd || process.cwd();
  const classified = classifyInstallSource(source, cwd);
  if (classified.kind === 'missing') {
    throw new Error('install source is required');
  }
  if (classified.kind === 'unknown') {
    throw new Error(`unsupported install source: ${source}`);
  }
  if (classified.kind === 'zip-missing') {
    throw new Error(`zip file not found: ${classified.value}`);
  }

  let zipBuffer;
  if (classified.kind === 'zip') {
    zipBuffer = fs.readFileSync(classified.value);
  } else if (classified.kind === 'url') {
    zipBuffer = await fetchZipBuffer(classified.value, options.deps);
  } else {
    zipBuffer = await fetchZipBuffer(registryPackUrl(classified.value), options.deps);
  }

  let manifest;
  try {
    const entries = unzipSync(new Uint8Array(zipBuffer));
    manifest = readManifestFromZipEntries(entries);
    const targetDir = options.dir
      ? path.resolve(cwd, options.dir)
      : defaultInstallDir(manifest, cwd);
    assertDirEmpty(targetDir);
    extractZipEntries(entries, targetDir);
    printInstallSummary(manifest, targetDir);
    return { ok: true, manifest, targetDir };
  } catch (err) {
    if (err.message && err.message.includes('pack.json')) throw err;
    throw new Error(err.message || String(err));
  }
}

function readPackManifestFromDir(packDir) {
  const manifestPath = path.join(packDir, 'pack.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`pack folder is missing pack.json: ${packDir}`);
  }
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    throw new Error(`pack.json is not valid json: ${manifestPath}`);
  }
  if (!manifest || typeof manifest !== 'object' || !manifest.slug) {
    throw new Error(`pack.json is missing slug: ${manifestPath}`);
  }
  return manifest;
}

function walkPackFiles(dir, base = '') {
  const out = {};
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const rel = base ? `${base}/${entry.name}` : entry.name;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      Object.assign(out, walkPackFiles(abs, rel));
    } else if (entry.isFile()) {
      out[rel.replace(/\\/g, '/')] = fs.readFileSync(abs);
    }
  }
  return out;
}

function bundlePack(packDir, options = {}) {
  const cwd = options.cwd || process.cwd();
  const resolved = path.resolve(cwd, packDir || '.');
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new Error(`pack folder not found: ${resolved}`);
  }
  const manifest = readPackManifestFromDir(resolved);
  const files = walkPackFiles(resolved);
  const zipEntries = {};
  for (const [rel, buf] of Object.entries(files)) {
    zipEntries[rel] = buf;
  }
  const zipBytes = zipSync(zipEntries);
  const zipName = `${manifest.slug}-pack.zip`;
  const zipPath = path.join(path.dirname(resolved), zipName);
  fs.writeFileSync(zipPath, Buffer.from(zipBytes));
  console.log(zipPath);
  console.log(`send this file to a friend; they run: atris pack install ${zipName}`);
  return { ok: true, zipPath, manifest };
}

function listInstalledPacks(cwd = process.cwd()) {
  const root = path.resolve(cwd);
  const found = [];

  function scan(dir, depth) {
    if (depth > 4) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const hasPackJson = entries.some((entry) => entry.isFile() && entry.name === 'pack.json');
    if (hasPackJson) {
      try {
        const manifest = readPackManifestFromDir(dir);
        found.push({ dir, manifest });
      } catch {
        // skip invalid pack folders
      }
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '.atris') continue;
      scan(path.join(dir, entry.name), depth + 1);
    }
  }

  scan(root, 0);
  found.sort((a, b) => String(a.manifest.title || a.manifest.slug).localeCompare(String(b.manifest.title || b.manifest.slug)));

  if (!found.length) {
    console.log('no packs found under this directory');
    return { ok: true, packs: [] };
  }

  for (const item of found) {
    const title = item.manifest.title || item.manifest.name || item.manifest.slug;
    const version = item.manifest.version || 'unknown';
    console.log(`${item.manifest.slug}  ${title}  v${version}  ${item.dir}`);
  }
  return { ok: true, packs: found };
}

function showPackHelp() {
  console.log('');
  console.log('Usage: atris pack install <slug|zip|url> [--dir <path>]');
  console.log('       atris pack bundle [<dir>]');
  console.log('       atris pack list');
  console.log('');
  console.log('install downloads a registry pack, local zip, or https zip url.');
  console.log('bundle zips a pack folder for sharing.');
  console.log('list shows pack folders under the current directory.');
  console.log('');
}

module.exports = {
  SLUG_RE,
  assertDirEmpty,
  bundlePack,
  classifyInstallSource,
  defaultInstallDir,
  extractZipEntries,
  findPackJsonEntry,
  installPack,
  isUnsafeZipEntry,
  listInstalledPacks,
  normalizeZipEntryName,
  parsePackArgs,
  readManifestFromZipEntries,
  readPackManifestFromDir,
  registryPackUrl,
  showPackHelp,
  unzipBufferToDir,
};
