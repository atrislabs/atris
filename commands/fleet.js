/**
 * Atris Fleet: Manage the agent swarm via Swarlo
 *
 * Commands:
 *   atris fleet                  : Show fleet status
 *   atris fleet status           : Same as above
 *   atris fleet post <message>   : Post to the board
 *   atris fleet task <prompt>    : Post a task for agents to claim
 *   atris fleet claim <task_key> : Claim a task
 *   atris fleet done <task_key>  : Report task complete
 *   atris fleet members          : List members
 *   atris fleet prune            : Remove stale members
 *   atris fleet join             : Register this session
 *   atris fleet up <member>...   : Activate team members on the hub
 *   atris fleet down <member>... : Deactivate launched members
 *   atris fleet launched         : List activated members (alias: roster)
 *   atris fleet watch            : Nudge launched members when work waits
 *   atris fleet tail [sec]       : Live-tail the board
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { parseScopeFlag } = require('../lib/cli-scope');

// ── Config ──────────────────────────────────────────────

const DEFAULT_HUB_URL = 'http://localhost:8090';
const DEFAULT_HUB_ID = 'atris';

function loadConfig() {
  const paths = [
    path.join(os.homedir(), '.swarlo', 'config.json'),
    path.join(process.cwd(), '.swarlo', 'config.json'),
  ];
  for (const p of paths) {
    try {
      const raw = fs.readFileSync(p, 'utf8');
      return JSON.parse(raw);
    } catch {}
  }
  return {};
}

function getHubUrl() {
  const cfg = loadConfig();
  return cfg.server || process.env.SWARLO_SERVER || DEFAULT_HUB_URL;
}

function getHubId() {
  const cfg = loadConfig();
  return cfg.hub || process.env.SWARLO_HUB || DEFAULT_HUB_ID;
}

// ── HTTP helpers ────────────────────────────────────────

function request(method, urlStr, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const mod = url.protocol === 'https:' ? https : http;
    const opts = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
    };
    const req = mod.request(opts, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, data: data });
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// ── State file for API key persistence ──────────────────

const STATE_FILE = path.join(os.homedir(), '.swarlo', 'fleet-state.json');

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveState(state) {
  const dir = path.dirname(STATE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ── Auto-register ───────────────────────────────────────

async function ensureRegistered({ preserveIdentity = false } = {}) {
  const state = loadState();
  const hubUrl = getHubUrl();
  const hubId = getHubId();

  // Check if hub is up
  try {
    await request('GET', `${hubUrl}/api/health`);
  } catch {
    console.error('✗ Swarlo hub not running at', hubUrl);
    console.error('  Start it: swarlo serve --port 8090');
    process.exit(1);
  }

  // A keyed retry is scoped to the original member. Creating a replacement
  // member for a saved key would turn the retry into another operation.
  if (preserveIdentity && state.api_key && (state.hub_id !== hubId || (state.hub_url && state.hub_url !== hubUrl))) {
    throw new Error('the saved Fleet identity belongs to a different hub');
  }
  // Re-use existing key if valid
  if (state.api_key && state.hub_id === hubId) {
    try {
      const check = await request('GET', `${hubUrl}/api/${hubId}/members`, null, {
        Authorization: `Bearer ${state.api_key}`,
      });
      if (check.status === 200) return state;
    } catch (error) {
      if (preserveIdentity) throw error;
    }
    if (preserveIdentity) throw new Error('could not confirm the original Fleet identity for this retry');
  }

  // Register fresh
  const memberId = `cli-${os.hostname().split('.')[0]}-${process.pid}`;
  const memberName = `CLI (${os.userInfo().username})`;
  const res = await request('POST', `${hubUrl}/api/register`, {
    hub_id: hubId,
    member_id: memberId,
    member_name: memberName,
    member_type: 'agent',
  });

  if (res.status >= 300) {
    console.error('✗ Failed to register:', res.data);
    process.exit(1);
  }

  const newState = {
    api_key: res.data.api_key,
    hub_id: hubId,
    member_id: res.data.member_id,
    hub_url: hubUrl,
  };
  saveState(newState);
  return newState;
}

function authHeaders(state) {
  return { Authorization: `Bearer ${state.api_key}` };
}

// ── Commands ────────────────────────────────────────────

async function fleetStatus(state) {
  const hubUrl = getHubUrl();
  const hubId = getHubId();
  const h = authHeaders(state);

  const [members, posts, claims] = await Promise.all([
    request('GET', `${hubUrl}/api/${hubId}/members`, null, h),
    request('GET', `${hubUrl}/api/${hubId}/channels/general/posts?limit=5`, null, h),
    request('GET', `${hubUrl}/api/${hubId}/claims`, null, h),
  ]);

  const m = members.data;
  const p = posts.data;
  const c = claims.data;

  console.log(`\n  ⚡ Swarlo Fleet`);
  console.log(`  ─────────────────────────────────`);
  console.log(`  Hub:     ${hubId} (${hubUrl})`);
  console.log(`  You:     ${state.member_id}`);
  console.log(`  Members: ${m.count || 0}`);
  if (m.members) {
    for (const mem of m.members) {
      const seen = mem.last_seen ? ` (seen ${mem.last_seen.slice(0, 16)})` : '';
      console.log(`    ${mem.member_type === 'human' ? '👤' : '🤖'} ${mem.member_name}${seen}`);
    }
  }
  console.log(`  Claims:  ${c.count || 0} open`);
  if (c.claims) {
    for (const cl of c.claims) {
      console.log(`    [${cl.status}] ${cl.task_key || 'no-key'}: ${(cl.content || '').slice(0, 60)}`);
    }
  }
  console.log(`  Recent:  ${p.posts?.length || 0} posts`);
  if (p.posts) {
    for (const post of p.posts.slice(0, 3)) {
      console.log(`    [${post.member_name}] ${(post.content || '').slice(0, 60)}`);
    }
  }
  console.log();
}

async function fleetPost(state, message) {
  const hubUrl = getHubUrl();
  const hubId = getHubId();
  const res = await request('POST', `${hubUrl}/api/${hubId}/channels/general/posts`, {
    content: message,
    kind: 'message',
  }, authHeaders(state));
  if (res.status < 300) {
    console.log('✓ Posted to general');
  } else {
    console.error('✗ Failed:', res.data);
  }
}

async function fleetTask(state, prompt) {
  const hubUrl = getHubUrl();
  const hubId = getHubId();
  const taskKey = `task:${prompt.slice(0, 40).replace(/[^a-z0-9]/gi, '-').toLowerCase()}`;
  const res = await request('POST', `${hubUrl}/api/${hubId}/channels/general/posts`, {
    content: prompt,
    kind: 'message',
    task_key: taskKey,
  }, authHeaders(state));
  if (res.status < 300) {
    console.log(`✓ Task posted: ${taskKey}`);
  } else {
    console.error('✗ Failed:', res.data);
  }
}

async function fleetClaim(state, taskKey) {
  const hubUrl = getHubUrl();
  const hubId = getHubId();
  const res = await request('POST', `${hubUrl}/api/${hubId}/channels/general/posts`, {
    content: `Claiming: ${taskKey}`,
    kind: 'claim',
    task_key: taskKey,
  }, authHeaders(state));
  if (res.status < 300) {
    console.log(`✓ Claimed: ${taskKey}`);
  } else {
    console.error('✗ Failed:', res.data);
  }
}

async function fleetDone(state, taskKey, result = '', operationKey = null, json = false) {
  const hubUrl = getHubUrl();
  const hubId = getHubId();
  const content = result || `Done: ${taskKey}`;
  const channel = `${hubUrl}/api/${encodeURIComponent(hubId)}/channels/general`;
  const route = operationKey ? 'report/once' : 'posts';
  const payload = operationKey
    ? { task_key: taskKey, status: 'done', content, idempotency_key: operationKey }
    : { content, kind: 'result', task_key: taskKey };
  const res = await request('POST', `${channel}/${route}`, payload, authHeaders(state));
  if (res.status >= 300) {
    console.error('could not record the result:', res.data);
    process.exitCode = 1;
    return;
  }
  if (operationKey && !res.data?.post_id) {
    console.error('the hub did not confirm the result. retry with the same key.');
    process.exitCode = 1;
    return;
  }
  if (json) console.log(JSON.stringify(res.data));
  else console.log(`✓ Reported done: ${taskKey}`);
}

async function fleetMembers(state) {
  const hubUrl = getHubUrl();
  const hubId = getHubId();
  const res = await request('GET', `${hubUrl}/api/${hubId}/members`, null, authHeaders(state));
  if (res.data?.members) {
    console.log(`\n  Members (${res.data.count}):`);
    for (const m of res.data.members) {
      const seen = m.last_seen ? m.last_seen.slice(0, 16) : 'never';
      console.log(`    ${m.member_type === 'human' ? '👤' : '🤖'} ${m.member_name} (${m.member_id}), seen: ${seen}`);
    }
    console.log();
  }
}

async function fleetPrune(state, minutes = 60) {
  const hubUrl = getHubUrl();
  const hubId = getHubId();
  const res = await request('POST', `${hubUrl}/api/${hubId}/prune`, {
    stale_minutes: minutes,
  }, authHeaders(state));
  if (res.data?.pruned) {
    console.log(`✓ Pruned ${res.data.count} stale members: ${res.data.pruned.join(', ') || 'none'}`);
  } else {
    console.log('✓ No stale members to prune');
  }
}

async function fleetTail(state, intervalSec = 10) {
  const hubUrl = getHubUrl();
  const hubId = getHubId();
  const h = authHeaders(state);
  let lastPostId = null;

  console.log(`\n  ⚡ Watching Swarlo board (every ${intervalSec}s, Ctrl+C to stop)\n`);

  const poll = async () => {
    try {
      const res = await request('GET', `${hubUrl}/api/${hubId}/channels/general/posts?limit=5`, null, h);
      const posts = res.data?.posts || [];

      if (posts.length > 0 && posts[0].post_id !== lastPostId) {
        // Show new posts (reverse to show oldest first)
        const newPosts = lastPostId
          ? posts.filter(p => {
              // Show posts newer than last seen
              return !lastPostId || new Date(p.created_at) > new Date(posts.find(x => x.post_id === lastPostId)?.created_at || 0);
            }).reverse()
          : [posts[0]]; // First poll, just show latest

        for (const p of newPosts) {
          const time = new Date(p.created_at).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
          const kind = p.kind !== 'message' ? ` [${p.kind}]` : '';
          console.log(`  ${time} ${p.member_name}${kind}: ${(p.content || '').slice(0, 100)}`);
        }
        lastPostId = posts[0].post_id;
      }
    } catch {}
  };

  await poll();
  const interval = setInterval(poll, intervalSec * 1000);

  // Keep alive until Ctrl+C
  await new Promise((resolve) => {
    process.on('SIGINT', () => {
      clearInterval(interval);
      console.log('\n  Stopped watching.\n');
      resolve();
    });
  });
}

async function fleetWorkspaceStatus(root = process.cwd(), { json = false } = {}) {
  const teamDir = path.join(root, 'atris', 'team');
  const members = [];
  if (fs.existsSync(teamDir)) {
    for (const name of fs.readdirSync(teamDir).filter((n) => !n.startsWith('_') && !n.startsWith('.'))) {
      const memberFile = path.join(teamDir, name, 'MEMBER.md');
      if (!fs.existsSync(memberFile)) continue;
      members.push({ member_id: name, member_name: name, member_type: 'agent', source: 'workspace' });
    }
  }
  const missionsPath = path.join(root, '.atris', 'state', 'missions.jsonl');
  let activeMissions = 0;
  if (fs.existsSync(missionsPath)) {
    const seen = new Map();
    for (const line of fs.readFileSync(missionsPath, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line);
        const id = rec.id || rec.mission_id;
        if (id) seen.set(id, rec);
      } catch {}
    }
    activeMissions = [...seen.values()].filter((m) => ['ready', 'running', 'planning', 'paused'].includes(m.status)).length;
  }
  const payload = {
    scope: 'workspace',
    hub: null,
    members: { count: members.length, members },
    claims: { count: 0, claims: [] },
    missions_active: activeMissions,
    note: 'workspace scope only. pass --global to query the machine Swarlo hub.',
  };
  if (json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  console.log(`\n  Fleet (workspace)`);
  console.log(`  ─────────────────────────────────`);
  console.log(`  Scope:   workspace`);
  console.log(`  Members: ${members.length} (from atris/team)`);
  for (const mem of members.slice(0, 24)) {
    console.log(`    ${mem.member_name}`);
  }
  console.log(`  Missions active: ${activeMissions}`);
  console.log(`  Hub:     not queried (use --global for localhost Swarlo)`);
  console.log();
}

// ── Member activation (up / down / launched) ─────────────
//
// `fleet up` gives each atris/team member its own Swarlo identity under
// ~/.swarlo/identities/<server>/<hub>/<member>/ so its board posts carry the
// member's name, then leaves a ready note in each channel. `fleet down`
// posts a down note and drops the member from the launched list.
// `fleet launched` (alias `roster`) shows who is activated. The name
// `launched` matches the up/down verbs; `roster` is kept as a synonym.

// Flags take `--flag value` or `--flag=value`. Positional args are members.
// --engine takes member=profile pairs (repeatable); a bare profile applies
// to every member without its own pair.
function parseFleetMemberArgs(args) {
  const out = { members: [], hub: '', server: '', channels: '', dryRun: false, json: false, engines: new Map(), engineAll: '' };
  const valueFlags = { '--hub': 'hub', '--server': 'server', '--channels': 'channels' };
  for (let i = 0; i < args.length; i += 1) {
    const arg = String(args[i]);
    const eq = arg.indexOf('=');
    const isFlagValue = eq > 0 && arg.startsWith('--');
    const flag = isFlagValue ? arg.slice(0, eq) : arg;
    const inline = isFlagValue ? arg.slice(eq + 1) : null;
    const takeValue = () => {
      if (inline !== null) return inline;
      const next = args[i + 1];
      if (next === undefined || String(next).startsWith('--')) return '';
      i += 1;
      return String(next);
    };
    if (flag === '--dry-run' && !isFlagValue) { out.dryRun = true; continue; }
    if (flag === '--json' && !isFlagValue) { out.json = true; continue; }
    if (flag === '--engine') {
      const value = takeValue();
      const sep = value.indexOf('=');
      if (sep > 0) out.engines.set(value.slice(0, sep).trim().toLowerCase(), value.slice(sep + 1).trim());
      else if (value) out.engineAll = value;
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(valueFlags, flag)) {
      out[valueFlags[flag]] = takeValue();
      continue;
    }
    if (!arg.startsWith('-')) out.members.push(arg);
  }
  return out;
}

// The args after the subcommand word inside scope.args, so flag values are
// never mistaken for members the way the argv/flags split would.
function lifecycleTailArgs(scopeArgs, subcommand) {
  const index = scopeArgs.indexOf(subcommand);
  return index >= 0 ? scopeArgs.slice(index + 1) : scopeArgs.slice(1);
}

// A --engine profile names a runner profile ("claude", "codex"); the first
// word is tried when the whole value does not resolve ("claude haiku").
function engineIdForProfile(profile) {
  const { canonicalEngineName } = require('../lib/engine-registry');
  const text = String(profile || '').trim();
  if (!text) return '';
  return canonicalEngineName(text) || canonicalEngineName(text.split(/[\s,]+/)[0]) || '';
}

function memberResult(member) {
  return { member, stage: 'resolve', engine: null, channels: [], error: null, identity: '', awake: null, warning: null };
}

function emitLifecycleResults(kind, results, extra, asJson) {
  if (asJson) {
    const ready = results.filter((r) => r.stage === 'ready' || r.stage === 'planned').length;
    console.log(JSON.stringify({
      command: kind,
      hub: extra.hub || null,
      server: extra.server || null,
      members: results,
      summary: { total: results.length, ready, failed: results.length - ready },
    }, null, 2));
    return;
  }
  for (const r of results) {
    if (r.stage === 'ready') {
      console.log(`  ✓ ${r.member} is ${kind === 'down' ? 'down' : `ready on ${r.engine} in ${r.channels.map((c) => `#${c}`).join(' ')}.`}`);
    } else if (r.stage === 'planned') {
      console.log(`  ○ ${r.member} would be ready on ${r.engine} in ${r.channels.map((c) => `#${c}`).join(' ')} (dry run).`);
    } else if (r.stage === 'missing') {
      console.log(`  · ${r.member} is not launched.`);
    } else {
      console.log(`  ✗ ${r.member} failed at ${r.stage}: ${r.error}`);
    }
    if (r.warning) console.log(`    note: ${r.warning}`);
  }
}

async function fleetUp(parsed, asJson) {
  const swarlo = require('../lib/swarlo-members');
  const { workspaceRoot } = require('../lib/workspace-root');
  const { readMemberCard, resolveEngineForMember } = require('../lib/member-engine');
  const { setMemberAwake } = require('../lib/member-switches');

  const root = workspaceRoot(process.cwd());
  const shared = loadConfig();
  const server = parsed.server || process.env.SWARLO_SERVER || shared.server || DEFAULT_HUB_URL;
  const hub = parsed.hub || process.env.SWARLO_HUB || shared.hub || DEFAULT_HUB_ID;
  const configured = swarlo.configuredChannels(shared);
  const channels = parsed.channels
    ? parsed.channels.split(',').map((c) => c.trim()).filter(Boolean)
    : (configured.length ? configured : ['common']);

  const results = parsed.members.map(memberResult);

  // Dry run resolves members and engines locally and never touches the hub.
  if (!parsed.dryRun) {
    const health = await swarlo.hubHealth(server);
    if (!health.ok) {
      for (const r of results) {
        r.stage = 'preflight';
        r.error = `hub not reachable at ${server}`;
      }
      emitLifecycleResults('up', results, { hub, server }, asJson);
      process.exitCode = 2;
      return;
    }
  }

  // The CLI's own hub key can sponsor registrations on hubs that require
  // an existing member's authority.
  let sponsorKey = '';
  try {
    const state = loadState();
    if (state.api_key && state.hub_id === hub) sponsorKey = state.api_key;
  } catch {}

  const launched = swarlo.loadLaunched();
  let launchedDirty = false;

  for (let index = 0; index < parsed.members.length; index += 1) {
    const name = parsed.members[index];
    const r = results[index];

    const card = readMemberCard(root, name);
    if (!card.found) {
      r.error = `no team member named ${name} (atris/team/${name}/MEMBER.md)`;
      continue;
    }
    const memberName = card.name || name;

    r.stage = 'engine';
    const overrideProfile = parsed.engines.get(name) || parsed.engineAll;
    if (overrideProfile) {
      const engineId = engineIdForProfile(overrideProfile);
      if (!engineId) {
        r.error = `engine profile "${overrideProfile}" is not recognized`;
        continue;
      }
      r.engine = engineId;
      r.warning = 'engine set by --engine, roster pick skipped';
    } else {
      const picked = resolveEngineForMember(name, root);
      if (!picked.engine) {
        r.error = picked.reason || 'no ready engine';
        continue;
      }
      r.engine = picked.engine.id;
      if (picked.runs_here === false) r.warning = `roster says ${name} runs on ${picked.runs_on_label || picked.runs_on}, not this machine`;
    }

    r.channels = [...channels];
    if (parsed.dryRun) {
      r.stage = 'planned';
      r.identity = 'dry-run';
      continue;
    }

    r.stage = 'identity';
    const identDir = swarlo.identityDirFor({ server, hub, member: name });
    const existing = swarlo.loadIdentity(identDir);
    let token = existing ? existing.token : '';
    if (token) {
      r.identity = 'reused';
    } else {
      const inviteToken = process.env.SWARLO_INVITE_TOKEN || '';
      const reg = await swarlo.registerMember(
        { server, hub, memberId: name, memberName, inviteToken, sponsorKey },
      );
      if (!reg.ok) {
        r.error = `register failed (HTTP ${reg.status})`;
        continue;
      }
      token = reg.token;
      swarlo.saveIdentity(identDir, {
        server,
        hub,
        member_id: name,
        member_name: memberName,
        member_type: 'agent',
        token,
      });
      r.identity = 'registered';
    }

    r.stage = 'channels';
    r.channels = [];
    for (const channel of channels) {
      const post = await swarlo.postChannelNote({
        server,
        hub,
        channel,
        content: `${name} is ready on ${r.engine}`,
        kind: 'status',
        token,
        memberId: name,
        memberName,
      });
      if (!post.ok) {
        r.error = `post to #${channel} failed (HTTP ${post.status})`;
        break;
      }
      r.channels.push(channel);
    }
    if (r.error) continue;

    try {
      setMemberAwake(name, true, root);
      r.awake = true;
    } catch {
      r.awake = false;
    }

    if (!launched[hub] || typeof launched[hub] !== 'object') launched[hub] = {};
    launched[hub][name] = {
      server,
      engine: r.engine,
      channels: [...r.channels],
      member_name: memberName,
      launched_at: new Date().toISOString(),
    };
    launchedDirty = true;
    r.stage = 'ready';
  }

  if (launchedDirty) swarlo.saveLaunched(launched);
  emitLifecycleResults('up', results, { hub, server }, asJson);

  const ready = results.filter((r) => r.stage === 'ready' || r.stage === 'planned').length;
  process.exitCode = ready === results.length ? 0 : (ready > 0 ? 1 : 2);
}

async function fleetDown(parsed, asJson) {
  const swarlo = require('../lib/swarlo-members');
  const launched = swarlo.loadLaunched();
  const hubFilter = parsed.hub || '';
  const serverFilter = parsed.server ? swarlo.serverSlug(parsed.server) : '';
  const results = parsed.members.map(memberResult);
  let changed = false;

  for (let index = 0; index < parsed.members.length; index += 1) {
    const name = parsed.members[index];
    const r = results[index];
    r.stage = 'down';
    const hits = [];
    for (const [hub, members] of Object.entries(launched)) {
      if (hubFilter && hub !== hubFilter) continue;
      const entry = members && typeof members === 'object' ? members[name] : null;
      if (!entry) continue;
      if (serverFilter && swarlo.serverSlug(entry.server || '') !== serverFilter) continue;
      hits.push({ hub, entry });
    }
    if (!hits.length) {
      r.stage = 'missing';
      r.error = hubFilter ? `not launched on ${hubFilter}` : 'not launched';
      continue;
    }

    for (const { hub, entry } of hits) {
      r.hub = hub;
      r.engine = entry.engine || r.engine;
      const channels = Array.isArray(entry.channels) && entry.channels.length ? entry.channels : ['common'];
      const ident = swarlo.loadIdentity(swarlo.identityDirFor({ server: entry.server, hub, member: name }));
      const token = ident ? ident.token : '';
      for (const channel of channels) {
        if (!token) break;
        try {
          const post = await swarlo.postChannelNote({
            server: entry.server,
            hub,
            channel,
            content: `${name} is down`,
            kind: 'status',
            token,
            memberId: name,
            memberName: entry.member_name || name,
          });
          if (post.ok) r.channels.push(channel);
        } catch {}
      }
      delete launched[hub][name];
      if (!Object.keys(launched[hub]).length) delete launched[hub];
      changed = true;
    }
    r.stage = 'ready';
    r.error = null;
  }

  if (changed) swarlo.saveLaunched(launched);
  emitLifecycleResults('down', results, {}, asJson);
  process.exitCode = 0;
}

function fleetLaunchedView(asJson) {
  const swarlo = require('../lib/swarlo-members');
  const state = swarlo.loadLaunched();
  const rows = [];
  for (const [hub, members] of Object.entries(state)) {
    for (const [member, entry] of Object.entries(members || {})) {
      if (!entry || typeof entry !== 'object') continue;
      rows.push({
        member,
        hub,
        server: entry.server || '',
        engine: entry.engine || '',
        channels: Array.isArray(entry.channels) ? entry.channels : [],
        launched_at: entry.launched_at || '',
      });
    }
  }
  rows.sort((a, b) => a.member.localeCompare(b.member) || a.hub.localeCompare(b.hub));
  if (asJson) {
    console.log(JSON.stringify({ launched: rows, count: rows.length }, null, 2));
    return;
  }
  if (!rows.length) {
    console.log('  No launched members.');
    return;
  }
  console.log('  Launched members:');
  for (const row of rows) {
    const channels = row.channels.length ? row.channels.map((c) => `#${c}`).join(' ') : '';
    console.log(`    ${row.member} on ${row.hub} (${row.server}) ${row.engine} ${channels}`.trimEnd());
  }
}

async function fleetMemberLifecycle(subcommand, scopeArgs, { json } = {}) {
  const parsed = parseFleetMemberArgs(lifecycleTailArgs(scopeArgs, subcommand));
  const asJson = json || parsed.json;
  if (subcommand === 'launched' || subcommand === 'roster') {
    fleetLaunchedView(asJson);
    return;
  }
  if (!parsed.members.length) {
    console.error(`Usage: atris fleet ${subcommand} <member> [member...] [--hub <id>] [--server <url>] [--channels <csv>] [--engine <member=profile>] [--dry-run] [--json]`);
    process.exitCode = 2;
    return;
  }
  if (subcommand === 'down') {
    await fleetDown(parsed, asJson);
    return;
  }
  await fleetUp(parsed, asJson);
}

// ── Member watch (doorbell) ──────────────────────────────
//
// `fleet watch` polls every launched member's hub for work addressed to it
// and rings the doorbell — a board post that @mentions the member — when
// something is pending. It never claims tasks, never posts heartbeats, and
// never starts an engine: it is a doorbell, not a worker. The poll, dedup,
// and nudge logic lives in lib/fleet-watch.js; this is flags, the loop, and
// output. The board tail keeps the name `fleet tail`.

// --interval takes seconds (`--interval 45` or `--interval=45`); a bare
// number keeps the old `fleet watch <sec>` habit working as the interval.
function parseFleetWatchArgs(args) {
  const out = { intervalSec: 30, once: false, json: false, hub: '', server: '' };
  const valueFlags = { '--interval': 'interval', '--hub': 'hub', '--server': 'server' };
  for (let i = 0; i < args.length; i += 1) {
    const arg = String(args[i]);
    const eq = arg.indexOf('=');
    const isFlagValue = eq > 0 && arg.startsWith('--');
    const flag = isFlagValue ? arg.slice(0, eq) : arg;
    const inline = isFlagValue ? arg.slice(eq + 1) : null;
    const takeValue = () => {
      if (inline !== null) return inline;
      const next = args[i + 1];
      if (next === undefined || String(next).startsWith('--')) return '';
      i += 1;
      return String(next);
    };
    if (flag === '--once' && !isFlagValue) { out.once = true; continue; }
    if (flag === '--json' && !isFlagValue) { out.json = true; continue; }
    if (Object.prototype.hasOwnProperty.call(valueFlags, flag)) {
      const value = takeValue();
      if (flag === '--interval') {
        const seconds = Number(value);
        if (Number.isFinite(seconds) && seconds > 0) out.intervalSec = seconds;
      } else {
        out[valueFlags[flag]] = value;
      }
      continue;
    }
    if (/^\d+(\.\d+)?$/.test(arg)) out.intervalSec = Number(arg);
  }
  return out;
}

function watchEventLine(event) {
  if (event.type === 'nudge') {
    const kinds = event.kinds && Object.keys(event.kinds).length
      ? ` (${Object.entries(event.kinds).map(([k, n]) => `${n} ${k}`).join(', ')})`
      : '';
    return `  → ${event.member} nudged on ${event.hub} (#${event.channel}): ${event.pending} waiting${kinds}`;
  }
  if (event.type === 'dropped') return `  · ${event.member} is no longer launched on ${event.hub}`;
  if (event.type === 'recovered') return `  · ${event.member} is reachable again on ${event.hub}`;
  return `  ! ${event.member}: ${event.reason}`;
}

async function fleetMembersWatch(scopeArgs, { json } = {}) {
  const watch = require('../lib/fleet-watch');
  const swarlo = require('../lib/swarlo-members');
  const { workspaceRoot } = require('../lib/workspace-root');
  const { isLocalMember, setMemberAwake } = require('../lib/member-switches');

  const parsed = parseFleetWatchArgs(lifecycleTailArgs(scopeArgs, 'watch'));
  const asJson = json || parsed.json;
  const intervalSec = Math.max(1, parsed.intervalSec);
  const root = workspaceRoot(process.cwd());

  // The CLI's own hub key can sponsor watcher registrations, same as up.
  const sponsorKeys = {};
  try {
    const state = loadState();
    if (state.api_key && state.hub_id) sponsorKeys[state.hub_id] = state.api_key;
  } catch {}

  let polling = false;
  const poll = async () => {
    if (polling) return null;
    polling = true;
    try {
      const launched = watch.filterLaunched(swarlo.loadLaunched(), parsed);
      const result = await watch.pollOnce({
        launched,
        state: watch.loadWatchState(),
        env: process.env,
        sponsorKeyFor: (hub) => sponsorKeys[hub] || '',
      });
      watch.saveWatchState(result.state);
      // The board mention is the doorbell; the awake switch is the same one
      // `atris wake` flips, so a slept local member is marked awake too.
      for (const event of result.events) {
        if (event.type !== 'nudge') continue;
        try {
          if (isLocalMember(event.member, root)) setMemberAwake(event.member, true, root);
        } catch {}
      }
      return result;
    } catch {
      return null; // transient: stay quiet, the next tick retries
    } finally {
      polling = false;
    }
  };

  const emit = (result) => {
    if (!result) return;
    if (asJson) {
      if (result.events.length) {
        console.log(JSON.stringify({ at: result.at, events: result.events }, null, 2));
      }
      return;
    }
    for (const event of result.events) console.log(watchEventLine(event));
  };

  if (parsed.once) {
    const result = await poll();
    if (result) {
      if (asJson) {
        console.log(JSON.stringify({
          at: result.at,
          members: result.members,
          events: result.events,
        }, null, 2));
      } else {
        for (const event of result.events) console.log(watchEventLine(event));
        if (!result.members.length) console.log('  No launched members.');
      }
    }
    return;
  }

  const launchedCount = watch.launchedRows(watch.filterLaunched(swarlo.loadLaunched(), parsed)).length;
  if (!asJson) {
    console.log(launchedCount
      ? `  Watching ${launchedCount} launched member${launchedCount === 1 ? '' : 's'} every ${intervalSec}s (Ctrl+C to stop)`
      : '  No launched members yet. Ctrl+C to stop.');
  }
  emit(await poll());
  const timer = setInterval(() => { poll().then(emit); }, intervalMs(intervalSec));

  await new Promise((resolve) => {
    const stop = () => {
      clearInterval(timer);
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      if (!asJson) console.log('\n  Stopped watching.\n');
      resolve();
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  });
}

function intervalMs(seconds) {
  return Math.max(1, Number(seconds) || 30) * 1000;
}

// ── Main ────────────────────────────────────────────────

async function fleet(args = []) {
  const scope = parseScopeFlag(args);
  let argv = scope.args.filter((a) => !String(a).startsWith('-'));
  let operationKey = null;
  if (scope.args.some((arg) => arg === '--idempotency-key' || arg.startsWith('--idempotency-key='))) {
    const parsed = require('../lib/business-target').parseArgs(scope.args, { values: ['idempotency_key'] });
    operationKey = parsed.flags.idempotency_key;
    if (parsed.error || !operationKey || parsed.flags.business || !['done', 'report'].includes(parsed.pos[0]?.toLowerCase())) {
      console.error(parsed.error || 'use --idempotency-key with fleet done or fleet report');
      process.exitCode = 1;
      return;
    }
    argv = parsed.flags.help ? ['help'] : parsed.pos;
  }
  const flags = scope.args.filter((a) => String(a).startsWith('-'));
  const subcommand = (argv[0] || 'status').toLowerCase();
  const rest = argv.slice(1).join(' ');
  const json = flags.includes('--json') || args.includes('--json');

  if (subcommand === 'help' || subcommand === '--help' || subcommand === '-h') {
    console.log('');
    console.log('  atris fleet: coordinate agent swarm via Swarlo');
    console.log('');
    console.log('  fleet              show workspace fleet (default)');
    console.log('  fleet verify <manifest.json> [--retry-failed] [--json]   check pinned local repos and their joint behavior');
    console.log('  fleet --global     query the machine Swarlo hub');
    console.log('  fleet post <msg>   post message to board (global)');
    console.log('  fleet task <prompt> create a task for agents (global)');
    console.log('  fleet claim <key>  claim a task (global)');
    console.log('  fleet done <key> [result] [--idempotency-key <intent>]   report task complete (global)');
    console.log('  fleet members      who is online');
    console.log('  fleet prune [min]  remove stale members (default 60m)');
    console.log('  fleet watch [--interval sec] [--once] [--json]');
    console.log('                      nudge launched members when work waits');
    console.log('  fleet tail [sec]    live-tail the board (default 10s)');
    console.log('  fleet up <member>  activate team members on the hub');
    console.log('                      ([--hub id] [--server url] [--channels a,b]');
    console.log('                       [--engine member=profile] [--dry-run] [--json])');
    console.log('  fleet down <member> deactivate launched members ([--hub id])');
    console.log('  fleet launched     list activated members (alias: roster)');
    console.log('');
    return;
  }

  if (subcommand === 'verify') {
    try {
      if (scope.global || argv.length !== 2 || flags.some(flag => !['--json', '--retry-failed'].includes(flag))) {
        throw new Error('usage: atris fleet verify <manifest.json> [--retry-failed] [--json]');
      }
      const result = await require('../lib/fleet-verify').verifyFleet(argv[1], { retryFailed: flags.includes('--retry-failed') });
      if (json) console.log(JSON.stringify(result));
      else {
        for (const target of result.targets) console.log(`${target.name}: ${target.state}${target.detail ? ', ' + target.detail : ''}`);
        console.log(`joint check: ${result.joint.state}${result.joint.detail ? ', ' + result.joint.detail : ''}`);
      }
      process.exitCode = result.ok ? 0 : 1;
    } catch (error) {
      if (json) console.log(JSON.stringify({ ok: false, error: error.message }));
      else console.error(error.message);
      process.exitCode = 1;
    }
    return;
  }

  if (!scope.global && (subcommand === 'status' || subcommand === 'st' || subcommand === 'members' || subcommand === 'who')) {
    await fleetWorkspaceStatus(process.cwd(), { json });
    return;
  }

  if (!scope.global && ['post', 'say', 'task', 'claim', 'done', 'report', 'prune', 'tail'].includes(subcommand)) {
    console.error('fleet mutations need the machine hub. re-run with --global.');
    process.exitCode = 1;
    return;
  }

  // Member activation and watch manage per-member hub identities; they
  // always target the machine hub, so they do not wait on --global or the
  // CLI's own join.
  if (subcommand === 'watch') {
    await fleetMembersWatch(scope.args, { json });
    return;
  }
  if (['up', 'down', 'launched', 'roster'].includes(subcommand)) {
    await fleetMemberLifecycle(subcommand, scope.args, { json });
    return;
  }

  const state = await ensureRegistered({ preserveIdentity: Boolean(operationKey) });

  switch (subcommand) {
    case 'status':
    case 'st':
      if (json) {
        const hubUrl = getHubUrl();
        const hubId = getHubId();
        const h = authHeaders(state);
        const [members, posts, claims] = await Promise.all([
          request('GET', `${hubUrl}/api/${hubId}/members`, null, h),
          request('GET', `${hubUrl}/api/${hubId}/channels/general/posts?limit=5`, null, h),
          request('GET', `${hubUrl}/api/${hubId}/claims`, null, h),
        ]);
        console.log(JSON.stringify({
          scope: 'global',
          hub: { id: hubId, url: hubUrl },
          you: state.member_id,
          members: members.data,
          claims: claims.data,
          recent: posts.data,
        }, null, 2));
      } else {
        await fleetStatus(state);
      }
      break;
    case 'post':
    case 'say':
      if (!rest) { console.error('Usage: atris fleet post <message>'); return; }
      await fleetPost(state, rest);
      break;
    case 'task':
      if (!rest) { console.error('Usage: atris fleet task <prompt>'); return; }
      await fleetTask(state, rest);
      break;
    case 'claim':
      if (!rest) { console.error('Usage: atris fleet claim <task_key>'); return; }
      await fleetClaim(state, rest);
      break;
    case 'done':
    case 'report':
      if (!rest) { console.error('Usage: atris fleet done <task_key> [result]'); process.exitCode = 1; return; }
      const [key, ...resultParts] = argv.slice(1);
      await fleetDone(state, key, resultParts.join(' '), operationKey, json);
      break;
    case 'members':
    case 'who':
      await fleetMembers(state);
      break;
    case 'prune':
      await fleetPrune(state, parseInt(rest) || 60);
      break;
    case 'tail':
      await fleetTail(state, parseInt(rest) || 10);
      break;
    default:
      if (!scope.global) {
        await fleetWorkspaceStatus(process.cwd(), { json });
      } else {
        await fleetStatus(state);
      }
  }
}

module.exports = { fleet, fleetWorkspaceStatus, parseFleetMemberArgs, parseFleetWatchArgs };
