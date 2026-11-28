'use strict';

// Suggestions from the run record. When a job's first worker keeps stalling
// or failing and a worker further down its list keeps landing, the roster
// view says so once, with the command that would move the better worker up.
// Nothing here writes ROSTER.md: only a person (or a person telling an
// agent) changes the roster. This file only reads runs and words a line.

const { readRosterRuns, workerRuns } = require('./roster-runs');
const { rosterToolLabel } = require('./engine-registry');

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
// Same-model effort downgrade: when a lower-effort line lands at least as well
// as a higher-effort lead and finishes at least 2x faster (or 2x cheaper),
// suggest promoting the lower-effort line.
const EFFORT_RANK = Object.freeze({ low: 1, medium: 2, high: 3, xhigh: 4, max: 5 });
const SUGGEST_MIN_EFFORT_RUNS = 3;
const SUGGEST_MIN_SPEEDUP = 2;
// The boot line reads only this much of the end of the record.
const BOOT_TAIL_BYTES = 64 * 1024;

// A credit wall says nothing about how well a worker does the job, and
// engine health already benches it, so credit out runs are left out. A held
// run has not landed or failed yet: its pull request waits for a person.
function judgedRuns(runs) {
  return runs
    .filter((run) => run.outcome !== 'credit out' && run.outcome !== 'review unavailable' && run.outcome !== 'held')
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

// The assign command that moves the challenger to the top of the job. It
// names the challenger's line exactly: the tool, plus its model and effort
// when its line has them, so --promote moves that worker and no other line
// of the same tool. --promote reorders lines as written, so the demoted
// lead keeps its own cap, prep, and notes.
function assignArgs(job, challenger) {
  const words = [rosterToolLabel(challenger.engine), challenger.model, challenger.effort].filter(Boolean).join(' ');
  return ['assign', job, '--promote', words];
}

function leadText(name, count) {
  const missed = count.runs - count.landed;
  const outcomes = [...new Set(count.list.filter((run) => run.outcome !== 'landed').map((run) => run.outcome))];
  const last = `of its last ${count.runs} run${count.runs === 1 ? '' : 's'}`;
  if (missed && outcomes.length === 1) return `${name} ${outcomes[0]} ${missed} ${last}`;
  return `${name} landed ${count.landed} ${last}`;
}

function medianNumber(values) {
  const nums = values.filter((value) => Number.isFinite(value) && value > 0).sort((a, b) => a - b);
  if (!nums.length) return null;
  const mid = Math.floor(nums.length / 2);
  return nums.length % 2 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
}

function effortRank(value) {
  const word = String(value || '').trim().toLowerCase();
  return EFFORT_RANK[word] || 3;
}

function sameEngineModel(a, b) {
  return Boolean(a && b && a.engine === b.engine && String(a.model || '').toLowerCase() === String(b.model || '').toLowerCase());
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
  // Separate runs by effort only when this job lists multiple efforts for the
  // same engine + model; legacy single-effort lines keep reading untagged history.
  const hasEffortSibling = (worker) => usable.some((other) => other !== worker && sameEngineModel(other, worker)
    && String(other.effort || '').toLowerCase() !== String(worker.effort || '').toLowerCase());
  const countFor = (worker) => {
    const filterEffort = hasEffortSibling(worker) ? (worker.effort || '') : '';
    const list = judgedRuns(workerRuns(runs, { job, engine: worker.engine, model: worker.model || '', effort: filterEffort }));
    return { ...tally(list), list };
  };
  const leadCount = countFor(lead);
  if (leadCount.runs < SUGGEST_MIN_LEAD_RUNS) return null;
  if (leadCount.landed * 100 < SUGGEST_LEAD_BELOW_POINTS * leadCount.runs) {
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
    const args = assignArgs(row.job, best.worker);
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

  // West Coast effort downgrade: same model at lower effort lands at least as
  // well as the lead while finishing >=2x faster or >=2x cheaper.
  if (leadCount.runs < SUGGEST_MIN_EFFORT_RUNS) return null;
  const leadMedSec = medianNumber(leadCount.list.map((r) => Number(r.seconds)));
  const leadMedCost = medianNumber(leadCount.list.map((r) => Number(r.cost_usd)));
  let bestEffort = null;
  for (const worker of usable.slice(1)) {
    if (worker.status === 'skipped') continue;
    if (!sameEngineModel(lead, worker) || !worker.effort) continue;
    if (effortRank(worker.effort) >= effortRank(lead.effort)) continue;
    const count = countFor(worker);
    if (count.runs < SUGGEST_MIN_EFFORT_RUNS) continue;
    if (count.landed * leadCount.runs < leadCount.landed * count.runs) continue;
    const chalMedSec = medianNumber(count.list.map((r) => Number(r.seconds)));
    const chalMedCost = medianNumber(count.list.map((r) => Number(r.cost_usd)));
    const speedup = (leadMedSec && chalMedSec) ? leadMedSec / chalMedSec : 0;
    const costCut = (leadMedCost && chalMedCost) ? leadMedCost / chalMedCost : 0;
    if (speedup < SUGGEST_MIN_SPEEDUP && costCut < SUGGEST_MIN_SPEEDUP) continue;
    const score = Math.max(speedup, costCut);
    if (!bestEffort || score > bestEffort.score) bestEffort = { worker, count, speedup, costCut, score };
  }
  if (!bestEffort) return null;
  const leadName = [workerName(lead), lead.effort || 'default'].join(' ');
  const challengerName = [workerName(bestEffort.worker), bestEffort.worker.effort].join(' ');
  const args = assignArgs(row.job, bestEffort.worker);
  const command = `atris engine ${args.map(quoteArg).join(' ')}`;
  const gain = bestEffort.speedup >= SUGGEST_MIN_SPEEDUP
    ? `${bestEffort.speedup.toFixed(1)}x faster`
    : `${bestEffort.costCut.toFixed(1)}x cheaper`;
  const record = `${challengerName} matched ${leadName} (${bestEffort.count.landed}/${bestEffort.count.runs} landed) and ran ${gain}`;
  return {
    job: row.job,
    days: SUGGEST_DAYS,
    kind: 'effort_downgrade',
    lead: { engine: lead.engine, model: lead.model || null, effort: lead.effort || null, runs: leadCount.runs, landed: leadCount.landed },
    challenger: { engine: bestEffort.worker.engine, model: bestEffort.worker.model || null, effort: bestEffort.worker.effort, runs: bestEffort.count.runs, landed: bestEffort.count.landed },
    command,
    args,
    text: `${record}. to drop effort: ${command}`,
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
