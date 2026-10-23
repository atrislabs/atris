'use strict';

const { describe, test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-design-command-'));
const savedEnv = {};
for (const name of [
  'HOME',
  'ATRIS_API_KEY',
  'ATRIS_TOKEN',
  'ATRIS_PROFILE',
  'ATRIS_CLIENT_ID',
  'ATRIS_CLIENT_SECRET',
  'ATRIS_CLIENT_SECRET_FILE',
  'ATRIS_AGENT_TOKEN_FILE',
  'ATRIS_DESIGN_POLL_MS',
  'ATRIS_DESIGN_TIMEOUT_MS',
]) {
  savedEnv[name] = process.env[name];
  if (name === 'HOME') process.env.HOME = home;
  else delete process.env[name];
}

const { run } = require('../commands/design');

after(() => {
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  fs.rmSync(home, { recursive: true, force: true });
});

function quietIo() {
  return { tty: false, write() {} };
}

function captureConsole(fn) {
  const lines = [];
  const log = console.log;
  console.log = (...args) => lines.push(args.map(String).join(' '));
  return Promise.resolve()
    .then(fn)
    .finally(() => { console.log = log; })
    .then((code) => ({ code, text: lines.join('\n') }));
}

describe('atris design command', { concurrency: false }, () => {
  test('help lists the three subcommands and a bare call exits 1', async () => {
    const bare = await captureConsole(() => run([]));
    assert.strictEqual(bare.code, 1);
    assert.match(bare.text, /usage: atris design extract <url>/);
    assert.match(bare.text, /atris design check <url> --against <brand-url>/);
    assert.match(bare.text, /atris design search "<words>"/);
    assert.match(bare.text, /pull a site's design system/);

    const helped = await captureConsole(() => run(['--help']));
    assert.strictEqual(helped.code, 0);
    assert.strictEqual(helped.text, bare.text);

    const short = await captureConsole(() => run(['-h']));
    assert.strictEqual(short.code, 0);
    const word = await captureConsole(() => run(['help']));
    assert.strictEqual(word.code, 0);
    assert.strictEqual(word.text, bare.text);
  });

  test('unknown subcommands and a missing key stop before any request', async () => {
    const calls = [];
    const err = [];
    const request = async () => {
      calls.push('request');
      return { ok: true, status: 200, data: {} };
    };
    const deps = {
      key: 'test-key',
      io: quietIo(),
      request,
      err: (line) => err.push(line),
      out: () => {},
    };

    const unknown = await captureConsole(() => run(['paint'], deps));
    assert.strictEqual(unknown.code, 1);
    assert.deepStrictEqual(err, ['unknown design subcommand: paint']);
    assert.match(unknown.text, /usage: atris design extract/);
    assert.deepStrictEqual(calls, []);

    err.length = 0;
    const missing = await run(['extract', 'https://example.com'], { ...deps, key: null });
    assert.strictEqual(missing, 1);
    assert.match(err.join('\n'), /no api key found\. set ATRIS_API_KEY or run: atris login/);
    assert.deepStrictEqual(calls, []);
  });

  test('extract, check, and search reject bad arguments before any request', async () => {
    const calls = [];
    const err = [];
    const deps = {
      key: 'test-key',
      io: quietIo(),
      request: async () => {
        calls.push('request');
        return { ok: false, status: 500, error: 'should not run' };
      },
      err: (line) => err.push(line),
      out: () => {},
    };

    assert.strictEqual(await run(['extract'], deps), 1);
    assert.strictEqual(await run(['extract', '--sections'], deps), 1);
    assert.strictEqual(await run(['extract', 'https://example.com', '--nope'], deps), 1);
    assert.strictEqual(await run(['check', 'https://example.com'], deps), 1);
    assert.strictEqual(await run(['check', 'https://example.com', '--against'], deps), 1);
    assert.strictEqual(await run(['search'], deps), 1);
    assert.strictEqual(await run(['search', 'tools', '--limit'], deps), 1);
    assert.strictEqual(await run(['search', 'tools', '--limit', '0'], deps), 1);
    assert.strictEqual(await run(['search', 'tools', '--limit', 'nope'], deps), 1);

    assert.deepStrictEqual(calls, []);
    assert.deepStrictEqual(err, [
      'usage: atris design extract <url> [--json] [--sections colors,typography]',
      '--sections needs a value',
      'unknown flag for design extract: --nope',
      'usage: atris design check <url> --against <brand-url> [--json]',
      '--against needs a value',
      'usage: atris design search "<words>" [--limit n] [--json]',
      '--limit needs a value',
      'invalid --limit value: "0". expected a positive integer.',
      'invalid --limit value: "nope". expected a positive integer.',
    ]);
  });

  test('extract normalizes the url, polls once, and prints the card', async () => {
    const calls = [];
    const out = [];
    const job = {
      id: 'job-1',
      status: 'completed',
      source_url: 'https://stripe.com',
      result: {
        design_system: {
          profile: { brand_name: 'Stripe', one_line_positioning: 'payments for the internet' },
          colors: {
            primary: '#635bff',
            secondary: '#00d4ff',
            accent: '#635bff',
            palette: ['#111111', { hex: '#635bff' }, { hex: '#222222' }],
          },
          typography: {
            heading: 'Sohne',
            body: { family: 'Inter' },
          },
        },
      },
      atris: { credits_charged: 3, balance_remaining_usd: 1.5 },
    };
    const code = await run(['extract', 'stripe.com', '--sections', 'colors,typography'], {
      key: 'test-key',
      io: quietIo(),
      sleep: async () => {},
      pollMs: 1,
      maxWaitMs: 1000,
      out: (line) => out.push(line),
      err: (line) => { throw new Error(line); },
      request: async (pathname, options) => {
        calls.push({ pathname, method: options.method || 'GET', body: options.body, key: options.key });
        if (calls.length === 1) return { ok: true, status: 202, data: { id: 'job-1', status: 'running' } };
        return { ok: true, status: 200, data: job };
      },
    });

    assert.strictEqual(code, 0);
    assert.deepStrictEqual(calls, [
      {
        pathname: '/design/extractions',
        method: 'POST',
        body: { url: 'https://stripe.com', sections: 'colors,typography' },
        key: 'test-key',
      },
      {
        pathname: '/design/extractions/job-1?sections=colors%2Ctypography',
        method: 'GET',
        body: undefined,
        key: 'test-key',
      },
    ]);
    assert.strictEqual(out.join(''), [
      '',
      '  Stripe',
      '  https://stripe.com',
      '',
      '  colors    #635bff #00d4ff #111111 #222222',
      '  heading   Sohne',
      '  body      Inter',
      '  line      payments for the internet',
      '',
      '  3 credits charged. $1.50 left.',
      '',
    ].join('\n'));
  });

  test('extract --json returns the job and a non-completed job exits 1', async () => {
    const failed = { id: 'job-9', status: 'failed', error: 'render broke' };
    const out = [];
    const code = await run(['extract', 'https://example.com', '--json'], {
      key: 'test-key',
      io: quietIo(),
      out: (line) => out.push(line),
      err: () => {},
      request: async () => ({ ok: true, status: 200, data: failed }),
    });
    assert.strictEqual(code, 1);
    assert.strictEqual(out.join(''), JSON.stringify(failed, null, 2));
  });

  test('extract reports an api error, a failed poll, and a timed out job', async () => {
    const err = [];
    const base = {
      key: 'test-key',
      io: quietIo(),
      sleep: async () => {},
      pollMs: 1,
      maxWaitMs: 1000,
      out: () => {},
      err: (line) => err.push(line),
    };

    assert.strictEqual(await run(['extract', 'https://example.com'], {
      ...base,
      request: async () => ({ ok: false, status: 401, error: 'invalid api key' }),
    }), 1);

    let polls = 0;
    assert.strictEqual(await run(['extract', 'https://example.com'], {
      ...base,
      request: async (pathname) => {
        if (pathname === '/design/extractions') {
          return { ok: true, status: 202, data: { id: 'job-5', status: 'queued' } };
        }
        polls += 1;
        return { ok: false, status: 500, error: 'boom' };
      },
    }), 1);
    assert.strictEqual(polls, 3);

    assert.strictEqual(await run(['extract', 'https://example.com'], {
      ...base,
      maxWaitMs: 0,
      request: async (pathname) => {
        if (pathname === '/design/extractions') {
          return { ok: true, status: 202, data: { id: 'job-4', status: 'running' } };
        }
        return { ok: true, status: 200, data: { id: 'job-4', status: 'running' } };
      },
    }), 1);

    assert.deepStrictEqual(err, [
      'design extract failed (401): invalid api key',
      'extraction did not finish: boom',
      'still running after 0s. job id: job-4',
    ]);
  });

  test('check posts both urls and prints the score card', async () => {
    const calls = [];
    const out = [];
    const job = {
      id: 'job-2',
      status: 'completed',
      source_url: 'https://example.com',
      reference_url: 'https://brand.test',
      result: {
        score: 0.8,
        fixes: [{ title: 'use the purple' }, 'tighten type'],
        recommendations: [],
      },
      atris: { credits_charged: 2, balance_remaining_usd: 4 },
    };
    const code = await run(['check', 'example.com', '--against=brand.test'], {
      key: 'test-key',
      io: quietIo(),
      sleep: async () => {},
      pollMs: 1,
      maxWaitMs: 1000,
      out: (line) => out.push(line),
      err: (line) => { throw new Error(line); },
      request: async (pathname, options) => {
        calls.push({ pathname, body: options.body, key: options.key });
        if (pathname === '/design/adherence') {
          return { ok: true, status: 202, data: { id: 'job-2', status: 'running' } };
        }
        return { ok: true, status: 200, data: job };
      },
    });

    assert.strictEqual(code, 0);
    assert.deepStrictEqual(calls[0], {
      pathname: '/design/adherence',
      body: { source_url: 'https://example.com', reference_url: 'https://brand.test' },
      key: 'test-key',
    });
    assert.strictEqual(calls[1].pathname, '/design/adherence/job-2');
    assert.strictEqual(out.join(''), [
      '',
      '  score     0.80',
      '  source    https://example.com',
      '  against   https://brand.test',
      '',
      '  fixes:',
      '   - use the purple',
      '   - tighten type',
      '',
      '  2 credits charged. $4.00 left.',
      '',
    ].join('\n'));
  });

  test('search joins the words, sends the limit, and prints one result', async () => {
    const data = {
      results: [
        { brand_name: 'Stripe', source_url: 'https://stripe.com', palette: ['#635bff', '#fff'] },
      ],
      atris: { credits_charged: 1, balance_remaining_usd: 9 },
    };
    let seen;
    const out = [];
    const code = await run(['search', 'developer', 'tools', '--limit=2'], {
      key: 'test-key',
      io: quietIo(),
      out: (line) => out.push(line),
      err: (line) => { throw new Error(line); },
      request: async (pathname, options) => {
        seen = { pathname, method: options.method, body: options.body, key: options.key };
        return { ok: true, status: 200, data };
      },
    });

    assert.strictEqual(code, 0);
    assert.deepStrictEqual(seen, {
      pathname: '/design/search',
      method: 'POST',
      body: { query: 'developer tools', limit: 2 },
      key: 'test-key',
    });
    assert.strictEqual(out.join(''), [
      '',
      '  1 result for "developer tools"',
      '',
      '  Stripe  https://stripe.com',
      '    #635bff #fff',
      '',
      '  1 credit charged. $9.00 left.',
      '',
    ].join('\n'));
  });

  test('a thrown request becomes one plain failure line', async () => {
    const err = [];
    const code = await run(['search', 'tools'], {
      key: 'test-key',
      io: quietIo(),
      err: (line) => err.push(line),
      out: () => {},
      request: async () => { throw new Error('socket down'); },
    });
    assert.strictEqual(code, 1);
    assert.deepStrictEqual(err, ['design search failed: socket down']);
  });

  test('the env key wins, then the login token, then the key file in home', async () => {
    const keyFile = path.join(home, '.atris', 'design-api-key');
    fs.mkdirSync(path.dirname(keyFile), { recursive: true });
    fs.writeFileSync(keyFile, '  from-file  \n');

    async function searchKey(extraEnv) {
      let seen;
      const prev = process.env.ATRIS_API_KEY;
      if (extraEnv === undefined) delete process.env.ATRIS_API_KEY;
      else process.env.ATRIS_API_KEY = extraEnv;
      try {
        const code = await run(['search', 'quiet'], {
          loadCredentials: () => ({ token: ' login-token ' }),
          io: quietIo(),
          pollMs: 1,
          maxWaitMs: 20,
          sleep: async () => {},
          out: () => {},
          err: (line) => { throw new Error(line); },
          request: async (pathname, options) => {
            seen = { pathname, key: options.key };
            return { ok: true, status: 200, data: { results: [] } };
          },
        });
        assert.strictEqual(code, 0);
        return seen;
      } finally {
        if (prev === undefined) delete process.env.ATRIS_API_KEY;
        else process.env.ATRIS_API_KEY = prev;
      }
    }

    assert.deepStrictEqual(await searchKey('  env-key  '), {
      pathname: '/design/search',
      key: 'env-key',
    });

    delete process.env.ATRIS_API_KEY;
    let fromLogin;
    const loginCode = await run(['search', 'quiet'], {
      loadCredentials: () => ({ token: ' login-token ' }),
      io: quietIo(),
      out: () => {},
      err: (line) => { throw new Error(line); },
      request: async (pathname, options) => {
        fromLogin = { pathname, key: options.key };
        return { ok: true, status: 200, data: { results: [] } };
      },
    });
    assert.strictEqual(loginCode, 0);
    assert.deepStrictEqual(fromLogin, { pathname: '/design/search', key: 'login-token' });

    let fromFile;
    const fileCode = await run(['search', 'quiet'], {
      loadCredentials: () => null,
      io: quietIo(),
      out: () => {},
      err: (line) => { throw new Error(line); },
      request: async (pathname, options) => {
        fromFile = { pathname, key: options.key };
        return { ok: true, status: 200, data: { results: [] } };
      },
    });
    assert.strictEqual(fileCode, 0);
    assert.deepStrictEqual(fromFile, { pathname: '/design/search', key: 'from-file' });
  });
});
