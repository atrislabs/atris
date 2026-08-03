'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadCredentials } = require('../utils/auth');
const { httpRequest } = require('../utils/api');

const DEFAULT_API_BASE = 'https://api.atris.ai';
const RENDER_SERVICE_ID = 'srv-culkutq3esus73cvqcg0';
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_FILES = 200;
const BATCH_SIZE = 50;
const RESERVED_NAMES = new Set([
  'api', 'www', 'app', 'share', 'admin', 'mail', 'staging', 'status',
  'docs', 'blog', 'dev', 'dashboard', 'auth', 'cdn', 'assets',
]);

const TEXT_CONTENT_TYPES = Object.freeze({
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.webmanifest': 'application/manifest+json',
  '.map': 'application/json',
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
});

function printHelp() {
  console.log(`
  atris site deploy: publish a web folder at a free atris.ai subdomain

    atris site deploy <dir> --name <slug> [--spa] [--dry-run]
    atris site deploy dist --name my-site --api-base https://api.atris.ai

  names use lowercase letters, digits, and hyphens. files are capped at 2 mb
  each and 200 total. --spa enables single-page app routing.
`);
}

function parseArgs(argv) {
  const options = {
    dir: null,
    name: null,
    apiBase: DEFAULT_API_BASE,
    spa: false,
    dryRun: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === 'help') {
      options.help = true;
    } else if (arg === '--spa') {
      options.spa = true;
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--name' || arg === '--api-base') {
      const value = argv[i + 1];
      if (!value || value.startsWith('-')) throw new Error(`${arg} needs a value`);
      if (arg === '--name') options.name = value;
      else options.apiBase = value;
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

function validateSlug(slug) {
  if (!slug) return '--name is required';
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(slug)) {
    return 'name must use lowercase letters, digits, and hyphens, with no hyphen at either end';
  }
  if (RESERVED_NAMES.has(slug)) return `name is reserved: ${slug}`;
  return null;
}

function validateApiBase(value) {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('bad protocol');
    return parsed.toString().replace(/\/$/, '');
  } catch {
    throw new Error('--api-base must be a valid http or https url');
  }
}

