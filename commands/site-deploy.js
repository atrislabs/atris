'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { loadCredentials } = require('../utils/auth');
const { httpRequest } = require('../utils/api');

const DEFAULT_API_BASE = 'https://api.atris.ai';
const RENDER_API_BASE = 'https://api.render.com/v1';
const RENDER_SERVICE_ID = 'srv-culkutq3esus73cvqcg0';
const RENDER_POLL_INTERVAL_MS = 15000;
const RENDER_POLL_TIMEOUT_MS = 10 * 60 * 1000;
const GITHUB_ORG = 'atrislabs';
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

    atris site deploy <dir> --name <slug> [--spa] [--dry-run] --yes
    atris site deploy <dir> --fullstack --name <slug> [--dry-run] --yes
    atris site deploy dist --name my-site --api-base https://api.atris.ai --yes

  names use lowercase letters, digits, and hyphens. files are capped at 2 mb
  each and 200 total. --spa enables single-page app routing. --fullstack
  deploys a node server with a package.json start script. --yes is required
  to publish.
`);
}

function parseArgs(argv) {
  const options = {
    dir: null,
    name: null,
    apiBase: DEFAULT_API_BASE,
    spa: false,
    fullstack: false,
    dryRun: false,
    help: false,
    yes: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === 'help') {
      options.help = true;
    } else if (arg === '--spa') {
      options.spa = true;
    } else if (arg === '--fullstack') {
      options.fullstack = true;
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--yes' || arg === '-y') {
      options.yes = true;
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

function validationDetail(items) {
  const messages = items.map((item) => {
    if (!item || typeof item !== 'object') return String(item);
    const message = item.msg || item.message || item.type || 'validation failed';
    const location = Array.isArray(item.loc) ? item.loc.join('.') : '';
    return location ? `${location}: ${message}` : message;
  });
  return messages.join('; ');
}

function errorDetail(result) {
  const data = parseResponseData(result);
  if (data && typeof data === 'object') {
    const detail = data.detail || data.error || data.message;
    if (Array.isArray(detail)) return validationDetail(detail);
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
    const result = await requestJson(
      'PUT',
      url,
      token,
      batch.map((page) => pagePayload(page, fileSystem)),
      deps,
    );
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

function loadRenderApiKey(deps = {}) {
  if (deps.renderApiKey) return deps.renderApiKey;
  const fileSystem = deps.fs || fs;
  const home = deps.homedir ? deps.homedir() : os.homedir();
  const configPath = path.join(home, '.render', 'cli.yaml');
  if (!fileSystem.existsSync(configPath)) {
    throw new Error('~/.render/cli.yaml was not found');
  }
  let yaml;
  try {
    yaml = fileSystem.readFileSync(configPath, 'utf8');
  } catch (error) {
    throw new Error(`the render config could not be read: ${error.message}`);
  }
  const apiKey = renderApiKey(yaml);
  if (!apiKey) throw new Error('the render api key was not found in ~/.render/cli.yaml');
  return apiKey;
}

function alreadyExists(result) {
  return result.status === 409 || /already[\s_-]*(?:exists|registered)|conflict/i.test(errorDetail(result));
}

function withoutSecret(value, secret) {
  const text = String(value || '');
  return secret ? text.split(secret).join('[redacted]') : text;
}

async function registerSubdomain(slug, deps = {}) {
  const log = deps.log || console.log;
  let apiKey;
  try {
    apiKey = loadRenderApiKey(deps);
  } catch (error) {
    log(`  warning: subdomain registration skipped because ${error.message}`);
    return;
  }

  const base = `${RENDER_API_BASE}/services/${RENDER_SERVICE_ID}/custom-domains`;
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

function fullstackPackage(root, deps = {}) {
  const fileSystem = deps.fs || fs;
  const packagePath = path.join(root, 'package.json');
  if (!fileSystem.existsSync(packagePath)) {
    throw new Error('fullstack deploy needs package.json. add package.json with a "start" script.');
  }

  let packageJson;
  try {
    packageJson = JSON.parse(fileSystem.readFileSync(packagePath, 'utf8'));
  } catch (error) {
    throw new Error(`package.json could not be read. fix its json and add a "start" script: ${error.message}`);
  }
  const scripts = packageJson && packageJson.scripts;
  if (!scripts || typeof scripts.start !== 'string' || !scripts.start.trim()) {
    throw new Error('fullstack deploy needs a start script. add "scripts": { "start": "node server.js" } to package.json.');
  }
  const hasBuild = typeof scripts.build === 'string' && scripts.build.trim();
  return { buildCommand: hasBuild ? 'npm install && npm run build' : 'npm install' };
}

function printFullstackPlan(slug, packagePlan, log) {
  const repoName = `atris-app-${slug}`;
  const repoUrl = `https://github.com/${GITHUB_ORG}/${repoName}`;
  const renderName = `atris-app-${slug}`;
  log('\n  dry run: fullstack deploy');
  log(`  repository ${GITHUB_ORG}/${repoName} (private)`);
  log(`  render service ${renderName}`);
  log(`  repo ${repoUrl}`);
  log('  branch main');
  log('  runtime node');
  log('  plan starter');
  log('  region oregon');
  log(`  build ${packagePlan.buildCommand}`);
  log('  start npm start');
  log('  auto deploy yes');
  log(`  render target https://${renderName}.onrender.com`);
  log(`  target https://${slug}.atris.ai`);
  log('  no network calls made');
}

