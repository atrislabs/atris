'use strict';

// atris memory show, search, ask, read, ls, remember, write, rm, usage, log, lesson
// and agents: the person's Atris memory from any terminal, so any agent can
// read it, search it and save to it. One request per command. The login and
// network modules load only when a command needs the server.

const fs = require('fs');
const path = require('path');
const live = require('../lib/memory-live');
const { NOT_LOGGED_IN, oneLine, tokenFrom } = require('../lib/developer-api');

const MAX_WRITE_BYTES = 1000000;
const STDIN_WAIT_MS = 5000;
const REMEMBER_MAX_CHARS = 1000;
const ASK_MAX_CHARS = 500;
const REMEMBER_FILES = ['journal', 'now', 'learning'];
const LEARNING_SECTIONS = ['want', 'understand', 'shaky'];

class UsageError extends Error {}

const enc = encodeURIComponent;

function usageFor(sub) {
  const line = live.USAGE_LINES[sub];
  return `${line ? `usage:\n${line}\n` : ''}All memory commands: atris memory --help`;
}

// What went wrong, in words a person or an agent can act on.
function plainError(result, auth = {}) {
  const status = Number(result && result.status) || 0;
  const raw = result ? result.error : null;
  let detail;
  if (Array.isArray(raw)) {
    const first = raw[0] || {};
    const field = Array.isArray(first.loc) ? first.loc.filter((part) => part !== 'body' && part !== 'query').join('.') : '';
    detail = `Atris refused the request${field ? `, ${field}` : ''}: ${oneLine(first.msg || 'not valid')}`;
  } else {
    detail = oneLine(raw);
  }
  if (status === 0) return `could not reach Atris (${detail}). Check the connection and try again.`;
  if (status === 401) return 'your Atris login was not accepted. Run: atris login';
  if (status === 404 && detail === 'Not Found') {
    return auth.scoped
      ? 'this agent sign-in cannot reach Atris memory. Memory needs your own login: atris login'
      : 'the Atris server does not have this memory command yet. Try again after it updates.';
  }
  if (status === 429) return 'Atris is getting too many requests right now. Wait a minute and try again.';
  if (status >= 500) return `Atris had a problem (HTTP ${status}). Try again in a moment.`;
  return detail;
}

async function defaultAuth() {
  const { apiRequestJson } = require('../utils/api');
  const { ensureFreshCredentials, decodeJwtClaims } = require('../utils/auth');
  const creds = await ensureFreshCredentials(apiRequestJson);
  const token = tokenFrom(creds);
  const claims = token ? decodeJwtClaims(token) : null;
  const scoped = Boolean(creds && (creds.auth_type === 'agent_client' || (claims && claims.type === 'agent_access')));
  return { token, scoped };
}

function makeCall(deps, auth) {
  const request = deps.apiRequestJson || require('../utils/api').apiRequestJson;
  return async (pathname, options = {}) => {
    const result = await request(pathname, { token: auth.token, timeoutMs: 30000, ...options });
    if (result && result.ok) return result.data || {};
    const error = new Error(plainError(result, auth));
    error.status = result ? Number(result.status) || 0 : 0;
    throw error;
  };
}

// The whole of stdin, or null when nothing is piped in. Stops waiting after a
// few seconds with no data, so an agent whose stdin is an idle pipe never hangs.
function readStdin(waitMs = STDIN_WAIT_MS) {
  const stdin = process.stdin;
  if (stdin.isTTY) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const chunks = [];
    let got = false;
    const timer = setTimeout(() => {
      if (got) return;
      stdin.pause();
      resolve(null);
    }, waitMs);
    stdin.on('data', (chunk) => { got = true; chunks.push(chunk); });
    stdin.on('end', () => { clearTimeout(timer); resolve(Buffer.concat(chunks)); });
    stdin.on('error', (error) => { clearTimeout(timer); reject(error); });
  });
}

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function agentName(ctx) {
  return String(ctx.flags['--as'] || ctx.env.ATRIS_AGENT || '').trim();
}

