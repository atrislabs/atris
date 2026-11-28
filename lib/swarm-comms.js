'use strict';

// LLM-first natural swarm planner, higher-plane comms, and bounded loop.
//
// No brittle regex classifiers. When a person types plain English
// (`atris swarm "harden auth for 23 min"` or `atris swarm up 23 min`), the
// subscription model reads the real team lineup, workspace context, and Swarlo
// board, chooses the right seats (or runs solo when no seats exist), sets the
// clock, and launches cleanly.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const swarlo = require('./swarlo-members');
const { readMemberCard, resolveEngineForMember } = require('./member-engine');
const {
  loadSwarmState,
  updateSwarmState,
  loadFrozenState,
  startSwarm,
  freezeModules,
  planSwarmTasks,
  pullSwarmTask,
  reportSwarmTask,
  watchSwarm,
} = require('./swarm');
const { MEMORY_CORE_PATH } = require('./member-context');
const { classifyTaskEffort, effectiveEffortForEngine, runDiagnosticAudible } = require('./effort-router');

const DEFAULT_SERVER = 'http://localhost:8090';
const DEFAULT_HUB = swarlo.DEFAULT_HUB_ID;
const DEFAULT_CHANNEL = 'general';
const DEFAULT_INTERVAL_MS = 10 * 60 * 1000;
const PLANNER_TIMEOUT_MS = 45 * 1000;
const TRACE_REL = path.join('.atris', 'state', 'coordination_trace.jsonl');
const LOOP_LOG_REL = path.join('.atris', 'state', 'swarm_loop.jsonl');

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function safeRead(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}

