'use strict';

// Thin swarm coordination over existing primitives: Git + Swarlo SQL + atris/team/.
//
// No custom orchestration engine. A swarm is:
//   - 1 lead seat (default: coordinator, or any atris/team/<member>)
//   - N worker seats (named atris/team/ members or numbered clones like builder-1..N)
//   - Swarlo for atomic claims, dependencies, file locks, and liveness/stall checks
//   - Local frozen-module guard (reusing lib/campaign-protect.js) so solved modules stay untouched

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const swarlo = require('./swarlo-members');
const { readMemberCard, resolveEngineForMember } = require('./member-engine');
const { setMemberAwake } = require('./member-switches');
const { canonicalEngineName } = require('./engine-registry');
const { planProtect, changedProtected, checkoutTop } = require('./campaign-protect');

const DEFAULT_SERVER = 'http://localhost:8090';
const DEFAULT_HUB = swarlo.DEFAULT_HUB_ID;
const DEFAULT_CHANNEL = 'general';
const DEFAULT_LEAD = 'coordinator';
const DEFAULT_WORKER_ROLE = 'builder';
const PREFERRED_WORKERS = ['builder', 'executor', 'validator', 'researcher', 'navigator', 'auto-improver', 'sentinel'];

function swarmStatePath(root) {
  return path.join(root, '.atris', 'state', 'swarm.json');
}

function frozenStatePath(root) {
  return path.join(root, '.atris', 'state', 'swarm-frozen.json');
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(file, payload) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
  return payload;
}

function loadSwarloConfig(root = process.cwd(), home = os.homedir()) {
  const paths = [
    path.join(home, '.swarlo', 'config.json'),
    path.join(root, '.swarlo', 'config.json'),
  ];
  for (const file of paths) {
    const cfg = readJson(file);
    if (cfg && typeof cfg === 'object') return cfg;
  }
  return {};
}

function resolveHubTarget(root, opts = {}) {
  const home = opts.home || os.homedir();
  const cfg = loadSwarloConfig(root, home);
  const server = opts.server || process.env.SWARLO_SERVER || cfg.server || DEFAULT_SERVER;
  const hub = opts.hub || process.env.SWARLO_HUB || cfg.hub || DEFAULT_HUB;
  const configured = swarlo.configuredChannels(cfg);
  const channel = opts.channel || configured[0] || DEFAULT_CHANNEL;
  return { server, hub, channel, home };
}

