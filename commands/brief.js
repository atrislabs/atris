const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const { clarify } = require('../lib/autoland');

const HOUR_MS = 60 * 60 * 1000;
const DEFAULT_HOURS = 24;
const DEFAULT_OUT = path.join('.atris', 'state', 'brief.html');
const ACTIVE_MISSION_STATUSES = new Set(['ready', 'running', 'planning']);
const HTTPS_URL_RE = /https:\/\/[^\s<>"')]+/g;
const GITHUB_PULL_RE = /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/(\d+)/i;
const SCRUB_ULID_RE = /[0-9A-HJKMNP-TV-Z]{20,}/g;
const SCRUB_TICKET_RE = /\b[A-Z]{2,4}-\d+\b/g;
const SCRUB_BACKTICK_RE = /`[^`]*`/g;
const SCRUB_PATH_RE = /\S+\.(?:js|md|py|json|ts)(?::\d+)?/gi;
const SHELL_WORD_RE = /\b(?:npm|node|grep|git)\s+/gi;
const SHELL_MARK_RE = /--|->/g;
const GUARD_RULES = [
  { name: 'raw work id', re: /[0-9A-HJKMNP-TV-Z]{20,}/ },
  { name: 'ticket id', re: /\b[A-Z]{2,4}-\d+\b/ },
  { name: 'shell fragment', re: /--|->|\bnpm\s+|\bnode\s+|\bgrep\s+|\bgit\s+/i },
  { name: 'file path', re: /\S+\.(?:js|md|py|json|ts)(?::\d+)?/i },
  { name: 'test tally', re: /\b\d+\s*\/\s*\d+\b|\b\d+\s+(?:tests?|checks?)\b/i },
];

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

function proofText(task) {
  const meta = task.metadata || {};
  return flatText(meta.latest_agent_proof || '');
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

function firstSentence(text) {
  const clean = flatText(text);
  if (!clean) return '';
  const match = clean.match(/^.*?[.!?](?:\s|$)/);
  return match ? match[0].trim() : clean;
}

function scrubOperatorText(text) {
  return flatText(text)
    .replace(SCRUB_BACKTICK_RE, ' ')
    .replace(SCRUB_ULID_RE, ' ')
    .replace(SCRUB_TICKET_RE, ' ')
    .replace(SCRUB_PATH_RE, ' ')
    .replace(SHELL_WORD_RE, ' ')
    .replace(SHELL_MARK_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function operatorSentence(text, max = 110, fallback = 'Work moved forward.') {
  const cleaned = scrubOperatorText(text);
  const line = firstSentence(clarify(cleaned, max));
  const finished = clarify(line, max)
    .replace(/\b(?:through|via|with|from|in|at|on|for|to|by)$/i, '')
    .replace(/[,\s]+$/, '');
  return finished || fallback;
}

function plural(n, word, pluralWord = `${word}s`) {
  return `${n} ${n === 1 ? word : pluralWord}`;
}

function headlineSub(data) {
  const parts = [
    `${data.totals.landed} landed`,
    `${data.totals.in_review} needs you`,
    `${data.totals.working} working`,
    `${plural(data.totals.active_missions, 'loop')} running`,
    `last ${data.window.hours} hours`,
  ];
  return parts.join(', ');
}

function relativeTime(value, nowMs = Date.now()) {
  const ms = timeMs(value);
  if (ms == null) return '';
  const delta = Math.max(0, nowMs - ms);
  const minutes = Math.floor(delta / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function proofLinkLabel(url) {
  const match = String(url || '').match(GITHUB_PULL_RE);
  return match ? `pr #${match[1]}` : 'proof';
}

function proofDisplay(proof, links) {
  const flat = flatText(proof);
  const match = flat.match(HTTPS_URL_RE);
  if (match && match[0]) {
    const label = proofLinkLabel(match[0]);
    const token = `__BRIEF_PROOF_LINK_${links.length}__`;
    links.push({ token, href: match[0], label });
    return { html: token, visible: label };
  }
  if (/\b(pass(?:ed)?|verified|merged|green|ok)\b/i.test(flat)) {
    return { html: 'verified', visible: 'verified' };
  }
  return { html: 'receipt on file', visible: 'receipt on file' };
}

