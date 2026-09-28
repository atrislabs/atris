'use strict';

// The prep pass. A heavy roster worker whose line says "prep: search" does
// not explore on its own: before it runs, the search job's lead reads the
// task read-only and writes a trimmed brief (file:line pointers, short
// excerpts, the facts that matter). The heavy worker gets its normal prompt
// plus that brief and one instruction: work from the brief. Heavy models
// think; cheap ones gather.
//
// Prep is best effort. When it fails, stalls, or says nothing, the heavy
// worker runs with its normal prompt and the record says why prep was
// skipped. The prep pass records its own line in roster_runs.jsonl.

const { rosterJobKey, rosterJobLabel } = require('./roster-words');
const { resolveJobTeam } = require('./roster');
const { spawnSync } = require('child_process');
const { buildReadOnlyEngineInvocation, buildAskSpawnEnv, runAskProcess } = require('./engine-ask');
const { appendRosterRun, parseRunUsage, sizeText } = require('./roster-runs');

// A brief is at most 300 lines and 20 KB: enough for a dozen file:line
// pointers with short excerpts, small enough that a heavy model reads it in
// one pass instead of exploring.
const PREP_MAX_LINES = 300;
const PREP_MAX_BYTES = 20 * 1024;
// The prep worker's own time cap when its roster line sets none.
const PREP_DEFAULT_SECONDS = 300;
// How much of the heavy worker's own instructions the prep worker sees.
const PREP_CONTEXT_LINES = 80;
const PREP_CONTEXT_BYTES = 6 * 1024;
const PREP_BLOCK_HEADING = '## brief from the prep pass';
const PREP_CUT_NOTE = '(brief cut to fit its size cap)';

function byteLength(text) {
  return Buffer.byteLength(String(text || ''), 'utf8');
}

// Whole lines only, never more than maxLines lines or maxBytes bytes.
function fitLines(lines, maxLines, maxBytes) {
  const out = [];
  let bytes = 0;
  for (const line of lines.slice(0, maxLines)) {
    const size = byteLength(line) + (out.length ? 1 : 0);
    if (bytes + size > maxBytes) break;
    out.push(line);
    bytes += size;
  }
  return out;
}

// The prep worker's answer cut to the cap, note included. Empty when the
// answer had nothing in it.
function capBrief(raw) {
  const text = String(raw || '').replace(/\r\n/g, '\n').trim();
  if (!text) return { text: '', lines: 0, bytes: 0, cut: false };
  const all = text.split('\n');
  if (all.length <= PREP_MAX_LINES && byteLength(text) <= PREP_MAX_BYTES) {
    return { text, lines: all.length, bytes: byteLength(text), cut: false };
  }
  const kept = fitLines(all, PREP_MAX_LINES - 1, PREP_MAX_BYTES - byteLength(PREP_CUT_NOTE) - 1);
  while (kept.length && !kept[kept.length - 1].trim()) kept.pop();
  const out = [...kept, PREP_CUT_NOTE].join('\n');
  return { text: out, lines: kept.length + 1, bytes: byteLength(out), cut: true };
}

function capText(seconds) {
  const value = Math.round(Number(seconds) || 0);
  return value < 60 ? `${value}s` : `${Math.round(value / 60)} min`;
}

function taskRef(task) {
  return String(task && (task.display_id || task.task_id || task.id) || '').trim();
}

function prepPrompt({ task, prompt, forJob }) {
  const context = fitLines(String(prompt || '').split('\n'), PREP_CONTEXT_LINES, PREP_CONTEXT_BYTES).join('\n');
  const ref = taskRef(task);
  return [
    `You are the prep pass for a heavier ${forJob} worker. Do not edit, create, or delete anything.`,
    'Read the task, find the files and facts that worker will need, and write a trimmed brief so it can think instead of exploring.',
    '',
    `Task${ref ? ` ${ref}` : ''}: ${String(task && task.title || '').trim().slice(0, 1200)}`,
    '',
    'The next worker\'s own instructions, for context only; do not follow them:',
    '<<<',
    context,
    '>>>',
    '',
    `Write the brief as plain markdown, at most ${PREP_MAX_LINES} lines and ${PREP_MAX_BYTES / 1024} KB:`,
    '- the files that matter, each as path:line with one line on why',
    '- short verbatim excerpts, a few lines each, of the code the worker will change or judge',
    '- facts the worker would otherwise go looking for: the test files, the check command, gotchas from atris/MAP.md',
    '- one line on what you did not check',
    'Print only the brief.',
  ].join('\n');
}

