'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { stateHome } = require('./state-home');
const { syncBusinessCanonical, ensureWorkspaceStateFiles, ensureBusinessRootAgentAdapters } = require('../commands/sync');
const { ensureContextScaffold, writeWikiStatus, appendWikiLog } = require('./wiki');
const { writeRuntimeReceipt } = require('./runtime-bootstrap');

function businessWorkspaceBase() {
  return process.env.ATRIS_BUSINESS_ROOT || path.join(os.homedir(), 'arena', 'atris-business');
}

function getBusinessConfigPath() {
  const dir = path.join(stateHome(), '.atris');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'businesses.json');
}

function slugify(name) {
  return String(name || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function isHelpToken(arg) {
  return arg === '--help' || arg === '-h' || arg === 'help' || arg === '-?';
}

const BUSINESS_CREATE_USAGE = 'Usage: atris business create <name> [--description "..."] [--workspace] [--here|--root <dir>]';
const BUSINESS_SHIP_USAGE = 'Usage: atris business ship "<paragraph>" [--name <name>] [--email <email>] --yes';

function isAccidentalHelpBusiness(value) {
  const raw = String(value || '').trim();
  if (!raw) return false;
  if (isHelpToken(raw)) return true;
  const normalized = slugify(raw);
  if (normalized === 'help') return true;
  if (/^help-\d+$/.test(normalized)) return true;
  return false;
}

function validateBusinessCreateName(name) {
  if (!name || !String(name).trim()) {
    return { ok: false, usage: BUSINESS_CREATE_USAGE };
  }
  if (isHelpToken(name)) {
    return { ok: false, usage: BUSINESS_CREATE_USAGE };
  }
  if (String(name).startsWith('-')) {
    return {
      ok: false,
      usage: BUSINESS_CREATE_USAGE,
      detail: `Refusing to create a business named "${name}", looks like a flag, not a name.`,
    };
  }
  if (isAccidentalHelpBusiness(name)) {
    return {
      ok: false,
      usage: BUSINESS_CREATE_USAGE,
      detail: `Refusing to create a business named "${name}", looks like accidental help output, not a real business.`,
    };
  }
  return { ok: true };
}

function compactShipText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function parseBusinessShipArgs(args = []) {
  const positional = [];
  let name = '';
  let email = '';

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];

    if (arg === '--name') {
      if (!next || String(next).startsWith('-')) {
        return { ok: false, usage: BUSINESS_SHIP_USAGE, detail: 'Missing value for --name.' };
      }
      name = next;
      i++;
    } else if (typeof arg === 'string' && arg.startsWith('--name=')) {
      name = arg.slice('--name='.length);
    } else if (arg === '--email') {
      if (!next || String(next).startsWith('-')) {
        return { ok: false, usage: BUSINESS_SHIP_USAGE, detail: 'Missing value for --email.' };
      }
      email = next;
      i++;
    } else if (typeof arg === 'string' && arg.startsWith('--email=')) {
      email = arg.slice('--email='.length);
    } else if (arg === '--yes' || arg === '-y') {
      // proceed flag; checked by shipBusiness
    } else if (typeof arg === 'string' && arg.startsWith('-')) {
      return { ok: false, usage: BUSINESS_SHIP_USAGE, detail: `Unknown option: ${arg}` };
    } else {
      positional.push(arg);
    }
  }

  const description = compactShipText(positional.join(' '));
  if (!description) {
    return { ok: false, usage: BUSINESS_SHIP_USAGE };
  }

  return {
    ok: true,
    description,
    name: compactShipText(name),
    email: compactShipText(email),
  };
}

function shipTeamNames(team) {
  const rows = Array.isArray(team)
    ? team
    : (Array.isArray(team?.members) ? team.members : []);
  return rows.map((member) => {
    if (typeof member === 'string') return compactShipText(member);
    if (!member || typeof member !== 'object') return '';
    return compactShipText(member.display_name || member.name || member.slug || '');
  }).filter(Boolean);
}

function shipTaskTitle(task) {
  if (!task) return '';
  if (typeof task === 'string') return compactShipText(task);
  if (typeof task !== 'object') return '';
  return compactShipText(task.title || task.name || '');
}

function loadBusinesses() {
  const p = getBusinessConfigPath();
  if (!fs.existsSync(p)) return {};
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return {}; }
}

function businessAliases(business) {
  const aliases = business?.aliases || business?.config?.aliases || [];
  return Array.isArray(aliases) ? aliases : [];
}

function businessMatchesSlug(business, slug, { includeName = false } = {}) {
  if (!business || !slug) return false;
  const wanted = String(slug).toLowerCase();
  const canonical = String(business.slug || '').toLowerCase();
  const aliases = businessAliases(business).map((alias) => String(alias).toLowerCase());
  if (canonical === wanted || aliases.includes(wanted)) return true;
  return includeName && String(business.name || '').toLowerCase() === wanted;
}

function saveBusinesses(data) {
  fs.writeFileSync(getBusinessConfigPath(), JSON.stringify(data, null, 2));
}

function buildBusinessCacheEntry(business, localSlug, existing = {}) {
  const aliases = businessAliases(business);
  const entry = {
    business_id: business.id || business.business_id,
    workspace_id: business.workspace_id,
    name: business.name || localSlug,
    slug: localSlug || business.slug,
    added_at: existing.added_at || new Date().toISOString(),
  };
  if (business.slug && business.slug !== entry.slug) entry.canonical_slug = business.slug;
  else if (business.slug) entry.canonical_slug = business.slug;
  if (aliases.length > 0) entry.aliases = aliases;
  return entry;
}

function readBusinessFolderBindings(rootDir = businessWorkspaceBase()) {
  const skip = new Set([
    '.git', '.DS_Store', 'archive', 'archives', '_archive', 'bench', 'deals',
    'node_modules', 'shelf', '_shelf', 'templates',
  ]);
  if (!fs.existsSync(rootDir)) return [];

  return fs.readdirSync(rootDir, { withFileTypes: true })
    .filter((entry) => !entry.name.startsWith('.') && !skip.has(entry.name))
    .map((entry) => {
      const fullPath = path.join(rootDir, entry.name);
      let isDirectory = entry.isDirectory();
      const isSymlink = entry.isSymbolicLink();
      let symlinkTarget = null;
      if (isSymlink) {
        try {
          symlinkTarget = fs.readlinkSync(fullPath);
          isDirectory = fs.statSync(fullPath).isDirectory();
        } catch {
          isDirectory = false;
        }
      }
      if (!isDirectory) return null;

      const businessJsonPath = path.join(fullPath, '.atris', 'business.json');
      const atrisDir = path.join(fullPath, 'atris');
      const binding = {
        name: entry.name,
        path: fullPath,
        isSymlink,
        symlinkTarget,
        hasAtris: fs.existsSync(atrisDir) && fs.statSync(atrisDir).isDirectory(),
        hasBusinessJson: fs.existsSync(businessJsonPath),
        businessJsonPath,
        meta: null,
        error: null,
      };

      if (binding.hasBusinessJson) {
        try {
          binding.meta = JSON.parse(fs.readFileSync(businessJsonPath, 'utf8'));
        } catch (err) {
          binding.error = err.message || 'invalid JSON';
        }
      }
      return binding;
    })
    .filter(Boolean);
}

