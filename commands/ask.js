/**
 * atris ask — chat with your personal Atris computer.
 *
 * Same brain as texting: your memory, calendar, email, and tools.
 * One-shot:    atris ask what should I do today
 * Interactive: atris ask
 */

const readline = require('readline');
const { getApiBaseUrl, httpRequest, apiRequestJson } = require('../utils/api');
const auth = require('../utils/auth');

const TIMEOUT_MS = 300000;

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
  if (!process.stdout.isTTY) return { stop: () => {} };
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  const started = Date.now();
  let i = 0;
  const timer = setInterval(() => {
    const secs = Math.floor((Date.now() - started) / 1000);
    process.stdout.write(`\r${frames[i % frames.length]} ${label}${secs > 2 ? ` · ${secs}s` : ''}   `);
    i += 1;
  }, 90);
  return {
    stop: () => {
      clearInterval(timer);
      process.stdout.write('\r\x1b[2K');
    },
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
  const res = await httpRequest(`${getApiBaseUrl()}/message/incoming`, {
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

async function askAtris(args) {
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
    console.log('  Chat with your personal Atris computer — memory, calendar, email, tools.');
    console.log('');
    console.log('  atris ask                      Interactive chat');
    console.log('  atris ask what is on today     One-shot question');
    return;
  }

  if (oneShot) {
    const spinner = startSpinner('thinking');
    try {
      const body = await sendMessage(token, oneShot);
      spinner.stop();
      await typeOut(stripEvents(body.response) || JSON.stringify(body));
    } catch (err) {
      spinner.stop();
      console.error(`✗ ${err.message}`);
      process.exit(1);
    }
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
      const body = await sendMessage(token, message);
      spinner.stop();
      process.stdout.write('\natris › ');
      await typeOut(stripEvents(body.response) || JSON.stringify(body));
      process.stdout.write('\n');
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

module.exports = { askAtris };
