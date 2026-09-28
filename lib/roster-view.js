'use strict';

// The roster views behind `atris engine roster`, `atris team`, and the boot
// line: each job with its workers (who leads, who backs up, who is skipped
// and why), the team, and the warnings, as rows and as plain text. Reads
// only; the command file prints and dispatches.

const { HIDDEN_PROFILE_NAMES } = require('./runner-command');
const { ENGINE_ROLES, readEngineRegistry, resolveEngineForRoleRanked } = require('./engine-registry');
const { ROSTER_LAYERS, ROSTER_SOURCES, readRosterState, rosterDecided, rosterJobRole, rosterWorkerWalk } = require('./roster');
const {
  ENGINE_JOBS,
  customRosterJobKeys,
  parseRosterUntil,
  rosterJobLabel,
  rosterMaxText,
  rosterPickObject,
  rosterToolLabel,
} = require('./roster-words');
const { teamRosterView } = require('./member-engine');
const { engineRunsView, availableModels } = require('./roster-models');
const { readRosterRuns, workerRuns, summarizeRuns, DEFAULT_DAYS: RUN_DAYS } = require('./roster-runs');
const { attachSuggestions } = require('./roster-suggest');

const WORKER_SKIP_WORDS = Object.freeze({ 'not ready': 'down', expired: 'expired', 'bad model': 'names a model it cannot run' });

// One worker of a job's team as the view shows it: what it runs, and whether
// it leads now, backs up, or is skipped and why.
function workerRow(step, index, leadIndex) {
  const { worker } = step;
  const runs = worker.error ? null : engineRunsView(worker.engine, worker);
  const status = index === leadIndex ? 'leads' : step.skip ? 'skipped' : 'backup';
  const why = step.skip === 'bad line' ? `bad line: ${worker.error}`
    : step.skip === 'cooling' && step.cooling ? step.cooling.text
      : step.skip ? WORKER_SKIP_WORDS[step.skip] : '';
  return {
    engine: worker.engine || null,
    model: worker.model || null,
    effort: worker.effort || null,
    max_seconds: Number(worker.max_seconds) > 0 ? Number(worker.max_seconds) : null,
    prep: worker.prep ? rosterJobLabel(worker.prep) : null,
    until: worker.until || null,
    line: worker.line || null,
    ...(worker.error ? { text: worker.text || '' } : {}),
    status,
    why,
    ...(step.cooling ? { cooling_until: step.cooling.until, cooling_reason: step.cooling.reason } : {}),
    runs,
  };
}

function jobRosterRow(job, role, root, state, registry, now, key = role) {
  const custom = key !== role || !ENGINE_ROLES.includes(key);
  const layerPicks = Object.fromEntries(ROSTER_LAYERS.map((scope) => [scope, (state[scope] && state[scope].picks) || {}]));
  const picks = Object.fromEntries(ROSTER_LAYERS.map((scope) => [scope, rosterPickObject(layerPicks[scope][key])]));
  const resolved = resolveEngineForRoleRanked(role, root, {
    now,
    sessionRosterPicks: layerPicks.session,
    projectRosterPicks: layerPicks.project,
    machineRosterPicks: layerPicks.machine,
    ...(custom ? { job: key } : {}),
  });
  // Show the layer that decided; when none did, show the first one set. A
  // custom job that fell back to its kind's pick did not decide on its own.
  const decided = rosterDecided(resolved.source) && (!custom || resolved.job === job);
  const source = decided ? resolved.source : ROSTER_LAYERS.find((scope) => picks[scope]) || null;
  const pick = source ? picks[source] : null;
  const walk = pick ? rosterWorkerWalk(pick, role, registry, now) : [];
  const leadIndex = decided && resolved.source === source ? walk.findIndex((step) => !step.skip) : -1;
  const good = walk.map((step, index) => ({ step, index })).filter(({ step }) => !step.worker.error);
  const first = good[0] || null;
  const status = !pick ? 'router'
    : first && first.step.skip === 'expired' ? 'expired'
      : first && leadIndex === first.index ? 'picked'
        : first && first.step.skip === 'cooling' ? 'cooling'
          : 'not ready';
  const lead = leadIndex === -1 ? 'none'
    : first && leadIndex === first.index ? 'first'
      : good[1] && leadIndex === good[1].index ? 'backup'
        : 'later';
  const kind = Object.keys(ENGINE_JOBS).find((name) => ENGINE_JOBS[name] === role);
  // What the job really runs: its first two good workers, each with its own
  // model and effort, or the router's engine when no line decides.
  const runsOf = (entry) => (entry ? engineRunsView(entry.step.worker.engine, entry.step.worker) : null);
  const runs = runsOf(first);
  const nowRuns = resolved.engine
    ? engineRunsView(resolved.engine.id, { model: resolved.engine.roster_model || '', effort: resolved.engine.roster_effort || '' })
    : null;
  return {
    job,
    role,
    ...(custom ? { key, like: kind } : {}),
    pick,
    from: source ? ROSTER_SOURCES[source] : null,
    file: source ? state[source].file : null,
    session_pick: picks.session,
    project_pick: picks.project,
    machine_pick: picks.machine,
    engine: resolved.engine ? resolved.engine.id : null,
    model: resolved.engine && resolved.engine.roster_model ? resolved.engine.roster_model : null,
    effort: resolved.engine && resolved.engine.roster_effort ? resolved.engine.roster_effort : null,
    max_seconds: pick && Number(pick.max_seconds) > 0 ? Number(pick.max_seconds) : null,
    prep: first && first.step.worker.prep ? rosterJobLabel(first.step.worker.prep) : null,
    backup_prep: good[1] && good[1].step.worker.prep ? rosterJobLabel(good[1].step.worker.prep) : null,
    runs: runs || nowRuns,
    backup_runs: runsOf(good[1]),
    now_runs: nowRuns,
    workers: walk.map((step, index) => workerRow(step, index, leadIndex)),
    lead,
    status,
    ...(status === 'cooling' ? { cooling: first.step.cooling.text } : {}),
    reason: resolved.reason,
  };
}

