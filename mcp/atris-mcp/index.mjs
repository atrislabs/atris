#!/usr/bin/env node
// atris mcp, a stdio Model Context Protocol server exposing the design API.
// Tools: design_extract, design_check, design_search.
// Auth resolves the same way as the CLI: ATRIS_API_KEY, then
// the logged-in atris token, then ~/.atris/design-api-key.

import { readFileSync, realpathSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import designApi from '../../lib/design-api.js';

const { resolveDesignKey, designRequest, pollDesignJob, billingOf } = designApi;

export const TOOLS = [
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
  const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });

  for await (const line of input) {
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
      const key = resolveDesignKey();
      if (!key) {
        result = fail('no api key found. set ATRIS_API_KEY or run: atris login (or save a key in ~/.atris/design-api-key)');
      } else {
        try {
          result = await handleTool(request.params?.name, request.params?.arguments || {}, key);
        } catch (error) {
          result = fail(`design call failed: ${(error && error.message) || error}`);
        }
      }
    } else {
      send({ id, error: { code: -32601, message: 'method not found' } });
      continue;
    }
    send({ id, result });
  }
}

// Auto-start only when run directly (`atris mcp`, `npx atris-mcp`,
// node index.mjs); realpathSync resolves the npm bin symlink.
const invokedPath = process.argv[1] ? realpathSync(process.argv[1]) : '';
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) {
  await serveStdio();
}
