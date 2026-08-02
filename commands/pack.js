'use strict';

const fs = require('fs');
const path = require('path');
const { getAppBaseUrl, httpRequest } = require('../utils/api');
const { loadCredentials } = require('../utils/auth');
const { createZipBuffer, readZipBuffer } = require('../lib/zip');
const { craftPack } = require('./pack-craft');

const REGISTRY_TIMEOUT_MS = 60000;

// The web registry caps every upload (atrisos-web app/api/pack/registry/route.ts).
// Keep these in one place so a preflight failure can name the limit it broke.
const REGISTRY_LIMITS = {
  maxZipBytes: 5 * 1024 * 1024,
  maxUnpackedBytes: 20 * 1024 * 1024,
  maxEntries: 500,
};

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
  // definition files travel — MEMBER.md, MISSION.md, SKILL.md, SOUL.md,
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
  runningStateReason: 'running state is excluded (a packet carries definitions, not state)',
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

function showHelp() {
  console.log('usage: atris pack craft "<topic>" [--dir <target>] [--force]');
  console.log('       atris pack publish [--dir atris] [--slug <slug>] [--author "<name>"] [--notes "..."] [--minor|--major] [--out <file.zip>] [--push] [--dry-run] [--allow-secrets]');
  console.log('       atris pack install <file.zip|url|slug> [--dir <target>] [--force]');
  console.log('       atris pack run <slug|dir> [--dir <target>] [--cloud] [--force] [--trust]');
  console.log('       atris pack share <slug> [--for "<Name>"]');
  console.log('       atris pack pull [<slug>] [--dir <path>]');
  console.log('       atris pack status [--dir <path>]');
  console.log('       atris pack update [<dir>]');
  console.log('       atris pack inspect <slug|dir>');
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
      : { ok: false, reason: `not in the packet allowlist (${inner[0]}/)` };
  }

  const extension = path.extname(lowerBase);
  if (inner.length === 1) {
    if (PACKET.rootFiles.includes(lowerBase)) return { ok: true };
    return PACKET.rootExtensions.includes(extension)
      ? { ok: true }
      : { ok: false, reason: 'not a root document (.md/.txt)' };
  }
  if (!packetDirectories(includeLogs).includes(inner[0])) {
    return { ok: false, reason: `not in the packet allowlist (${inner[0]}/)` };
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

function assertPublishableSlug(slug) {
  if (!SLUG_RULE.test(String(slug || ''))) {
    throw new Error(
      `pack slug "${slug}" is not viewable on the web. use 3-40 characters of a-z, 0-9 and dashes: --slug <slug>`,
    );
  }
}

function assertPublishableAuthor(manifest) {
  if (!manifest.author || !String(manifest.author).trim()) {
    throw new Error('registry packs need an author. re-run with --author "<your name>" (or set "author" in pack.json).');
  }
}

// ── pack share ──────────────────────────────────────────────────────────────
// The web renders /packs/<slug>?for=<name> and silently drops a `for` value it
// cannot display (atrisos-web app/lib/pack/personalize.ts). Mirroring that
// sanitizer here means the CLI never hands you a link that looks personalized
// and isn't — it says no instead.
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

function sharePack(rawArgs, cwd = process.cwd(), options = {}) {
  const args = [...rawArgs];
  const forName = takeValue(args, '--for');
  const slug = args.shift();
  if (!slug) throw new Error('pack share needs a slug: atris pack share <slug> [--for "<Name>"]');
  if (args.length) throw new Error(`unknown pack share argument: ${args.join(' ')}`);
  assertPublishableSlug(slug);

  const deps = options.deps || {};
  const base = registryUrl(`/packs/${encodeURIComponent(slug)}`, deps);
  if (forName === null) {
    console.log(base);
    console.log(`share this packet, or personalize it: atris pack share ${slug} --for "<Name>"`);
    return 0;
  }

  const name = sanitizePersonalizationName(forName);
  if (!name) {
    throw new Error(
      `--for "${forName}" is not a name the share page will display, so the link would render as if it were plain. `
      + `use letters, spaces and ' . - (no < > & " \` \\ /), at least one letter, up to ${PERSONALIZATION_MAX_LENGTH} characters.`,
    );
  }
  console.log(`${base}?for=${encodeURIComponent(name)}`);
  console.log(
    name === forName
      ? `personalized for ${name}`
      : `personalized for ${name} (trimmed from "${forName}" to match what the page will show)`,
  );
  return 0;
}

function formatBytes(value) {
  const bytes = Number(value) || 0;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// What a stranger actually receives, in one glance. The tree below is the
// detail; this is the shape — enough to see that the wiki, the skills, the
// members and the policies are all still in the box.
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
  console.log(`packet ${manifest.slug} ${manifest.version}`);
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
    failures.push(`entry count: ${entries.length} files exceeds the ${REGISTRY_LIMITS.maxEntries} file registry limit`);
  }
  if (unpacked > REGISTRY_LIMITS.maxUnpackedBytes) {
    failures.push(`unpacked size: ${formatBytes(unpacked)} exceeds the ${formatBytes(REGISTRY_LIMITS.maxUnpackedBytes)} registry limit`);
  }
  if (zipBytes > REGISTRY_LIMITS.maxZipBytes) {
    failures.push(`zip size: ${formatBytes(zipBytes)} exceeds the ${formatBytes(REGISTRY_LIMITS.maxZipBytes)} registry limit`);
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
  const dryRun = takeFlag(args, '--dry-run');
  const allowSecrets = takeFlag(args, '--allow-secrets');
  const major = takeFlag(args, '--major');
  const minor = takeFlag(args, '--minor');
  const push = takeFlag(args, '--push');
  if (major && minor) throw new Error('choose either --major or --minor, not both');
  if (args.length) throw new Error(`unknown pack publish argument: ${args.join(' ')}`);
  if (!fs.existsSync(sourceDir) || !fs.statSync(sourceDir).isDirectory()) {
    throw new Error(`pack source not found: ${path.relative(cwd, sourceDir) || sourceDir}`);
  }

  // pack.json belongs to the pack, not to whatever repo happens to contain it
  // (2026-07-27: publishing ~/arena/atrisos-backend/atris wrote a pack.json
  // into atrisos-backend/ and polluted the source repo).
  const manifestPath = path.join(sourceDir, 'pack.json');
  const existing = readJson(manifestPath);
  const manifest = buildManifest(existing, {
    slug,
    author,
    notes,
    bump: major ? 'major' : minor ? 'minor' : 'patch',
    fallbackSlug: path.basename(sourceDir),
  });
  assertPublishableSlug(manifest.slug);
  const shipping = Boolean(out || push);
  if (shipping || dryRun) assertPublishableAuthor(manifest);
  if (!dryRun) writeJson(manifestPath, manifest);

  const collected = collectPacketEntries(sourceDir, {
    prefix: packRootMode ? '' : 'atris',
    includeLogs,
  });
  // The manifest is always synthesized at the zip root, never copied from the
  // source, so drop whatever pack.json the walker picked up.
  const sourceManifestName = packRootMode ? 'pack.json' : 'atris/pack.json';
  const entries = [
    { name: 'pack.json', data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8'), mtime: new Date() },
    ...collected.entries.filter((entry) => entry.name !== sourceManifestName),
  ];

  // Scan before a zip exists anywhere: on disk, in the registry, or in a temp.
  if (!allowSecrets) {
    const findings = scanEntriesForSecrets(entries);
    if (findings.length) {
      reportSecretFindings(findings);
      return 1;
    }
  } else {
    console.log('WARNING: --allow-secrets is on. Credential scanning is disabled for this publish.');
    console.log('WARNING: anything you ship is readable by every person who installs this packet.');
  }

  const zipBuffer = createZipBuffer(entries);
  printPacketSummary(manifest, entries, collected.skipped, zipBuffer.length);
  const failures = registryLimitFailures(entries, zipBuffer.length);

  if (dryRun) {
    if (failures.length) {
      console.error('dry run: this packet would be rejected by the registry.');
      for (const failure of failures) console.error(`  ${failure}`);
      return 1;
    }
    console.log('dry run: nothing written. re-run without --dry-run to publish.');
    return 0;
  }

  if (shipping && failures.length) {
    console.error('refusing to publish: packet exceeds the registry limits.');
    for (const failure of failures) console.error(`  ${failure}`);
    console.error('trim the workspace or split the packet, then re-run.');
    return 1;
  }

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
  if (!shipping) {
    console.log(`wrote pack.json for ${manifest.slug} ${manifest.version}`);
    console.log('share with: atris pack publish --out <file.zip> or atris pack publish --push');
    if (failures.length) {
      console.log('note: this packet is too big for the registry today:');
      for (const failure of failures) console.log(`  ${failure}`);
    }
    if (!manifest.author || !String(manifest.author).trim()) {
      console.log('note: publishing to the registry needs an author. add --author "<your name>".');
    }
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
  const deps = options.deps || {};
  const zipBuffer = await fetchRegistryZip(slug, deps);
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

  recordRemoteCheck(packDir, {
    slug,
    origin: { type: 'registry', slug },
    remoteVersion,
  }, deps);

  const state = buildUpstreamState(slug, localVersion, remoteVersion);
  if (comparison > 0) {
    writeUpstreamZip(entries, packDir, state);
    console.log(`pulled ${slug} local v${localVersion} -> remote v${remoteVersion}`);
    console.log('upstream lives in .upstream/ for a deliberate merge.');
    return { ok: true, upToDate: false, localVersion, remoteVersion, targetDir: packDir };
  }

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
  const remoteState = readJson(packStatePath(packDir));
  const upstreamState = readJson(upstreamStatePath(packDir));
  const manifestOrigin = manifest.origin && typeof manifest.origin === 'object' ? manifest.origin : null;
  const remoteOrigin = remoteState && typeof remoteState.origin === 'object' ? remoteState.origin : null;
  const registrySlug = manifestOrigin && manifestOrigin.type === 'registry'
    ? manifestOrigin.slug
    : remoteOrigin && remoteOrigin.type === 'registry'
      ? remoteOrigin.slug
      : upstreamState && upstreamState.slug;

  console.log(`${manifest.slug} installed v${localVersion}`);
  console.log(`registry origin ${registrySlug || 'none'}`);

  const checkedState = remoteState && remoteState.remoteVersion
    ? {
      remoteVersion: remoteState.remoteVersion,
      checkedAt: remoteState.lastRemoteCheckAt,
    }
    : upstreamState && upstreamState.remoteVersion
      ? {
        remoteVersion: upstreamState.remoteVersion,
        checkedAt: upstreamState.pulledAt,
      }
      : manifestOrigin && (manifestOrigin.type === 'registry' || manifestOrigin.type === 'url')
        ? {
          remoteVersion: localVersion,
          checkedAt: null,
        }
      : null;
  if (checkedState) {
    console.log(`last remote check ${checkedState.checkedAt || 'time unknown'}, remote v${checkedState.remoteVersion}`);
  } else {
    console.log('remote not checked yet');
  }

  if (upstreamState && hasStagedUpstream(packDir)) {
    const stagedVersion = upstreamState.remoteVersion || 'unknown';
    const stagedAt = upstreamState.pulledAt ? ` at ${upstreamState.pulledAt}` : '';
    console.log(`staged upstream review remote v${stagedVersion}${stagedAt}`);
  }
  return { ok: true, manifest, remoteState, upstreamState, state: upstreamState };
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
  if (payload.sourceType === 'registry') {
    recordRemoteCheck(targetDir, {
      slug,
      origin: { type: 'registry', slug: payload.sourceSlug },
      remoteVersion: manifestVersion(manifest),
    }, options.deps || {});
  }

  if (force && existing) {
    const oldVersion = manifestVersion(existing);
    const newVersion = manifestVersion(manifest);
    console.log(`updated v${oldVersion} -> v${newVersion}`);
  }

  const displayTarget = path.relative(cwd, targetDir) || '.';
  console.log(`installed ${slug} -> ${displayTarget}`);
  console.log(`run it:  atris pack run ${shellQuote(displayTarget)}`);
  console.log(`or open: cd ${shellQuote(displayTarget)} && claude`);
  return 0;
}

// ── pack run ────────────────────────────────────────────────────────────────
// Install is half a product: it leaves a folder and a suggestion. `pack run`
// is the other half — packet in, running workspace out.
//
// It defaults to LOCAL on purpose. The cloud path is gated: activating a
// business workspace needs auth, an existing business record, and a paid plan
// (backend/routers/business/workspace.py `_require_owner_paid_plan`). A
// stranger who receives a shared packet link has none of those, so the free
// local computer is the only honest default. --cloud opts in, and when the
// gate bites it says so instead of silently degrading.

function packRunLocalHint(displayTarget) {
  return `atris pack run ${shellQuote(displayTarget)}`;
}

// A packet folder is a folder with a readable pack.json. Anything else is a
// mistake worth naming.
function assertPacketDir(dir, cwd) {
  const display = path.relative(cwd, dir) || '.';
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    throw new Error(`packet folder not found: ${display}`);
  }
  if (!fs.existsSync(path.join(dir, 'pack.json'))) {
    throw new Error(`not an atris packet (no pack.json): ${display}`);
  }
  try {
    return readPackManifestFromDir(dir);
  } catch {
    throw new Error(`packet is invalid (unreadable pack.json): ${display}`);
  }
}

function looksLikeExistingDir(source, cwd) {
  if (/^https?:\/\//i.test(source)) return false;
  const resolved = path.resolve(cwd, source);
  return fs.existsSync(resolved) && fs.statSync(resolved).isDirectory();
}

// The gates, checked in the order a stranger hits them, each with the free way
// out. No fallback: a paywall you route around quietly is a paywall you lied
// about.
function cloudGateFailure(packDir, displayTarget, deps = {}) {
  const readCredentials = deps.loadCredentials || loadCredentials;
  const credentials = readCredentials();
  if (!credentials || !credentials.token) {
    return ['not logged in, so the cloud workspace is out of reach.', 'run: atris login'];
  }
  const readBinding = deps.readBusinessBinding || require('./computer').readBusinessBinding;
  const binding = readBinding(packDir);
  if (!binding) {
    return [
      'no business is bound to this packet folder, so there is no cloud workspace to run in.',
      'run: atris business init "<name>"',
    ];
  }
  return null;
}

async function startPackCloud(packDir, displayTarget, deps = {}) {
  const failure = cloudGateFailure(packDir, displayTarget, deps);
  if (failure) {
    console.error(`cloud is unavailable: ${failure[0]}`);
    console.error(`  ${failure[1]}`);
    console.error('cloud workspaces also need a paid plan on the owner account.');
    console.error('local runs free and needs none of that:');
    console.error(`  ${packRunLocalHint(displayTarget)}`);
    return 1;
  }
  const start = deps.runComputer || require('./computer').runComputer;
  const previous = process.cwd();
  process.chdir(packDir);
  try {
    await start(['cloud']);
  } finally {
    process.chdir(previous);
  }
  return 0;
}

// A packet is markdown an agent reads as instructions, and it usually came
// from someone else. `atris console` skips permission prompts because it runs
// on a workspace you wrote; that assumption does not survive being pointed at
// a stranger's folder, so pack run keeps prompts on unless --trust says the
// reader vouched for it.
function startPackLocal(packDir, deps = {}, options = {}) {
  const trust = options.trust === true;
  const start = deps.computerLocal || require('./computer').computerLocal;
  const previous = process.cwd();
  process.chdir(packDir);
  try {
    start([], { skipPermissions: trust });
  } finally {
    process.chdir(previous);
  }
  return 0;
}

async function runPack(rawArgs, cwd = process.cwd(), options = {}) {
  const args = [...rawArgs];
  const source = args.shift();
  if (!source || source === 'help' || source === '--help' || source === '-h') {
    showHelp();
    return source ? 0 : 2;
  }
  const targetArg = takeValue(args, '--dir');
  const cloud = takeFlag(args, '--cloud');
  const force = takeFlag(args, '--force');
  const trust = takeFlag(args, '--trust');
  if (args.length) throw new Error(`unknown pack run argument: ${args.join(' ')}`);

  const deps = options.deps || {};
  const install = deps.installPack || installPack;
  let packDir;

  if (looksLikeExistingDir(source, cwd)) {
    if (targetArg) throw new Error('--dir applies when installing a packet, not when running a folder');
    packDir = path.resolve(cwd, source);
    assertPacketDir(packDir, cwd);
  } else {
    packDir = path.resolve(cwd, targetArg || slugify(source));
    const alreadyThere = !force && fs.existsSync(path.join(packDir, 'pack.json'));
    if (alreadyThere) {
      assertPacketDir(packDir, cwd);
      console.log(`using installed packet ${path.relative(cwd, packDir) || '.'}`);
    } else {
      const installArgs = [source, '--dir', packDir];
      if (force) installArgs.push('--force');
      const code = await install(installArgs, cwd, options);
      if (code !== 0) return code;
      assertPacketDir(packDir, cwd);
    }
  }

  const displayTarget = path.relative(cwd, packDir) || '.';
  if (cloud) return startPackCloud(packDir, displayTarget, deps);
  console.log(`starting local computer in ${displayTarget}`);
  if (!trust) {
    console.log('permission prompts are on because this packet came from somewhere else; add --trust to turn them off.');
  }
  return startPackLocal(packDir, deps, { trust });
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
  recordRemoteCheck(resolved, {
    slug: existing.slug,
    origin,
    remoteVersion: newVersion,
  }, deps);
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

function resolveInstalledPack(source, cwd) {
  const direct = path.resolve(cwd, source);
  if (fs.existsSync(direct)) return { dir: direct, manifest: assertPacketDir(direct, cwd) };

  if (path.isAbsolute(source) || source.includes('/') || source.includes('\\')) {
    throw new Error(`packet folder not found: ${source}`);
  }

  const requestedSlug = slugify(source);
  const found = [];
  const seen = new Set();
  collectPackDirs(cwd, found, seen);
  collectPackDirs(path.join(cwd, 'packs'), found, seen);
  const matches = found.filter((item) => slugify(item.manifest.slug) === requestedSlug);
  if (!matches.length) throw new Error(`installed pack not found: ${source}`);
  if (matches.length > 1) {
    const locations = matches.map((item) => item.dir).sort().join(', ');
    throw new Error(`multiple installed packs match ${source}: ${locations}. inspect a directory instead.`);
  }
  return matches[0];
}

function summarizeInstalledEntry(entryPath) {
  const stat = fs.lstatSync(entryPath);
  if (!stat.isDirectory()) {
    return { files: 1, bytes: stat.size, kind: stat.isSymbolicLink() ? 'symlink' : 'file' };
  }

  const summary = { files: 0, bytes: 0, kind: 'directory' };
  const children = fs.readdirSync(entryPath).sort((left, right) => left.localeCompare(right));
  for (const child of children) {
    const childSummary = summarizeInstalledEntry(path.join(entryPath, child));
    summary.files += childSummary.files;
    summary.bytes += childSummary.bytes;
  }
  return summary;
}

function summarizeInstalledFiles(packDir) {
  const entries = fs.readdirSync(packDir).sort((left, right) => left.localeCompare(right));
  const topLevel = entries.map((name) => ({
    name,
    ...summarizeInstalledEntry(path.join(packDir, name)),
  }));
  return {
    files: topLevel.reduce((total, entry) => total + entry.files, 0),
    bytes: topLevel.reduce((total, entry) => total + entry.bytes, 0),
    topLevel,
  };
}

function hasInspectValue(value) {
  if (value === undefined || value === null || value === '') return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

function inspectManifestValue(manifest, names) {
  const provenance = manifest.provenance && typeof manifest.provenance === 'object'
    ? manifest.provenance
    : {};
  for (const container of [manifest, provenance]) {
    for (const name of names) {
      if (hasInspectValue(container[name])) return container[name];
    }
  }
  return null;
}

function declaredManifestValue(manifest, names) {
  for (const name of names) {
    if (hasInspectValue(manifest[name])) return manifest[name];
  }
  return null;
}

function formatInspectValue(value) {
  const formatted = typeof value === 'string' ? value : JSON.stringify(value);
  return String(formatted).replace(/\u2014/g, '-');
}

function createdInValue(manifest) {
  const declared = inspectManifestValue(manifest, ['created-in', 'createdIn', 'created_in']);
  if (declared !== null) return declared;
  const versions = Array.isArray(manifest.versions) ? manifest.versions : [];
  const createdNote = versions
    .map((version) => version && version.notes)
    .find((notes) => typeof notes === 'string' && /created in\b/i.test(notes));
  return createdNote || null;
}

function printProvenanceField(label, value) {
  console.log(`  ${label}: ${hasInspectValue(value) ? `${formatInspectValue(value)} [present]` : 'ABSENT'}`);
}

function printRegistryOrigin(manifest, deps = {}) {
  const origin = manifest.origin && typeof manifest.origin === 'object' ? manifest.origin : null;
  if (!origin || origin.type !== 'registry') {
    const detail = origin && origin.type ? ` (installed from ${origin.type})` : '';
    console.log(`registry origin: ABSENT${detail}`);
    return;
  }
  const slug = origin.slug || manifest.slug;
  const base = String((deps.getAppBaseUrl || getAppBaseUrl)() || '').replace(/\/+$/, '');
  console.log('registry origin:');
  console.log(`  slug: ${slug || 'ABSENT'}`);
  console.log(`  url: ${slug && base ? `${base}/packs/${encodeURIComponent(slug)}` : 'ABSENT'}`);
}

function printInstalledTree(summary) {
  console.log('top-level tree:');
  summary.topLevel.forEach((entry, index) => {
    const branch = index === summary.topLevel.length - 1 ? '`-' : '|-';
    if (entry.kind === 'directory') {
      const noun = entry.files === 1 ? 'file' : 'files';
      console.log(`  ${branch} ${entry.name}/ (${entry.files} ${noun}, ${formatBytes(entry.bytes)})`);
      return;
    }
    const kind = entry.kind === 'symlink' ? 'symlink, ' : '';
    console.log(`  ${branch} ${entry.name} (${kind}${formatBytes(entry.bytes)})`);
  });
}

function inspectPack(rawArgs, cwd = process.cwd(), options = {}) {
  const args = [...rawArgs];
  const source = args.shift();
  if (!source || source === 'help' || source === '--help' || source === '-h') {
    showHelp();
    return source ? 0 : 2;
  }
  if (args.length) throw new Error(`unknown pack inspect argument: ${args.join(' ')}`);

  const resolved = resolveInstalledPack(source, cwd);
  const packDir = path.resolve(resolved.dir);
  const manifest = resolved.manifest;
  const state = readJson(upstreamStatePath(packDir));
  const summary = summarizeInstalledFiles(packDir);
  const packType = declaredManifestValue(manifest, ['type', 'packType', 'pack_type', 'pack-type']);
  const entrypoint = hasInspectValue(manifest.entrypoint)
    ? manifest.entrypoint
    : (fs.existsSync(path.join(packDir, 'RUN.md')) ? 'RUN.md' : null);
  const permissions = declaredManifestValue(manifest, ['permissions']);
  const sourceUrls = inspectManifestValue(manifest, [
    'source-urls', 'sourceUrls', 'sourceURLs', 'source_urls', 'source-url', 'sourceUrl', 'source_url', 'sources',
  ]);
  const contentHashes = inspectManifestValue(manifest, [
    'content-hashes', 'contentHashes', 'content_hashes', 'content-hash', 'contentHash', 'content_hash', 'hashes',
  ]);

  console.log(`location: ${packDir}`);
  printRegistryOrigin(manifest, options.deps || {});
  console.log(`installed version: ${manifestVersion(manifest)}`);
  if (!state) {
    console.log('update state: remote never pulled');
  } else {
    const pulledAt = state.pulledAt ? ` at ${state.pulledAt}` : '';
    console.log(`update state: last pulled remote v${state.remoteVersion || 'unknown'}${pulledAt}`);
  }
  console.log(`files: ${summary.files}, total size ${formatBytes(summary.bytes)}`);
  printInstalledTree(summary);
  console.log(`pack type: ${packType === null ? 'undeclared' : formatInspectValue(packType)}`);
  console.log(`entrypoint: ${entrypoint === null ? 'none: this pack has no actionable entry contract' : formatInspectValue(entrypoint)}`);
  console.log(`permissions: ${permissions === null ? 'none declared' : formatInspectValue(permissions)}`);
  console.log('provenance:');
  printProvenanceField('author', inspectManifestValue(manifest, ['author']));
  printProvenanceField('created-in', createdInValue(manifest));
  printProvenanceField('source urls', sourceUrls);
  printProvenanceField('content hashes', contentHashes);
  return 0;
}

async function run(argv = []) {
  const [subcommand, ...args] = argv;
  try {
    if (!subcommand || subcommand === 'help' || subcommand === '--help' || subcommand === '-h') {
      showHelp();
      return subcommand ? 0 : 2;
    }
    // `pack <sub> --help/-h` is a help request, not a subcommand argument: show
    // usage and exit 0 instead of letting the subcommand throw "unknown argument".
    if (args.includes('--help') || args.includes('-h')) {
      showHelp();
      return 0;
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
    if (subcommand === 'run') return await runPack(args);
    if (subcommand === 'share') return sharePack(args);
    if (subcommand === 'pull') return await pullPack(args);
    if (subcommand === 'status') return statusPack(args);
    if (subcommand === 'update') return await updatePack(args);
    if (subcommand === 'inspect') return inspectPack(args);
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
  installPack,
  runPack,
  sanitizePersonalizationName,
  pullPack,
  updatePack,
  inspectPack,
  listInstalledPacks,
  buildManifest,
  comparePackVersions,
  classifyPacketPath,
  collectPacketEntries,
  scanTextForSecrets,
  redactSecret,
  registryLimitFailures,
  REGISTRY_LIMITS,
};
