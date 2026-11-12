'use strict';

// The orb, in the terminal: the same chat as atris.ai/orb, with its numbered choices.
//   atris orb chat          talk, type a number to pick a choice or write your own
//   atris orb say "text"    one message, prints the reply and numbered choices
//   atris orb pick 2        picks choice 2 from the last reply
//   atris orb new           starts fresh with the orb's own opener
// The thread lives in ~/.atris/orb-chat.json so say and pick continue the same chat.

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { stateHome } = require('../lib/state-home');
const { getApiBaseUrl } = require('../utils/api');

const MAX_MESSAGES = 16;
const MAX_CHOICE_SETS = 6;
const OPENER_MESSAGE = 'Open my day.';

const TOOL_WORDS = {
  computer_list: 'looking at your computers',
  computer_team: 'looking at your helpers',
  computer_execute: 'sending the work to your computer',
  computer_delegate: 'handing the work to a helper',
  computer_inflight: 'checking what your computers are doing',
  computer_execution_result: 'reading what a job found',
  web_search: 'searching the web',
  memory_search: 'searching your notes',
  memory_read: 'reading your notes',
  memory_ask: 'reading your notes',
  memory_write: 'writing a page',
  remember: 'saving that',
};

function stateFile() {
  return path.join(stateHome(), '.atris', 'orb-chat.json');
}

function readState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
    if (parsed && Array.isArray(parsed.messages)) return parsed;
  } catch {}
  return { messages: [], choiceHistory: [], options: [] };
}

function writeState(state) {
  const file = stateFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const trimmed = {
    messages: state.messages.slice(-MAX_MESSAGES),
    choiceHistory: state.choiceHistory.slice(-MAX_CHOICE_SETS),
    options: state.options || [],
  };
  fs.writeFileSync(file, JSON.stringify(trimmed, null, 2), { mode: 0o600 });
}

function token(env = process.env) {
  if (env.ATRIS_TOKEN) return env.ATRIS_TOKEN;
  try {
    const creds = require('../utils/auth').loadCredentials();
    return creds && creds.token ? String(creds.token) : '';
  } catch {
    return '';
  }
}

function turnBody(state, message, { opener = false } = {}) {
  const body = {
    message,
    surface: 'dashboard_orb',
    model: 'atris:fast',
    memory_enabled: true,
    max_turns: 4,
    previous_messages: opener ? [] : state.messages.slice(-MAX_MESSAGES),
    choice_history: state.choiceHistory.slice(-MAX_CHOICE_SETS),
  };
  if (opener) {
    Object.assign(body, {
      orb_opener: true,
      turn_kind: 'orb_open',
      disable_connector_tools: true,
      max_turns: 1,
    });
  }
  return body;
}

function parseSseLines(buffer, onEvent) {
  const lines = buffer.split('\n');
  const rest = lines.pop();
  for (const raw of lines) {
    const line = raw.trim();
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') continue;
    try { onEvent(JSON.parse(data)); } catch {}
  }
  return rest;
}

