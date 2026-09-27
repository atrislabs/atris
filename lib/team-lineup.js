'use strict';

// Who does each job, worded for `atris team` and the session boot. The rows
// come from the same resolver `atris engine roster` uses (jobRosterView and
// rosterReport in commands/engine.js); this file only picks and words them.

const { engineRunsView, modelLabel } = require('./roster-models');
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

function runsText(view) {
  return view && view.text ? view.text : 'no ready tool';
}

// "who does each job" lines: the tool and model running each job now, its
// backup, and a short note when the router or a backup is standing in.
function renderJobLines(jobs, { width = 80 } = {}) {
  const rows = orderJobs(jobs);
  if (!rows.length) return [];
  const labelWidth = Math.max(...rows.map((row) => row.job.length));
  return rows.map((row) => {
    const head = `  ${row.job.padEnd(labelWidth)}  ${runsText(row.now_runs)}`;
    let note = '';
    if (!row.pick) note = row.like ? `, same as ${row.like}` : ', picked by the router';
    else if (row.lead === 'first' && row.backup_runs) note = `, backup ${row.backup_runs.text}`;
    else if (row.lead !== 'first') note = row.status === 'expired' ? ', first pick expired' : ', first pick not ready';
    const line = `${head}${note}`;
    return line.length <= width || row.lead !== 'first' ? line : head;
  });
}

// Names under each job, wrapped to the width. A member running something
// other than its job's tool and model says what it runs.
function renderMemberLines(team, jobs, { width = 80 } = {}) {
  const members = Array.isArray(team) ? team : [];
  if (!members.length) return [];
  const rows = orderJobs(jobs);
  const order = [...rows.map((row) => row.job)];
  for (const member of members) if (member.job && !order.includes(member.job)) order.push(member.job);
  const groups = order
    .map((job) => ({ job, row: rows.find((row) => row.job === job) || null, names: members.filter((member) => member.job === job) }))
    .filter((group) => group.names.length);
  const labelWidth = Math.max(...groups.map((group) => group.job.length));
  const indent = ' '.repeat(labelWidth + 4);
  const lines = [];
  for (const group of groups) {
    const jobText = group.row && group.row.now_runs ? group.row.now_runs.text : '';
    const names = group.names.map((member) => {
      const text = member.engine ? engineRunsView(member.engine, { model: member.model || '', effort: member.effort || '' }).text : 'no ready tool';
      return text === jobText ? member.member : `${member.member} on ${text}`;
    });
    let line = `  ${group.job.padEnd(labelWidth)}  `;
    let fresh = true;
    for (const name of names) {
      const piece = fresh ? name : `, ${name}`;
      if (!fresh && line.length + piece.length + 1 > width) {
        lines.push(`${line},`);
        line = `${indent}${name}`;
      } else {
        line += piece;
      }
      fresh = false;
    }
    lines.push(line);
  }
  return lines;
}

// The block `atris team` prints before today's active and rest lists.
function renderLineup(lineup, { width = 80 } = {}) {
  if (!lineup || !lineup.ok) return '';
  const jobLines = renderJobLines(lineup.jobs, { width });
  const memberLines = renderMemberLines(lineup.team, lineup.jobs, { width });
  const blocks = [];
  if (jobLines.length) blocks.push(['who does each job:', ...jobLines].join('\n'));
  if (memberLines.length) blocks.push(['who is on each job:', ...memberLines].join('\n'));
  return blocks.join('\n\n');
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

const LINEUP_UNREADABLE = 'could not read who does each job, so tools and models are not shown. try: atris engine roster';

module.exports = {
  LINEUP_UNREADABLE,
  bootTeamLine,
  memberLineup,
  readLineupSafe,
  renderLineup,
};