// The three built-in jobs first, then the owner's own jobs from this
// session, this project, and the all-projects roster.
function jobRosterView(root = process.cwd(), now = new Date(), state = null) {
  const registry = readEngineRegistry(root);
  const layers = state || readRosterState(root, { now });
  const rows = Object.entries(ENGINE_JOBS).map(([job, role]) => jobRosterRow(job, role, root, layers, registry, now));
  const customKeys = [...new Set(ROSTER_LAYERS.flatMap((scope) => customRosterJobKeys(layers[scope] && layers[scope].picks)))];
  for (const key of customKeys) {
    const role = rosterJobRole(key, root, {
      now,
      sessionRosterPicks: layers.session.picks,
      projectRosterPicks: layers.project.picks,
      machineRosterPicks: layers.machine.picks,
    });
    if (!role) continue;
    rows.push(jobRosterRow(rosterJobLabel(key), role, root, layers, registry, now, key));
  }
  return rows;
}

// Jobs, the team, and one warning per roster line that could not be used.
function rosterReport(root = process.cwd(), now = new Date()) {
  const state = readRosterState(root, { now });
  const jobs = jobRosterView(root, now, state);
  const team = teamRosterView(root, { now, rosterState: state });
  return {
    jobs,
    team: team.rows,
    warnings: [...ROSTER_LAYERS.flatMap((scope) => state[scope].warnings), ...team.warnings],
    files: Object.fromEntries(ROSTER_LAYERS.map((scope) => [scope, state[scope].format === 'none' ? null : state[scope].file])),
    session: state.session.key || null,
  };
}

function untilText(worker) {
  const until = parseRosterUntil(worker.until);
  if (until) return `until ${until.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }).toLowerCase()}`;
  return worker.never_expires ? 'no end date' : 'until no valid date';
}

// Every worker under its job, numbered in order, when the job has more than
// the lead and one backup (the job's own line already shows those two).
function renderWorkerLines(row) {
  if (!row.workers || row.workers.length <= 2) return [];
  const width = Math.max(...row.workers.map((worker) => (worker.runs ? worker.runs.text : worker.text || '').length));
  return row.workers.map((worker, index) => {
    const what = (worker.runs ? worker.runs.text : worker.text || '').padEnd(width);
    const extras = [worker.max_seconds ? rosterMaxText(worker.max_seconds) : '', worker.prep ? `prepped by ${worker.prep}` : '', worker.until ? `until ${worker.until}` : ''].filter(Boolean);
    const state = worker.status === 'leads' ? 'leads now' : worker.status === 'backup' ? 'backup' : `skipped, ${worker.why}`;
    return `  ${index + 1}. ${what} ${[state, ...extras].join(', ')}`.trimEnd();
  });
}

// Each worker's recent record under its job, only for workers with runs.
function renderWorkerRecords(row) {
  return (row.workers || [])
    .filter((worker) => worker.record)
    .map((worker) => `  ${worker.runs ? worker.runs.text : worker.engine}: ${worker.record.text}`);
}

