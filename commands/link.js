'use strict';

// atris link "<thing a>" "<thing b>" [--context "..."] [--team] [--json]
//
// Asks what two things could become together. The answer is one short line
// naming the connection, a plain why, a bounded first thing to make, and the
// team member who should make it. The question goes to the roster's engine
// for the job (a `link` job when the roster has one, else the `build` lead),
// through the same read-only runner `atris engine ask` uses. Nothing is
// written except the run record line every ask leaves.

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  MAX_ASK_PROMPT_BYTES,
  buildReadOnlyEngineInvocation,
  runAskProcess,
  runEngineAskJobs,
} = require('../lib/engine-ask');
const { isMemberParked } = require('../lib/member-park');

const LINK_TIMEOUT_MS = 180 * 1000;
const TEAM_FRESH_DAYS = 5;
const TEAM_NOTE_CHARS = 280;
const MAX_LINE_WORDS = 12;
const MEMBER_NAME_RE = /^[a-zA-Z0-9._-]+$/;

const SYSTEM_PROMPT = [
  'You look at two things a person cares about and say what they could become together.',
  '',
  'Rules:',
  '- Use only facts stated in the two things, the context, and the team notes below. Do not read files, search, or run anything. Do not invent numbers, names, customers, or results.',
  '- Plain words, the way a person talks. No em dashes. No hype or sales words; say the specific thing.',
  `- line: one sentence of at most ${MAX_LINE_WORDS} words naming the connection.`,
  '- why: two or three short sentences. Each one rests on something in the inputs.',
  '- experiment.label: a small first thing to make, in a few words.',
  '- experiment.scope: one sentence saying what it will do and what it will not do.',
  '- by: one slug from the team list, the member best placed to make it, or null when none fits.',
  '- hunch: true when the connection is a guess rather than grounded in both things; false when both things support it.',
  '- If nothing specific stands out, answer {"line": null, "reason": "<one plain sentence>"} instead.',
  '',
  'Answer with exactly one JSON object and nothing else:',
  '{"line": "...", "why": "...", "experiment": {"label": "...", "scope": "..."}, "by": "slug-or-null", "hunch": false}',
].join('\n');

function usage() {
  return [
    'usage:',
    '  atris link "<thing a>" "<thing b>" [--context "<text>"] [--team] [--json]',
    '',
    'asks the roster\'s engine what these two things could become together.',
    '',
    'options:',
    '  --context <text>  extra facts the answer may use',
    `  --team            read each member's now.md (fresh within ${TEAM_FRESH_DAYS} days, not parked) to pick who makes it`,
    '  --json            print the answer as json',
  ].join('\n');
}

function parseLinkArgs(args = []) {
  const things = [];
  let context = '';
  let team = false;
  let json = false;
  let help = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = String(args[index]);
    if (arg === '--help' || arg === '-h') { help = true; continue; }
    if (arg === '--json') { json = true; continue; }
    if (arg === '--team') { team = true; continue; }
    if (arg === '--context') {
      if (index + 1 >= args.length) throw new Error('--context needs text');
      context = String(args[index + 1]);
      index += 1;
      continue;
    }
    if (arg.startsWith('--context=')) { context = arg.slice('--context='.length); continue; }
    if (arg.startsWith('--')) throw new Error(`unknown option ${arg}`);
    things.push(arg.trim());
  }
  if (help) return { help: true, json };
  if (things.length !== 2 || !things[0] || !things[1]) throw new Error(usage());
  return { help: false, things, context: context.trim(), team, json };
}

// The roster's worker for this question: a `link` job when the owner made
// one, else whoever leads `build`.
function pickLinkWorker(report) {
  const jobs = Array.isArray(report && report.jobs) ? report.jobs : [];
  const row = jobs.find((entry) => entry && entry.job === 'link' && entry.engine)
    || jobs.find((entry) => entry && entry.job === 'build' && entry.engine);
  if (!row) return null;
  return {
    job: row.job,
    engine: String(row.engine),
    model: row.model ? String(row.model) : '',
    effort: row.effort ? String(row.effort) : '',
  };
}

function rosterMemberNames(report, root) {
  const rows = Array.isArray(report && report.team) ? report.team : [];
  const names = [];
  for (const row of rows) {
    const name = String((row && row.member) || '').trim();
    if (!name || !MEMBER_NAME_RE.test(name) || names.includes(name)) continue;
    if (isMemberParked(root, name)) continue;
    names.push(name);
  }
  return names;
}

