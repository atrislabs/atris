/**
 * atris ask: chat with your personal Atris computer.
 *
 * Same brain as texting: your memory, calendar, email, and tools.
 * One-shot:    atris ask what should I do today
 * Interactive: atris ask
 */

const readline = require('readline');
const api = require('../utils/api');
const auth = require('../utils/auth');

const { getApiBaseUrl, apiRequestJson } = api;

const TIMEOUT_MS = 300000;

// A request like "run date on my computer" can come back as a started job
// instead of an answer. These keep the terminal open until the job is done.
const JOB_FIRST_POLL_MS = 1500;
const JOB_MAX_POLL_MS = 3000;
const JOB_WAIT_CAP_MS = 5 * 60 * 1000;
const JOB_POLL_TIMEOUT_MS = 20000;
// Consecutive polls that may fail (network drop, 5xx) before we give up.
const JOB_POLL_FAILURE_LIMIT = 4;
// Consecutive 404s before we say the job is gone. One is tolerated in case
// the first read lands before the saved job is visible.
const JOB_NOT_FOUND_LIMIT = 2;
const CHECK_COMMAND = 'atris chat --personal "how is it going"';
const JOB_INTENTS = new Set(['mission_start', 'mission_answer', 'mission_approve', 'mission_correction']);

function stripEvents(text) {
  // Drop inline [[EVENT]]{...} tool chatter; keep only the spoken reply.
  // Tool names are surfaced dimmed in the terminal (texts never see them).
  if (typeof text !== 'string') return text;
  const parts = [];
  const toolNames = [];
  for (let chunk of text.split('[[EVENT]]')) {
    const trimmed = chunk.trimStart();
    if (trimmed.startsWith('{')) {
      let depth = 0;
      let inString = false;
      let escaped = false;
      let end = -1;
      for (let i = 0; i < trimmed.length; i += 1) {
        const ch = trimmed[i];
        if (escaped) { escaped = false; continue; }
        if (ch === '\\') { escaped = true; continue; }
        if (ch === '"') inString = !inString;
        if (inString) continue;
        if (ch === '{') depth += 1;
        if (ch === '}') { depth -= 1; if (depth === 0) { end = i + 1; break; } }
      }
      if (end > 0) {
        try {
          const evt = JSON.parse(trimmed.slice(0, end));
          if (evt.type === 'tool_call' && evt.tool) toolNames.push(evt.tool);
        } catch (_) { /* not JSON, keep going */ }
        chunk = trimmed.slice(end);
      }
    }
    parts.push(chunk);
  }
  const reply = parts.join('').trim();
  if (toolNames.length && process.stdout.isTTY) {
    process.stdout.write(`\x1b[2m[⚙ ${[...new Set(toolNames)].join(', ')}]\x1b[0m\n`);
  }
  return reply;
}

function startSpinner(label) {
  if (!process.stdout.isTTY) return { stop: () => {}, setLabel: () => {} };
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  const started = Date.now();
  let i = 0;
  let current = label;
  const timer = setInterval(() => {
    const secs = Math.floor((Date.now() - started) / 1000);
    process.stdout.write(`\r\x1b[2K${frames[i % frames.length]} ${current}${secs > 2 ? ` · ${secs}s` : ''}`);
    i += 1;
  }, 90);
  return {
    stop: () => {
      clearInterval(timer);
      process.stdout.write('\r\x1b[2K');
    },
    setLabel: (next) => { if (next) current = String(next); },
  };
}

async function typeOut(text) {
  if (!process.stdout.isTTY || text.length > 4000) {
    process.stdout.write(`${text}\n`);
    return;
  }
  for (const ch of text) {
    process.stdout.write(ch);
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, ch === '\n' ? 12 : 3));
  }
  process.stdout.write('\n');
}

async function sendMessage(token, message) {
  const res = await api.httpRequest(`${getApiBaseUrl()}/message/incoming`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ message, source: 'cli' }),
    timeoutMs: TIMEOUT_MS,
  });
  if (res.status !== 200) {
    let detail = res.body.toString('utf8').slice(0, 200);
    try { detail = JSON.parse(detail).detail || detail; } catch (_) { /* raw */ }
    throw new Error(`HTTP ${res.status}: ${detail}`);
  }
  return JSON.parse(res.body.toString('utf8'));
}

