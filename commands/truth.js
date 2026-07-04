// atris truth — one table of what is actually proven, blocked, or stale.
// Rolls up sources that already exist; writes nothing. SQL/state is truth, this is the render.
//   1. .atris/state/missions.jsonl        — mission states (dedupe by id, latest wins)
//   2. ~/.atris/tasks.db                  — task counts by status, scoped to this workspace unless --all is passed
//   3. atris/features/*/                  — validate.md frontmatter + newest proof/ receipt age
//   4. ~/.atris/heartbeat/{registry,state}.json — declared loops vs last_run / fails

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const taskDb = require('../lib/task-db');

const STALE_DAYS = 7;

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function daysAgo(ms) {
  if (!ms) return null;
  return (Date.now() - ms) / 86400000;
}

function fmtAge(days) {
  if (days == null) return 'never';
  if (days < 1) return `${Math.round(days * 24)}h`;
  return `${Math.round(days)}d`;
}

function loadMissions(cwd) {
  const file = path.join(cwd, '.atris', 'state', 'missions.jsonl');
  if (!fs.existsSync(file)) return [];
  const seen = new Map();
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line);
      const id = rec.id || rec.mission_id;
      if (id) seen.set(id, rec);
    } catch { /* skip bad lines */ }
  }
  // stopped = killed-on-purpose = a closed loop; only genuinely open states count
  return [...seen.values()].filter((m) => m.status && !['complete', 'archived', 'stopped'].includes(m.status));
}

