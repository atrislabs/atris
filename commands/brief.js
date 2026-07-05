const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const { renderHtml, THEMES: HTML_THEMES } = require('../lib/html-render');
const { mergedThemes } = require('../lib/theme');

const HOUR_MS = 60 * 60 * 1000;
const DEFAULT_HOURS = 24;
const DEFAULT_OUT = path.join('.atris', 'state', 'brief.html');
const ACTIVE_MISSION_STATUSES = new Set(['ready', 'running', 'planning']);
const HTTPS_URL_RE = /https:\/\/[^\s<>"')]+/g;
const HTML_HTTPS_URL_RE = /https:\/\/(?:(?!&(?:lt|gt|quot);)[^\s<>"')])+/g;

function parseFlags(argv = []) {
  const flags = {
    hours: DEFAULT_HOURS,
    out: DEFAULT_OUT,
    open: false,
    json: false,
    theme: 'atris',
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h' || arg === 'help') {
      flags.help = true;
    } else if (arg === '--open') {
      flags.open = true;
    } else if (arg === '--json') {
      flags.json = true;
    } else if (arg === '--hours') {
      const value = Number(argv[i + 1]);
      if (Number.isFinite(value) && value > 0) flags.hours = value;
      i += 1;
    } else if (arg === '--out') {
      if (argv[i + 1]) flags.out = argv[i + 1];
      i += 1;
    } else if (arg === '--theme') {
      if (argv[i + 1]) flags.theme = argv[i + 1];
      i += 1;
    }
  }
  return flags;
}

function readProjection(root) {
  const projectionPath = path.join(root, '.atris', 'state', 'tasks.projection.json');
  if (!fs.existsSync(projectionPath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(projectionPath, 'utf8'));
    return Array.isArray(parsed.tasks) ? parsed.tasks : null;
  } catch (e) {
    return null;
  }
}

function timeMs(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value < 100000000000 ? value * 1000 : value;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && String(value).trim() !== '') return numeric < 100000000000 ? numeric * 1000 : numeric;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function taskInsideWindow(task, sinceMs) {
  const updated = timeMs(task.updated_at);
  const done = timeMs(task.done_at);
  return (updated != null && updated >= sinceMs) || (done != null && done >= sinceMs);
}

function agentForTask(task) {
  const meta = task.metadata || {};
  return String(task.claimed_by || meta.assigned_to || 'unassigned').trim() || 'unassigned';
}

function displayTaskId(task) {
  return String(task.display_id || task.id || '').trim();
}

function flatText(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

function titleLine(task) {
  const ref = displayTaskId(task);
  const title = flatText(task.title || '(untitled task)');
  return ref ? `${ref} ${title}` : title;
}

function proofText(task) {
  const meta = task.metadata || {};
  return flatText(meta.latest_agent_proof || '');
}

function proofSnippet(proof, width = 110) {
  const flat = flatText(proof);
  if (!flat) return '';
  const match = flat.match(HTTPS_URL_RE);
  if (match && match[0]) {
    const url = match[0];
    const before = flat.slice(0, flat.indexOf(url)).trim();
    const prefix = before ? `${clip(before, Math.max(24, width - url.length - 10))} ` : '';
    return `proof: ${prefix}${url}`;
  }
  return `proof: ${clip(flat, width)}`;
}

function clip(text, width) {
  const value = flatText(text);
  if (value.length <= width) return value;
  return `${value.slice(0, Math.max(0, width - 3)).trimEnd()}...`;
}

function bucketName(status) {
  if (status === 'done') return 'landed';
  if (status === 'review') return 'in_review';
  if (status === 'open' || status === 'claimed') return 'working_now';
  return null;
}

function emptyAgent(name) {
  return {
    agent: name,
    buckets: {
      landed: [],
      in_review: [],
      working_now: [],
    },
  };
}

function summarizeTasks(tasks) {
  const agents = new Map();
  const waitingOnYou = [];
  const totals = {
    landed: 0,
    in_review: 0,
    working: 0,
  };

  for (const task of tasks) {
    const status = String(task.status || '').toLowerCase();
    const bucket = bucketName(status);
    if (!bucket) continue;
    const agent = agentForTask(task);
    if (!agents.has(agent)) agents.set(agent, emptyAgent(agent));
    const item = {
      id: task.id || null,
      display_id: displayTaskId(task),
      title: task.title || '',
      status,
      claimed_by: task.claimed_by || null,
      assigned_to: task.metadata && task.metadata.assigned_to || null,
      updated_at: task.updated_at || null,
      done_at: task.done_at || null,
      proof: proofText(task),
      agent_certified: Boolean(task.metadata && task.metadata.agent_certified),
      landing_branch: task.metadata && task.metadata.landing_branch || null,
      landing_pr: task.metadata && task.metadata.landing_pr || null,
      landing_url: task.metadata && task.metadata.landing_url || null,
    };
    agents.get(agent).buckets[bucket].push(item);
    if (bucket === 'landed') totals.landed += 1;
    if (bucket === 'in_review') {
      totals.in_review += 1;
      waitingOnYou.push(item);
    }
    if (bucket === 'working_now') totals.working += 1;
  }

  return {
    agents: [...agents.values()].sort((a, b) => a.agent.localeCompare(b.agent)),
    waiting_on_you: waitingOnYou,
    totals,
  };
}

function readActiveMissions(root) {
  try {
    const file = path.join(root, '.atris', 'state', 'missions.jsonl');
    if (!fs.existsSync(file)) return [];
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    const seen = new Map();
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      let rec;
      try { rec = JSON.parse(lines[i]); } catch { continue; }
      const id = rec.id || rec.mission_id;
      if (!id || seen.has(id)) continue;
      seen.set(id, rec);
    }
    const live = [];
    for (const mission of seen.values()) {
      const status = String(mission.status || '');
      if (!ACTIVE_MISSION_STATUSES.has(status)) continue;
      live.push({
        id: mission.id || mission.mission_id,
        owner: mission.owner || '?',
        runner: mission.runner || null,
        objective: mission.objective || '',
        status,
      });
    }
    return live;
  } catch {
    return [];
  }
}

function collectLandings(root) {
  try {
    const land = require('./land');
    if (!land || typeof land.collectBoard !== 'function') {
      return { status: 'unavailable', note: 'landings: unavailable' };
    }
    const board = land.collectBoard(root);
    return {
      status: 'available',
      summary: {
        unlanded: board.summary && Number(board.summary.unlanded) || 0,
        due: board.summary && Number(board.summary.due) || 0,
        landed: board.summary && Number(board.summary.landed) || 0,
      },
    };
  } catch {
    return { status: 'unavailable', note: 'landings: unavailable' };
  }
}

function buildBriefData(root = process.cwd(), options = {}) {
  const hours = Number.isFinite(Number(options.hours)) && Number(options.hours) > 0
    ? Number(options.hours)
    : DEFAULT_HOURS;
  const nowMs = options.nowMs || Date.now();
  const sinceMs = nowMs - hours * HOUR_MS;
  const projectionTasks = readProjection(root) || [];
  const windowTasks = projectionTasks.filter(task => taskInsideWindow(task, sinceMs));
  const taskSummary = summarizeTasks(windowTasks);
  const missions = readActiveMissions(root);
  return {
    schema: 'atris.brief.v1',
    generated_at: new Date(nowMs).toISOString(),
    window: {
      hours,
      since: new Date(sinceMs).toISOString(),
      until: new Date(nowMs).toISOString(),
    },
    totals: {
      ...taskSummary.totals,
      active_missions: missions.length,
    },
    agents: taskSummary.agents,
    waiting_on_you: taskSummary.waiting_on_you,
    missions,
    landings: collectLandings(root),
  };
}

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function rowForTask(item, value) {
  const sub = proofSnippet(item.proof);
  return {
    title: titleLine(item),
    sub: sub || '',
    value,
  };
}

function rowsForAgent(agent) {
  const rows = [];
  for (const item of agent.buckets.landed) rows.push(rowForTask(item, 'landed'));
  for (const item of agent.buckets.in_review) rows.push(rowForTask(item, 'review'));
  for (const item of agent.buckets.working_now) rows.push(rowForTask(item, 'working'));
  return rows.length ? rows : [{ title: 'no task movement in this window', value: 'idle' }];
}

function landingMeta(landings) {
  if (!landings || landings.status !== 'available') return 'landings: unavailable';
  const s = landings.summary || {};
  return `landings: ${s.unlanded || 0} in the air, ${s.due || 0} due, ${s.landed || 0} landed`;
}

function buildSpec(data, { theme = 'atris' } = {}) {
  const blocks = [
    {
      type: 'title',
      headline: 'agent activity brief',
      sub: `generated ${data.generated_at}, last ${data.window.hours} hours`,
      panel: {
        header: { title: 'local state', meta: landingMeta(data.landings) },
        rows: [
          { title: 'source', sub: '.atris/state/tasks.projection.json and missions.jsonl', value: 'local' },
          { title: 'window start', value: data.window.since },
          { title: 'window end', value: data.window.until },
        ],
      },
    },
    {
      type: 'columns',
      heading: 'rollup',
      columns: [
        { h: String(data.totals.landed), b: 'landed' },
        { h: String(data.totals.in_review), b: 'in review' },
        { h: String(data.totals.working), b: 'working' },
        { h: String(data.totals.active_missions), b: 'active missions' },
      ],
    },
  ];

  if (data.agents.length === 0) {
    blocks.push({
      type: 'panel',
      heading: 'agents',
      sub: 'no task movement in this window',
      panel: { rows: [{ title: 'no recent task movement', value: 'quiet' }] },
    });
  } else {
    for (const agent of data.agents) {
      blocks.push({
        type: 'panel',
        heading: agent.agent,
        sub: `${agent.buckets.landed.length} landed, ${agent.buckets.in_review.length} in review, ${agent.buckets.working_now.length} working`,
        panel: {
          header: { title: 'work', meta: agent.agent },
          rows: rowsForAgent(agent),
        },
      });
    }
  }

  blocks.push({
    type: 'panel',
    heading: 'waiting on you',
    sub: 'review tasks ready for operator attention',
    panel: {
      rows: data.waiting_on_you.length
        ? data.waiting_on_you.map(item => rowForTask(item, 'review'))
        : [{ title: 'nothing waiting on you right now', value: 'clear' }],
    },
  });

  blocks.push({
    type: 'panel',
    heading: 'missions',
    sub: 'active mission loops from local state',
    panel: {
      rows: data.missions.length
        ? data.missions.map(mission => ({
          title: `${mission.id} ${mission.objective}`.trim(),
          sub: `owner: ${mission.owner}${mission.runner ? `, runner: ${mission.runner}` : ''}`,
          value: mission.status,
        }))
        : [{ title: 'no active missions', value: 'clear' }],
    },
  });

  return {
    theme,
    brand: { name: 'Atris' },
    blocks,
  };
}

function linkifyProofUrls(html) {
  return html.replace(HTML_HTTPS_URL_RE, (url) => {
    const rawUrl = url.replace(/&amp;/g, '&');
    const safe = escapeHtml(rawUrl);
    return `<a href="${safe}" target="_blank" rel="noreferrer noopener" style="color:var(--brand-primary-2);text-decoration:none">${safe}</a>`;
  });
}

function renderBriefHtml(data, { root = process.cwd(), theme = 'atris' } = {}) {
  const themes = mergedThemes(HTML_THEMES, root);
  const html = renderHtml(buildSpec(data, { theme }), { themes, title: 'atris brief' });
  return linkifyProofUrls(html);
}

function isTestRuntime() {
  return Boolean(process.env.NODE_TEST_CONTEXT || process.env.ATRIS_BRIEF_NO_OPEN || process.env.NODE_ENV === 'test');
}

function openFile(file) {
  if (isTestRuntime()) return;
  const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
  const child = spawn(opener, [file], { detached: true, stdio: 'ignore' });
  child.unref();
}

function showHelp() {
  console.log('');
  console.log('atris brief - one local html page of recent agent activity');
  console.log('');
  console.log('  atris brief [--hours <n>] [--out <path>] [--open] [--json] [--theme <name>]');
  console.log('');
  console.log('defaults: --hours 24 --out .atris/state/brief.html --theme atris');
  console.log('');
}

function run(argv = []) {
  const flags = parseFlags(argv);
  if (flags.help) {
    showHelp();
    return 0;
  }

  const root = process.cwd();
  const data = buildBriefData(root, { hours: flags.hours });
  if (flags.json) {
    console.log(JSON.stringify(data, null, 2));
    return 0;
  }

  const outPath = path.resolve(root, flags.out);
  const html = renderBriefHtml(data, { root, theme: flags.theme });
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, html);
  console.log(`brief written: ${outPath}`);
  if (flags.open) openFile(outPath);
  return 0;
}

module.exports = {
  buildBriefData,
  renderBriefHtml,
  run,
};