function commandAttempt(command, args, cwd, deps = {}) {
  const execute = deps.spawnSync || spawnSync;
  return execute(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: 'pipe',
    timeout: 120000,
  });
}

function commandError(command, args, attempt) {
  const detail = String(attempt.stderr || attempt.stdout || '').trim();
  const cause = attempt.error ? attempt.error.message : `exit ${attempt.status}`;
  return new Error(`${command} ${args.join(' ')} failed (${cause})${detail ? `\n${detail}` : ''}`);
}

function requireCommand(command, args, cwd, deps = {}) {
  const attempt = commandAttempt(command, args, cwd, deps);
  if (attempt.error || attempt.status !== 0) throw commandError(command, args, attempt);
  return attempt;
}

function replaceScratchContents(sourceRoot, scratchRepo, deps = {}) {
  const fileSystem = deps.fs || fs;
  for (const entry of fileSystem.readdirSync(scratchRepo)) {
    if (entry !== '.git') fileSystem.rmSync(path.join(scratchRepo, entry), { recursive: true, force: true });
  }
  for (const entry of fileSystem.readdirSync(sourceRoot)) {
    if (entry === '.git' || entry === 'node_modules') continue;
    fileSystem.cpSync(path.join(sourceRoot, entry), path.join(scratchRepo, entry), {
      recursive: true,
      dereference: false,
    });
  }
}

function publishGithubRepo(sourceRoot, slug, deps = {}) {
  const fileSystem = deps.fs || fs;
  const log = deps.log || console.log;
  const repoName = `atris-app-${slug}`;
  const repoPath = `${GITHUB_ORG}/${repoName}`;
  const repoUrl = `https://github.com/${repoPath}`;

  requireCommand('gh', ['auth', 'status'], sourceRoot, deps);
  const viewArgs = ['repo', 'view', repoPath, '--json', 'visibility'];
  const view = commandAttempt('gh', viewArgs, sourceRoot, deps);
  if (view.error) throw commandError('gh', viewArgs, view);
  const repoExists = view.status === 0;
  if (!repoExists) {
    requireCommand('gh', ['repo', 'create', repoPath, '--private'], sourceRoot, deps);
    log(`  created private repository ${repoPath}`);
  } else {
    let visibility = null;
    try { visibility = JSON.parse(view.stdout).visibility; } catch {}
    if (visibility && visibility !== 'PRIVATE') {
      requireCommand('gh', [
        'repo', 'edit', repoPath, '--visibility', 'private',
        '--accept-visibility-change-consequences',
      ], sourceRoot, deps);
    }
    log(`  reusing private repository ${repoPath}`);
  }

  const scratchRoot = fileSystem.mkdtempSync(path.join(os.tmpdir(), 'atris-fullstack-'));
  const scratchRepo = path.join(scratchRoot, 'repo');
  fileSystem.mkdirSync(scratchRepo);
  try {
    requireCommand('git', ['init'], scratchRepo, deps);
    requireCommand('git', ['config', 'user.name', 'Atris'], scratchRepo, deps);
    requireCommand('git', ['config', 'user.email', '299057014+atris-builder[bot]@users.noreply.github.com'], scratchRepo, deps);
    requireCommand('git', ['config', 'commit.gpgsign', 'false'], scratchRepo, deps);
    requireCommand('git', ['remote', 'add', 'origin', `${repoUrl}.git`], scratchRepo, deps);
    if (repoExists) {
      const fetched = commandAttempt('git', ['fetch', '--depth=1', 'origin', 'main'], scratchRepo, deps);
      if (fetched.status === 0) {
        requireCommand('git', ['checkout', '-B', 'main', 'FETCH_HEAD'], scratchRepo, deps);
      } else if (!fetched.error && /remote ref main|couldn't find remote ref/i.test(String(fetched.stderr || ''))) {
        requireCommand('git', ['checkout', '-b', 'main'], scratchRepo, deps);
      } else {
        throw commandError('git', ['fetch', '--depth=1', 'origin', 'main'], fetched);
      }
    } else {
      requireCommand('git', ['checkout', '-b', 'main'], scratchRepo, deps);
    }
    replaceScratchContents(sourceRoot, scratchRepo, deps);
    requireCommand('git', ['add', '--all'], scratchRepo, deps);
    const changed = commandAttempt('git', ['diff', '--cached', '--quiet'], scratchRepo, deps);
    if (changed.error || (changed.status !== 0 && changed.status !== 1)) {
      throw commandError('git', ['diff', '--cached', '--quiet'], changed);
    }
    if (changed.status === 1) {
      requireCommand('git', ['commit', '-m', `deploy ${slug}`], scratchRepo, deps);
    }
    requireCommand('git', ['push', '--set-upstream', 'origin', 'main'], scratchRepo, deps);
  } finally {
    fileSystem.rmSync(scratchRoot, { recursive: true, force: true });
  }
  log(`  pushed source to ${repoPath}`);
  return repoUrl;
}