// The job id when this reply started (or restarted) a job the person should
// wait for. Replies that only report on a job (status, stop) carry no wait.
function startedJobId(body) {
  if (!body || typeof body !== 'object' || body.success === false) return null;
  if (!JOB_INTENTS.has(body.intent)) return null;
  const id = body.card && body.card.mission_id;
  return typeof id === 'string' && id ? id : null;
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJob(token, jobId) {
  const url = `${getApiBaseUrl()}/atris2/missions/${encodeURIComponent(jobId)}?details=true`;
  let res;
  try {
    res = await api.httpRequest(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
      timeoutMs: JOB_POLL_TIMEOUT_MS,
    });
  } catch (err) {
    return { transient: true, error: err && err.message ? err.message : String(err) };
  }
  const status = res && res.status;
  if (status === 200) {
    try {
      return { job: JSON.parse(res.body.toString('utf8')) };
    } catch (_) {
      return { transient: true, error: 'unreadable reply' };
    }
  }
  if (status === 404) return { notFound: true };
  if (status === 401 || status === 403) return { signedOut: true };
  return { transient: true, error: `HTTP ${status}` };
}

// What a polled job says right now: done (with its answer), needs the person,
// stopped, failed, waiting for a computer, or still working.
function readJob(job) {
  const result = job && typeof job.result === 'object' && job.result ? job.result : {};
  const proof = job && typeof job.proof === 'object' && job.proof ? job.proof : {};
  const state = String((job && job.state) || '').toLowerCase();
  const status = String((job && job.status) || '').toLowerCase();
  const text = [result.response, result.summary, proof.summary, job && job.summary]
    .map((value) => (typeof value === 'string' ? value.trim() : ''))
    .find(Boolean) || '';
  if (status === 'completed' || state === 'done') return { kind: 'done', text };
  if (status === 'cancelled') return { kind: 'stopped' };
  const detail = [result.message, result.error]
    .map((value) => (typeof value === 'string' ? value.trim() : ''))
    .find(Boolean) || '';
  if (status === 'failed') {
    // A hard-capped job that failed reads "stopped"; any other failure is a failure.
    return state === 'stopped' ? { kind: 'stopped', detail } : { kind: 'failed', detail };
  }
  if (state === 'stopped') return { kind: 'stopped', detail };
  if (state === 'your_turn') {
    const needs = job.needs && typeof job.needs === 'object' ? job.needs : {};
    const question = String(needs.question || job.next || '').trim();
    const options = Array.isArray(needs.options) ? needs.options.map(String).filter(Boolean) : [];
    return { kind: 'needs', question: question || 'The job is waiting on you.', options };
  }
  if (state === 'waiting_for_computer') return { kind: 'no_computer' };
  return { kind: 'working', label: typeof job.working_on === 'string' ? job.working_on : '' };
}

// Poll a started job until it ends, asks a question, or the wait cap passes.
// Never throws: every way this can go wrong comes back as an outcome.
async function waitForJob(token, jobId, { spinner, sleep = defaultSleep, now = Date.now, capMs = JOB_WAIT_CAP_MS } = {}) {
  const startedAt = now();
  let attempt = 0;
  let failures = 0;
  let notFound = 0;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const polled = await fetchJob(token, jobId);
    if (polled.signedOut) return { kind: 'signed_out' };
    if (polled.notFound) {
      notFound += 1;
      failures = 0;
      if (notFound >= JOB_NOT_FOUND_LIMIT) return { kind: 'lost' };
    } else if (polled.transient) {
      failures += 1;
      notFound = 0;
      if (failures >= JOB_POLL_FAILURE_LIMIT) return { kind: 'disconnected' };
    } else {
      failures = 0;
      notFound = 0;
      const read = readJob(polled.job);
      if (read.kind !== 'working') return read;
      if (spinner && read.label) spinner.setLabel(read.label);
    }
    const remaining = capMs - (now() - startedAt);
    if (remaining <= 0) return { kind: 'timeout' };
    attempt += 1;
    const delay = Math.min(JOB_FIRST_POLL_MS + (attempt - 1) * 500, JOB_MAX_POLL_MS, remaining);
    // eslint-disable-next-line no-await-in-loop
    await sleep(delay);
  }
}