function gitCommonWorkspaceRoot(cwd) {
  try {
    const common = execFileSync('git', ['rev-parse', '--git-common-dir'], {
      cwd: cwd || process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (!common) return null;
    const gitDir = path.resolve(cwd || process.cwd(), common);
    return path.basename(gitDir) === '.git' ? path.dirname(gitDir) : null;
  } catch {
    return null;
  }
}

function workspaceRootCandidates(cwd) {
  const primary = taskDb.workspaceRoot(cwd || process.cwd());
  const candidates = [primary];
  const commonRoot = gitCommonWorkspaceRoot(primary);
  if (commonRoot && commonRoot !== primary) candidates.push(commonRoot);
  return candidates;
}

function countsFromRows(rows) {
  const counts = {};
  for (const r of rows) counts[r.status] = Number(r.n || 0);
  return counts;
}

function taskCountRows(db, workspaceRoot) {
  return workspaceRoot
    ? db.prepare('SELECT status, COUNT(*) n FROM tasks WHERE workspace_root = ? GROUP BY status').all(workspaceRoot)
    : db.prepare('SELECT status, COUNT(*) n FROM tasks GROUP BY status').all();
}

function loadTaskCounts({ cwd, all = false } = {}) {
  const candidates = all ? [null] : workspaceRootCandidates(cwd || process.cwd());
  try {
    const { DatabaseSync } = require('node:sqlite');
    const dbPath = taskDb.getDbPath();
    if (!fs.existsSync(dbPath)) return { counts: null, workspaceRoot: candidates[0] || null };
    const db = new DatabaseSync(dbPath, { readOnly: true });
    for (const workspaceRoot of candidates) {
      const rows = taskCountRows(db, workspaceRoot);
      if (all || rows.length > 0) {
        db.close();
        return { counts: countsFromRows(rows), workspaceRoot };
      }
    }
    db.close();
    return { counts: {}, workspaceRoot: candidates[0] || null };
  } catch { return { counts: null, workspaceRoot: candidates[0] || null }; }
}

function taskScopeLabel(scope) {
  return scope.kind === 'global' ? 'global' : 'workspace';
}

function taskScopeLine(scope) {
  if (scope.kind === 'global') return 'global';
  return `${taskScopeLabel(scope)} (${scope.workspace_root})`;
}

const PARKED_DAYS = 30;

// One git call: every feature dir touched in the last PARKED_DAYS.
// An unproven feature nobody has edited in a month is a parked idea
// packet, not work-in-progress — counting it as "unproven" buries the
// handful of live lanes that actually need a proof receipt.
function recentlyTouchedFeatureDirs(cwd) {
  try {
    const out = execFileSync(
      'git',
      ['log', `--since=${PARKED_DAYS}.days`, '--format=', '--name-only', '--', 'atris/features'],
      { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const dirs = new Set();
    for (const line of out.split('\n')) {
      const m = line.match(/^atris\/features\/([^/]+)\//);
      if (m) dirs.add(m[1]);
    }
    return dirs;
  } catch {
    return null; // no git history to judge by: nothing reads as parked
  }
}

function loadFeatures(cwd) {
  const dir = path.join(cwd, 'atris', 'features');
  if (!fs.existsSync(dir)) return [];
  const recent = recentlyTouchedFeatureDirs(cwd);
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    if (name.startsWith('_')) continue;
    const fdir = path.join(dir, name);
    const validate = path.join(fdir, 'validate.md');
    if (!fs.existsSync(validate)) continue;
    let status = null;
    const head = fs.readFileSync(validate, 'utf8').slice(0, 500);
    const m = head.match(/^status:\s*(.+)$/m);
    if (m) status = m[1].trim();
    // newest receipt in proof/ (if any)
    let proofAgeDays = null;
    const proofDir = path.join(fdir, 'proof');
    if (fs.existsSync(proofDir)) {
      let newest = 0;
      for (const p of fs.readdirSync(proofDir)) {
        try { newest = Math.max(newest, fs.statSync(path.join(proofDir, p)).mtimeMs); } catch { /* skip */ }
      }
      if (newest) proofAgeDays = daysAgo(newest);
    }
    let verdict;
    if (/blocked/i.test(status || '')) verdict = 'blocked';
    else if (proofAgeDays != null && proofAgeDays <= STALE_DAYS) verdict = 'proven';
    else if (proofAgeDays != null) verdict = 'stale';
    else if (recent && !recent.has(name)) verdict = 'parked';
    else verdict = 'unproven';
    out.push({ lane: name, status: status || '-', verdict, proofAgeDays });
  }
  return out;
}

function loadHeartbeats() {
  const hbDir = path.join(os.homedir(), '.atris', 'heartbeat');
  const registry = readJson(path.join(hbDir, 'registry.json'));
  const state = readJson(path.join(hbDir, 'state.json')) || {};
  if (!registry || !Array.isArray(registry.jobs)) return [];
  return registry.jobs.filter((j) => !j.disabled).map((j) => {
    const s = state[j.id] || {};
    const lastRun = s.last_run ? Date.parse(s.last_run) : null;
    const ageDays = daysAgo(lastRun);
    const expectedDays = ((j.cadence_minutes || 60) / 1440) * 3; // 3 missed cadences = stale
    let verdict;
    if (s.disabled) verdict = 'disabled';
    else if ((s.consecutive_fails || 0) > 0) verdict = 'blocked';
    else if (lastRun == null) verdict = 'never-ran';
    else if (ageDays > Math.max(expectedDays, 0.05)) verdict = 'stale';
    else verdict = 'proven';
    return { id: j.id, verdict, lastRunAgeDays: ageDays, fails: s.consecutive_fails || 0, source: 'heartbeat' };
  });
}

// launchd agents are loops too - `atris loops` shows them, so truth must count
// them or the two views disagree ("loops: 0" while com.atris.* jobs run).
function loadLaunchdLoops() {
  let agents = [];
  try {
    agents = require('./loops').listLaunchdAgents();
  } catch { return []; }
  return agents.map((agent) => ({
    id: agent.label,
    verdict: agent.running || agent.lastExit === '0' ? 'proven' : 'blocked',
    lastRunAgeDays: null,
    fails: agent.running || agent.lastExit === '0' ? 0 : 1,
    source: 'launchd',
  }));
}

function truthCommand(args = []) {
  const cwd = process.cwd();
  const json = args.includes('--json');
  const summary = args.includes('--summary');
  const all = args.includes('--all');

  const missions = loadMissions(cwd);
  const taskCounts = loadTaskCounts({ cwd, all });
  const scope = all
    ? { kind: 'global' }
    : { kind: 'workspace', workspace_root: taskCounts.workspaceRoot };
  const tasks = taskCounts.counts;
  const features = loadFeatures(cwd);
  const heartbeats = [...loadHeartbeats(), ...loadLaunchdLoops()];

  const featureTally = {};
  for (const f of features) featureTally[f.verdict] = (featureTally[f.verdict] || 0) + 1;
  const loopTally = {};
  for (const h of heartbeats) loopTally[h.verdict] = (loopTally[h.verdict] || 0) + 1;

  const result = {
    ok: true,
    generated_at: new Date().toISOString(),
    scope,
    missions_active: missions.map((m) => ({ id: m.id || m.mission_id, status: m.status, owner: m.owner })),
    tasks,
    features: featureTally,
    loops: loopTally,
    feature_rows: features,
    loop_rows: heartbeats,
  };

  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }

  const line = (s) => console.log(s);
  if (summary) {
    line(`truth [${taskScopeLabel(scope)}]: features ${featureTally.proven || 0} proven / ${featureTally.stale || 0} stale / ${featureTally.blocked || 0} blocked / ${featureTally.unproven || 0} unproven / ${featureTally.parked || 0} parked · loops ${loopTally.proven || 0} live / ${(loopTally.stale || 0) + (loopTally['never-ran'] || 0)} stale / ${loopTally.blocked || 0} failing · missions ${missions.length} active`);
    return 0;
  }

  line('ATRIS TRUTH — live state, not belief\n');
  line(`Scope: ${taskScopeLine(scope)}`);

  line(`Missions active: ${missions.length}`);
  for (const m of missions) line(`  ${m.status.padEnd(8)} ${m.owner || '?'}  ${m.id || m.mission_id}`);

  if (tasks) {
    line(`\nTasks: ${Object.entries(tasks).map(([k, v]) => `${v} ${k}`).join(', ')}`);
  }

  line(`\nFeature lanes (${features.length}):`);
  const order = { blocked: 0, stale: 1, unproven: 2, proven: 3, parked: 4 };
  for (const f of features.sort((a, b) => (order[a.verdict] ?? 9) - (order[b.verdict] ?? 9))) {
    line(`  ${f.verdict.padEnd(9)} ${fmtAge(f.proofAgeDays).padStart(6)}  ${f.lane}`);
  }

  line(`\nLoops (${heartbeats.length}):`);
  for (const h of heartbeats) {
    const age = h.source === 'launchd' ? 'launchd' : fmtAge(h.lastRunAgeDays);
    line(`  ${h.verdict.padEnd(9)} ${age.padStart(7)}  ${h.id}${h.fails ? `  fails=${h.fails}` : ''}`);
  }

  line(`\nVerdict key: proven = receipt within ${STALE_DAYS}d · stale = receipt older · unproven = no receipt, edited within ${PARKED_DAYS}d · parked = no receipt, untouched ${PARKED_DAYS}d+ · blocked = failing now`);
  return 0;
}

module.exports = { truthCommand };