function appendJsonl(file, row) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(row)}\n`, 'utf8');
}

// Parse simple leading duration tokens when explicitly passed to `swarm up`
// or quoted in `atris swarm "1 hour to understand the swarm"`. Returns null
// for member names so `fleet up <member>` stays unambiguous.
function parseDurationTokens(tokens = []) {
  const clean = (Array.isArray(tokens) ? tokens : []).map((t) => String(t || '').trim()).filter(Boolean);
  if (!clean.length) return null;

  const units = {
    s: 1000, sec: 1000, secs: 1000, second: 1000, seconds: 1000,
    m: 60 * 1000, min: 60 * 1000, mins: 60 * 1000, minute: 60 * 1000, minutes: 60 * 1000,
    h: 3600 * 1000, hr: 3600 * 1000, hrs: 3600 * 1000, hour: 3600 * 1000, hours: 3600 * 1000,
  };

  const matchPair = (arr) => {
    const single = arr[0].match(/^(\d+(?:\.\d+)?)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours)$/i);
    if (single) {
      const val = Number(single[1]);
      const mult = units[single[2].toLowerCase()];
      if (val > 0 && mult) {
        return { ms: Math.round(val * mult), label: `${single[1]}${single[2].toLowerCase()}`, consumed: 1 };
      }
    }
    if (arr.length >= 2 && /^\d+(?:\.\d+)?$/.test(arr[0])) {
      const mult = units[arr[1].toLowerCase()];
      const val = Number(arr[0]);
      if (val > 0 && mult) {
        return { ms: Math.round(val * mult), label: `${arr[0]} ${arr[1].toLowerCase()}`, consumed: 2 };
      }
    }
    return null;
  };

  const direct = matchPair(clean);
  if (direct) return direct;

  // Handle a quoted prompt starting with a duration, e.g. "1 hour improve" (even if extra tokens follow).
  if (/\s/.test(clean[0])) {
    const words = clean[0].split(/\s+/).filter(Boolean);
    const quoted = matchPair(words);
    if (quoted) {
      const rest = [words.slice(quoted.consumed).join(' ').trim(), ...clean.slice(1)].filter(Boolean).join(' ').trim();
      return {
        ms: quoted.ms,
        label: quoted.label,
        consumed: 0,
        remainder: rest,
      };
    }
  }

  return null;
}

function resolveTarget(root, opts = {}) {
  const active = loadSwarmState(root);
  const home = opts.home || os.homedir();
  const cfg = readJson(path.join(home, '.swarlo', 'config.json'))
    || readJson(path.join(root, '.swarlo', 'config.json'))
    || {};
  const server = opts.server || (active && active.server) || process.env.SWARLO_SERVER || cfg.server || DEFAULT_SERVER;
  const hub = opts.hub || (active && active.hub) || process.env.SWARLO_HUB || cfg.hub || DEFAULT_HUB;
  const channel = opts.channel || (active && active.channel) || DEFAULT_CHANNEL;
  const lead = (active && active.lead) || 'coordinator';
  return { server, hub, channel, home, lead, active };
}

function normalizeServerUrl(url) {
  return String(url || '').trim().replace(/\/+$/, '').toLowerCase();
}

function findTokenFor(actor, target, deps = {}) {
  const sw = deps.swarlo || swarlo;
  const targetServer = normalizeServerUrl(target.server);
  for (const candidate of [actor, target.lead, 'coordinator']) {
    if (!candidate) continue;
    if (typeof sw.identityDirFor === 'function' && typeof sw.loadIdentity === 'function') {
      const dir = sw.identityDirFor({ server: target.server, hub: target.hub, member: candidate }, target.home);
      const loaded = sw.loadIdentity(dir);
      if (loaded && loaded.token) return String(loaded.token).trim();
    }
  }
  const fleetState = readJson(path.join(target.home, '.swarlo', 'fleet-state.json'), {});
  if (fleetState && fleetState.api_key && fleetState.hub_id === target.hub) {
    const fsServer = normalizeServerUrl(fleetState.server || '');
    if (!targetServer || !fsServer || fsServer === targetServer) return fleetState.api_key;
  }
  const shared = readJson(path.join(target.home, '.swarlo', 'config.json'), {});
  if (shared && (shared.api_key || shared.token)) {
    const hubMatch = !shared.hub || shared.hub === target.hub;
    const cfgServer = normalizeServerUrl(shared.server || '');
    const serverMatch = !targetServer || (cfgServer && cfgServer === targetServer);
    if (hubMatch && serverMatch) return shared.api_key || shared.token;
  }
  return process.env.SWARLO_TOKEN || process.env.SWARLO_API_KEY || '';
}

function listTeamRoster(root) {
  const dir = path.join(root, 'atris', 'team');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('_') && !e.name.startsWith('.'))
    .map((e) => e.name)
    .filter((name) => fs.existsSync(path.join(dir, name, 'MEMBER.md')))
    .sort()
    .map((slug) => {
      const card = readMemberCard(root, slug) || {};
      return {
        slug,
        role: String(card.role || '').trim(),
        description: String(card.description || '').trim(),
      };
    });
}

function pickPlannerEngine(root, override = '') {
  if (override) return { engine: override, model: '' };
  const { readEngineRegistry } = require('./engine-registry');
  const reg = readEngineRegistry(root, { persist: false });
  const ready = (reg && Array.isArray(reg.engines) ? reg.engines : [])
    .filter((e) => e && e.health && e.health.status === 'ready')
    .map((e) => e.id);
  if (ready.includes('haiku') || ready.includes('claude')) {
    return { engine: 'haiku', model: '' };
  }
  for (const pref of ['codex', 'agy', 'grok']) {
    if (ready.includes(pref)) return { engine: pref, model: '' };
  }
  const picked = resolveEngineForMember('coordinator', root) || {};
  if (picked.engine && picked.engine.id) {
    return { engine: picked.engine.id, model: picked.model || '' };
  }
  return ready.length ? { engine: ready[0], model: '' } : { engine: 'haiku', model: '' };
}

async function defaultAskModel(root, prompt, { engineOverride = '', timeoutMs = PLANNER_TIMEOUT_MS } = {}) {
  const { runEngineAskJobs } = require('./engine-ask');
  const pick = pickPlannerEngine(root, engineOverride);
  if (!pick.engine) return { ok: false, text: '', engine: '', error: 'no ready engine' };
  const effort = effectiveEffortForEngine(pick.engine, 'low');
  const [answer] = await runEngineAskJobs(
    [{ engine: pick.engine, model: pick.model || '', ...(effort ? { effort } : {}), prompt, label: 'swarm natural planner' }],
    { root, timeoutMs },
  );
  const text = String((answer && (answer.stdout || answer.output || answer.text)) || '').trim();
  if (!answer || answer.ok === false || !text) {
    return {
      ok: false,
      text: '',
      engine: pick.engine,
      error: (answer && (answer.error || answer.reason)) || 'model returned empty output',
    };
  }
  return { ok: true, text, engine: pick.engine };
}

function parseJsonObject(text) {
  const raw = String(text || '').trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1].trim() : raw;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
}

function extractQueryTerms(text) {
  return [...new Set(String(text || '').toLowerCase().split(/[^a-z0-9._/-]+/).filter((w) => w.length >= 3))];
}

function rankTextLines(lines, query, cap) {
  const terms = extractQueryTerms(query);
  if (!terms.length) return lines.slice(0, cap);
  const scored = lines.map((line, idx) => {
    const lower = line.toLowerCase();
    const score = terms.reduce((s, w) => s + (lower.includes(w) ? 1 : 0), 0);
    return { line, score, idx };
  });
  const hits = scored.filter((x) => x.score > 0).sort((a, b) => b.score - a.score || a.idx - b.idx);
  const out = hits.slice(0, cap).map((x) => x.line);
  if (out.length < Math.min(cap, 6)) {
    const seen = new Set(out);
    for (const line of lines) {
      if (out.length >= Math.min(cap, 8)) break;
      if (!seen.has(line)) {
        seen.add(line);
        out.push(line);
      }
    }
  }
  return out;
}

// Search the ENTIRE atris/MAP.md (no 2.8KB head truncation) and return the most relevant routing rows.
function selectRelevantMapLines(root, query = '', maxRows = 16) {
  const text = safeRead(path.join(root, 'atris', 'MAP.md'));
  if (!text) return '';
  const rows = text.split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith('|') && !/^\|[-\s|]+\|$/.test(l) && !/^\|\s*Task\s*\|/i.test(l));
  if (!rows.length) return '';
  return rankTextLines(rows, query, maxRows).join('\n');
}

// Search atris/wiki/index.md and return top matching wiki page pointers.
function selectRelevantWikiLines(root, query = '', maxLines = 6) {
  const text = safeRead(path.join(root, 'atris', 'wiki', 'index.md'));
  if (!text) return [];
  const bullets = text.split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith('- ') && l.includes('[['));
  if (!bullets.length) return [];
  return rankTextLines(bullets, query, maxLines);
}

function readRosterHint(root, maxChars = 1600) {
  const text = safeRead(path.join(root, 'atris', 'ROSTER.md'));
  if (!text) return '';
  const bodyLines = text
    .split(/\r?\n/)
    .filter((line) => !/^\s*>/.test(line))
    .map((line) => line.trimEnd());
  const compact = bodyLines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return compact ? compact.slice(0, maxChars) : '';
}

// Summarize historical seat performance from coordination_trace.jsonl so the
// planner favors winning seats and avoids repeatedly failing seats.
function seatTrackRecord(root) {
  const raw = safeRead(path.join(root, TRACE_REL));
  if (!raw) return '';
  const stats = new Map();
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    const seat = String((row && row.seat) || '').trim().toLowerCase();
    if (!seat || seat === 'human') continue;
    const entry = stats.get(seat) || { accepted: 0, failed: 0, review_pending: 0 };
    if (row.outcome === 'accepted') entry.accepted += 1;
    else if (row.outcome === 'failed') entry.failed += 1;
    else if (row.outcome === 'review_pending') entry.review_pending += 1;
    stats.set(seat, entry);
  }
  const lines = [];
  for (const [seat, s] of [...stats.entries()].sort((a, b) => (b[1].accepted - b[1].failed) - (a[1].accepted - a[1].failed))) {
    if (s.accepted + s.failed + s.review_pending === 0) continue;
    lines.push(`- ${seat}: ${s.accepted} accepted, ${s.failed} failed${s.review_pending ? `, ${s.review_pending} awaiting review` : ''}`);
  }
  return lines.slice(0, 10).join('\n');
}

function buildNaturalPlanPrompt({
  input, roster, nowText, coreText, mapText, wikiLines, rosterHint, trackRecord,
  activeSwarm, frozenPaths, boardPosts, explicitDuration,
}) {
  const teamBlock = roster.length
    ? roster.map((m) => `- ${m.slug}: ${m.role || 'member'}${m.description ? ` (${m.description.slice(0, 120)})` : ''}`).join('\n')
    : '(no team seats configured yet — set solo=true and lead="atris" so one agent handles it directly)';
  const boardBlock = boardPosts.length
    ? boardPosts.slice(0, 6).map((p) => `- [${p.member_name || p.member_id}] ${String(p.content || '').slice(0, 140)}`).join('\n')
    : '(none)';

  return [
    'You are the natural swarm coordinator for an Atris workspace.',
    'Read what the person asked and the workspace context below, then return ONE compact JSON object and nothing else.',
    '',
    `Person said: ${input || '(no text — pick the highest-value active work from workspace context)'}`,
    explicitDuration ? `Time budget requested: ${explicitDuration.label} (${explicitDuration.ms >= 60000 ? `${Math.round(explicitDuration.ms / 60000)} minutes` : `${Math.round(explicitDuration.ms / 1000)} seconds`})` : '',
    '',
    'Available team seats (pick ONLY from these names; if empty or 1 agent is better, set solo=true and lead="atris"):',
    teamBlock,
    '',
    rosterHint ? `Active ROSTER.md:\n${rosterHint}` : '',
    trackRecord ? `Recent seat track record (favor reliable seats, bench seats with repeated failures):\n${trackRecord}` : '',
    activeSwarm ? `Active swarm: ${activeSwarm.objective} (lead=${activeSwarm.lead}, workers=${(activeSwarm.workers || []).join(', ')})` : '',
    frozenPaths.length ? `Frozen modules (do not edit): ${frozenPaths.join(', ')}` : '',
    coreText ? `Core verified memory:\n${coreText.slice(0, 1600)}` : '',
    nowText ? `Current workspace now.md:\n${nowText.slice(0, 1000)}` : '',
    boardPosts.length ? `Relevant Swarlo board notes:\n${boardBlock}` : '',
    wikiLines && wikiLines.length ? `Relevant wiki pages:\n${wikiLines.join('\n')}` : '',
    mapText ? `Relevant project MAP routes:\n${mapText}` : '',
    '',
    'Tier rules:',
    '- Tier 1: routine engineering, research, testing, docs, fixes (coordinator + best-fit workers execute directly).',
    '- Tier 2: architecture, scope or cross-system judgment (include strategist).',
    '- Tier 3: money, billing, charging customers, deploying to production, external emails/posts, or deleting user data (set tier=3 and needs_human_yes=true).',
    '',
    'Reply with valid JSON only, exact keys:',
    '{',
    '  "objective": "<clear concrete goal in one plain sentence>",',
    '  "duration_minutes": <positive number if the person mentioned a time window like 23 min or 1 hr, else null>,',
    '  "lead": "<seat name from team list, or \'atris\' if no team seats exist>",',
    '  "workers": ["<0 to 3 best-fit seats from team list, excluding lead>"],',
    '  "solo": <true if no seats exist or one agent should just do it directly, else false>,',
    '  "tier": <1, 2, or 3>,',
    '  "needs_human_yes": <true for tier 3 money/deploy/external-send/destructive asks, else false>,',
    '  "context_paths": ["<up to 4 most relevant file paths from MAP>"],',
    '  "tasks": [{"task_key": "<short-kebab-slug>", "content": "<concrete step>", "depends_on": []}],',
    '  "reason": "<one plain sentence explaining the seat pick and plan>"',
    '}',
  ].filter((line) => line !== '').join('\n');
}

function normalizeNaturalPlan(parsed, { input, roster, activeSwarm, explicitDuration, mode, engine }) {
  const seatSet = new Set(roster.map((m) => m.slug));
  const rawObj = parsed && typeof parsed === 'object' ? parsed : {};

  const objective = String(rawObj.objective || input || (activeSwarm && activeSwarm.objective) || 'work the open workspace queue').trim();
  const parsedMinutes = Number(rawObj.duration_minutes);
  const durationMs = explicitDuration
    ? explicitDuration.ms
    : (Number.isFinite(parsedMinutes) && parsedMinutes > 0 ? Math.round(parsedMinutes * 60 * 1000) : null);
  const durationLabel = explicitDuration
    ? explicitDuration.label
    : (durationMs ? `${Math.round(durationMs / 60000)}m` : null);

  const hasSeats = roster.length > 0;
  let solo = Boolean(rawObj.solo) || !hasSeats;
  let lead = String(rawObj.lead || '').trim().toLowerCase();
  if (hasSeats) {
    if (!seatSet.has(lead)) {
      lead = seatSet.has('coordinator') ? 'coordinator' : roster[0].slug;
    }
  } else {
    lead = 'atris';
    solo = true;
  }

  let workers = [];
  if (!solo && hasSeats) {
    const rawWorkers = Array.isArray(rawObj.workers) ? rawObj.workers : [];
    workers = [...new Set(rawWorkers.map((w) => String(w || '').trim().toLowerCase()).filter((w) => seatSet.has(w) && w !== lead))].slice(0, 4);
    if (!workers.length) {
      const others = roster.map((m) => m.slug).filter((s) => s !== lead && s !== 'strategist');
      workers = others.slice(0, 2);
      if (!workers.length) solo = true;
    }
  }

  const tier = [1, 2, 3].includes(Number(rawObj.tier)) ? Number(rawObj.tier) : 1;
  const needsHumanYes = Boolean(rawObj.needs_human_yes) || tier === 3;
  const contextPaths = Array.isArray(rawObj.context_paths)
    ? rawObj.context_paths.map((p) => String(p || '').trim()).filter(Boolean).slice(0, 6)
    : [];
  const tasks = Array.isArray(rawObj.tasks)
    ? rawObj.tasks
      .filter((t) => t && t.task_key && t.content)
      .slice(0, 6)
      .map((t) => ({
        task_key: String(t.task_key).trim().toLowerCase().replace(/[^a-z0-9._:-]+/g, '-').slice(0, 48),
        content: String(t.content).trim(),
        depends_on: Array.isArray(t.depends_on) ? t.depends_on.map((d) => String(d).trim()).filter(Boolean) : [],
      }))
    : [];

  return {
    objective,
    duration_ms: durationMs,
    duration_minutes: durationMs ? Math.round(durationMs / 60000) : null,
    duration_label: durationLabel,
    lead,
    workers,
    solo,
    tier,
    needs_human_yes: needsHumanYes,
    context_paths: contextPaths,
    tasks,
    reason: String(rawObj.reason || (solo ? 'running solo because no extra team seats are needed' : `staffed ${lead} with ${workers.join(', ')}`)).trim(),
    planner: mode,
    planner_engine: engine || null,
  };
}

// LLM-first natural swarm planner. Calls the subscription model when available;
// falls back cleanly (zero regex!) when --offline or no model is ready.
async function planNaturalSwarm(root, input, options = {}, deps = {}) {
  const roster = listTeamRoster(root);
  const target = resolveTarget(root, options);
  const frozen = loadFrozenState(root);
  const frozenPaths = Array.isArray(frozen && frozen.paths) ? frozen.paths : [];
  const nowText = safeRead(path.join(root, 'atris', 'now.md'));
  const coreText = safeRead(path.join(root, MEMORY_CORE_PATH));
  const briefQuery = String(input || (target.active && target.active.objective) || '').trim();
  const mapText = selectRelevantMapLines(root, briefQuery, 16);
  const wikiLines = selectRelevantWikiLines(root, briefQuery, 6);
  const rosterHint = readRosterHint(root);
  const trackRecord = seatTrackRecord(root);

  let boardPosts = [];
  if (briefQuery && !options.skipBoard) {
    const sw = deps.swarlo || swarlo;
    const health = await sw.hubHealth(target.server);
    if (health && health.ok) {
      const token = findTokenFor(target.lead, target, deps);
      if (token) {
        const res = await sw.fetchBriefing({
          server: target.server,
          hub: target.hub,
          task: briefQuery,
          limit: 6,
          scorer: 'tfidf',
          token,
        }).catch(() => null);
        if (res && res.ok && res.data && Array.isArray(res.data.posts)) {
          boardPosts = res.data.posts;
        }
      }
    }
  }

  let parsed = null;
  let mode = 'fallback';
  let engine = '';

  const askFn = deps.askModel || (!options.offline ? defaultAskModel : null);
  if (askFn) {
    const prompt = buildNaturalPlanPrompt({
      input: String(input || '').trim(),
      roster,
      nowText,
      coreText,
      mapText,
      wikiLines,
      rosterHint,
      trackRecord,
      activeSwarm: target.active,
      frozenPaths,
      boardPosts,
      explicitDuration: options.explicitDuration || null,
    });
    const ans = await askFn(root, prompt, {
      engineOverride: options.engine || '',
      timeoutMs: options.timeoutMs || PLANNER_TIMEOUT_MS,
    }).catch((err) => ({ ok: false, error: err.message }));
    if (ans && ans.ok) {
      const obj = parseJsonObject(ans.text);
      if (obj) {
        parsed = obj;
        mode = 'llm';
        engine = ans.engine || '';
      }
    }
  }

  if (!parsed) {
    // Minimal clean fallback when offline / no model — zero regex rules!
    const hasSeats = roster.length > 0;
    const lead = hasSeats ? (roster.some((m) => m.slug === 'coordinator') ? 'coordinator' : roster[0].slug) : 'atris';
    const workers = hasSeats ? roster.map((m) => m.slug).filter((s) => s !== lead && s !== 'strategist').slice(0, 2) : [];
    const objective = String(input || (target.active && target.active.objective) || 'work the active workspace queue').trim();
    parsed = {
      objective,
      duration_minutes: options.explicitDuration ? Math.round(options.explicitDuration.ms / 60000) : null,
      lead,
      workers,
      solo: !hasSeats || workers.length === 0,
      tier: 1,
      needs_human_yes: false,
      context_paths: [],
      tasks: [{ task_key: 'step-1', content: objective, depends_on: [] }],
      reason: hasSeats ? `offline fallback staffed ${lead} with ${workers.join(', ') || 'solo'}` : 'no team seats configured; running solo as atris',
    };
  }

  return {
    plan: normalizeNaturalPlan(parsed, {
      input,
      roster,
      activeSwarm: target.active,
      explicitDuration: options.explicitDuration || null,
      mode,
      engine,
    }),
    board_posts: boardPosts,
    frozen_paths: frozenPaths,
  };
}

// Higher-plane compressed briefing packet: Swarlo TF-IDF /briefing + MEMORY_CORE + MAP + frozen modules.
async function buildSwarmBrief(root, options = {}, deps = {}) {
  const sw = deps.swarlo || swarlo;
  const task = String(options.task || '').trim();
  if (!task) {
    return { ok: false, exitCode: 2, error: 'usage: atris swarm brief "<task>" [--as <member>] [--limit 10] [--scorer tfidf|regex]' };
  }

  const target = resolveTarget(root, options);
  const actor = String(options.as || target.lead || 'coordinator').trim().toLowerCase();
  const limit = Math.max(1, Math.min(30, Number(options.limit) || 10));
  const scorer = String(options.scorer || 'tfidf').trim().toLowerCase();

  const coreText = safeRead(path.join(root, MEMORY_CORE_PATH));
  const coreBullets = coreText.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith('- '));

  const mapText = safeRead(path.join(root, 'atris', 'MAP.md'));
  const mapRows = mapText.split(/\r?\n/).map((l) => l.trim())
    .filter((l) => l.startsWith('|') && !/^\|[-\s|]+\|$/.test(l) && !/^\|\s*Task\s*\|/i.test(l));

  // Simple token overlap on local static lines (not a classifier — Swarlo does TF-IDF on the board).
  const terms = [...new Set(task.toLowerCase().split(/[^a-z0-9._/-]+/).filter((w) => w.length >= 3))];
  const rankLocal = (lines, cap) => {
    const hits = lines
      .map((line) => ({ line, score: terms.reduce((s, w) => s + (line.toLowerCase().includes(w) ? 1 : 0), 0) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, cap)
      .map((x) => x.line);
    return hits;
  };

  const memoryCore = rankLocal(coreBullets, 5);
  const mapRoutes = rankLocal(mapRows, 6);
  const wikiPages = selectRelevantWikiLines(root, task, 5);
  const frozen = loadFrozenState(root);
  const frozenPaths = Array.isArray(frozen && frozen.paths) ? frozen.paths : [];

  const health = await sw.hubHealth(target.server);
  const hubReachable = Boolean(health && health.ok);
  let boardPosts = [];
  let extractedPaths = [];
  let extractedKeywords = [];
  if (hubReachable) {
    const token = findTokenFor(actor, target, deps);
    if (token) {
      const res = await sw.fetchBriefing({
        server: target.server,
        hub: target.hub,
        task,
        limit,
        scorer,
        token,
      });
      if (res.ok && res.data) {
        boardPosts = Array.isArray(res.data.posts) ? res.data.posts : [];
        extractedPaths = Array.isArray(res.data.extracted_paths) ? res.data.extracted_paths : [];
        extractedKeywords = Array.isArray(res.data.extracted_keywords) ? res.data.extracted_keywords : [];
      }
    }
  }

  const westCoast = classifyTaskEffort({ title: task });

  return {
    ok: true,
    exitCode: 0,
    task,
    scorer,
    hub_reachable: hubReachable,
    extracted_paths: extractedPaths,
    extracted_keywords: extractedKeywords,
    board_posts: boardPosts,
    memory_core: memoryCore.length ? memoryCore : coreBullets.slice(0, 5),
    map_routes: mapRoutes,
    wiki_pages: wikiPages,
    frozen_paths: frozenPaths,
    west_coast: westCoast,
  };
}

// LLM-first 3-tier routing decision + append-only trace row (.atris/state/coordination_trace.jsonl).
async function routeIntent(root, options = {}, deps = {}) {
  const sw = deps.swarlo || swarlo;
  const intent = String(options.intent || '').trim();
  if (!intent) {
    return { ok: false, exitCode: 2, error: 'usage: atris swarm route "<intent>" [--to <seat>] [--tier 1|2|3] [--task-key <key>] [--evidence <paths>] [--tried <text>]' };
  }

  const target = resolveTarget(root, options);
  const actor = String(options.as || target.lead || 'coordinator').trim().toLowerCase();

  let tier = [1, 2, 3].includes(Number(options.tier)) ? Number(options.tier) : null;
  let seat = String(options.to || '').trim().toLowerCase();
  if (!tier || !seat) {
    const planned = await planNaturalSwarm(root, intent, { ...options, skipBoard: true }, deps);
    const p = planned.plan;
    if (!tier) tier = p.tier;
    if (!seat) {
      if (tier === 3) seat = 'human';
      else if (tier === 2) seat = listTeamRoster(root).some((m) => m.slug === 'strategist') ? 'strategist' : p.lead;
      else seat = (p.workers && p.workers[0]) || p.lead || 'atris';
    }
  }

  const channel = options.channel || (tier >= 2 ? 'escalations' : target.channel);
  const evidence = Array.isArray(options.evidence) ? options.evidence : [];
  const tried = String(options.tried || '').trim();
  const taskKey = String(options.taskKey || '').trim() || null;

  let engine = 'human';
  if (seat !== 'human') {
    const picked = resolveEngineForMember(seat, root);
    engine = picked && picked.engine ? picked.engine.id : 'auto';
  }

  const briefParts = [`[tier ${tier} -> @${seat}] ${intent}`];
  if (taskKey) briefParts.push(`task: ${taskKey}`);
  if (evidence.length) briefParts.push(`evidence: ${evidence.join(', ')}`);
  if (tried) briefParts.push(`tried: ${tried}`);
  const briefLine = briefParts.join(' | ');

  let posted = false;
  if (!options.dryRun) {
    const health = await sw.hubHealth(target.server);
    if (health && health.ok) {
      const token = findTokenFor(actor, target, deps);
      if (token) {
        const res = await sw.postChannelNote({
          server: target.server,
          hub: target.hub,
          channel,
          content: briefLine,
          kind: tier >= 2 ? 'escalation' : 'message',
          token,
          memberId: actor,
          memberName: actor,
        });
        posted = Boolean(res && res.ok);
      }
    }
  }

  const row = {
    ts: new Date().toISOString(),
    id: `rt-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`,
    intent,
    tier,
    seat,
    engine,
    task_key: taskKey,
    evidence,
    tried: tried || null,
    channel,
    routed_by: actor,
    posted,
    outcome: 'pending',
    corrected_by: null,
  };

  if (!options.dryRun) {
    appendJsonl(path.join(root, TRACE_REL), row);
  }

  return {
    ok: true,
    exitCode: 0,
    ...row,
    brief: briefLine,
    trace_file: TRACE_REL,
  };
}

// Upward context funnel: sends compressed brief (intent, tier >= 2, evidence, tried) to #escalations.
async function escalateIntent(root, options = {}, deps = {}) {
  const intent = String(options.intent || '').trim();
  if (!intent) {
    return { ok: false, exitCode: 2, error: 'usage: atris swarm escalate "<intent>" --tried "<what failed>" [--tier 2|3] [--evidence <paths>]' };
  }
  const explicitTier = Number(options.tier);
  let tier = [2, 3].includes(explicitTier) ? explicitTier : null;
  let seat = String(options.to || '').trim().toLowerCase();
  if (!tier) {
    const planned = await planNaturalSwarm(root, intent, { ...options, skipBoard: true }, deps);
    tier = planned.plan.tier >= 2 ? planned.plan.tier : 2;
    if (!seat) {
      seat = tier === 3
        ? 'human'
        : (listTeamRoster(root).some((m) => m.slug === 'strategist') ? 'strategist' : planned.plan.lead);
    }
  }
  return routeIntent(root, {
    ...options,
    intent,
    tier,
    to: seat || options.to || '',
    channel: 'escalations',
    tried: String(options.tried || 'escalated without raw transcript').trim(),
  }, deps);
}

function normalizeErrorSignature(err) {
  return String(err || '')
    .toLowerCase()
    .replace(/\b\d{4}-\d{2}-\d{2}t[\d:.z+-]+\b/g, '<ts>')
    .replace(/\b\d+\b/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
}

function envWithNodeDir(extra = {}) {
  const nodeDir = path.dirname(process.execPath);
  const curPath = String(process.env.PATH || '');
  const nextPath = curPath.split(path.delimiter).includes(nodeDir)
    ? curPath
    : (curPath ? `${nodeDir}${path.delimiter}${curPath}` : nodeDir);
  return { ...process.env, PATH: nextPath, ...extra };
}

function resolveBaseMember(seat, swarm) {
  const id = String(seat || '').trim().toLowerCase();
  if (swarm && Array.isArray(swarm.members)) {
    const found = swarm.members.find((m) => m && m.member === id && m.base_member);
    if (found) return String(found.base_member).trim().toLowerCase();
  }
  const clone = id.match(/^([a-z0-9][a-z0-9._-]*)-(\d+)$/);
  return clone ? clone[1] : id;
}

function spawnAsync(cmd, args, { cwd, env, timeoutMs = 10 * 60 * 1000, shell = false, activeChildren = null } = {}) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let done = false;
    let timer = null;
    let child = null;
    const finish = (payload) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      if (activeChildren && child) activeChildren.delete(child);
      resolve(payload);
    };
    try {
      child = spawn(cmd, args, { cwd, env, shell, stdio: ['ignore', 'pipe', 'pipe'] });
      if (activeChildren) activeChildren.add(child);
    } catch (error) {
      return finish({ ok: false, exitCode: 1, stdout: '', stderr: '', error: error.message || String(error) });
    }
    child.stdout.on('data', (d) => { stdout += d.toString('utf8'); if (stdout.length > 65536) stdout = stdout.slice(-65536); });
    child.stderr.on('data', (d) => { stderr += d.toString('utf8'); if (stderr.length > 65536) stderr = stderr.slice(-65536); });
    child.on('error', (err) => finish({ ok: false, exitCode: 1, stdout, stderr, error: err.message || String(err) }));
    child.on('close', (code) => finish({
      ok: code === 0,
      exitCode: code == null ? 1 : code,
      stdout,
      stderr,
      error: code === 0 ? null : (`${stdout}\n${stderr}`.trim().slice(-320) || `command exited ${code}`),
    }));
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        try { child.kill('SIGTERM'); } catch {}
        setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 1500).unref();
        finish({ ok: false, exitCode: 124, stdout, stderr, error: `step timed out after ${Math.round(timeoutMs / 1000)}s` });
      }, timeoutMs);
      timer.unref();
    }
  });
}

async function runShellStepAsync(cwd, cmd, { env = {}, timeoutMs = 10 * 60 * 1000, activeChildren = null } = {}) {
  const res = await spawnAsync(String(cmd), [], {
    shell: true,
    cwd,
    timeoutMs,
    activeChildren,
    env: envWithNodeDir(env),
  });
  const tail = `${res.stdout || ''}\n${res.stderr || ''}`.trim().slice(-320);
  if (!res.ok) {
    return { ok: false, exitCode: res.exitCode, summary: '', error: res.error || tail || `command exited ${res.exitCode}` };
  }
  return { ok: true, exitCode: 0, summary: tail || 'step passed', error: null };
}

async function defaultDispatchMemberAsync(root, { member, timeoutMs = 10 * 60 * 1000, activeChildren = null } = {}) {
  const bin = path.join(__dirname, '..', 'bin', 'atris.js');
  const res = await spawnAsync(process.execPath, [bin, 'member', 'go', member, '--needs-check'], {
    cwd: root,
    timeoutMs,
    activeChildren,
    env: envWithNodeDir({
      ATRIS_AGENT_PROOF_ONLY: '1',
      ATRIS_SKIP_UPDATE_CHECK: '1',
    }),
  });
  const tail = `${res.stdout || ''}\n${res.stderr || ''}`.trim().slice(-320);
  if (res.exitCode === 75) {
    return { ok: true, idle: true, summary: 'no runnable task', error: null };
  }
  if (res.ok) {
    return { ok: true, idle: false, summary: tail || `${member} completed task`, error: null };
  }
  return { ok: false, idle: false, summary: '', error: res.error || tail || `member go exited ${res.exitCode}` };
}

// Built-in autonomous mission worker: reuses existing `atris mission start` +
// `atris mission run --complete-on-pass` with isolated `--worktree`, `--runner auto`,
// clean objective (never stuffing MAP/MEMORY_CORE words that falsely trip approval
// gates), and JSON completion-status verification (never false-green on paused runs).
async function defaultRunMissionWorker(root, {
  member, baseMember, task, swarm, verify = '', maxTicks = 4, timeoutMs = 15 * 60 * 1000, engine = '', activeChildren = null,
}) {
  const bin = path.join(__dirname, '..', 'bin', 'atris.js');
  const owner = baseMember || member || 'builder';
  const requestedId = `swm-${Date.now().toString(36)}-${crypto.randomBytes(2).toString('hex')}`;
  let objective = String((task && task.content) || (swarm && swarm.objective) || 'complete swarm step').trim();
  if (objective.startsWith('-')) objective = `Task: ${objective}`;
  objective = objective.slice(0, 600);

  const env = envWithNodeDir({
    ATRIS_AGENT_PROOF_ONLY: '1',
    ATRIS_SKIP_UPDATE_CHECK: '1',
  });
  const startArgs = [
    bin, 'mission', 'start', objective,
    '--mission-id', requestedId,
    '--owner', owner,
    '--runner', String(engine || 'auto'),
    '--worktree',
    '--duplicate',
    '--max-wall', String(Math.max(60, Math.round(timeoutMs / 1000))),
    '--json',
  ];
  if (verify) startArgs.push('--verify', String(verify));
  else startArgs.push('--no-verify');

  const started = await spawnAsync(process.execPath, startArgs, { cwd: root, env, timeoutMs: 60 * 1000, activeChildren });
  if (!started.ok) {
    return { ok: false, summary: '', error: `mission start failed: ${started.error || started.stderr.slice(-200)}` };
  }
  const startJson = parseJsonObject(started.stdout);
  const missionId = String((startJson && ((startJson.mission && startJson.mission.id) || startJson.id || startJson.mission_id)) || requestedId);

  const runArgs = [
    bin, 'mission', 'run', missionId,
    '--max-ticks', String(Math.max(1, Number(maxTicks) || 4)),
    '--complete-on-pass',
    '--json',
  ];
  const ran = await spawnAsync(process.execPath, runArgs, { cwd: root, env, timeoutMs, activeChildren });
  const runJson = parseJsonObject(ran.stdout);
  const finalStatus = String(
    (runJson && ((runJson.mission && runJson.mission.status) || runJson.status || runJson.final_status || runJson.stop_reason)) || '',
  ).toLowerCase();
  const completed = ran.ok && (
    ['complete', 'completed', 'done'].includes(finalStatus)
    || Boolean(runJson && (runJson.completed === true || runJson.passed === true || (runJson.mission && runJson.mission.status === 'complete')))
  );

  if (!completed) {
    const why = (runJson && (runJson.stop_reason || runJson.error || runJson.reason || runJson.status))
      || ran.error
      || `mission ${missionId} did not complete (exit ${ran.exitCode})`;
    await spawnAsync(process.execPath, [bin, 'mission', 'stop', missionId, '--reason', `swarm worker ended: ${String(why).slice(0, 120)}`], {
      cwd: root, env, timeoutMs: 30 * 1000, activeChildren,
    }).catch(() => null);
    return { ok: false, summary: '', error: String(why), mission_id: missionId };
  }

  const summary = (runJson && (runJson.summary || (runJson.mission && runJson.mission.summary)))
    || `mission ${missionId} completed`;
  return { ok: true, summary: String(summary).slice(0, 240), error: null, mission_id: missionId, self_verified: Boolean(verify) };
}

function createIsolatedWorktree(root, runId, taskKey) {
  const gitCheck = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: root, encoding: 'utf8' });
  if (gitCheck.status !== 0) return { path: root, isolated: false, branch: null, baseHead: null };
  const headRes = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
  if (headRes.status !== 0) return { path: root, isolated: false, branch: null, baseHead: null };
  const baseHead = String(headRes.stdout || '').trim();
  const slug = String(taskKey || 'step').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').slice(0, 28);
  const suffix = crypto.randomBytes(2).toString('hex');
  const branch = `swarm/${runId}-${slug}-${suffix}`;
  const wtDir = path.join(root, '.atris', 'swarm-worktrees', `${runId}-${slug}-${suffix}`);
  fs.mkdirSync(path.dirname(wtDir), { recursive: true });
  const added = spawnSync('git', ['worktree', 'add', '-b', branch, '-q', wtDir, baseHead], { cwd: root, encoding: 'utf8' });
  if (added.status !== 0) return { path: root, isolated: false, branch: null, baseHead: null };
  return { path: wtDir, isolated: true, branch, baseHead };
}

function isAtrisInternalPath(filePath) {
  const normalized = String(filePath || '').replace(/\\/g, '/').replace(/\/+$/, '');
  return normalized === '.atris' || normalized.startsWith('.atris/');
}

function parsePorcelainDirtyPaths(stdout) {
  const entries = String(stdout || '').split('\0');
  const paths = [];
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    if (!entry || entry.length < 4) continue;
    const status = entry.slice(0, 2);
    const filePath = entry.slice(3);
    if (filePath) paths.push(filePath);
    if (status[0] === 'R' || status[0] === 'C' || status[1] === 'R' || status[1] === 'C') {
      i += 1;
      const origPath = entries[i];
      if (origPath) paths.push(origPath);
    }
  }
  return [...new Set(paths)];
}

// Preserve verified work on its named branch before cleaning the scratch worktree.
// If no changes or commits were produced (or the turn failed), drop the temp branch too.
function finalizeIsolatedWorktree(root, wt, { preserve = false, member = 'worker', taskKey = 'step' } = {}) {
  if (!wt || !wt.isolated || !wt.path || path.resolve(wt.path) === path.resolve(root)) {
    return { branch: null, commit: null };
  }
  let savedBranch = null;
  let savedCommit = null;
  let preserveError = null;
  try {
    if (preserve && wt.branch) {
      const dirty = spawnSync('git', ['status', '--porcelain', '-z', '-uall'], { cwd: wt.path, encoding: 'utf8' });
      if (dirty.status !== 0) {
        preserveError = `git status failed in isolated worktree: ${String(dirty.stderr || dirty.stdout || `exit ${dirty.status}`).trim()}`;
      } else {
        const allDirtyPaths = parsePorcelainDirtyPaths(dirty.stdout);
        const nonAtrisPaths = allDirtyPaths.filter((p) => !isAtrisInternalPath(p));
        const hasAtrisDirty = allDirtyPaths.some(isAtrisInternalPath);
        if (nonAtrisPaths.length > 0) {
          for (let i = 0; i < nonAtrisPaths.length; i += 500) {
            const chunk = nonAtrisPaths.slice(i, i + 500);
            const added = spawnSync('git', ['add', '-A', '--', ...chunk], { cwd: wt.path, encoding: 'utf8' });
            if (added.status !== 0) {
              preserveError = `git add failed in isolated worktree: ${String(added.stderr || added.stdout || `exit ${added.status}`).trim()}`;
              break;
            }
          }
          if (!preserveError && hasAtrisDirty) {
            spawnSync('git', ['reset', '-q', 'HEAD', '--', '.atris'], { cwd: wt.path, encoding: 'utf8' });
          }
          if (!preserveError) {
            const stagedCheck = spawnSync('git', ['diff', '--cached', '--quiet'], { cwd: wt.path, encoding: 'utf8' });
            if (stagedCheck.status === 1) {
              const hasName = spawnSync('git', ['config', '--get', 'user.name'], { cwd: wt.path, encoding: 'utf8' });
              const hasEmail = spawnSync('git', ['config', '--get', 'user.email'], { cwd: wt.path, encoding: 'utf8' });
              const commitArgs = [];
              if (hasName.status !== 0 || !String(hasName.stdout || '').trim()) commitArgs.push('-c', 'user.name=atris-swarm');
              if (hasEmail.status !== 0 || !String(hasEmail.stdout || '').trim()) commitArgs.push('-c', 'user.email=swarm@atris.local');
              commitArgs.push('commit', '-q', '-m', `swarm(${member}): ${taskKey}`);
              const committed = spawnSync('git', commitArgs, { cwd: wt.path, encoding: 'utf8' });
              if (committed.status !== 0) {
                preserveError = `git commit failed in isolated worktree: ${String(committed.stderr || committed.stdout || `exit ${committed.status}`).trim()}`;
              }
            } else if (stagedCheck.status !== 0) {
              preserveError = `git diff --cached failed in isolated worktree: ${String(stagedCheck.stderr || stagedCheck.stdout || `exit ${stagedCheck.status}`).trim()}`;
            }
          }
        }
      }
      if (!preserveError) {
        const curHeadRes = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: wt.path, encoding: 'utf8' });
        if (curHeadRes.status !== 0) {
          preserveError = `git rev-parse HEAD failed in isolated worktree: ${String(curHeadRes.stderr || curHeadRes.stdout || `exit ${curHeadRes.status}`).trim()}`;
        } else {
          const curHead = String(curHeadRes.stdout || '').trim();
          if (curHead && curHead !== wt.baseHead) {
            savedBranch = wt.branch;
            savedCommit = curHead;
          }
        }
      }
    }
  } finally {
    if (!preserveError) {
      const removed = spawnSync('git', ['worktree', 'remove', '--force', wt.path], { cwd: root, encoding: 'utf8' });
      if (removed.status !== 0) {
        try { fs.rmSync(wt.path, { recursive: true, force: true }); } catch {}
        spawnSync('git', ['worktree', 'prune'], { cwd: root, encoding: 'utf8' });
      }
      if (!savedBranch && wt.branch) {
        spawnSync('git', ['branch', '-D', wt.branch], { cwd: root, encoding: 'utf8' });
      }
    }
  }
  if (preserveError) {
    return { branch: null, commit: null, preserve_error: preserveError };
  }
  return { branch: savedBranch, commit: savedCommit };
}

function startClaimHeartbeat({ sw, target, channel, member, taskKey, token, intervalMs = 60 * 1000 }) {
  if (!sw || typeof sw.touchClaimNote !== 'function' || !token || !taskKey) {
    return () => {};
  }
  const timer = setInterval(() => {
    sw.touchClaimNote({
      server: target.server,
      hub: target.hub,
      channel: channel || target.channel,
      taskKey,
      token,
      memberId: member,
      memberName: member,
    }).catch(() => null);
  }, Math.max(5000, intervalMs));
  timer.unref();
  return () => clearInterval(timer);
}

// Local persisted queue fallback in .atris/state/swarm.json when Swarlo is offline.
// Propagates upstream failures to `blocked_failed` so downstream tasks never deadlock forever.
function pullNextLocalTask(root, member) {
  let claimed = null;
  let waitingCount = 0;
  updateSwarmState(root, (state) => {
    const queue = Array.isArray(state.queue) ? state.queue.map((t) => ({ ...t })) : [];
    const statusByKey = new Map(queue.map((t) => [t.task_key, t.status]));

    // Cascade failed/unrunnable upstream dependencies to blocked_failed.
    let changed = true;
    while (changed) {
      changed = false;
      for (const item of queue) {
        if (item.status !== 'open') continue;
        const deps = Array.isArray(item.depends_on) ? item.depends_on : [];
        if (deps.some((d) => ['failed', 'blocked_failed'].includes(statusByKey.get(d)))) {
          item.status = 'blocked_failed';
          statusByKey.set(item.task_key, 'blocked_failed');
          changed = true;
        }
      }
    }

    for (const item of queue) {
      if (item.status !== 'open') continue;
      const deps = Array.isArray(item.depends_on) ? item.depends_on : [];
      if (deps.every((d) => statusByKey.get(d) === 'done')) {
        item.status = 'claimed';
        item.owner = member;
        claimed = { ...item };
        break;
      }
      waitingCount += 1;
    }
    return { ...state, queue };
  });
  return { claimed, blockedCount: waitingCount };
}

function finishLocalTask(root, taskKey, status) {
  updateSwarmState(root, (state) => {
    const queue = Array.isArray(state.queue) ? state.queue.map((t) => (
      t.task_key === taskKey ? { ...t, status, finished_at: new Date().toISOString() } : t
    )) : [];
    return { ...state, queue };
  });
}

function candidateSeats(swarm) {
  if (swarm && Array.isArray(swarm.workers) && swarm.workers.length) return swarm.workers.slice();
  if (swarm && swarm.lead) return [swarm.lead];
  return ['atris'];
}

function rotateSeats(seats, offset) {
  if (!seats.length) return [];
  const start = ((offset % seats.length) + seats.length) % seats.length;
  return [...seats.slice(start), ...seats.slice(0, start)];
}

async function runSingleClaimedTask(root, {
  seat, baseMember, task, pulled, fromLocalQueue, swarm, target, cycle, runId, options, deps, activeChildren = null, diagnosis = null,
}) {
  const sw = deps.swarlo || swarlo;
  const timeoutMs = Math.max(1000, Number(options.stepTimeoutMs) || 10 * 60 * 1000);
  const keyPrefix = runId ? `swarm-loop-${runId}-${cycle}` : `swarm-loop-${cycle}`;
  const taskChannel = (task && task.channel) || options.channel || target.channel || DEFAULT_CHANNEL;

  const brief = await buildSwarmBrief(root, {
    task: task.content || task.task_key,
    as: seat,
    hub: options.hub || '',
    server: options.server || '',
    home: options.home,
  }, deps).catch(() => null);

  const westCoast = (brief && brief.west_coast) || classifyTaskEffort(task);
  if (diagnosis && brief) brief.diagnosis = diagnosis;

  const token = pulled ? findTokenFor(seat, target, deps) : '';
  const stopHeartbeat = pulled
    ? startClaimHeartbeat({ sw, target, channel: taskChannel, member: seat, taskKey: task.task_key, token, intervalMs: options.heartbeatMs || 60 * 1000 })
    : () => {};

  const useIsolated = Boolean(options.exec) && !options.inPlace && options.isolated !== false && typeof deps.runWorker !== 'function';
  let wt = { path: root, isolated: false, branch: null, baseHead: null };
  let stepRes;
  let finalOk = false;
  let finalError = null;
  let blockedBy = null;
  let reviewed = false;
  let savedWork = { branch: null, commit: null };
  let worktreeFinalized = false;

  try {
    wt = useIsolated ? createIsolatedWorktree(root, runId, task.task_key) : wt;
    const workDir = wt.path;

    try {
      if (typeof deps.runWorker === 'function') {
        const raw = await deps.runWorker({ root, workDir, member: seat, baseMember, task, brief, swarm, cycle, westCoast, diagnosis });
        stepRes = {
          ok: Boolean(raw && raw.ok !== false),
          summary: String((raw && raw.summary) || '').trim(),
          error: raw && raw.ok === false ? String(raw.error || 'worker returned ok=false') : null,
        };
      } else if (options.exec) {
        stepRes = await runShellStepAsync(workDir, options.exec, {
          timeoutMs,
          activeChildren,
          env: {
            ATRIS_AGENT_PROOF_ONLY: '1',
            SWARM_MEMBER: seat,
            SWARM_BASE_MEMBER: baseMember,
            SWARM_TASK_KEY: task.task_key,
            SWARM_TASK_CONTENT: task.content,
            SWARM_OBJECTIVE: (swarm && swarm.objective) || '',
            SWARM_THINKING_EFFORT: westCoast.effort,
            SWARM_WEIGHT_CLASS: westCoast.weight_class,
            ...(diagnosis && diagnosis.diagnosis ? { SWARM_DIAGNOSIS: diagnosis.diagnosis.slice(0, 2000) } : {}),
            SWARM_BRIEF_JSON: JSON.stringify({
              board_posts: ((brief && brief.board_posts) || []).slice(0, 4),
              memory_core: ((brief && brief.memory_core) || []).slice(0, 5),
              wiki_pages: ((brief && brief.wiki_pages) || []).slice(0, 4),
              frozen_paths: (brief && brief.frozen_paths) || [],
              west_coast: westCoast,
              ...(diagnosis && diagnosis.diagnosis ? { diagnosis: diagnosis.diagnosis.slice(0, 1200) } : {}),
            }),
          },
        });
      } else {
        const missionFn = deps.runMission || defaultRunMissionWorker;
        stepRes = await missionFn(root, {
          member: seat,
          baseMember,
          task,
          brief,
          swarm,
          verify: options.verify || task.verify || '',
          maxTicks: options.maxTicks || 4,
          timeoutMs,
          engine: options.engine || '',
          activeChildren,
        });
      }
    } catch (err) {
      stepRes = { ok: false, summary: '', error: err && err.message ? err.message : String(err) };
    }

    finalOk = Boolean(stepRes.ok);
    finalError = stepRes.error || null;

    // Check frozen modules from `root`'s swarm-frozen.json against BOTH `root` and `workDir`.
    const checkDirs = [root];
    if (workDir !== root) checkDirs.push(workDir);
    let frozenAfter = { ok: true, changed: [] };
    for (const dir of checkDirs) {
      const chk = await freezeModules(root, [], { check: true, targetDir: dir }, deps);
      if (!chk.ok) {
        frozenAfter = chk;
        break;
      }
    }

    if (!frozenAfter.ok) {
      finalOk = false;
      blockedBy = 'frozen_modules';
      finalError = frozenAfter.changed && frozenAfter.changed.length
        ? `refused to report done: frozen module(s) modified (${frozenAfter.changed.join(', ')})`
        : `refused to report done: frozen module check failed (${frozenAfter.error || 'unknown error'})`;
      if (pulled) {
        await reportSwarmTask(root, {
          taskKey: task.task_key,
          status: 'failed',
          content: finalError,
          as: seat,
          idempotencyKey: `${keyPrefix}-${task.task_key}-frozen-fail`,
          channel: taskChannel,
          hub: options.hub || '',
          server: options.server || '',
          home: options.home,
        }, deps).catch(() => null);
      } else if (fromLocalQueue) {
        finishLocalTask(root, task.task_key, 'failed');
      }
    } else {
      if (finalOk && typeof deps.reviewTurn === 'function') {
        const rev = await deps.reviewTurn({ root, workDir, member: seat, task, step: stepRes, swarm, cycle }).catch((e) => ({ ok: false, error: e.message }));
        reviewed = true;
        if (!rev || rev.ok === false) {
          finalOk = false;
          blockedBy = 'review_rejected';
          finalError = (rev && rev.error) || 'independent review rejected change';
        }
      }

      const verifyToRun = stepRes && stepRes.self_verified ? '' : (options.verify || task.verify || '');
      if (wt.isolated) {
        if (finalOk && verifyToRun) {
          const verified = await runShellStepAsync(workDir, verifyToRun, { timeoutMs, activeChildren });
          if (!verified.ok) {
            finalOk = false;
            blockedBy = 'verify_failed';
            finalError = `verify command failed (exit ${verified.exitCode}): ${verifyToRun}`;
          }
        }
        if (finalOk) {
          savedWork = finalizeIsolatedWorktree(root, wt, { preserve: true, member: seat, taskKey: task.task_key });
          worktreeFinalized = true;
          if (savedWork.preserve_error) {
            finalOk = false;
            blockedBy = 'worktree_preserve_failed';
            finalError = savedWork.preserve_error;
          }
        }
      }
      if (pulled) {
        const rep = await reportSwarmTask(root, {
          taskKey: task.task_key,
          status: finalOk ? 'done' : 'failed',
          content: finalOk ? (stepRes.summary || `completed ${task.task_key}`) : (finalError || `failed ${task.task_key}`),
          as: seat,
          verify: (finalOk && !wt.isolated) ? verifyToRun : '',
          verifyCwd: wt.isolated ? root : workDir,
          idempotencyKey: `${keyPrefix}-${task.task_key}`,
          channel: taskChannel,
          hub: options.hub || '',
          server: options.server || '',
          home: options.home,
        }, deps);
        if (!rep.ok) {
          finalOk = false;
          finalError = rep.error || 'report failed';
          blockedBy = rep.blocked_by || null;
          if (blockedBy === 'verify_failed' || blockedBy === 'frozen_modules') {
            await reportSwarmTask(root, {
              taskKey: task.task_key,
              status: 'failed',
              content: finalError,
              as: seat,
              idempotencyKey: `${keyPrefix}-${task.task_key}-${blockedBy}`,
              channel: taskChannel,
              hub: options.hub || '',
              server: options.server || '',
              home: options.home,
            }, deps).catch(() => null);
          }
        }
      } else {
        if (!wt.isolated && finalOk && verifyToRun) {
          const verified = await runShellStepAsync(workDir, verifyToRun, { timeoutMs, activeChildren });
          if (!verified.ok) {
            finalOk = false;
            blockedBy = 'verify_failed';
            finalError = `verify command failed (exit ${verified.exitCode}): ${verifyToRun}`;
          }
        }
        if (fromLocalQueue) {
          finishLocalTask(root, task.task_key, finalOk ? 'done' : 'failed');
        }
      }
    }
  } finally {
    stopHeartbeat();
    if (wt.isolated && !worktreeFinalized) {
      savedWork = finalizeIsolatedWorktree(root, wt, { preserve: finalOk, member: seat, taskKey: task.task_key });
    }
  }

  // Honest grading (builder-green-is-not-reviewed): only mark accepted after independent review.
  const traceOutcome = !finalOk ? 'failed' : (reviewed ? 'accepted' : 'review_pending');
  appendJsonl(path.join(root, TRACE_REL), {
    ts: new Date().toISOString(),
    id: `rt-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`,
    intent: task.content || task.task_key,
    tier: 1,
    seat,
    engine: options.engine || (options.exec ? 'shell-exec' : 'swarm-worker'),
    task_key: task.task_key,
    evidence: (brief && brief.map_routes) ? brief.map_routes.slice(0, 3) : [],
    tried: finalOk ? null : finalError,
    channel: taskChannel,
    routed_by: (swarm && swarm.lead) || seat,
    posted: Boolean(pulled),
    outcome: traceOutcome,
    corrected_by: null,
  });

  return {
    ran: true,
    idle: false,
    queue_empty: false,
    member: seat,
    base_member: baseMember,
    task_key: task.task_key,
    ok: finalOk,
    reviewed,
    isolated: wt.isolated,
    branch: savedWork.branch,
    commit: savedWork.commit,
    blocked_by: blockedBy,
    summary: finalOk ? (stepRes.summary || `completed ${task.task_key}`) : '',
    error: finalOk ? null : finalError,
  };
}

// Execute up to `parallel` unblocked tasks concurrently across rotated seats.
async function executeSwarmWave(root, { snap, cycle, seatIndex, runId = '', options, deps, activeChildren = null, diagnosis = null }) {
  const swarm = (snap && snap.swarm) || loadSwarmState(root);
  const seats = rotateSeats(candidateSeats(swarm), seatIndex);
  const target = resolveTarget(root, options);
  const timeoutMs = Math.max(1000, Number(options.stepTimeoutMs) || 10 * 60 * 1000);
  const hubOnline = Boolean(snap && snap.hub && snap.hub.reachable);
  const defaultParallel = options.inPlace ? 1 : Math.min(seats.length, 3);
  const concurrency = Math.max(1, Math.min(Number(options.parallel) || defaultParallel, seats.length));

  // Dispatch mode reuses existing `atris member go <baseMember> --needs-check`,
  // mapping numbered clones (builder-1 -> builder) and checking every runnable seat.
  if (options.dispatch && !options.exec && typeof deps.runWorker !== 'function' && options.mission !== true) {
    const roster = new Set(listTeamRoster(root).map((m) => m.slug));
    const seenBases = new Set();
    const runnablePairs = [];
    for (const seat of seats) {
      const base = resolveBaseMember(seat, swarm);
      if (roster.has(base) && !seenBases.has(base)) {
        seenBases.add(base);
        runnablePairs.push({ seat, base });
      }
    }
    if (!runnablePairs.length) {
      return {
        steps: [{ ran: false, idle: true, queue_empty: true, member: seats[0] || 'atris', task_key: null, ok: true, summary: 'no team member card to dispatch', error: null }],
        ran_count: 0, succeeded_count: 0, failed_count: 0, queue_empty: true, blocked_by: null, next_seat_index: seatIndex + 1,
      };
    }
    const dispatchFn = deps.dispatchMember || defaultDispatchMemberAsync;
    let ranStep = null;
    for (const pair of runnablePairs) {
      const out = await dispatchFn(root, { member: pair.base, timeoutMs, activeChildren });
      if (!out.idle) {
        let finalOk = Boolean(out.ok);
        let finalError = out.error || null;
        let blockedBy = null;
        const frozenAfter = await freezeModules(root, [], { check: true }, deps);
        if (!frozenAfter.ok) {
          finalOk = false;
          blockedBy = 'frozen_modules';
          finalError = frozenAfter.changed && frozenAfter.changed.length
            ? `frozen module(s) modified (${frozenAfter.changed.join(', ')})`
            : `frozen module check failed (${frozenAfter.error || 'unknown error'})`;
        } else if (finalOk && options.verify) {
          const verified = await runShellStepAsync(root, options.verify, { timeoutMs, activeChildren });
          if (!verified.ok) {
            finalOk = false;
            blockedBy = 'verify_failed';
            finalError = `verify command failed (exit ${verified.exitCode}): ${options.verify}`;
          }
        }
        appendJsonl(path.join(root, TRACE_REL), {
          ts: new Date().toISOString(),
          id: `rt-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`,
          intent: (swarm && swarm.objective) || `dispatch ${pair.base}`,
          tier: 1,
          seat: pair.base,
          engine: options.engine || 'member-go',
          task_key: null,
          evidence: [],
          tried: finalOk ? null : finalError,
          channel: options.channel || (swarm && swarm.channel) || DEFAULT_CHANNEL,
          routed_by: (swarm && swarm.lead) || pair.base,
          posted: false,
          outcome: finalOk ? 'review_pending' : 'failed',
          corrected_by: null,
        });
        ranStep = {
          ran: true,
          idle: false,
          queue_empty: false,
          member: pair.seat,
          base_member: pair.base,
          task_key: null,
          ok: finalOk,
          reviewed: false,
          blocked_by: blockedBy,
          summary: finalOk ? (out.summary || `${pair.base} completed task`) : '',
          error: finalOk ? null : finalError,
        };
        break;
      }
    }
    if (!ranStep) {
      return {
        steps: [{ ran: false, idle: true, queue_empty: true, member: runnablePairs[0].seat, task_key: null, ok: true, summary: 'no runnable task for any seat', error: null }],
        ran_count: 0, succeeded_count: 0, failed_count: 0, queue_empty: true, blocked_by: null, next_seat_index: seatIndex + 1,
      };
    }
    return {
      steps: [ranStep],
      ran_count: 1,
      succeeded_count: ranStep.ok ? 1 : 0,
      failed_count: ranStep.ok ? 0 : 1,
      queue_empty: false,
      blocked_by: ranStep.blocked_by,
      next_seat_index: seatIndex + 1,
    };
  }

  // Claim up to `concurrency` distinct unblocked tasks sequentially (race-free),
  // then execute the whole wave concurrently via Promise.allSettled.
  const assignments = [];
  const blockedKeys = new Set();
  const pullErrors = [];

  if (hubOnline) {
    for (const seat of seats) {
      if (assignments.length >= concurrency) break;
      const attempt = await pullSwarmTask(root, {
        as: seat,
        channel: options.channel || '',
        hub: options.hub || '',
        server: options.server || '',
        home: options.home,
      }, deps);
      if (attempt && attempt.claimed && attempt.task) {
        assignments.push({
          seat,
          baseMember: resolveBaseMember(seat, swarm),
          task: attempt.task,
          pulled: attempt,
          fromLocalQueue: false,
        });
      } else if (attempt && attempt.ok === false && attempt.error) {
        pullErrors.push(`${seat}: ${attempt.error}`);
      } else if (attempt && Array.isArray(attempt.blocked)) {
        for (const b of attempt.blocked) if (b && b.task_key) blockedKeys.add(b.task_key);
      }
    }
  } else {
    const hasLocalQueue = Boolean(swarm && Array.isArray(swarm.queue) && swarm.queue.length);
    if (hasLocalQueue) {
      for (const seat of seats) {
        if (assignments.length >= concurrency) break;
        const local = pullNextLocalTask(root, seat);
        if (local.claimed) {
          assignments.push({
            seat,
            baseMember: resolveBaseMember(seat, swarm),
            task: local.claimed,
            pulled: null,
            fromLocalQueue: true,
          });
        } else {
          if (local.blockedCount > 0) blockedKeys.add(`local:${local.blockedCount}`);
          break;
        }
      }
    } else if (options.allowLocalStep !== false) {
      assignments.push({
        seat: seats[0] || 'atris',
        baseMember: resolveBaseMember(seats[0] || 'atris', swarm),
        task: { task_key: `local-cycle-${cycle}`, content: (swarm && swarm.objective) || 'bounded workspace improvement step', depends_on: [] },
        pulled: null,
        fromLocalQueue: false,
      });
    }
  }

  const blockedCount = blockedKeys.size;
  if (!assignments.length) {
    return {
      steps: [{
        ran: false,
        idle: true,
        queue_empty: blockedCount === 0,
        blocked_count: blockedCount,
        member: seats[0] || 'atris',
        task_key: null,
        ok: pullErrors.length === 0,
        summary: pullErrors.length
          ? `pull error: ${pullErrors[0]}`
          : (blockedCount ? `${blockedCount} task(s) blocked on dependencies` : 'no claimable tasks'),
        error: pullErrors.length ? pullErrors[0] : null,
      }],
      ran_count: 0,
      succeeded_count: 0,
      failed_count: 0,
      queue_empty: blockedCount === 0,
      blocked_by: null,
      next_seat_index: seatIndex + 1,
    };
  }

  const settled = await Promise.allSettled(
    assignments.map((a) => runSingleClaimedTask(root, { ...a, swarm, target, cycle, runId, options, deps, activeChildren, diagnosis })),
  );
  const steps = settled.map((res, idx) => (
    res.status === 'fulfilled'
      ? res.value
      : {
        ran: true,
        idle: false,
        queue_empty: false,
        member: assignments[idx].seat,
        task_key: assignments[idx].task.task_key,
        ok: false,
        reviewed: false,
        blocked_by: null,
        summary: '',
        error: (res.reason && res.reason.message) || String(res.reason || 'worker rejected'),
      }
  ));

  const ranSteps = steps.filter((s) => s.ran);
  const succeeded = ranSteps.filter((s) => s.ok).length;
  const failed = ranSteps.length - succeeded;
  const frozenHit = steps.find((s) => s.blocked_by === 'frozen_modules');
  return {
    steps,
    ran_count: ranSteps.length,
    succeeded_count: succeeded,
    failed_count: failed,
    queue_empty: false,
    blocked_by: frozenHit ? 'frozen_modules' : null,
    next_seat_index: seatIndex + assignments.length,
  };
}

// Bounded autonomous swarm loop (`atris swarm up 23 min`).
// Watches hub liveness + frozen modules each cycle, runs parallel worker waves
// when --mission / --exec / --dispatch / deps.runWorker is active, halts early
// on frozen-module tampering or repeated errors (with upward escalation), and
// runs offline dreaming consolidation when the clock ends.
async function runSwarmUpLoop(root, options = {}, deps = {}) {
  const nowFn = typeof deps.now === 'function' ? deps.now : () => Date.now();
  const customSleep = typeof deps.sleep === 'function' ? deps.sleep : null;
  const durationMs = Math.max(1000, Number(options.durationMs) || 3600 * 1000);
  const label = String(options.label || `${Math.round(durationMs / 60000)}m`);
  const intervalMs = Math.max(1000, Number(options.intervalMs) || Math.min(DEFAULT_INTERVAL_MS, durationMs));
  const maxCycles = (options.once || options.dryRun) ? 1 : (Number(options.maxCycles) > 0 ? Number(options.maxCycles) : Infinity);
  const maxRepeatErrors = Math.max(1, Number(options.maxRepeatErrors) || 2);
  const canExecute = !options.dryRun && !options.watchOnly
    && (typeof deps.runWorker === 'function' || Boolean(options.exec) || Boolean(options.dispatch) || options.mission === true);
  const log = options.log || (() => {});
  const startMs = nowFn();
  const deadlineMs = startMs + durationMs;
  const runId = `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;

  let stopped = false;
  let activeTimer = null;
  let activeWake = null;
  const activeChildren = new Set();
  const sleepWithStop = (ms) => {
    if (customSleep) return customSleep(ms);
    return new Promise((resolve) => {
      if (stopped) return resolve();
      activeWake = () => {
        if (activeTimer) {
          clearTimeout(activeTimer);
          activeTimer = null;
        }
        activeWake = null;
        resolve();
      };
      activeTimer = setTimeout(activeWake, ms);
    });
  };
  const onStop = () => {
    stopped = true;
    for (const child of activeChildren) {
      try { child.kill('SIGTERM'); } catch {}
    }
    if (activeWake) activeWake();
  };
  process.once('SIGINT', onStop);
  process.once('SIGTERM', onStop);

  const history = [];
  let stopReason = 'completed';
  let lastErrorSig = '';
  let repeatErrorCount = 0;
  let escalated = null;
  let lastDiagnosis = null;
  let pendingDiagnosis = null;
  const diagnosedSigs = new Set();
  let seatIndex = 0;

  try {
    let cycle = 0;
    while (!stopped && cycle < maxCycles) {
      cycle += 1;
      const snap = await watchSwarm(root, {
        staleMinutes: Math.max(1, Number(options.staleMinutes) || 10),
        expire: !options.dryRun && options.expire !== false,
        reallocate: !options.dryRun && options.reallocate !== false,
        channel: options.channel || '',
        hub: options.hub || '',
        server: options.server || '',
        home: options.home,
      }, deps);

      const entry = {
        ts: snap.checked_at,
        cycle,
        duration_label: label,
        hub_reachable: Boolean(snap.hub && snap.hub.reachable),
        alive: snap.hub && snap.hub.liveness && Array.isArray(snap.hub.liveness.alive) ? snap.hub.liveness.alive.length : 0,
        dying: snap.hub && snap.hub.liveness && Array.isArray(snap.hub.liveness.dying) ? snap.hub.liveness.dying.length : 0,
        orphaned: snap.hub && snap.hub.liveness && Array.isArray(snap.hub.liveness.orphaned_claims) ? snap.hub.liveness.orphaned_claims.length : 0,
        reallocated: Boolean(snap.reallocated),
        frozen_ok: Boolean(snap.frozen && snap.frozen.ok),
        alerts: snap.alerts || [],
        step: null,
        steps: [],
      };

      let haltNow = false;
      let ranWorkThisCycle = false;

      if (!entry.frozen_ok) {
        stopReason = 'frozen_module_modified';
        haltNow = true;
      } else if (canExecute) {
        const cycleDiagnosis = pendingDiagnosis;
        pendingDiagnosis = null;
        const wave = await executeSwarmWave(root, { snap, cycle, seatIndex, runId, options, deps, activeChildren, diagnosis: cycleDiagnosis });
        seatIndex = wave.next_seat_index;
        entry.steps = wave.steps;
        entry.step = wave.steps[0] || null;
        ranWorkThisCycle = wave.ran_count > 0;

        if (wave.blocked_by === 'frozen_modules') {
          const hit = wave.steps.find((s) => s.blocked_by === 'frozen_modules');
          entry.frozen_ok = false;
          entry.alerts = [...entry.alerts, (hit && hit.error) || 'frozen module modified'];
          stopReason = 'frozen_module_modified';
          haltNow = true;
        } else if (wave.queue_empty && options.stopOnEmpty) {
          stopReason = 'queue_drained';
          haltNow = true;
        } else {
          for (const step of wave.steps) {
            if (!step.ran) continue;
            if (!step.ok) {
              const sig = normalizeErrorSignature(step.error);
              if (sig && sig === lastErrorSig) {
                repeatErrorCount += 1;
              } else {
                lastErrorSig = sig;
                repeatErrorCount = 1;
              }
              if (repeatErrorCount >= maxRepeatErrors) {
                const canDiagnose = typeof deps.diagnoseStall === 'function' || options.diagnose === true;
                let diag = null;
                if (canDiagnose && !diagnosedSigs.has(sig)) {
                  diagnosedSigs.add(sig);
                  const diagFn = typeof deps.diagnoseStall === 'function'
                    ? deps.diagnoseStall
                    : (r, payload) => runDiagnosticAudible(r, payload);
                  diag = await diagFn(root, {
                    task: { title: (snap.swarm && snap.swarm.objective) || step.task_key || step.member },
                    error: step.error || 'worker error',
                    files: [],
                  }).catch(() => null);
                  if (diag && diag.ok && diag.diagnosis) {
                    lastDiagnosis = diag;
                    entry.diagnosis = { engine: diag.engine, effort: diag.effort, summary: diag.diagnosis.slice(0, 240) };
                  }
                }
                // West Coast recovery: after 1 read-only Deep Thinker diagnosis,
                // optionally give the next cycle ONE fresh low-effort pass with
                // the root-cause diagnosis attached before halting.
                if (diag && diag.ok && diag.diagnosis && options.recover === true) {
                  pendingDiagnosis = diag;
                  repeatErrorCount = 0;
                  break;
                }
                const leadActor = (snap.swarm && snap.swarm.lead) || 'coordinator';
                const diagNote = diag && diag.ok && diag.diagnosis
                  ? ` | Deep Thinker (${diag.engine}/${diag.effort || 'high'}): ${diag.diagnosis.replace(/\s+/g, ' ').slice(0, 320)}`
                  : '';
                escalated = await escalateIntent(root, {
                  intent: `Swarm stalled after ${repeatErrorCount} repeated failures: ${step.error || 'worker error'}`,
                  tried: `Repeated ${repeatErrorCount} consecutive times on ${step.task_key || step.member}${diagNote}`,
                  taskKey: step.task_key || '',
                  as: leadActor,
                  tier: 2,
                  offline: true,
                  hub: options.hub || '',
                  server: options.server || '',
                  home: options.home,
                }, deps).catch(() => null);
                stopReason = 'repeated_error';
                haltNow = true;
                break;
              }
            } else {
              lastErrorSig = '';
              repeatErrorCount = 0;
            }
          }
        }
      }

      history.push(entry);
      if (!options.dryRun) {
        appendJsonl(path.join(root, LOOP_LOG_REL), entry);
      }

      if (!options.json) {
        const ran = entry.steps.filter((s) => s.ran);
        const stepTag = entry.steps.length
          ? (ran.length
            ? ` wave=${ran.map((s) => `${s.task_key || s.member}:${s.ok ? 'ok' : 'fail'}`).join(',')}`
            : ' step=idle')
          : '';
        log(`swarm up [${cycle}/${label}] hub=${entry.hub_reachable ? 'online' : 'offline'} alive=${entry.alive} dying=${entry.dying} frozen=${entry.frozen_ok ? 'clean' : 'alert'}${stepTag} alerts=${entry.alerts.length}`);
      }

      if (haltNow) break;
      if (stopped) {
        stopReason = 'signal';
        break;
      }
      if (cycle >= maxCycles) {
        stopReason = 'max_cycles';
        break;
      }
      const remaining = deadlineMs - nowFn();
      if (remaining <= 0) {
        stopReason = 'deadline';
        break;
      }
      // Keep moving immediately when a wave executed work; only sleep when idle/watching.
      if (!ranWorkThisCycle) {
        await sleepWithStop(Math.min(intervalMs, remaining));
        if (stopped) {
          stopReason = 'signal';
          break;
        }
      }
    }
  } finally {
    if (activeTimer) {
      clearTimeout(activeTimer);
      activeTimer = null;
    }
    activeWake = null;
    process.removeListener('SIGINT', onStop);
    process.removeListener('SIGTERM', onStop);
  }

  const allExecuted = history.flatMap((h) => (
    Array.isArray(h.steps) && h.steps.length
      ? h.steps.filter((s) => s && s.ran)
      : (h.step && h.step.ran ? [h.step] : [])
  ));
  const succeeded = allExecuted.filter((s) => s.ok).length;
  const failed = allExecuted.length - succeeded;

  let dream = null;
  if (options.dream !== false && !options.dryRun) {
    try {
      const { runDreamConsolidate } = require('./dream-consolidate');
      const shouldApplyDream = options.applyDream === true || (options.applyDream !== false && allExecuted.length > 0);
      dream = runDreamConsolidate(root, { apply: shouldApplyDream });
    } catch {
      dream = null;
    }
  }

  const healthy = stopReason !== 'frozen_module_modified'
    && stopReason !== 'repeated_error'
    && !(allExecuted.length > 0 && succeeded === 0)
    && history.every((h) => h.frozen_ok);

  return {
    ok: healthy,
    exitCode: healthy ? 0 : 1,
    duration_ms: durationMs,
    duration_label: label,
    cycles: history.length,
    stop_reason: stopReason,
    executed_count: allExecuted.length,
    succeeded_count: succeeded,
    failed_count: failed,
    escalated: escalated ? { seat: escalated.seat, channel: escalated.channel, posted: escalated.posted } : null,
    ...(lastDiagnosis ? { diagnosis: { engine: lastDiagnosis.engine, model: lastDiagnosis.model || '', effort: lastDiagnosis.effort || '', text: lastDiagnosis.diagnosis } } : {}),
    loop_log: LOOP_LOG_REL,
    history,
    dream: dream ? {
      applied: dream.applied,
      memory_core_count: dream.memory_core.count,
      poisoned_count: dream.lessons.poisoned.length,
    } : null,
  };
}

