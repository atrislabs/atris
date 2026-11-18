#!/usr/bin/env node
// atris mcp, a stdio Model Context Protocol server.
// Design tools (design_extract, design_check, design_search) call the design
// API. Auth resolves the same way as the CLI: ATRIS_API_KEY, then the
// logged-in atris token, then ~/.atris/design-api-key.
// Campaign tools (campaign_list, campaign_show, campaign_new, campaign_start,
// campaign_run, campaign_ask, campaign_answer) run `atris campaign ... --json`
// in the workspace and need no key.

import { spawn } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import designApi from '../../lib/design-api.js';

const { resolveDesignKey, designRequest, pollDesignJob, billingOf } = designApi;

const DESIGN_TOOLS = [
  {
    name: 'design_extract',
    description: 'extract a site\'s design system (colors, typography, layout, voice) as json. costs 10 credits, 2 on a cache hit.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'site url to extract, e.g. https://stripe.com' },
      },
      required: ['url'],
    },
  },
  {
    name: 'design_check',
    description: 'score how closely a page follows a reference brand. costs 20 credits.',
    inputSchema: {
      type: 'object',
      properties: {
        source_url: { type: 'string', description: 'page being checked' },
        reference_url: { type: 'string', description: 'brand url to check against' },
      },
      required: ['source_url', 'reference_url'],
    },
  },
  {
    name: 'design_search',
    description: 'search brands already extracted by atris design. costs 1 credit.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'plain words, e.g. "dark developer tools brand"' },
        limit: { type: 'number', description: 'max results' },
      },
      required: ['query'],
    },
  },
];

const CWD = { type: 'string', description: 'workspace folder to run in; defaults to the folder this server started in' };
const ID = { type: 'string', description: 'campaign id, e.g. cmp-ship-billing-1a2b' };
const AS = { type: 'string', description: 'the member you are working as, e.g. builder; writes are never recorded as a person' };

export const CAMPAIGN_TOOLS = [
  {
    name: 'campaign_list',
    description: 'list every atris campaign with its state, money spent, and the next move. a campaign is a long goal with a judge (a command that exits 0 when the goal is met), a budget, and members.',
    inputSchema: { type: 'object', properties: { cwd: CWD } },
  },
  {
    name: 'campaign_show',
    description: 'show one campaign: judge and its last reading, budget, seats, missions, open asks, and the next move.',
    inputSchema: { type: 'object', properties: { id: ID, cwd: CWD }, required: ['id'] },
  },
  {
    name: 'campaign_new',
    description: 'the easiest start: give a goal in plain words. the owner\'s engine drafts a judge script, atris runs it to prove it fails today, and returns the draft. start: true also starts the campaign. budget defaults to $20.',
    inputSchema: {
      type: 'object',
      properties: {
        goal: { type: 'string', description: 'the goal in plain words' },
        budget: { type: 'number', description: 'dollars the campaign may spend (default 20)' },
        owner: { type: 'string', description: 'member who owns it (default mission-lead)' },
        start: { type: 'boolean', description: 'start the campaign once the drafted judge fails today' },
        cwd: CWD,
      },
      required: ['goal'],
    },
  },
  {
    name: 'campaign_start',
    description: 'start a campaign with a judge you wrote. the judge runs first and a judge that already passes is refused: it must fail today. print graded output like "ℹ pass 3" and "ℹ fail 2" so progress shows.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'short name for the goal' },
        judge: { type: 'string', description: 'shell command that exits 0 only when the goal is met' },
        budget: { type: 'number', description: 'dollars the campaign may spend' },
        owner: { type: 'string', description: 'member who owns it (default mission-lead)' },
        seats: { type: 'array', items: { type: 'string' }, description: 'members who work on it, as member or member:role' },
        bet: { type: 'string', description: 'what you think will work' },
        id: { type: 'string', description: 'optional id, cmp-<lowercase-words>' },
        as: AS,
        cwd: CWD,
      },
      required: ['title', 'judge', 'budget'],
    },
  },
  {
    name: 'campaign_run',
    description: 'let the campaign run itself for at most max_steps steps: it judges, proposes missions, and runs them. it stops early when the judge passes, the money runs out, or a person must answer an ask. returns the stop reason.',
    inputSchema: {
      type: 'object',
      properties: {
        id: ID,
        max_steps: { type: 'number', description: 'steps before it stops, 1 to 20 (default 3)' },
        parallel: { type: 'number', description: 'missions at once, 1 to 5 (default 3)' },
        as: AS,
        cwd: CWD,
      },
      required: ['id'],
    },
  },
  {
    name: 'campaign_ask',
    description: 'stop for a person before anything that cannot be undone: sending, paying, deleting, deploying, publishing. the campaign waits until a person answers.',
    inputSchema: {
      type: 'object',
      properties: {
        id: ID,
        question: { type: 'string', description: 'the question, with what happens on yes' },
        mission: { type: 'string', description: 'mission id the ask belongs to' },
        as: AS,
        cwd: CWD,
      },
      required: ['id', 'question'],
    },
  },
  {
    name: 'campaign_answer',
    description: 'pass along a person\'s answer to an open ask. an agent cannot close an ask: the answer is recorded and the ask stays open until the person runs the returned person_command in their own terminal.',
    inputSchema: {
      type: 'object',
      properties: {
        id: ID,
        ask_id: { type: 'string', description: 'ask id from campaign_show, e.g. a-1b2c3d' },
        answer: { type: 'string', description: 'the person\'s answer in their words' },
        as: AS,
        cwd: CWD,
      },
      required: ['id', 'ask_id', 'answer'],
    },
  },
];