function analyzeBusinessDoctor({ cache = {}, cloudBusinesses = [], folderBindings = [] } = {}) {
  const issues = [];
  const cacheUpdates = {};
  const activeById = new Map();
  const activeBySlug = new Map();
  const realFolderIds = new Map();

  for (const business of cloudBusinesses || []) {
    const id = business.id || business.business_id;
    if (!id) continue;
    activeById.set(id, business);
    if (business.slug) {
      const lower = String(business.slug).toLowerCase();
      if (activeBySlug.has(lower)) {
        issues.push({
          level: 'fail',
          code: 'duplicate-active-slug',
          subject: business.slug,
          message: `multiple active cloud businesses use slug ${business.slug}`,
        });
      }
      activeBySlug.set(lower, business);
    }
  }

  const findActiveMatch = (key, entry = {}) => {
    if (entry.business_id && activeById.has(entry.business_id)) return activeById.get(entry.business_id);
    const candidates = [key, entry.slug, entry.canonical_slug, entry.name].filter(Boolean);
    return cloudBusinesses.find((business) =>
      candidates.some((candidate) => businessMatchesSlug(business, candidate, { includeName: true }))
    ) || null;
  };

  for (const [key, entry] of Object.entries(cache || {})) {
    const active = findActiveMatch(key, entry);
    if (!active) {
      issues.push({
        level: 'fail',
        code: 'stale-cache',
        subject: key,
        message: `${key} points at a deleted/inaccessible business (${entry.business_id || 'missing id'})`,
      });
      continue;
    }

    if (entry.business_id && entry.business_id !== active.id) {
      issues.push({
        level: 'fail',
        code: 'stale-cache-repoint',
        subject: key,
        message: `${key} points at ${entry.business_id}; active cloud row is ${active.id}`,
        fixable: true,
      });
      cacheUpdates[key] = buildBusinessCacheEntry(active, key, entry);
    }

    if (!businessMatchesSlug({ ...active, aliases: businessAliases(active) }, key, { includeName: true }) && key !== active.slug) {
      issues.push({
        level: 'warn',
        code: 'cache-key-not-alias',
        subject: key,
        message: `${key} is cached but is not the canonical slug, alias, or name for ${active.slug}`,
      });
    }
  }

  for (const business of cloudBusinesses || []) {
    const canonicalKey = business.slug;
    if (canonicalKey && (!cache[canonicalKey] || cache[canonicalKey].business_id !== business.id)) {
      issues.push({
        level: 'warn',
        code: 'missing-canonical-cache',
        subject: canonicalKey,
        message: `${canonicalKey} is active in cloud but missing/stale in local cache`,
        fixable: true,
      });
      cacheUpdates[canonicalKey] = buildBusinessCacheEntry(business, canonicalKey, cache[canonicalKey]);
    }

    for (const alias of businessAliases(business)) {
      if (!cache[alias] || cache[alias].business_id !== business.id) {
        issues.push({
          level: 'warn',
          code: 'missing-alias-cache',
          subject: alias,
          message: `${alias} is an active alias for ${business.slug} but missing/stale in local cache`,
          fixable: true,
        });
        cacheUpdates[alias] = buildBusinessCacheEntry(business, alias, cache[alias]);
      }
    }
  }

  for (const binding of folderBindings || []) {
    if (binding.error) {
      issues.push({
        level: 'fail',
        code: 'invalid-business-json',
        subject: binding.name,
        message: `${binding.name}/.atris/business.json is invalid: ${binding.error}`,
      });
      continue;
    }

    if (!binding.hasBusinessJson) {
      if (binding.hasAtris && !binding.isSymlink) {
        issues.push({
          level: 'warn',
          code: 'folder-unbound',
          subject: binding.name,
          message: `${binding.name} has atris/ but no .atris/business.json`,
        });
      }
      continue;
    }

    const meta = binding.meta || {};
    const active = findActiveMatch(binding.name, {
      business_id: meta.business_id,
      slug: meta.slug,
      canonical_slug: meta.canonical_slug,
      name: meta.name,
    });

    if (!active) {
      issues.push({
        level: 'fail',
        code: 'stale-folder-binding',
        subject: binding.name,
        message: `${binding.name} is bound to deleted/inaccessible business ${meta.business_id || meta.slug || 'unknown'}`,
      });
      continue;
    }

    if (meta.business_id && meta.business_id !== active.id) {
      issues.push({
        level: 'fail',
        code: 'folder-id-mismatch',
        subject: binding.name,
        message: `${binding.name} points at ${meta.business_id}; active cloud row is ${active.id}`,
      });
    }

    if (meta.slug && !businessMatchesSlug(active, meta.slug, { includeName: true })) {
      issues.push({
        level: 'fail',
        code: 'folder-slug-mismatch',
        subject: binding.name,
        message: `${binding.name} uses slug ${meta.slug}, which is not ${active.slug} or an alias`,
      });
    }

    if (!businessMatchesSlug(active, binding.name, { includeName: false }) && !binding.isSymlink) {
      issues.push({
        level: 'warn',
        code: 'folder-name-not-slug-or-alias',
        subject: binding.name,
        message: `${binding.name} is not a canonical slug or alias for ${active.slug}`,
      });
    }

    if (!binding.isSymlink) {
      const existing = realFolderIds.get(active.id) || [];
      existing.push(binding.name);
      realFolderIds.set(active.id, existing);
    }

    const cacheKey = meta.slug || binding.name;
    if (!cache[cacheKey] || cache[cacheKey].business_id !== active.id) {
      issues.push({
        level: 'warn',
        code: 'folder-cache-missing',
        subject: cacheKey,
        message: `${binding.name} is bound locally but ${cacheKey} is missing/stale in local cache`,
        fixable: true,
      });
      cacheUpdates[cacheKey] = buildBusinessCacheEntry(active, cacheKey, cache[cacheKey]);
    }
  }

  for (const [businessId, names] of realFolderIds.entries()) {
    if (names.length > 1) {
      issues.push({
        level: 'fail',
        code: 'duplicate-real-folders',
        subject: businessId,
        message: `business ${businessId} has multiple real folders: ${names.join(', ')}`,
      });
    }
  }

  const cacheRemovals = [];
  for (const business of cloudBusinesses || []) {
    if (!isAccidentalHelpBusiness(business?.name) && !isAccidentalHelpBusiness(business?.slug)) continue;
    const label = business.slug || business.name || business.id;
    issues.push({
      level: 'warn',
      code: 'accidental-help-business',
      subject: label,
      message: `${label} looks like an accidental help business (April 2026 ghost rows)`,
      fixable: true,
    });
  }

  for (const [key, entry] of Object.entries(cache || {})) {
    const active = findActiveMatch(key, entry);
    const accidental = isAccidentalHelpBusiness(key)
      || isAccidentalHelpBusiness(entry?.name)
      || isAccidentalHelpBusiness(entry?.slug)
      || (active && (isAccidentalHelpBusiness(active.name) || isAccidentalHelpBusiness(active.slug)));
    if (!accidental) continue;
    issues.push({
      level: 'warn',
      code: 'accidental-help-cache',
      subject: key,
      message: `${key} is cached for an accidental help business`,
      fixable: true,
    });
    if (!cacheRemovals.includes(key)) cacheRemovals.push(key);
  }

  return {
    issues,
    cacheUpdates,
    cacheRemovals,
    stats: {
      cache_entries: Object.keys(cache || {}).length,
      cloud_active: cloudBusinesses.length,
      folders: folderBindings.length,
      fixable_cache_entries: Object.keys(cacheUpdates).length,
      accidental_help_cache_removals: cacheRemovals.length,
    },
  };
}

function parseCreateBusinessFlags(flags, cwd = process.cwd()) {
  const options = {
    description: '',
    template: null,
    ownerEmail: '',
    noLocal: false,
    workspace: false,
    here: false,
    root: null,
    cwd,
  };

  for (let i = 0; i < flags.length; i++) {
    const flag = flags[i];
    const next = flags[i + 1];

    if ((flag === '--description' || flag === '-d') && next) {
      options.description = next;
      i++;
    } else if ((flag === '--template' || flag === '-t') && next) {
      options.template = next;
      i++;
    } else if (flag === '--owner-email' && next) {
      options.ownerEmail = next;
      i++;
    } else if ((flag === '--root' || flag === '--workspace-root') && next) {
      options.root = path.resolve(cwd, next);
      options.workspace = true;
      i++;
    } else if (flag === '--here') {
      options.here = true;
      options.workspace = true;
    } else if (flag === '--workspace' || flag === '--local-workspace') {
      options.workspace = true;
    } else if (flag === '--no-local') {
      options.noLocal = true;
    }
  }

  return options;
}

function resolveWorkspaceRoot(slug, options = {}) {
  if (options.noLocal) return null;
  if (options.here) return options.cwd || process.cwd();
  if (options.root) return path.join(options.root, slug);
  return path.join(businessWorkspaceBase(), slug);
}

function createCanonicalBusinessWorkspace(targetRoot, bizMeta, options = {}) {
  if (!targetRoot) {
    throw new Error('No target directory provided for business workspace.');
  }

  if (options.here !== true && fs.existsSync(targetRoot) && !fs.statSync(targetRoot).isDirectory()) {
    throw new Error(`Target path is not a directory: ${targetRoot}`);
  }

  fs.mkdirSync(targetRoot, { recursive: true });

  const atrisMetaDir = path.join(targetRoot, '.atris');
  const businessJsonPath = path.join(atrisMetaDir, 'business.json');
  if (fs.existsSync(businessJsonPath)) {
    throw new Error(`Target already contains .atris/business.json: ${targetRoot}`);
  }

  const workspaceTemplate = options.templateName || bizMeta.workspace_template || 'business';
  fs.mkdirSync(atrisMetaDir, { recursive: true });
  fs.writeFileSync(businessJsonPath, JSON.stringify({
    business_id: bizMeta.business_id,
    workspace_id: bizMeta.workspace_id,
    name: bizMeta.name,
    slug: bizMeta.slug,
    owner_email: bizMeta.owner_email || '',
    workspace_template: workspaceTemplate,
    created_at: new Date().toISOString(),
  }, null, 2));

  const syncResult = syncBusinessCanonical(targetRoot, bizMeta, { force: false, dryRun: false, templateName: workspaceTemplate });
  const agentAdapters = syncResult?.agentAdapterList || ensureBusinessRootAgentAdapters(targetRoot, bizMeta);
  writeRuntimeReceipt(targetRoot, {
    scope: 'local-business-computer',
    boundary: 'business-workspace-scaffold',
    business_id: bizMeta.business_id,
    workspace_id: bizMeta.workspace_id,
    business_slug: bizMeta.slug,
    business_name: bizMeta.name,
    workspace_template: workspaceTemplate,
    install_status: 'local_cli_present',
    sync_status: 'templates_seeded',
    agent_adapters: agentAdapters,
  });
  return { targetRoot, businessJsonPath, workspaceTemplate, agentAdapters };
}