function listWorkspaceMembers(root) {
  const teamDir = path.join(root, 'atris', 'team');
  if (!fs.existsSync(teamDir)) return [];
  return fs.readdirSync(teamDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('_') && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .filter((name) => fs.existsSync(path.join(teamDir, name, 'MEMBER.md')))
    .sort();
}

// Parse a seat name that may be a direct team member ("builder"), a numbered
// clone ("builder-2") inheriting its base role's MEMBER.md, or a solo ad-hoc
// seat ("atris") when a workspace has no team seats configured yet.
function resolveSeatSpec(root, rawName, fallbackRole = DEFAULT_WORKER_ROLE, { allowSolo = false } = {}) {
  const id = String(rawName || '').trim().toLowerCase();
  if (!id) return { ok: false, id: '', error: 'empty member name' };
  const direct = readMemberCard(root, id);
  if (direct.found) {
    return { ok: true, id, baseMember: id, name: direct.name || id, cloned: false, solo: false };
  }
  const cloneMatch = id.match(/^([a-z0-9][a-z0-9._-]*)-(\d+)$/);
  if (cloneMatch) {
    const base = cloneMatch[1];
    const baseCard = readMemberCard(root, base);
    if (baseCard.found) {
      return { ok: true, id, baseMember: base, name: `${baseCard.name || base} #${cloneMatch[2]}`, cloned: true, solo: false };
    }
    const fallbackCard = readMemberCard(root, fallbackRole);
    if (fallbackCard.found) {
      return { ok: true, id, baseMember: fallbackRole, name: `${id} (${fallbackCard.name || fallbackRole})`, cloned: true, solo: false };
    }
  }
  if (allowSolo) {
    return { ok: true, id, baseMember: id, name: id, cloned: false, solo: true };
  }
  return { ok: false, id, error: `no team member named ${id} (atris/team/${id}/MEMBER.md)` };
}

function resolveSeatEngine(root, baseMember, engineOverride = '') {
  if (engineOverride) {
    const id = canonicalEngineName(engineOverride) || canonicalEngineName(String(engineOverride).split(/[\s,]+/)[0]) || '';
    if (!id) return { engine: null, error: `engine profile "${engineOverride}" is not recognized` };
    return { engine: id, error: null };
  }
  const picked = resolveEngineForMember(baseMember, root);
  if (picked && picked.engine) return { engine: picked.engine.id, error: null };
  return { engine: 'auto', error: null };
}

// Pick N worker seats for a swarm: explicit --team first, otherwise real
// atris/team/ seats (excluding the lead), then numbered clones of --role to reach N.
function planWorkerSeats(root, { lead, count = 0, team = [], role = DEFAULT_WORKER_ROLE, existing = [] } = {}) {
  const taken = new Set([lead, ...existing].filter(Boolean));
  const seats = [];

  if (team.length) {
    for (const raw of team) {
      const id = String(raw || '').trim().toLowerCase();
      if (!id || taken.has(id)) continue;
      taken.add(id);
      seats.push(id);
    }
    return seats;
  }

  const wanted = Math.max(0, Number(count) || 0);
  if (wanted === 0) return seats;

  const available = listWorkspaceMembers(root);
  const baseRole = available.includes(role) ? role : (available.find((m) => m !== lead) || role);

  // If the caller explicitly asked for a specific role clone count or if
  // expanding an existing swarm, mix unused preferred team seats first unless
  // an explicit role override was requested.
  if (!role || role === DEFAULT_WORKER_ROLE) {
    const ordered = [
      ...PREFERRED_WORKERS.filter((m) => available.includes(m)),
      ...available.filter((m) => !PREFERRED_WORKERS.includes(m)),
    ].filter((m) => !taken.has(m) && m !== 'strategist');
    for (const name of ordered) {
      if (seats.length >= wanted) break;
      taken.add(name);
      seats.push(name);
    }
  }

  let seq = 1;
  while (seats.length < wanted) {
    const cloneId = `${baseRole}-${seq}`;
    seq += 1;
    if (taken.has(cloneId)) continue;
    taken.add(cloneId);
    seats.push(cloneId);
  }
  return seats;
}

function buildLeadBrief({ objective, lead, workers, channel, campaignId = '', frozenPaths = [] }) {
  const workerList = workers.length ? workers.join(', ') : 'none yet';
  const lines = [
    `[swarm lead: ${lead}] objective: ${objective}`,
    `roles: lead=${lead}; workers=${workerList} (${workers.length})`,
    `channel: #${channel}${campaignId ? ` | campaign: ${campaignId}` : ''}`,
    'protocol: lead splits into checkable tasks with depends_on on Swarlo; workers pull unblocked work (claim_next), verify bare, commit on Git, report done with include_next.',
    'tiers: coordinator routes, strategist judges escalations, human owns taste/spend/deploys.',
  ];
  if (frozenPaths.length) {
    lines.push(`frozen modules (do not modify): ${frozenPaths.join(', ')}`);
  }
  return lines.join('\n');
}

function normalizeServerUrl(url) {
  return String(url || '').trim().replace(/\/+$/, '').toLowerCase();
}

function exactMemberToken(memberId, target, deps = {}) {
  const sw = deps.swarlo || swarlo;
  if (!memberId || !target || !target.server || !target.hub) return '';
  if (typeof sw.identityDirFor === 'function' && typeof sw.loadIdentity === 'function') {
    const dir = sw.identityDirFor({ server: target.server, hub: target.hub, member: memberId }, target.home);
    const loaded = sw.loadIdentity(dir);
    if (loaded && loaded.token) return String(loaded.token).trim();
    return '';
  }
  return '';
}

function loadSponsorKey(hub, home = os.homedir(), { server = '', lead = '', sw = swarlo } = {}) {
  const targetServer = normalizeServerUrl(server);
  if (lead) {
    const leadToken = exactMemberToken(lead, { server, hub, home }, { swarlo: sw });
    if (leadToken) return leadToken;
  }
  const fleetState = readJson(path.join(home, '.swarlo', 'fleet-state.json'), {});
  if (fleetState && fleetState.api_key && fleetState.hub_id === hub) {
    const fsServer = normalizeServerUrl(fleetState.server || '');
    if (!targetServer || !fsServer || fsServer === targetServer) return fleetState.api_key;
  }
  const shared = readJson(path.join(home, '.swarlo', 'config.json'), {});
  if (shared && (shared.api_key || shared.token)) {
    const hubMatch = !shared.hub || shared.hub === hub;
    const cfgServer = normalizeServerUrl(shared.server || '');
    const serverMatch = !targetServer || (cfgServer && cfgServer === targetServer);
    if (hubMatch && serverMatch) return shared.api_key || shared.token;
  }
  return process.env.SWARLO_TOKEN || process.env.SWARLO_API_KEY || '';
}

function resolveMemberToken(memberId, target, deps = {}) {
  return exactMemberToken(memberId, target, deps);
}

async function activateSeatOnHub(root, seatSpec, { server, hub, channel, engine, roleTag, dryRun, home, sponsorKey, deps = {} }) {
  const sw = deps.swarlo || swarlo;
  const result = {
    member: seatSpec.id,
    base_member: seatSpec.baseMember,
    role: roleTag,
    engine,
    cloned: seatSpec.cloned,
    stage: 'planned',
    identity: dryRun ? 'dry-run' : '',
    error: null,
    token: '',
  };
  if (dryRun) return result;

  const identDir = sw.identityDirFor({ server, hub, member: seatSpec.id }, home);
  const existing = sw.loadIdentity(identDir);
  let token = existing ? existing.token : '';
  if (token) {
    result.identity = 'reused';
  } else {
    const inviteToken = process.env.SWARLO_INVITE_TOKEN || '';
    const reg = await sw.registerMember({
      server,
      hub,
      memberId: seatSpec.id,
      memberName: seatSpec.name,
      inviteToken,
      sponsorKey,
    });
    if (!reg.ok) {
      result.stage = 'identity';
      result.error = `register failed (HTTP ${reg.status})`;
      return result;
    }
    token = reg.token;
    sw.saveIdentity(identDir, {
      server,
      hub,
      member_id: seatSpec.id,
      member_name: seatSpec.name,
      member_type: 'agent',
      token,
    });
    result.identity = 'registered';
  }

  result.token = token;
  const post = await sw.postChannelNote({
    server,
    hub,
    channel,
    content: `${seatSpec.id} joined swarm as ${roleTag} on ${engine}`,
    kind: 'status',
    token,
    memberId: seatSpec.id,
    memberName: seatSpec.name,
  });
  if (!post.ok) {
    result.stage = 'channel';
    result.error = `post to #${channel} failed (HTTP ${post.status})`;
    return result;
  }

  try {
    setMemberAwake(seatSpec.baseMember, true, root);
  } catch { /* non-fatal */ }

  result.stage = 'ready';
  return result;
}

function loadSwarmState(root) {
  return readJson(swarmStatePath(root), null);
}

function updateSwarmState(root, updater) {
  const current = loadSwarmState(root);
  if (!current) return null;
  const next = typeof updater === 'function' ? updater(current) : { ...current, ...updater };
  if (!next) return null;
  next.updated_at = new Date().toISOString();
  return writeJsonAtomic(swarmStatePath(root), next);
}

function loadFrozenState(root) {
  return readJson(frozenStatePath(root), { paths: [], base_commit: null, entries: [] });
}

function activeCampaignSummary(root) {
  try {
    const store = require('./campaign-store');
    const opened = store.openCampaignStore(root);
    const rows = store.listCampaigns(opened) || [];
    return rows
      .filter((row) => row && !['done', 'stopped'].includes(String(row.state || row.status || '')))
      .slice(0, 6)
      .map((row) => ({
        id: row.id,
        title: String(row.title || row.goal || '').slice(0, 120),
        state: row.state || row.status || 'active',
        lead: row.lead || row.owner || null,
      }));
  } catch {
    return [];
  }
}

async function startSwarm(root, options = {}, deps = {}) {
  const sw = deps.swarlo || swarlo;
  const objective = String(options.objective || '').trim();
  if (!objective) {
    return { ok: false, exitCode: 2, error: 'usage: atris swarm start "<objective>" [--lead coordinator] [--workers N] [--team a,b] [--role builder] [--channel general] [--dry-run]' };
  }

  const target = resolveHubTarget(root, options);
  const available = listWorkspaceMembers(root);
  const allowSolo = Boolean(options.allowSolo || options.solo || available.length === 0);
  const defaultLead = available.includes(DEFAULT_LEAD) ? DEFAULT_LEAD : (available[0] || 'atris');
  const leadName = String(options.lead || defaultLead).trim().toLowerCase();
  const leadSpec = resolveSeatSpec(root, leadName, DEFAULT_LEAD, { allowSolo });
  if (!leadSpec.ok) return { ok: false, exitCode: 2, error: leadSpec.error };

  const workerCount = options.solo
    ? 0
    : (options.team && options.team.length
      ? options.team.length
      : (available.length <= 1 && options.workers === undefined ? 0 : Math.max(0, options.workers !== undefined ? Number(options.workers) : 2)));
  const workerIds = workerCount === 0 && !(options.team && options.team.length)
    ? []
    : planWorkerSeats(root, {
      lead: leadSpec.id,
      count: workerCount,
      team: options.team || [],
      role: options.role || DEFAULT_WORKER_ROLE,
    });

  const seatPlans = [
    { spec: leadSpec, roleTag: workerIds.length ? 'lead' : 'solo' },
    ...workerIds.map((id) => ({ spec: resolveSeatSpec(root, id, options.role || DEFAULT_WORKER_ROLE, { allowSolo }), roleTag: 'worker' })),
  ];
  const bad = seatPlans.find((item) => !item.spec.ok);
  if (bad) return { ok: false, exitCode: 2, error: bad.spec.error };

  const resolvedSeats = [];
  for (const item of seatPlans) {
    const picked = resolveSeatEngine(root, item.spec.baseMember, options.engine || '');
    if (picked.error) return { ok: false, exitCode: 2, error: picked.error };
    resolvedSeats.push({ ...item, engine: picked.engine });
  }

  const frozen = loadFrozenState(root);
  const brief = buildLeadBrief({
    objective,
    lead: leadSpec.id,
    workers: workerIds,
    channel: target.channel,
    campaignId: options.campaign || '',
    frozenPaths: frozen.paths || [],
  });

  let hubReachable = false;
  if (!options.dryRun) {
    const health = await sw.hubHealth(target.server);
    hubReachable = Boolean(health && health.ok);
  }

  let sponsorKey = loadSponsorKey(target.hub, target.home, { server: target.server, lead: leadSpec.id, sw });
  const launched = options.dryRun ? {} : sw.loadLaunched(target.home);
  let launchedDirty = false;
  const members = [];

  for (const seat of resolvedSeats) {
    if (!options.dryRun && !hubReachable) {
      members.push({
        member: seat.spec.id,
        base_member: seat.spec.baseMember,
        role: seat.roleTag,
        engine: seat.engine,
        cloned: seat.spec.cloned,
        stage: 'local-only',
        identity: 'offline',
        error: null,
      });
      try { setMemberAwake(seat.spec.baseMember, true, root); } catch { /* ignore */ }
      continue;
    }

    const activated = await activateSeatOnHub(root, seat.spec, {
      server: target.server,
      hub: target.hub,
      channel: target.channel,
      engine: seat.engine,
      roleTag: seat.roleTag,
      dryRun: Boolean(options.dryRun),
      home: target.home,
      sponsorKey,
      deps,
    });
    if (!sponsorKey && activated.token) sponsorKey = activated.token;
    if (activated.stage === 'ready') {
      if (!launched[target.hub] || typeof launched[target.hub] !== 'object') launched[target.hub] = {};
      launched[target.hub][seat.spec.id] = {
        server: target.server,
        engine: seat.engine,
        channels: [target.channel],
        member_name: seat.spec.name,
        role: seat.roleTag,
        launched_at: new Date().toISOString(),
      };
      launchedDirty = true;
    }
    const { token: _drop, ...safeMember } = activated;
    members.push({ ...safeMember, _token: activated.token });
  }

  let announced = false;
  if (!options.dryRun && hubReachable) {
    const leadEntry = members.find((m) => (m.role === 'lead' || m.role === 'solo') && m._token);
    if (leadEntry) {
      const post = await sw.postChannelNote({
        server: target.server,
        hub: target.hub,
        channel: target.channel,
        content: brief,
        kind: 'briefing',
        token: leadEntry._token,
        memberId: leadSpec.id,
        memberName: leadSpec.name,
      });
      announced = Boolean(post && post.ok);
    }
  }

  if (launchedDirty) sw.saveLaunched(launched, target.home);

  const cleanMembers = members.map(({ _token, ...rest }) => rest);
  const state = {
    schema: 'atris.swarm.v1',
    objective,
    lead: leadSpec.id,
    workers: workerIds,
    members: cleanMembers,
    hub: target.hub,
    server: target.server,
    channel: target.channel,
    campaign_id: options.campaign || null,
    hub_reachable: hubReachable,
    announced,
    started_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  if (!options.dryRun) {
    writeJsonAtomic(swarmStatePath(root), state);
  }

  const failed = cleanMembers.filter((m) => m.error).length;
  return {
    ok: failed === 0,
    exitCode: failed === 0 ? 0 : (failed < cleanMembers.length ? 1 : 2),
    dry_run: Boolean(options.dryRun),
    hub_reachable: hubReachable,
    announced,
    brief,
    swarm: state,
  };
}

async function expandSwarm(root, options = {}, deps = {}) {
  const sw = deps.swarlo || swarlo;
  const existing = loadSwarmState(root);
  if (!existing) {
    return { ok: false, exitCode: 2, error: 'no active swarm in this workspace. start one: atris swarm start "<objective>"' };
  }

  const target = resolveHubTarget(root, {
    server: options.server || existing.server,
    hub: options.hub || existing.hub,
    channel: options.channel || existing.channel,
    home: options.home,
  });

  const existingWorkers = Array.isArray(existing.workers) ? existing.workers : [];
  const requestedMembers = Array.isArray(options.members) ? options.members : [];
  const requestedCount = Number(options.count) || 0;
  const newIds = planWorkerSeats(root, {
    lead: existing.lead,
    count: requestedMembers.length ? requestedMembers.length : Math.max(1, requestedCount),
    team: requestedMembers,
    role: options.role || DEFAULT_WORKER_ROLE,
    existing: existingWorkers,
  });

  if (!newIds.length) {
    return { ok: false, exitCode: 2, error: 'every requested worker is already in the swarm' };
  }

  const plans = newIds.map((id) => ({ id, spec: resolveSeatSpec(root, id, options.role || DEFAULT_WORKER_ROLE) }));
  const bad = plans.find((p) => !p.spec.ok);
  if (bad) return { ok: false, exitCode: 2, error: bad.spec.error };

  const hubReachable = options.dryRun ? false : Boolean((await sw.hubHealth(target.server)).ok);
  let sponsorKey = loadSponsorKey(target.hub, target.home, { server: target.server, lead: existing.lead, sw });
  const launched = options.dryRun ? {} : sw.loadLaunched(target.home);
  let launchedDirty = false;
  const added = [];

  for (const plan of plans) {
    const picked = resolveSeatEngine(root, plan.spec.baseMember, options.engine || '');
    if (picked.error) return { ok: false, exitCode: 2, error: picked.error };
    if (!options.dryRun && !hubReachable) {
      added.push({
        member: plan.spec.id,
        base_member: plan.spec.baseMember,
        role: 'worker',
        engine: picked.engine,
        cloned: plan.spec.cloned,
        stage: 'local-only',
        identity: 'offline',
        error: null,
      });
      try { setMemberAwake(plan.spec.baseMember, true, root); } catch { /* ignore */ }
      continue;
    }

    const activated = await activateSeatOnHub(root, plan.spec, {
      server: target.server,
      hub: target.hub,
      channel: target.channel,
      engine: picked.engine,
      roleTag: 'worker',
      dryRun: Boolean(options.dryRun),
      home: target.home,
      sponsorKey,
      deps,
    });
    if (!sponsorKey && activated.token) sponsorKey = activated.token;
    if (activated.stage === 'ready') {
      if (!launched[target.hub] || typeof launched[target.hub] !== 'object') launched[target.hub] = {};
      launched[target.hub][plan.spec.id] = {
        server: target.server,
        engine: picked.engine,
        channels: [target.channel],
        member_name: plan.spec.name,
        role: 'worker',
        launched_at: new Date().toISOString(),
      };
      launchedDirty = true;
    }
    const { token: _drop, ...safeMember } = activated;
    added.push(safeMember);
  }

  if (launchedDirty) sw.saveLaunched(launched, target.home);

  const updated = {
    ...existing,
    workers: [...existingWorkers, ...added.map((m) => m.member)],
    members: [...(existing.members || []), ...added],
    updated_at: new Date().toISOString(),
  };
  if (!options.dryRun) writeJsonAtomic(swarmStatePath(root), updated);

  const failed = added.filter((m) => m.error).length;
  return {
    ok: failed === 0,
    exitCode: failed === 0 ? 0 : 1,
    dry_run: Boolean(options.dryRun),
    hub_reachable: hubReachable,
    added,
    swarm: updated,
  };
}

function normalizeRelPath(root, given) {
  const here = fs.realpathSync(root);
  const top = checkoutTop(here) || here;
  const rel = path.relative(top, path.resolve(here, given)).split(path.sep).join('/');
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel;
}

async function freezeModules(root, paths = [], options = {}, deps = {}) {
  const sw = deps.swarlo || swarlo;
  const current = loadFrozenState(root);
  const existingPaths = Array.isArray(current.paths) ? current.paths : [];

  if (options.check) {
    return checkFrozenModules(root, options.targetDir || root);
  }

  if (options.unfreeze) {
    if (!paths.length) {
      return { ok: false, exitCode: 2, error: 'usage: atris swarm unfreeze <path...>' };
    }
    const existingSet = new Set(existingPaths);
    const entryByPath = new Map((current.entries || []).map((e) => [e.path, e]));
    const drop = new Set();
    for (const p of paths) {
      const norm = normalizeRelPath(root, p) || String(p || '').replace(/^\.\//, '');
      if (norm && existingSet.has(norm)) drop.add(norm);
    }
    const remaining = existingPaths.filter((p) => !drop.has(p));
    const next = {
      ...current,
      paths: remaining,
      entries: (current.entries || []).filter((e) => !drop.has(e.path)),
      updated_at: new Date().toISOString(),
    };
    let hubReleased = 0;
    if (!options.dryRun && drop.size > 0) {
      writeJsonAtomic(frozenStatePath(root), next);
      const active = loadSwarmState(root);
      const fallbackActor = String(options.as || (active && active.lead) || DEFAULT_LEAD);
      const target = resolveHubTarget(root, {
        server: options.server || (active && active.server),
        hub: options.hub || (active && active.hub),
        channel: options.channel || (active && active.channel),
        home: options.home,
      });
      const health = await sw.hubHealth(target.server);
      if (health && health.ok) {
        for (const p of drop) {
          const entry = entryByPath.get(p);
          const owner = String((entry && entry.by) || fallbackActor);
          const token = resolveMemberToken(owner, target, deps)
            || resolveMemberToken(fallbackActor, target, deps)
            || loadSponsorKey(target.hub, target.home, { server: target.server, lead: owner, sw });
          if (!token) continue;
          const rel = await sw.reportTaskNote({
            server: target.server,
            hub: target.hub,
            channel: target.channel,
            taskKey: `file:${p}`,
            status: 'done',
            content: `UNFROZEN by ${fallbackActor}`,
            token,
            memberId: owner,
            memberName: owner,
          }).catch(() => null);
          if (rel && rel.ok) hubReleased += 1;
        }
        const announceToken = resolveMemberToken(fallbackActor, target, deps)
          || loadSponsorKey(target.hub, target.home, { server: target.server, lead: fallbackActor, sw });
        if (announceToken) {
          await sw.postChannelNote({
            server: target.server,
            hub: target.hub,
            channel: target.channel,
            content: `unfroze ${[...drop].join(', ')}`,
            kind: 'status',
            token: announceToken,
            memberId: fallbackActor,
            memberName: fallbackActor,
          }).catch(() => null);
        }
      }
    }
    return { ok: true, exitCode: 0, action: 'unfreeze', paths: remaining, removed: [...drop], hub_released: hubReleased };
  }

  if (!paths.length) {
    return { ok: true, exitCode: 0, action: 'list', frozen: current };
  }

  const normalized = [];
  for (const given of paths) {
    const rel = normalizeRelPath(root, given);
    if (!rel) return { ok: false, exitCode: 2, error: `freeze path ${given} is not inside this workspace` };
    if (!normalized.includes(rel)) normalized.push(rel);
  }

  const merged = [...new Set([...existingPaths, ...normalized])];
  const gitPlan = planProtect(root, normalized);
  const newBaseCommit = gitPlan && !gitPlan.error ? gitPlan.base_commit : null;
  const topBaseCommit = current.base_commit || newBaseCommit;
  const actor = String(options.as || (loadSwarmState(root) && loadSwarmState(root).lead) || DEFAULT_LEAD);
  const reason = String(options.reason || 'module solved and frozen').trim();
  const stamp = new Date().toISOString();
  const existingEntries = (current.entries || [])
    .filter((e) => !normalized.includes(e.path))
    .map((e) => (e.base_commit ? e : { ...e, base_commit: current.base_commit || newBaseCommit }));
  const entries = [
    ...existingEntries,
    ...normalized.map((p) => ({ path: p, by: actor, reason, frozen_at: stamp, base_commit: newBaseCommit || topBaseCommit })),
  ];
  const next = {
    schema: 'atris.swarm_frozen.v1',
    base_commit: topBaseCommit,
    paths: merged,
    entries,
    updated_at: stamp,
  };

  let hubNotified = false;
  if (!options.dryRun) {
    writeJsonAtomic(frozenStatePath(root), next);
    const active = loadSwarmState(root);
    const target = resolveHubTarget(root, {
      server: options.server || (active && active.server),
      hub: options.hub || (active && active.hub),
      channel: options.channel || (active && active.channel),
      home: options.home,
    });
    const health = await sw.hubHealth(target.server);
    if (health && health.ok) {
      const token = resolveMemberToken(actor, target, deps)
        || loadSponsorKey(target.hub, target.home, { server: target.server, lead: actor, sw });
      if (token) {
        for (const p of normalized) {
          await sw.claimFileNote({
            server: target.server,
            hub: target.hub,
            channel: target.channel,
            filePath: p,
            content: `FROZEN by ${actor}: ${reason}`,
            token,
            memberId: actor,
            memberName: actor,
          }).catch(() => null);
        }
        const announced = await sw.postChannelNote({
          server: target.server,
          hub: target.hub,
          channel: target.channel,
          content: `total freeze on ${normalized.join(', ')} (${reason}). stop modifying these modules.`,
          kind: 'status',
          token,
          memberId: actor,
          memberName: actor,
        }).catch(() => null);
        hubNotified = Boolean(announced && announced.ok);
      }
    }
  }

  return {
    ok: true,
    exitCode: 0,
    action: 'freeze',
    dry_run: Boolean(options.dryRun),
    hub_notified: hubNotified,
    frozen: next,
  };
}

// Always load swarm-frozen.json from `root` (even when inspecting an isolated
// worktree `targetDir` whose untracked `.atris/state/` is empty).
function checkFrozenModules(root, targetDir = root) {
  const current = loadFrozenState(root);
  const paths = Array.isArray(current.paths) ? current.paths : [];
  if (!paths.length) {
    return { ok: true, exitCode: 0, action: 'check', paths: [], changed: [] };
  }
  const top = checkoutTop(targetDir || root);
  const byCommit = new Map();
  const entryMap = new Map((current.entries || []).map((e) => [e.path, e]));
  for (const p of paths) {
    const entry = entryMap.get(p);
    const commit = (entry && entry.base_commit) || current.base_commit || '';
    if (!commit) continue;
    const list = byCommit.get(commit) || [];
    list.push(p);
    byCommit.set(commit, list);
  }
  if (!top || byCommit.size === 0) {
    return { ok: true, exitCode: 0, action: 'check', paths, changed: [], note: 'no git base commit recorded' };
  }
  const changed = new Set();
  for (const [baseCommit, groupPaths] of byCommit.entries()) {
    const res = changedProtected(top, { paths: groupPaths, base_commit: baseCommit });
    if (res.error) return { ok: false, exitCode: 1, action: 'check', paths, changed: [...changed], error: res.error };
    for (const item of res.changed || []) changed.add(item);
  }
  const changedList = [...changed];
  return {
    ok: changedList.length === 0,
    exitCode: changedList.length === 0 ? 0 : 1,
    action: 'check',
    paths,
    changed: changedList,
  };
}

function runVerifyCommandAsync(cmd, cwd, timeoutMs = 10 * 60 * 1000) {
  const nodeDir = path.dirname(process.execPath);
  const curPath = String(process.env.PATH || '');
  const nextPath = curPath.split(path.delimiter).includes(nodeDir)
    ? curPath
    : (curPath ? `${nodeDir}${path.delimiter}${curPath}` : nodeDir);
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let finished = false;
    let timer = null;
    const done = (result) => {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };
    let child;
    try {
      child = spawn(String(cmd), [], {
        shell: true,
        cwd,
        env: { ...process.env, PATH: nextPath },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      return done({ ok: false, status: 1, output: error.message || String(error) });
    }
    child.stdout.on('data', (d) => { stdout += d.toString('utf8'); if (stdout.length > 65536) stdout = stdout.slice(-65536); });
    child.stderr.on('data', (d) => { stderr += d.toString('utf8'); if (stderr.length > 65536) stderr = stderr.slice(-65536); });
    child.on('error', (err) => done({ ok: false, status: 1, output: err.message || String(err) }));
    child.on('close', (code) => done({
      ok: code === 0,
      status: code == null ? 1 : code,
      output: `${stdout}\n${stderr}`.trim().slice(-400),
    }));
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        try { child.kill('SIGTERM'); } catch {}
        setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 1500).unref();
        done({ ok: false, status: 124, output: `verify timed out after ${Math.round(timeoutMs / 1000)}s` });
      }, timeoutMs);
      timer.unref();
    }
  });
}