function needAgent(ctx) {
  const agent = agentName(ctx);
  if (!agent) throw new UsageError('say which agent you are: --as <name>, or set ATRIS_AGENT once (like ATRIS_AGENT=codex)');
  return agent;
}

function onePath(ctx, what) {
  const [rel, extra] = ctx.words;
  if (!rel) throw new UsageError(`name the ${what}, like wiki/people/sam.md`);
  if (extra !== undefined) throw new UsageError(`give one path; "${extra}" is extra`);
  return rel;
}

function numberFlag(ctx, name, read) {
  const parsed = read(ctx.flags[name], name);
  if (parsed.error) throw new UsageError(parsed.error);
  return parsed.value;
}

const COMMANDS = {
  show: {
    check(ctx) {
      if (ctx.words.length) throw new UsageError('show takes no words; it prints everything that matters now');
    },
    async run(ctx) {
      const data = await ctx.call('/me/memory');
      const text = live.showText(data);
      return { data: { empty: Boolean(data.empty), files: data.files || {}, text }, lines: [text] };
    },
  },

  search: {
    check(ctx) {
      const query = ctx.words.map((word) => word.trim()).filter(Boolean).join('|');
      if (!query) throw new UsageError('say what to look for, like atris memory search "rent|lease"');
      return { query, folder: ctx.flags['--in'] || '' };
    },
    async run(ctx, { query, folder }) {
      const data = await ctx.call(`/memory/grep?q=${enc(query)}${folder ? `&folder=${enc(folder)}` : ''}`);
      return { data: { query, folder, ...data }, lines: live.searchLines(query, data) };
    },
  },

  ask: {
    check(ctx) {
      const question = ctx.words.join(' ').replace(/\s+/g, ' ').trim();
      if (!question) throw new UsageError('ask a question, like atris memory ask "where does Sam work?"');
      if (question.length > ASK_MAX_CHARS) throw new UsageError('keep the question under 500 characters');
      return { question, folder: ctx.flags['--in'] || '' };
    },
    async run(ctx, { question, folder }) {
      // The server reads for up to 75 seconds; asking twice would count twice.
      const data = await ctx.call(`/memory/ask?q=${enc(question)}${folder ? `&folder=${enc(folder)}` : ''}`, { timeoutMs: 90000, retries: 0 });
      return { data, lines: live.askLines(data) };
    },
  },

  read: {
    check(ctx) {
      const rel = onePath(ctx, 'file to read');
      const from = numberFlag(ctx, '--from', live.positiveInt);
      const count = numberFlag(ctx, '--lines', live.positiveInt);
      if (ctx.flags['--raw'] && (from || count)) throw new UsageError('--raw prints the whole file; leave out --from and --lines');
      return { rel, from: from || 1, count: count || 120 };
    },
    async run(ctx, { rel, from, count }) {
      if (ctx.flags['--raw']) {
        const data = await ctx.call(`/memory/file?path=${enc(rel)}`);
        return { data, raw: String(data.text || '') };
      }
      const data = await ctx.call(`/memory/read?path=${enc(rel)}&start=${from}&count=${count}`);
      return { data, lines: live.readLines({ path: rel, ...data }) };
    },
  },

  ls: {
    check(ctx) {
      if (ctx.words.length > 1) throw new UsageError('give one folder, or none for the top');
      return { folder: (ctx.words[0] || '').replace(/^\/+|\/+$/g, '') };
    },
    async run(ctx, { folder }) {
      const data = await ctx.call(`/memory/ls?folder=${enc(folder)}`);
      return { data: { folder, items: data.items || [] }, lines: live.lsLines(folder, data) };
    },
  },

  remember: {
    check(ctx) {
      const text = ctx.words.join(' ').replace(/\s+/g, ' ').trim();
      if (!text) throw new UsageError('say what to remember, like atris memory remember "prefers short answers"');
      if (text.length > REMEMBER_MAX_CHARS) throw new UsageError('keep it to one short line, under 1,000 characters');
      const file = ctx.flags['--to'] || 'journal';
      if (!REMEMBER_FILES.includes(file)) throw new UsageError('--to is journal (the default), now or learning');
      const section = ctx.flags['--section'];
      if (section && file !== 'learning') throw new UsageError('--section goes with --to learning');
      if (section && !LEARNING_SECTIONS.includes(section)) throw new UsageError('--section is want, understand or shaky');
      const body = { text, file, source: (agentName(ctx) || 'terminal').slice(0, 40) };
      if (section) body.section = section;
      return body;
    },
    async run(ctx, body) {
      const data = await ctx.call('/me/memory/remember', { method: 'POST', body, retries: 0 });
      return { data, lines: [`Saved to ${data.file || body.file}: ${String(data.added || body.text).replace(/^- /, '')}`] };
    },
  },

  write: {
    check(ctx) {
      const [rel, extra] = ctx.words;
      if (!rel) throw new UsageError('name the page, like wiki/people/sam.md');
      if (extra !== undefined) {
        throw new UsageError('the page comes from --file or stdin, not from words. Pipe it in: echo "text" | atris memory write <path>');
      }
      return { rel, file: ctx.flags['--file'] };
    },
    async run(ctx, { rel, file }) {
      let buffer;
      let from = 'the page';
      if (file && file !== '-') {
        from = file;
        try {
          buffer = fs.readFileSync(path.resolve(ctx.cwd, file));
        } catch (error) {
          throw new Error(`could not read ${file}: ${error.code === 'ENOENT' ? 'no such file' : oneLine(error.message)}`);
        }
      } else {
        buffer = await (ctx.deps.readStdin || readStdin)();
        if (buffer === null) {
          throw new UsageError(`give the page with --file <file>, or pipe it in: cat page.md | atris memory write ${rel}`);
        }
      }
      if (!buffer.length) {
        throw new UsageError(`nothing to save, ${from === 'the page' ? 'no text came in' : `${from} is empty`}. To delete a page, run: atris memory rm ${rel}`);
      }
      if (buffer.length > MAX_WRITE_BYTES) throw new Error('Keep a write under 1 MB.');
      let text;
      try { text = utf8.decode(buffer); } catch { throw new Error(`${from} is not text. Only text pages and files can be saved here.`); }
      const data = await ctx.call('/memory/write', { method: 'PUT', body: { path: rel, text } });
      return { data, lines: [`Saved ${data.path || rel} (${live.size(data.bytes != null ? data.bytes : buffer.length)}).`] };
    },
  },

  rm: {
    check(ctx) {
      return { rel: onePath(ctx, 'page to delete') };
    },
    async run(ctx, { rel }) {
      const data = await ctx.call(`/memory/file?path=${enc(rel)}`, { method: 'DELETE', retries: 0 });
      return { data, lines: [`Deleted ${data.path || rel} from your Atris memory.`] };
    },
  },

  usage: {
    check(ctx) {
      if (ctx.words.length) throw new UsageError('usage takes no words');
    },
    async run(ctx) {
      const data = await ctx.call('/memory/usage');
      return { data, lines: [data.message || `Your files use ${live.size(data.used_bytes)}.`] };
    },
  },

  log: {
    check(ctx) {
      const agent = needAgent(ctx);
      const text = ctx.words.join(' ').replace(/\s+/g, ' ').trim();
      if (!text) throw new UsageError('say what you did, like atris memory log "drafted the lease email" --as codex');
      return { text, agent };
    },
    async run(ctx, body) {
      const data = await ctx.call('/memory/log', { method: 'POST', body, retries: 0 });
      return { data, lines: [`Logged in ${data.path}: ${String(data.line || body.text).replace(/^- /, '')}`] };
    },
  },

  lesson: {
    check(ctx) {
      const agent = needAgent(ctx);
      const text = ctx.words.join(' ').replace(/\s+/g, ' ').trim();
      if (!text) throw new UsageError('say the lesson, like atris memory lesson "search names first" --before 3 --after 5 --as codex');
      const before = numberFlag(ctx, '--before', live.plainNumber);
      const after = numberFlag(ctx, '--after', live.plainNumber);
      return { text, score_before: before, score_after: after, agent };
    },
    async run(ctx, body) {
      const data = await ctx.call('/memory/lesson', { method: 'POST', body, retries: 0 });
      const score = `${body.score_before} -> ${body.score_after}`;
      const lines = data.kept
        ? [`Kept in ${data.path}: ${String(data.lesson || body.text).replace(/^- /, '')}`]
        : [`Not kept, because the score did not go up (${score}). Logged as tried and dropped in ${data.path}.`];
      return { data, lines };
    },
  },

  agents: {
    local: true,
    check(ctx) {
      if (ctx.words.length) throw new UsageError('agents takes no words. To add the rules to a file: --write AGENTS.md');
    },
    async run(ctx) {
      const agent = agentName(ctx);
      const block = live.rulesBlock(agent);
      const apiBase = ctx.deps.apiBase || require('../utils/api').getApiBaseUrl();
      const mcp = live.mcpSetup(apiBase);
      const target = ctx.flags['--write'];
      const lines = [];
      let file = null;
      if (target) {
        file = live.writeRulesFile(target, block, ctx.cwd);
        const shown = path.relative(ctx.cwd, file.path) || file.path;
        if (file.action === 'added') lines.push(`Added the Atris memory rules to ${shown}.`);
        else if (file.action === 'replaced') lines.push(`Updated the Atris memory rules in ${shown}. The rest of the file is untouched.`);
        else lines.push(`${shown} already has these rules. Nothing changed.`);
      } else {
        lines.push(
          'Paste this into the agent\'s rules file (AGENTS.md, CLAUDE.md, .cursorrules or Codex instructions),',
          'or let atris add it and keep it current: atris memory agents --write AGENTS.md',
          '',
          block,
        );
      }
      const setup = live.mcpLines(mcp);
      if (setup.length) lines.push('', ...setup);
      return { data: { agent: agent || null, block, file, mcp }, lines };
    },
  },
};
COMMANDS.setup = COMMANDS.agents;

