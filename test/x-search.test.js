'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseXSearchArgs,
  buildSearchPayload,
  buildPersonPayload,
  formatXSearchResult,
  xSearchCommand,
} = require('../commands/x-search');

test('parseXSearchArgs accepts query with limit, days, and json', () => {
  const options = parseXSearchArgs([
    'MCP agents',
    '--limit',
    '5',
    '--days',
    '2',
    '--json',
  ]);

  assert.equal(options.mode, 'search');
  assert.equal(options.query, 'MCP agents');
  assert.equal(options.limit, 5);
  assert.equal(options.daysBack, 2);
  assert.equal(options.json, true);
  assert.equal(options.help, false);
});

test('buildSearchPayload maps days to days_back and omits unset fields', () => {
  assert.deepEqual(buildSearchPayload(parseXSearchArgs(['AI agents'])), {
    query: 'AI agents',
  });
  assert.deepEqual(buildSearchPayload(parseXSearchArgs(['AI agents', '--limit=10', '--days=7'])), {
    query: 'AI agents',
    limit: 10,
    days_back: 7,
  });
});

test('parseXSearchArgs person mode requires --name', () => {
  const options = parseXSearchArgs([
    'person',
    '--name',
    'Leah Bonvissuto',
    '--handle',
    '@leahbon',
    '--company',
    'Presentr',
  ]);
  assert.equal(options.mode, 'person');
  assert.equal(options.name, 'Leah Bonvissuto');
  assert.equal(options.handle, 'leahbon');
  assert.equal(options.company, 'Presentr');
  assert.deepEqual(buildPersonPayload(options), {
    name: 'Leah Bonvissuto',
    handle: 'leahbon',
    company: 'Presentr',
  });
  assert.throws(() => parseXSearchArgs(['person', '--handle', 'x']), /Missing --name/);
});

test('xSearchCommand --help prints usage without calling the API', async () => {
  const output = [];
  let apiCalls = 0;
  const status = await xSearchCommand(['--help'], {
    output: (line) => output.push(line),
    apiRequestJson: async () => {
      apiCalls += 1;
      return { ok: true, status: 200, data: {} };
    },
  });

  assert.equal(status, 0);
  assert.equal(apiCalls, 0);
  assert.match(output.join('\n'), /Usage: atris x-search/);
  assert.match(output.join('\n'), /--limit/);
  assert.match(output.join('\n'), /person --name/);
});

test('xSearchCommand prints content, citations, and credits', async () => {
  const calls = [];
  const output = [];

  const status = await xSearchCommand(['MCP agents', '--limit', '5', '--days', '2'], {
    output: (line) => output.push(line),
    ensureValidCredentials: async () => ({ credentials: { token: 'token-123' } }),
    apiRequestJson: async (pathname, options) => {
      calls.push({ pathname, options });
      return {
        ok: true,
        status: 200,
        data: {
          status: 'success',
          credits_used: 5,
          credits_remaining: 995,
          data: {
            content: '1. @levelsio: MCP agents are shipping.',
            citations: [
              'https://x.com/levelsio/status/1',
              'https://x.com/i/status/2',
            ],
            usage: { prompt_tokens: 10, completion_tokens: 20 },
          },
        },
      };
    },
  });

  assert.equal(status, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].pathname, '/x-search/search');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.token, 'token-123');
  assert.equal(calls[0].options.retries, 0);
  assert.deepEqual(calls[0].options.body, {
    query: 'MCP agents',
    limit: 5,
    days_back: 2,
  });

  const text = output.join('\n');
  assert.match(text, /MCP agents are shipping/);
  assert.match(text, /https:\/\/x\.com\/levelsio\/status\/1/);
  assert.match(text, /https:\/\/x\.com\/i\/status\/2/);
  assert.match(text, /Credits: 5 used, 995 remaining/);
});

test('xSearchCommand --json prints raw payload', async () => {
  const output = [];
  const status = await xSearchCommand(['hello', '--json'], {
    output: (line) => output.push(line),
    ensureValidCredentials: async () => ({ credentials: { token: 't' } }),
    apiRequestJson: async () => ({
      ok: true,
      status: 200,
      data: { status: 'success', credits_used: 5, data: { content: 'hi', citations: [] } },
    }),
  });
  assert.equal(status, 0);
  const parsed = JSON.parse(output.join('\n'));
  assert.equal(parsed.credits_used, 5);
  assert.equal(parsed.data.content, 'hi');
});

test('xSearchCommand surfaces 401 login hint', async () => {
  await assert.rejects(
    () => xSearchCommand(['agents'], {
      output: () => {},
      ensureValidCredentials: async () => ({ credentials: { token: 't' } }),
      apiRequestJson: async () => ({
        ok: false,
        status: 401,
        error: 'Not authenticated',
      }),
    }),
    (err) => {
      assert.match(String(err.message), /401/);
      assert.match(String(err.message), /atris login --force/);
      return true;
    },
  );
});

test('xSearchCommand surfaces 402 credits hint', async () => {
  await assert.rejects(
    () => xSearchCommand(['agents'], {
      output: () => {},
      ensureValidCredentials: async () => ({ credentials: { token: 't' } }),
      apiRequestJson: async () => ({
        ok: false,
        status: 402,
        error: 'Insufficient credits',
      }),
    }),
    (err) => {
      assert.match(String(err.message), /402/);
      assert.match(String(err.message), /Check Atris credits/);
      return true;
    },
  );
});

test('xSearchCommand person posts to research-person', async () => {
  const calls = [];
  const status = await xSearchCommand([
    'person',
    '--name',
    'Leah Bonvissuto',
    '--handle',
    'leahbon',
  ], {
    output: () => {},
    ensureValidCredentials: async () => ({ credentials: { token: 'token-abc' } }),
    apiRequestJson: async (pathname, options) => {
      calls.push({ pathname, options });
      return {
        ok: true,
        status: 200,
        data: {
          status: 'success',
          credits_used: 5,
          credits_remaining: 990,
          data: { content: 'Profile notes', citations: ['https://x.com/leahbon'] },
        },
      };
    },
  });

  assert.equal(status, 0);
  assert.equal(calls[0].pathname, '/x-search/research-person');
  assert.deepEqual(calls[0].options.body, {
    name: 'Leah Bonvissuto',
    handle: 'leahbon',
  });
});

test('xSearchCommand missing query exits 2 with usage hint', async () => {
  const output = [];
  const status = await xSearchCommand(['--limit', '3'], {
    output: (line) => output.push(line),
  });
  assert.equal(status, 2);
  assert.match(output.join('\n'), /Missing query/);
});
