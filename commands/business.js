const fs = require('fs');
const path = require('path');
const os = require('os');
const { loadCredentials } = require('../utils/auth');
const { apiRequestJson } = require('../utils/api');
const { syncBusinessCanonical, ensureWorkspaceStateFiles, ensureBusinessRootAgentAdapters } = require('./sync');
const { ensureContextScaffold, writeWikiStatus, appendWikiLog } = require('../lib/wiki');
const { writeRuntimeReceipt } = require('../lib/runtime-bootstrap');

function getBusinessConfigPath() {
  const home = require('os').homedir();
  const dir = path.join(home, '.atris');
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

function readBusinessFolderBindings(rootDir = path.join(os.homedir(), 'arena', 'atris-business')) {
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

  return {
    issues,
    cacheUpdates,
    stats: {
      cache_entries: Object.keys(cache || {}).length,
      cloud_active: cloudBusinesses.length,
      folders: folderBindings.length,
      fixable_cache_entries: Object.keys(cacheUpdates).length,
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
  return path.join(os.homedir(), 'arena', 'atris-business', slug);
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
  const title = `${starterAction.title} — ${starterAction.action}`;
  try {
    const taskDb = require('../lib/task-db');
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

function defaultSharePath(cwd, role) {
  const stamp = new Date().toISOString().slice(0, 10);
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

function slugifyName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'item';
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
  const today = new Date().toISOString().slice(0, 10);

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
  fs.writeFileSync(onePagerPath, operatorSummary.replace('# ', '# One Pager — '), 'utf8');

  const todoPath = path.join(cwd, 'atris', 'TODO.md');
  if (fs.existsSync(todoPath)) {
    let todoContent = fs.readFileSync(todoPath, 'utf8');
    const taskLine = `- **Onboard:** ${starterAction.title} — ${starterAction.action} [execute]\n`;
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

async function findExistingBusinessBySlug(slug, token) {
  if (!slug) return null;

  // Local cache first — no network round-trip needed.
  const local = loadBusinesses();
  if (local[slug]) {
    return { id: local[slug].business_id, name: local[slug].name, slug, source: 'local' };
  }
  for (const v of Object.values(local)) {
    if (businessMatchesSlug(v, slug)) {
      return { id: v.business_id, name: v.name, slug, source: 'local' };
    }
  }

  if (!token) return null;

  // Cloud lookup — covers businesses the user is a member of but hasn't added.
  const direct = await apiRequestJson(`/business/by-slug/${encodeURIComponent(slug)}`, {
    method: 'GET',
    token,
  });
  if (direct.ok && direct.data && direct.data.id) {
    return { id: direct.data.id, name: direct.data.name, slug: direct.data.slug || slug, source: 'cloud' };
  }

  const list = await apiRequestJson('/business/', { method: 'GET', token });
  if (list.ok && Array.isArray(list.data)) {
    const match = list.data.find(b => businessMatchesSlug(b, slug));
    if (match) return { id: match.id, name: match.name, slug: match.slug, source: 'cloud' };
  }

  return null;
}

async function addBusiness(slug) {
  if (!slug || isHelpToken(slug)) {
    console.error('Usage: atris business add <slug>');
    process.exit(1);
  }
  if (!slug) {
    console.error('Usage: atris business add <slug>');
    process.exit(1);
  }

  const creds = loadCredentials();
  if (!creds || !creds.token) {
    console.error('Not logged in. Run: atris login');
    process.exit(1);
  }

  // Resolve slug to business
  const result = await apiRequestJson(`/business/by-slug/${slug}`, {
    method: 'GET',
    token: creds.token,
  });

  if (!result.ok) {
    // Try listing all and matching
    const listResult = await apiRequestJson('/business/', { method: 'GET', token: creds.token });
    if (listResult.ok && Array.isArray(listResult.data)) {
      const match = listResult.data.find(b => businessMatchesSlug(b, slug, { includeName: true }));
      if (match) {
        const businesses = loadBusinesses();
        businesses[slug] = {
          business_id: match.id,
          workspace_id: match.workspace_id,
          name: match.name,
          slug: match.slug,
          added_at: new Date().toISOString(),
        };
        saveBusinesses(businesses);
        console.log(`\nAdded "${match.name}" (${match.slug})`);
        return;
      }
    }
    console.error(`Business "${slug}" not found.`);
    process.exit(1);
  }

  const biz = result.data;
  const businesses = loadBusinesses();
  businesses[slug] = {
    business_id: biz.id,
    workspace_id: biz.workspace_id,
    name: biz.name,
    slug: biz.slug,
    added_at: new Date().toISOString(),
  };
  saveBusinesses(businesses);
  console.log(`\nAdded "${biz.name}" (${biz.slug})`);
}

async function listBusinesses(opts = {}) {
  // --local mode: walk ~/arena/atris-business/ and show fleet status table
  // (no API calls, rate-limit safe). Different from API-mode below which lists
  // businesses cached from the API.
  if (opts.local) {
    return listBusinessesLocal(opts);
  }

  const businesses = loadBusinesses();
  const slugs = Object.keys(businesses);

  if (slugs.length === 0) {
    console.log('\nNo businesses connected. Run: atris business add <slug>');
    return;
  }

  console.log('\nConnected businesses:\n');
  for (const slug of slugs) {
    const b = businesses[slug];
    console.log(`  ${b.name || slug} (${b.slug || slug})`);
    console.log(`    ID: ${b.business_id}`);
    console.log(`    Added: ${b.added_at || 'unknown'}`);
    console.log('');
  }
}

/**
 * Walk ~/arena/atris-business/ and print a fleet status table for every
 * customer workspace. Pure local — no API calls, no rate-limit risk.
 *
 * Classifies each dir as: ready, flat, unbound, nested, bare, or superseded.
 *
 * Discovered the need for this during overnight loop tick #3 when we hand-wrote
 * /tmp/customer_fleet.md. Now any team member can run `atris business list --local`
 * (or `atris business fleet`) to see fleet state in one shot.
 */
function listBusinessesLocal(opts = {}) {
  const os = require('os');
  const SKIP_DIRS = new Set(['deals', 'archive', 'archives', '_archive', 'templates', 'node_modules', '.git']);
  const SKIP_FILES = new Set(['.DS_Store', 'Thumbs.db']);

  const rootDir = opts.root || path.join(os.homedir(), 'arena', 'atris-business');
  const jsonMode = opts.json === true;

  if (!fs.existsSync(rootDir)) {
    console.error(`Fleet root not found: ${rootDir}`);
    process.exit(1);
  }

  function countFiles(dir) {
    let total = 0;
    let md = 0;
    function walk(d) {
      let entries;
      try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (e.name.startsWith('.git')) continue;
        if (e.name === 'node_modules') continue;
        const full = path.join(d, e.name);
        if (e.isDirectory()) {
          walk(full);
        } else if (e.isFile()) {
          if (SKIP_FILES.has(e.name)) continue;
          total++;
          if (e.name.endsWith('.md')) md++;
        }
      }
    }
    walk(dir);
    return { total, md };
  }

  function classifyCustomer(name) {
    const customerDir = path.join(rootDir, name);
    const businessJson = path.join(customerDir, '.atris', 'business.json');
    const atrisDir = path.join(customerDir, 'atris');
    const nestedDir = path.join(customerDir, name);

    const hasBizJson = fs.existsSync(businessJson);
    const hasAtris = fs.existsSync(atrisDir) && fs.statSync(atrisDir).isDirectory();
    const hasNested = fs.existsSync(nestedDir) && fs.statSync(nestedDir).isDirectory();
    const { total, md } = countFiles(customerDir);

    let state, action, icon;
    if (hasBizJson && hasAtris) {
      state = 'ready'; action = 'none'; icon = '🟢';
    } else if (hasBizJson && !hasAtris) {
      state = 'flat'; action = 'migrate to atris/ wrapper'; icon = '🟡';
    } else if (!hasBizJson && hasAtris) {
      state = 'unbound'; action = 'create .atris/business.json'; icon = '🟡';
    } else if (hasNested) {
      state = 'nested'; action = 'legacy nesting bug'; icon = '🔴';
    } else if (total < 5) {
      state = 'bare'; action = 'not yet onboarded'; icon = '⚪';
    } else {
      state = 'flat-unbound'; action = 'needs business init'; icon = '🟡';
    }

    let bizName = name;
    if (hasBizJson) {
      try {
        const meta = JSON.parse(fs.readFileSync(businessJson, 'utf8'));
        bizName = meta.name || name;
      } catch {}
    }

    return { name, bizName, state, icon, files: total, md, hasBizJson, hasAtris, hasNested, action };
  }

  const entries = fs.readdirSync(rootDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .filter((e) => !e.name.startsWith('.'))
    .filter((e) => !SKIP_DIRS.has(e.name))
    .map((e) => e.name)
    .sort();

  const customers = entries.map(classifyCustomer);

  // Mark superseded: any customer with a -canonical sibling is superseded
  const canonicalNames = new Set(
    customers.filter((c) => c.name.endsWith('-canonical')).map((c) => c.name.replace(/-canonical$/, ''))
  );
  for (const c of customers) {
    if (canonicalNames.has(c.name)) {
      c.state = 'superseded';
      c.icon = '🔴';
      c.action = `superseded by ${c.name}-canonical`;
    }
  }

  if (jsonMode) {
    console.log(JSON.stringify({ root: rootDir, customers }, null, 2));
    return;
  }

  console.log('');
  console.log(`Atris Fleet — ${rootDir}`);
  console.log('═'.repeat(86));
  console.log('  CUSTOMER              STATE         FILES   BIZ.JSON  ATRIS/  ACTION');
  console.log('  ' + '─'.repeat(83));

  const order = ['ready', 'flat', 'unbound', 'flat-unbound', 'bare', 'nested', 'superseded'];
  const grouped = {};
  for (const c of customers) {
    if (!grouped[c.state]) grouped[c.state] = [];
    grouped[c.state].push(c);
  }

  for (const state of order) {
    if (!grouped[state]) continue;
    for (const c of grouped[state]) {
      const name = c.name.padEnd(20).slice(0, 20);
      const stateLabel = (c.icon + ' ' + state).padEnd(13).slice(0, 13);
      const filesStr = String(c.files).padStart(5);
      const bizStr = c.hasBizJson ? '   ✓    ' : '   ✗    ';
      const atrisStr = c.hasAtris ? '  ✓   ' : '  ✗   ';
      const action = c.action.length > 28 ? c.action.slice(0, 25) + '...' : c.action;
      console.log(`  ${name}  ${stateLabel} ${filesStr}    ${bizStr}  ${atrisStr}  ${action}`);
    }
  }

  console.log('  ' + '─'.repeat(83));

  const counts = {};
  for (const c of customers) counts[c.state] = (counts[c.state] || 0) + 1;
  const summary = order.filter((s) => counts[s]).map((s) => `${counts[s]} ${s}`).join(', ');
  console.log(`  ${customers.length} customers — ${summary}`);
  console.log('');

  const needsWork = customers.filter((c) => ['flat', 'unbound', 'flat-unbound', 'nested'].includes(c.state));
  if (needsWork.length > 0) {
    console.log('  Next actions:');
    needsWork.slice(0, 5).forEach((c) => {
      console.log(`    ${c.icon} ${c.name}: ${c.action}`);
    });
    console.log('');
  }
}

async function removeBusiness(slug) {
  if (!slug || isHelpToken(slug)) {
    console.error('Usage: atris business remove <slug>');
    process.exit(1);
  }

  const businesses = loadBusinesses();
  if (!businesses[slug]) {
    console.error(`Business "${slug}" not connected.`);
    process.exit(1);
  }

  const name = businesses[slug].name || slug;
  delete businesses[slug];
  saveBusinesses(businesses);
  console.log(`\nRemoved "${name}"`);
}

// ---------------------------------------------------------------------------
// Resolve a slug to a business ID using local cache or API lookup
// ---------------------------------------------------------------------------
async function resolveSlug(slug, creds) {
  // Check local cache first
  const businesses = loadBusinesses();
  if (businesses[slug]) {
    return businesses[slug];
  }

  // Try by-slug endpoint
  const result = await apiRequestJson(`/business/by-slug/${slug}/`, {
    method: 'GET',
    token: creds.token,
  });
  if (result.ok && result.data) {
    return { business_id: result.data.id, workspace_id: result.data.workspace_id, name: result.data.name, slug: result.data.slug };
  }

  // Fallback: list all and match
  const listResult = await apiRequestJson('/business/', { method: 'GET', token: creds.token });
  if (listResult.ok && Array.isArray(listResult.data)) {
    const match = listResult.data.find(b => businessMatchesSlug(b, slug, { includeName: true }));
    if (match) {
      return { business_id: match.id, workspace_id: match.workspace_id, name: match.name, slug: match.slug };
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Helper: format relative time
// ---------------------------------------------------------------------------
function relativeTime(dateStr) {
  if (!dateStr) return 'unknown';
  const diff = Date.now() - new Date(dateStr).getTime();
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  if (days <= 0) return 'today';
  if (days === 1) return '1d ago';
  return `${days}d ago`;
}

// ---------------------------------------------------------------------------
// Helper: activity bar
// ---------------------------------------------------------------------------
function activityBar(daysSinceActive, width = 10) {
  const filled = Math.max(0, Math.min(width, width - Math.floor(daysSinceActive / 3)));
  return '\u2501'.repeat(filled) + '\u2591'.repeat(width - filled);
}

// ---------------------------------------------------------------------------
// atris business health <slug>
// ---------------------------------------------------------------------------
async function businessHealth(slug) {
  if (!slug) {
    console.error('Usage: atris business health <slug>');
    process.exit(1);
  }

  const creds = loadCredentials();
  if (!creds || !creds.token) {
    console.error('Not logged in. Run: atris login');
    process.exit(1);
  }

  const biz = await resolveSlug(slug, creds);
  if (!biz) {
    console.error(`Business "${slug}" not found.`);
    process.exit(1);
  }

  const bizId = biz.business_id;
  const wsId = biz.workspace_id;

  // Fetch dashboard and workspace snapshot in parallel
  const fetchOpts = { method: 'GET', token: creds.token, timeoutMs: 120000 };
  const [dashResult, wsResult] = await Promise.all([
    apiRequestJson(`/business/${bizId}/dashboard/`, fetchOpts),
    wsId
      ? apiRequestJson(`/business/${bizId}/workspaces/${wsId}/snapshot?include_content=false`, fetchOpts)
      : Promise.resolve({ ok: false }),
  ]);

  const dashboard = dashResult.ok ? dashResult.data : null;
  const workspace = wsResult.ok ? wsResult.data : null;

  const name = dashboard?.business?.name || biz.name || slug;

  console.log('');
  console.log(`Business Health: ${name}`);
  console.log('\u2501'.repeat(26 + name.length));
  console.log('');

  // Workspace stats
  const files = workspace?.files || [];
  const totalSize = files.reduce((sum, f) => sum + (f.size || 0), 0);
  const fileSizeStr = totalSize > 1024 ? `${Math.round(totalSize / 1024)}KB` : `${totalSize}B`;
  console.log(`  Workspace:  ${files.length} files, ${fileSizeStr}`);

  // Members
  const members = dashboard?.roster?.members || dashboard?.members || dashboard?.business?.members || [];
  const humanMembers = members.filter(m => !m.is_agent && m.role !== 'agent');
  const agentMembers = members.filter(m => m.is_agent || m.role === 'agent');
  const memberCountStr = members.length > 0
    ? `${members.length} (${humanMembers.length} human, ${agentMembers.length} agent)`
    : `${members.length}`;
  console.log(`  Members:    ${memberCountStr}`);

  // Apps
  const apps = dashboard?.business?.apps || dashboard?.apps || [];
  console.log(`  Apps:       ${Array.isArray(apps) ? apps.length : 0}`);

  // Status
  const status = dashboard?.business?.status || dashboard?.status || 'unknown';
  console.log(`  Status:     ${status}`);

  // Member activity
  if (members.length > 0) {
    console.log('');
    console.log('  Member Activity:');
    for (const m of members) {
      const memberName = m.display_name || m.name || m.email || 'Unknown';
      const role = m.role || 'member';
      const lastActive = m.atris?.last_active || m.last_active || m.last_login || m.joined_at || m.created_at;
      const daysSince = lastActive ? Math.floor((Date.now() - new Date(lastActive).getTime()) / (1000 * 60 * 60 * 24)) : 999;
      const bar = activityBar(daysSince);
      const label = daysSince <= 1 ? 'active' : `last active ${relativeTime(lastActive)}`;
      console.log(`    ${memberName.padEnd(18)} ${role.padEnd(8)} ${bar} ${label}`);
    }
  }

  // Workspace breakdown by directory
  if (files.length > 0) {
    console.log('');
    console.log('  Workspace Breakdown:');
    const dirSizes = {};
    for (const f of files) {
      const filePath = f.path || f.name || '';
      const dir = filePath.includes('/') ? filePath.split('/')[0] + '/' : '/';
      dirSizes[dir] = (dirSizes[dir] || 0) + (f.size || 0);
    }
    const maxDirSize = Math.max(...Object.values(dirSizes), 1);
    const sortedDirs = Object.entries(dirSizes).sort((a, b) => b[1] - a[1]);
    for (const [dir, size] of sortedDirs) {
      const sizeStr = size > 1024 ? `${Math.round(size / 1024)}KB` : `${size}B`;
      const barLen = Math.max(1, Math.round((size / maxDirSize) * 10));
      console.log(`    ${dir.padEnd(12)} ${sizeStr.padStart(5)}   ${'█'.repeat(barLen)}`);
    }
  }

  // Issues
  console.log('');
  console.log('  Issues:');
  let hasIssues = false;
  const humanMembers2 = members.filter(m => m.role !== 'agent');
  for (const m of humanMembers2) {
    const lastActive = m.atris?.last_active || m.last_active || m.last_login || m.joined_at || m.created_at;
    const daysSince = lastActive ? Math.floor((Date.now() - new Date(lastActive).getTime()) / (1000 * 60 * 60 * 24)) : 999;
    if (daysSince >= 30) {
      const memberName = m.display_name || m.name || m.email || 'Unknown';
      console.log(`    \u26A0 ${memberName} inactive for ${daysSince}+ days`);
      hasIssues = true;
    }
  }

  // Check for workspace bloat (arbitrary threshold: >500KB or >100 files)
  if (totalSize > 500 * 1024) {
    console.log(`    \u26A0 Workspace large (${fileSizeStr})`);
    hasIssues = true;
  }
  if (files.length > 100) {
    console.log(`    \u26A0 Workspace has ${files.length} files (consider cleanup)`);
    hasIssues = true;
  }
  if (!hasIssues) {
    console.log('    \u2713 Workspace clean (no bloat detected)');
  }

  console.log('');
}

// ---------------------------------------------------------------------------
// atris business audit
// ---------------------------------------------------------------------------
async function businessAudit() {
  const creds = loadCredentials();
  if (!creds || !creds.token) {
    console.error('Not logged in. Run: atris login');
    process.exit(1);
  }

  const listResult = await apiRequestJson('/business/', { method: 'GET', token: creds.token });
  if (!listResult.ok || !Array.isArray(listResult.data)) {
    console.error(`Failed to fetch businesses: ${listResult.error || 'unknown error'}`);
    process.exit(1);
  }

  const businesses = listResult.data;

  console.log('');
  console.log('Business Audit');
  console.log('\u2501'.repeat(14));
  console.log('');

  for (const biz of businesses) {
    const name = biz.name || biz.slug || 'Unknown';
    const memberCount = typeof biz.member_count === 'number' ? biz.member_count : (Array.isArray(biz.members) ? biz.members.length : 0);
    const appCount = typeof biz.app_count === 'number' ? biz.app_count : (Array.isArray(biz.apps) ? biz.apps.length : 0);

    // Determine activity status
    const status = biz.status || 'unknown';
    const isActive = status === 'active' || (memberCount > 1 && appCount > 0);
    const hasContent = memberCount > 1 || appCount > 0;

    let icon, activityLabel;
    if (isActive) {
      icon = '\u2713';
      activityLabel = appCount > 0 ? 'active' : 'idle';
    } else if (hasContent) {
      icon = '\u26A0';
      activityLabel = 'inactive';
    } else {
      icon = '\u25CB';
      activityLabel = 'inactive';
    }

    const memberStr = memberCount === 1 ? '1 member' : `${memberCount} members`;
    const appStr = appCount === 1 ? '1 app' : `${appCount} apps`;

    console.log(`  ${icon} ${name.padEnd(16)} ${memberStr.padEnd(12)} ${appStr.padEnd(8)} ${activityLabel}`);
  }

  console.log('');
}

function parseBusinessDoctorOptions(args = []) {
  const options = {
    fix: args.includes('--fix'),
    json: args.includes('--json'),
    root: path.join(os.homedir(), 'arena', 'atris-business'),
  };
  const rootIdx = args.indexOf('--root');
  if (rootIdx !== -1 && args[rootIdx + 1]) {
    options.root = path.resolve(args[rootIdx + 1]);
  }
  return options;
}

function printBusinessDoctorHelp() {
  console.log('Usage: atris business doctor [--fix] [--root <dir>] [--json]');
  console.log('');
  console.log('Checks cloud-active businesses against:');
  console.log('  - ~/.atris/businesses.json');
  console.log('  - ~/arena/atris-business/*/.atris/business.json');
  console.log('  - canonical slug + alias bindings');
  console.log('');
  console.log('--fix rewrites only safe local cache entries. It does not rename folders or touch cloud data.');
}

async function businessDoctor(...args) {
  if (args.some(isHelpToken)) {
    printBusinessDoctorHelp();
    return;
  }

  const options = parseBusinessDoctorOptions(args);
  const creds = loadCredentials();
  if (!creds || !creds.token) {
    console.error('Not logged in. Run: atris login');
    process.exit(1);
  }

  const listResult = await apiRequestJson('/business/', { method: 'GET', token: creds.token });
  if (!listResult.ok || !Array.isArray(listResult.data)) {
    console.error(`Failed to fetch businesses: ${listResult.errorMessage || listResult.error || listResult.status || 'unknown error'}`);
    process.exit(1);
  }

  let cache = loadBusinesses();
  const folderBindings = readBusinessFolderBindings(options.root);
  let analysis = analyzeBusinessDoctor({
    cache,
    cloudBusinesses: listResult.data,
    folderBindings,
  });

  const cacheUpdateKeys = Object.keys(analysis.cacheUpdates);
  let fixed = [];
  if (options.fix && cacheUpdateKeys.length > 0) {
    cache = { ...cache, ...analysis.cacheUpdates };
    saveBusinesses(cache);
    fixed = cacheUpdateKeys;
    analysis = analyzeBusinessDoctor({
      cache,
      cloudBusinesses: listResult.data,
      folderBindings,
    });
  }

  if (options.json) {
    console.log(JSON.stringify({
      root: options.root,
      stats: analysis.stats,
      fixed,
      issues: analysis.issues,
    }, null, 2));
  } else {
    console.log('');
    console.log('Business Doctor');
    console.log('---------------');
    console.log(`cloud active: ${analysis.stats.cloud_active}`);
    console.log(`cache entries: ${analysis.stats.cache_entries}`);
    console.log(`folders scanned: ${analysis.stats.folders}`);
    if (fixed.length > 0) console.log(`fixed cache entries: ${fixed.join(', ')}`);
    console.log('');

    if (analysis.issues.length === 0) {
      console.log('OK no business binding drift found.');
    } else {
      for (const issue of analysis.issues) {
        const label = issue.level === 'fail' ? 'FAIL' : 'WARN';
        const fixHint = issue.fixable ? ' (run with --fix)' : '';
        console.log(`${label} ${issue.code}: ${issue.message}${fixHint}`);
      }
    }
    console.log('');
  }

  const failures = analysis.issues.filter((issue) => issue.level === 'fail');
  if (failures.length > 0) process.exitCode = 1;
}

async function createBusinessInternal(name, flags = [], mode = 'auto') {
  if (!name || isHelpToken(name) || String(name).startsWith('-')) {
    console.error('Usage: atris business create <name> [--description "..."] [--workspace] [--here|--root <dir>]');
    if (name && String(name).startsWith('-') && !isHelpToken(name)) {
      console.error(`\n  Refusing to create a business named "${name}" — looks like a flag, not a name.`);
    }
    process.exit(1);
  }

  const creds = loadCredentials();
  if (!creds || !creds.token) {
    console.error('Not logged in. Run: atris login');
    process.exit(1);
  }

  const options = parseCreateBusinessFlags(flags);
  const description = options.description;
  const force = flags.includes('--force') || flags.includes('--allow-duplicate');

  // Pre-flight: refuse to create a duplicate by slug. The backend will silently
  // suffix `-1`, `-2`, etc., which produces ghost businesses when users actually
  // wanted to attach to an existing one. Guide them to `atris pull` instead.
  if (!force) {
    const desiredSlug = slugify(name);
    if (desiredSlug) {
      const existing = await findExistingBusinessBySlug(desiredSlug, creds.token);
      if (existing) {
        console.error(`\nA business with slug "${desiredSlug}" already exists.`);
        console.error(`  Name: ${existing.name || desiredSlug}`);
        if (existing.id) console.error(`  ID:   ${existing.id}`);
        console.error('');
        console.error('To set up a local workspace for it, run:');
        console.error(`  atris pull ${desiredSlug}                       # into ./${desiredSlug}`);
        console.error(`  atris pull ${desiredSlug} --into <path>         # into a custom path`);
        console.error('');
        console.error(`To create a NEW business anyway (will be slugged "${desiredSlug}-1"), pass --force.`);
        process.exit(1);
      }
    }
  }

  console.log(`Creating business: ${name}...`);

  const result = await apiRequestJson('/business/', {
    method: 'POST',
    token: creds.token,
    body: { name, description: description || undefined },
  });

  if (!result.ok) {
    console.error(`Failed: ${result.errorMessage || result.error || result.status}`);
    process.exit(1);
  }

  const biz = result.data;

  // Register locally
  const businesses = loadBusinesses();
  businesses[biz.slug] = {
    business_id: biz.id,
    workspace_id: biz.workspace_id,
    name: biz.name,
    slug: biz.slug,
    agent_id: biz.agent_id,
    added_at: new Date().toISOString(),
  };
  saveBusinesses(businesses);

  const shouldCreateCanonicalWorkspace = !options.noLocal && (
    mode === 'canonical' ||
    options.workspace ||
    options.here ||
    Boolean(options.root)
  );

  // Scaffold legacy local directory if in an atris project
  const atrisDir = !shouldCreateCanonicalWorkspace ? findAtrisDir() : null;
  if (atrisDir) {
    const bizDir = path.join(atrisDir, 'business', biz.slug);
    if (!fs.existsSync(bizDir)) {
      fs.mkdirSync(path.join(bizDir, 'context'), { recursive: true });
      fs.mkdirSync(path.join(bizDir, 'team'), { recursive: true });
      fs.mkdirSync(path.join(bizDir, 'workspace'), { recursive: true });
      fs.writeFileSync(path.join(bizDir, 'BUSINESS.md'), [
        `# ${biz.name}`,
        description ? `\n> ${description}\n` : '',
        '\n## The Business\n\n[What problem does this solve?]\n',
        '## Revenue Model\n\n[How does this make money?]\n',
        `---\n*Created: ${new Date().toISOString().split('T')[0]}*\n`,
      ].join(''));
      console.log(`  Local scaffold: ${bizDir}/`);
    }
  } else if (shouldCreateCanonicalWorkspace) {
    const workspaceRoot = resolveWorkspaceRoot(biz.slug, options);
    const scaffold = createCanonicalBusinessWorkspace(workspaceRoot, {
      business_id: biz.id,
      workspace_id: biz.workspace_id,
      name: biz.name,
      slug: biz.slug,
      owner_email: options.ownerEmail,
    }, { here: options.here });
    console.log(`  Local workspace: ${scaffold.targetRoot}/`);
  } else if (!options.noLocal) {
    console.log('  Tip: run `atris business init "<name>"` or add `--workspace` for a local business environment.');
  }

  const template = options.template;

  if (template) {
    const templates = {
      'saas': { agents: ['growth-hacker', 'product-analyst', 'support-agent'], desc: 'SaaS Startup' },
      'agency': { agents: ['project-manager', 'researcher', 'outreach-agent'], desc: 'Agency / Consulting' },
      'ecommerce': { agents: ['inventory-analyst', 'marketing-agent', 'support-agent'], desc: 'E-Commerce' },
      'content': { agents: ['writer', 'researcher', 'social-media-agent'], desc: 'Content Creator' },
      'restaurant': { agents: ['review-responder', 'social-media-agent', 'booking-agent'], desc: 'Restaurant / Local' },
    };
    const tpl = templates[template.toLowerCase()];
    if (tpl) {
      console.log(`  Template: ${tpl.desc} (${tpl.agents.length} agents)`);
      for (const agentName of tpl.agents) {
        console.log(`    + ${agentName}`);
      }
    } else {
      console.log(`  Unknown template: ${template}`);
      console.log(`  Available: ${Object.keys(templates).join(', ')}`);
    }
  }

  console.log(`\n  Business created!`);
  console.log(`  ID:        ${biz.id}`);
  console.log(`  Slug:      ${biz.slug}`);
  console.log(`  Agent:     ${biz.agent_id || '(none)'}`);
  console.log(`  Dashboard: https://atris.ai/dashboard/gm/${biz.id}`);
  if (shouldCreateCanonicalWorkspace) {
    const workspaceRoot = resolveWorkspaceRoot(biz.slug, options);
    console.log(renderBusinessCreatedNextSteps(biz, workspaceRoot));
  }
  console.log('');
}

async function createBusiness(name, ...flags) {
  return createBusinessInternal(name, flags, 'auto');
}

async function initBusinessWorkspace(name, ...flags) {
  return createBusinessInternal(name, flags, 'canonical');
}


async function businessStatus(slug) {
  const creds = loadCredentials();
  if (!creds || !creds.token) {
    console.error('Not logged in. Run: atris login');
    process.exit(1);
  }

  const resolved = await resolveSlug(slug, creds);
  if (!resolved) {
    console.error('No business specified. Usage: atris business status <slug>');
    process.exit(1);
  }

  const result = await apiRequestJson(`/business/${resolved.business_id}`, {
    method: 'GET',
    token: creds.token,
  });

  if (!result.ok) {
    console.error(`Failed to fetch business: ${result.errorMessage || result.status}`);
    return;
  }

  const biz = result.data;
  const agents = biz.member_count || 0;
  const apps = biz.app_count || 0;

  // Quick status line
  console.log(`\n  ${biz.name} (${biz.slug})`);
  console.log(`  ${'─'.repeat(40)}`);
  console.log(`  Agents:   ${agents}`);
  console.log(`  Apps:     ${apps}`);
  if (biz.workspace_id) console.log(`  Workspace: ${biz.workspace_id.slice(0, 12)}...`);
  console.log(`  Created:  ${biz.created_at ? biz.created_at.split('T')[0] : '?'}`);
  console.log('');
}

function describeAccess(member) {
  const role = (member.role || '').toLowerCase();
  if (role === 'owner') return 'full control';
  if (role === 'admin') return 'admin access';
  if (role === 'member') return 'standard access';
  if (role === 'agent') return 'agent';
  return role || 'unknown';
}

async function businessTeam(slug) {
  const requestedSlug = detectBusinessSlug(slug);
  if (!requestedSlug) {
    console.error('No business specified. Usage: atris business team <slug>');
    process.exit(1);
  }

  const creds = loadCredentials();
  if (!creds || !creds.token) {
    console.error('Not logged in. Run: atris login');
    process.exit(1);
  }

  const resolved = await resolveSlug(requestedSlug, creds);
  if (!resolved) {
    console.error(`Business "${requestedSlug}" not found.`);
    process.exit(1);
  }

  const result = await apiRequestJson(`/business/${resolved.business_id}`, {
    method: 'GET',
    token: creds.token,
  });

  if (!result.ok) {
    console.error(`Failed to fetch business team: ${result.errorMessage || result.status}`);
    process.exit(1);
  }

  const biz = result.data || {};
  const members = Array.isArray(biz.members) ? [...biz.members] : [];
  const roleOrder = { owner: 0, admin: 1, member: 2, agent: 3 };
  members.sort((a, b) => {
    const roleDelta = (roleOrder[a.role] ?? 99) - (roleOrder[b.role] ?? 99);
    if (roleDelta !== 0) return roleDelta;
    const aName = (a.display_name || a.name || a.email || '').toLowerCase();
    const bName = (b.display_name || b.name || b.email || '').toLowerCase();
    return aName.localeCompare(bName);
  });

  const admins = members.filter(m => ['owner', 'admin'].includes((m.role || '').toLowerCase()));
  const nonAdmins = members.filter(m => !['owner', 'admin'].includes((m.role || '').toLowerCase()));
  const roleCounts = members.reduce((acc, member) => {
    const role = member.role || 'unknown';
    acc[role] = (acc[role] || 0) + 1;
    return acc;
  }, {});
  const roleSummary = Object.entries(roleCounts)
    .sort((a, b) => (roleOrder[a[0]] ?? 99) - (roleOrder[b[0]] ?? 99))
    .map(([role, count]) => `${count} ${role}${count === 1 ? '' : 's'}`)
    .join(', ');

  console.log('');
  console.log(`Business Team: ${biz.name || resolved.name || requestedSlug} (${biz.slug || resolved.slug || requestedSlug})`);
  console.log('━'.repeat(32 + (biz.name || resolved.name || requestedSlug).length));
  console.log('');
  console.log(`  Members: ${members.length}`);
  console.log(`  Roles:   ${roleSummary || 'none'}`);
  console.log(`  Admins:  ${admins.length}`);

  if (admins.length > 0) {
    console.log('');
    console.log('  Admin Access:');
    for (const member of admins) {
      const name = member.display_name || member.name || member.email || 'Unknown';
      const email = member.email || '(no email)';
      const role = member.role || 'unknown';
      console.log(`    ${name.padEnd(24)} ${role.padEnd(8)} ${describeAccess(member).padEnd(14)} ${email}`);
    }
  }

  if (nonAdmins.length > 0) {
    console.log('');
    console.log('  Standard Access:');
    for (const member of nonAdmins) {
      const name = member.display_name || member.name || member.email || 'Unknown';
      const email = member.email || '(no email)';
      const role = member.role || 'unknown';
      console.log(`    ${name.padEnd(24)} ${role.padEnd(8)} ${describeAccess(member).padEnd(14)} ${email}`);
    }
  }

  console.log('');
}


async function connectService(connector, ...flags) {
  if (!connector) {
    console.log('Usage: atris business connect <service> [--business <slug>]');
    console.log('');
    console.log('Available connectors:');
    // List skills that look like integrations
    const skillDirs = [
      path.join(__dirname, '..', '..', '.claude', 'skills'),
      path.join(require('os').homedir(), '.claude', 'skills'),
    ];
    const seen = new Set();
    for (const dir of skillDirs) {
      if (!fs.existsSync(dir)) continue;
      for (const name of fs.readdirSync(dir)) {
        const skillFile = path.join(dir, name, 'SKILL.md');
        if (fs.existsSync(skillFile) && !seen.has(name)) {
          seen.add(name);
        }
      }
    }
    const integrations = [...seen].filter(s =>
      ['slack', 'hubspot', 'linear', 'notion', 'google-drive', 'github',
       'calendar', 'email-agent', 'x-search', 'youtube', 'ramp'].includes(s)
    ).sort();
    for (const s of integrations) {
      console.log(`  ${s}`);
    }
    if (integrations.length === 0) console.log('  (none found — install skills first)');
    return;
  }

  // Parse --business flag
  let bizSlug = null;
  for (let i = 0; i < flags.length; i++) {
    if ((flags[i] === '--business' || flags[i] === '-b') && flags[i + 1]) {
      bizSlug = flags[i + 1];
      i++;
    }
  }

  // Find the skill
  const skillDirs = [
    path.join(__dirname, '..', '..', '.claude', 'skills', connector),
    path.join(require('os').homedir(), '.claude', 'skills', connector),
  ];
  let skillPath = null;
  for (const dir of skillDirs) {
    const p = path.join(dir, 'SKILL.md');
    if (fs.existsSync(p)) { skillPath = p; break; }
  }

  if (!skillPath) {
    console.error(`Skill "${connector}" not found.`);
    console.error('Check: .claude/skills/ or ~/.claude/skills/');
    process.exit(1);
  }

  console.log(`\n  Connecting: ${connector}`);
  console.log(`  Skill:     ${skillPath}`);
  if (bizSlug) console.log(`  Business:  ${bizSlug}`);

  // Read skill to check for required secrets
  const skillContent = fs.readFileSync(skillPath, 'utf8');
  const secretMatches = skillContent.match(/[A-Z][A-Z0-9_]*_(?:KEY|TOKEN|SECRET|PASSWORD|API_KEY)/g) || [];
  const uniqueSecrets = [...new Set(secretMatches)];

  if (uniqueSecrets.length > 0) {
    console.log(`\n  Required secrets:`);
    for (const secret of uniqueSecrets) {
      console.log(`    ${secret}`);
    }
    console.log(`\n  Store secrets with: atris computer run "echo $${uniqueSecrets[0]}"`);
    console.log(`  Or set in: ~/.atris/secrets/${connector}/`);
  }

  // Create local secrets directory
  const secretsDir = path.join(require('os').homedir(), '.atris', 'secrets', connector);
  if (!fs.existsSync(secretsDir)) {
    fs.mkdirSync(secretsDir, { recursive: true });
    console.log(`\n  Created secrets dir: ${secretsDir}/`);
  }

  console.log(`\n  Connected "${connector}" skill.`);
  console.log(`  Agent can now use ${connector} capabilities.`);
  console.log('');
}


async function setNotificationMode(mode, ...flags) {
  const validModes = ['digest', 'silent', 'push'];
  if (!mode || !validModes.includes(mode)) {
    console.log('Usage: atris business notify <digest|silent|push> [--business <slug>]');
    console.log('');
    console.log('  digest   Batch all reports into morning briefing (1 email/day)');
    console.log('  silent   Log only, never notify (check with `atris business status`)');
    console.log('  push     Interrupt immediately on every action (default, noisy)');
    return;
  }

  const creds = loadCredentials();
  if (!creds || !creds.token) {
    console.error('Not logged in. Run: atris login');
    process.exit(1);
  }

  // Parse --business flag
  let bizSlug = null;
  for (let i = 0; i < flags.length; i++) {
    if ((flags[i] === '--business' || flags[i] === '-b') && flags[i + 1]) {
      bizSlug = flags[i + 1];
      i++;
    }
  }

  const resolved = await resolveSlug(bizSlug, creds);
  if (!resolved) {
    console.error('No business specified. Usage: atris business notify digest --business <slug>');
    process.exit(1);
  }

  // Update business config with notification mode
  const result = await apiRequestJson(`/business/${resolved.business_id}`, {
    method: 'PUT',
    token: creds.token,
    body: {
      config: { notification_mode: mode },
    },
  });

  if (!result.ok) {
    console.error(`Failed: ${result.errorMessage || result.status}`);
    process.exit(1);
  }

  const icons = { digest: '📬', silent: '🔇', push: '🔔' };
  const descriptions = {
    digest: 'Agents report in morning briefing only (1 email/day)',
    silent: 'Everything logged, nothing notified',
    push: 'Every action sends a notification',
  };

  console.log(`\n  ${icons[mode]} Notification mode: ${mode}`);
  console.log(`  ${descriptions[mode]}`);
  console.log(`  Business: ${resolved.name || resolved.slug}`);
  console.log('');
}


async function deployBusiness(slug) {
  if (!slug) {
    console.error('Usage: atris business deploy <slug>');
    console.error('  Pushes local atris/business/<slug>/ to the cloud business.');
    process.exit(1);
  }

  const creds = loadCredentials();
  if (!creds || !creds.token) {
    console.error('Not logged in. Run: atris login');
    process.exit(1);
  }

  // Find local business directory
  const atrisDir = findAtrisDir();
  if (!atrisDir) {
    console.error('Not in an atris project. Run from a directory with atris/ folder.');
    process.exit(1);
  }

  const bizDir = path.join(atrisDir, 'business', slug);
  if (!fs.existsSync(bizDir)) {
    console.error(`Local business not found: ${bizDir}`);
    console.error(`Create with: atris business create "${slug}"`);
    process.exit(1);
  }

  // Check if business exists in cloud
  const businesses = loadBusinesses();
  let bizConfig = businesses[slug];

  if (!bizConfig) {
    // Try to find by slug in cloud
    const listResult = await apiRequestJson('/business/', { method: 'GET', token: creds.token });
    if (listResult.ok && Array.isArray(listResult.data)) {
      const match = listResult.data.find(b => businessMatchesSlug(b, slug));
      if (match) {
        bizConfig = { business_id: match.id, workspace_id: match.workspace_id, name: match.name, slug: match.slug };
        businesses[slug] = { ...bizConfig, added_at: new Date().toISOString() };
        saveBusinesses(businesses);
      }
    }
  }

  if (!bizConfig || !bizConfig.business_id) {
    console.log(`  Business "${slug}" not in cloud. Creating...`);
    const bizMd = path.join(bizDir, 'BUSINESS.md');
    const name = slug.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    const createResult = await apiRequestJson('/business/', {
      method: 'POST', token: creds.token,
      body: { name },
    });
    if (!createResult.ok) {
      console.error(`Failed to create: ${createResult.errorMessage || createResult.status}`);
      process.exit(1);
    }
    bizConfig = {
      business_id: createResult.data.id,
      workspace_id: createResult.data.workspace_id,
      name: createResult.data.name,
      slug: createResult.data.slug,
    };
    businesses[slug] = { ...bizConfig, added_at: new Date().toISOString() };
    saveBusinesses(businesses);
    console.log(`  Created: ${bizConfig.name} (${bizConfig.business_id.slice(0, 12)}...)`);
  }

  // Upload workspace files
  const workspaceDir = path.join(bizDir, 'workspace');
  let uploadCount = 0;
  if (fs.existsSync(workspaceDir)) {
    const files = walkDir(workspaceDir);
    for (const filePath of files) {
      const relativePath = path.relative(workspaceDir, filePath);
      if (relativePath.startsWith('.')) continue;
      try {
        const content = fs.readFileSync(filePath, 'utf8');
        const uploadResult = await apiRequestJson(
          `/business/${bizConfig.business_id}/workspaces/${bizConfig.workspace_id}/file`,
          { method: 'PUT', token: creds.token, body: { path: '/' + relativePath, content } }
        );
        if (uploadResult.ok) {
          uploadCount++;
          process.stdout.write(`  Uploaded: ${relativePath}\n`);
        }
      } catch (e) {
        // Skip binary files or errors
      }
    }
  }

  // Upload BUSINESS.md as context
  const bizMd = path.join(bizDir, 'BUSINESS.md');
  if (fs.existsSync(bizMd)) {
    try {
      const content = fs.readFileSync(bizMd, 'utf8');
      await apiRequestJson(
        `/business/${bizConfig.business_id}/workspaces/${bizConfig.workspace_id}/file`,
        { method: 'PUT', token: creds.token, body: { path: '/BUSINESS.md', content } }
      );
      uploadCount++;
      console.log('  Uploaded: BUSINESS.md');
    } catch {}
  }

  console.log(`\n  Deployed ${uploadCount} files to ${bizConfig.name}`);
  console.log(`  Dashboard: https://atris.ai/dashboard/gm/${bizConfig.business_id}`);
  console.log('');
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


async function quickstart() {
  console.log(`
  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Start a Business With An Operating Loop
  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  1. Create:
     atris business init "My Company" --template saas

  2. Open the local workspace:
     cd ~/arena/atris-business/my-company

  3. See what Atris knows:
     atris
     atris business start
     atris radar

  4. Claim the first real action:
     atris task next
     atris member activate operator
     atris mission status --status active --json

  5. If no active mission exists:
     atris mission start "Run the first useful loop for My Company" --owner operator --runner codex_goal --lane business --verify "atris business check" --stop "first proof recap recorded"
     atris member goal-from-mission operator

  6. Seed onboarding context:
     atris business onboard --website https://example.com --contact "Founder Name" --note "what they do"

  7. Do one useful loop:
     atris do
     atris business record atris/reports/YYYY-MM-DD-your-recap.md --outcome mixed --metric "operator speed"

  8. Write the handoff before sharing:
     atris business share --write

  9. Push local state to cloud:
     atris sync --dry-run
     atris sync

  Repeat:
     atris radar -> atris task next -> atris do -> record -> share

  Optional:
     atris sync --watch
     atris business connect slack --business my-company
     atris business connect github --business my-company

     atris business notify digest --business my-company
     (get 1 email/day instead of every notification)

  Templates: saas, agency, ecommerce, content, restaurant

  Rule of thumb:
     atris business init "<name>"    = cloud + local business computer workspace
     atris business create "<name>"  = cloud-only unless you pass --workspace
  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`);
}


function printBusinessHelp() {
  console.log('Usage: atris business <command> [args]');
  console.log('');
  console.log('  quickstart           ← Start here! 3-command guide');
  console.log('');
  console.log('  init <name>          RECOMMENDED: create a business environment (cloud + local)');
  console.log('  workspace <name>     Alias for init');
  console.log('  create <name>        Cloud-only business record; add --workspace to also scaffold local');
  console.log('  add <slug>           Register an existing cloud business');
  console.log('  list                 Show registered businesses');
  console.log('  team [slug]          Show members, roles, and admin access');
  console.log('  status <slug>        Quick status check');
  console.log('  health [slug]        Full health dashboard');
  console.log('  audit                Audit all businesses');
  console.log('  doctor [--fix]       Find stale business cache, alias, and folder bindings');
  console.log('  connect <service>    Connect a skill/integration');
  console.log('  notify <mode>        Set notification mode (digest/silent/push)');
  console.log('  deploy <slug>        Push local business to cloud');
  console.log('  onboard              Seed brief, person, first loop, safe next action, and one-pager from sparse input');
  console.log('  start                Check a received business workspace and show the first loop');
  console.log('  check                Alias for start');
  console.log('  share                Print/write a collaborator handoff for this business workspace');
  console.log('  record <report>      Append recap state into events, episodes, and scorecards');
  console.log('  remove <slug>        Unregister locally');
  console.log('');
  console.log('  Already-attached business? Run `atris pull <slug>` to scaffold a local workspace.');
}

async function businessCommand(subcommand, ...args) {
  // Help intercept — without this, `atris business init --help` would treat
  // `--help` as a business name and create one. Same for any subcommand that
  // takes a positional name/slug.
  if (!subcommand || isHelpToken(subcommand)) {
    printBusinessHelp();
    return;
  }
  if (args.length > 0 && isHelpToken(args[0]) && subcommand !== 'doctor') {
    printBusinessHelp();
    return;
  }

  switch (subcommand) {
    case 'add':
      await addBusiness(args[0]);
      break;
    case 'create':
    case 'new':
      await createBusiness(args[0], ...args.slice(1));
      break;
    case 'init':
    case 'workspace':
      await initBusinessWorkspace(args[0], ...args.slice(1));
      break;
    case 'list':
    case 'ls': {
      const opts = {};
      if (args.includes('--local')) opts.local = true;
      if (args.includes('--json')) opts.json = true;
      await listBusinesses(opts);
      break;
    }
    case 'fleet': {
      // Shorthand for `business list --local`
      const opts = { local: true };
      if (args.includes('--json')) opts.json = true;
      await listBusinesses(opts);
      break;
    }
    case 'remove':
    case 'rm':
      await removeBusiness(args[0]);
      break;
    case 'health':
      await businessHealth(args[0]);
      break;
    case 'team':
    case 'members':
    case 'roster':
      await businessTeam(args[0]);
      break;
    case 'status':
      await businessStatus(args[0]);
      break;
    case 'audit':
      await businessAudit();
      break;
    case 'doctor':
      await businessDoctor(...args);
      break;
    case 'connect':
      await connectService(args[0], ...args.slice(1));
      break;
    case 'notify':
    case 'notification':
      await setNotificationMode(args[0], ...args.slice(1));
      break;
    case 'deploy':
    case 'push':
      await deployBusiness(args[0]);
      break;
    case 'record':
    case 'record-recap':
      await recordBusinessRun(args[0], ...args.slice(1));
      break;
    case 'onboard':
      await onboardBusiness(...args);
      break;
    case 'start':
    case 'check':
    case 'ready':
      await startBusinessWorkspace(...args);
      break;
    case 'share':
    case 'handoff':
      await shareBusinessWorkspace(...args);
      break;
    case 'quickstart':
    case 'guide':
      await quickstart();
      break;
    default:
      console.error(`Unknown subcommand: ${subcommand}`);
      console.error('');
      printBusinessHelp();
      process.exitCode = 1;
  }
}

module.exports = {
  businessCommand,
  businessHealth,
  businessAudit,
  businessDoctor,
  businessTeam,
  loadBusinesses,
  saveBusinesses,
  getBusinessConfigPath,
  businessMatchesSlug,
  analyzeBusinessDoctor,
  readBusinessFolderBindings,
  createCanonicalBusinessWorkspace,
  initBusinessWorkspace,
  onboardBusiness,
  startBusinessWorkspace,
  shareBusinessWorkspace,
  collectBusinessShareState,
  renderBusinessCreatedNextSteps,
  renderBusinessShareHandoff,
  renderBusinessStartCard,
  recordBusinessRun,
};
