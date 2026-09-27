'use strict';

// Suggestions from the run record. When a job's first worker keeps stalling
// or failing and a worker further down its list keeps landing, the roster
// view says so once, with the command that would move the better worker up.
// Nothing here writes ROSTER.md: only a person (or a person telling an
// agent) changes the roster. This file only reads runs and words a line.

const { readRosterRuns, workerRuns } = require('./roster-runs');
const { rosterToolLabel, rosterMaxText } = require('./engine-registry');

// Only the last week counts, and within it each worker's newest few runs.
const SUGGEST_DAYS = 7;
const SUGGEST_WINDOW_RUNS = 5;
// The lead needs enough runs to judge; the challenger needs at least two.
const SUGGEST_MIN_LEAD_RUNS = 3;
const SUGGEST_MIN_CHALLENGER_RUNS = 2;
// The lead lands under half its runs, and the challenger's landed rate is
// at least 25 points higher.
const SUGGEST_LEAD_BELOW_POINTS = 50;
const SUGGEST_MIN_GAP_POINTS = 25;
// The boot line reads only this much of the end of the record.
const BOOT_TAIL_BYTES = 64 * 1024;

// A credit wall says nothing about how well a worker does the job, and
// engine health already benches it, so credit out runs are left out.
function judgedRuns(runs) {
  return runs
    .filter((run) => run.outcome !== 'credit out')
    .map((run, index) => ({ run, index }))
    .sort((a, b) => (Date.parse(b.run.at) - Date.parse(a.run.at)) || (b.index - a.index))
    .slice(0, SUGGEST_WINDOW_RUNS)
    .map(({ run }) => run);
}

function tally(runs) {
  const landed = runs.filter((run) => run.outcome === 'landed').length;
  return { runs: runs.length, landed };
}

function workerName(worker) {
  if (worker.runs && worker.runs.text) return worker.runs.text;
  return [rosterToolLabel(worker.engine), worker.model].filter(Boolean).join(' ');
}

function quoteArg(value) {
  const text = String(value);
  return /^[a-z0-9._:/@+-]+$/i.test(text) ? text : `"${text.replace(/(["\\$`])/g, '\\$1')}"`;
}

// The assign command that puts the challenger first and keeps the old lead
// right behind it, each with its own settings from its roster line.
function assignArgs(job, challenger, lead) {
  const args = ['assign', job, rosterToolLabel(challenger.engine)];
  if (challenger.model) args.push('--model', challenger.model);
  if (challenger.effort) args.push('--effort', challenger.effort);
  if (challenger.max_seconds) args.push('--max', rosterMaxText(challenger.max_seconds).replace(/^max /, ''));
  if (challenger.prep) args.push('--prep', challenger.prep);
  args.push('--backup', [rosterToolLabel(lead.engine), lead.model, lead.effort].filter(Boolean).join(' '));
  return args;
}

function leadText(name, count) {
  const missed = count.runs - count.landed;
  const outcomes = [...new Set(count.list.filter((run) => run.outcome !== 'landed').map((run) => run.outcome))];
  const last = `of its last ${count.runs} run${count.runs === 1 ? '' : 's'}`;
  if (missed && outcomes.length === 1) return `${name} ${outcomes[0]} ${missed} ${last}`;
  return `${name} landed ${count.landed} ${last}`;
}

// At most one suggestion for one job row of the roster report, or null. A
// row's workers carry their status: a worker that is cooling, expired, not
// ready, or on a bad line is skipped and is never suggested.
function jobSuggestion(row, runs) {
  if (!row || !row.pick || !Array.isArray(row.workers) || row.workers.length < 2) return null;
  const job = row.key || row.job;
  const usable = row.workers.filter((worker) => worker.engine && !worker.text);
  const lead = usable[0];
  if (!lead) return null;
  const countFor = (worker) => {
    const list = judgedRuns(workerRuns(runs, { job, engine: worker.engine, model: worker.model || '' }));
    return { ...tally(list), list };
  };
  const leadCount = countFor(lead);
  if (leadCount.runs < SUGGEST_MIN_LEAD_RUNS) return null;
  if (leadCount.landed * 100 >= SUGGEST_LEAD_BELOW_POINTS * leadCount.runs) return null;
  let best = null;
  for (const worker of usable.slice(1)) {
    if (worker.status === 'skipped') continue;
    const count = countFor(worker);
    if (count.runs < SUGGEST_MIN_CHALLENGER_RUNS) continue;
    // Whole-number math: the challenger's rate minus the lead's, in points.
    const gap = 100 * (count.landed * leadCount.runs - leadCount.landed * count.runs);
    if (gap < SUGGEST_MIN_GAP_POINTS * leadCount.runs * count.runs) continue;
    const rate = count.landed / count.runs;
    if (!best || rate > best.rate || (rate === best.rate && count.runs > best.count.runs)) best = { worker, count, rate };
  }
  if (!best) return null;
  const leadName = workerName(lead);
  const challengerName = workerName(best.worker);
  const args = assignArgs(row.job, best.worker, lead);
  const command = `atris engine ${args.map(quoteArg).join(' ')}`;
  const record = `${leadText(leadName, leadCount)}; ${challengerName} landed ${best.count.landed} of ${best.count.runs}`;
  return {
    job: row.job,
    days: SUGGEST_DAYS,
    lead: { engine: lead.engine, model: lead.model || null, runs: leadCount.runs, landed: leadCount.landed },
    challenger: { engine: best.worker.engine, model: best.worker.model || null, runs: best.count.runs, landed: best.count.landed },
    command,
    args,
    text: `${record}. to move ${rosterToolLabel(best.worker.engine)} up: ${command}`,
  };
}

// Attach a suggestion to each job row that has one. Returns how many.
function attachSuggestions(jobs, runs) {
  let count = 0;
  for (const row of jobs || []) {
    const suggestion = jobSuggestion(row, runs);
    if (suggestion) {
      row.suggestion = suggestion;
      count += 1;
    }
  }
  return count;
}

// How many jobs have a suggestion, reading only the end of the record. For
// the boot line: never throws, 0 when anything goes wrong.
function suggestionCount(jobs, root, { now } = {}) {
  try {
    const runs = readRosterRuns(root, { now, days: SUGGEST_DAYS, tailBytes: BOOT_TAIL_BYTES });
    if (!runs.length) return 0;
    return (jobs || []).filter((row) => jobSuggestion(row, runs)).length;
  } catch {
    return 0;
  }
}

module.exports = {
  SUGGEST_MIN_LEAD_RUNS,
  SUGGEST_MIN_CHALLENGER_RUNS,
  SUGGEST_LEAD_BELOW_POINTS,
  SUGGEST_MIN_GAP_POINTS,
  attachSuggestions,
  suggestionCount,
};