function rowForTask(item, value, links, nowMs) {
  const proof = proofDisplay(item.proof, links);
  return {
    title: operatorSentence(item.title),
    sub: proof.html,
    subVisible: proof.visible,
    value,
    valueSub: relativeTime(item.done_at || item.updated_at, nowMs),
  };
}

function rowsForAgent(agent, links, nowMs) {
  const all = [
    ...agent.buckets.landed.map(item => rowForTask(item, 'landed', links, nowMs)),
    ...agent.buckets.in_review.map(item => rowForTask(item, 'needs you', links, nowMs)),
    ...agent.buckets.working_now.map(item => rowForTask(item, 'working', links, nowMs)),
  ];
  const visible = all.slice(0, 3);
  const hidden = all.length - visible.length;
  if (hidden > 0) {
    visible.push({
      title: `+${hidden} more, ask for them`,
      sub: '',
      subVisible: '',
      value: '',
      valueSub: '',
    });
  }
  return visible.length ? visible : [{ title: 'No task movement in this window.', sub: '', subVisible: '', value: 'quiet', valueSub: '' }];
}

function agentSub(agent) {
  const parts = [];
  if (agent.buckets.landed.length) parts.push(`${agent.buckets.landed.length} landed`);
  if (agent.buckets.in_review.length) parts.push(`${agent.buckets.in_review.length} needs you`);
  if (agent.buckets.working_now.length) parts.push(`${agent.buckets.working_now.length} working`);
  return parts.length ? parts.join(', ') : 'quiet';
}

function missionRows(missions) {
  if (!missions.length) {
    return [{ title: 'No loops are running right now.', sub: '', subVisible: '', value: 'clear', valueSub: '' }];
  }
  return missions.slice(0, 3).map(mission => ({
    title: operatorSentence(mission.objective, 110, 'A loop is running.'),
    sub: '',
    subVisible: '',
    value: String(mission.status || 'running'),
    valueSub: '',
  }));
}

function waitingRows(items, links, nowMs) {
  if (!items.length) {
    return [{ title: 'Nothing needs you right now.', sub: '', subVisible: '', value: 'clear', valueSub: '' }];
  }
  const visible = items.slice(0, 3).map(item => rowForTask(item, 'review', links, nowMs));
  const hidden = items.length - visible.length;
  if (hidden > 0) {
    visible.push({ title: `+${hidden} more, ask for them`, sub: '', subVisible: '', value: '', valueSub: '' });
  }
  return visible;
}

function buildPageModel(data) {
  const links = [];
  const nowMs = Date.now();
  const panels = [
    {
      heading: 'waiting on you',
      sub: data.waiting_on_you.length ? 'Approve or send back.' : 'Clear.',
      rows: waitingRows(data.waiting_on_you, links, nowMs),
    },
  ];
  for (const agent of data.agents) {
    panels.push({
      heading: agent.agent,
      sub: agentSub(agent),
      rows: rowsForAgent(agent, links, nowMs),
    });
  }
  if (data.agents.length === 0) {
    panels.push({
      heading: 'team',
      sub: 'quiet',
      rows: [{ title: 'No task movement in this window.', sub: '', subVisible: '', value: 'quiet', valueSub: '' }],
    });
  }
  panels.push({
    heading: 'missions',
    sub: `${plural(data.missions.length, 'loop')} running`,
    rows: missionRows(data.missions),
  });
  const page = {
    title: 'what your team did',
    sub: headlineSub(data),
    rollup: [
      { number: String(data.totals.landed), label: 'landed' },
      { number: String(data.totals.in_review), label: 'needs you' },
      { number: String(data.totals.working), label: 'working' },
      { number: String(data.totals.active_missions), label: 'loops running' },
    ],
    panels,
  };
  briefOperatorGate(visibleStringsForPage(page));
  return { page, links };
}

function visibleStringsForPage(page) {
  const strings = [page.title, page.sub];
  for (const item of page.rollup || []) strings.push(item.number, item.label);
  for (const panel of page.panels || []) {
    strings.push(panel.heading, panel.sub);
    for (const row of panel.rows || []) strings.push(row.title, row.subVisible || row.sub, row.value, row.valueSub);
  }
  return strings;
}