// Natural-language front door: `atris swarm "<anything>"` or `atris swarm up 23 min "<anything>"`.
// The model reads the team + workspace context, staffs the right seats (or solo when
// no seats exist), starts the swarm, persists + posts starter tasks, and runs the timed loop if requested.
async function runNaturalSwarm(root, rawInput, options = {}, deps = {}) {
  const { plan, board_posts: boardPosts, frozen_paths: frozenPaths } = await planNaturalSwarm(root, rawInput, options, deps);

  if (plan.needs_human_yes && !options.yes) {
    return {
      ok: true,
      exitCode: 0,
      needs_human_yes: true,
      plan,
      board_posts: boardPosts,
      frozen_paths: frozenPaths,
      message: `tier 3 request needs your yes before starting. re-run with --yes to proceed.`,
    };
  }

  const started = await startSwarm(root, {
    objective: plan.objective,
    lead: plan.lead,
    team: plan.solo ? [] : plan.workers,
    solo: plan.solo,
    allowSolo: true,
    channel: options.channel || '',
    hub: options.hub || '',
    server: options.server || '',
    engine: options.engine || '',
    dryRun: Boolean(options.dryRun),
    home: options.home,
  }, deps);

  if (!started.ok) {
    return {
      ok: false,
      exitCode: started.exitCode || 1,
      error: started.error || 'swarm start failed',
      dry_run: Boolean(options.dryRun),
      needs_human_yes: false,
      plan,
      swarm: started.swarm || null,
      announced: false,
      planned_tasks: null,
      loop: null,
      board_posts: boardPosts,
      frozen_paths: frozenPaths,
    };
  }

  // Persist planned tasks onto .atris/state/swarm.json so offline swarms never lose work.
  if (!options.dryRun && plan.tasks.length) {
    updateSwarmState(root, (state) => ({
      ...state,
      queue: plan.tasks.map((t) => ({
        task_key: t.task_key,
        content: t.content,
        depends_on: Array.isArray(t.depends_on) ? t.depends_on : [],
        verify: options.verify || '',
        status: 'open',
      })),
    }));
  }

  let plannedTasks = null;
  if (!options.dryRun && started.hub_reachable && plan.tasks.length) {
    plannedTasks = await planSwarmTasks(root, {
      as: plan.lead,
      tasks: plan.tasks,
      channel: options.channel || '',
      hub: options.hub || '',
      server: options.server || '',
      home: options.home,
    }, deps);
  }

  // Natural front door executes via built-in mission worker by default when live
  // (unless --watch-only, --dry-run, --offline, --no-mission, --exec, or --dispatch).
  const defaultMission = options.mission !== undefined
    ? Boolean(options.mission)
    : (!options.dryRun && !options.watchOnly && !options.offline && !options.exec && !options.dispatch && typeof deps.runWorker !== 'function');

  let loop = null;
  if (plan.duration_ms && !options.noLoop) {
    loop = await runSwarmUpLoop(root, {
      durationMs: plan.duration_ms,
      label: plan.duration_label || `${plan.duration_minutes}m`,
      intervalMs: options.intervalMs,
      maxCycles: options.maxCycles,
      once: Boolean(options.once || options.dryRun),
      exec: options.exec || '',
      verify: options.verify || '',
      dispatch: Boolean(options.dispatch),
      mission: defaultMission,
      parallel: options.parallel,
      maxTicks: options.maxTicks,
      inPlace: Boolean(options.inPlace),
      watchOnly: Boolean(options.watchOnly),
      stopOnEmpty: options.stopOnEmpty !== undefined ? Boolean(options.stopOnEmpty) : defaultMission,
      maxRepeatErrors: options.maxRepeatErrors,
      diagnose: Boolean(options.diagnose || options.recover),
      recover: Boolean(options.recover),
      stepTimeoutMs: options.stepTimeoutMs,
      engine: options.engine || '',
      expire: options.expire,
      reallocate: options.reallocate,
      dream: options.dream,
      applyDream: options.applyDream,
      staleMinutes: options.staleMinutes,
      channel: options.channel || '',
      hub: options.hub || '',
      server: options.server || '',
      dryRun: Boolean(options.dryRun),
      json: Boolean(options.json),
      home: options.home,
      log: options.log,
    }, deps);
  }

  if (!options.dryRun && !(loop && loop.executed_count > 0)) {
    appendJsonl(path.join(root, TRACE_REL), {
      ts: new Date().toISOString(),
      id: `rt-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`,
      intent: plan.objective,
      tier: plan.tier,
      seat: plan.solo ? plan.lead : (plan.workers[0] || plan.lead),
      engine: plan.planner_engine || 'auto',
      task_key: plan.tasks[0] ? plan.tasks[0].task_key : null,
      evidence: plan.context_paths,
      tried: null,
      channel: options.channel || DEFAULT_CHANNEL,
      routed_by: plan.lead,
      posted: Boolean(started.announced),
      outcome: 'pending',
      corrected_by: null,
    });
  }

  return {
    ok: started.ok && (!loop || loop.ok),
    exitCode: started.ok && (!loop || loop.ok) ? 0 : 1,
    dry_run: Boolean(options.dryRun),
    needs_human_yes: false,
    plan,
    swarm: started.swarm,
    announced: started.announced,
    planned_tasks: plannedTasks,
    loop,
    board_posts: boardPosts,
    frozen_paths: frozenPaths,
  };
}

module.exports = {
  parseDurationTokens,
  planNaturalSwarm,
  runNaturalSwarm,
  buildSwarmBrief,
  routeIntent,
  escalateIntent,
  runSwarmUpLoop,
  TRACE_REL,
};