// Plain words for each way a wait can end. `failed` ones are errors for a
// script (exit code 1); the rest are answers or a request for the person.
function describeOutcome(outcome, { interactive = false } = {}) {
  switch (outcome.kind) {
    case 'done':
      return { text: stripEvents(outcome.text) || 'The job finished, but it did not leave a written answer.' };
    case 'needs': {
      const lines = [`The job needs your answer: ${outcome.question}`];
      if (outcome.options.length) lines.push(`Choices: ${outcome.options.join(', ')}`);
      lines.push(interactive
        ? 'Type your answer below.'
        : 'Answer with: atris chat --personal "<your answer>"');
      return { text: lines.join('\n') };
    }
    case 'timeout':
      return { text: `Still working after ${Math.round(JOB_WAIT_CAP_MS / 60000)} minutes, and it keeps running. Check on it with: ${CHECK_COMMAND}` };
    case 'no_computer':
      return { text: 'This job is waiting for a computer to run on. It starts once your computer is running.' };
    case 'stopped':
      return { text: `That job was stopped before it finished.${outcome.detail ? ` ${outcome.detail}` : ''}`, failed: true };
    case 'failed':
      return {
        text: `The job did not finish${outcome.detail ? `: ${outcome.detail}` : '.'} Say it a little differently to start a fresh try.`,
        failed: true,
      };
    case 'lost':
      return { text: 'I lost track of that job, so I cannot tell you how it went. Ask again to start a new one.', failed: true };
    case 'signed_out':
      return { text: 'Your sign-in no longer works for this job. Run "atris login", then ask for an update.', failed: true };
    case 'disconnected':
    default:
      return {
        text: `Lost the connection while the job was running. It may still be working. Check with: ${CHECK_COMMAND}`,
        failed: true,
      };
  }
}

// One person's message, start to finish: send it, and when the reply is a
// started job, wait for the job's real answer instead of stopping at "I'm starting now".
async function askOnce(token, message, { spinner, interactive = false, wait = {} } = {}) {
  const body = await sendMessage(token, message);
  const jobId = startedJobId(body);
  if (!jobId) return { text: stripEvents(body.response) || JSON.stringify(body) };
  if (spinner) spinner.setLabel('working on it');
  const outcome = await waitForJob(token, jobId, { spinner, ...wait });
  const described = describeOutcome(outcome, { interactive });
  // The same words always map to the same job, so asking again can return a finished one.
  if (outcome.kind === 'done' && body.intent === 'mission_start'
    && body.card && String(body.card.state || '').toLowerCase() === 'done') {
    described.note = 'This is the answer from the last time you asked this. Reword it to run it again.';
  }
  return described;
}

async function askAtris(args, options = {}) {
  const ensured = await auth.ensureValidCredentials(apiRequestJson);
  if (ensured.error === 'not_logged_in' || !ensured.credentials?.token) {
    console.error('✗ Not logged in. Run "atris login" first.');
    process.exit(1);
  }
  if (ensured.error) {
    console.error(`✗ Authentication failed: ${ensured.detail || ensured.error}. Run "atris login".`);
    process.exit(1);
  }
  const { token } = ensured.credentials;

  const oneShot = (args || []).join(' ').trim();
  if (oneShot === '-h' || oneShot === '--help' || oneShot === 'help') {
    console.log('Usage: atris ask ["message"]');
    console.log('');
    console.log('  Chat with your personal Atris computer: memory, calendar, email, tools.');
    console.log('');
    console.log('  atris ask                      Interactive chat');
    console.log('  atris ask what is on today     One-shot question');
    return;
  }

  if (oneShot) {
    const spinner = startSpinner('thinking');
    let answer;
    try {
      answer = await askOnce(token, oneShot, { spinner, wait: options });
    } catch (err) {
      spinner.stop();
      console.error(`✗ ${err.message}`);
      process.exit(1);
      return;
    }
    spinner.stop();
    if (answer.note) console.error(answer.note);
    if (answer.failed) {
      console.error(`✗ ${answer.text}`);
      process.exit(1);
      return;
    }
    await typeOut(answer.text);
    return;
  }

  console.log('Chatting with your computer. Ctrl-C or "bye" to leave.\n');
  await new Promise((resolve) => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let busy = false;
  let closed = false;
  const prompt = () => { if (!closed) rl.question('you › ', onLine); };
  async function onLine(line) {
    const message = line.trim();
    if (!message) { prompt(); return; }
    if (['bye', 'exit', 'quit'].includes(message.toLowerCase())) { rl.close(); return; }
    busy = true;
    const spinner = startSpinner('thinking');
    try {
      const answer = await askOnce(token, message, { spinner, interactive: true, wait: options });
      spinner.stop();
      if (answer.note) console.error(answer.note);
      if (answer.failed) {
        console.error(`✗ ${answer.text}\n`);
      } else {
        process.stdout.write('\natris › ');
        await typeOut(answer.text);
        process.stdout.write('\n');
      }
    } catch (err) {
      spinner.stop();
      console.error(`✗ ${err.message}\n`);
    }
    busy = false;
    if (closed) { console.log('\nbye.'); resolve(); return; }
    prompt();
  }
  rl.on('close', () => {
    closed = true;
    // Let an in-flight answer finish printing before we leave.
    if (!busy) { console.log('\nbye.'); resolve(); }
  });
  prompt();
  });
}

module.exports = { askAtris, readJob, startedJobId, waitForJob, describeOutcome };
