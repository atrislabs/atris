'use strict';

// Outdated models on the roster. A roster worker whose model has a newer
// version among the models this machine or the engine registry already
// knows gets one plain line and the command that moves it forward. A pinned
// model whose newest proof (a "verified <date>" on its line, or a landed run
// on that model) is over 30 days old gets one line too. Nothing here goes
// online: the model lists come from availableModels (codex's own models
// cache, the claude names atris knows, and each engine's registry models).

const { modelLabel, availableModels } = require('./roster-models');
const { parseRosterUntil, rosterMaxText, rosterToolLabel } = require('./engine-registry');

const PIN_MAX_AGE_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const CLAUDE_FAMILY = Object.freeze(['claude', 'fable', 'haiku']);

// Family ordering across names is ambiguous: going from a "luna" tail to a
// "sol" tail one version up is a tier change as much as a version change,
// and nothing local says which tails rank above which. So versions are only
// compared within an identical name prefix, the text before the first
// version number: "x-6-astra" and "x-6.1-sol" share the prefix "x", and two
// names with different prefixes (sonnet and opus) never compare. Among
// newer versions, one that keeps the same tail (sol, fast, flash-high) wins;
// otherwise the highest version, and on a tie the one the list names first.
// Examples stay abstract here so this file never pins a real model name.
// A context tag at the end ("[1m]", "(beta)") is not part of the name, and
// a leading "claude-" before a family word is the vendor, not the family,
// so "claude-x-4-6[1m]" and "x 5" land in the same family.
function familyLabel(model) {
  let text = String(model || '').trim();
  while (/\s*(?:\[[^\]]*\]|\([^)]*\))$/.test(text)) text = text.replace(/\s*(?:\[[^\]]*\]|\([^)]*\))$/, '');
  return modelLabel(text).toLowerCase().trim().replace(/^claude[\s_-]+(?=[a-z])/, '');
}