function relativePath(root, filePath) {
  return path.relative(root, filePath).split(path.sep).join('/');
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} b`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kb`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} mb`;
}

function skip(relative, reason, log) {
  log(`  skipped ${relative}: ${reason}`);
}

function collectPages(root, deps = {}) {
  const fileSystem = deps.fs || fs;
  const log = deps.log || console.log;
  const pages = [];

  function walk(current) {
    const entries = fileSystem.readdirSync(current, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      const relative = relativePath(root, absolute);
      const shown = entry.isDirectory() ? `${relative}/` : relative;

      if (entry.name === 'node_modules' || entry.name === '.git') {
        skip(shown, 'ignored directory', log);
        continue;
      }
      if (entry.name.startsWith('.')) {
        skip(shown, 'dotfiles are ignored', log);
        continue;
      }
      if (entry.isSymbolicLink()) {
        skip(shown, 'symbolic links are ignored', log);
        continue;
      }
      if (entry.isDirectory()) {
        walk(absolute);
        continue;
      }
      if (!entry.isFile()) {
        skip(relative, 'not a regular file', log);
        continue;
      }

      const extension = path.extname(entry.name).toLowerCase();
      const contentType = TEXT_CONTENT_TYPES[extension] || BINARY_CONTENT_TYPES[extension];
      if (!contentType) {
        skip(relative, 'unsupported file type', log);
        continue;
      }

      let size;
      try {
        size = fileSystem.statSync(absolute).size;
        if (typeof fileSystem.accessSync === 'function') {
          fileSystem.accessSync(absolute, (fileSystem.constants || fs.constants).R_OK);
        }
      } catch (error) {
        skip(relative, `could not read file: ${error.message}`, log);
        continue;
      }
      if (size > MAX_FILE_BYTES) {
        skip(relative, `larger than ${formatBytes(MAX_FILE_BYTES)}`, log);
        continue;
      }
      if (pages.length >= MAX_FILES) {
        skip(relative, `file limit of ${MAX_FILES} reached`, log);
        continue;
      }

      const isBase64 = Object.prototype.hasOwnProperty.call(BINARY_CONTENT_TYPES, extension);
      pages.push({
        path: relative,
        sourcePath: absolute,
        content_type: contentType,
        is_base64: isBase64,
        size,
      });
    }
  }

  walk(root);
  return pages;
}

function responseText(result) {
  const body = result && result.body;
  if (!body) return '';
  return Buffer.isBuffer(body) ? body.toString('utf8') : String(body);
}

function parseResponseData(result) {
  const text = responseText(result);
  if (!text.trim()) return null;
  try { return JSON.parse(text); } catch { return null; }
}

function errorDetail(result) {
  const data = parseResponseData(result);
  if (data && typeof data === 'object') {
    const detail = data.detail || data.error || data.message;
    if (detail) return typeof detail === 'string' ? detail : JSON.stringify(detail);
  }
  return responseText(result).trim() || 'request failed';
}

async function requestJson(method, url, token, body, deps = {}) {
  const request = deps.httpRequest || httpRequest;
  const payload = body === undefined ? null : JSON.stringify(body);
  return request(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    ...(payload === null ? {} : { body: payload }),
    timeoutMs: 60000,
  });
}

function requestError(method, url, result) {
  return new Error(`${method} ${url} failed (${result.status || 0}): ${errorDetail(result)}`);
}

async function setSpa(sitesUrl, slug, token, deps = {}) {
  const log = deps.log || console.log;
  const url = `${sitesUrl}/${slug}`;
  let result;
  try {
    result = await requestJson('PATCH', url, token, { spa: true }, deps);
  } catch (error) {
    log(`  warning: spa routing could not be enabled: ${error.message}`);
    return;
  }
  if (result.status < 200 || result.status >= 300) {
    log(`  warning: spa routing was not accepted by the server: ${errorDetail(result)}`);
  }
}

async function createSite(sitesUrl, slug, spa, token, deps = {}) {
  const log = deps.log || console.log;
  const body = spa ? { slug, spa: true } : { slug };
  let result = await requestJson('POST', sitesUrl, token, body, deps);

  if (result.status >= 200 && result.status < 300) {
    log(`  created site ${slug}`);
    return;
  }

  if (result.status === 409) {
    log(`  site ${slug} already exists`);
    if (spa) await setSpa(sitesUrl, slug, token, deps);
    return;
  }

  if (spa && (result.status === 400 || result.status === 422)) {
    const rejectedSpa = errorDetail(result);
    result = await requestJson('POST', sitesUrl, token, { slug }, deps);
    if ((result.status >= 200 && result.status < 300) || result.status === 409) {
      log(`  warning: spa routing was not accepted during site creation: ${rejectedSpa}`);
      if (result.status === 409) {
        log(`  site ${slug} already exists`);
        await setSpa(sitesUrl, slug, token, deps);
      } else {
        log(`  created site ${slug}`);
      }
      return;
    }
  }

  throw requestError('POST', sitesUrl, result);
}

function pagePayload(page, fileSystem) {
  const bytes = fileSystem.readFileSync(page.sourcePath);
  return {
    path: page.path,
    content: page.is_base64 ? bytes.toString('base64') : bytes.toString('utf8'),
    content_type: page.content_type,
    is_base64: page.is_base64,
  };
}

async function uploadPages(sitesUrl, slug, pages, token, deps = {}) {
  const fileSystem = deps.fs || fs;
  const log = deps.log || console.log;
  const url = `${sitesUrl}/${slug}/pages`;
  for (let start = 0; start < pages.length; start += BATCH_SIZE) {
    const batch = pages.slice(start, start + BATCH_SIZE);
    const result = await requestJson('PUT', url, token, {
      pages: batch.map((page) => pagePayload(page, fileSystem)),
    }, deps);
    if (result.status < 200 || result.status >= 300) throw requestError('PUT', url, result);
    for (const page of batch) log(`  published ${page.path} (${formatBytes(page.size)})`);
  }
}

function parseYamlScalar(value) {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try { return JSON.parse(trimmed); } catch { return null; }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }
  return trimmed.split(/\s+#/)[0].trim() || null;
}

function renderApiKey(yaml) {
  const lines = String(yaml).split(/\r?\n/);
  let apiIndent = null;
  for (const line of lines) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const indent = line.match(/^\s*/)[0].length;
    if (apiIndent === null) {
      if (/^\s*api:\s*(?:#.*)?$/.test(line)) apiIndent = indent;
      continue;
    }
    if (indent <= apiIndent) break;
    const match = line.match(/^\s*key:\s*(.*?)\s*$/);
    if (match) return parseYamlScalar(match[1]);
  }
  return null;
}

function alreadyExists(result) {
  return result.status === 409 || /already[\s_-]*(?:exists|registered)|conflict/i.test(errorDetail(result));
}

function withoutSecret(value, secret) {
  const text = String(value || '');
  return secret ? text.split(secret).join('[redacted]') : text;
}

async function registerSubdomain(slug, deps = {}) {
  const fileSystem = deps.fs || fs;
  const home = deps.homedir ? deps.homedir() : os.homedir();
  const log = deps.log || console.log;
  const configPath = path.join(home, '.render', 'cli.yaml');
  if (!fileSystem.existsSync(configPath)) {
    log('  warning: subdomain registration skipped because ~/.render/cli.yaml was not found');
    return;
  }

  let apiKey;
  try {
    apiKey = renderApiKey(fileSystem.readFileSync(configPath, 'utf8'));
  } catch (error) {
    log(`  warning: subdomain registration skipped because the render config could not be read: ${error.message}`);
    return;
  }
  if (!apiKey) {
    log('  warning: subdomain registration skipped because the render api key was not found');
    return;
  }

  const base = `https://api.render.com/v1/services/${RENDER_SERVICE_ID}/custom-domains`;
  let created;
  try {
    created = await requestJson('POST', base, apiKey, { name: `${slug}.atris.ai` }, deps);
  } catch (error) {
    log(`  warning: subdomain registration failed: ${withoutSecret(error.message, apiKey)}`);
    return;
  }

  const data = parseResponseData(created);
  const id = data && (data.id || (data.customDomain && data.customDomain.id));
  if (alreadyExists(created)) {
    log(`  subdomain ${slug}.atris.ai is already registered`);
    if (!id) return;
  } else if (created.status < 200 || created.status >= 300) {
    log(`  warning: subdomain registration failed (${created.status || 0}): ${withoutSecret(errorDetail(created), apiKey)}`);
    return;
  } else {
    log(`  registered subdomain ${slug}.atris.ai`);
  }

  if (!id) return;

  const verifyUrl = `${base}/${encodeURIComponent(id)}/verify`;
  try {
    const verified = await requestJson('POST', verifyUrl, apiKey, undefined, deps);
    if (verified.status >= 200 && verified.status < 300) {
      log(`  verified subdomain ${slug}.atris.ai`);
    } else {
      log(`  warning: subdomain verification failed (${verified.status || 0}): ${withoutSecret(errorDetail(verified), apiKey)}`);
    }
  } catch (error) {
    log(`  warning: subdomain verification failed: ${withoutSecret(error.message, apiKey)}`);
  }
}

