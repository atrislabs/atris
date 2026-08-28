'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  parseXSearchArgs,
  buildSearchPayload,
  buildPersonPayload,
  xSearchHasResults,
  xSearchApplyRel,
  xSearchExperimentSlug,
  xSearchCommand,
} = require('../commands/x-search');
const { TEACH_THIN_REFUSE } = require('../commands/youtube');

function applyWorkspace(source, filled = false) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-x-search-apply-'));
  fs.mkdirSync(path.join(cwd, 'atris', 'wiki', 'briefs'), { recursive: true });
  if (filled && source) {
    const rel = xSearchApplyRel(source);
    fs.writeFileSync(path.join(cwd, rel), [
      `source: ${source}`,
      'change: commands/x-search.js',
      'receipt: node --test test/x-search.test.js',
      '',
    ].join('\n'));
  }
  return cwd;
}

function assertNoSaveFiles(cwd, source) {
  const applyRel = xSearchApplyRel(source);
  const briefRel = applyRel.replace(/\.apply\.md$/, '.md');
  assert.equal(fs.existsSync(path.join(cwd, applyRel)), false);
  assert.equal(fs.existsSync(path.join(cwd, briefRel)), false);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'logs')), false);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'experiments', xSearchExperimentSlug(source))), false);
}

function successSearchData(content = '1. @levelsio: MCP agents are shipping.', citations = [
  'https://x.com/levelsio/status/1',
]) {
  return {
    ok: true,
    status: 200,
    data: {
      status: 'success',
      credits_used: 5,
      credits_remaining: 995,
      data: { content, citations },
    },
  };
}

test('parseXSearchArgs accepts query with limit, days, save, and json', () => {
  const options = parseXSearchArgs([
    'MCP agents',
    '--limit',
    '5',
    '--days',
    '2',
    '--save',
    '--json',
  ]);

  assert.equal(options.mode, 'search');
  assert.equal(options.query, 'MCP agents');
  assert.equal(options.limit, 5);
  assert.equal(options.daysBack, 2);
  assert.equal(options.save, true);
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
  assert.match(output.join('\n'), /--save/);
  assert.match(output.join('\n'), /person --name/);
  assert.match(output.join('\n'), /Empty or failed search refunds the credits/);
});