function modelFamily(model) {
  const label = familyLabel(model);
  const match = /^([a-z][a-z/_\s-]*?)[\s_-]*(\d+(?:[.-]\d{1,2}(?!\d))*)(.*)$/.exec(label);
  if (!match) return null;
  const prefix = match[1].replace(/[\s_-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!prefix) return null;
  return {
    prefix,
    version: match[2].split(/[.-]/).map(Number),
    variant: match[3].replace(/[\s_-]+/g, '-').replace(/^-+|-+$/g, ''),
  };
}

function compareVersions(a, b) {
  const size = Math.max(a.length, b.length);
  for (let i = 0; i < size; i += 1) {
    const diff = (a[i] || 0) - (b[i] || 0);
    if (diff) return diff > 0 ? 1 : -1;
  }
  return 0;
}

function sameModel(a, b) {
  const left = modelLabel(a).toLowerCase().trim();
  return Boolean(left) && left === modelLabel(b).toLowerCase().trim();
}

// The newest model in the list that beats this one, or null.
function newerModel(model, catalog = []) {
  const current = modelFamily(model);
  if (!current) return null;
  let best = null;
  for (const candidate of catalog || []) {
    const family = modelFamily(candidate);
    if (!family || family.prefix !== current.prefix) continue;
    if (compareVersions(family.version, current.version) <= 0) continue;
    const sameTail = family.variant === current.variant;
    const better = !best
      || (sameTail && !best.sameTail)
      || (sameTail === best.sameTail && compareVersions(family.version, best.family.version) > 0);
    if (better) best = { candidate, family, sameTail };
  }
  return best ? best.candidate : null;
}

// Every model each engine is known to offer, from local files only. Claude,
// fable, and haiku run through the same CLI, so they share one list.
function modelCatalog(engines, options = {}) {
  const catalog = {};
  const add = (id, models) => {
    const list = catalog[id] || (catalog[id] = []);
    for (const model of models || []) if (model && !list.includes(model)) list.push(model);
  };
  const rows = availableModels(engines || [], options);
  for (const row of rows) add(row.engine, row.models);
  for (const engine of engines || []) add(engine.id, engine.models);
  const claude = (rows.find((row) => row.engine === 'claude') || {}).models || [];
  for (const id of CLAUDE_FAMILY) if (catalog[id]) add(id, claude);
  return catalog;
}

function localDayText(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function wholeDaysSince(dayText, now) {
  const day = parseRosterUntil(dayText);
  if (!day) return null;
  const date = new Date(now);
  const today = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  return Math.round((today.getTime() - day.getTime()) / DAY_MS);
}

// The newest proof that this engine and model answer: the line's own
// "verified" date or the newest landed run on the same engine and model.
function pinVerified(worker, runs) {
  let best = worker.verified ? { at: worker.verified, source: 'roster line' } : null;
  for (const run of runs || []) {
    if (run.outcome !== 'landed' || run.engine !== worker.engine || !sameModel(run.model, worker.model)) continue;
    const at = Date.parse(run.at);
    if (!Number.isFinite(at)) continue;
    const day = localDayText(new Date(at));
    if (!best || day > best.at) best = { at: day, source: 'landed run' };
  }
  return best;
}

function quoteArg(text) {
  const value = String(text || '');
  return /^[A-Za-z0-9._:/@-]+$/.test(value) ? value : `"${value.replace(/"/g, '\\"')}"`;
}

const SCOPE_FLAGS = Object.freeze({ 'all projects': '--everywhere', 'this session': '--session' });

// The assign command that moves a job's first worker to the newer model and
// keeps everything else on its line: effort, time cap, prep, end date.
function assignCommand(row, worker, model) {
  const parts = ['atris engine assign', quoteArg(row.job), worker.engine, '--model', quoteArg(modelLabel(model))];
  if (worker.effort) parts.push('--effort', worker.effort);
  if (worker.max_seconds) parts.push('--max', quoteArg(rosterMaxText(worker.max_seconds).replace(/^max /, '')));
  if (worker.prep) parts.push('--prep', quoteArg(worker.prep));
  if (worker.until && Number(worker.ends_in_days) > 0) parts.push('--days', String(worker.ends_in_days));
  if (SCOPE_FLAGS[row.from]) parts.push(SCOPE_FLAGS[row.from]);
  return parts.join(' ');
}

function lineHint(file, line, change) {
  const where = line ? `line ${line} of ${file || 'the roster'}` : (file || 'the roster');
  return `${change} on ${where}`;
}

// Mark every worker and job in a roster report with stale_model,
// newer_model, pin_age_days, and pin_verified_at, and list what needs a
// look in report.stale. Returns the report.
function attachStaleModels(report, { catalog = {}, runs = [], now = new Date() } = {}) {
  const stale = [];
  const today = localDayText(new Date(now));
  for (const row of report.jobs || []) {
    (row.workers || []).forEach((worker, index) => {
      worker.stale_model = false;
      worker.newer_model = null;
      worker.pin_age_days = null;
      worker.pin_verified_at = null;
      const view = worker.runs;
      if (!view || !view.model || !worker.engine || worker.why === 'expired') return;
      const who = index === 0 ? row.job : `${row.job} backup`;
      const tool = rosterToolLabel(worker.engine);
      const newer = newerModel(view.model, catalog[worker.engine]);
      if (newer) {
        worker.stale_model = true;
        worker.newer_model = newer;
        const from = view.model_source === 'roster' ? '' : ` from ${view.model_source}`;
        const renew = index === 0
          ? assignCommand(row, worker, newer)
          : lineHint(row.file, worker.line, `change the model to ${modelLabel(newer)}`);
        stale.push({
          kind: 'newer model',
          job: row.job,
          engine: worker.engine,
          model: view.model,
          newer_model: newer,
          from: row.from,
          file: row.file,
          line: worker.line,
          renew,
          text: `${who}: ${tool} runs ${modelLabel(view.model)}${from}, newer ${modelLabel(newer)} is available. renew: ${renew}`,
        });
      }
      if (view.model_source !== 'roster') return;
      const proof = pinVerified({ ...worker, model: view.model }, runs);
      if (!proof) return;
      worker.pin_verified_at = proof.at;
      worker.pin_age_days = wholeDaysSince(proof.at, now);
      if (worker.pin_age_days === null || worker.pin_age_days <= PIN_MAX_AGE_DAYS || newer) return;
      stale.push({
        kind: 'old pin',
        job: row.job,
        engine: worker.engine,
        model: view.model,
        pin_verified_at: proof.at,
        pin_age_days: worker.pin_age_days,
        from: row.from,
        file: row.file,
        line: worker.line,
        text: `${who}: ${tool} on ${modelLabel(view.model)} was last verified ${worker.pin_age_days} days ago (${proof.source}). smoke one prompt, then ${lineHint(row.file, worker.line, `add "verified ${today}"`)}`,
      });
    });
    // The job's own fields mirror the worker that leads it, else its first.
    const lead = (row.workers || []).find((worker) => worker.status === 'leads') || (row.workers || [])[0] || {};
    row.stale_model = Boolean(lead.stale_model);
    row.newer_model = lead.newer_model || null;
    row.pin_age_days = lead.pin_age_days === undefined ? null : lead.pin_age_days;
  }
  // A member line that pins its own model is checked too; a member that
  // picks automatically runs its job's worker, already checked above.
  for (const member of report.team || []) {
    if (member.source !== 'file' || !member.model || !member.engine) continue;
    const newer = newerModel(member.model, catalog[member.engine]);
    member.stale_model = Boolean(newer);
    member.newer_model = newer;
    if (!newer) continue;
    const renew = `change the model to ${modelLabel(newer)} on the ${member.member} line of ${member.file || 'the roster'}`;
    stale.push({
      kind: 'newer model',
      member: member.member,
      engine: member.engine,
      model: member.model,
      newer_model: newer,
      file: member.file,
      renew,
      text: `${member.member}: ${rosterToolLabel(member.engine)} runs ${modelLabel(member.model)}, newer ${modelLabel(newer)} is available. renew: ${renew}`,
    });
  }
  report.stale = stale;
  return report;
}

module.exports = {
  PIN_MAX_AGE_DAYS,
  attachStaleModels,
  compareVersions,
  modelCatalog,
  modelFamily,
  newerModel,
};