function parseRecordFlags(args, cwd = process.cwd()) {
  const options = {
    cwd,
    reportPath: null,
    summary: '',
    metric: '',
    outcome: 'recorded',
    reward: null,
    loop: 'manual',
    actor: 'operator',
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];

    if ((arg === '--summary' || arg === '-s') && next) {
      options.summary = next;
      i++;
    } else if ((arg === '--metric' || arg === '-m') && next) {
      options.metric = next;
      i++;
    } else if ((arg === '--outcome' || arg === '-o') && next) {
      options.outcome = next;
      i++;
    } else if ((arg === '--reward' || arg === '-r') && next) {
      options.reward = next;
      i++;
    } else if (arg === '--loop' && next) {
      options.loop = next;
      i++;
    } else if (arg === '--actor' && next) {
      options.actor = next;
      i++;
    } else if (!arg.startsWith('-') && !options.reportPath) {
      options.reportPath = arg;
    }
  }

  return options;
}

function parseShareFlags(args, cwd = process.cwd()) {
  const options = {
    cwd,
    role: 'collaborator',
    name: '',
    email: '',
    write: false,
    out: null,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    if ((arg === '--role' || arg === '-r') && next) {
      options.role = next;
      i++;
    } else if ((arg === '--name' || arg === '--person') && next) {
      options.name = next;
      i++;
    } else if (arg === '--email' && next) {
      options.email = next;
      i++;
    } else if (arg === '--write') {
      options.write = true;
    } else if (arg === '--out' && next) {
      options.out = next;
      options.write = true;
      i++;
    } else if (arg.startsWith('--out=')) {
      options.out = arg.slice('--out='.length);
      options.write = true;
    } else if ((arg === '--cwd' || arg === '--workspace') && next) {
      options.cwd = path.resolve(cwd, next);
      i++;
    } else if (arg.startsWith('--cwd=')) {
      options.cwd = path.resolve(cwd, arg.slice('--cwd='.length));
    } else if (arg.startsWith('--workspace=')) {
      options.cwd = path.resolve(cwd, arg.slice('--workspace='.length));
    }
  }

  return options;
}

function parseOnboardFlags(args, cwd = process.cwd()) {
  const options = {
    cwd,
    name: '',
    website: '',
    links: [],
    notes: [],
    sources: [],
    contactName: '',
    contactEmail: '',
    contactRole: '',
  };
  const freeform = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];

    if ((arg === '--name' || arg === '--business') && next) {
      options.name = next;
      i++;
    } else if ((arg === '--website' || arg === '--site') && next) {
      options.website = next;
      i++;
    } else if ((arg === '--link' || arg === '--url') && next) {
      options.links.push(next);
      i++;
    } else if ((arg === '--from' || arg === '--source') && next) {
      options.sources.push(next);
      i++;
    } else if ((arg === '--note' || arg === '--notes') && next) {
      options.notes.push(next);
      i++;
    } else if ((arg === '--contact' || arg === '--person') && next) {
      options.contactName = next;
      i++;
    } else if (arg === '--email' && next) {
      options.contactEmail = next;
      i++;
    } else if (arg === '--role' && next) {
      options.contactRole = next;
      i++;
    } else if (!arg.startsWith('-')) {
      const resolved = path.resolve(cwd, arg);
      if (/^https?:\/\//i.test(arg)) {
        if (!options.website) options.website = arg;
        else options.links.push(arg);
      } else if (fs.existsSync(resolved)) {
        options.sources.push(arg);
      } else {
        freeform.push(arg);
      }
    }
  }

  if (freeform.length > 0) {
    options.notes.push(freeform.join(' '));
  }

  return options;
}

function readWorkspaceBusinessMeta(cwd = process.cwd()) {
  const bizFile = path.join(cwd, '.atris', 'business.json');
  if (!fs.existsSync(bizFile)) {
    throw new Error('Run this command inside a business environment with .atris/business.json.');
  }
  try {
    return JSON.parse(fs.readFileSync(bizFile, 'utf8'));
  } catch (error) {
    throw new Error(`Failed to read .atris/business.json: ${error.message}`);
  }
}

function resolveWorkspaceReport(cwd, reportPath) {
  if (!reportPath) {
    throw new Error('Usage: atris business record <report-path> [--summary "text"] [--metric name] [--outcome positive|mixed|negative] [--reward N]');
  }
  const absPath = path.resolve(cwd, reportPath);
  if (!fs.existsSync(absPath) || !fs.statSync(absPath).isFile()) {
    throw new Error(`Report not found: ${reportPath}`);
  }
  const relPath = path.relative(cwd, absPath).replace(/\\/g, '/');
  return { absPath, relPath };
}