export const TOOLS = [...DESIGN_TOOLS, ...CAMPAIGN_TOOLS];

function terminal(job) {
  const s = String((job && job.status) || '').toLowerCase();
  return s === 'completed' || s === 'failed' || s === 'error' || s === 'succeeded';
}

function withBilling(data) {
  const bill = billingOf(data);
  return {
    ...(data && typeof data === 'object' ? data : { result: data }),
    credits_charged: bill.credits,
    balance_remaining_usd: bill.balanceUsd,
  };
}

function ok(data) {
  return { content: [{ type: 'text', text: JSON.stringify(withBilling(data), null, 2) }] };
}

function fail(message) {
  return { content: [{ type: 'text', text: message }], isError: true };
}

async function callApi(pathname, options, key) {
  const res = await designRequest(pathname, { ...options, key });
  if (!res.ok) throw new Error(`http ${res.status}: ${res.error || 'request failed'}`);
  if (!res.data || typeof res.data !== 'object') {
    throw new Error('the design api returned an empty response');
  }
  return res.data;
}

async function runJob(first, pollPath, key) {
  if (!first || typeof first !== 'object') {
    throw new Error('the design api returned an empty response');
  }
  let job = first;
  if (!terminal(job) && !job.id) {
    throw new Error('the design api returned no job id');
  }
  if (!terminal(job) && job.id) {
    let failures = 0;
    const polled = await pollDesignJob(async () => {
      try {
        const out = await callApi(pollPath, {}, key);
        failures = 0;
        return out;
      } catch (error) {
        failures += 1;
        if (failures >= 3) return { status: 'failed', id: job.id, error: (error && error.message) || String(error) };
        return { status: 'polling' };
      }
    });
    if (polled.timedOut) {
      throw new Error(`still running after 3 minutes. job id: ${job.id}, poll: ${pollPath}`);
    }
    job = polled.job || job;
  }
  if (job.status !== 'completed') {
    throw new Error(`job ${job.id || 'unknown'} did not finish: ${job.error || job.status || 'unknown'} (poll: ${pollPath})`);
  }
  return job;
}

const CLI = fileURLToPath(new URL('../../bin/atris.js', import.meta.url));

function text(value) {
  return String(value ?? '').trim();
}

function bounded(value, min, max, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
}

