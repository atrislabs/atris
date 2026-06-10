'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { buildLatestCheck, buildPacket, collectFreshness } = require('./zero-shot');

const ZERO_SHOT_LATEST_RELATIVE_PATH = '.atris/state/zero-shot.latest.json';
const ZERO_SHOT_PROMPT_RELATIVE_PATH = '.atris/state/zero-shot.prompt.txt';
const ZERO_SHOT_MENU_RELATIVE_PATH = '.atris/state/zero-shot.menu.txt';
const ZERO_SHOT_HORIZONS = ['now', 'immediate_review', 'long_term', 'blocked', 'orient'];
const ZERO_SHOT_MODELS = ['fast', 'pro', 'validator', 'human'];

function safeJson(text, fallback = null) {
  try { return JSON.parse(text); } catch { return fallback; }
}

function readJsonLines(file, readFile = fs.readFileSync, exists = fs.existsSync) {
  if (!exists(file)) return [];
  return String(readFile(file, 'utf8'))
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => safeJson(line))
    .filter(Boolean);
}

function truncate(value, width) {
  const text = String(value == null || value === '' ? '-' : value);
  if (text.length <= width) return text.padEnd(width, ' ');
  return `${text.slice(0, Math.max(0, width - 1))}…`;
}

function repoLabel(cwd) {
  if (!cwd) return '-';
  const parts = cwd.split(/[\\/]/).filter(Boolean);
  if (parts.length >= 2) return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
  return parts[0] || cwd;
}

function parsePsOutput(text) {
  const rows = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(/\s+/);
    if (parts.length < 10) continue;
    const [pid, ppid, cpu, mem, stat] = parts;
    const start = parts.slice(5, 10).join(' ');
    const command = parts.slice(10).join(' ');
    rows.push({ pid, ppid, cpu: Number(cpu) || 0, mem: Number(mem) || 0, stat, start, command });
  }
  return rows;
}

function agentTypeForCommand(command) {
  const cmd = String(command || '');
  if (/ctop|grep|node\s+.*atris\.js\s+radar/.test(cmd)) return null;
  if (/(^|\s|\/)codex(\s|$)|codex-darwin|codex-linux|codex-win/.test(cmd)) return 'codex';
  if (/(^|\s|\/)claude(\s|$)/.test(cmd) && !/Claude\.app/.test(cmd)) return 'claude';
  if (/(^|\s|\/)opencode(\s|$)/.test(cmd)) return 'opencode';
  if (/(^|\s|\/)devin(\s|$)/.test(cmd)) return 'devin';
  return null;
}

function processCwd(pid, deps) {
  const { platform, execFile } = deps;
  try {
    if (platform === 'linux') {
      return deps.readlink(`/proc/${pid}/cwd`);
    }
    if (platform === 'darwin') {
      const out = execFile('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
      const line = String(out).split(/\r?\n/).find(value => value.startsWith('n'));
      return line ? line.slice(1) : '';
    }
  } catch {}
  return '';
}

function gitBranch(cwd, execFile) {
  if (!cwd) return '';
  try {
    return String(execFile('git', ['-C', cwd, 'branch', '--show-current'], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] })).trim();
  } catch {
    return '';
  }
}

function collectAgents(deps) {
  let ps = '';
  try {
    ps = deps.execFile('ps', ['-eo', 'pid=,ppid=,pcpu=,pmem=,stat=,lstart=,command='], { encoding: 'utf8' });
  } catch {
    return [];
  }
  const agentRows = parsePsOutput(ps)
    .map(row => ({ ...row, agent: agentTypeForCommand(row.command) }))
    .filter(row => row.agent);
  const parentPids = new Set(agentRows.map(row => String(row.ppid || '')).filter(Boolean));
  return agentRows
    .filter(row => !parentPids.has(String(row.pid)))
    .map(row => {
      const cwd = processCwd(row.pid, deps);
      return {
        pid: row.pid,
        agent: row.agent,
        status: row.stat.includes('Z') ? 'zombie' : row.stat.includes('T') ? 'stopped' : 'active',
        cwd,
        repo: repoLabel(cwd),
        branch: gitBranch(cwd, deps.execFile),
        cpu: row.cpu,
        mem: row.mem,
      };
    });
}

function loadTasks(root, deps) {
  const file = path.join(root, '.atris', 'state', 'tasks.projection.json');
  if (!deps.exists(file)) return [];
  const payload = safeJson(deps.readFile(file, 'utf8'), {});
  const tasks = Array.isArray(payload.tasks) ? payload.tasks : [];
  return tasks.map(task => ({
    id: task.id,
    display_id: task.display_id,
    legacy_ref: task.legacy_ref,
    title: task.title,
    status: task.status,
    tag: task.tag,
    workspace_root: task.workspace_root,
    claimed_by: task.claimed_by,
    assigned_to: task.metadata?.assigned_to || task.assigned_to || null,
    metadata: task.metadata || {},
    messages: Array.isArray(task.messages) ? task.messages : [],
  }));
}

function findTaskWorkspaceRoot(cwd, deps) {
  if (!cwd) return null;
  let current = path.resolve(cwd);
  for (let depth = 0; depth < 8; depth += 1) {
    if (deps.exists(path.join(current, '.atris', 'state', 'tasks.projection.json'))) return current;
    const parent = path.dirname(current);
    if (!parent || parent === current) break;
    current = parent;
  }
  return null;
}

function loadTasksCached(root, deps, cache) {
  if (!root) return [];
  if (!cache.has(root)) cache.set(root, loadTasks(root, deps));
  return cache.get(root);
}

function untaskedReason(agent, taskWorkspaceRoot, tasks) {
  if (!agent.cwd) return 'cwd unknown';
  if (!taskWorkspaceRoot) return 'no task projection';
  if (!tasks.length) return 'empty task projection';
  return 'no active task';
}

function shellQuote(value) {
  return `'${String(value || '').replace(/'/g, "'\\''")}'`;
}

function untaskedAction(agent, taskWorkspaceRoot, tasks) {
  const reason = untaskedReason(agent, taskWorkspaceRoot, tasks);
  const pid = agent.pid || '?';
  const actor = agent.agent || 'agent';
  if (reason === 'cwd unknown') return `inspect pid ${pid} cwd with lsof`;
  if (reason === 'no active task') return `cd ${shellQuote(taskWorkspaceRoot)} && atris task next --as ${actor}`;
  if (reason === 'empty task projection') return `cd ${shellQuote(taskWorkspaceRoot)} && atris task new "<small concrete title>" --tag ops`;
  return `inspect ${agent.cwd || 'unknown cwd'} for missing Atris task plane or close pid ${pid} only with operator approval if idle`;
}

function readJsonFile(file, deps, fallback = null) {
  if (!deps.exists(file)) return fallback;
  return safeJson(deps.readFile(file, 'utf8'), fallback);
}