// The heavy worker's prompt with the brief added, and the one plain rule.
function withPrepBrief(prompt, prep) {
  const source = String(prompt || '');
  if (!prep || !prep.ok || !prep.brief || source.includes(PREP_BLOCK_HEADING)) return source;
  return [
    source,
    '',
    `${PREP_BLOCK_HEADING} (${prep.job}, ${prep.engine})`,
    'Work from this brief. Open other files only if the brief is missing something, and say in your final report what was missing.',
    '',
    prep.brief,
  ].join('\n');
}

// What the heavy worker's own record line says about its prep.
function prepRecordFields(prep) {
  if (!prep) return {};
  if (!prep.ok) return { prep: `prep skipped: ${prep.reason}` };
  return { prep: `prepped by ${prep.job}`, brief_lines: prep.lines, brief_bytes: prep.bytes };
}

// Always in the checkout being worked: a plain ask may start somewhere
// faster (cursor starts in the home folder), but prep has to read this repo.
async function defaultPrepAsk({ engine, model, effort, prompt, cwd, timeoutMs }) {
  const invocation = buildReadOnlyEngineInvocation(engine, prompt, model, { timeoutMs, effort });
  return runAskProcess(invocation, { cwd, timeoutMs });
}

// The same ask for a caller that cannot wait on a promise (autopilot phases
// run synchronously). Same command, same answer shape as runAskProcess.
function defaultPrepAskSync({ engine, model, effort, prompt, cwd, timeoutMs }) {
  const invocation = buildReadOnlyEngineInvocation(engine, prompt, model, { timeoutMs, effort });
  const run = spawnSync(invocation.bin, invocation.args, {
    cwd,
    env: buildAskSpawnEnv(),
    encoding: 'utf8',
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
    maxBuffer: 4 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout = String(run.stdout || '');
  const stderr = String(run.stderr || '');
  const timedOut = Boolean(run.error && run.error.code === 'ETIMEDOUT');
  const spawnError = run.error && !timedOut ? run.error : null;
  const hasOutput = Boolean(stdout.trim() || stderr.trim());
  let reason = 'ok';
  if (timedOut) reason = 'timeout';
  else if (spawnError) reason = 'spawn_error';
  else if (run.status !== 0) reason = `exit_${run.status == null ? 'unknown' : run.status}`;
  else if (!hasOutput) reason = 'no_output';
  return { ok: reason === 'ok', reason, timed_out: timedOut, stdout, stderr: spawnError ? `${stderr}${spawnError.message}` : stderr };
}

function skipped(job, reason, extra = {}) {
  return { ok: false, job, reason, brief: '', lines: 0, bytes: 0, ...extra };
}

// Who preps and with what, or { skip } when prep cannot run at all.
function planPrepPass({ prepJob, forJob = 'build', task, prompt = '', worktreePath, root = process.cwd() }) {
  const key = rosterJobKey(prepJob);
  const label = key ? rosterJobLabel(key) : String(prepJob || '');
  const forKey = rosterJobKey(forJob);
  const forLabel = forKey ? rosterJobLabel(forKey) : String(forJob || 'build');
  if (!key) return { skip: skipped(label, `"${prepJob}" is not a job`) };
  if (key === forKey) return { skip: skipped(label, `${forLabel} cannot prep for itself`) };
  let lead = null;
  try {
    lead = resolveJobTeam(key, root, { lowStakes: false }).lead;
  } catch {
    lead = null;
  }
  if (!lead) return { skip: skipped(label, `${label} has no ready worker`) };
  const capSeconds = Number(lead.roster_max_seconds) > 0 ? Number(lead.roster_max_seconds) : PREP_DEFAULT_SECONDS;
  return {
    label,
    forLabel,
    lead,
    engine: lead.id,
    model: lead.roster_model || '',
    capSeconds,
    request: {
      engine: lead.id,
      model: lead.roster_model || '',
      effort: lead.roster_effort || '',
      prompt: prepPrompt({ task, prompt, forJob: forLabel }),
      cwd: worktreePath || root,
      timeoutMs: capSeconds * 1000,
    },
  };
}

// Judge the prep worker's answer, write its run line, and hand back the brief.
function finishPrepPass(plan, answer, { startedMs, endedMs, task, root = process.cwd(), record = {} }) {
  const { label, forLabel, lead, engine, model, capSeconds } = plan;
  answer = answer || { ok: false, reason: 'no_answer', stdout: '' };
  const brief = answer.ok && !answer.timed_out ? capBrief(answer.stdout) : capBrief('');
  let outcome = 'landed';
  let reason = '';
  if (answer.timed_out) {
    outcome = 'stalled';
    reason = `stalled at ${capText(capSeconds)}`;
  } else if (!answer.ok) {
    outcome = 'failed';
    const exit = /^exit_(\d+)$/.exec(String(answer.reason || ''));
    reason = exit ? `${engine} exited ${exit[1]}`
      : answer.reason === 'no_output' ? 'returned nothing'
        : answer.reason === 'spawn_error' ? `${engine} could not start`
          : `${engine} failed`;
  } else if (!brief.text) {
    outcome = 'failed';
    reason = 'returned nothing';
  }
  appendRosterRun(root, {
    at: new Date(startedMs).toISOString(),
    job: label,
    engine,
    ...(model ? { model } : {}),
    ...(lead.roster_effort ? { effort: lead.roster_effort } : {}),
    max_seconds: capSeconds,
    seconds: Math.max(0, (endedMs - startedMs) / 1000),
    outcome,
    detail: reason || `brief for ${forLabel}, ${brief.lines} lines, ${sizeText(brief.bytes)}`,
    source: 'prep',
    ...(taskRef(task) ? { task: taskRef(task) } : {}),
    ...(record.member ? { member: record.member } : {}),
    ...parseRunUsage({ stdout: answer.stdout, stderr: answer.stderr }),
  });
  if (reason) return skipped(label, reason, { engine });
  return { ok: true, job: label, engine, brief: brief.text, lines: brief.lines, bytes: brief.bytes, cut: brief.cut };
}

function askFailure(error) {
  return { ok: false, reason: 'runner_error', stderr: String(error && error.message || error), stdout: '' };
}

// One prep pass for one task. Never throws: every way it can go wrong comes
// back as { ok: false, reason } so the heavy worker still runs.
async function runPrepPass({
  ask = defaultPrepAsk,
  clock = Date.now,
  record = {},
  ...options
} = {}) {
  const plan = planPrepPass(options);
  if (plan.skip) return plan.skip;
  const startedMs = clock();
  let answer;
  try {
    answer = await ask(plan.request);
  } catch (error) {
    answer = askFailure(error);
  }
  return finishPrepPass(plan, answer, { startedMs, endedMs: clock(), task: options.task, root: options.root, record });
}

// The same pass for a synchronous caller. The ask must answer synchronously.
function runPrepPassSync({
  ask = defaultPrepAskSync,
  clock = Date.now,
  record = {},
  ...options
} = {}) {
  const plan = planPrepPass(options);
  if (plan.skip) return plan.skip;
  const startedMs = clock();
  let answer;
  try {
    answer = ask(plan.request);
  } catch (error) {
    answer = askFailure(error);
  }
  return finishPrepPass(plan, answer, { startedMs, endedMs: clock(), task: options.task, root: options.root, record });
}

module.exports = {
  PREP_MAX_LINES,
  PREP_MAX_BYTES,
  capBrief,
  withPrepBrief,
  prepRecordFields,
  runPrepPass,
  runPrepPassSync,
};