// The argv for `atris campaign` for one tool call, or { error }.
export function campaignArgs(name, args = {}) {
  const as = text(args.as) ? ['--as', text(args.as)] : [];
  const need = (...keys) => keys.filter((key) => !text(args[key]));
  if (name === 'campaign_list') return ['campaign', 'list', '--json'];
  if (name === 'campaign_show') {
    if (need('id').length) return { error: 'campaign_show needs an id' };
    return ['campaign', 'show', text(args.id), '--json'];
  }
  if (name === 'campaign_new') {
    if (need('goal').length) return { error: 'campaign_new needs a goal' };
    const out = ['campaign', 'new', text(args.goal)];
    if (args.budget !== undefined) out.push('--budget', String(args.budget));
    if (text(args.owner)) out.push('--owner', text(args.owner));
    if (args.start === true) out.push('--yes');
    return [...out, '--json'];
  }
  if (name === 'campaign_start') {
    const missing = need('title', 'judge');
    if (missing.length || args.budget === undefined) return { error: 'campaign_start needs a title, a judge, and a budget' };
    const out = ['campaign', 'start', text(args.title), '--judge', text(args.judge), '--budget', String(args.budget)];
    if (text(args.owner)) out.push('--owner', text(args.owner));
    for (const seat of Array.isArray(args.seats) ? args.seats : []) if (text(seat)) out.push('--seat', text(seat));
    if (text(args.bet)) out.push('--bet', text(args.bet));
    if (text(args.id)) out.push('--id', text(args.id));
    return [...out, ...as, '--json'];
  }
  if (name === 'campaign_run') {
    if (need('id').length) return { error: 'campaign_run needs an id' };
    return ['campaign', 'run', text(args.id), '--max-steps', String(bounded(args.max_steps, 1, 20, 3)),
      '--parallel', String(bounded(args.parallel, 1, 5, 3)), ...as, '--json'];
  }
  if (name === 'campaign_ask') {
    if (need('id', 'question').length) return { error: 'campaign_ask needs an id and a question' };
    const out = ['campaign', 'ask', text(args.id), text(args.question)];
    if (text(args.mission)) out.push('--mission', text(args.mission));
    return [...out, ...as, '--json'];
  }
  if (name === 'campaign_answer') {
    if (need('id', 'ask_id', 'answer').length) return { error: 'campaign_answer needs an id, an ask_id, and an answer' };
    return ['campaign', 'answer', text(args.id), text(args.ask_id), text(args.answer), ...as, '--json'];
  }
  return { error: `unknown tool: ${name}` };
}

// Every write from here is an agent's: the CLI never records it as a person.
function runCli(argv, cwd) {
  const env = { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1', ATRIS_NONINTERACTIVE: '1', ATRIS_AGENT_ID: process.env.ATRIS_AGENT_ID || 'mcp-agent' };
  delete env.ATRIS_HUMAN;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...argv], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => resolve({ code: null, stdout, stderr: error.message }));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function lastJson(stdout) {
  const lines = String(stdout).split('\n').map((line) => line.trim()).filter(Boolean).reverse();
  for (const line of lines) {
    try { return JSON.parse(line); } catch {}
  }
  return null;
}

