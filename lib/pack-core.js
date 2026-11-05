'use strict';

const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');
const { apiRequestJson, getApiBaseUrl, getAppBaseUrl, httpRequest } = require('../utils/api');
const { loadCredentials, performTokenRefresh } = require('../utils/auth');
const { ZIP_LIMITS } = require('./zip');
const { assertPackCapabilityPolicy } = require('./pack-capabilities');

const REGISTRY_TIMEOUT_MS = 60000;
const PACK_RUN_INPUT_MAX_BYTES = 256 * 1024;
const PACK_VISIBILITIES = new Set(['public', 'unlisted', 'private']);
const DEFAULT_SHARE_DAYS = 30;
const MAX_SHARE_DAYS = 365;
const MAX_SHARE_RECIPIENT_LENGTH = 120;
const SHARE_NONCE_RULE = /^[A-Za-z0-9_-]{22}$/;
const PACK_BROWSE_LIMIT = 50;

// The web registry caps every upload (atrisos-web app/api/pack/registry/route.ts).
// The ZIP reader uses the same limits so inbound packs cannot expand past them.
const REGISTRY_LIMITS = ZIP_LIMITS;

// The web viewer rejects anything else (atrisos-web app/lib/pack/manifests.ts).
const SLUG_RULE = /^[a-z0-9-]{3,40}$/;

// ── The packet allowlist ────────────────────────────────────────────────────
// A packet is the shareable knowledge spine of a workspace, not the folder it
// lives in. Only what a stranger could read and learn from ships: the map and
// readme layer, member and team definitions, the wiki, skills, policies, refs,
// features. Runtime exhaust (runs/, logs/, journal/, status/, .atris/),
// dependencies, binaries and lockfiles never ship.
//
// This table is the whole rule. Audit it here, not in scattered ifs.
// (2026-07-27: the denylist that preceded it shipped a 94 MB zip containing
// node_modules, customer folders and a live JWT.)
const PACKET = {
  // Folders whose contents ship. Checked at the first level under the pack
  // root and under atris/. Anything not listed here is skipped.
  directories: [
    'features',    // what got built, and why
    'wiki',        // ingested knowledge
    'skills',      // reusable procedures
    'team',        // member and role definitions
    'policies',    // house rules
    'refs',        // stable reference tables
    'reference',
    'checklists',
    'templates',
    'guides',
    'docs',
    'briefs',
    'playbooks',
  ],
  // Root-level files ship only as documents: the map, the readme, the persona.
  rootExtensions: ['.md', '.markdown', '.txt'],
  // ...plus the manifest itself.
  rootFiles: ['pack.json'],
  // Inside an allowed folder, only these extensions ship. Text only.
  extensions: ['.md', '.markdown', '.txt', '.yml', '.yaml', '.json', '.toml', '.csv'],
  // Path segments that never ship, at any depth. Runtime exhaust and deps.
  deniedSegments: [
    'runs', 'logs', 'journal', 'status', 'missions', 'queue', 'tmp', 'cache',
    '.atris', '.git', '.upstream', '.venv', 'venv', 'node_modules',
    '__pycache__', 'dist', 'build', 'coverage', '_archive',
    // Proof folders are receipts of runs that already happened, not knowledge a
    // stranger can use. A packet ships the feature definition, not its history.
    // (2026-07-27: features/*/proof was 1,253 files and 76% of the unpacked
    // weight of the atrisos-backend workspace.)
    'proof',
    // Same class as proof: a receipt records that a run happened. Kept as its
    // own entry so the principle stays legible rather than reading as one
    // grab-bag of excluded words.
    'receipts',
  ],
  // Segments that get their own skip reason, because "runtime exhaust" does not
  // explain why a folder full of readable markdown was left out.
  segmentReasons: {
    proof: 'proof artifacts are excluded (receipts of past runs, not knowledge)',
    receipts: 'receipts are excluded (records of past runs, not knowledge)',
  },

  // ── definitions, not state ────────────────────────────────────────────────
  // A packet carries what a thing IS, never what it is currently DOING. The
  // definition files travel: MEMBER.md, MISSION.md, SKILL.md, SOUL.md,
  // README.md, wiki pages, policies. The running state a live workspace keeps
  // beside them stays home: a stranger cannot use someone else's standup notes,
  // and project-management exhaust is most of the file count.
  //
  // The rule is matched on FILENAME, not on folder path, so it generalizes to
  // any Atris workspace instead of naming the folders of one.
  // (2026-07-27, atrisos-backend/atris: team/ was 939 eligible files of which
  // only ~129 were definitions; features/ was 1,183 of which only 43 were
  // README.md. The rest were now.md/goals.md, dated journals, and the
  // idea/build/validate plan-do-review triplet.)
  runningStateNames: [
    'now.md',       // what this member/feature is doing right now
    'goals.md',     // this workspace's current targets
    'idea.md',      // the plan-do-review triplet: an internal tracker, not a
    'build.md',     // description of the thing. features/*/README.md is the
    'validate.md',  // definition and it still ships.
  ],
  // Dated journal entries, at any depth: 2026-07-06.md, 2026-07-06-retro.md.
  runningStatePatterns: [/^\d{4}-\d{2}-\d{2}(?:[-_][^.]*)?\.[a-z0-9]+$/i],
  runningStateReason: 'running state is excluded (a pack carries definitions, not state)',
  // Exact filenames that never ship.
  deniedNames: [
    'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'poetry.lock',
    'cargo.lock', 'uv.lock', '.ds_store',
  ],
  // Secret-shaped filenames that never ship, at any depth.
  deniedPatterns: [
    /^credentials/i, /^\.env/i, /\.pem$/i, /\.key$/i, /^id_rsa/i, /^id_ed25519/i,
  ],
};

// Credential shapes. A hit blocks the publish; the match is redacted, never
// echoed, because the point of the scan is to stop the secret from travelling.
const SECRET_PATTERNS = [
  { label: 'jwt', regex: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  { label: 'api key', regex: /\b(?:sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{16,}|gho_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16})/g },
  { label: 'private key', regex: /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/g },
  { label: 'database url with password', regex: /\b(?:postgres(?:ql)?|mysql):\/\/[^\s:/@]+:[^\s/@]{3,}@\S+/g },
  { label: 'inline credential', regex: /\b(?:api[_-]?key|secret|token|password)\s*[:=]\s*(\S{12,})/gi },
];

