#!/usr/bin/env node
// atris mcp, a stdio Model Context Protocol server exposing the design API.
// Tools: design_extract, design_check, design_search.
// Auth resolves the same way as the CLI: ATRIS_API_KEY, then
// ~/.atris/design-api-key, then the logged-in atris token.

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
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
  return res.data;
}

async function runJob(first, pollPath, key) {
  if (terminal(first) || !first.id) return first;
  const polled = await pollDesignJob(() => callApi(pollPath, {}, key));
  if (polled.timedOut) throw new Error(`still running after 3 minutes. job id: ${first.id}`);
  const job = polled.job || first;
  if (job.status !== 'completed') throw new Error(`job did not finish: ${job.error || job.status || 'unknown'}`);
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

export function createServer() {
  const server = new Server(
    { name: 'atris', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const key = resolveDesignKey();
    if (!key) {
      return fail('no api key found. set ATRIS_API_KEY or run: atris api-key create');
    }
    try {
      return await handleTool(request.params.name, request.params.arguments || {}, key);
    } catch (error) {
      return fail(`design call failed: ${(error && error.message) || error}`);
    }
  });

  return server;
}

// Auto-start only when run directly (`atris mcp`, `npx atris-mcp`,
// node index.mjs); realpathSync resolves the npm bin symlink.
const invokedPath = process.argv[1] ? realpathSync(process.argv[1]) : '';
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