function extractReportTitle(content, absPath) {
  const heading = String(content || '').match(/^#\s+(.+)$/m);
  if (heading) return heading[1].trim();
  return path.basename(absPath, path.extname(absPath));
}

function normalizeOutcome(value) {
  const normalized = String(value || 'recorded').trim().toLowerCase();
  if (['positive', 'win', 'success', 'improved'].includes(normalized)) return 'positive';
  if (['negative', 'loss', 'failed', 'regressed'].includes(normalized)) return 'negative';
  if (['mixed', 'partial', 'unclear'].includes(normalized)) return 'mixed';
  return 'recorded';
}

function defaultRewardForOutcome(outcome) {
  if (outcome === 'positive') return 5;
  if (outcome === 'negative') return -3;
  if (outcome === 'mixed') return 1;
  return 0;
}

function appendJsonl(filePath, record) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`, 'utf8');
}

function countJsonlRows(filePath) {
  if (!fs.existsSync(filePath)) return 0;
  return fs.readFileSync(filePath, 'utf8').split(/\r?\n/).filter(line => line.trim()).length;
}

function readJsonFile(filePath, fallback = null) {
  if (!fs.existsSync(filePath)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function readJsonlRows(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter(Boolean);
}

function countFiles(dir, predicate = () => true) {
  if (!fs.existsSync(dir)) return 0;
  try {
    return fs.readdirSync(dir).filter(predicate).length;
  } catch {
    return 0;
  }
}

function latestMatchingFile(dir, predicate = () => true) {
  if (!fs.existsSync(dir)) return null;
  const rows = fs.readdirSync(dir)
    .filter(predicate)
    .map((name) => {
      const full = path.join(dir, name);
      let mtime = 0;
      try { mtime = fs.statSync(full).mtimeMs; } catch {}
      return { name, full, mtime };
    })
    .sort((a, b) => b.mtime - a.mtime);
  return rows[0]?.full || null;
}

function rel(cwd, filePath) {
  return filePath ? path.relative(cwd, filePath).replace(/\\/g, '/') : null;
}

function hasCloudWorkspaceId(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return Boolean(normalized && normalized !== 'local-only');
}

function countBusinessTeamGoals(teamDir) {
  if (!fs.existsSync(teamDir)) return { members: 0, activeGoalMembers: 0 };
  let members = 0;
  let activeGoalMembers = 0;
  for (const name of fs.readdirSync(teamDir).filter(entry => !entry.startsWith('.'))) {
    const memberDir = path.join(teamDir, name);
    if (!fs.existsSync(path.join(memberDir, 'MEMBER.md'))) continue;
    members++;
    const goals = readJsonFile(path.join(memberDir, 'goals.json'), { goals: [] });
    const activeGoals = Array.isArray(goals?.goals) ? goals.goals.filter(goal => goal.status === 'active') : [];
    if (activeGoals.length > 0) activeGoalMembers++;
  }
  return { members, activeGoalMembers };
}

function collectBusinessOperatingState(cwd = process.cwd(), nowMs = Date.now()) {
  const stateDir = path.join(cwd, '.atris', 'state');
  const projection = readJsonFile(path.join(stateDir, 'tasks.projection.json'), { tasks: [] }) || { tasks: [] };
  const tasks = Array.isArray(projection.tasks) ? projection.tasks : [];
  const taskCounts = {
    open: tasks.filter(task => task.status === 'open').length,
    claimed: tasks.filter(task => task.status === 'claimed').length,
    review: tasks.filter(task => task.status === 'review').length,
    certifiedReview: tasks.filter(task => task.status === 'review' && task.metadata?.agent_certified).length,
    blocked: tasks.filter(task => task.status === 'blocked').length,
  };

  const missionsById = new Map();
  for (const mission of readJsonlRows(path.join(stateDir, 'missions.jsonl'))) {
    if (mission?.id) missionsById.set(mission.id, mission);
  }
  const missions = [...missionsById.values()];
  const terminal = new Set(['complete', 'completed', 'stopped', 'cancelled', 'done']);
  const activeMissions = missions.filter(mission => !terminal.has(String(mission.status || '').toLowerCase()));
  const staleMissions = activeMissions.filter((mission) => {
    const status = String(mission.status || '').toLowerCase();
    const lastTick = mission.last_tick_at ? Date.parse(mission.last_tick_at) : 0;
    return status === 'running' && (!mission.verifier || !lastTick || nowMs - lastTick > 3 * 24 * 60 * 60 * 1000);
  });
  const missionEvents = readJsonlRows(path.join(stateDir, 'mission_events.jsonl'));
  const codexGoal = readJsonFile(path.join(stateDir, 'codex_goal.json'), {}) || {};
  const xp = readJsonFile(path.join(stateDir, 'career_xp.projection.json'), {}) || {};
  const team = countBusinessTeamGoals(path.join(cwd, 'atris', 'team'));

  return {
    tasks: taskCounts,
    missions: {
      active: activeMissions.length,
      running: activeMissions.filter(mission => mission.status === 'running').length,
      alwaysOn: activeMissions.filter(mission => mission.always_on).length,
      stale: staleMissions.length,
    },
    loop: {
      ticks: missionEvents.filter(event => event.type === 'mission_tick').length,
      codexGoal: codexGoal.goal?.objective || '',
    },
    team,
    xp: {
      metric: xp.metric_label || 'AgentXP',
      total: Number(xp.total_agent_xp ?? xp.agent_xp ?? xp.total_xp ?? 0) || 0,
      today: Number(xp.today_agent_xp ?? xp.today_xp ?? 0) || 0,
      receipts: countJsonlRows(path.join(stateDir, 'career_xp_receipts.jsonl')),
      integrity: xp.integrity_status || 'unknown',
    },
  };
}

function seedBusinessStarterTask(cwd, todoPath, starterAction) {
  const title = `${starterAction.title}: ${starterAction.action}`;
  try {
    const taskDb = require('./task-db');
    const db = taskDb.open();
    const workspaceRoot = taskDb.workspaceRoot(cwd);
    const sourceKey = taskDb.sourceKey(todoPath, title);
    const result = taskDb.addTask(db, {
      title,
      tag: 'execute',
      workspaceRoot,
      sourceKey,
      metadata: {
        source: 'business_onboard',
        todo_id: 'Onboard',
        todo_tags: ['execute'],
        business_slug: readWorkspaceBusinessMeta(cwd).slug || null,
        verify: 'atris business record atris/reports/<recap>.md --outcome mixed --metric "operator speed"',
      },
    });
    const projection = taskDb.taskProjection(db, { workspaceRoot, limit: 500 });
    const projectionPath = path.join(cwd, '.atris', 'state', 'tasks.projection.json');
    fs.mkdirSync(path.dirname(projectionPath), { recursive: true });
    fs.writeFileSync(projectionPath, `${JSON.stringify(projection, null, 2)}\n`, 'utf8');
    return { ok: true, inserted: Boolean(result.inserted), taskId: result.id, projectionPath };
  } catch (error) {
    return { ok: false, error: error && error.message ? error.message : String(error) };
  }
}

function slugifyName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'item';
}

function collectBusinessShareState(cwd = process.cwd()) {
  const bizMeta = readWorkspaceBusinessMeta(cwd);
  const remoteReady = hasCloudWorkspaceId(bizMeta.business_id) && hasCloudWorkspaceId(bizMeta.workspace_id);
  const reportsDir = path.join(cwd, 'atris', 'reports');
  const briefsDir = path.join(cwd, 'atris', 'wiki', 'briefs');
  const conceptsDir = path.join(cwd, 'atris', 'wiki', 'concepts');
  const ingestDir = path.join(cwd, 'atris', 'context', '_ingest');
  const teamDir = path.join(cwd, 'atris', 'team');
  const teamStartPath = path.join(teamDir, 'START_HERE.md');
  const stateDir = path.join(cwd, '.atris', 'state');
  const rootAgentAdapterNames = ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md'];
  const rootAgentAdapters = rootAgentAdapterNames.filter(name => fs.existsSync(path.join(cwd, name)));
  const scaffold = {
    map: fs.existsSync(path.join(cwd, 'atris', 'MAP.md')),
    todo: fs.existsSync(path.join(cwd, 'atris', 'TODO.md')),
    persona: fs.existsSync(path.join(cwd, 'atris', 'PERSONA.md')),
    runtime: fs.existsSync(path.join(stateDir, 'runtime.json')),
    sync: fs.existsSync(path.join(stateDir, '_sync.json')),
  };
  const starterBrief = latestMatchingFile(briefsDir, name => /starter-brief\.md$/i.test(name));
  const expectedFirstLoop = `${bizMeta.slug || slugifyName(bizMeta.name)}-first-loop.md`;
  const firstLoop = latestMatchingFile(conceptsDir, name => name === expectedFirstLoop);
  const onePager = latestMatchingFile(reportsDir, name => /one-pager|cheat-sheet|onboarding/i.test(name));
  const reports = countFiles(reportsDir, name => /\.(md|json)$/i.test(name));
  const teamMembers = countFiles(teamDir, name => !name.startsWith('.') && fs.existsSync(path.join(teamDir, name, 'MEMBER.md')));
  const events = countJsonlRows(path.join(stateDir, 'events.jsonl'));
  const episodes = countJsonlRows(path.join(stateDir, 'episodes.jsonl'));
  const scorecards = countJsonlRows(path.join(stateDir, 'scorecards.jsonl'));
  const missing = [];
  if (!scaffold.map || !scaffold.todo || !scaffold.persona) missing.push('canonical Atris scaffold');
  if (!scaffold.runtime) missing.push('runtime receipt');
  if (!scaffold.sync) missing.push('sync state');
  if (!starterBrief) missing.push('starter brief');
  if (!firstLoop) missing.push('first loop');
  if (!onePager) missing.push('operator one-pager');
  if (teamMembers < 1) missing.push('team member lanes');
  if (!fs.existsSync(teamStartPath)) missing.push('team start guide');
  if (rootAgentAdapters.length < rootAgentAdapterNames.length) missing.push('root agent adapters');
  if (scorecards < 1 && events < 1 && episodes < 1) missing.push('first proof recap');

  return {
    bizMeta,
    scaffold,
    starterBrief: rel(cwd, starterBrief),
    firstLoop: rel(cwd, firstLoop),
    onePager: rel(cwd, onePager),
    teamStart: rel(cwd, fs.existsSync(teamStartPath) ? teamStartPath : null),
    rootAgentAdapters,
    missingRootAgentAdapters: rootAgentAdapterNames.filter(name => !rootAgentAdapters.includes(name)),
    remoteReady,
    os: collectBusinessOperatingState(cwd),
    ingestPacks: countFiles(ingestDir, name => !name.startsWith('.')),
    reports,
    teamMembers,
    proof: { events, episodes, scorecards },
    ready: missing.length === 0,
    missing,
  };
}

function renderBusinessOsLines(os = {}, prefix = '- ') {
  const tasks = os.tasks || {};
  const missions = os.missions || {};
  const team = os.team || {};
  const xp = os.xp || {};
  const loop = os.loop || {};
  return [
    `${prefix}Tasks: ${tasks.open || 0} open, ${tasks.claimed || 0} claimed, ${tasks.review || 0} review (${tasks.certifiedReview || 0} certified), ${tasks.blocked || 0} blocked`,
    `${prefix}Missions: ${missions.active || 0} active, ${missions.running || 0} running, ${missions.alwaysOn || 0} always-on, ${missions.stale || 0} stale/no-verifier`,
    `${prefix}Team goals: ${team.members || 0} member lanes, ${team.activeGoalMembers || 0} with active goals`,
    `${prefix}${xp.metric || 'AgentXP'}: ${xp.total || 0} total, ${xp.today || 0} today, ${xp.receipts || 0} receipts, integrity ${xp.integrity || 'unknown'}`,
    `${prefix}Loop: ${loop.ticks || 0} mission ticks; Codex goal ${loop.codexGoal || 'none'}`,
    `${prefix}XP gate: proof can move to Review; XP is awarded only after human approval`,
  ];
}

function shellDoubleQuote(value) {
  return `"${String(value || '').replace(/(["\\$`])/g, '\\$1')}"`;
}

function renderBusinessMissionBootstrapLines(bizMeta = {}, prefix = '') {
  const missionTitle = shellDoubleQuote(`Run the first useful loop for ${bizMeta.name || bizMeta.slug || 'this business'}`);
  return [
    `${prefix}atris mission status --status active --json`,
    `${prefix}# If no active mission exists:`,
    `${prefix}atris mission start ${missionTitle} --owner operator --runner codex_goal --lane business --verify "atris business check" --stop "first proof recap recorded"`,
    `${prefix}atris member goal-from-mission operator`,
  ];
}

function renderBusinessMissingAction(missing) {
  if (!missing) return 'Start from the first loop, ship one small artifact, then record the recap.';
  if (missing === 'root agent adapters') {
    return 'Run `atris update` to restore root AGENTS.md, CLAUDE.md, and GEMINI.md adapters.';
  }
  return `Add ${missing}.`;
}

function renderBusinessCreatedNextSteps(bizMeta = {}, workspaceRoot = '.') {
  const lines = [
    '  Atris:     seeded local computer + operator + validator',
    '',
    '  Start here:',
    `    cd ${workspaceRoot}`,
    '    atris',
    '    atris business start',
    '    atris radar',
    '    atris task next',
    '    atris member activate operator',
    ...renderBusinessMissionBootstrapLines(bizMeta, '    '),
    '',
    '  First loop:',
    '    atris business onboard --website <url> --contact "Name" --note "what they do"',
    '    atris do',
    '    atris business record atris/reports/<recap>.md --outcome mixed --metric "operator speed"',
    '    atris business share --write',
    '',
    '  Sync when ready:',
    '    atris sync --dry-run',
    '    atris sync',
  ];
  return lines.join('\n');
}

