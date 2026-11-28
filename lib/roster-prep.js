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

const {
  rosterJobKey,
  rosterJobLabel,
  resolveJobTeam,
} = require('./engine-registry');
const { engineEffortLevels } = require('./runner-command');
const { spawnSync } = require('child_process');
const { buildReadOnlyEngineInvocation, buildAskSpawnEnv, openAskScratch, runAskProcess } = require('./engine-ask');
const { appendRosterRun, parseRunUsage } = require('./roster-runs');
const { startEngineRun } = require('./engine-resource');
const { compileSpecPacket } = require('./spec-packet');

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

function sizeText(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} bytes`;
  return `${(value / 1024).toFixed(1).replace(/\.0$/, '')} KB`;
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
// Light start on claude (skips boot files, hooks and servers), no web, and
// codex on its fast tier: prep only reads this repo.
async function defaultPrepAsk({ engine, model, effort, prompt, cwd, timeoutMs }) {
  const invocation = buildReadOnlyEngineInvocation(engine, prompt, model, {
    timeoutMs,
    effort,
    noWeb: true,
    ...(engine === 'claude' || engine === 'haiku' || engine === 'fable' ? { context: 'light' } : {}),
    ...(engine === 'codex' ? { service_tier: 'fast' } : {}),
  });
  return runAskProcess(invocation, { cwd, timeoutMs });
}

// The same ask for a caller that cannot wait on a promise (autopilot phases
// run synchronously). Same command, same answer shape as runAskProcess.
// No light start here: spawnSync does not unwrap the json result.
function defaultPrepAskSync({ engine, model, effort, prompt, cwd, timeoutMs }) {
  const invocation = buildReadOnlyEngineInvocation(engine, prompt, model, {
    timeoutMs,
    effort,
    noWeb: true,
    ...(engine === 'codex' ? { service_tier: 'fast' } : {}),
  });
  // An edit-mode ask (agy) never starts in the checkout, same as runAskProcess.
  const scratch = openAskScratch(invocation);
  let run;
  try {
    run = spawnSync(invocation.bin, invocation.args, {
      cwd: scratch ? scratch.cwd : cwd,
      env: buildAskSpawnEnv(),
      encoding: 'utf8',
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
      maxBuffer: 4 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } finally {
    if (scratch) scratch.close();
  }
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
  return { ok: reason === 'ok', reason, timed_out: timedOut, signal: run.signal || null, stdout, stderr: spawnError ? `${stderr}${spawnError.message}` : stderr };
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
  const effort = lead.roster_effort || (engineEffortLevels(lead.id).includes('low') ? 'low' : '');
  return {
    label,
    forLabel,
    lead,
    engine: lead.id,
    model: lead.roster_model || '',
    effort,
    capSeconds,
    request: {
      engine: lead.id,
      model: lead.roster_model || '',
      effort,
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
          : answer.signal ? `${engine} stopped by ${answer.signal}`
            : `${engine} failed`;
    if (answer.cause) reason = `${reason}; ${answer.cause}`;
  } else if (!brief.text) {
    outcome = 'failed';
    reason = 'returned nothing';
  }
  appendRosterRun(root, {
    at: new Date(startedMs).toISOString(),
    job: label,
    engine,
    ...(model ? { model } : {}),
    ...(plan.effort ? { effort: plan.effort } : {}),
    max_seconds: capSeconds,
    seconds: Math.max(0, (endedMs - startedMs) / 1000),
    outcome,
    detail: reason || `brief for ${forLabel}, ${brief.lines} lines, ${sizeText(brief.bytes)}`,
    source: 'prep',
    ...(taskRef(task) ? { task: taskRef(task) } : {}),
    ...(record.member ? { member: record.member } : {}),
    ...parseRunUsage({ usage: answer.usage || null, cost_usd: answer.cost_usd ?? null, stdout: answer.stdout, stderr: answer.stderr }),
  });
  if (reason) return skipped(label, reason, { engine });
  return { ok: true, job: label, engine, brief: brief.text, lines: brief.lines, bytes: brief.bytes, cut: brief.cut };
}

function askFailure(error) {
  return { ok: false, reason: 'runner_error', stderr: String(error && error.message || error), stdout: '' };
}

// Machine memory and load at both ends of the prep launch. The ask answers
// instead of throwing, so a failure is passed in the thrown shape, and a
// SIGKILL hands its cause back on the answer.
function startPrepReadings(plan, root) {
  const endResource = startEngineRun(root || process.cwd(), { engine: plan.engine, task: `prep for ${plan.forLabel}` });
  return (answer) => {
    const end = endResource(answer.ok ? null : {
      code: answer.timed_out ? 'ETIMEDOUT' : '',
      signal: answer.signal,
      stderr: answer.stderr,
      message: answer.reason,
    });
    return end && end.cause && !answer.timed_out ? { ...answer, cause: end.cause } : answer;
  };
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
  const endReadings = startPrepReadings(plan, options.root);
  let answer;
  try {
    answer = await ask(plan.request);
  } catch (error) {
    answer = askFailure(error);
  }
  answer = endReadings(answer || { ok: false, reason: 'no_answer', stdout: '' });
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
  const endReadings = startPrepReadings(plan, options.root);
  let answer;
  try {
    answer = ask(plan.request);
  } catch (error) {
    answer = askFailure(error);
  }
  answer = endReadings(answer || { ok: false, reason: 'no_answer', stdout: '' });
  return finishPrepPass(plan, answer, { startedMs, endedMs: clock(), task: options.task, root: options.root, record });
}

// The spec prep pass. A fast search lead turns one plain goal into a
// checked spec packet: exact files, exact edits, a bare verify command and
// short excerpts. Any miss falls back, so the heavy worker still runs.
function specPrepPrompt({ goal = '', task = null, forJob = 'build', hints = [] } = {}) {
  const cleanGoal = String(goal || (task && task.title) || '').trim().slice(0, 1200);
  const hintLines = (Array.isArray(hints) ? hints : []).map((item) => String(item || '').trim()).filter(Boolean);
  return [
    `You are the spec prep pass for a heavier ${forJob} worker. Do not edit, create, or delete any file.`,
    'Read atris/MAP.md and the exact target files, then write the spec that worker will build from.',
    '',
    `Goal: ${cleanGoal}`,
    ...(hintLines.length ? ['', 'Hints:', ...hintLines.map((item) => `- ${item}`)] : []),
    '',
    'Return ONLY one valid JSON object, with no markdown prose outside it, in this shape:',
    '{"files": ["relative/path.js"], "contract": ["exact edit with path:line and symbol"], "verify": "bare node --test command, never piped", "antiGoals": ["files not to touch"], "excerpts": ["path:line short verbatim snippet"]}',
    '',
    'Rules:',
    '- files are repo-relative paths; never list anything under .atris/ or atris/TODO.md',
    '- verify runs bare: never pipe it through tail, grep, or anything else',
    '- excerpts are a few lines each, copied verbatim with their path:line',
  ].join('\n');
}

function stringList(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string').map((item) => item.trim()).filter(Boolean) : [];
}

function parseSpecPrepJson(raw) {
  let text = String(raw || '').trim();
  const fence = /^```[a-zA-Z]*\s*\n?([\s\S]*?)\n?```$/.exec(text);
  if (fence) text = fence[1].trim();
  let value = null;
  try {
    value = JSON.parse(text);
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try {
      value = JSON.parse(text.slice(start, end + 1));
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const files = stringList(value.files);
  const verify = typeof value.verify === 'string' ? value.verify.trim() : '';
  if (!files.length || !verify) return null;
  return { files, contract: stringList(value.contract), verify, antiGoals: stringList(value.antiGoals), excerpts: stringList(value.excerpts) };
}

async function runSpecPrepPass({
  goal = '',
  task = null,
  prepJob = 'search',
  forJob = 'build',
  engine = '',
  effort = null,
  hints = [],
  worktreePath,
  root = process.cwd(),
  ask = defaultPrepAsk,
  clock = Date.now,
  record = {},
} = {}) {
  const cleanGoal = String(goal || (task && task.title) || '').trim();
  if (!cleanGoal) {
    return { ok: false, mode: 'fallback', reason: 'goal is required', errors: ['goal is required'], packet: null, prompt: '', brief: '', lines: 0, bytes: 0 };
  }
  const forTask = task || { title: cleanGoal };
  const plan = planPrepPass({ prepJob, forJob, task: forTask, prompt: cleanGoal, worktreePath, root });
  if (plan.skip) return { ...plan.skip, mode: 'fallback', errors: [plan.skip.reason], packet: null, prompt: '' };
  plan.request.prompt = specPrepPrompt({ goal: cleanGoal, task, forJob: plan.forLabel, hints });
  const startedMs = clock();
  const endReadings = startPrepReadings(plan, root);
  let answer;
  try {
    answer = await ask(plan.request);
  } catch (error) {
    answer = askFailure(error);
  }
  answer = endReadings(answer || { ok: false, reason: 'no_answer', stdout: '' });
  const endedMs = clock();
  const duration_ms = Math.max(0, endedMs - startedMs);
  const finished = finishPrepPass(plan, answer, { startedMs, endedMs, task: forTask, root, record });
  if (!finished.ok) return { ...finished, mode: 'fallback', duration_ms, errors: [finished.reason], packet: null, prompt: '' };
  const base = { job: plan.label, engine: plan.engine, model: plan.model, effort: plan.effort, duration_ms };
  const fallback = (reason, errors) => ({ ok: false, mode: 'fallback', ...base, reason, errors, packet: null, prompt: '', brief: finished.brief, lines: finished.lines, bytes: finished.bytes });
  const parsed = parseSpecPrepJson(answer.stdout);
  if (!parsed) return fallback('prep output was not valid spec json', ['prep output was not valid spec json']);
  const compiled = compileSpecPacket({ goal: cleanGoal, files: parsed.files, contract: parsed.contract, verify: parsed.verify, antiGoals: parsed.antiGoals, engine, job: plan.forLabel, effort });
  if (!compiled.ok) return fallback(compiled.errors.join('; '), compiled.errors);
  const finalPrompt = parsed.excerpts.length
    ? `${compiled.prompt}\n\n## Excerpts\n\n${parsed.excerpts.map((item) => `- ${item}`).join('\n')}`
    : compiled.prompt;
  const capped = capBrief(finalPrompt);
  return { ok: true, mode: 'spec_packet', ...base, packet: compiled.packet, excerpts: parsed.excerpts, prompt: capped.text, brief: capped.text, lines: capped.lines, bytes: capped.bytes, cut: capped.cut };
}

module.exports = {
  PREP_MAX_LINES,
  PREP_MAX_BYTES,
  capBrief,
  withPrepBrief,
  prepRecordFields,
  runPrepPass,
  runPrepPassSync,
  defaultPrepAsk,
  specPrepPrompt,
  parseSpecPrepJson,
  runSpecPrepPass,
};