async function watchSwarm(root, options = {}, deps = {}) {
  const sw = deps.swarlo || swarlo;
  const active = loadSwarmState(root);
  const target = resolveHubTarget(root, {
    server: options.server || (active && active.server),
    hub: options.hub || (active && active.hub),
    channel: options.channel || (active && active.channel),
    home: options.home,
  });
  const staleMinutes = Math.max(1, Number(options.staleMinutes) || 10);
  const autoExpire = Boolean(options.expire);
  const frozenCheck = checkFrozenModules(root);
  const campaigns = activeCampaignSummary(root);
  const health = await sw.hubHealth(target.server);

  let hubSnapshot = null;
  if (health && health.ok) {
    const actor = (active && active.lead) || DEFAULT_LEAD;
    const token = resolveMemberToken(actor, target, deps)
      || loadSponsorKey(target.hub, target.home, { server: target.server, lead: actor, sw });
    if (token) {
      hubSnapshot = await sw.fetchHubSnapshot({
        server: target.server,
        hub: target.hub,
        token,
        staleMinutes,
        autoExpire,
      });
    }
  }

  const alerts = [];
  if (!frozenCheck.ok) {
    if (frozenCheck.changed && frozenCheck.changed.length) {
      alerts.push(`frozen modules modified: ${frozenCheck.changed.join(', ')}`);
    } else {
      alerts.push(`frozen module check failed: ${frozenCheck.error || 'unable to verify frozen baseline'}`);
    }
  }
  const liveness = hubSnapshot && hubSnapshot.liveness ? hubSnapshot.liveness : null;
  if (liveness) {
    if (Array.isArray(liveness.dying) && liveness.dying.length) {
      alerts.push(`dying workers (${liveness.dying.length}): ${liveness.dying.map((d) => d.member_id).join(', ')}`);
    }
    if (Array.isArray(liveness.orphaned_claims) && liveness.orphaned_claims.length) {
      alerts.push(`orphaned claims (${liveness.orphaned_claims.length}): ${liveness.orphaned_claims.map((c) => c.task_key).join(', ')}`);
    }
  }
  const unclaimedCount = hubSnapshot && hubSnapshot.unclaimed
    ? (Array.isArray(hubSnapshot.unclaimed.tasks) ? hubSnapshot.unclaimed.tasks.length : Number(hubSnapshot.unclaimed.count || 0))
    : 0;
  const idleList = hubSnapshot && hubSnapshot.idle && Array.isArray(hubSnapshot.idle.idle)
    ? hubSnapshot.idle.idle
    : [];
  if (unclaimedCount > 0 && idleList.length > 0) {
    alerts.push(`${idleList.length} idle worker(s) while ${unclaimedCount} unclaimed task(s) wait`);
  }

  let reallocated = false;
  if (options.reallocate && hubSnapshot && health && health.ok) {
    const expired = Array.isArray(liveness && liveness.expired_on_sweep) ? liveness.expired_on_sweep : [];
    const unclaimedKeys = hubSnapshot.unclaimed && Array.isArray(hubSnapshot.unclaimed.tasks)
      ? hubSnapshot.unclaimed.tasks.map((t) => t.task_key).filter(Boolean).slice(0, 6)
      : [];
    const idleIds = idleList.map((i) => i.member_id || i.member_name).filter(Boolean).slice(0, 6);
    if (expired.length || (unclaimedKeys.length && idleIds.length)) {
      const actor = (active && active.lead) || DEFAULT_LEAD;
      const token = resolveMemberToken(actor, target, deps)
        || loadSponsorKey(target.hub, target.home, { server: target.server, lead: actor, sw });
      if (token) {
        const parts = [];
        if (expired.length) parts.push(`re-opened expired claim(s): ${expired.join(', ')}`);
        if (unclaimedKeys.length) parts.push(`unclaimed ready queue: ${unclaimedKeys.join(', ')}`);
        if (idleIds.length) parts.push(`idle workers can pull now: ${idleIds.join(', ')}`);
        const post = await sw.postChannelNote({
          server: target.server,
          hub: target.hub,
          channel: target.channel,
          content: `reallocation check: ${parts.join(' | ')}`,
          kind: 'status',
          token,
          memberId: actor,
          memberName: actor,
        }).catch(() => null);
        reallocated = Boolean(post && post.ok);
      }
    }
  }

  return {
    ok: alerts.length === 0,
    exitCode: frozenCheck.ok ? 0 : 1,
    checked_at: new Date().toISOString(),
    stale_minutes: staleMinutes,
    reallocated,
    swarm: active,
    campaigns,
    frozen: frozenCheck,
    hub: {
      server: target.server,
      hub: target.hub,
      reachable: Boolean(health && health.ok),
      liveness,
      idle: hubSnapshot ? hubSnapshot.idle : null,
      claims: hubSnapshot ? hubSnapshot.claims : null,
      unclaimed: hubSnapshot ? hubSnapshot.unclaimed : null,
    },
    alerts,
  };
}