function oneLine(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

// A member's now.md, trimmed to the first lines that say something: no
// heading marks, no "Updated:" stamp. Skipped when older than five days.
function teamNote(root, name, now = Date.now()) {
  const file = path.join(root, 'atris', 'team', name, 'now.md');
  let stat;
  let text;
  try {
    stat = fs.statSync(file);
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  if (now - stat.mtimeMs > TEAM_FRESH_DAYS * 86400000) return null;
  const lines = text.split(/\r?\n/)
    .map((line) => line.replace(/^#+\s*/, '').trim())
    .filter((line) => line && line.toLowerCase() !== 'now' && !/^updated:/i.test(line));
  const note = oneLine(lines.join(' '));
  if (!note) return null;
  return note.length > TEAM_NOTE_CHARS ? `${note.slice(0, TEAM_NOTE_CHARS - 3)}...` : note;
}

function buildLinkPrompt({ things, context, members, notes }) {
  const parts = [
    SYSTEM_PROMPT,
    '',
    `Thing A: ${oneLine(things[0])}`,
    `Thing B: ${oneLine(things[1])}`,
  ];
  if (context) parts.push(`Context: ${oneLine(context)}`);
  parts.push('');
  if (notes && notes.length) {
    parts.push('Team (slug: what they are on now):');
    for (const entry of notes) parts.push(`- ${entry.name}: ${entry.note}`);
  } else {
    parts.push(`Team slugs: ${members.length ? members.join(', ') : '(none)'}`);
  }
  return parts.join('\n');
}

// Notes go in until the prompt would pass the ask limit; whoever does not
// fit is still a valid slug, named on the last line.
function fitTeamNotes(base, notes, members, maxBytes = MAX_ASK_PROMPT_BYTES - 1024) {
  const kept = [];
  for (const entry of notes) {
    const next = buildLinkPrompt({ ...base, members, notes: [...kept, entry] });
    if (Buffer.byteLength(next) > maxBytes) break;
    kept.push(entry);
  }
  const rest = members.filter((name) => !kept.some((entry) => entry.name === name));
  let prompt = buildLinkPrompt({ ...base, members, notes: kept });
  if (kept.length && rest.length) prompt += `\nOther team slugs: ${rest.join(', ')}`;
  return prompt;
}

// The same read-only invocation `engine ask` builds, run from the temp
// folder so the workspace's own notes and memory do not leak into an answer
// that may use only its inputs. Claude-family engines also lose their read
// tools for the same reason.
function linkInvocation(job, timeoutMs) {
  const invocation = buildReadOnlyEngineInvocation(job.engine, job.prompt, job.model, { timeoutMs, effort: job.effort || '' });
  const args = [...invocation.args];
  const tools = args.indexOf('--tools');
  if (tools >= 0 && tools + 1 < args.length) args[tools + 1] = '';
  return { ...invocation, args, cwd: os.tmpdir() };
}

function executeLinkJob(job, { timeoutMs, signal } = {}) {
  const invocation = linkInvocation(job, timeoutMs);
  return runAskProcess(invocation, { cwd: invocation.cwd, timeoutMs, signal });
}

// The engine's text to one object: fences stripped, first "{" to last "}".
function extractJsonObject(text) {
  const raw = String(text || '').replace(/```(?:json)?/gi, '').trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// Em and en dashes become commas, so a rule the model missed never reaches
// the board.
function plain(text) {
  return oneLine(String(text == null ? '' : text)
    .replace(/\s*[\u2014\u2013]\s*/g, ', ')
    .replace(/,\s*,/g, ','));
}

function wordCount(text) {
  return plain(text).split(' ').filter(Boolean).length;
}

// Shape the answer into the contract. Returns { ok, value } or
// { ok: false, error }.
function normalizeLinkAnswer(parsed, members) {
  if (!parsed) return { ok: false, error: 'the engine did not answer with a json object' };
  if (parsed.line === null || parsed.line === undefined || !plain(parsed.line)) {
    const reason = plain(parsed.reason) || 'nothing specific stood out between these two';
    return { ok: true, value: { line: null, reason } };
  }
  const line = plain(parsed.line);
  if (wordCount(line) > MAX_LINE_WORDS) {
    return { ok: false, error: `the line has ${wordCount(line)} words, more than ${MAX_LINE_WORDS}` };
  }
  const experiment = parsed.experiment && typeof parsed.experiment === 'object' ? parsed.experiment : {};
  const label = plain(experiment.label);
  const scope = plain(experiment.scope);
  const why = plain(parsed.why);
  if (!why || !label || !scope) return { ok: false, error: 'the answer is missing why, experiment.label, or experiment.scope' };
  const by = String(parsed.by == null ? '' : parsed.by).trim();
  return {
    ok: true,
    value: {
      line,
      why,
      experiment: { label, scope },
      by: by && members.includes(by) ? by : null,
      hunch: parsed.hunch === true || String(parsed.hunch).toLowerCase() === 'true',
    },
  };
}

function compactFailure(answer) {
  if (!answer) return 'no answer';
  if (answer.reason === 'timeout') return `timed out after ${Math.round((answer.duration_ms || 0) / 1000)}s`;
  const detail = String(answer.stderr || '').trim().split(/\r?\n/).find(Boolean);
  return detail || String(answer.reason || 'failed').replace(/_/g, ' ');
}

// One run-record line, job "ask", task "link", so `atris engine roster
// --runs` shows how long links take. Best effort.
function recordLinkRun(root, worker, answer, startedAt) {
  try {
    const { appendRosterRun, parseRunUsage } = require('../lib/roster-runs');
    let outcome = 'landed';
    if (answer && (answer.timed_out || answer.reason === 'timeout')) outcome = 'stalled';
    else if (!answer || !answer.ok) outcome = 'failed';
    appendRosterRun(root, {
      at: startedAt,
      job: 'ask',
      engine: worker.engine,
      model: worker.model,
      ...(worker.effort ? { effort: worker.effort } : {}),
      max_seconds: Math.round(LINK_TIMEOUT_MS / 1000),
      seconds: Math.max(0, (Number(answer && answer.duration_ms) || 0) / 1000),
      outcome,
      ...(outcome === 'landed' ? {} : { detail: compactFailure(answer) }),
      task: 'link',
      source: 'link',
      ...parseRunUsage({ stdout: answer && answer.stdout, stderr: answer && answer.stderr }),
    });
  } catch { /* best effort */ }
}

function printHuman(value, ran) {
  if (value.line === null) {
    console.log(`\nnothing specific: ${value.reason}\n`);
    return;
  }
  console.log(`\n${value.line}${value.hunch ? '  (hunch)' : ''}`);
  console.log(`\n  ${value.why}`);
  console.log(`\n  make: ${value.experiment.label}`);
  console.log(`        ${value.experiment.scope}`);
  console.log(`  by:   ${value.by || 'nobody on the team fits yet'}`);
  console.log(`\n  ${ran.engine}${ran.model ? ` (${ran.model})` : ''}, ${ran.seconds}s\n`);
}

async function linkCommand(args = [], deps = {}) {
  const root = deps.root || process.cwd();
  let parsed;
  try {
    parsed = parseLinkArgs(args);
  } catch (error) {
    console.error(`link: ${error.message}`);
    return 2;
  }
  if (parsed.help) {
    console.log(usage());
    return 0;
  }

  const fail = (error, extra = {}) => {
    if (parsed.json) console.log(JSON.stringify({ ok: false, error, ...extra }, null, 2));
    else console.error(`link: ${error}`);
    return 1;
  };

  let report;
  try {
    report = deps.rosterReport ? deps.rosterReport(root) : require('./engine').rosterReport(root);
  } catch (error) {
    return fail(`could not read the roster: ${error.message || error}`);
  }
  const worker = pickLinkWorker(report);
  if (!worker) return fail('the roster has no build engine; run: atris engine roster');

  const members = rosterMemberNames(report, root);
  const now = deps.now ? deps.now() : Date.now();
  const notes = parsed.team
    ? members.map((name) => ({ name, note: teamNote(root, name, now) })).filter((entry) => entry.note)
    : [];
  const base = { things: parsed.things, context: parsed.context };
  const prompt = notes.length
    ? fitTeamNotes(base, notes, members)
    : buildLinkPrompt({ ...base, members, notes: [] });

  const startedAt = new Date().toISOString();
  const job = { engine: worker.engine, model: worker.model, ...(worker.effort ? { effort: worker.effort } : {}), prompt, label: 'link' };
  const [answer] = await runEngineAskJobs([job], {
    root,
    concurrency: 1,
    timeoutMs: deps.timeoutMs || LINK_TIMEOUT_MS,
    executeAskJob: deps.executeAskJob || executeLinkJob,
  });
  if (!deps.executeAskJob) recordLinkRun(root, worker, answer, startedAt);

  const ran = {
    job: worker.job,
    engine: worker.engine,
    model: worker.model || null,
    seconds: Math.round((Number(answer && answer.duration_ms) || 0) / 100) / 10,
    team_notes: parsed.team ? notes.length : null,
  };
  if (!answer || !answer.ok) return fail(`the engine did not answer: ${compactFailure(answer)}`, { ran });

  const result = normalizeLinkAnswer(extractJsonObject(answer.stdout), members);
  if (!result.ok) return fail(result.error, { ran, raw: String(answer.stdout || '').trim().slice(0, 2000) });

  if (parsed.json) console.log(JSON.stringify({ ...result.value, ran }, null, 2));
  else printHuman(result.value, ran);
  return 0;
}

module.exports = {
  SYSTEM_PROMPT,
  linkCommand,
  parseLinkArgs,
  pickLinkWorker,
  teamNote,
  fitTeamNotes,
  extractJsonObject,
  normalizeLinkAnswer,
  linkInvocation,
};