async function sendTurn(state, message, { opener = false, out = process.stdout, fetchImpl = globalThis.fetch } = {}) {
  const auth = token();
  if (!auth) throw new Error('Not signed in. Run: atris login');
  const response = await fetchImpl(`${getApiBaseUrl()}/atris2/turn`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${auth}`,
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    body: JSON.stringify(turnBody(state, message, { opener })),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`The orb did not answer (${response.status}). ${detail.slice(0, 200)}`.trim());
  }

  let text = '';
  let options = [];
  let lastToolWords = '';
  const onEvent = (event) => {
    if (event.type === 'text_delta' && event.content) {
      text += event.content;
      out.write(event.content);
    } else if (event.type === 'options' && Array.isArray(event.options)) {
      options = event.options
        .filter((option) => option && option.label)
        .map((option) => ({ label: String(option.label), message: String(option.message || option.label) }));
    } else if (event.type === 'tool_call') {
      const words = TOOL_WORDS[event.tool];
      if (words && words !== lastToolWords) {
        lastToolWords = words;
        out.write(`${text && !text.endsWith('\n') ? '\n' : ''}\x1b[2m· ${words}\x1b[0m\n`);
      }
    } else if (event.type === 'error' && event.error) {
      out.write(`\n\x1b[2m(${String(event.error).slice(0, 160)})\x1b[0m\n`);
    }
  };

  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    buffer = parseSseLines(buffer, onEvent);
  }
  parseSseLines(`${buffer}\n`, onEvent);
  if (!text.endsWith('\n')) out.write('\n');

  if (!opener) state.messages.push({ role: 'user', content: message });
  if (text.trim()) state.messages.push({ role: 'assistant', content: text.trim() });
  state.options = options;
  if (options.length) state.choiceHistory.push({ shown: options.map((option) => option.label), picked: null });
  writeState(state);
  return { text, options };
}

function renderOptions(options, out = process.stdout) {
  if (!options.length) return;
  out.write('\n');
  options.forEach((option, index) => {
    out.write(`  \x1b[1m${index + 1}\x1b[0m  ${option.label}\n`);
  });
}

// A number picks a choice from the last reply; anything else is their own words.
function resolveInput(state, input) {
  const trimmed = String(input || '').trim();
  const number = /^\d+$/.test(trimmed) ? Number(trimmed) : NaN;
  const options = state.options || [];
  if (Number.isInteger(number) && number >= 1 && number <= options.length) {
    const option = options[number - 1];
    const lastSet = state.choiceHistory[state.choiceHistory.length - 1];
    if (lastSet) lastSet.picked = option.label;
    return { message: option.message, echo: option.label };
  }
  return { message: trimmed, echo: '' };
}

async function say(state, input, io) {
  const { message, echo } = resolveInput(state, input);
  if (!message) return;
  if (echo) io.out.write(`\x1b[2m> ${echo}\x1b[0m\n`);
  io.out.write('\n');
  const { options } = await sendTurn(state, message, io);
  renderOptions(options, io.out);
}

async function openFresh(io) {
  const state = { messages: [], choiceHistory: readState().choiceHistory, options: [] };
  const { options } = await sendTurn(state, OPENER_MESSAGE, { ...io, opener: true });
  renderOptions(options, io.out);
  return state;
}

async function interactive(io) {
  let state = await openFresh(io);
  const rl = readline.createInterface({ input: process.stdin, output: io.out });
  const ask = () => new Promise((resolve) => rl.question('\n\x1b[2mpick a number or say anything (q to leave)\x1b[0m\n> ', resolve));
  try {
    for (;;) {
      const input = (await ask()).trim();
      if (!input) continue;
      if (/^(q|quit|exit|bye)$/i.test(input)) break;
      if (/^new$/i.test(input)) { state = await openFresh(io); continue; }
      try {
        await say(state, input, io);
      } catch (error) {
        io.out.write(`\n${error.message || error}\n`);
      }
    }
  } finally {
    rl.close();
  }
  return 0;
}

async function runOrbChat(args = [], io = { out: process.stdout }) {
  const [verb, ...rest] = args;
  if (verb === 'new') {
    await openFresh(io);
    return 0;
  }
  if (verb === 'say') {
    const text = rest.join(' ').trim();
    if (!text) {
      io.out.write('Usage: atris orb say "what is on your mind"\n');
      return 2;
    }
    await say(readState(), text, io);
    return 0;
  }
  if (verb === 'pick') {
    const state = readState();
    if (!state.options.length) {
      io.out.write('No choices yet. Start with: atris orb new\n');
      return 2;
    }
    const number = Number(rest[0]);
    if (!Number.isInteger(number) || number < 1 || number > state.options.length) {
      io.out.write(`Pick a number from 1 to ${state.options.length}.\n`);
      return 2;
    }
    await say(state, String(number), io);
    return 0;
  }
  return interactive(io);
}

module.exports = { runOrbChat, resolveInput, turnBody, parseSseLines, readState, writeState, stateFile };
