'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { loadCredentials } = require('../utils/auth');
const { getApiBaseUrl } = require('../utils/api');

const MAX_PAGE_BYTES = 2 * 1024 * 1024;
const MAX_PAGES = 200;
const BUILD_DIRS = ['dist', 'build', 'out'];
const SKIP_DIRS = new Set(['node_modules', '.git']);

const TEXT_CONTENT_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
  '.map': 'application/json',
  '.md': 'text/markdown; charset=utf-8',
});

const BINARY_CONTENT_TYPES = Object.freeze({
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.wasm': 'application/wasm',
  '.pdf': 'application/pdf',
});

function normalizePagePath(value) {
  return String(value || '').replace(/\\/g, '/').replace(/^\/+/, '');
}

function fileEncoding(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (Object.prototype.hasOwnProperty.call(TEXT_CONTENT_TYPES, extension)) {
    return { contentType: TEXT_CONTENT_TYPES[extension], isBase64: false };
  }
  return {
    contentType: BINARY_CONTENT_TYPES[extension] || 'application/octet-stream',
    isBase64: true,
  };
}

function walkSiteFiles(root, deps = {}) {
  const fileSystem = deps.fs || fs;
  const files = [];

  function walk(current) {
    const entries = fileSystem.readdirSync(current, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      if (entry.name === '.DS_Store' || entry.name.startsWith('.')) continue;
      if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;

      const absolutePath = path.join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        walk(absolutePath);
        continue;
      }
      if (!entry.isFile()) continue;

      const pagePath = normalizePagePath(path.relative(root, absolutePath));
      const { contentType, isBase64 } = fileEncoding(absolutePath);
      files.push({
        absolutePath,
        path: pagePath,
        size: fileSystem.statSync(absolutePath).size,
        content_type: contentType,
        is_base64: isBase64,
      });
    }
  }

  walk(root);
  return files;
}

function validateFileLimits(files) {
  const oversized = files.filter((file) => file.size > MAX_PAGE_BYTES);
  const excess = files.slice(MAX_PAGES);
  if (oversized.length === 0 && excess.length === 0) return;

  const lines = ['site files exceed upload limits:'];
  if (oversized.length > 0) {
    lines.push(`pages over 2 mb: ${oversized.map((file) => file.path).join(', ')}`);
  }
  if (excess.length > 0) {
    lines.push(`pages over the 200 page limit: ${excess.map((file) => file.path).join(', ')}`);
  }
  throw new Error(lines.join('\n'));
}

function collectPages(root, deps = {}) {
  const fileSystem = deps.fs || fs;
  const files = walkSiteFiles(root, deps);
  validateFileLimits(files);

  return files.map((file) => {
    const content = fileSystem.readFileSync(file.absolutePath);
    return {
      path: file.path,
      content: file.is_base64 ? content.toString('base64') : content.toString('utf8'),
      content_type: file.content_type,
      is_base64: file.is_base64,
    };
  });
}

function parseArgs(argv) {
  const options = {
    dir: null,
    slug: null,
    profile: null,
    spa: false,
    claimSubdomain: true,
    build: false,
    json: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h' || arg === 'help') {
      options.help = true;
    } else if (arg === '--spa') {
      options.spa = true;
    } else if (arg === '--no-claim') {
      options.claimSubdomain = false;
    } else if (arg === '--build') {
      options.build = true;
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--slug' || arg === '--profile') {
      const value = argv[i + 1];
      if (!value || value.startsWith('-')) throw new Error(`${arg} needs a value`);
      if (arg === '--slug') options.slug = value;
      else options.profile = value;
      i += 1;
    } else if (arg.startsWith('-')) {
      throw new Error(`unknown option: ${arg}`);
    } else if (!options.dir) {
      options.dir = arg;
    } else {
      throw new Error(`unexpected argument: ${arg}`);
    }
  }

  return options;
}

function printHelp(log = console.log) {
  log(`
  atris site publish: upload a built web folder to atris.ai

    atris site publish <dir> --slug <slug> [--profile strict|app] [--spa] [--no-claim] [--build] [--json]

  --build runs npm run build in <dir>, then publishes dist, build, or out.
  each page is capped at 2 mb, and each site is capped at 200 pages.
`);
}

function validateOptions(options) {
  if (!options.dir) return 'site publish needs a directory';
  if (!options.slug) return '--slug is required';
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(options.slug)) {
    return 'slug must use lowercase letters, digits, and hyphens, with no hyphen at either end';
  }
  if (options.profile && options.profile !== 'strict' && options.profile !== 'app') {
    return '--profile must be strict or app';
  }
  return null;
}

function requireDirectory(dir, fileSystem = fs) {
  const root = path.resolve(dir);
  let stat;
  try {
    stat = fileSystem.statSync(root);
  } catch {
    throw new Error(`site directory does not exist: ${root}`);
  }
  if (!stat.isDirectory()) throw new Error(`site path is not a directory: ${root}`);
  return root;
}

