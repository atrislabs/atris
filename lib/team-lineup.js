'use strict';

// Who does each job, worded for `atris team` and the session boot. The rows
// come from the same resolver `atris engine roster` uses (jobRosterView and
// rosterReport in commands/engine.js); this file only picks and words them.

const { modelLabel } = require('./roster-models');
const { rosterToolLabel } = require('./engine-registry');
const { suggestionCount } = require('./roster-suggest');

const BUILT_IN_JOBS = Object.freeze(['build', 'review', 'search']);
const CLAUDE_FAMILY = Object.freeze(['claude', 'fable', 'haiku']);

// Built-in jobs in the order people say them, then the owner's own jobs.
function orderJobs(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const builtIn = BUILT_IN_JOBS.map((job) => list.find((row) => row.job === job && !row.key)).filter(Boolean);
  return [...builtIn, ...list.filter((row) => !builtIn.includes(row))];
}

// "opus 5.5" for a claude model, "codex gpt-6-astra" for anything else, and
// just the tool when it runs its own default.
function shortRuns(view) {
  if (!view || !view.engine) return '';
  const tool = rosterToolLabel(view.engine);
  if (!view.model) return tool;
  const label = modelLabel(view.model);
  // "atris:fast" on atris fast says the tool twice; "grok 4.7 fast" on grok
  // already names it.
  const plain = (text) => String(text).toLowerCase().replace(/[^a-z0-9.]+/g, ' ').trim();
  if (plain(label) === plain(tool)) return tool;
  if (CLAUDE_FAMILY.includes(view.engine) || plain(label).startsWith(`${plain(tool)} `)) return label;
  return `${tool} ${label}`;
}

// The full lineup: every job and every member, read once. Throws when the
// roster cannot be read; callers decide how to say so.
function readLineup(root = process.cwd(), now = new Date()) {
  const { rosterReport } = require('../commands/engine');
  const report = rosterReport(root, now);
  return { jobs: orderJobs(report.jobs), team: report.team || [] };
}

// The same read, never throwing: { ok: false, error } when it fails.
function readLineupSafe(root = process.cwd(), now = new Date()) {
  try {
    return { ok: true, ...readLineup(root, now) };
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error || 'unknown error'), jobs: [], team: [] };
  }
}

// One boot line: the tool and model that runs each built-in job right now,
// custom jobs only when all of them still fit. '' when nothing resolves.
// When the run record suggests a new order for any job, a short marker
// points at the roster view; only the end of the record is read.
function bootTeamLine(root = process.cwd(), { width = 69, now = new Date(), jobs = null } = {}) {
  let rows = jobs;
  if (!rows) {
    const { jobRosterView } = require('../commands/engine');
    rows = jobRosterView(root, now);
  }
  const ordered = orderJobs(rows);
  const part = (row) => {
    const text = shortRuns(row.now_runs);
    return text ? `${row.job} ${text}` : '';
  };
  const builtIn = ordered.filter((row) => BUILT_IN_JOBS.includes(row.job) && !row.key).map(part).filter(Boolean);
  const custom = ordered.filter((row) => !BUILT_IN_JOBS.includes(row.job) || row.key).map(part).filter(Boolean);
  if (!builtIn.length && !custom.length) return '';
  const count = suggestionCount(ordered, root, { now });
  const marker = count ? ` · ${count} suggestion${count === 1 ? '' : 's'} (atris engine roster)` : '';
  const all = [...builtIn, ...custom].join(' · ');
  if (all.length + marker.length <= width || !builtIn.length) return `${all}${marker}`;
  return `${builtIn.join(' · ')}${marker}`;
}

// Per member, for json: the job, tool, model, and whether a roster line or
// the automatic match decided it. null for a name the lineup does not know.
function memberLineup(lineup, name) {
  if (!lineup || !lineup.ok) return null;
  const key = String(name || '').trim().toLowerCase();
  const row = (lineup.team || []).find((member) => String(member.member || '').toLowerCase() === key);
  if (!row) return null;
  return {
    job: row.job || null,
    engine: row.engine || null,
    model: row.model || null,
    effort: row.effort || null,
    source: row.source === 'file' ? 'roster' : 'automatic',
    file: row.file || null,
  };
}

// The two commands under both team tables: the real way to change a job's
// worker (assign takes a job, not a member) and the real way to start a
// member working (it runs on the member's roster engine).
const TEAM_FOOTER = Object.freeze([
  'change who does a job: atris engine assign <job> <tool> --model <model>',
  'launch a member: atris member run <member> "<goal>" --minutes 30',
]);

const LINEUP_UNREADABLE = 'could not read who does each job, so tools and models are not shown. try: atris engine roster';

module.exports = {
  LINEUP_UNREADABLE,
  TEAM_FOOTER,
  bootTeamLine,
  memberLineup,
  readLineupSafe,
};