function countJsonLines(file, deps) {
  return readJsonLines(file, deps.readFile, deps.exists).length;
}

function loadMissions(root, deps, nowMs) {
  const file = path.join(root, '.atris', 'state', 'missions.jsonl');
  const byId = new Map();
  for (const mission of readJsonLines(file, deps.readFile, deps.exists)) {
    if (mission && mission.id) byId.set(mission.id, mission);
  }
  return [...byId.values()].map(mission => {
    const lastTick = mission.last_tick_at ? Date.parse(mission.last_tick_at) : 0;
    const stale = mission.status === 'running' && (!mission.verifier || !lastTick || nowMs - lastTick > 3 * 24 * 60 * 60 * 1000);
    return { ...mission, stale };
  });
}

function parseWorktrees(text) {
  const out = [];
  let current = {};
  for (const raw of `${text || ''}\n`.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) {
      if (current.worktree) {
        out.push({
          path: current.worktree,
          branch: String(current.branch || 'detached').replace(/^refs\/heads\//, ''),
          head: current.HEAD || '',
        });
      }
      current = {};
      continue;
    }
    const idx = line.indexOf(' ');
    if (idx === -1) current[line] = true;
    else current[line.slice(0, idx)] = line.slice(idx + 1);
  }
  return out;
}

function dirtyCount(worktreePath, execFile) {
  try {
    const out = String(execFile('git', ['-C', worktreePath, 'status', '--porcelain'], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }));
    return out.split(/\r?\n/).filter(Boolean).length;
  } catch {
    return null;
  }
}