// Lead decomposes an objective into dependency-linked Swarlo tasks (SQL DAG).
async function planSwarmTasks(root, options = {}, deps = {}) {
  const sw = deps.swarlo || swarlo;
  const active = loadSwarmState(root);
  const target = resolveHubTarget(root, {
    server: options.server || (active && active.server),
    hub: options.hub || (active && active.hub),
    channel: options.channel || (active && active.channel),
    home: options.home,
  });
  const actor = String(options.as || (active && active.lead) || DEFAULT_LEAD).trim().toLowerCase();
  const items = Array.isArray(options.tasks) ? options.tasks : [];
  if (!items.length) {
    return { ok: false, exitCode: 2, error: 'usage: atris swarm plan <task_key> "<content>" [--depends-on a,b] [--to <worker>] [--priority N] [--as <lead>] | --tasks <json> | --file <path>' };
  }

  const token = resolveMemberToken(actor, target, deps)
    || loadSponsorKey(target.hub, target.home, { server: target.server, lead: actor, sw });
  if (!token) {
    return { ok: false, exitCode: 2, error: `no saved Swarlo identity for ${actor} on ${target.hub}. start the swarm first: atris swarm start "<objective>"` };
  }

  const results = [];
  for (const item of items) {
    const taskKey = String(item.task_key || item.key || '').trim();
    const content = String(item.content || item.title || '').trim();
    if (!taskKey || !content) {
      results.push({ task_key: taskKey, ok: false, error: 'task_key and content are required' });
      continue;
    }
    const dependsOn = Array.isArray(item.depends_on)
      ? item.depends_on.map((d) => String(d).trim()).filter(Boolean)
      : [];
    const metadata = item.to ? { to: String(item.to).trim().toLowerCase() } : undefined;
    const res = await sw.postTaskNote({
      server: target.server,
      hub: target.hub,
      channel: target.channel,
      taskKey,
      content,
      dependsOn,
      priority: Number(item.priority) || 0,
      metadata,
      token,
      memberId: actor,
    });
    results.push({
      task_key: taskKey,
      ok: res.ok,
      status: res.status,
      depends_on: dependsOn,
      priority: Number(item.priority) || 0,
      post_id: res.data && res.data.post_id ? res.data.post_id : null,
      error: res.ok ? null : (res.data && (res.data.detail || res.data.error) ? String(res.data.detail || res.data.error) : `HTTP ${res.status}`),
    });
  }

  const planned = results.filter((r) => r.ok).length;
  const failed = results.length - planned;
  return {
    ok: failed === 0,
    exitCode: failed === 0 ? 0 : (planned > 0 ? 1 : 2),
    planned,
    failed,
    channel: target.channel,
    tasks: results,
  };
}