function renderBusinessShareHandoff(state, options = {}) {
  const { bizMeta } = state;
  const role = options.role || 'collaborator';
  const person = options.name || role;
  const workspacePath = options.cwd || process.cwd();
  const firstMissing = state.missing[0] || null;
  const lines = [
    `# ${bizMeta.name} Share Handoff`,
    '',
    `For: ${person}${options.email ? ` <${options.email}>` : ''}`,
    `Role: ${role}`,
    `Business: ${bizMeta.name} (${bizMeta.slug})`,
    `Business ID: ${bizMeta.business_id || 'local-only'}`,
    `Workspace ID: ${bizMeta.workspace_id || 'local-only'}`,
    `Local path: ${workspacePath}`,
    `Ready to share: ${state.ready ? 'yes' : 'no'}`,
    `Remote pull: ${state.remoteReady ? 'available' : 'local-only'}`,
    `Agent setup: ${(state.missingRootAgentAdapters && state.missingRootAgentAdapters.length) ? 'missing root agent adapters' : 'ready'}`,
    '',
    '## Get The Workspace',
    '',
    'If this folder is already on your machine:',
    '',
    '```bash',
    `cd ${workspacePath}`,
    'atris business start',
    '```',
    '',
    state.remoteReady ? 'If you need to pull it first:' : 'Remote pull is not available yet:',
    '',
    ...(state.remoteReady ? [
      '```bash',
      `atris pull ${bizMeta.slug}`,
      `cd ${bizMeta.slug}`,
      'atris sync --dry-run',
      'atris business start',
      '```',
    ] : [
      '- This workspace is local-only because it is missing a cloud business ID or workspace ID.',
      '- Share the folder directly, or create/pull the cloud business workspace before sending this handoff.',
    ]),
    '',
    '## Start Here',
    '',
    '```bash',
    `cd ${workspacePath}`,
    'atris',
    'atris business start',
    'atris radar',
    'atris task next',
    'atris member activate operator',
    ...renderBusinessMissionBootstrapLines(bizMeta),
    '```',
    '',
    '## What To Read',
    '',
    `- Protocol: atris/atris.md`,
    `- Map: atris/MAP.md`,
    `- Queue: atris/TODO.md`,
    `- Team start: ${state.teamStart || 'missing'}`,
    `- Starter brief: ${state.starterBrief || 'missing'}`,
    `- First loop: ${state.firstLoop || 'missing'}`,
    `- Operator one-pager: ${state.onePager || 'missing'}`,
    '',
    '## First Useful Loop',
    '',
    '```bash',
    'atris business onboard --website <url> --contact "Name" --note "what changed"',
    state.remoteReady ? 'atris sync --dry-run' : '# local-only: no cloud sync is available yet',
    'atris task next',
    ...renderBusinessMissionBootstrapLines(bizMeta),
    'atris do',
    'atris business record atris/reports/<recap>.md --outcome mixed --metric "operator speed"',
    'atris business share --write',
    state.remoteReady ? 'atris sync' : '# local-only: share the folder directly',
    '```',
    '',
    '## Proof State',
    '',
    `- Team lanes: ${state.teamMembers}`,
    `- Onboarding packs: ${state.ingestPacks}`,
    `- Reports: ${state.reports}`,
    `- Events: ${state.proof.events}`,
    `- Episodes: ${state.proof.episodes}`,
    `- Scorecards: ${state.proof.scorecards}`,
    '',
    '## Atris OS State',
    '',
    ...renderBusinessOsLines(state.os),
    '',
    'Useful commands:',
    '',
    '```bash',
    state.remoteReady ? 'atris sync --status' : '# local-only: no cloud sync status yet',
    state.remoteReady ? 'atris sync --watch' : '# local-only: no cloud watcher yet',
    'atris radar',
    'atris task next',
    ...renderBusinessMissionBootstrapLines(bizMeta),
    'atris xp status --local --json',
    '```',
    '',
    '## Next Action',
    '',
    `- ${renderBusinessMissingAction(firstMissing)}`,
    '',
    '## Guardrails',
    '',
    '- Do not mix another business into this workspace.',
    '- No external sends without operator approval.',
    '- No XP until proof is accepted by a human.',
    '',
  ];
  return lines.join('\n');
}

function renderBusinessStartCard(state, options = {}) {
  const { bizMeta } = state;
  const workspacePath = options.cwd || process.cwd();
  const firstMissing = state.missing[0] || null;
  const lines = [
    `${bizMeta.name} collaborator start`,
    '',
    `Business: ${bizMeta.name} (${bizMeta.slug})`,
    `Workspace: ${workspacePath}`,
    `Ready: ${state.ready ? 'yes' : 'no'}`,
    `Remote pull: ${state.remoteReady ? 'available' : 'local-only'}`,
    `Agent setup: ${(state.missingRootAgentAdapters && state.missingRootAgentAdapters.length) ? 'missing root agent adapters' : 'ready'}`,
    '',
    'Read:',
    `- atris/atris.md`,
    `- atris/MAP.md`,
    `- atris/TODO.md`,
    `- ${state.teamStart || 'missing team start guide'}`,
    `- ${state.starterBrief || 'missing starter brief'}`,
    `- ${state.firstLoop || 'missing first loop'}`,
    `- ${state.onePager || 'missing operator one-pager'}`,
    '',
    'Run:',
    state.remoteReady ? '  atris sync --dry-run' : '  # local-only: no cloud sync is available yet',
    '  atris',
    '  atris business start',
    '  atris radar',
    '  atris task next',
    '  atris member activate operator',
    ...renderBusinessMissionBootstrapLines(bizMeta, '  '),
    '  atris do',
    '  atris business record atris/reports/<recap>.md --outcome mixed --metric "operator speed"',
    '  atris business share --write',
    state.remoteReady ? '  atris sync' : '  # local-only: share the folder directly',
    state.remoteReady ? '  atris sync --watch' : '  # local-only: no cloud watcher yet',
    '',
    'Proof:',
    `- team lanes: ${state.teamMembers}`,
    `- onboarding packs: ${state.ingestPacks}`,
    `- scorecards: ${state.proof.scorecards}`,
    '',
    'OS:',
    ...renderBusinessOsLines(state.os, '  '),
    '',
    'Next:',
    `- ${state.ready ? 'Work the first loop, record the recap, then rewrite the share handoff.' : renderBusinessMissingAction(firstMissing)}`,
    '',
  ];
  return lines.join('\n');
}

async function startBusinessWorkspace(...args) {
  const options = parseShareFlags(args, process.cwd());
  const state = collectBusinessShareState(options.cwd);
  const content = renderBusinessStartCard(state, options);
  console.log(content);
  return state;
}

// Local calendar day; toISOString is UTC and dates evening work tomorrow
// anywhere west of Greenwich.
function localDay(now = new Date()) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function defaultSharePath(cwd, role) {
  const stamp = localDay();
  const roleSlug = slugifyName(role || 'collaborator');
  return path.join(cwd, 'atris', 'reports', `${stamp}-share-${roleSlug}.md`);
}

async function shareBusinessWorkspace(...args) {
  const options = parseShareFlags(args, process.cwd());
  const state = collectBusinessShareState(options.cwd);
  const content = renderBusinessShareHandoff(state, options);
  console.log(content);

  if (options.write || options.out) {
    const outputPath = options.out
      ? (path.isAbsolute(options.out) ? options.out : path.join(options.cwd, options.out))
      : defaultSharePath(options.cwd, options.role);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, content, 'utf8');
    console.log(`Wrote ${path.relative(options.cwd, outputPath).replace(/\\/g, '/')}`);
    return outputPath;
  }

  return state;
}

function upsertIndexEntry(indexPath, sectionName, relativePath, description) {
  const normalizedPath = relativePath.replace(/\\/g, '/');
  const entryLine = `- [[${normalizedPath}]] - ${description}`;
  let lines = fs.readFileSync(indexPath, 'utf8').split('\n');
  const existingIndex = lines.findIndex((line) => line.includes(`[[${normalizedPath}]]`));
  if (existingIndex >= 0) {
    lines[existingIndex] = entryLine;
    fs.writeFileSync(indexPath, `${lines.join('\n').replace(/\n*$/, '\n')}`, 'utf8');
    return;
  }

  const header = `## ${sectionName}`;
  const sectionIndex = lines.findIndex((line) => line.trim() === header);
  if (sectionIndex === -1) return;

  let insertAt = sectionIndex + 1;
  while (insertAt < lines.length && !/^##\s+/.test(lines[insertAt])) {
    insertAt++;
  }

  lines.splice(insertAt, 0, entryLine);
  fs.writeFileSync(indexPath, `${lines.join('\n').replace(/\n*$/, '\n')}`, 'utf8');
}

function writeMarkdownWithFrontmatter(filePath, frontmatter, body) {
  const yaml = Object.entries(frontmatter).map(([key, value]) => {
    if (Array.isArray(value)) {
      return `${key}:\n${value.map((item) => `  - ${item}`).join('\n')}`;
    }
    return `${key}: ${value}`;
  }).join('\n');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `---\n${yaml}\n---\n\n${body.trim()}\n`, 'utf8');
}