export async function handleCampaignTool(name, args = {}) {
  const argv = campaignArgs(name, args);
  if (!Array.isArray(argv)) return fail(argv.error);
  const ran = await runCli(argv, text(args.cwd) || process.cwd());
  const data = lastJson(ran.stdout);
  if (!data) return fail(`atris campaign gave no json (exit ${ran.code}): ${text(ran.stderr || ran.stdout).slice(-400)}`);
  if (name === 'campaign_answer' && data.campaign && data.campaign.asks.some((ask) => ask.id === text(args.ask_id))) {
    data.still_open = true;
    data.person_command = `atris campaign answer ${text(args.id)} ${text(args.ask_id)} ${JSON.stringify(text(args.answer))}`;
  }
  const result = { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  if (data.ok === false) result.isError = true;
  return result;
}

export async function handleTool(name, args = {}, key) {
  if (name === 'design_extract') {
    const url = String(args.url || '').trim();
    if (!url) return fail('design_extract needs a url');
    const first = await callApi('/design/extractions', { method: 'POST', body: { url } }, key);
    return ok(await runJob(first, `/design/extractions/${first.id}`, key));
  }
  if (name === 'design_check') {
    const source = String(args.source_url || '').trim();
    const reference = String(args.reference_url || '').trim();
    if (!source || !reference) return fail('design_check needs source_url and reference_url');
    const first = await callApi('/design/adherence', {
      method: 'POST',
      body: { source_url: source, reference_url: reference },
    }, key);
    return ok(await runJob(first, `/design/adherence/${first.id}`, key));
  }
  if (name === 'design_search') {
    const query = String(args.query || '').trim();
    if (!query) return fail('design_search needs a query');
    const body = { query };
    if (Number.isInteger(args.limit) && args.limit > 0) body.limit = args.limit;
    return ok(await callApi('/design/search', { method: 'POST', body }, key));
  }
  return fail(`unknown tool: ${name}`);
}

async function serveStdio() {
  const { name, version } = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  const knownVersions = new Set(['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25']);
  const send = (message, onWritten) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`, onWritten);
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const inFlight = new Set();
  const pendingById = new Map();

  for await (const line of input) {
    if (!line.trim()) continue;
    let request;
    try {
      request = JSON.parse(line);
    } catch {
      send({ id: null, error: { code: -32700, message: 'parse error' } });
      continue;
    }
    if (!request || typeof request !== 'object' || Array.isArray(request)
      || request.jsonrpc !== '2.0' || typeof request.method !== 'string') {
      send({ id: request?.id ?? null, error: { code: -32600, message: 'invalid request' } });
      continue;
    }
    if (request.method === 'notifications/cancelled') {
      const pending = pendingById.get(request.params?.requestId);
      if (pending) pending.cancelled = true;
      continue;
    }
    if (!Object.hasOwn(request, 'id')) continue;

    const id = request.id;
    let result;
    if (request.method === 'initialize') {
      result = {
        protocolVersion: knownVersions.has(request.params?.protocolVersion)
          ? request.params.protocolVersion : '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name, version },
      };
    } else if (request.method === 'ping') {
      result = {};
    } else if (request.method === 'tools/list') {
      result = { tools: TOOLS };
    } else if (request.method === 'tools/call') {
      const pending = { cancelled: false };
      const work = (async () => {
        const toolName = String(request.params?.name || '');
        const isCampaign = toolName.startsWith('campaign_');
        try {
          if (isCampaign) {
            result = await handleCampaignTool(toolName, request.params?.arguments || {});
          } else {
            const key = resolveDesignKey();
            result = key
              ? await handleTool(request.params?.name, request.params?.arguments || {}, key)
              : fail('no api key found. set ATRIS_API_KEY or run: atris login (or save a key in ~/.atris/design-api-key)');
          }
        } catch (error) {
          result = fail(`${isCampaign ? 'campaign' : 'design'} call failed: ${(error && error.message) || error}`);
        }
        if (!pending.cancelled) {
          await new Promise((resolve, reject) => {
            send({ id, result }, (error) => (error ? reject(error) : resolve()));
          });
        }
      })();
      inFlight.add(work);
      pendingById.set(id, pending);
      const done = () => {
        inFlight.delete(work);
        if (pendingById.get(id) === pending) pendingById.delete(id);
      };
      work.then(done, (error) => {
        done();
        process.stderr.write(`mcp response write failed: ${(error && error.message) || error}\n`);
        process.exitCode = 1;
      });
      continue;
    } else {
      send({ id, error: { code: -32601, message: 'method not found' } });
      continue;
    }
    send({ id, result });
  }
  await Promise.allSettled(inFlight);
}

// Auto-start only when run directly (`atris mcp`, `npx atris-mcp`,
// node index.mjs); realpathSync resolves the npm bin symlink.
const invokedPath = process.argv[1] ? realpathSync(process.argv[1]) : '';
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) {
  await serveStdio();
}