// Worker atomically pulls the highest-priority unblocked task from Swarlo SQL.
async function pullSwarmTask(root, options = {}, deps = {}) {
  const sw = deps.swarlo || swarlo;
  const active = loadSwarmState(root);
  const target = resolveHubTarget(root, {
    server: options.server || (active && active.server),
    hub: options.hub || (active && active.hub),
    channel: options.channel || (active && active.channel),
    home: options.home,
  });
  const member = String(options.as || '').trim().toLowerCase();
  if (!member) {
    return { ok: false, exitCode: 2, claimed: false, error: 'usage: atris swarm pull --as <worker> [--channel general]' };
  }
  const token = resolveMemberToken(member, target, deps);
  if (!token) {
    return { ok: false, exitCode: 2, claimed: false, error: `no saved Swarlo identity for ${member} on ${target.hub}` };
  }

  const queue = await sw.fetchPullQueue({
    server: target.server,
    hub: target.hub,
    channel: target.channel,
    memberId: member,
    token,
  });
  if (!queue.ok) {
    return { ok: false, exitCode: 2, claimed: false, error: `cannot reach Swarlo hub at ${target.server}` };
  }

  const metaByKey = new Map();
  for (const post of queue.posts) {
    if (!post || !post.task_key || post.kind !== 'message') continue;
    if (!metaByKey.has(post.task_key)) {
      metaByKey.set(post.task_key, {
        task_key: post.task_key,
        content: post.content || '',
        depends_on: Array.isArray(post.depends_on) ? post.depends_on : [],
        priority: Number(post.priority) || 0,
        to: post.metadata && post.metadata.to ? String(post.metadata.to).toLowerCase() : '',
        created_at: String(post.created_at || ''),
        channel: post.channel || target.channel,
      });
    }
  }

  const candidates = [];
  const seen = new Set();
  for (const r of queue.ready) {
    if (!r || !r.task_key || seen.has(r.task_key)) continue;
    seen.add(r.task_key);
    candidates.push({
      task_key: r.task_key,
      content: r.content || '',
      depends_on: Array.isArray(r.depends_on) ? r.depends_on : [],
      priority: (Number(r.priority) || 0) + 100,
      to: member,
      created_at: String(r.created_at || ''),
      channel: r.channel || target.channel,
    });
  }

  const unclaimedOrdered = queue.unclaimed
    .map((u) => {
      const meta = metaByKey.get(u.task_key) || {};
      return {
        task_key: u.task_key,
        content: u.content || meta.content || '',
        depends_on: Array.isArray(meta.depends_on) ? meta.depends_on : [],
        priority: Number(meta.priority) || 0,
        to: meta.to || '',
        created_at: String(u.created_at || meta.created_at || ''),
        channel: u.channel || target.channel,
      };
    })
    .filter((item) => !item.to || item.to === member)
    .sort((a, b) => {
      const aDirect = a.to === member ? 1 : 0;
      const bDirect = b.to === member ? 1 : 0;
      if (bDirect !== aDirect) return bDirect - aDirect;
      if (b.priority !== a.priority) return b.priority - a.priority;
      return a.created_at.localeCompare(b.created_at);
    });

  for (const item of unclaimedOrdered) {
    if (seen.has(item.task_key)) continue;
    seen.add(item.task_key);
    candidates.push(item);
  }

  const blocked = [];
  let conflicts = 0;
  for (const item of candidates) {
    const res = await sw.claimTaskNote({
      server: target.server,
      hub: target.hub,
      channel: item.channel,
      taskKey: item.task_key,
      content: `Claiming ${item.task_key}: ${item.content.slice(0, 120)}`,
      dependsOn: item.depends_on,
      token,
      memberId: member,
    });
    if (res.ok) {
      return {
        ok: true,
        exitCode: 0,
        claimed: true,
        member,
        task: item,
        claim: res.data,
        conflicts,
        blocked,
      };
    }
    if (res.conflict) {
      conflicts += 1;
      continue;
    }
    blocked.push({
      task_key: item.task_key,
      status: res.status,
      reason: res.data && (res.data.detail || res.data.message || res.data.error)
        ? String(res.data.detail || res.data.message || res.data.error)
        : `HTTP ${res.status}`,
    });
  }

  return {
    ok: true,
    exitCode: 1,
    claimed: false,
    member,
    task: null,
    conflicts,
    blocked,
  };
}