function renderJobRoster(rows) {
  const width = Math.max(7, ...rows.map((row) => row.job.length));
  const ownerWidth = Math.max(24, ...rows.filter((row) => row.pick && row.runs).map((row) => row.runs.text.length));
  const backupWidth = Math.max(16, ...rows.filter((row) => row.backup_runs).map((row) => row.backup_runs.text.length + 7));
  return rows.map((row) => {
    const label = row.job.padEnd(width);
    const nowText = row.now_runs ? row.now_runs.text : 'no ready engine';
    const fallsTo = `${row.like ? `falls back to ${row.like}` : 'router decides'}: ${nowText}`;
    if (!row.pick) return `${label} no pick, ${fallsTo}`;
    const owner = row.runs.text.padEnd(ownerWidth);
    const backup = row.backup_runs ? `backup ${row.backup_runs.text}${row.backup_prep ? ` prepped by ${row.backup_prep}` : ''}` : 'no backup';
    const cap = `${row.max_seconds ? `${rosterMaxText(row.max_seconds)}, ` : ''}${row.prep ? `prepped by ${row.prep}, ` : ''}`;
    const date = untilText(row.pick);
    const fallback = row.lead === 'backup' ? 'using backup' : row.lead === 'later' ? `using ${nowText}` : fallsTo;
    const status = row.status === 'expired' ? `expired, ${fallback}`
      : row.status === 'cooling' ? `${row.cooling}, ${fallback}`
        : row.status === 'not ready' ? `not ready, ${fallback}`
          : date;
    const where = row.file ? `${row.from} (${row.file})` : row.from;
    const head = `${label} ${owner} ${backup.padEnd(backupWidth)} ${cap}${status}, ${where}`.trimEnd();
    const suggestion = row.suggestion ? [`  suggestion: ${row.suggestion.text}`] : [];
    return [head, ...renderWorkerLines(row), ...renderWorkerRecords(row), ...suggestion].join('\n');
  }).join('\n');
}

function renderTeamRoster(rows) {
  if (!rows.length) return '';
  const width = Math.max(6, ...rows.map((row) => row.member.length));
  const jobWidth = Math.max(6, ...rows.map((row) => String(row.job || '').length));
  const lines = rows.map((row) => {
    const engine = row.engine ? engineRunsView(row.engine, row).text : 'no ready engine';
    const how = row.source === 'file' ? `from ${row.file}` : 'automatic';
    return `${row.member.padEnd(width)} ${String(row.job || '').padEnd(jobWidth)} ${engine.padEnd(24)} ${how}`.trimEnd();
  });
  return ['team', ...lines].join('\n');
}

function renderRosterWarnings(warnings) {
  return warnings.map((warning) => `warning: ${warning.file} line ${warning.line} "${warning.text}" ${warning.message}.`).join('\n');
}

function renderRosterReport(report) {
  return [renderJobRoster(report.jobs), renderTeamRoster(report.team), renderRosterWarnings(report.warnings)]
    .filter(Boolean)
    .join('\n\n');
}

const AVAILABLE_HINT = 'see which tools and models this machine has: atris engine roster --available';

// Each installed tool and the models it offers, from local files only.
function availableReport(root) {
  const engines = readEngineRegistry(root, { persist: false }).engines
    .filter((engine) => !HIDDEN_PROFILE_NAMES.includes(engine.id))
    .filter((engine) => engine.installed || (engine.health && engine.health.status === 'ready'));
  return availableModels(engines).map((row) => ({ ...row, tool: rosterToolLabel(row.engine) }));
}

function renderAvailable(rows) {
  if (!rows.length) return 'no tools found on this machine. run atris engine doctor to check again';
  const width = Math.max(...rows.map((row) => row.tool.length));
  return ['on this machine', ...rows.map((row) => `${row.tool.padEnd(width)}  ${row.models.join(', ') || 'its own default'}  (${row.source})`)].join('\n');
}

// Only this session's changes: the jobs it decided and the team lines from
// its own file.
function sessionRosterRows(report) {
  return {
    jobs: report.jobs.filter((row) => row.from === ROSTER_SOURCES.session),
    team: report.team.filter((row) => row.source === 'file' && row.file === report.files.session),
  };
}

function renderSessionRoster(report, key) {
  const { jobs, team } = sessionRosterRows(report);
  if (!jobs.length && !team.length) return `this session (${key}) has no roster changes. add one with: atris engine assign <job> <tool> --session`;
  const head = `this session (${key}) changes${report.files.session ? `, from ${report.files.session}` : ''}`;
  return [head, renderJobRoster(jobs), renderTeamRoster(team)].filter(Boolean).join('\n\n');
}

// Attach each worker's recent record (last 7 days) to the roster report, and
// at most one suggestion per job when that record says the order is wrong.
// Only the roster command reads the whole tail of the run file; the boot
// line reads a smaller tail just to count suggestions. Nothing here writes
// the roster: a suggestion is a line to read and a command a person may run.
function attachRunRecords(report, root, now = new Date()) {
  const runs = readRosterRuns(root, { now, days: RUN_DAYS });
  if (!runs.length) return report;
  for (const row of report.jobs || []) {
    for (const worker of row.workers || []) {
      if (!worker.engine) continue;
      const record = summarizeRuns(workerRuns(runs, { job: row.key || row.job, engine: worker.engine, model: worker.model || '' }), { days: RUN_DAYS });
      if (record) worker.record = record;
    }
  }
  attachSuggestions(report.jobs, runs);
  return report;
}

module.exports = {
  AVAILABLE_HINT, attachRunRecords, availableReport, jobRosterView, renderAvailable,
  renderRosterReport, renderSessionRoster, rosterReport, sessionRosterRows,
};