function buildSite(root, deps = {}) {
  const fileSystem = deps.fs || fs;
  const packagePath = path.join(root, 'package.json');
  let packageJson;
  try {
    packageJson = JSON.parse(fileSystem.readFileSync(packagePath, 'utf8'));
  } catch {
    throw new Error('--build needs package.json with a build script');
  }
  if (!packageJson.scripts || typeof packageJson.scripts.build !== 'string' || !packageJson.scripts.build.trim()) {
    throw new Error('--build needs package.json with a build script');
  }

  const spawn = deps.spawnSync || spawnSync;
  const result = spawn('npm', ['run', 'build'], { cwd: root, stdio: 'inherit' });
  if (result.error) throw new Error(`build failed: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`build failed with exit code ${result.status}`);

  for (const name of BUILD_DIRS) {
    const candidate = path.join(root, name);
    try {
      if (fileSystem.statSync(candidate).isDirectory()) return candidate;
    } catch {
      // Try the next conventional build directory.
    }
  }
  throw new Error('build finished but no dist, build, or out directory exists');
}

async function readResponse(response) {
  if (response && typeof response.text === 'function') {
    const text = await response.text();
    if (!text) return { data: null, text: '' };
    try { return { data: JSON.parse(text), text }; } catch { return { data: null, text }; }
  }
  if (response && typeof response.json === 'function') {
    try {
      const data = await response.json();
      return { data, text: data == null ? '' : JSON.stringify(data) };
    } catch {
      return { data: null, text: '' };
    }
  }
  return { data: null, text: '' };
}

function responsePageCount(value) {
  if (Array.isArray(value)) return value.length;
  return value == null ? 0 : value;
}

function printPublishResult(data, log) {
  const urls = data && data.urls && typeof data.urls === 'object' ? data.urls : {};
  log(`pages uploaded: ${responsePageCount(data && data.pages)}`);
  log(`verified: ${data && data.verified === true ? 'yes' : 'no'}`);
  log(`site url: ${urls.site || ''}`);
  log(`preview url: ${urls.preview || ''}`);
  log(`publish id: ${(data && data.publish_id) || ''}`);
}

async function run(argv, deps = {}) {
  const log = deps.log || console.log;
  const errorLog = deps.error || console.error;
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    errorLog(error.message);
    return 2;
  }

  if (options.help) {
    printHelp(log);
    return 0;
  }
  const optionError = validateOptions(options);
  if (optionError) {
    errorLog(optionError);
    return 2;
  }

  const fileSystem = deps.fs || fs;
  let root;
  let pages;
  try {
    root = requireDirectory(options.dir, fileSystem);
    if (options.build) root = buildSite(root, deps);
    pages = collectPages(root, deps);
  } catch (error) {
    errorLog(error.message);
    return 2;
  }

  if (!pages.some((page) => page.path === 'index.html')) {
    errorLog('site home page is missing: index.html');
    return 2;
  }

  const readCredentials = deps.loadCredentials || loadCredentials;
  const credentials = readCredentials();
  const token = credentials && typeof credentials.token === 'string' ? credentials.token.trim() : '';
  if (!token) {
    errorLog('not logged in. run atris login first.');
    return 1;
  }

  const body = { pages, claim_subdomain: options.claimSubdomain };
  if (options.spa) body.spa = true;
  if (options.profile) body.csp_profile = options.profile;

  const fetchFn = deps.fetch || globalThis.fetch;
  if (typeof fetchFn !== 'function') {
    errorLog('site publish needs Node.js 18 or newer');
    return 1;
  }
  const apiBase = String(deps.apiBase || getApiBaseUrl()).replace(/\/+$/, '');
  const url = `${apiBase}/sites/${encodeURIComponent(options.slug)}/publish`;

  let response;
  let parsed;
  try {
    response = await fetchFn(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    parsed = await readResponse(response);
  } catch (error) {
    errorLog(`publish failed: ${error.message}`);
    return 1;
  }

  const status = Number(response && response.status) || 0;
  const ok = response && typeof response.ok === 'boolean'
    ? response.ok
    : status >= 200 && status < 300;
  if (!ok) {
    const detail = parsed.data && typeof parsed.data === 'object' && parsed.data.detail
      ? String(parsed.data.detail)
      : parsed.text.trim() || `request failed with status ${status}`;
    errorLog(detail);
    if (status === 503 && detail === 'subdomain_grant_unavailable') {
      errorLog(`could not claim ${options.slug}.atris.ai (server has no Render credentials); retry with --no-claim if the subdomain already exists`);
    }
    return 1;
  }

  const data = parsed.data && typeof parsed.data === 'object' ? parsed.data : {};
  if (options.json) log(JSON.stringify(data));
  else printPublishResult(data, log);

  if (data.verified !== true) {
    errorLog('site is not live: verified no');
    return 1;
  }
  return 0;
}

module.exports = {
  MAX_PAGE_BYTES,
  MAX_PAGES,
  collectPages,
  normalizePagePath,
  run,
};