async function memoryLiveCommand(args = [], deps = {}) {
  const log = deps.log || console.log;
  const err = deps.err || console.error;
  const out = deps.out || ((text) => process.stdout.write(text));
  const parsed = live.parseLiveArgs(args);
  const json = Boolean(parsed.json) || args.includes('--json');
  const sub = parsed.sub || '';

  const usageFail = (message) => {
    if (json) log(JSON.stringify({ ok: false, error: message }));
    else err(`atris memory ${sub}: ${message}\n${usageFor(sub)}`);
    return 2;
  };
  const fail = (message, status) => {
    if (json) log(JSON.stringify({ ok: false, error: message, ...(status ? { status } : {}) }));
    else err(message);
    return 1;
  };

  if (parsed.error) return usageFail(parsed.error);
  const command = COMMANDS[sub];
  if (!command) return usageFail('not a memory command');
  if (parsed.help) {
    log(usageFor(sub));
    return 0;
  }

  const ctx = { ...parsed, deps, env: deps.env || process.env, cwd: deps.cwd || process.cwd() };
  try {
    const prepared = command.check ? command.check(ctx) : undefined;
    if (!command.local) {
      const auth = await (deps.getAuth || defaultAuth)();
      if (!auth || !auth.token) return fail(NOT_LOGGED_IN);
      ctx.call = makeCall(deps, auth);
    }
    const result = await command.run(ctx, prepared);
    if (json) log(JSON.stringify({ ok: true, ...result.data }));
    else if (result.raw !== undefined) out(result.raw);
    else for (const line of result.lines) log(line);
    return 0;
  } catch (error) {
    if (error instanceof UsageError) return usageFail(error.message);
    return fail(oneLine(error && error.message), error && error.status);
  }
}

// Called by bin/atris.js before the rest of the CLI loads.
function runFromCli(args) {
  const exit = (code) => {
    if (process.stdout.writableLength === 0) process.exit(code);
    else process.stdout.write('', () => process.exit(code));
  };
  memoryLiveCommand(args)
    .then((code) => exit(typeof code === 'number' ? code : 0))
    .catch((error) => {
      console.error(oneLine(error && error.message ? error.message : error));
      process.exit(1);
    });
}

module.exports = { memoryLiveCommand, plainError, runFromCli };
