/**
 * Atris Fleet — Manage the agent swarm via Swarlo
 *
 * Commands:
 *   atris fleet                  — Show fleet status
 *   atris fleet status           — Same as above
 *   atris fleet post <message>   — Post to the board
 *   atris fleet task <prompt>    — Post a task for agents to claim
 *   atris fleet claim <task_key> — Claim a task
 *   atris fleet done <task_key>  — Report task complete
 *   atris fleet members          — List members
 *   atris fleet prune            — Remove stale members
 *   atris fleet join             — Register this session
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

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

async function ensureRegistered() {
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

  // Re-use existing key if valid
  if (state.api_key && state.hub_id === hubId) {
    try {
      const check = await request('GET', `${hubUrl}/api/${hubId}/members`, null, {
        Authorization: `Bearer ${state.api_key}`,
      });
      if (check.status === 200) return state;
    } catch {}
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

async function fleetDone(state, taskKey, result = '') {
  const hubUrl = getHubUrl();
  const hubId = getHubId();
  const res = await request('POST', `${hubUrl}/api/${hubId}/channels/general/posts`, {
    content: result || `Done: ${taskKey}`,
    kind: 'result',
    task_key: taskKey,
  }, authHeaders(state));
  if (res.status < 300) {
    console.log(`✓ Reported done: ${taskKey}`);
  } else {
    console.error('✗ Failed:', res.data);
  }
}

async function fleetMembers(state) {
  const hubUrl = getHubUrl();
  const hubId = getHubId();
  const res = await request('GET', `${hubUrl}/api/${hubId}/members`, null, authHeaders(state));
  if (res.data?.members) {
    console.log(`\n  Members (${res.data.count}):`);
    for (const m of res.data.members) {
      const seen = m.last_seen ? m.last_seen.slice(0, 16) : 'never';
      console.log(`    ${m.member_type === 'human' ? '👤' : '🤖'} ${m.member_name} (${m.member_id}) — seen: ${seen}`);
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

async function fleetWatch(state, intervalSec = 10) {
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

// ── Main ────────────────────────────────────────────────

async function fleet(args = []) {
  const subcommand = (args[0] || 'status').toLowerCase();
  const rest = args.slice(1).join(' ');

  if (subcommand === 'help' || subcommand === '--help' || subcommand === '-h') {
    console.log('');
    console.log('  atris fleet — coordinate agent swarm via Swarlo');
    console.log('');
    console.log('  fleet              show board status');
    console.log('  fleet post <msg>   post message to board');
    console.log('  fleet task <prompt> create a task for agents');
    console.log('  fleet claim <key>  claim a task');
    console.log('  fleet done <key>   report task complete');
    console.log('  fleet members      who is online');
    console.log('  fleet prune [min]  remove stale members (default 60m)');
    console.log('  fleet watch [sec]  live-tail the board (default 10s)');
    console.log('');
    return;
  }

  const state = await ensureRegistered();

  switch (subcommand) {
    case 'status':
    case 'st':
      await fleetStatus(state);
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
      if (!rest) { console.error('Usage: atris fleet done <task_key> [result]'); return; }
      const [key, ...resultParts] = rest.split(' ');
      await fleetDone(state, key, resultParts.join(' '));
      break;
    case 'members':
    case 'who':
      await fleetMembers(state);
      break;
    case 'prune':
      await fleetPrune(state, parseInt(rest) || 60);
      break;
    case 'watch':
    case 'tail':
      await fleetWatch(state, parseInt(rest) || 10);
      break;
    default:
      // If no subcommand match, treat the whole thing as status
      await fleetStatus(state);
  }
}

module.exports = { fleet };