function walkOnboardingFiles(dir, options = {}) {
  const skipDirs = new Set(['.git', '.atris', 'atris', '_ingest', 'node_modules', 'dist', 'build', 'coverage', '.next']);
  const allowedExt = new Set(['.md', '.txt', '.pdf', '.csv', '.json', '.html', '.htm', '.docx', '.xlsx', '.png', '.jpg', '.jpeg']);
  const maxFiles = options.maxFiles || 25;
  const output = [];

  function walk(currentDir) {
    if (!fs.existsSync(currentDir) || output.length >= maxFiles) return;
    for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
      if (output.length >= maxFiles) break;
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        if (skipDirs.has(entry.name)) continue;
        walk(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (entry.name.startsWith('.')) continue;
      if (!allowedExt.has(path.extname(entry.name).toLowerCase())) continue;
      output.push(fullPath);
    }
  }

  walk(dir);
  return output;
}

function extractUrlsFromText(text) {
  return Array.from(new Set((String(text || '').match(/https?:\/\/[^\s)<>"']+/g) || []).map((item) => item.replace(/[.,]$/, ''))));
}

function isTextLike(filePath) {
  return new Set(['.md', '.txt', '.json', '.csv', '.html', '.htm']).has(path.extname(filePath).toLowerCase());
}

function readSmallText(filePath, maxBytes = 200000) {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > maxBytes || !isTextLike(filePath)) return null;
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

function discoverOnboardingSignals(cwd, options = {}) {
  const explicitSourcePaths = (options.sources || [])
    .map((value) => path.resolve(cwd, value))
    .filter((fullPath) => fs.existsSync(fullPath));

  const rootCandidates = walkOnboardingFiles(cwd, { maxFiles: 20 })
    .filter((fullPath) => {
      const relative = path.relative(cwd, fullPath).replace(/\\/g, '/');
      return !relative.startsWith('atris/') && !relative.startsWith('.atris/');
    });

  const contextDir = path.join(cwd, 'atris', 'context');
  const contextCandidates = walkOnboardingFiles(contextDir, { maxFiles: 20 })
    .filter((fullPath) => {
      const relative = path.relative(contextDir, fullPath).replace(/\\/g, '/');
      return !relative.startsWith('_ingest/') && relative !== 'README.md' && relative !== 'live-workspace.md';
    });

  const sourcePaths = Array.from(new Set([...explicitSourcePaths, ...rootCandidates, ...contextCandidates]));
  const urls = new Set([options.website, ...(options.links || [])].filter(Boolean));

  for (const note of options.notes || []) {
    for (const url of extractUrlsFromText(note)) urls.add(url);
  }

  for (const sourcePath of sourcePaths) {
    const text = readSmallText(sourcePath);
    if (!text) continue;
    for (const url of extractUrlsFromText(text)) urls.add(url);
  }

  return {
    website: options.website || Array.from(urls)[0] || '',
    urls: Array.from(urls),
    sourcePaths,
  };
}

function stageOnboardingSources(cwd, packDir, sourcePaths = []) {
  const stagedDir = path.join(packDir, 'sources');
  fs.mkdirSync(stagedDir, { recursive: true });
  const stagedEntries = [];
  let counter = 0;

  for (const sourcePath of sourcePaths) {
    if (!fs.existsSync(sourcePath)) continue;
    counter += 1;
    const baseName = path.basename(sourcePath);
    const targetPath = path.join(stagedDir, `${String(counter).padStart(2, '0')}-${baseName}`);
    const stat = fs.statSync(sourcePath);
    if (stat.isDirectory()) {
      fs.cpSync(sourcePath, targetPath, { recursive: true });
    } else {
      fs.copyFileSync(sourcePath, targetPath);
    }
    stagedEntries.push({
      original: path.relative(cwd, sourcePath).replace(/\\/g, '/'),
      staged: path.relative(cwd, targetPath).replace(/\\/g, '/'),
      kind: stat.isDirectory() ? 'directory' : 'file',
    });
  }

  return stagedEntries;
}

function suggestStarterAction(signals) {
  if (signals.contactEmail && signals.website) {
    return {
      title: 'Draft a founder-context note',
      action: `Write a short note to ${signals.contactName || 'the contact'} that reflects the website, asks for the current priority, and proposes one concrete first loop.`,
      why: 'This is the shortest safe path to real feedback from a named human.',
    };
  }
  if (signals.website) {
    return {
      title: 'Map the offer into one loop',
      action: 'Read the website and turn it into one measurable workflow with a clear reward signal.',
      why: 'A website is enough to define a first useful business loop without waiting for perfect intake.',
    };
  }
  if ((signals.sourceEntries || []).length > 0) {
    return {
      title: 'Extract the first workflow from local evidence',
      action: 'Read the strongest local source, summarize what the company does, and choose one workflow worth operationalizing first.',
      why: 'Local evidence is already better than a blank template and can anchor the first action.',
    };
  }
  return {
    title: 'Collect one anchor signal',
    action: 'Get one website, one named human, or one source doc so the environment can stop guessing.',
    why: 'The system can work from partial input, but it still needs one concrete anchor.',
  };
}

async function onboardBusiness(...flags) {
  const options = parseOnboardFlags(flags, process.cwd());
  const cwd = options.cwd || process.cwd();

  const bizFile = path.join(cwd, '.atris', 'business.json');
  if (!fs.existsSync(bizFile) && options.name) {
    const slug = slugifyName(options.name);
    createCanonicalBusinessWorkspace(cwd, {
      business_id: '',
      workspace_id: '',
      name: options.name,
      slug,
      owner_email: '',
      workspace_template: 'business',
    }, { here: true });
  }

  const bizMeta = readWorkspaceBusinessMeta(cwd);

  ensureWorkspaceStateFiles(cwd, {
    slug: bizMeta.slug || 'business',
    business_id: bizMeta.business_id || '',
    workspace_id: bizMeta.workspace_id || '',
    workspace_template: bizMeta.workspace_template || 'business',
  }, { dryRun: false });

  const contextDir = ensureContextScaffold(cwd, 'public');
  const stamp = new Date().toISOString().replace(/[:]/g, '-').slice(0, 16);
  const packDir = path.join(contextDir, '_ingest', `${stamp}-onboarding`);
  fs.mkdirSync(packDir, { recursive: true });

  const discovered = discoverOnboardingSignals(cwd, options);
  const stagedSources = stageOnboardingSources(cwd, packDir, discovered.sourcePaths);
  const links = Array.from(new Set([discovered.website, ...discovered.urls].filter(Boolean)));
  const starterAction = suggestStarterAction({
    website: discovered.website,
    contactName: options.contactName,
    contactEmail: options.contactEmail,
    sourceEntries: stagedSources,
  });
  const intakeLines = [
    `# ${bizMeta.name} Onboarding Intake`,
    '',
    `- Business: ${bizMeta.name}`,
    `- Slug: ${bizMeta.slug}`,
    discovered.website ? `- Website: ${discovered.website}` : null,
    options.contactName ? `- Contact: ${options.contactName}` : null,
    options.contactRole ? `- Contact role: ${options.contactRole}` : null,
    options.contactEmail ? `- Contact email: ${options.contactEmail}` : null,
    '',
    '## Notes',
    ...(options.notes.length > 0 ? options.notes.map((note) => `- ${note}`) : ['- No notes captured yet.']),
    '',
    '## Discovered Sources',
    ...(stagedSources.length > 0 ? stagedSources.map((entry) => `- ${entry.original} -> ${entry.staged}`) : ['- No local files discovered yet.']),
    '',
    '## Links',
    ...(links.length > 0 ? links.map((link) => `- ${link}`) : ['- No links captured yet.']),
  ].filter(Boolean);
  const intakePath = path.join(packDir, 'intake.md');
  fs.writeFileSync(intakePath, `${intakeLines.join('\n')}\n`, 'utf8');

  const linksPath = path.join(packDir, 'links.txt');
  fs.writeFileSync(linksPath, `${links.join('\n')}${links.length > 0 ? '\n' : ''}`, 'utf8');
  const sourcesPath = path.join(packDir, 'sources.txt');
  fs.writeFileSync(
    sourcesPath,
    `${stagedSources.map((entry) => `${entry.original} -> ${entry.staged}`).join('\n')}${stagedSources.length > 0 ? '\n' : ''}`,
    'utf8'
  );

  const intakeRel = path.relative(cwd, intakePath).replace(/\\/g, '/');
  const linksRel = path.relative(cwd, linksPath).replace(/\\/g, '/');
  const sourcesRel = path.relative(cwd, sourcesPath).replace(/\\/g, '/');
  const today = localDay();

  const briefSlug = `${bizMeta.slug}-starter-brief`;
  const briefPath = path.join(cwd, 'atris', 'wiki', 'briefs', `${briefSlug}.md`);
  writeMarkdownWithFrontmatter(briefPath, {
    type: 'brief',
    slug: briefSlug,
    title: `${bizMeta.name} Starter Brief`,
    sources: [intakeRel, linksRel, sourcesRel],
    last_compiled: today,
    created: today,
    updated: today,
    tags: ['business', 'onboarding', 'starter'],
  }, `
# ${bizMeta.name} Starter Brief

## What We Know

- Website: ${discovered.website || 'unknown'}
- Contact: ${options.contactName || 'unknown'}
- Contact role: ${options.contactRole || 'unknown'}
- Contact email: ${options.contactEmail || 'unknown'}
${options.notes.map((note) => `- Note: ${note}`).join('\n') || '- Notes: none captured yet'}
${stagedSources.length > 0 ? `- Local sources discovered: ${stagedSources.length}` : '- Local sources discovered: 0'}

## Unknowns

- Primary customer or audience
- Revenue model and buying motion
- Main operator inside the business
- Tool stack and source systems
- First measurable operating loop

## Next Moves

- Read the staged intake in \`${intakeRel}\`
- ${starterAction.action}
- Turn the first real interaction into a recap, then run \`atris business record ...\`
`);
  upsertIndexEntry(path.join(cwd, 'atris', 'wiki', 'index.md'), 'Briefs', path.relative(cwd, briefPath), 'Starter business brief from onboarding intake');

  let personRelativePath = null;
  if (options.contactName) {
    const personSlug = slugifyName(options.contactName);
    const personPath = path.join(cwd, 'atris', 'wiki', 'people', `${personSlug}.md`);
    writeMarkdownWithFrontmatter(personPath, {
      type: 'person',
      slug: personSlug,
      title: options.contactName,
      sources: [intakeRel, sourcesRel],
      last_compiled: today,
      created: today,
      updated: today,
      tags: ['person', 'contact', 'onboarding'],
    }, `
# ${options.contactName}

## Known

- Business: ${bizMeta.name}
- Role: ${options.contactRole || 'unknown'}
- Email: ${options.contactEmail || 'unknown'}

## Unknown

- Decision authority
- Preferred communication rhythm
- Main business pain

## Cross-References

- [[atris/wiki/briefs/${path.basename(briefPath)}]] - starter brief
`);
    personRelativePath = path.relative(cwd, personPath).replace(/\\/g, '/');
    upsertIndexEntry(path.join(cwd, 'atris', 'wiki', 'index.md'), 'People', personRelativePath, `Seed contact for ${bizMeta.name}`);
  }

  const conceptSlug = `${bizMeta.slug}-first-loop`;
  const conceptPath = path.join(cwd, 'atris', 'wiki', 'concepts', `${conceptSlug}.md`);
  writeMarkdownWithFrontmatter(conceptPath, {
    type: 'concept',
    slug: conceptSlug,
    title: `${bizMeta.name} First Loop`,
    sources: [intakeRel, linksRel, sourcesRel],
    last_compiled: today,
    created: today,
    updated: today,
    tags: ['concept', 'loop', 'onboarding'],
  }, `
# ${bizMeta.name} First Loop

## Candidate Loop

- Trigger: a new lead, meeting, client request, or operator handoff
- Action: summarize context, propose the next move, and draft one concrete output
- Reward: operator approval, reply, booked meeting, or visible pipeline progress

## Known Signals

${links.map((link) => `- ${link}`).join('\n') || '- No external links captured yet'}
${stagedSources.length > 0 ? `- Local evidence files: ${stagedSources.length}` : ''}

## Unknowns

- Best first workflow to automate
- Exact reward signal
- Required integrations
`);
  upsertIndexEntry(path.join(cwd, 'atris', 'wiki', 'index.md'), 'Concepts', path.relative(cwd, conceptPath), 'Seed first-loop hypothesis from onboarding intake');

  const cheatSheetPath = path.join(cwd, 'atris', 'reports', `${today}-${bizMeta.slug}-onboarding-cheat-sheet.md`);
  const onePagerPath = path.join(cwd, 'atris', 'reports', `${today}-${bizMeta.slug}-operator-one-pager.md`);
  const operatorSummary = [
    `# ${bizMeta.name} Onboarding Cheat Sheet`,
    '',
    '## What Exists',
    `- Starter brief: ${path.relative(cwd, briefPath).replace(/\\/g, '/')}`,
    personRelativePath ? `- Contact page: ${personRelativePath}` : null,
    `- First loop page: ${path.relative(cwd, conceptPath).replace(/\\/g, '/')}`,
    `- Raw intake: ${intakeRel}`,
    `- Source list: ${sourcesRel}`,
    stagedSources.length > 0 ? `- Staged sources: ${stagedSources.length}` : '- Staged sources: 0',
    '',
    '## Best Next Action',
    `- ${starterAction.title}`,
    `- Action: ${starterAction.action}`,
    `- Why: ${starterAction.why}`,
    '- Swarlo join: placeholder preserved for the next live join step.',
    '',
    '## Next 3 Moves',
    '- Open the starter brief and correct anything false.',
    `- ${starterAction.action}`,
    '- After the first real run, write a recap and record it with `atris business record ...`.',
    '- Before sharing the workspace, run `atris business share --write` and send the handoff.',
  ].filter(Boolean).join('\n') + '\n';
  fs.writeFileSync(cheatSheetPath, operatorSummary, 'utf8');
  fs.writeFileSync(onePagerPath, operatorSummary.replace('# ', '# One Pager: '), 'utf8');

  const todoPath = path.join(cwd, 'atris', 'TODO.md');
  if (fs.existsSync(todoPath)) {
    let todoContent = fs.readFileSync(todoPath, 'utf8');
    const taskLine = `- **Onboard:** ${starterAction.title}: ${starterAction.action} [execute]\n`;
    const backlogMatch = todoContent.match(/^## Backlog\s*$/m);
    if (backlogMatch) {
      const insertAt = backlogMatch.index + backlogMatch[0].length;
      todoContent = todoContent.slice(0, insertAt) + '\n' + taskLine + todoContent.slice(insertAt);
    } else {
      todoContent += '\n## Backlog\n\n' + taskLine;
    }
    fs.writeFileSync(todoPath, todoContent, 'utf8');
  }
  const taskSeed = seedBusinessStarterTask(cwd, todoPath, starterAction);

  writeWikiStatus(cwd, {
    health: `starter onboarding compiled from ${intakeRel}`,
    nextMove: `review ${path.relative(cwd, briefPath).replace(/\\/g, '/')} and tighten the first loop`,
  }, 'public', { lastIngest: `${today} ${new Date().toTimeString().slice(0, 5)}` });
  appendWikiLog(cwd, `starter onboarding compiled for ${bizMeta.slug}`, [
    `intake ${intakeRel}`,
    `sources ${sourcesRel}`,
    `brief ${path.relative(cwd, briefPath).replace(/\\/g, '/')}`,
    personRelativePath ? `person ${personRelativePath}` : null,
    `concept ${path.relative(cwd, conceptPath).replace(/\\/g, '/')}`,
    `cheat sheet ${path.relative(cwd, cheatSheetPath).replace(/\\/g, '/')}`,
    `one pager ${path.relative(cwd, onePagerPath).replace(/\\/g, '/')}`,
  ].filter(Boolean), 'public', 'ONBOARD');

  console.log('');
  console.log(`Onboarded ${bizMeta.name}.`);
  console.log(`  Intake:      ${intakeRel}`);
  console.log(`  Sources:     ${sourcesRel}`);
  console.log(`  Brief:       ${path.relative(cwd, briefPath).replace(/\\/g, '/')}`);
  if (personRelativePath) console.log(`  Contact:     ${personRelativePath}`);
  console.log(`  First loop:  ${path.relative(cwd, conceptPath).replace(/\\/g, '/')}`);
  console.log(`  Cheat sheet: ${path.relative(cwd, cheatSheetPath).replace(/\\/g, '/')}`);
  console.log(`  One pager:   ${path.relative(cwd, onePagerPath).replace(/\\/g, '/')}`);
  console.log(`  Next action: ${starterAction.title}`);
  if (taskSeed.ok) {
    console.log(`  Task plane:  ${taskSeed.inserted ? 'seeded starter task' : 'starter task already present'}`);
  } else {
    console.log(`  Task plane:  TODO fallback only (${taskSeed.error})`);
  }
  console.log('  Share:       atris business share --write');
  console.log('');
}

async function recordBusinessRun(reportArg, ...flags) {
  const options = parseRecordFlags([reportArg, ...flags], process.cwd());
  const cwd = options.cwd || process.cwd();
  const bizMeta = readWorkspaceBusinessMeta(cwd);
  const { absPath, relPath } = resolveWorkspaceReport(cwd, options.reportPath);

  ensureWorkspaceStateFiles(cwd, {
    slug: bizMeta.slug || 'business',
    business_id: bizMeta.business_id || '',
    workspace_id: bizMeta.workspace_id || '',
    workspace_template: bizMeta.workspace_template || 'business',
  }, { dryRun: false });

  const reportContent = fs.readFileSync(absPath, 'utf8');
  const title = extractReportTitle(reportContent, absPath);
  const outcome = normalizeOutcome(options.outcome);
  const reward = options.reward != null ? Number(options.reward) : defaultRewardForOutcome(outcome);
  if (!Number.isFinite(reward)) {
    throw new Error(`Invalid reward: ${options.reward}`);
  }

  const recordedAt = new Date().toISOString();
  const summary = options.summary || title;
  const metric = options.metric || null;
  const loop = options.loop || 'manual';
  const actor = options.actor || 'operator';
  const stateDir = path.join(cwd, '.atris', 'state');

  const shared = {
    recorded_at: recordedAt,
    business_slug: bizMeta.slug || null,
    business_name: bizMeta.name || null,
    business_id: bizMeta.business_id || null,
    workspace_id: bizMeta.workspace_id || null,
    workspace_template: bizMeta.workspace_template || 'business',
    report_path: relPath,
    report_title: title,
    summary,
    metric,
    outcome,
    reward,
    loop,
    actor,
  };

  appendJsonl(path.join(stateDir, 'events.jsonl'), {
    ...shared,
    type: 'report_recorded',
  });

  appendJsonl(path.join(stateDir, 'episodes.jsonl'), {
    ...shared,
    type: 'episode',
  });

  appendJsonl(path.join(stateDir, 'scorecards.jsonl'), {
    ...shared,
    type: 'scorecard',
  });

  console.log('');
  console.log(`Recorded recap for ${bizMeta.name || bizMeta.slug || 'workspace'}.`);
  console.log(`  Report:  ${relPath}`);
  console.log(`  Outcome: ${outcome}`);
  console.log(`  Reward:  ${reward}`);
  if (metric) console.log(`  Metric:  ${metric}`);
  console.log('  State:   .atris/state/events.jsonl, episodes.jsonl, scorecards.jsonl');
  console.log('');
}

function detectBusinessSlug(explicitSlug) {
  if (explicitSlug) return explicitSlug;
  const bizFile = path.join(process.cwd(), '.atris', 'business.json');
  if (!fs.existsSync(bizFile)) return null;
  try {
    const biz = JSON.parse(fs.readFileSync(bizFile, 'utf8'));
    return biz.slug || biz.name || null;
  } catch {
    return null;
  }
}

function relativeTime(dateStr) {
  if (!dateStr) return 'unknown';
  const diff = Date.now() - new Date(dateStr).getTime();
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  if (days <= 0) return 'today';
  if (days === 1) return '1d ago';
  return `${days}d ago`;
}

function activityBar(daysSinceActive, width = 10) {
  const filled = Math.max(0, Math.min(width, width - Math.floor(daysSinceActive / 3)));
  return '\u2501'.repeat(filled) + '\u2591'.repeat(width - filled);
}

function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function firstNumber(...values) {
  for (const value of values) {
    const parsed = typeof value === 'number'
      ? value
      : (typeof value === 'string' && value.trim() ? Number(value) : Number.NaN);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function firstBoolean(...values) {
  for (const value of values) {
    if (typeof value === 'boolean') return value;
    if (value === 1 || value === '1' || value === 'true') return true;
    if (value === 0 || value === '0' || value === 'false') return false;
  }
  return false;
}

function normalizeOrdersPayload(value) {
  const root = asRecord(value);
  const body = asRecord(root.data);
  const source = Object.keys(body).length > 0 ? body : root;
  const summary = asRecord(source.summary);
  const rawOrders = Array.isArray(value)
    ? value
    : (Array.isArray(source.orders) ? source.orders : (Array.isArray(root.orders) ? root.orders : []));
  const orders = rawOrders.map((rawOrder, index) => {
    const order = asRecord(rawOrder);
    const product = asRecord(order.product);
    const item = asRecord(order.item);
    const buyer = asRecord(order.buyer);
    const customer = asRecord(order.customer);
    const metadata = asRecord(order.metadata);
    const firstItem = Array.isArray(order.items) ? asRecord(order.items[0]) : {};
    const status = firstString(order.status, order.payment_status, order.order_type).toLowerCase();
    const createdAt = firstString(
      order.created_at,
      order.createdAt,
      order.order_date,
      order.date,
      order.paid_at,
    ) || null;

    return {
      id: firstString(order.id, order.order_id, order.reference) || `order-${index + 1}`,
      reference: firstString(order.order_ref, order.reference, order.order_number, order.id) || `order ${index + 1}`,
      product: firstString(
        order.product_name,
        order.product_title,
        typeof order.product === 'string' ? order.product : null,
        product.name,
        product.title,
        item.name,
        firstItem.name,
        firstItem.product_name,
        metadata.product_name,
      ) || 'product',
      quantity: Math.max(1, Math.round(firstNumber(order.quantity, order.qty, firstItem.quantity, 1))),
      buyer: firstString(
        order.buyer_name,
        order.customer_name,
        buyer.name,
        customer.name,
        order.buyer_email,
        order.customer_email,
        buyer.email,
        customer.email,
      ) || 'guest',
      status: status || 'unknown',
      isPreorder: firstBoolean(order.is_preorder, order.preorder)
        || status.replace(/[_-]/g, '').includes('preorder')
        || status === 'pending',
      amountCents: firstNumber(order.amount_cents, order.price_cents, order.total_cents, firstItem.amount_cents),
      createdAt,
    };
  });

  orders.sort((a, b) => {
    const aTime = a.createdAt ? Date.parse(a.createdAt) : 0;
    const bTime = b.createdAt ? Date.parse(b.createdAt) : 0;
    return (Number.isFinite(bTime) ? bTime : 0) - (Number.isFinite(aTime) ? aTime : 0);
  });

  return {
    orders,
    revenueCents: firstNumber(summary.revenue_cents, source.revenue_cents, root.revenue_cents),
    paidOrders: Math.max(0, Math.round(firstNumber(summary.paid_orders, source.paid_orders, root.paid_orders))),
    pendingRevenueCents: firstNumber(
      summary.pending_revenue_cents,
      source.pending_revenue_cents,
      root.pending_revenue_cents,
    ),
  };
}

function readStorefront(business) {
  const config = asRecord(asRecord(business).config);
  const storefront = asRecord(config.storefront);
  return {
    enabled: storefront.enabled === true,
    products: Array.isArray(storefront.products) ? storefront.products.filter(product => product && typeof product === 'object') : [],
  };
}

function readWalletNet(business) {
  const config = asRecord(asRecord(business).config);
  for (const key of ['wallet_balance', 'credits_balance', 'credits', 'wallet_credits']) {
    const value = config[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return null;
}

function formatWalletNet(value) {
  if (value === null) return 'not available';
  return `$${value.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
}

function formatCents(value, currency = 'usd') {
  const amount = firstNumber(value) / 100;
  const code = firstString(currency).toUpperCase() || 'USD';
  const formatted = amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return code === 'USD' ? `$${formatted}` : `${code} ${formatted}`;
}

function renderOrderLine(order) {
  const kind = order.isPreorder ? ', preorder' : '';
  const when = order.createdAt ? relativeTime(order.createdAt) : 'date unavailable';
  return `  ${order.reference}: ${order.product} x${order.quantity}, ${order.buyer}, ${when}${kind}`;
}

function parseBusinessStoreArgs(args = []) {
  const actions = new Set(['status', 'on', 'enable', 'toggle', 'off', 'disable']);
  if (actions.has(args[0])) return { action: args[0], slug: args[1] };
  if (actions.has(args[1])) return { action: args[1], slug: args[0] };
  return { action: 'status', slug: args[0] };
}

function parseBusinessDoctorOptions(args = []) {
  const options = {
    fix: args.includes('--fix'),
    json: args.includes('--json'),
    root: businessWorkspaceBase(),
  };
  const rootIdx = args.indexOf('--root');
  if (rootIdx !== -1 && args[rootIdx + 1]) {
    options.root = path.resolve(args[rootIdx + 1]);
  }
  return options;
}

function describeAccess(member) {
  const role = (member.role || '').toLowerCase();
  if (role === 'owner') return 'full control';
  if (role === 'admin') return 'admin access';
  if (role === 'member') return 'standard access';
  if (role === 'agent') return 'agent';
  return role || 'unknown';
}

function walkDir(dir) {
  let results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results = results.concat(walkDir(full));
    } else {
      results.push(full);
    }
  }
  return results;
}

function findAtrisDir() {
  let dir = process.cwd();
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, 'atris'))) return path.join(dir, 'atris');
    dir = path.dirname(dir);
  }
  return null;
}

module.exports = {
  BUSINESS_SHIP_USAGE,
  businessWorkspaceBase,
  slugify,
  isHelpToken,
  isAccidentalHelpBusiness,
  validateBusinessCreateName,
  parseBusinessShipArgs,
  shipTeamNames,
  shipTaskTitle,
  loadBusinesses,
  businessMatchesSlug,
  saveBusinesses,
  readBusinessFolderBindings,
  analyzeBusinessDoctor,
  parseCreateBusinessFlags,
  resolveWorkspaceRoot,
  createCanonicalBusinessWorkspace,
  normalizeOutcome,
  defaultRewardForOutcome,
  appendJsonl,
  readJsonFile,
  readJsonlRows,
  countFiles,
  rel,
  collectBusinessShareState,
  renderBusinessCreatedNextSteps,
  startBusinessWorkspace,
  localDay,
  shareBusinessWorkspace,
  onboardBusiness,
  recordBusinessRun,
  detectBusinessSlug,
  relativeTime,
  activityBar,
  asRecord,
  firstString,
  firstNumber,
  normalizeOrdersPayload,
  readStorefront,
  readWalletNet,
  formatWalletNet,
  formatCents,
  renderOrderLine,
  parseBusinessStoreArgs,
  parseBusinessDoctorOptions,
  describeAccess,
  walkDir,
  findAtrisDir,
};