function serviceFromPayload(payload) {
  if (!payload || typeof payload !== 'object') return null;
  return payload.service || payload;
}

function deployFromPayload(payload) {
  if (!payload || typeof payload !== 'object') return null;
  return payload.deploy || payload;
}

async function renderRequest(method, url, apiKey, body, deps = {}) {
  const response = await requestJson(method, url, apiKey, body, deps);
  if (response.status < 200 || response.status >= 300) throw requestError(method, url, response);
  return parseResponseData(response);
}

async function ensureRenderService(slug, repoUrl, buildCommand, apiKey, deps = {}) {
  const log = deps.log || console.log;
  const serviceName = `atris-app-${slug}`;
  const listUrl = `${RENDER_API_BASE}/services?name=${encodeURIComponent(serviceName)}&limit=100`;
  const listed = await renderRequest('GET', listUrl, apiKey, undefined, deps);
  const entries = Array.isArray(listed) ? listed : [];
  const existing = entries.map(serviceFromPayload).find((service) => service && service.name === serviceName);
  if (existing) {
    log(`  reusing render service ${serviceName}`);
    const deployPayload = await renderRequest(
      'POST',
      `${RENDER_API_BASE}/services/${encodeURIComponent(existing.id)}/deploys`,
      apiKey,
      undefined,
      deps,
    );
    return { service: existing, deploy: deployFromPayload(deployPayload) };
  }

  const backendPayload = await renderRequest(
    'GET',
    `${RENDER_API_BASE}/services/${RENDER_SERVICE_ID}`,
    apiKey,
    undefined,
    deps,
  );
  const backendService = serviceFromPayload(backendPayload);
  if (!backendService || !backendService.ownerId) {
    throw new Error(`render service ${RENDER_SERVICE_ID} did not return a workspace id`);
  }
  const servicePayload = await renderRequest('POST', `${RENDER_API_BASE}/services`, apiKey, {
    type: 'web_service',
    name: serviceName,
    ownerId: backendService.ownerId,
    repo: repoUrl,
    branch: 'main',
    autoDeploy: 'yes',
    serviceDetails: {
      runtime: 'node',
      plan: 'starter',
      region: 'oregon',
      envSpecificDetails: {
        buildCommand,
        startCommand: 'npm start',
      },
    },
  }, deps);
  const created = serviceFromPayload(servicePayload);
  if (!created || !created.id) throw new Error(`render did not return the new service ${serviceName}`);
  log(`  created render service ${serviceName}`);
  return { service: created, deploy: null };
}

async function pollRenderDeploy(serviceId, initialDeploy, apiKey, deps = {}) {
  const log = deps.log || console.log;
  const sleep = deps.sleep || ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const interval = deps.pollIntervalMs === undefined ? RENDER_POLL_INTERVAL_MS : deps.pollIntervalMs;
  const timeout = deps.pollTimeoutMs === undefined ? RENDER_POLL_TIMEOUT_MS : deps.pollTimeoutMs;
  const maxPolls = Math.max(1, Math.floor(timeout / Math.max(1, interval)) + 1);
  const deployId = initialDeploy && initialDeploy.id;

  for (let poll = 0; poll < maxPolls; poll += 1) {
    let deploy;
    if (deployId) {
      const payload = await renderRequest(
        'GET',
        `${RENDER_API_BASE}/services/${encodeURIComponent(serviceId)}/deploys/${encodeURIComponent(deployId)}`,
        apiKey,
        undefined,
        deps,
      );
      deploy = deployFromPayload(payload);
    } else {
      const payload = await renderRequest(
        'GET',
        `${RENDER_API_BASE}/services/${encodeURIComponent(serviceId)}/deploys?limit=1`,
        apiKey,
        undefined,
        deps,
      );
      const first = Array.isArray(payload) ? payload[0] : null;
      deploy = deployFromPayload(first);
    }
    const status = deploy && deploy.status ? deploy.status : 'waiting';
    log(`  render deploy status: ${status}`);
    if (status === 'live') return deploy;
    if (/failed|canceled|deactivated/.test(status)) {
      throw new Error(`render deploy ${status}`);
    }
    if (poll + 1 < maxPolls) await sleep(interval);
  }
  throw new Error('render deploy did not go live within 10 minutes');
}