function loadWorktrees(root, deps) {
  let raw = '';
  try {
    raw = deps.execFile('git', ['-C', root, 'worktree', 'list', '--porcelain'], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
  } catch {
    return [];
  }
  return parseWorktrees(raw).map(wt => ({ ...wt, dirty: dirtyCount(wt.path, deps.execFile) }));
}

function loadXp(root, deps) {
  const projection = readJsonFile(path.join(root, '.atris', 'state', 'career_xp.projection.json'), deps, {});
  return {
    metric: projection.metric_label || 'AgentXP',
    total: Number(projection.total_agent_xp ?? projection.agent_xp ?? projection.total_xp ?? 0) || 0,
    today: Number(projection.today_agent_xp ?? projection.today_xp ?? 0) || 0,
    level: Number(projection.level ?? projection.career?.level ?? 0) || 0,
    integrity: projection.integrity_status || 'unknown',
    leaderboard_eligible: Boolean(projection.leaderboard_eligible),
    receipts: countJsonLines(path.join(root, '.atris', 'state', 'career_xp_receipts.jsonl'), deps),
    generated_at: projection.generated_at || null,
  };
}

function memberTitle(markdown, fallback) {
  const heading = String(markdown || '').split(/\r?\n/).find(line => /^#\s+/.test(line));
  return heading ? heading.replace(/^#\s+/, '').trim() : fallback;
}

function loadTeam(root, deps) {
  const teamDir = path.join(root, 'atris', 'team');
  if (!deps.exists(teamDir)) return { total: 0, active_goal_members: 0, members: [] };
  let names = [];
  try {
    names = deps.readdir(teamDir).filter(name => !name.startsWith('_'));
  } catch {
    return { total: 0, active_goal_members: 0, members: [] };
  }
  const members = [];
  for (const name of names) {
    const memberFile = path.join(teamDir, name, 'MEMBER.md');
    if (!deps.exists(memberFile)) continue;
    const goals = readJsonFile(path.join(teamDir, name, 'goals.json'), deps, { goals: [] }) || { goals: [] };
    const activeGoals = Array.isArray(goals.goals) ? goals.goals.filter(goal => goal.status === 'active') : [];
    const nowFile = path.join(teamDir, name, 'now.md');
    members.push({
      slug: name,
      title: memberTitle(deps.readFile(memberFile, 'utf8'), name),
      active_goals: activeGoals.length,
      current_goal: activeGoals[0]?.title || null,
      has_now: deps.exists(nowFile),
      updated_at: goals.updated_at || null,
    });
  }
  return {
    total: members.length,
    active_goal_members: members.filter(member => member.active_goals > 0).length,
    members,
  };
}

function loadBrain(root, deps) {
  const scorecards = readJsonLines(path.join(root, '.atris', 'state', 'scorecards.jsonl'), deps.readFile, deps.exists);
  const operatorDir = path.join(root, '.atris', 'state', 'operator-scorecards');
  let operatorScorecards = 0;
  try {
    if (deps.exists(operatorDir)) operatorScorecards = deps.readdir(operatorDir).filter(name => name.endsWith('.json')).length;
  } catch {}
  const latest = [...scorecards].reverse().find(row => row && (row.type === 'scorecard' || row.schema));
  return {
    scorecards: scorecards.length,
    operator_scorecards: operatorScorecards,
    latest_reward: latest?.reward ?? latest?.score ?? null,
    latest_next: latest?.next_task_suggestion || latest?.next || null,
  };
}

function listNames(dir, deps) {
  try {
    if (!deps.exists(dir)) return [];
    return deps.readdir(dir);
  } catch {
    return [];
  }
}

function countDirectoryEntries(dir, deps, predicate = () => true) {
  return listNames(dir, deps).filter(predicate).length;
}

function loadBusinessCollaboration(root, deps, team = {}) {
  const business = readJsonFile(path.join(root, '.atris', 'business.json'), deps, null);
  const runtime = readJsonFile(path.join(root, '.atris', 'state', 'runtime.json'), deps, null);
  const sync = readJsonFile(path.join(root, '.atris', 'state', '_sync.json'), deps, null);
  const cache = readJsonFile(path.join(deps.homeDir || os.homedir(), '.atris', 'businesses.json'), deps, {}) || {};
  const slug = business?.slug || sync?.workspace_slug || null;
  const cacheEntry = slug && cache ? cache[slug] : null;
  const hasAtris = deps.exists(path.join(root, 'atris'));
  const hasMap = deps.exists(path.join(root, 'atris', 'MAP.md'));
  const hasTodo = deps.exists(path.join(root, 'atris', 'TODO.md'));
  const hasPersona = deps.exists(path.join(root, 'atris', 'PERSONA.md'));
  const ingestPacks = countDirectoryEntries(path.join(root, 'atris', 'context', '_ingest'), deps, name => !name.startsWith('.'));
  const starterBriefs = countDirectoryEntries(path.join(root, 'atris', 'wiki', 'briefs'), deps, name => /starter-brief\.md$/i.test(name));
  const firstLoops = countDirectoryEntries(path.join(root, 'atris', 'wiki', 'concepts'), deps, name => /first-loop/i.test(name));
  const reports = countDirectoryEntries(path.join(root, 'atris', 'reports'), deps, name => /\.(md|json)$/i.test(name));
  const onePagers = countDirectoryEntries(path.join(root, 'atris', 'reports'), deps, name => /one-pager|cheat-sheet|onboarding/i.test(name));
  const localReceipts = countDirectoryEntries(path.join(root, '.atris', 'receipts'), deps, name => /\.(json|md|txt)$/i.test(name));
  const events = countJsonLines(path.join(root, '.atris', 'state', 'events.jsonl'), deps);
  const episodes = countJsonLines(path.join(root, '.atris', 'state', 'episodes.jsonl'), deps);
  const scorecards = countJsonLines(path.join(root, '.atris', 'state', 'scorecards.jsonl'), deps);
  const computerDirs = countDirectoryEntries(path.join(root, 'atris', 'computers'), deps, name => !name.startsWith('.'));
  const hasOnboarding = ingestPacks > 0 || starterBriefs > 0 || onePagers > 0;
  const hasProofLoop = events > 0 || episodes > 0 || scorecards > 0 || localReceipts > 0;
  const hasTeam = Number(team.total || 0) > 0;
  const missing = [];
  if (!business) missing.push('business binding');
  if (!hasAtris || !hasMap || !hasTodo || !hasPersona) missing.push('canonical atris scaffold');
  if (!runtime) missing.push('runtime receipt');
  if (!sync) missing.push('sync state');
  if (!hasTeam) missing.push('team members');
  if (!hasOnboarding) missing.push('onboarding intake/brief');
  if (firstLoops < 1) missing.push('first loop');
  if (!hasProofLoop) missing.push('proof/scorecard loop');
  return {
    bound: Boolean(business),
    slug,
    name: business?.name || cacheEntry?.name || slug || null,
    business_id: business?.business_id || cacheEntry?.business_id || null,
    workspace_id: business?.workspace_id || cacheEntry?.workspace_id || null,
    template: business?.workspace_template || sync?.workspace_template || 'unknown',
    cache_bound: Boolean(cacheEntry),
    scaffold: { atris: hasAtris, map: hasMap, todo: hasTodo, persona: hasPersona },
    runtime: runtime ? {
      scope: runtime.scope || null,
      install_status: runtime.install_status || null,
      sync_status: runtime.sync_status || null,
    } : null,
    onboarding: { packs: ingestPacks, starter_briefs: starterBriefs, first_loops: firstLoops, one_pagers: onePagers, reports },
    proof: { events, episodes, scorecards, receipts: localReceipts },
    computers: computerDirs,
    team_members: Number(team.total || 0),
    active_goal_members: Number(team.active_goal_members || 0),
    share_ready: missing.length === 0,
    missing,
    next_action: missing.length > 0 ? `add ${missing[0]}` : 'share workspace and start first proof loop',
  };
}

function loadSwarlo(tasks) {
  const handoffs = tasks
    .filter(task => task.metadata?.delegate_via || task.metadata?.swarlo_channel || task.assigned_to)
    .map(task => ({
      task: taskRef(task),
      status: task.status,
      assigned_to: task.assigned_to || task.metadata?.assigned_to || null,
      delegate_via: task.metadata?.delegate_via || null,
      swarlo_channel: task.metadata?.swarlo_channel || null,
    }));
  return {
    handoffs: handoffs.length,
    swarlo_leases: handoffs.filter(row => row.delegate_via === 'swarlo' || row.swarlo_channel).length,
    local_delegations: handoffs.filter(row => row.delegate_via && row.delegate_via !== 'swarlo').length,
    rows: handoffs,
  };
}

function loadLoop(missions, root, deps) {
  const events = readJsonLines(path.join(root, '.atris', 'state', 'mission_events.jsonl'), deps.readFile, deps.exists);
  const codexGoal = readJsonFile(path.join(root, '.atris', 'state', 'codex_goal.json'), deps, {}) || {};
  const tickEvents = events.filter(event => event.type === 'mission_tick');
  return {
    running: missions.filter(mission => mission.status === 'running').length,
    always_on: missions.filter(mission => mission.always_on).length,
    stale: missions.filter(mission => mission.stale).length,
    no_verifier: missions.filter(mission => mission.status === 'running' && !mission.verifier).length,
    ticks: tickEvents.length,
    last_event_at: events[events.length - 1]?.at || null,
    codex_goal: codexGoal.goal?.objective || null,
    codex_goal_mission: codexGoal.goal?.mission_id || null,
    infinite_loop_risk: missions.some(mission => mission.stale || (mission.status === 'running' && !mission.verifier)),
  };
}

function zeroShotRouteFromPacket(packet = null) {
  const decision = packet?.decision || {};
  const commands = packet?.commands || {};
  return {
    lane: decision.lane || null,
    selected_ref: decision.selected_ref || null,
    selected_title: decision.selected_title || null,
    model_tier: decision.model_tier || null,
    first_command: commands.first_command || decision.first_command || null,
    owner_action: decision.owner_action || null,
    safe_agent_action: decision.safe_agent_action || null,
  };
}

function normalizeZeroShotHorizons(counts = {}) {
  return Object.fromEntries(ZERO_SHOT_HORIZONS.map(key => [key, Number(counts[key] || 0)]));
}

function normalizeZeroShotModels(models = {}) {
  return Object.fromEntries(ZERO_SHOT_MODELS.map(key => {
    const value = models[key];
    return [key, Number(value && typeof value === 'object' ? value.count || 0 : value || 0)];
  }));
}

function zeroShotBucketsFromPacket(packet = null) {
  const routes = packet?.routes || {};
  return {
    horizon_counts: normalizeZeroShotHorizons(routes.horizons || {}),
    model_counts: normalizeZeroShotModels(routes.models || {}),
  };
}

function zeroShotBucketLine(zeroShot = {}) {
  const horizons = zeroShot.horizon_counts || normalizeZeroShotHorizons({});
  const models = zeroShot.model_counts || normalizeZeroShotModels({});
  return `0-shot buckets: horizons now=${horizons.now} review=${horizons.immediate_review} long=${horizons.long_term} blocked=${horizons.blocked}; models fast=${models.fast} pro=${models.pro} validator=${models.validator} human=${models.human}`;
}

function zeroShotFreshnessLabel(exists, fresh) {
  if (fresh) return 'fresh';
  if (exists) return 'stale';
  return 'missing';
}

function zeroShotGroupFreshnessLabel(fresh) {
  if (fresh === true) return 'fresh';
  if (fresh === false) return 'stale_or_missing';
  return 'unknown';
}

function zeroShotDurableLine(zeroShot = {}) {
  return [
    `prompt=${zeroShotFreshnessLabel(zeroShot.prompt_exists, zeroShot.prompt_fresh)}`,
    `menu=${zeroShotFreshnessLabel(zeroShot.menu_exists, zeroShot.menu_fresh)}`,
    `model=${zeroShotGroupFreshnessLabel(zeroShot.model_prompts_fresh)}`,
    `horizon=${zeroShotGroupFreshnessLabel(zeroShot.horizon_prompts_fresh)}`,
    `check: ${zeroShot.check_command || 'atris 0-shot --check'}`,
  ].join(' ');
}

function loadZeroShotCheck(root, options = {}) {
  if (typeof options.buildZeroShotCheck === 'function') return options.buildZeroShotCheck(root);
  if (options.existsSync || options.readFileSync) return null;
  return buildLatestCheck({ cwd: root });
}

function loadZeroShot(root, deps, options = {}) {
  const latest = readJsonFile(path.join(root, ZERO_SHOT_LATEST_RELATIVE_PATH), deps, null);
  const promptExists = deps.exists(path.join(root, ZERO_SHOT_PROMPT_RELATIVE_PATH));
  const menuExists = deps.exists(path.join(root, ZERO_SHOT_MENU_RELATIVE_PATH));
  const currentFreshness = collectFreshness(root, {
    existsSync: deps.exists,
    readFileSync: deps.readFile,
  });
  const latestFingerprint = latest?.freshness?.source_fingerprint || latest?.durable?.source_fingerprint || null;
  const currentFingerprint = currentFreshness.source_fingerprint;
  const latestExists = Boolean(latest);
  const fresh = Boolean(latestExists && promptExists && latestFingerprint && latestFingerprint === currentFingerprint);
  let currentPacket = null;
  try {
    currentPacket = typeof options.buildZeroShotPacket === 'function'
      ? options.buildZeroShotPacket(root)
      : buildPacket({ cwd: root });
  } catch {}
  let latestCheck = null;
  try {
    latestCheck = loadZeroShotCheck(root, options);
  } catch {}
  const currentRoute = zeroShotRouteFromPacket(currentPacket);
  const latestRoute = zeroShotRouteFromPacket(latest);
  const selectedPacket = currentPacket || latest;
  const selectedRoute = currentPacket ? currentRoute : latestRoute;
  const selectedBuckets = zeroShotBucketsFromPacket(currentPacket || latest);
  const status = latestCheck ? latestCheck.status : (fresh ? 'fresh' : (latestExists ? 'stale' : 'missing'));
  return {
    schema: 'atris.radar_zero_shot.v1',
    status,
    ok: latestCheck ? latestCheck.ok : fresh,
    latest_exists: latestCheck ? latestCheck.latest_exists : latestExists,
    prompt_exists: latestCheck ? latestCheck.prompt_exists : promptExists,
    prompt_fresh: latestCheck ? latestCheck.prompt_fresh : promptExists,
    menu_exists: latestCheck ? latestCheck.menu_exists : menuExists,
    menu_fresh: latestCheck ? latestCheck.menu_fresh : (menuExists ? null : false),
    model_prompts_fresh: latestCheck ? latestCheck.model_prompts_fresh : null,
    horizon_prompts_fresh: latestCheck ? latestCheck.horizon_prompts_fresh : null,
    route_source: currentPacket ? 'current' : 'latest',
    lane: selectedRoute.lane,
    selected_ref: selectedRoute.selected_ref,
    selected_title: selectedRoute.selected_title,
    model_tier: selectedRoute.model_tier,
    first_command: selectedRoute.first_command,
    owner_action: selectedRoute.owner_action,
    safe_agent_action: selectedRoute.safe_agent_action,
    menu_command: selectedPacket?.commands?.zero_shot_all || 'atris 0-shot --all',
    horizon_counts: selectedBuckets.horizon_counts,
    model_counts: selectedBuckets.model_counts,
    current: currentPacket ? currentRoute : null,
    latest: latest ? latestRoute : null,
    latest_json: ZERO_SHOT_LATEST_RELATIVE_PATH,
    prompt_txt: ZERO_SHOT_PROMPT_RELATIVE_PATH,
    menu_txt: ZERO_SHOT_MENU_RELATIVE_PATH,
    check_command: 'atris 0-shot --check',
    refresh_command: 'atris 0-shot --write',
    prompt_command: 'atris 0-shot --prompt',
    legacy_check_command: 'atris zero-shot --check',
    legacy_refresh_command: 'atris zero-shot --write',
    legacy_prompt_command: 'atris zero-shot --prompt',
    latest_source_fingerprint: latestCheck ? latestCheck.latest_source_fingerprint : latestFingerprint,
    current_source_fingerprint: latestCheck ? latestCheck.current_source_fingerprint : currentFingerprint,
  };
}

function taskRef(task) {
  return task ? (task.display_id || task.legacy_ref || task.id || '-') : '-';
}

function taskOwnerMatchesAgent(task, agent) {
  const actor = String(agent?.agent || '').toLowerCase();
  if (!actor) return false;
  return [
    task.assigned_to,
    task.claimed_by,
    task.metadata?.assigned_to,
    task.metadata?.claimed_by,
    task.metadata?.owner,
  ]
    .filter(Boolean)
    .some(owner => String(owner).toLowerCase() === actor);
}

function taskForCwd(tasks, cwd, workspaceRoot = cwd, agent = null) {
  if (!cwd && !workspaceRoot) return null;
  const matchesWorkspace = task => !task.workspace_root || task.workspace_root === cwd || task.workspace_root === workspaceRoot;
  const candidates = tasks.filter(matchesWorkspace);
  const firstByStatus = status => {
    const statusMatches = candidates.filter(task => task.status === status);
    return statusMatches.find(task => taskOwnerMatchesAgent(task, agent)) || statusMatches[0] || null;
  };
  return firstByStatus('claimed')
    || firstByStatus('open')
    || firstByStatus('review')
    || null;
}

function taskBindingForProjection(task) {
  if (!task) return { task_source: null, task_scope: null };
  return {
    task_source: 'repo_task_projection',
    task_scope: 'repo',
  };
}

function taskSourceLabel(sources = []) {
  if (sources.includes('repo_task_projection')) return 'repo projection; verify ownership';
  return sources.filter(Boolean).join(', ');
}

function ownerForTask(task) {
  if (!task) return '-';
  return task.assigned_to || task.claimed_by || task.metadata?.assigned_to || '-';
}

function taskSessionReason(task) {
  if (!task) return null;
  if (task.status === 'review') return task.metadata?.agent_certified ? 'certified review' : 'review task';
  if (ownerActionRequired(task)) return 'owner action required';
  return null;
}

function taskSessionAction(agent, task, taskWorkspaceRoot) {
  if (!task) return null;
  const ref = taskRef(task);
  const pid = agent?.pid || '?';
  const actor = agent?.agent || 'agent';
  const reviewCommand = taskWorkspaceRoot
    ? `cd ${shellQuote(taskWorkspaceRoot)} && atris task reviews --limit 5`
    : 'atris task reviews --limit 5';
  if (task.status === 'review') {
    if (task.metadata?.agent_certified) {
      return `handoff complete for ${ref}; claim fresh work as ${actor} or close pid ${pid} only with operator approval`;
    }
    return `review or hand off ${ref}: ${reviewCommand}`;
  }
  if (ownerActionRequired(task)) return `owner-gated ${ref}; wait for owner action, do not start duplicate work; close pid ${pid} only with operator approval`;
  return null;
}

function ownerActionRequired(task) {
  const metadata = task?.metadata || {};
  if (metadata.owner_action_required === true || metadata.agent_executable === false) return true;
  if (String(metadata.agent_executable || '').toLowerCase() === 'false') return true;
  const recentMessages = Array.isArray(task?.messages)
    ? task.messages.slice(-8).map(message => message?.content || message?.payload?.content || '')
    : [];
  const text = [
    task?.title,
    task?.tag,
    metadata.status,
    metadata.blocker,
    metadata.human_revision_note,
    metadata.latest_agent_proof,
    metadata.latest_agent_lesson,
    task?.routing_text,
    ...recentMessages,
  ].filter(Boolean).join(' ').toLowerCase();
  if (text.includes('owner_action_required') || text.includes('agent_executable=false')) return true;
  if (text.includes('owner-only') || text.includes('owner only') || text.includes('not agent-executable')) return true;
  const productionGateEligible = !['radar', 'task-plane', 'review'].includes(String(task?.tag || '').toLowerCase());
  if (productionGateEligible && (text.includes('human/production gated') || text.includes('production execution proof is still missing'))) return true;
  if (productionGateEligible && text.includes('remaining blocker') && text.includes('deploy receipt') && text.includes('live canary')) return true;
  if (productionGateEligible && text.includes('human approval required') && (text.includes('production deploy') || text.includes('feedback mutation'))) return true;
  return text.includes('owner') && text.includes('billing') && (text.includes('spending limit') || text.includes('failed payments'));
}

function summarize(tasks, missions, worktrees, agents) {
  const count = (rows, pred) => rows.filter(pred).length;
  return {
    agents: { total: agents.length, active: count(agents, a => a.status === 'active'), stopped: count(agents, a => a.status !== 'active') },
    tasks: {
      open: count(tasks, t => t.status === 'open'),
      claimed: count(tasks, t => t.status === 'claimed'),
      review: count(tasks, t => t.status === 'review'),
      certifiedReview: count(tasks, t => t.status === 'review' && t.metadata && t.metadata.agent_certified),
    },
    missions: { running: count(missions, m => m.status === 'running'), stale: count(missions, m => m.stale) },
    worktrees: { total: worktrees.length, dirty: count(worktrees, w => Number(w.dirty) > 0) },
  };
}

function nextAction(tasks, missions, worktrees, agents, os = {}) {
  const activeTasks = tasks.filter(t => t.status === 'claimed' || t.status === 'open');
  const activeTask = activeTasks.find(t => !ownerActionRequired(t));
  if (activeTask) return `work ${taskRef(activeTask)}: ${activeTask.title || 'active task'}`;
  const ownerTask = activeTasks.find(ownerActionRequired);
  if (ownerTask) return `owner action required ${taskRef(ownerTask)}: ${ownerTask.title || 'owner-only task'}`;
  const needsReview = tasks.find(t => t.status === 'review' && !(t.metadata && t.metadata.agent_certified));
  if (needsReview) return `review ${taskRef(needsReview)}: ${needsReview.title || 'uncertified review task'}`;
  const certified = tasks.find(t => t.status === 'review' && t.metadata && t.metadata.agent_certified);
  if (certified) return `human accept/revise ${taskRef(certified)} or clear certified review queue`;
  const stale = missions.find(m => m.stale);
  if (stale) return `close or repair stale mission ${stale.id}`;
  if (os.xp && os.xp.integrity !== 'verified') return `repair ${os.xp.metric || 'AgentXP'} integrity`;
  const dirty = worktrees.find(w => Number(w.dirty) > 0);
  if (dirty) return `inspect dirty worktree ${dirty.path}`;
  if (agents.some(a => !a.task || a.task === '-')) return 'map untasked live agents to tasks or shut down idle sessions';
  return 'no obvious action';
}

function collectRadar(options = {}) {
  const root = options.root || process.cwd();
  const deps = {
    execFile: options.execFileSync || execFileSync,
    readFile: options.readFileSync || fs.readFileSync,
    exists: options.existsSync || fs.existsSync,
    readlink: options.readlinkSync || fs.readlinkSync,
    readdir: options.readdirSync || fs.readdirSync,
    platform: options.platform || os.platform(),
    homeDir: options.homeDir || os.homedir(),
  };
  const nowMs = options.nowMs || Date.now();
  const tasks = loadTasks(root, deps);
  const taskCache = new Map([[root, tasks]]);
  const missions = loadMissions(root, deps, nowMs);
  const worktrees = loadWorktrees(root, deps);
  const agents = collectAgents(deps).map(agent => {
    const taskWorkspaceRoot = findTaskWorkspaceRoot(agent.cwd, deps);
    const agentTasks = taskWorkspaceRoot ? loadTasksCached(taskWorkspaceRoot, deps, taskCache) : [];
    const task = taskForCwd(agentTasks, agent.cwd, taskWorkspaceRoot, agent);
    const taskReason = task ? taskSessionReason(task) : untaskedReason(agent, taskWorkspaceRoot, agentTasks);
    const taskBinding = taskBindingForProjection(task);
    return {
      ...agent,
      task: taskRef(task),
      task_status: task?.status || null,
      owner: ownerForTask(task),
      task_workspace: taskWorkspaceRoot ? repoLabel(taskWorkspaceRoot) : null,
      ...taskBinding,
      task_reason: taskReason,
      task_action: task ? taskSessionAction(agent, task, taskWorkspaceRoot) : untaskedAction(agent, taskWorkspaceRoot, agentTasks),
    };
  });
  const osState = {
    xp: loadXp(root, deps),
    team: loadTeam(root, deps),
    brain: loadBrain(root, deps),
    swarlo: loadSwarlo(tasks),
    loop: loadLoop(missions, root, deps),
  };
  osState.zero_shot = loadZeroShot(root, deps, options);
  osState.business = loadBusinessCollaboration(root, deps, osState.team);
  return { root, generated_at: new Date(nowMs).toISOString(), summary: summarize(tasks, missions, worktrees, agents), os: osState, next_action: nextAction(tasks, missions, worktrees, agents, osState), agents, tasks, missions, worktrees };
}

function renderRadar(data) {
  const lines = [];
  const s = data.summary;
  lines.push('Operator radar');
  lines.push('');
  lines.push(`Agents: ${s.agents.active}/${s.agents.total} active`);
  lines.push(`Tasks: ${s.tasks.open} open, ${s.tasks.claimed} claimed, ${s.tasks.review} review (${s.tasks.certifiedReview} certified)`);
  lines.push(`Missions: ${s.missions.running} running, ${s.missions.stale} stale/no-verifier`);
  lines.push(`Worktrees: ${s.worktrees.total} registered, ${s.worktrees.dirty} dirty`);
  lines.push(`Next: ${data.next_action}`);
  if (data.os?.zero_shot) {
    const zs = data.os.zero_shot;
    const focus = [zs.lane, zs.selected_ref].filter(Boolean).join(' ') || 'none';
    lines.push(`0-shot: ${zs.status} ${focus} -> ${zs.first_command || zs.refresh_command}`);
    lines.push(`0-shot menu: ${zs.menu_command || 'atris 0-shot --all'}`);
    if (zs.owner_action) lines.push(`0-shot owner action: ${zs.owner_action}`);
    if (zs.safe_agent_action) lines.push(`0-shot agent-safe action: ${zs.safe_agent_action}`);
    lines.push(`0-shot durable: ${zeroShotDurableLine(zs)}`);
    lines.push(zeroShotBucketLine(zs));
  }
  if (data.os) {
    const xp = data.os.xp || {};
    const team = data.os.team || {};
    const brain = data.os.brain || {};
    const swarlo = data.os.swarlo || {};
    const loop = data.os.loop || {};
    const business = data.os.business || {};
    const bizLabel = business.bound ? `${business.slug || business.name || 'bound'} ${business.share_ready ? 'share-ready' : 'not-ready'}` : 'no-binding';
    lines.push(`OS: ${xp.metric || 'AgentXP'} ${xp.total || 0} L${xp.level || 0} (${xp.integrity || 'unknown'}), team ${team.total || 0}/${team.active_goal_members || 0} active-goal, business ${bizLabel}, loop ${loop.stale || 0} stale, Swarlo ${swarlo.swarlo_leases || 0} leases/${swarlo.handoffs || 0} handoffs, brain ${brain.scorecards || 0}+${brain.operator_scorecards || 0} scorecards`);
  }
  lines.push('');
  lines.push(`${truncate('PID', 7)} ${truncate('AGENT', 8)} ${truncate('REPO', 24)} ${truncate('BRANCH', 16)} ${truncate('TASK', 10)} ${truncate('OWNER', 14)} ${truncate('STATE', 8)}`);
  for (const agent of data.agents.slice(0, 24)) {
    lines.push(`${truncate(agent.pid, 7)} ${truncate(agent.agent, 8)} ${truncate(agent.repo, 24)} ${truncate(agent.branch, 16)} ${truncate(agent.task, 10)} ${truncate(agent.owner, 14)} ${truncate(agent.status, 8)}`);
  }
  if (data.agents.length > 24) lines.push(`... ${data.agents.length - 24} more agents`);
  const stale = data.missions.filter(m => m.stale).slice(0, 3);
  if (stale.length) {
    lines.push('');
    lines.push('Stale mission candidates:');
    for (const mission of stale) lines.push(`- ${mission.id}: ${mission.next_action || mission.objective || 'review'}`);
  }
  const review = data.tasks.filter(t => t.status === 'review').slice(0, 5);
  if (review.length) {
    lines.push('');
    lines.push('Review queue:');
    for (const task of review) {
      const passes = task.metadata?.agent_review_pass_count || 0;
      const cert = task.metadata?.agent_certified ? 'certified' : `${passes} pass${passes === 1 ? '' : 'es'}`;
      lines.push(`- ${taskRef(task)} ${cert}: ${task.title || 'untitled'}`);
    }
  }
  const dirty = data.worktrees.filter(w => Number(w.dirty) > 0).slice(0, 5);
  if (dirty.length) {
    lines.push('');
    lines.push('Dirty worktrees:');
    for (const worktree of dirty) lines.push(`- ${worktree.dirty} files: ${worktree.path}`);
  }
  if (data.os) {
    const members = data.os.team?.members?.filter(member => member.active_goals > 0).slice(0, 5) || [];
    if (members.length) {
      lines.push('');
      lines.push('Team goals:');
      for (const member of members) lines.push(`- ${member.slug}: ${member.current_goal || `${member.active_goals} active goals`}`);
    }
    const swarloRows = data.os.swarlo?.rows?.slice(0, 5) || [];
    if (swarloRows.length) {
      lines.push('');
      lines.push('Delegation/Swarlo:');
      for (const row of swarloRows) lines.push(`- ${row.task} ${row.delegate_via || 'assigned'} -> ${row.assigned_to || row.swarlo_channel || 'unassigned'}`);
    }
    const xp = data.os.xp || {};
    lines.push('');
    if (data.os.business) {
      const business = data.os.business;
      lines.push(`Business: ${business.bound ? `${business.name || business.slug} (${business.slug || 'no-slug'})` : 'no local business binding'}`);
      if (business.bound) {
        lines.push(`Business ready: ${business.share_ready ? 'yes' : 'no'}; team ${business.team_members || 0}/${business.active_goal_members || 0} active-goal; onboarding ${business.onboarding?.packs || 0} packs/${business.onboarding?.starter_briefs || 0} briefs/${business.onboarding?.first_loops || 0} loops; proof ${business.proof?.scorecards || 0} scorecards/${business.proof?.events || 0} events; computers ${business.computers || 0}`);
        if (!business.share_ready) lines.push(`Business next: ${business.next_action}`);
      } else {
        lines.push('Business next: run `atris business init <name>` or `atris pull <slug>` before sharing work.');
      }
    }
    lines.push(`${xp.metric || 'AgentXP'}: ${xp.total || 0} total, ${xp.today || 0} today, ${xp.receipts || 0} receipts, integrity ${xp.integrity || 'unknown'}`);
    if (data.os.loop?.codex_goal) {
      lines.push(`Codex goal: ${data.os.loop.codex_goal}`);
    }
  }
  return lines.join('\n');
}

function number(value) {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

function sortedAgents(agents = []) {
  return [...agents].sort((a, b) => {
    if (a.status !== b.status) return a.status === 'active' ? -1 : 1;
    const cpuDelta = number(b.cpu) - number(a.cpu);
    if (cpuDelta) return cpuDelta;
    return String(a.repo || '').localeCompare(String(b.repo || ''));
  });
}

function executableAgentLanes(agents = []) {
  return sortedAgents(agents).filter(agent => {
    if (agent.status !== 'active') return false;
    if (!agent.task || agent.task === '-') return false;
    if (!['claimed', 'open'].includes(agent.task_status)) return false;
    return !agent.task_reason;
  });
}

function formatExecutableLane(agent) {
  const repo = agent.repo || agent.cwd || 'unknown repo';
  const actor = agent.agent || 'agent';
  return `continue ${agent.task} in ${repo} as ${actor}`;
}

function certifiedReviewLanes(agents = []) {
  return sortedAgents(agents).filter(agent => {
    if (agent.status !== 'active') return false;
    if (!agent.task || agent.task === '-') return false;
    if (agent.task_status !== 'review') return false;
    return agent.task_reason === 'certified review';
  });
}

function formatReviewCheckpoint(agent) {
  const repo = agent.repo || agent.cwd || 'unknown repo';
  return `accept/revise ${agent.task} in ${repo}`;
}

function agentProcessNextAction(agents = [], fallback = 'no obvious process action') {
  const stopped = agents.filter(agent => agent.status !== 'active').length;
  if (stopped > 0) return `inspect ${stopped} stopped agent session${stopped === 1 ? '' : 's'}`;
  const ownerGated = agents.filter(agent => agent.task_reason === 'owner action required');
  if (ownerGated.length > 0) {
    const tasks = [...new Set(ownerGated.map(agent => agent.task).filter(Boolean))].slice(0, 3).join(', ');
    const projectionBound = ownerGated.some(agent => agent.task_source === 'repo_task_projection');
    const executable = executableAgentLanes(agents)[0];
    const reviewCheckpoint = executable ? null : certifiedReviewLanes(agents)[0];
    const ownerGateAction = executable
      ? `wait for owner action; executable lane: ${formatExecutableLane(executable)}; avoid duplicate work, close only with operator approval`
      : reviewCheckpoint
        ? `wait for owner action; review checkpoint: ${formatReviewCheckpoint(reviewCheckpoint)}; avoid duplicate work, close only with operator approval`
      : 'wait for owner action, avoid duplicate work, close only with operator approval';
    if (projectionBound) {
      return `owner-gated repo projection covers ${ownerGated.length} session${ownerGated.length === 1 ? '' : 's'}${tasks ? ` on ${tasks}` : ''}; verify ownership, ${ownerGateAction}`;
    }
    return `owner gate blocks ${ownerGated.length} session${ownerGated.length === 1 ? '' : 's'}${tasks ? ` on ${tasks}` : ''}; ${ownerGateAction}`;
  }
  const taskLoad = summarizeTaskLoad(agents);
  const activePileup = taskLoad.find(row => row.sessions > 1 && !row.status.split(/,\s*/).includes('review'));
  if (activePileup) {
    const source = taskSourceLabel(activePileup.task_sources);
    const sourceHint = source ? `; ${source}` : '';
    return `inspect ${activePileup.sessions} sessions on ${activePileup.task} (${activePileup.cpu.toFixed(1)}% CPU${sourceHint})`;
  }
  const reviewBound = taskLoad.find(row => row.status.split(/,\s*/).includes('review'));
  if (reviewBound) {
    const source = taskSourceLabel(reviewBound.task_sources);
    const sourceHint = source ? `; ${source}` : '';
    return `close or hand off ${reviewBound.sessions} session${reviewBound.sessions === 1 ? '' : 's'} still bound to review task ${reviewBound.task}${sourceHint}`;
  }
  const pileup = taskLoad.find(row => row.sessions > 1);
  if (pileup) {
    const source = taskSourceLabel(pileup.task_sources);
    const sourceHint = source ? `; ${source}` : '';
    return `inspect ${pileup.sessions} sessions on ${pileup.task} (${pileup.cpu.toFixed(1)}% CPU${sourceHint})`;
  }
  const untasked = agents.filter(agent => !agent.task || agent.task === '-').length;
  if (untasked > 0) {
    const reasons = summarizeUntaskedReasons(agents);
    const summary = reasons.map(row => `${row.count} ${row.reason}`).join(', ');
    return `resolve ${untasked} untasked session${untasked === 1 ? '' : 's'}${summary ? `: ${summary}` : ''}`;
  }
  const hot = agents.find(agent => number(agent.cpu) >= 50);
  if (hot) return `inspect high-CPU ${hot.agent} ${hot.pid} in ${hot.repo || hot.cwd || 'unknown repo'}`;
  return fallback;
}

function summarizeUntaskedReasons(agents = []) {
  const counts = new Map();
  for (const agent of agents) {
    if (agent.task && agent.task !== '-') continue;
    const reason = agent.task_reason || 'unmapped';
    counts.set(reason, (counts.get(reason) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
}

function summarizeTaskLoad(agents = []) {
  const byTask = new Map();
  for (const agent of agents) {
    if (!agent.task || agent.task === '-') continue;
    if (!byTask.has(agent.task)) {
      byTask.set(agent.task, {
        task: agent.task,
        sessions: 0,
        active: 0,
        cpu: 0,
        mem: 0,
        statuses: new Set(),
        owners: new Set(),
        repos: new Set(),
        task_sources: new Set(),
        task_scopes: new Set(),
        pids: [],
      });
    }
    const row = byTask.get(agent.task);
    row.sessions += 1;
    if (agent.status === 'active') row.active += 1;
    row.cpu += number(agent.cpu);
    row.mem += number(agent.mem);
    if (agent.task_status) row.statuses.add(agent.task_status);
    if (agent.owner && agent.owner !== '-') row.owners.add(agent.owner);
    if (agent.repo) row.repos.add(agent.repo);
    if (agent.task_source) row.task_sources.add(agent.task_source);
    if (agent.task_scope) row.task_scopes.add(agent.task_scope);
    if (agent.pid) row.pids.push(agent.pid);
  }
  return [...byTask.values()]
    .map(row => {
      const statuses = [...row.statuses].sort();
      return {
        task: row.task,
        sessions: row.sessions,
        active: row.active,
        cpu: Number(row.cpu.toFixed(1)),
        mem: Number(row.mem.toFixed(1)),
        status: statuses.join(', ') || '-',
        owners: [...row.owners].sort(),
        repos: [...row.repos].sort(),
        task_sources: [...row.task_sources].sort(),
        task_scopes: [...row.task_scopes].sort(),
        pids: row.pids.sort((a, b) => number(a) - number(b)),
        attention: row.sessions > 1 || statuses.includes('review'),
      };
    })
    .sort((a, b) => Number(b.attention) - Number(a.attention) || b.sessions - a.sessions || b.cpu - a.cpu || a.task.localeCompare(b.task));
}

function agentTopPayload(data) {
  const agents = sortedAgents(data.agents || []);
  const untasked = agents.filter(agent => !agent.task || agent.task === '-').length;
  const cpu = agents.reduce((sum, agent) => sum + number(agent.cpu), 0);
  const mem = agents.reduce((sum, agent) => sum + number(agent.mem), 0);
  const taskLoad = summarizeTaskLoad(agents);
  return {
    root: data.root,
    generated_at: data.generated_at,
    summary: {
      total: agents.length,
      active: agents.filter(agent => agent.status === 'active').length,
      untasked,
      untasked_reasons: summarizeUntaskedReasons(agents),
      task_pileups: taskLoad.filter(row => row.sessions > 1).length,
      review_bound_tasks: taskLoad.filter(row => row.status === 'review').length,
      cpu: Number(cpu.toFixed(1)),
      mem: Number(mem.toFixed(1)),
    },
    next_action: agentProcessNextAction(agents, data.next_action),
    task_load: taskLoad,
    agents,
  };
}

function representativeAgentsByTask(agents = [], limit = 8) {
  const selected = [];
  const selectedRows = new Set();
  const seenTasks = new Set();
  for (const agent of agents) {
    const task = agent.task || '-';
    if (seenTasks.has(task)) continue;
    seenTasks.add(task);
    selected.push(agent);
    selectedRows.add(agent);
    if (selected.length >= limit) return selected;
  }
  for (const agent of agents) {
    if (selected.length >= limit) break;
    if (selectedRows.has(agent)) continue;
    selected.push(agent);
  }
  return selected;
}

function renderAgentTop(data) {
  const payload = agentTopPayload(data);
  const lines = [];
  lines.push('Agent process top');
  lines.push('');
  lines.push(`Agents: ${payload.summary.active}/${payload.summary.total} active; ${payload.summary.untasked} untasked; CPU ${payload.summary.cpu.toFixed(1)}%; MEM ${payload.summary.mem.toFixed(1)}%`);
  lines.push(`Next: ${payload.next_action}`);
  if (payload.agents.some(agent => agent.task_source === 'repo_task_projection')) {
    lines.push('Task binding: repo projection; verify ownership before assuming every session owns the displayed task.');
  }
  lines.push('');
  lines.push(`${truncate('PID', 7)} ${truncate('AGENT', 8)} ${truncate('CPU', 6)} ${truncate('MEM', 6)} ${truncate('REPO', 24)} ${truncate('BRANCH', 16)} ${truncate('TASK', 10)} ${truncate('STATE', 8)}`);
  for (const agent of payload.agents.slice(0, 32)) {
    lines.push(`${truncate(agent.pid, 7)} ${truncate(agent.agent, 8)} ${truncate(`${number(agent.cpu).toFixed(1)}%`, 6)} ${truncate(`${number(agent.mem).toFixed(1)}%`, 6)} ${truncate(agent.repo, 24)} ${truncate(agent.branch, 16)} ${truncate(agent.task, 10)} ${truncate(agent.status, 8)}`);
  }
  if (payload.agents.length > 32) lines.push(`... ${payload.agents.length - 32} more agents`);
  if (payload.summary.untasked > 0) {
    lines.push('');
    const reasonText = payload.summary.untasked_reasons.map(row => `${row.count} ${row.reason}`).join(', ');
    lines.push(`Untasked: ${payload.summary.untasked} sessions (${reasonText}).`);
    for (const agent of payload.agents.filter(row => !row.task || row.task === '-').slice(0, 8)) {
      lines.push(`- ${agent.pid} ${agent.repo || agent.cwd || '-'}: ${agent.task_reason || 'unmapped'} -> ${agent.task_action || 'inspect session'}`);
    }
  }
  const ownerGatedAll = payload.agents.filter(row => row.task_reason === 'owner action required');
  const ownerGatedAgents = representativeAgentsByTask(ownerGatedAll, 8);
  if (ownerGatedAgents.length) {
    lines.push('');
    const shown = ownerGatedAll.length > ownerGatedAgents.length ? `; showing ${ownerGatedAgents.length}` : '';
    const projectionBound = ownerGatedAll.some(agent => agent.task_source === 'repo_task_projection');
    const label = projectionBound ? 'Owner-gated projection' : 'Owner-gated';
    const actionText = projectionBound ? 'verify ownership and wait on human/owner action' : 'waiting on human/owner action';
    lines.push(`${label}: ${ownerGatedAll.length} session${ownerGatedAll.length === 1 ? '' : 's'} ${actionText}${shown}; do not start duplicate work.`);
    for (const agent of ownerGatedAgents) {
      lines.push(`- ${agent.pid} ${agent.repo || agent.cwd || '-'} ${agent.task}: ${agent.task_action || 'wait for owner action'}`);
    }
  }
  const reviewAll = payload.agents.filter(row => row.task_reason === 'certified review' || row.task_reason === 'review task');
  const reviewAgents = reviewAll.slice(0, 8);
  if (reviewAgents.length) {
    lines.push('');
    const shown = reviewAll.length > reviewAgents.length ? `; showing ${reviewAgents.length}` : '';
    lines.push(`Review-bound: ${reviewAll.length} session${reviewAll.length === 1 ? '' : 's'} should hand off or claim fresh work${shown}.`);
    for (const agent of reviewAgents) {
      lines.push(`- ${agent.pid} ${agent.repo || agent.cwd || '-'} ${agent.task}: ${agent.task_reason || 'review'} -> ${agent.task_action || 'close or hand off session'}`);
    }
  }
  const taskLoadRows = payload.task_load.filter(row => row.attention).slice(0, 8);
  if (taskLoadRows.length) {
    lines.push('');
    lines.push(`Task load: ${payload.summary.task_pileups} pileup${payload.summary.task_pileups === 1 ? '' : 's'}, ${payload.summary.review_bound_tasks} review-bound task${payload.summary.review_bound_tasks === 1 ? '' : 's'}.`);
    for (const row of taskLoadRows) {
      const repoText = row.repos.slice(0, 3).join(', ') || '-';
      const source = taskSourceLabel(row.task_sources);
      const sourceText = source ? `, ${source}` : '';
      lines.push(`- ${row.task}: ${row.sessions} sessions, ${row.cpu.toFixed(1)}% CPU, ${row.status}, ${repoText}${sourceText}`);
    }
  }
  return lines.join('\n');
}

function radarCommand(args = [], options = {}) {
  if (args.includes('--help') || args.includes('-h') || args[0] === 'help') {
    console.log('Usage: atris radar [--json] [--agents]');
    console.log('Usage: atris radar agents');
    console.log('Usage: atris ctop');
    console.log('');
    console.log('Shows live agent processes joined with Atris tasks, missions, worktrees, and the current 0-shot route.');
    console.log('Use --agents or ctop for a process-first CPU/memory view.');
    return 0;
  }
  const data = collectRadar(options);
  const agentsOnly = args.includes('--agents') || args[0] === 'agents';
  if (args.includes('--json')) console.log(JSON.stringify(agentsOnly ? agentTopPayload(data) : data, null, 2));
  else if (agentsOnly) console.log(renderAgentTop(data));
  else console.log(renderRadar(data));
  return 0;
}

module.exports = {
  agentTypeForCommand,
  agentTopPayload,
  collectRadar,
  parsePsOutput,
  parseWorktrees,
  radarCommand,
  renderAgentTop,
  renderRadar,
};