function briefOperatorGate(strings) {
  const queue = Array.isArray(strings) ? [...strings] : [strings];
  while (queue.length) {
    const value = queue.shift();
    if (Array.isArray(value)) {
      queue.push(...value);
      continue;
    }
    if (value == null) continue;
    const text = String(value);
    for (const rule of GUARD_RULES) {
      if (rule.re.test(text)) throw new Error(`brief operator gate blocked ${rule.name}`);
    }
  }
  return true;
}

function renderRows(rows) {
  return rows.map(row => [
    '<div class="row">',
    '<div class="row-main">',
    `<strong>${escapeHtml(row.title)}</strong>`,
    row.sub ? `<small>${escapeHtml(row.sub)}</small>` : '',
    '</div>',
    row.value ? `<div class="row-side"><span>${escapeHtml(row.value)}</span>${row.valueSub ? `<small>${escapeHtml(row.valueSub)}</small>` : ''}</div>` : '',
    '</div>',
  ].join('')).join('');
}

function renderPanels(panels) {
  return panels.map(panel => [
    '<section class="panel">',
    '<div class="panel-lede">',
    `<h2>${escapeHtml(panel.heading)}</h2>`,
    panel.sub ? `<p>${escapeHtml(panel.sub)}</p>` : '',
    '</div>',
    '<div class="rows">',
    renderRows(panel.rows || []),
    '</div>',
    '</section>',
  ].join('')).join('');
}

function renderRollup(items) {
  return items.map(item => [
    '<div class="metric">',
    `<strong>${escapeHtml(item.number)}</strong>`,
    `<span>${escapeHtml(item.label)}</span>`,
    '</div>',
  ].join('')).join('');
}

function injectProofLinks(html, links) {
  let out = html;
  for (const link of links) {
    const token = escapeHtml(link.token);
    const href = escapeHtml(link.href);
    const label = escapeHtml(link.label);
    const anchor = `<a href="${href}" target="_blank" rel="noreferrer noopener">${label}</a>`;
    out = out.split(token).join(anchor);
  }
  return out;
}

function renderBriefHtml(data) {
  const { page, links } = buildPageModel(data);
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>atris brief</title>
<style>
*{box-sizing:border-box}
body{margin:0;background:#171513;color:#efe7dc;font:15px/1.45 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
main{max-width:980px;margin:0 auto;padding:42px 24px 64px}
header{padding:20px 0 28px}
h1{font-size:clamp(38px,7vw,70px);line-height:.95;margin:0 0 18px;font-weight:650;letter-spacing:0}
.sub{color:#c8bdb1;font-size:18px;margin:0;max-width:760px}
.rollup{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:10px 0 28px}
.metric{border-top:1px solid #4b4138;padding-top:12px}
.metric strong{display:block;font-size:34px;line-height:1.05;font-weight:620}
.metric span{display:block;color:#b5aaa0;margin-top:5px}
.panel{display:grid;grid-template-columns:220px 1fr;gap:24px;border-top:1px solid #4b4138;padding:24px 0}
.panel-lede h2{font-size:20px;margin:0 0 6px;font-weight:650}
.panel-lede p{margin:0;color:#b5aaa0}
.rows{display:grid;gap:8px}
.row{display:grid;grid-template-columns:1fr auto;gap:18px;align-items:center;background:#211d19;border:1px solid #40372f;border-radius:8px;padding:13px 15px}
.row-main strong{display:block;font-weight:560}
.row-main small,.row-side small{display:block;color:#9d9288;margin-top:3px}
.row-side{text-align:right;color:#d8cfc5;min-width:82px}
.row-side span{font-weight:560}
a{color:#f5b44d;text-decoration:none}
@media(max-width:760px){main{padding:30px 18px 48px}.rollup{grid-template-columns:repeat(2,1fr)}.panel{grid-template-columns:1fr}.row{grid-template-columns:1fr}.row-side{text-align:left}}
</style>
</head>
<body>
<main>
<header>
<h1>${escapeHtml(page.title)}</h1>
<p class="sub">${escapeHtml(page.sub)}</p>
</header>
<section class="rollup">${renderRollup(page.rollup)}</section>
${renderPanels(page.panels)}
</main>
</body>
</html>`;
  return injectProofLinks(html, links);
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
  console.log('atris brief - one local html page of recent team progress');
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
  briefOperatorGate,
  renderBriefHtml,
  run,
};