async function run(argv, deps = {}) {
  const log = deps.log || console.log;
  const errorLog = deps.error || console.error;
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    errorLog(`  ${error.message}`);
    return 2;
  }

  if (options.help) {
    printHelp();
    return 0;
  }
  if (!options.dir) {
    errorLog('  site deploy needs a directory');
    return 2;
  }
  const slugError = validateSlug(options.name);
  if (slugError) {
    errorLog(`  ${slugError}`);
    return 2;
  }

  let apiBase;
  try {
    apiBase = validateApiBase(options.apiBase);
  } catch (error) {
    errorLog(`  ${error.message}`);
    return 2;
  }

  const root = path.resolve(options.dir);
  const fileSystem = deps.fs || fs;
  let stat;
  try {
    stat = fileSystem.statSync(root);
  } catch {
    errorLog(`  site directory does not exist: ${root}`);
    return 2;
  }
  if (!stat.isDirectory()) {
    errorLog(`  site path is not a directory: ${root}`);
    return 2;
  }

  let pages;
  try {
    pages = collectPages(root, { ...deps, log });
  } catch (error) {
    errorLog(`  could not read site directory: ${error.message}`);
    return 1;
  }

  const liveUrl = `https://${options.name}.atris.ai`;
  const totalBytes = pages.reduce((sum, page) => sum + page.size, 0);
  if (options.dryRun) {
    log(`\n  dry run: ${pages.length} file${pages.length === 1 ? '' : 's'}, ${formatBytes(totalBytes)}`);
    for (const page of pages) log(`  would publish ${page.path} (${formatBytes(page.size)})`);
    log(`  target ${liveUrl}`);
    log('  no network calls made');
    return 0;
  }

  const readCredentials = deps.loadCredentials || loadCredentials;
  const credentials = readCredentials();
  if (!credentials || !credentials.token) {
    errorLog('  not logged in. run atris login first.');
    return 1;
  }

  const sitesUrl = `${apiBase}/api/sites`;
  log(`\n  deploying ${pages.length} file${pages.length === 1 ? '' : 's'} to ${liveUrl}`);
  try {
    await createSite(sitesUrl, options.name, options.spa, credentials.token, { ...deps, log });
    await uploadPages(sitesUrl, options.name, pages, credentials.token, { ...deps, log });
  } catch (error) {
    errorLog(`  deploy failed: ${error.message}`);
    return 1;
  }

  await registerSubdomain(options.name, { ...deps, log });
  log(`\n  live at ${liveUrl}`);
  return 0;
}

module.exports = {
  BATCH_SIZE,
  MAX_FILE_BYTES,
  MAX_FILES,
  collectPages,
  parseArgs,
  registerSubdomain,
  renderApiKey,
  run,
  validateSlug,
};