// Worker reports done/failed/blocked with frozen-module guard, bare verify gate,
// optional idempotency key, and optional --next zero-poll auto-claim.
async function reportSwarmTask(root, options = {}, deps = {}) {
  const sw = deps.swarlo || swarlo;
  const active = loadSwarmState(root);
  const target = resolveHubTarget(root, {
    server: options.server || (active && active.server),
    hub: options.hub || (active && active.hub),
    channel: options.channel || (active && active.channel),
    home: options.home,
  });
  const taskKey = String(options.taskKey || '').trim();
  const status = String(options.status || 'done').trim().toLowerCase();
  const member = String(options.as || '').trim().toLowerCase();
  const content = String(options.content || `${status}: ${taskKey}`).trim();
  if (!taskKey || !member || !['done', 'failed', 'blocked'].includes(status)) {
    return { ok: false, exitCode: 2, error: 'usage: atris swarm report <task_key> <done|failed|blocked> "<summary>" --as <worker> [--verify "<cmd>"] [--next] [--idempotency-key <key>]' };
  }

  if (status === 'done') {
    const checkDirs = [root];
    if (options.verifyCwd && path.resolve(options.verifyCwd) !== path.resolve(root)) {
      checkDirs.push(options.verifyCwd);
    }
    for (const dir of checkDirs) {
      const frozenCheck = checkFrozenModules(root, dir);
      if (!frozenCheck.ok) {
        const changed = Array.isArray(frozenCheck.changed) ? frozenCheck.changed : [];
        return {
          ok: false,
          exitCode: 1,
          blocked_by: 'frozen_modules',
          changed,
          error: changed.length
            ? `refused to report done: frozen module(s) modified (${changed.join(', ')})`
            : `refused to report done: frozen module check failed (${frozenCheck.error || 'unknown error'})`,
        };
      }
    }
    if (options.verify) {
      const run = await runVerifyCommandAsync(options.verify, options.verifyCwd || root, 10 * 60 * 1000);
      if (!run.ok) {
        return {
          ok: false,
          exitCode: 1,
          blocked_by: 'verify_failed',
          verify_exit: run.status,
          verify_output: run.output,
          error: `verify command failed (exit ${run.status}): ${options.verify}`,
        };
      }
    }
  }

  const token = resolveMemberToken(member, target, deps);
  if (!token) {
    return { ok: false, exitCode: 2, error: `no saved Swarlo identity for ${member} on ${target.hub}` };
  }

  const rep = await sw.reportTaskNote({
    server: target.server,
    hub: target.hub,
    channel: target.channel,
    taskKey,
    status,
    content,
    includeNext: Boolean(options.next),
    idempotencyKey: options.idempotencyKey || '',
    token,
    memberId: member,
  });
  if (!rep.ok) {
    const detail = rep.data && (rep.data.detail || rep.data.error || rep.data.message)
      ? String(rep.data.detail || rep.data.error || rep.data.message)
      : `HTTP ${rep.status}`;
    return { ok: false, exitCode: 1, status: rep.status, error: `report failed: ${detail}` };
  }

  let nextTask = rep.data && rep.data.next_task ? rep.data.next_task : null;
  if (options.next && !nextTask) {
    const pulled = await pullSwarmTask(root, {
      as: member,
      channel: target.channel,
      hub: target.hub,
      server: target.server,
      home: target.home,
    }, deps);
    if (pulled.claimed) nextTask = pulled.task;
  }

  return {
    ok: true,
    exitCode: 0,
    task_key: taskKey,
    status,
    member,
    report: rep.data,
    next_task: nextTask,
  };
}