function proxyTargetFromService(service) {
  const rawUrl = service && ((service.serviceDetails && service.serviceDetails.url) || service.url);
  if (!rawUrl) return null;
  try {
    return new URL(rawUrl).hostname;
  } catch {
    return String(rawUrl).replace(/^https?:\/\//, '').replace(/\/$/, '');
  }
}

async function renderProxyTarget(service, apiKey, deps = {}) {
  let proxyTarget = proxyTargetFromService(service);
  if (!proxyTarget) {
    const payload = await renderRequest(
      'GET',
      `${RENDER_API_BASE}/services/${encodeURIComponent(service.id)}`,
      apiKey,
      undefined,
      deps,
    );
    proxyTarget = proxyTargetFromService(serviceFromPayload(payload));
  }
  if (!proxyTarget) throw new Error(`render service ${service.name || service.id} did not return its url`);
  if (!/^[a-z0-9-]+\.onrender\.com$/i.test(proxyTarget)) {
    throw new Error(`render service ${service.name || service.id} returned an invalid proxy target`);
  }
  return proxyTarget;
}

async function setProxyTarget(sitesUrl, slug, proxyTarget, token, deps = {}) {
  const log = deps.log || console.log;
  const url = `${sitesUrl}/${slug}`;
  const body = { proxy_target: proxyTarget };
  const response = await requestJson('PATCH', url, token, body, deps);
  if (response.status >= 200 && response.status < 300) {
    log(`  wired ${slug}.atris.ai to ${proxyTarget}`);
    return true;
  }
  const detail = errorDetail(response);
  if ((response.status === 400 || response.status === 422) && /proxy_target|unknown|extra|unexpected|not permitted/i.test(detail)) {
    log(`  warning: the atris api does not accept proxy_target yet: ${detail}`);
    log(`  retry later: PATCH ${url} with ${JSON.stringify(body)}`);
    return false;
  }
  throw requestError('PATCH', url, response);
}

async function runFullstack(root, options, packagePlan, deps = {}) {
  const log = deps.log || console.log;
  const errorLog = deps.error || console.error;
  let credentials;
  let apiKey;
  try {
    const readCredentials = deps.loadCredentials || loadCredentials;
    credentials = readCredentials();
    if (!credentials || !credentials.token) {
      errorLog('  not logged in. run atris login first.');
      return 1;
    }
    apiKey = loadRenderApiKey(deps);
    const repoUrl = publishGithubRepo(root, options.name, { ...deps, log });
    const render = await ensureRenderService(options.name, repoUrl, packagePlan.buildCommand, apiKey, { ...deps, log });
    await pollRenderDeploy(render.service.id, render.deploy, apiKey, { ...deps, log });
    const proxyTarget = await renderProxyTarget(render.service, apiKey, deps);
    const sitesUrl = `${options.apiBase}/api/sites`;
    await createSite(sitesUrl, options.name, false, credentials.token, { ...deps, log });
    const wired = await setProxyTarget(sitesUrl, options.name, proxyTarget, credentials.token, { ...deps, log });
    await registerSubdomain(options.name, { ...deps, log, renderApiKey: apiKey });
    if (wired) log(`\n  live at https://${options.name}.atris.ai`);
    else log('\n  render infrastructure is ready. retry the proxy patch above to finish the address.');
    return 0;
  } catch (error) {
    const withoutRenderKey = withoutSecret(error.message, apiKey);
    const safeMessage = withoutSecret(withoutRenderKey, credentials && credentials.token);
    errorLog(`  fullstack deploy failed: ${safeMessage}`);
    return 1;
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

  if (options.fullstack) {
    let packagePlan;
    try {
      packagePlan = fullstackPackage(root, deps);
    } catch (error) {
      errorLog(`  ${error.message}`);
      return 2;
    }
    if (options.dryRun) {
      printFullstackPlan(options.name, packagePlan, log);
      return 0;
    }
    if (!options.yes) {
      errorLog('  Pass --yes to publish.');
      return 2;
    }
    return runFullstack(root, { ...options, apiBase }, packagePlan, deps);
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

  if (!options.yes) {
    errorLog('  Pass --yes to publish.');
    return 2;
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
    await registerSubdomain(options.name, { ...deps, log });
    await uploadPages(sitesUrl, options.name, pages, credentials.token, { ...deps, log });
  } catch (error) {
    errorLog(`  deploy failed: ${error.message}`);
    return 1;
  }

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