// Docs are full of examples. A value that is obviously a stand-in is not a leak.
const SECRET_PLACEHOLDER = /^(?:<|\{|\$|\.\.\.|x{6,}|\*{4,}|-{4,}|your[-_ ]|my[-_]|some[-_]|placeholder|example|redacted|changeme|dummy|fake|test[-_]|null|true|false|undefined)/i;

// The generic `token = ...` rule fires on code samples far more often than on
// real leaks, so a hit must also look like an opaque credential: one run of
// credential characters, not an expression, an env lookup, or a CONSTANT_NAME.
const CREDENTIAL_VALUE = /^[A-Za-z0-9_\-.+/=:~]{16,}$/;
const CREDENTIAL_REFERENCE = /process\.env|os\.environ|os\.getenv|getenv|ENV\[|env\.|config\.|settings\.|self\.|this\.|_el\./i;
const CONSTANT_NAME = /^[A-Z][A-Z0-9_]*$/;
const FILE_PATH_VALUE = /^[~/]|^\.{1,2}\//;
const ENV_ASSIGNMENT = /=(?!=*$)/;

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

function takeValues(args, name) {
  const values = [];
  while (args.some((arg) => String(arg) === name || String(arg).startsWith(`${name}=`))) {
    values.push(takeValue(args, name));
  }
  return values;
}

function takeFlag(args, name, options = {}) {
  const index = args.indexOf(name);
  if (index === -1) return false;
  const next = args[index + 1];
  if (options.optionalValue && next !== undefined && !String(next).startsWith('--')) {
    args.splice(index, 2);
    return next;
  }
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
  const hasExistingManifest = existing && typeof existing === 'object';
  const priceCents = existingManifest.priceCents;
  if (priceCents !== undefined && (!Number.isSafeInteger(priceCents) || priceCents < 0)) {
    throw new Error('pack.json priceCents must be a non-negative integer');
  }
  const slug = slugify(options.slug || existingManifest.slug || options.fallbackSlug);
  const version = existingManifest.version
    ? bumpVersion(existingManifest.version, options.bump)
    : '0.1.0';
  const title = existingManifest.title || titleFromSlug(slug);
  let visibility;
  if (options.visibility !== null && options.visibility !== undefined) {
    visibility = String(options.visibility);
  } else if (Object.prototype.hasOwnProperty.call(existingManifest, 'visibility')) {
    visibility = existingManifest.visibility;
  } else if (!hasExistingManifest) {
    visibility = 'unlisted';
  }
  if (visibility !== undefined && !PACK_VISIBILITIES.has(visibility)) {
    throw new Error('pack visibility must be public, unlisted, or private');
  }
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
  if (visibility !== undefined) manifest.visibility = visibility;
  if (priceCents !== undefined) manifest.priceCents = priceCents;
  // Entry-contract and provenance fields must survive republish, or inspect's
  // trust surface goes blank the moment a pack ships.
  for (const key of [
    'type', 'entrypoint', 'verifier', 'permissions', 'origin',
    'created-in', 'createdIn', 'learned-at', 'learnedAt',
    'source-urls', 'sourceUrls', 'sources',
  ]) {
    if (existingManifest[key] !== undefined) manifest[key] = existingManifest[key];
  }
  if (manifest.permissions !== undefined) assertPackCapabilityPolicy(manifest.permissions);
  manifest.versions.push({
    version,
    date: new Date().toISOString(),
    // the registry rejects entries with empty notes, so never write one
    notes: options.notes || 'version bump',
  });
  return manifest;
}

function packetDirectories(includeLogs) {
  return includeLogs ? [...PACKET.directories, 'logs', 'journal'] : PACKET.directories;
}

function packetDeniedSegments(includeLogs) {
  if (!includeLogs) return PACKET.deniedSegments;
  return PACKET.deniedSegments.filter((segment) => segment !== 'logs' && segment !== 'journal');
}

// Definitions travel, running state stays home. Judged on the filename alone
// so the rule holds in any workspace, whatever its folders are called.
function isRunningStateName(lowerBase) {
  if (PACKET.runningStateNames.includes(lowerBase)) return true;
  return PACKET.runningStatePatterns.some((pattern) => pattern.test(lowerBase));
}

// Paths are judged relative to the pack root, so `atris/` is transparent: the
// same table decides `wiki/page.md` in a crafted pack and `atris/wiki/page.md`
// in a workspace publish.
function classifyPacketPath(relativePath, { includeLogs = false, isDirectory = false } = {}) {
  const normalized = String(relativePath).replace(/\\/g, '/');
  const parts = normalized.split('/').filter(Boolean);
  const basename = parts[parts.length - 1] || '';
  const lowerBase = basename.toLowerCase();
  const denied = packetDeniedSegments(includeLogs);

  for (const part of parts) {
    if (denied.includes(part)) {
      const reason = PACKET.segmentReasons[part];
      return { ok: false, reason: reason || `runtime exhaust or dependency (${part}/)` };
    }
  }
  if (PACKET.deniedNames.includes(lowerBase)) return { ok: false, reason: 'lockfile or editor junk' };
  if (PACKET.deniedPatterns.some((pattern) => pattern.test(basename))) {
    return { ok: false, reason: 'secret-shaped filename' };
  }
  if (!isDirectory && isRunningStateName(lowerBase)) {
    return { ok: false, reason: PACKET.runningStateReason };
  }

  const inner = parts[0] === 'atris' ? parts.slice(1) : parts;
  if (!inner.length) return { ok: true };
  if (isDirectory) {
    if (inner.length > 1) return { ok: true };
    return packetDirectories(includeLogs).includes(inner[0])
      ? { ok: true }
      : { ok: false, reason: `not in the pack allowlist (${inner[0]}/)` };
  }

  const extension = path.extname(lowerBase);
  if (inner.length === 1) {
    if (PACKET.rootFiles.includes(lowerBase)) return { ok: true };
    return PACKET.rootExtensions.includes(extension)
      ? { ok: true }
      : { ok: false, reason: 'not a root document (.md/.txt)' };
  }
  if (!packetDirectories(includeLogs).includes(inner[0])) {
    return { ok: false, reason: `not in the pack allowlist (${inner[0]}/)` };
  }
  return PACKET.extensions.includes(extension)
    ? { ok: true }
    : { ok: false, reason: `not a text file type (${extension || 'no extension'})` };
}

// The registry rejects non-UTF-8 members, and a stranger cannot read a binary
// anyway, so prove it decodes before shipping it.
function isUtf8Text(buffer) {
  if (buffer.includes(0)) return false;
  return Buffer.compare(Buffer.from(buffer.toString('utf8'), 'utf8'), buffer) === 0;
}

// A crafted pack keeps wiki/, README.md, and friends at the pack root, so a
// root publish walks the whole folder, not just atris/ (2026-07-09: the first
// dogfooded pack shipped without its research).
function collectPacketEntries(sourceDir, { prefix = '', includeLogs = false } = {}) {
  const entries = [];
  const skipped = [];

  function record(relative, reason) {
    skipped.push({ path: prefix ? `${prefix}/${relative}` : relative, reason });
  }

  function walk(dir, relativeDir = '') {
    const names = fs.readdirSync(dir).sort();
    for (const name of names) {
      const abs = path.join(dir, name);
      const rel = (relativeDir ? `${relativeDir}/${name}` : name).replace(/\\/g, '/');
      const scoped = prefix ? `${prefix}/${rel}` : rel;
      let stat;
      try {
        stat = fs.statSync(abs);
      } catch {
        record(rel, 'unreadable');
        continue;
      }
      if (stat.isDirectory()) {
        const verdict = classifyPacketPath(scoped, { includeLogs, isDirectory: true });
        if (!verdict.ok) {
          record(`${rel}/`, verdict.reason);
          continue;
        }
        walk(abs, rel);
        continue;
      }
      if (!stat.isFile()) continue;
      const verdict = classifyPacketPath(scoped, { includeLogs });
      if (!verdict.ok) {
        record(rel, verdict.reason);
        continue;
      }
      const data = fs.readFileSync(abs);
      if (!isUtf8Text(data)) {
        record(rel, 'not valid utf-8 text');
        continue;
      }
      entries.push({ name: scoped, data, mtime: stat.mtime });
    }
  }

  walk(sourceDir);
  return { entries, skipped };
}

function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

function canonicalZipEntryName(name) {
  return path.posix.normalize(String(name || '').replace(/\\/g, '/'));
}

function canonicalContentPath(value) {
  const raw = String(value || '');
  if (!raw || raw.includes('\\') || raw.startsWith('/') || raw.endsWith('/')) return null;
  const normalized = path.posix.normalize(raw);
  if (normalized !== raw || normalized === '.' || normalized === 'pack.json') return null;
  if (normalized.split('/').includes('..')) return null;
  return normalized;
}

function contentEntries(entries) {
  return entries.filter((entry) => {
    const raw = String(entry.name || '').replace(/\\/g, '/');
    return raw && !raw.endsWith('/') && canonicalZipEntryName(raw) !== 'pack.json';
  });
}

function buildContentHashes(entries) {
  return Object.fromEntries(
    contentEntries(entries)
      .map((entry) => [canonicalZipEntryName(entry.name), sha256(entry.data)])
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

function parseContentHashes(manifest) {
  if (!Object.prototype.hasOwnProperty.call(manifest, 'content-hashes')) {
    return { present: false, hashes: new Map() };
  }
  const declared = manifest['content-hashes'];
  if (!declared || typeof declared !== 'object' || Array.isArray(declared)) {
    throw new Error('pack.json content-hashes must be an object of path to lowercase SHA-256');
  }

  const hashes = new Map();
  for (const [rawPath, digest] of Object.entries(declared)) {
    const contentPath = canonicalContentPath(rawPath);
    if (!contentPath) {
      throw new Error(`pack.json content-hashes has invalid path: ${rawPath}`);
    }
    if (typeof digest !== 'string' || !/^[0-9a-f]{64}$/.test(digest)) {
      throw new Error(`pack.json content-hashes has invalid SHA-256 for ${rawPath}`);
    }
    hashes.set(contentPath, digest);
  }
  return { present: true, hashes };
}

function verifyArchiveContentHashes(entries, manifest) {
  const declared = parseContentHashes(manifest);
  if (declared.present) {
    for (const entry of entries) {
      const raw = String(entry.name || '');
      if (!raw.endsWith('/') && (raw.includes('\\') || canonicalZipEntryName(raw) !== raw)) {
        throw new Error(`pack content-hashes requires canonical archive path: ${raw}`);
      }
    }
  }
  const files = new Map(
    contentEntries(entries).map((entry) => [canonicalZipEntryName(entry.name), entry.data]),
  );
  if (!declared.present) {
    return { status: 'absent', declared: 0, files: files.size, hashes: declared.hashes };
  }

  for (const [contentPath, digest] of declared.hashes) {
    const data = files.get(contentPath);
    if (!data) throw new Error(`pack content-hashes claims missing file: ${contentPath}`);
    if (sha256(data) !== digest) {
      throw new Error(`pack content hash mismatch: ${contentPath}`);
    }
  }
  return {
    status: declared.hashes.size === files.size ? 'verified' : 'partial',
    declared: declared.hashes.size,
    files: files.size,
    hashes: declared.hashes,
  };
}

function contentHashFingerprint(manifest) {
  const parsed = parseContentHashes(manifest);
  if (!parsed.present) return null;
  return JSON.stringify([...parsed.hashes.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

function redactSecret(value) {
  const text = String(value || '');
  if (text.length <= 8) return '*'.repeat(Math.max(text.length, 3));
  const masked = '*'.repeat(Math.min(12, text.length - 6));
  return `${text.slice(0, 4)}${masked}${text.slice(-2)}`;
}

function trimSecretValue(value) {
  return String(value || '')
    .replace(/^[`'"]+/, '')
    .replace(/[`'"]+$/, '')
    .replace(/[,;.)\]}>|]+$/, '');
}

function looksLikePlaceholder(value) {
  return SECRET_PLACEHOLDER.test(trimSecretValue(value));
}

function looksLikeCredentialValue(value) {
  const trimmed = trimSecretValue(value);
  if (!CREDENTIAL_VALUE.test(trimmed)) return false;
  if (CREDENTIAL_REFERENCE.test(trimmed)) return false;
  if (CONSTANT_NAME.test(trimmed)) return false;
  if (FILE_PATH_VALUE.test(trimmed)) return false;
  if (ENV_ASSIGNMENT.test(trimmed)) return false;
  // Real credentials carry entropy: a digit, or at least mixed case.
  return /\d/.test(trimmed) || (/[a-z]/.test(trimmed) && /[A-Z]/.test(trimmed));
}

function scanTextForSecrets(text) {
  const findings = [];
  const lines = String(text).split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    for (const pattern of SECRET_PATTERNS) {
      pattern.regex.lastIndex = 0;
      let match = pattern.regex.exec(line);
      while (match) {
        const value = match[1] !== undefined ? match[1] : match[0];
        // The shaped patterns (jwt, sk-, AKIA, BEGIN PRIVATE KEY) are specific
        // enough to stand on their own; only the generic rule needs filtering.
        const generic = match[1] !== undefined;
        if (!generic || (!looksLikePlaceholder(value) && looksLikeCredentialValue(value))) {
          findings.push({ line: i + 1, label: pattern.label, redacted: redactSecret(trimSecretValue(value)) });
        }
        match = pattern.regex.exec(line);
      }
    }
  }
  return findings;
}

function scanEntriesForSecrets(entries) {
  const findings = [];
  for (const entry of entries) {
    if (!entry || !entry.data) continue;
    for (const hit of scanTextForSecrets(entry.data.toString('utf8'))) {
      findings.push({ file: entry.name, ...hit });
    }
  }
  return findings;
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

function refreshApiWithoutProviderHint(deps = {}) {
  const requestJson = deps.apiRequestJson || apiRequestJson;
  return (pathname, options = {}) => {
    if (pathname !== '/auth/refresh') return requestJson(pathname, options);
    const body = options.body && typeof options.body === 'object' ? { ...options.body } : {};
    delete body.provider;
    return requestJson(pathname, { ...options, body });
  };
}

async function refreshRegistryCredentials(credentials, deps = {}) {
  const refresh = deps.performTokenRefresh || performTokenRefresh;
  try {
    const result = await refresh(credentials, refreshApiWithoutProviderHint(deps));
    if (!result || !result.ok) return null;
    return result.payload?.credentials || (deps.loadCredentials || loadCredentials)();
  } catch {
    return null;
  }
}

async function requestRegistryZip(url, deps = {}, options = {}) {
  const request = deps.httpRequest || httpRequest;
  const readCredentials = deps.loadCredentials || loadCredentials;
  const credentials = readCredentials();
  const authenticated = Boolean(credentials && credentials.token);
  const requestWithToken = (token) => request(url, {
    ...options,
    method: 'GET',
    headers: token ? { ...(options.headers || {}), Authorization: `Bearer ${token}` } : { ...(options.headers || {}) },
  });

  let response = await requestWithToken(credentials?.token);
  if (response.status === 404 && authenticated) {
    const refreshedCredentials = await refreshRegistryCredentials(credentials, deps);
    if (refreshedCredentials && refreshedCredentials.token) {
      response = await requestWithToken(refreshedCredentials.token);
    }
  }
  return { response, authenticated };
}

function registryNotFoundError(slug, authenticated) {
  if (authenticated) {
    return new Error('pack not found or you do not have access (your login may be stale; try atris login)');
  }
  return new Error(`pack not found: ${slug}`);
}

function requiredAuthHeaders(deps = {}, purpose = 'publish packs') {
  const headers = optionalAuthHeaders(deps);
  if (!headers.Authorization) {
    throw new Error(`not logged in. run atris login first to ${purpose}.`);
  }
  return headers;
}

function assertPublishableSlug(slug) {
  if (!SLUG_RULE.test(String(slug || ''))) {
    throw new Error(
      `pack slug "${slug}" is not viewable on the web. use 3-40 characters of a-z, 0-9 and dashes: --slug <slug>`,
    );
  }
}

function assertPublishableAuthor(manifest) {
  if (!manifest.author || !String(manifest.author).trim()) {
    throw new Error('publishing needs an author. re-run with --author "<your name>" (or set "author" in pack.json).');
  }
}

async function postPackToRegistry(manifest, zipBuffer, deps = {}) {
  const request = deps.httpRequest || httpRequest;
  const url = registryUrl('/api/pack/registry', deps);
  const body = JSON.stringify({ manifest, zipBase64: zipBuffer.toString('base64') });
  const authHeaders = requiredAuthHeaders(deps);
  assertPublishableAuthor(manifest);
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

function paidPackBarrierFromResponse(response, slug) {
  const status = Number(response && response.status) || 0;
  if (status === 404) return null;

  const rawBody = response && response.body;
  const body = !rawBody
    ? Buffer.alloc(0)
    : (Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody)));
  const empty = body.length === 0;
  const parsed = parseJsonBody(body);
  const data = parsed.data && typeof parsed.data === 'object' && !Array.isArray(parsed.data)
    ? parsed.data
    : {};
  const priceRaw = data.price_cents ?? data.priceCents;
  const priceCents = Number(priceRaw);
  const hasPrice = Number.isFinite(priceCents) && priceCents > 0;
  const nameSource = [data.name, data.title, data.slug, slug]
    .find((value) => typeof value === 'string' && value.trim());
  const details = {
    name: String(nameSource || slug || 'this pack').trim().toLowerCase(),
    priceCents: hasPrice ? Math.round(priceCents) : null,
  };

  const entitled = data.entitled === true
    || data.has_access === true
    || data.hasAccess === true
    || data.is_owner === true
    || data.isOwner === true;
  const unentitled = data.entitled === false
    || data.has_access === false
    || data.hasAccess === false
    || data.entitlement === false
    || data.entitlement === null;
  const message = String(data.error || data.message || data.detail || '');
  const looksLikeZip = body.length >= 4 && body[0] === 0x50 && body[1] === 0x4b;
  const paid = status === 402
    || data.paid === true
    || data.is_paid === true
    || data.isPaid === true
    || data.purchase_required === true
    || typeof data.checkout_hint === 'string'
    || /purchase required/i.test(message)
    || (hasPrice && (unentitled || !looksLikeZip));

  if (entitled && status >= 200 && status < 300 && looksLikeZip) return null;
  if (status === 402 || status === 403) return details;
  if (status >= 200 && status < 300 && empty) return details;
  if (paid && !entitled && !looksLikeZip) return details;
  return null;
}

function formatSalesDollars(priceCents) {
  const cents = Math.round(Number(priceCents));
  if (!Number.isFinite(cents)) return '$0';
  const sign = cents < 0 ? '-' : '';
  const absoluteCents = Math.abs(cents);
  const dollars = Math.floor(absoluteCents / 100).toLocaleString('en-US');
  const remainder = absoluteCents % 100;
  return `${sign}$${dollars}${remainder ? `.${String(remainder).padStart(2, '0')}` : ''}`;
}

function printPaidPackBarrier(slug, details = {}, deps = {}) {
  const name = String(details.name || slug || 'this pack').trim().toLowerCase() || 'this pack';
  const cents = Number(details.priceCents);
  const price = Number.isFinite(cents) && cents > 0 ? ` (${formatSalesDollars(cents)})` : '';
  console.error(`this pack is paid: ${name}${price}.`);
  console.error('buy it on its page, then run this again.');
  console.error(registryUrl(`/packs/${encodeURIComponent(slug)}`, deps));
  console.error('already bought it? run atris login');
}

function throwPaidPackBarrier(barrier, status) {
  const error = new Error('this pack is paid');
  error.status = status;
  error.paidPack = barrier;
  throw error;
}

async function fetchRegistryZip(slug, deps = {}) {
  const url = registryUrl(`/api/pack/registry/${encodeURIComponent(slug)}`, deps);
  let result;
  try {
    result = await requestRegistryZip(url, deps, {
      timeoutMs: REGISTRY_TIMEOUT_MS,
    });
  } catch {
    throw new Error('could not reach pack registry. check your connection and try again.');
  }
  const { response, authenticated } = result;
  if (response.status === 404) throw registryNotFoundError(slug, authenticated);
  const barrier = paidPackBarrierFromResponse(response, slug);
  if (barrier) throwPaidPackBarrier(barrier, response.status);
  if (response.status < 200 || response.status >= 300) {
    const error = new Error(responseErrorText(response, `registry lookup failed for ${slug} with status ${response.status}`));
    error.status = response.status;
    throw error;
  }
  if (!response.body || response.body.length === 0) {
    throw new Error(`registry returned an empty zip for ${slug}`);
  }
  return response.body;
}

async function fetchRegistryZipForUser(slug, deps = {}) {
  try {
    return await fetchRegistryZip(slug, deps);
  } catch (error) {
    if (!error || !error.paidPack) throw error;
    printPaidPackBarrier(slug, error.paidPack, deps);
    return null;
  }
}

// ── pack share ──────────────────────────────────────────────────────────────
// Signed links are the primary handoff. The old /packs/<slug>?for=<name> link
// is retained only when minting fails for a pack the public registry confirms
// is public.
const PERSONALIZATION_MAX_LENGTH = 40;
const PERSONALIZATION_MARKUP = /[<>&"`\\/]/;
const PERSONALIZATION_DISALLOWED = /[^\p{L}\p{M} '’.\-]/gu;
const PERSONALIZATION_HAS_LETTER = /\p{L}/u;

function sanitizePersonalizationName(raw) {
  if (typeof raw !== 'string') return null;
  if (PERSONALIZATION_MARKUP.test(raw)) return null;
  const cleaned = raw
    .normalize('NFC')
    .replace(/\s/g, ' ')
    .replace(PERSONALIZATION_DISALLOWED, '')
    .replace(/ +/g, ' ')
    .trim();
  if (!cleaned) return null;
  const capped = cleaned.slice(0, PERSONALIZATION_MAX_LENGTH).trim();
  if (!capped || !PERSONALIZATION_HAS_LETTER.test(capped)) return null;
  return capped;
}

function parsePackShareArgs(rawArgs) {
  const args = [...rawArgs];
  const forName = takeValue(args, '--for');
  const daysValue = takeValue(args, '--days');
  const list = takeFlag(args, '--list');
  const revoke = takeFlag(args, '--revoke', { optionalValue: true });
  const slug = args.shift();
  if (!slug) throw new Error('pack share needs a slug: atris pack share <slug> --for "<Name>"');
  if (args.length) throw new Error(`unknown pack share argument: ${args.join(' ')}`);
  assertPublishableSlug(slug);

  if (list) {
    if (forName !== null || daysValue !== null || revoke !== false) {
      throw new Error('pack share --list cannot be combined with --for, --days, or --revoke');
    }
    return { mode: 'list', slug };
  }

  if (revoke !== false) {
    if (forName !== null || daysValue !== null) {
      throw new Error('pack share --revoke cannot be combined with --for or --days');
    }
    if (typeof revoke === 'string' && !SHARE_NONCE_RULE.test(revoke)) {
      throw new Error('--revoke link id must be a 22-character base64url value');
    }
    return {
      mode: 'revoke',
      slug,
      ...(typeof revoke === 'string' ? { nonce: revoke } : {}),
    };
  }

  if (forName === null) {
    if (daysValue !== null) throw new Error('pack share --days requires --for "<Name>"');
    return { mode: 'plain', slug };
  }

  const recipientLabel = String(forName).trim();
  if (!recipientLabel || recipientLabel.length > MAX_SHARE_RECIPIENT_LENGTH) {
    throw new Error(
      `--for needs a recipient label between 1 and ${MAX_SHARE_RECIPIENT_LENGTH} characters`,
    );
  }

  const expiresInDays = daysValue === null ? DEFAULT_SHARE_DAYS : Number(daysValue);
  if (!Number.isSafeInteger(expiresInDays) || expiresInDays < 1 || expiresInDays > MAX_SHARE_DAYS) {
    throw new Error(`--days must be a whole number from 1 to ${MAX_SHARE_DAYS}`);
  }
  return { mode: 'mint', slug, recipientLabel, expiresInDays };
}

async function requestRegistryJson(pathname, requestOptions = {}, deps = {}) {
  const request = deps.httpRequest || httpRequest;
  const method = requestOptions.method || 'GET';
  const headers = {
    Accept: 'application/json',
    ...(requestOptions.authPurpose
      ? requiredAuthHeaders(deps, requestOptions.authPurpose)
      : {}),
  };
  if (requestOptions.sendOrigin) {
    const origin = registryOrigin(deps);
    if (origin) headers.Origin = origin;
  }

  let body;
  if (requestOptions.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(requestOptions.body);
  }

  let response;
  try {
    response = await request(registryUrl(pathname, deps), {
      method,
      timeoutMs: REGISTRY_TIMEOUT_MS,
      headers,
      ...(body !== undefined ? { body } : {}),
    });
  } catch {
    throw new Error(requestOptions.unreachableMessage || 'could not reach pack registry. check your connection and try again.');
  }

  if (response.status < 200 || response.status >= 300) {
    const error = new Error(responseErrorText(response, `registry request failed with status ${response.status}`));
    error.status = response.status;
    throw error;
  }
  const parsed = parseJsonBody(response.body);
  if (!parsed.data || typeof parsed.data !== 'object') {
    throw new Error(requestOptions.invalidMessage || 'pack registry returned an invalid response');
  }
  return parsed.data;
}

async function mintPackShare(slug, recipientLabel, expiresInDays, deps = {}) {
  const data = await requestRegistryJson(
    `/api/pack/registry/${encodeURIComponent(slug)}/share`,
    {
      method: 'POST',
      authPurpose: 'share packs',
      sendOrigin: true,
      body: { recipientLabel, expiresInDays },
      unreachableMessage: 'could not mint a pack share link. check your connection and try again.',
      invalidMessage: 'pack registry did not return a share link',
    },
    deps,
  );
  if (typeof data.shareUrl !== 'string' || !data.shareUrl.trim()) {
    throw new Error('pack registry did not return a share link');
  }
  if (!Number.isFinite(Number(data.expiresAt))) {
    throw new Error('pack registry did not return the share link expiry');
  }
  return {
    shareUrl: data.shareUrl,
    expiresAt: Number(data.expiresAt),
    ...(typeof data.nonce === 'string' && SHARE_NONCE_RULE.test(data.nonce)
      ? { nonce: data.nonce }
      : {}),
  };
}

async function listPackShares(slug, deps = {}) {
  const data = await requestRegistryJson(
    `/api/pack/registry/${encodeURIComponent(slug)}/share`,
    {
      authPurpose: 'list personal links for packs',
      unreachableMessage: 'could not list pack share links. check your connection and try again.',
      invalidMessage: 'pack share links returned an invalid response',
    },
    deps,
  );
  if (!Array.isArray(data.links)) {
    throw new Error('pack share links returned an invalid response');
  }
  return data.links;
}

async function revokePackShares(slug, deps = {}) {
  return requestRegistryJson(
    `/api/pack/registry/${encodeURIComponent(slug)}/share`,
    {
      method: 'DELETE',
      authPurpose: 'revoke personal links for packs',
      sendOrigin: true,
      unreachableMessage: 'could not revoke pack share links. check your connection and try again.',
    },
    deps,
  );
}

async function revokePackShare(slug, nonce, deps = {}) {
  return requestRegistryJson(
    `/api/pack/registry/${encodeURIComponent(slug)}/share`,
    {
      method: 'DELETE',
      authPurpose: 'revoke a personal link for a pack',
      sendOrigin: true,
      body: { nonce },
      unreachableMessage: 'could not revoke that pack share link. check your connection and try again.',
    },
    deps,
  );
}

function registryPackItems(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && Array.isArray(payload.packs)) return payload.packs;
  return [];
}

function packManifestFromItem(item) {
  if (item && item.manifest && typeof item.manifest === 'object') return item.manifest;
  return item && typeof item === 'object' ? item : {};
}

function isPublicPackPayload(payload, slug) {
  return registryPackItems(payload).some((item) => {
    const manifest = packManifestFromItem(item);
    return manifest.slug === slug
      && (manifest.visibility === undefined || manifest.visibility === 'public');
  });
}

async function registryConfirmsPublicPack(slug, deps = {}) {
  try {
    const payload = await requestRegistryJson(
      '/api/pack/registry',
      {
        unreachableMessage: 'could not check public pack visibility',
        invalidMessage: 'pack registry returned an invalid public listing',
      },
      deps,
    );
    return isPublicPackPayload(payload, slug);
  } catch {
    return false;
  }
}

function legacyPersonalizedShareUrl(slug, recipientLabel, deps = {}) {
  const name = sanitizePersonalizationName(recipientLabel);
  if (!name) return null;
  const base = registryUrl(`/packs/${encodeURIComponent(slug)}`, deps);
  return `${base}?for=${encodeURIComponent(name)}`;
}

function formatShareExpiry(expiresAt) {
  if (expiresAt === undefined || expiresAt === null || expiresAt === '') return 'unknown';
  const numeric = Number(expiresAt);
  const date = Number.isFinite(numeric)
    ? new Date(numeric < 1000000000000 ? numeric * 1000 : numeric)
    : new Date(expiresAt);
  if (Number.isNaN(date.getTime())) return 'unknown';
  return date.toISOString().replace('T', ' ').replace('.000Z', ' utc');
}

function cleanTableCell(value, fallback, maxLength) {
  const clean = String(value === undefined || value === null || value === '' ? fallback : value)
    .replace(/\s+/g, ' ')
    .trim();
  if (clean.length <= maxLength) return clean;
  return `${clean.slice(0, Math.max(1, maxLength - 3))}...`;
}

function formatPackShareLinksTable(links) {
  if (!Array.isArray(links) || !links.length) return '';
  const rows = links.map((link) => ({
    label: cleanTableCell(link && link.label, 'unlabeled', 40),
    expires: formatShareExpiry(link && link.expiresAt),
    state: link && link.revoked ? 'revoked' : 'active',
    nonce: cleanTableCell(link && link.nonce, 'unknown', 64),
  }));
  const columns = [
    { key: 'label', label: 'label' },
    { key: 'expires', label: 'expires' },
    { key: 'state', label: 'state' },
    { key: 'nonce', label: 'nonce' },
  ];
  const widths = columns.map((column) => Math.max(
    column.label.length,
    ...rows.map((row) => row[column.key].length),
  ));
  const render = (row) => columns
    .map((column, index) => (
      index === columns.length - 1
        ? row[column.key]
        : row[column.key].padEnd(widths[index])
    ))
    .join('  ');
  return [
    render(Object.fromEntries(columns.map((column) => [column.key, column.label]))),
    ...rows.map(render),
  ].join('\n');
}

function browseStarValue(item, payload, slug) {
  const manifest = packManifestFromItem(item);
  const summary = payload && payload.summaries && payload.summaries[slug];
  const mapped = payload && payload.stars && payload.stars[slug];
  const candidates = [
    item && item.stars,
    item && item.starCount,
    manifest.stars,
    manifest.starCount,
    summary && summary.stars,
    summary && summary.starCount,
    mapped,
  ];
  for (const candidate of candidates) {
    if (Number.isFinite(candidate)) return Number(candidate);
    if (candidate && typeof candidate === 'object' && Number.isFinite(candidate.count)) {
      return Number(candidate.count);
    }
  }
  return null;
}

function browsePriceCents(item) {
  const manifestPriceCents = item
    && item.manifest
    && typeof item.manifest === 'object'
    ? item.manifest.priceCents
    : undefined;
  if (manifestPriceCents !== undefined && manifestPriceCents !== null) {
    return manifestPriceCents;
  }
  return item && typeof item === 'object' ? item.priceCents : undefined;
}

function packBrowseRows(payload, { mine = false, limit = PACK_BROWSE_LIMIT } = {}) {
  return registryPackItems(payload).slice(0, limit).map((item) => {
    const manifest = packManifestFromItem(item);
    const priceCents = browsePriceCents(item);
    return {
      slug: cleanTableCell(manifest.slug, 'unknown', 40),
      title: cleanTableCell(manifest.title || manifest.name, manifest.slug || 'untitled', 42),
      version: cleanTableCell(manifest.version, 'unknown', 20),
      ...(mine
        ? { visibility: cleanTableCell(manifest.visibility, 'public', 10) }
        : {}),
      price: Number(priceCents) > 0 ? formatSalesDollars(priceCents) : 'free',
      stars: browseStarValue(item, payload, manifest.slug),
    };
  });
}

function formatPackBrowseTable(payload, options = {}) {
  const mine = Boolean(options.mine);
  const rows = packBrowseRows(payload, {
    mine,
    limit: options.limit || PACK_BROWSE_LIMIT,
  });
  if (!rows.length) return '';

  const showPrice = rows.some((row) => row.price !== 'free');
  const showStars = rows.some((row) => row.stars !== null);
  const columns = [
    { key: 'slug', label: 'slug' },
    { key: 'title', label: 'title' },
    { key: 'version', label: 'version' },
    ...(mine ? [{ key: 'visibility', label: 'visibility' }] : []),
    ...(showPrice ? [{ key: 'price', label: 'price' }] : []),
    ...(showStars ? [{ key: 'stars', label: 'stars' }] : []),
  ];
  const widths = columns.map((column) => Math.max(
    column.label.length,
    ...rows.map((row) => String(row[column.key] === null ? '-' : row[column.key]).length),
  ));
  const render = (row) => columns
    .map((column, index) => {
      const value = row[column.key] === null ? '-' : String(row[column.key]);
      return index === columns.length - 1 ? value : value.padEnd(widths[index]);
    })
    .join('  ');
  return [
    render(Object.fromEntries(columns.map((column) => [column.key, column.label]))),
    ...rows.map(render),
  ].join('\n');
}

function packSalesUrl(apiBaseUrl = getApiBaseUrl()) {
  return `${String(apiBaseUrl || '').replace(/\/+$/, '')}/pack/purchases/sales`;
}

function packPurchasesUrl(apiBaseUrl = getApiBaseUrl()) {
  return `${String(apiBaseUrl || '').replace(/\/+$/, '')}/pack/purchases/mine`;
}

function formatPackSaleDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'unknown';
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(date);
}

function isPackTransactionRefunded(item) {
  return Boolean(item && item.refunded === true);
}

function formatPackTransactionsTable(items, personKey, personLabel) {
  const rows = items.map((item) => ({
    pack: cleanTableCell(item && item.slug, 'unknown', 40),
    person: cleanTableCell(item && item[personKey], 'unknown', 40),
    price: formatSalesDollars(item && item.price_cents),
    date: formatPackSaleDate(item && item.granted_at),
    status: isPackTransactionRefunded(item) ? 'refunded' : '',
  }));
  if (!rows.length) return '';

  const showStatus = rows.some((row) => row.status === 'refunded');
  const columns = [
    { key: 'pack', label: 'pack' },
    { key: 'person', label: personLabel },
    { key: 'price', label: 'price' },
    { key: 'date', label: 'date' },
    ...(showStatus ? [{ key: 'status', label: 'status' }] : []),
  ];
  const widths = columns.map((column) => Math.max(
    column.label.length,
    ...rows.map((row) => row[column.key].length),
  ));
  const render = (row) => columns
    .map((column, index) => (
      index === columns.length - 1
        ? row[column.key]
        : row[column.key].padEnd(widths[index])
    ))
    .join('  ');
  return [
    render(Object.fromEntries(columns.map((column) => [column.key, column.label]))),
    ...rows.map(render),
  ].join('\n');
}

function formatPackSalesTable(sales) {
  return formatPackTransactionsTable(sales, 'buyer', 'buyer');
}

function formatPackPurchasesTable(purchases) {
  return formatPackTransactionsTable(purchases, 'seller', 'seller');
}

function formatBytes(value) {
  const bytes = Number(value) || 0;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function printPacketComposition(entries) {
  const byTop = new Map();
  for (const entry of entries) {
    const parts = entry.name.split('/');
    const inner = parts[0] === 'atris' ? parts.slice(1) : parts;
    const top = inner.length > 1 ? `${inner[0]}/` : '(root)';
    byTop.set(top, (byTop.get(top) || 0) + 1);
  }
  console.log('composition:');
  for (const [top, count] of [...byTop.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
    console.log(`  ${top.padEnd(16)} ${count}`);
  }
}

function printPacketTree(entries) {
  console.log('tree:');
  if (entries.length <= 200) {
    for (const entry of entries) console.log(`  ${entry.name}`);
    return;
  }
  const byDir = new Map();
  for (const entry of entries) {
    const dir = entry.name.includes('/') ? `${entry.name.slice(0, entry.name.lastIndexOf('/'))}/` : './';
    const current = byDir.get(dir) || { files: 0, bytes: 0 };
    current.files += 1;
    current.bytes += entry.data.length;
    byDir.set(dir, current);
  }
  console.log(`  (${entries.length} files across ${byDir.size} folders, rolled up by folder)`);
  for (const [dir, stats] of [...byDir.entries()].sort()) {
    console.log(`  ${dir}  ${stats.files} files  ${formatBytes(stats.bytes)}`);
  }
}

function printSkipped(skipped) {
  if (!skipped.length) return;
  const byReason = new Map();
  for (const item of skipped) {
    const list = byReason.get(item.reason) || [];
    list.push(item.path);
    byReason.set(item.reason, list);
  }
  console.log('skipped:');
  for (const [reason, paths] of [...byReason.entries()].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`  ${reason}: ${paths.length}`);
    for (const item of paths.slice(0, 5)) console.log(`    ${item}`);
    if (paths.length > 5) console.log(`    ... ${paths.length - 5} more`);
  }
}

function printPacketSummary(manifest, entries, skipped, zipBytes) {
  const unpacked = entries.reduce((total, entry) => total + entry.data.length, 0);
  console.log(`pack ${manifest.slug} ${manifest.version}`);
  console.log(`  files     ${entries.length} (limit ${REGISTRY_LIMITS.maxEntries})`);
  console.log(`  unpacked  ${formatBytes(unpacked)} (limit ${formatBytes(REGISTRY_LIMITS.maxUnpackedBytes)})`);
  console.log(`  zip       ${formatBytes(zipBytes)} (limit ${formatBytes(REGISTRY_LIMITS.maxZipBytes)})`);
  printPacketComposition(entries);
  printPacketTree(entries);
  printSkipped(skipped);
  return { unpacked, zipBytes, files: entries.length };
}

function registryLimitFailures(entries, zipBytes) {
  const unpacked = entries.reduce((total, entry) => total + entry.data.length, 0);
  const failures = [];
  if (entries.length > REGISTRY_LIMITS.maxEntries) {
    failures.push(`entry count: ${entries.length} files exceeds the ${REGISTRY_LIMITS.maxEntries} file limit`);
  }
  if (unpacked > REGISTRY_LIMITS.maxUnpackedBytes) {
    failures.push(`unpacked size: ${formatBytes(unpacked)} exceeds the ${formatBytes(REGISTRY_LIMITS.maxUnpackedBytes)} unpacked limit`);
  }
  if (zipBytes > REGISTRY_LIMITS.maxZipBytes) {
    failures.push(`zip size: ${formatBytes(zipBytes)} exceeds the ${formatBytes(REGISTRY_LIMITS.maxZipBytes)} zip limit`);
  }
  return failures;
}

function reportSecretFindings(findings) {
  console.error(`refusing to publish: found ${findings.length} credential-shaped match${findings.length === 1 ? '' : 'es'}.`);
  for (const finding of findings.slice(0, 20)) {
    console.error(`  ${finding.file}:${finding.line}  ${finding.label}  ${finding.redacted}`);
  }
  if (findings.length > 20) console.error(`  ... ${findings.length - 20} more`);
  console.error('remove the credentials, or re-run with --allow-secrets if every match is a false positive.');
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
      sourcePath: localPath,
    };
  }

  const slug = slugify(source);
  const buffer = await fetchRegistryZipForUser(slug, deps);
  if (!buffer) return null;
  return { buffer, fallbackSlug: slug, sourceType: 'registry', sourceSlug: slug };
}

function parseManifest(entries) {
  const manifestEntries = entries.filter((entry) => (
    canonicalZipEntryName(entry.name) === 'pack.json'
    && !String(entry.name || '').replace(/\\/g, '/').endsWith('/')
  ));
  if (manifestEntries.length === 0) {
    throw new Error('pack archive is missing root pack.json');
  }
  if (manifestEntries.length > 1) {
    throw new Error('pack archive contains duplicate pack.json entries');
  }

  const manifestEntry = manifestEntries[0];
  let parsed;
  try {
    parsed = JSON.parse(manifestEntry.data.toString('utf8'));
  } catch (error) {
    throw new Error(`pack archive has invalid pack.json: ${error.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('pack archive pack.json must contain an object');
  }
  if (typeof parsed.slug !== 'string' || !parsed.slug.trim()) {
    throw new Error('pack archive pack.json is missing slug');
  }
  return parsed;
}

function manifestVersion(manifest) {
  return manifest.version
    || (Array.isArray(manifest.versions) && manifest.versions[0] && manifest.versions[0].version)
    || 'unknown';
}

function upstreamStatePath(packDir) {
  return path.join(packDir, '.upstream', 'STATE.json');
}

function packStatePath(packDir) {
  return path.join(packDir, '.atris', 'state', 'pack.json');
}

function remoteCheckTime(deps = {}) {
  const value = typeof deps.now === 'function' ? deps.now() : new Date();
  const date = value instanceof Date ? value : new Date(value);
  return date.toISOString();
}

function recordRemoteCheck(packDir, details, deps = {}) {
  const statePath = packStatePath(packDir);
  const existing = readJson(statePath);
  const state = {
    ...(existing && typeof existing === 'object' ? existing : {}),
    slug: details.slug,
    origin: details.origin,
    remoteVersion: details.remoteVersion,
    lastRemoteCheckAt: remoteCheckTime(deps),
  };
  writeJson(statePath, state);
  return state;
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

function hasStagedUpstream(packDir) {
  const upstreamDir = path.join(packDir, '.upstream');
  if (!fs.existsSync(upstreamDir)) return false;
  return fs.readdirSync(upstreamDir).some((name) => name !== 'STATE.json');
}

module.exports = {
  REGISTRY_TIMEOUT_MS,
  PACK_RUN_INPUT_MAX_BYTES,
  PACK_VISIBILITIES,
  DEFAULT_SHARE_DAYS,
  MAX_SHARE_DAYS,
  MAX_SHARE_RECIPIENT_LENGTH,
  SHARE_NONCE_RULE,
  PACK_BROWSE_LIMIT,
  REGISTRY_LIMITS,
  SLUG_RULE,
  PACKET,
  SECRET_PATTERNS,
  slugify,
  titleFromSlug,
  takeValue,
  takeValues,
  takeFlag,
  parseSemver,
  bumpVersion,
  comparePackVersions,
  readJson,
  writeJson,
  buildManifest,
  packetDirectories,
  packetDeniedSegments,
  isRunningStateName,
  classifyPacketPath,
  isUtf8Text,
  collectPacketEntries,
  sha256,
  canonicalZipEntryName,
  canonicalContentPath,
  contentEntries,
  buildContentHashes,
  parseContentHashes,
  verifyArchiveContentHashes,
  contentHashFingerprint,
  redactSecret,
  trimSecretValue,
  looksLikePlaceholder,
  looksLikeCredentialValue,
  scanTextForSecrets,
  scanEntriesForSecrets,
  parseJsonBody,
  responseErrorText,
  registryUrl,
  registryOrigin,
  optionalAuthHeaders,
  refreshApiWithoutProviderHint,
  refreshRegistryCredentials,
  requestRegistryZip,
  registryNotFoundError,
  requiredAuthHeaders,
  assertPublishableSlug,
  assertPublishableAuthor,
  postPackToRegistry,
  paidPackBarrierFromResponse,
  formatSalesDollars,
  printPaidPackBarrier,
  throwPaidPackBarrier,
  fetchRegistryZip,
  fetchRegistryZipForUser,
  sanitizePersonalizationName,
  parsePackShareArgs,
  requestRegistryJson,
  mintPackShare,
  listPackShares,
  revokePackShares,
  revokePackShare,
  registryPackItems,
  packManifestFromItem,
  isPublicPackPayload,
  registryConfirmsPublicPack,
  legacyPersonalizedShareUrl,
  formatShareExpiry,
  cleanTableCell,
  formatPackShareLinksTable,
  browseStarValue,
  browsePriceCents,
  packBrowseRows,
  formatPackBrowseTable,
  packSalesUrl,
  packPurchasesUrl,
  formatPackSaleDate,
  isPackTransactionRefunded,
  formatPackTransactionsTable,
  formatPackSalesTable,
  formatPackPurchasesTable,
  formatBytes,
  printPacketComposition,
  printPacketTree,
  printSkipped,
  printPacketSummary,
  registryLimitFailures,
  reportSecretFindings,
  shellQuote,
  fallbackSlugFromZipPath,
  loadZipPayload,
  parseManifest,
  manifestVersion,
  upstreamStatePath,
  packStatePath,
  remoteCheckTime,
  recordRemoteCheck,
  buildUpstreamState,
  writeUpstreamState,
  hasStagedUpstream,
};