async function downSwarm(root, options = {}, deps = {}) {
  const sw = deps.swarlo || swarlo;
  const active = loadSwarmState(root);
  if (!active) {
    return { ok: true, exitCode: 0, stopped: [], note: 'no active swarm' };
  }
  const target = resolveHubTarget(root, {
    server: options.server || active.server,
    hub: options.hub || active.hub,
    channel: options.channel || active.channel,
    home: options.home,
  });
  const requested = Array.isArray(options.members) && options.members.length
    ? new Set(options.members.map((m) => String(m).trim().toLowerCase()))
    : null;
  const allMembers = (active.members || []).map((m) => m.member);
  const toStop = requested ? allMembers.filter((m) => requested.has(m)) : allMembers;
  const health = await sw.hubHealth(target.server);
  const launched = sw.loadLaunched(target.home);
  let launchedDirty = false;

  for (const name of toStop) {
    if (health && health.ok) {
      const token = resolveMemberToken(name, target, deps);
      if (token) {
        await sw.postChannelNote({
          server: target.server,
          hub: target.hub,
          channel: target.channel,
          content: `${name} left swarm`,
          kind: 'status',
          token,
          memberId: name,
          memberName: name,
        }).catch(() => null);
      }
    }
    if (launched[target.hub] && launched[target.hub][name]) {
      delete launched[target.hub][name];
      if (!Object.keys(launched[target.hub]).length) delete launched[target.hub];
      launchedDirty = true;
    }
  }
  if (launchedDirty) sw.saveLaunched(launched, target.home);

  const remainingMembers = (active.members || []).filter((m) => !toStop.includes(m.member));
  if (!remainingMembers.length) {
    try { fs.unlinkSync(swarmStatePath(root)); } catch { /* ignore */ }
  } else {
    writeJsonAtomic(swarmStatePath(root), {
      ...active,
      workers: (active.workers || []).filter((w) => !toStop.includes(w)),
      members: remainingMembers,
      updated_at: new Date().toISOString(),
    });
  }

  return { ok: true, exitCode: 0, stopped: toStop, remaining: remainingMembers.length };
}

module.exports = {
  startSwarm,
  expandSwarm,
  freezeModules,
  watchSwarm,
  downSwarm,
  planSwarmTasks,
  pullSwarmTask,
  reportSwarmTask,
  loadSwarmState,
  updateSwarmState,
  loadFrozenState,
  planWorkerSeats,
  buildLeadBrief,
};