test('xSearchCommand prints content, citations, and credits', async () => {
  const calls = [];
  const output = [];
  const cwd = applyWorkspace('MCP agents');

  const status = await xSearchCommand(['MCP agents', '--limit', '5', '--days', '2'], {
    cwd,
    applyNow: '2026-08-26',
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
  assert.doesNotMatch(text, /thin: no number or named mechanism/);
  assert.doesNotMatch(text, /next: apply /);
  assertNoSaveFiles(cwd, 'MCP agents');
});

test('xSearchCommand --json prints raw payload', async () => {
  const output = [];
  const cwd = applyWorkspace('hello', true);
  const status = await xSearchCommand(['hello', '--json'], {
    cwd,
    applyNow: '2026-08-26',
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
  const output = [];
  const status = await xSearchCommand(['agents'], {
    output: (line) => output.push(line),
    ensureValidCredentials: async () => ({ credentials: { token: 't' } }),
    loadCredentials: () => ({ token: 't' }),
    apiRequestJson: async () => ({
      ok: false,
      status: 401,
      error: 'Not authenticated',
    }),
  });
  assert.equal(status, 1);
  assert.match(output.join('\n'), /401/);
  assert.match(output.join('\n'), /atris login --force/);
});

test('xSearchCommand surfaces 402 credits hint', async () => {
  const output = [];
  const status = await xSearchCommand(['agents'], {
    output: (line) => output.push(line),
    ensureValidCredentials: async () => ({ credentials: { token: 't' } }),
    apiRequestJson: async () => ({
      ok: false,
      status: 402,
      error: 'Insufficient credits',
    }),
  });
  assert.equal(status, 1);
  assert.match(output.join('\n'), /402/);
  assert.match(output.join('\n'), /Check Atris credits/);
});

test('xSearchCommand mints only the x-search scope after an expired user wall and retries', async () => {
  const calls = [];
  const persisted = [];
  const output = [];
  const secret = 'minted-x-search-secret';

  const cwd = applyWorkspace('MCP agents', true);
  const status = await xSearchCommand(['MCP agents'], {
    cwd,
    applyNow: '2026-08-26',
    output: (line) => output.push(line),
    ensureValidCredentials: async () => ({ error: 'token_invalid', detail: 'Token expired' }),
    loadCredentials: () => ({
      token: 'user-jwt',
      refresh_token: 'refresh-jwt',
      email: 'owner@example.com',
    }),
    persistMintedAgentToken: (_credentials, token) => {
      persisted.push(token);
    },
    apiRequestJson: async (pathname, options) => {
      calls.push({ pathname, options });
      if (pathname === '/auth/agent-token') {
        return {
          ok: true,
          status: 200,
          data: { access_token: secret, scopes: ['x-search'], daily_credit_cap: 50 },
        };
      }
      return {
        ok: true,
        status: 200,
        data: { data: { content: 'ok from mint', citations: [] }, credits_used: 5 },
      };
    },
  });

  assert.equal(status, 0);
  assert.equal(calls[0].pathname, '/auth/agent-token');
  assert.equal(calls[0].options.token, 'user-jwt');
  assert.deepEqual(calls[0].options.body.scopes, ['x-search']);
  assert.equal(calls[0].options.body.scopes.includes('youtube'), false);
  assert.equal(calls[1].pathname, '/x-search/search');
  assert.equal(calls[1].options.token, secret);
  assert.deepEqual(persisted, [secret]);
  assert.match(output.join('\n'), /ok from mint/);
  assert.doesNotMatch(output.join('\n'), new RegExp(secret));
  assert.doesNotMatch(output.join('\n'), /\/auth\/cli|Choose login method|Opening browser/);
});

test('xSearchCommand remints after a billed 401 and retries once', async () => {
  const calls = [];
  const secret = 'minted-after-401-secret';
  const cwd = applyWorkspace('agents', true);
  const status = await xSearchCommand(['agents'], {
    cwd,
    applyNow: '2026-08-26',
    output: () => {},
    ensureValidCredentials: async () => ({ credentials: { token: 'user-jwt' } }),
    loadCredentials: () => ({ token: 'user-jwt', refresh_token: 'refresh-jwt' }),
    persistMintedAgentToken: () => {},
    apiRequestJson: async (pathname, options) => {
      calls.push({ pathname, token: options.token, body: options.body });
      if (pathname === '/x-search/search' && options.token === 'user-jwt') {
        return { ok: false, status: 401, error: 'agent token required' };
      }
      if (pathname === '/auth/agent-token') {
        assert.deepEqual(options.body.scopes, ['x-search']);
        return { ok: true, status: 200, data: { access_token: secret, scopes: ['x-search'] } };
      }
      return { ok: true, status: 200, data: { data: { content: 'retried', citations: [] } } };
    },
  });

  assert.equal(status, 0);
  assert.equal(calls[0].pathname, '/x-search/search');
  assert.equal(calls[0].token, 'user-jwt');
  assert.equal(calls[1].pathname, '/auth/agent-token');
  assert.equal(calls[2].pathname, '/x-search/search');
  assert.equal(calls[2].token, secret);
});

test('xSearchCommand with no stored JWT fails in one sentence and stays off the login wall', async () => {
  const output = [];
  let apiCalls = 0;
  const status = await xSearchCommand(['agents'], {
    output: (line) => output.push(line),
    ensureValidCredentials: async () => ({ error: 'not_logged_in' }),
    loadCredentials: () => null,
    apiRequestJson: async () => {
      apiCalls += 1;
      return { ok: true, status: 200, data: {} };
    },
  });
  assert.equal(status, 1);
  assert.equal(apiCalls, 0);
  assert.equal(output.join('\n').trim(), 'not signed in. run atris login first.');
  assert.doesNotMatch(output.join('\n'), /\/auth\/cli|Choose login method|Opening browser|https:\/\//);
});

test('xSearchCommand person posts to research-person', async () => {
  const calls = [];
  const cwd = applyWorkspace('Leah Bonvissuto');
  const status = await xSearchCommand([
    'person',
    '--name',
    'Leah Bonvissuto',
    '--handle',
    'leahbon',
  ], {
    cwd,
    applyNow: '2026-08-26',
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
  assertNoSaveFiles(cwd, 'Leah Bonvissuto');
});

test('x-search person --save refuses thin research text', async () => {
  const cwd = applyWorkspace('Leah Bonvissuto');
  const output = [];
  const status = await xSearchCommand([
    'person',
    '--name',
    'Leah Bonvissuto',
    '--save',
  ], {
    cwd,
    applyNow: '2026-08-26',
    output: (line) => output.push(line),
    ensureValidCredentials: async () => ({ credentials: { token: 't' } }),
    apiRequestJson: async () => ({
      ok: true,
      status: 200,
      data: {
        status: 'success',
        credits_used: 5,
        credits_remaining: 990,
        data: { content: 'just a chat about vibes and feelings', citations: [] },
      },
    }),
  });

  assert.equal(status, 2);
  assert.match(output.join('\n'), /just a chat about vibes/);
  assert.match(output.join('\n'), new RegExp(TEACH_THIN_REFUSE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assertNoSaveFiles(cwd, 'Leah Bonvissuto');
});

test('empty x-search --save still does not owe an apply', async () => {
  const cwd = applyWorkspace('quiet topic');
  const output = [];
  const status = await xSearchCommand(['quiet topic', '--save'], {
    cwd,
    applyNow: '2026-08-26',
    output: (line) => output.push(line),
    ensureValidCredentials: async () => ({ credentials: { token: 't' } }),
    apiRequestJson: async () => ({
      ok: true,
      status: 200,
      data: { status: 'success', credits_used: 0, credits_remaining: 1000, data: { content: '', citations: [] } },
    }),
  });

  assert.equal(status, 2);
  assert.match(output.join('\n'), /no results/);
  assert.doesNotMatch(output.join('\n'), /next: apply /);
  assertNoSaveFiles(cwd, 'quiet topic');
});

test('xSearchCommand missing query exits 2 with usage hint', async () => {
  const output = [];
  const status = await xSearchCommand(['--limit', '3'], {
    output: (line) => output.push(line),
  });
  assert.equal(status, 2);
  assert.match(output.join('\n'), /Missing query/);
});

test('xSearchHasResults is false for empty payloads', () => {
  assert.equal(xSearchHasResults({ data: { content: '', citations: [] } }), false);
  assert.equal(xSearchHasResults({ data: { content: '   ', citations: [] } }), false);
  assert.equal(xSearchHasResults({ status: 'success' }), false);
  assert.equal(xSearchHasResults(successSearchData().data), true);
});

test('x-search without --save stays stdout only', async () => {
  const cwd = applyWorkspace('MCP agents');
  const output = [];
  const status = await xSearchCommand(['MCP agents'], {
    cwd,
    applyNow: '2026-08-26',
    output: (line) => output.push(line),
    ensureValidCredentials: async () => ({ credentials: { token: 't' } }),
    apiRequestJson: async () => successSearchData(),
  });

  assert.equal(status, 0);
  assert.match(output.join('\n'), /MCP agents are shipping/);
  assert.doesNotMatch(output.join('\n'), /next: apply /);
  assert.doesNotMatch(output.join('\n'), new RegExp(TEACH_THIN_REFUSE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assertNoSaveFiles(cwd, 'MCP agents');
});

test('x-search without --save does not rewrite an existing apply', async () => {
  const cwd = applyWorkspace('MCP agents', true);
  const rel = xSearchApplyRel('MCP agents');
  const filled = fs.readFileSync(path.join(cwd, rel), 'utf8');
  const output = [];
  const status = await xSearchCommand(['MCP agents'], {
    cwd,
    applyNow: '2026-08-26',
    output: (line) => output.push(line),
    ensureValidCredentials: async () => ({ credentials: { token: 't' } }),
    apiRequestJson: async () => successSearchData(),
  });

  assert.equal(status, 0);
  assert.doesNotMatch(output.join('\n'), /next: apply /);
  assert.equal(fs.readFileSync(path.join(cwd, rel), 'utf8'), filled);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'logs')), false);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'experiments')), false);
});

test('x-search --save refuses a thin result and writes no atris files', async () => {
  const cwd = applyWorkspace('quiet chat');
  const output = [];
  const status = await xSearchCommand(['quiet chat', '--save'], {
    cwd,
    applyNow: '2026-08-26',
    output: (line) => output.push(line),
    ensureValidCredentials: async () => ({ credentials: { token: 't' } }),
    apiRequestJson: async () => successSearchData(
      'welcome back friends this is just a chat about feelings and vibes',
    ),
  });

  assert.equal(status, 2);
  assert.match(output.join('\n'), /feelings and vibes/);
  assert.match(output.join('\n'), new RegExp(TEACH_THIN_REFUSE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assertNoSaveFiles(cwd, 'quiet chat');
});

test('empty x-search does not owe an apply', async () => {
  const cwd = applyWorkspace('quiet topic');
  const output = [];
  const status = await xSearchCommand(['quiet topic'], {
    cwd,
    applyNow: '2026-08-26',
    output: (line) => output.push(line),
    ensureValidCredentials: async () => ({ credentials: { token: 't' } }),
    apiRequestJson: async () => ({
      ok: true,
      status: 200,
      data: { status: 'success', credits_used: 0, credits_remaining: 1000, data: { content: '', citations: [] } },
    }),
  });

  assert.equal(status, 2);
  assert.doesNotMatch(output.join('\n'), /next: apply /);
  assertNoSaveFiles(cwd, 'quiet topic');
});

test('empty x-search surfaces a server-side refund and does not invent a refund call', async () => {
  const cwd = applyWorkspace('quiet topic');
  const calls = [];
  const output = [];
  const status = await xSearchCommand(['quiet topic'], {
    cwd,
    applyNow: '2026-08-26',
    output: (line) => output.push(line),
    ensureValidCredentials: async () => ({ credentials: { token: 't' } }),
    apiRequestJson: async (pathname, options) => {
      calls.push({ pathname, options });
      return {
        ok: true,
        status: 200,
        data: {
          status: 'success',
          credits_used: 0,
          credits_remaining: 1000,
          credits_refunded: 5,
          data: { content: '', citations: [] },
        },
      };
    },
  });

  assert.equal(status, 2);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].pathname, '/x-search/search');
  assert.doesNotMatch(output.join('\n'), /next: apply /);
  const text = output.join('\n');
  assert.match(text, /no results/);
  assert.match(text, /Credits: 0 used, 1000 remaining/);
  assert.match(text, /credits refunded/);
  assertNoSaveFiles(cwd, 'quiet topic');
});

test('empty citations payload is a refunded empty search', async () => {
  const cwd = applyWorkspace('ghost cites');
  const output = [];
  const status = await xSearchCommand(['ghost cites'], {
    cwd,
    applyNow: '2026-08-26',
    output: (line) => output.push(line),
    ensureValidCredentials: async () => ({ credentials: { token: 't' } }),
    apiRequestJson: async () => ({
      ok: true,
      status: 200,
      data: { credits_used: 0, credits_remaining: 50, data: { citations: [] } },
    }),
  });

  assert.equal(status, 2);
  const text = output.join('\n');
  assert.match(text, /no results/);
  assert.match(text, /credits refunded/);
  assert.doesNotMatch(text, /next: apply /);
  assertNoSaveFiles(cwd, 'ghost cites');
});

test('failed x-search does not owe an apply', async () => {
  const cwd = applyWorkspace('agents');
  const output = [];
  const status = await xSearchCommand(['agents'], {
    cwd,
    applyNow: '2026-08-26',
    output: (line) => output.push(line),
    ensureValidCredentials: async () => ({ credentials: { token: 't' } }),
    apiRequestJson: async () => ({
      ok: false,
      status: 502,
      error: 'Search failed',
    }),
  });

  assert.equal(status, 1);
  assert.doesNotMatch(output.join('\n'), /next: apply /);
  assertNoSaveFiles(cwd, 'agents');
});

test('502 with refunded credits surfaces them and does not invent a refund call', async () => {
  const cwd = applyWorkspace('agents');
  const calls = [];
  const output = [];
  const status = await xSearchCommand(['agents'], {
    cwd,
    applyNow: '2026-08-26',
    output: (line) => output.push(line),
    ensureValidCredentials: async () => ({ credentials: { token: 't' } }),
    apiRequestJson: async (pathname, options) => {
      calls.push({ pathname, options });
      return {
        ok: false,
        status: 502,
        error: 'Search failed',
        data: {
          error: 'Search failed',
          credits_used: 0,
          credits_remaining: 1000,
          credits_refunded: 5,
        },
      };
    },
  });

  assert.equal(status, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].pathname, '/x-search/search');
  assert.doesNotMatch(output.join('\n'), /next: apply /);
  const text = output.join('\n');
  assert.match(text, /502/);
  assert.match(text, /credits refunded/);
  assert.match(text, /Credits: 0 used, 1000 remaining/);
  assertNoSaveFiles(cwd, 'agents');
});
