const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  browsePacks,
  formatPackShareLinksTable,
  formatPackSalesTable,
  formatPackBrowseTable,
  formatSalesDollars,
  formatShareExpiry,
  packSalesUrl,
  parsePackShareArgs,
  sanitizePersonalizationName,
  sharePack,
  showPackSales,
} = require('../commands/pack');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');

// Spawn the CLI from a temp dir, never the repo root: a repo-root cwd makes
// the CLI mutate the checkout's own .atris/state during the suite (CLI-1241).
const scratchCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-pack-share-test-'));
test.after(() => fs.rmSync(scratchCwd, { recursive: true, force: true }));
const shareNonce = 'AbCdEfGhIjKlMnOpQrStUv';
const revokedNonce = 'ZYXWVUTSRQPONMLKJIHGFE';

function jsonResponse(status, value) {
  return {
    status,
    body: Buffer.from(JSON.stringify(value)),
  };
}

function registryDeps(httpRequest, token = 'test-token') {
  return {
    getAppBaseUrl: () => 'https://packs.example.com',
    loadCredentials: () => (token ? { token } : null),
    httpRequest,
  };
}

test('pack share without --for keeps the plain public pack link', () => {
  const result = spawnSync(process.execPath, [cliPath, 'pack', 'share', 'design-brain'], {
    cwd: scratchCwd,
    encoding: 'utf8',
    timeout: 20000,
    env: {
      ...process.env,
      ATRIS_SKIP_UPDATE_CHECK: '1',
      ATRIS_APP_URL: 'https://packs.example.com',
    },
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  const lines = result.stdout.trim().split('\n');
  assert.equal(lines[0], 'https://packs.example.com/packs/design-brain');
  assert.match(lines[1], /atris pack share design-brain --for "<Name>"/);
});

test('pack share mints a signed link with auth, origin, recipient, and expiry', async () => {
  const calls = [];
  const output = [];
  const deps = registryDeps(async (url, options) => {
    calls.push({ url, options });
    return jsonResponse(200, {
      shareUrl: 'https://packs.example.com/share/signed-token',
      expiresAt: 1782864000,
      nonce: shareNonce,
    });
  });

  const result = await sharePack(
    ['design-brain', '--for', 'Ada Lovelace', '--days', '7'],
    repoRoot,
    { deps, print: (line) => output.push(line) },
  );

  assert.equal(result, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://packs.example.com/api/pack/registry/design-brain/share');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer test-token');
  assert.equal(calls[0].options.headers.Origin, 'https://packs.example.com');
  assert.equal(calls[0].options.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    recipientLabel: 'Ada Lovelace',
    expiresInDays: 7,
  });
  assert.deepEqual(output, [
    'https://packs.example.com/share/signed-token',
    `take this one back later with: atris pack share design-brain --revoke ${shareNonce}`,
    `expires at ${formatShareExpiry(1782864000)}`,
  ]);
});

test('pack share sends the full signed recipient label instead of legacy sanitizing it', async () => {
  const calls = [];
  const deps = registryDeps(async (url, options) => {
    calls.push({ url, options });
    return jsonResponse(200, {
      shareUrl: 'https://packs.example.com/share/team-token',
      expiresAt: 1782864000,
    });
  });

  await sharePack(
    ['design-brain', '--for', 'Design & Ops 2'],
    repoRoot,
    { deps, print: () => {} },
  );

  assert.deepEqual(JSON.parse(calls[0].options.body), {
    recipientLabel: 'Design & Ops 2',
    expiresInDays: 30,
  });
});

test('pack share falls back to ?for only after minting fails for a public pack', async () => {
  const calls = [];
  const output = [];
  const deps = registryDeps(async (url, options) => {
    calls.push({ url, options });
    if (options.method === 'POST') return jsonResponse(503, { error: 'mint unavailable' });
    return jsonResponse(200, {
      packs: [{ slug: 'design-brain', title: 'Design Brain', version: '1.0.0', visibility: 'public' }],
    });
  });

  const result = await sharePack(
    ['design-brain', '--for', 'Ada Lovelace'],
    repoRoot,
    { deps, print: (line) => output.push(line) },
  );

  assert.equal(result, 0);
  assert.deepEqual(calls.map((call) => call.options.method), ['POST', 'GET']);
  assert.equal(output[0], 'https://packs.example.com/packs/design-brain?for=Ada%20Lovelace');
  assert.match(output[1], /personal link with no expiry/);
});

test('pack share does not fall back for an unlisted or private pack', async () => {
  const deps = registryDeps(async (url, options) => {
    if (options.method === 'POST') return jsonResponse(503, { error: 'mint unavailable' });
    return jsonResponse(200, {
      packs: [{ slug: 'design-brain', visibility: 'unlisted' }],
    });
  });

  await assert.rejects(
    () => sharePack(['design-brain', '--for', 'Ada Lovelace'], repoRoot, { deps, print: () => {} }),
    /mint unavailable/,
  );
});

test('pack share can use the public fallback when credentials are missing', async () => {
  const calls = [];
  const output = [];
  const deps = registryDeps(async (url, options) => {
    calls.push({ url, options });
    return jsonResponse(200, {
      packs: [{ slug: 'legacy-public', title: 'Legacy Public', version: '1.0.0' }],
    });
  }, null);

  const result = await sharePack(
    ['legacy-public', '--for', 'Ada Lovelace'],
    repoRoot,
    { deps, print: (line) => output.push(line) },
  );

  assert.equal(result, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.method, 'GET');
  assert.match(output[0], /\?for=Ada%20Lovelace$/);
});

test('pack share --revoke deletes all signed links with auth and origin', async () => {
  const calls = [];
  const output = [];
  const deps = registryDeps(async (url, options) => {
    calls.push({ url, options });
    return jsonResponse(200, { ok: true, version: '1.0.1', shareEpoch: 2 });
  });

  const result = await sharePack(
    ['design-brain', '--revoke'],
    repoRoot,
    { deps, print: (line) => output.push(line) },
  );

  assert.equal(result, 0);
  assert.equal(calls[0].url, 'https://packs.example.com/api/pack/registry/design-brain/share');
  assert.equal(calls[0].options.method, 'DELETE');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer test-token');
  assert.equal(calls[0].options.headers.Origin, 'https://packs.example.com');
  assert.equal(calls[0].options.body, undefined);
  assert.deepEqual(output, [
    'every outstanding personal link is now dead. sharing again mints fresh personal links.',
  ]);
});

test('pack share --list renders active and revoked links with their ids', async () => {
  const calls = [];
  const output = [];
  const links = [
    {
      nonce: shareNonce,
      label: 'Ada Lovelace',
      issuedAt: 1780272000,
      expiresAt: 1782864000,
      revoked: false,
    },
    {
      nonce: revokedNonce,
      label: 'Design Ops',
      issuedAt: '2026-06-01T00:00:00.000Z',
      expiresAt: '2026-08-01T00:00:00.000Z',
      revoked: true,
    },
  ];
  const deps = registryDeps(async (url, options) => {
    calls.push({ url, options });
    return jsonResponse(200, { links });
  });

  const result = await sharePack(
    ['design-brain', '--list'],
    repoRoot,
    { deps, print: (line) => output.push(line) },
  );

  assert.equal(result, 0);
  assert.equal(calls[0].url, 'https://packs.example.com/api/pack/registry/design-brain/share');
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer test-token');
  assert.equal(calls[0].options.body, undefined);
  assert.deepEqual(output, [formatPackShareLinksTable(links)]);
  assert.match(output[0], /^label\s+expires\s+state\s+nonce/m);
  assert.match(output[0], new RegExp(`Ada Lovelace\\s+.*active\\s+${shareNonce}`));
  assert.match(output[0], new RegExp(`Design Ops\\s+.*revoked\\s+${revokedNonce}`));
});

test('pack share --list prints one sentence when no links remain', async () => {
  const output = [];
  const deps = registryDeps(async () => jsonResponse(200, { links: [] }));

  const result = await sharePack(
    ['design-brain', '--list'],
    repoRoot,
    { deps, print: (line) => output.push(line) },
  );

  assert.equal(result, 0);
  assert.deepEqual(output, ['no personal links minted for this pack.']);
});

test('pack share --revoke with an id deletes only that link', async () => {
  const calls = [];
  const output = [];
  const deps = registryDeps(async (url, options) => {
    calls.push({ url, options });
    return jsonResponse(200, {
      ok: true,
      nonce: shareNonce,
      revoked: true,
      version: '1.0.1',
    });
  });

  const result = await sharePack(
    ['design-brain', '--revoke', shareNonce],
    repoRoot,
    { deps, print: (line) => output.push(line) },
  );

  assert.equal(result, 0);
  assert.equal(calls[0].url, 'https://packs.example.com/api/pack/registry/design-brain/share');
  assert.equal(calls[0].options.method, 'DELETE');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer test-token');
  assert.equal(calls[0].options.headers.Origin, 'https://packs.example.com');
  assert.deepEqual(JSON.parse(calls[0].options.body), { nonce: shareNonce });
  assert.deepEqual(output, ['that personal link is now dead. other personal links keep working.']);
});

test('pack share --revoke with an unknown id points to the link list', async () => {
  const deps = registryDeps(async () => jsonResponse(404, {
    error: 'Share link not found.',
  }));

  await assert.rejects(
    () => sharePack(
      ['design-brain', '--revoke', shareNonce],
      repoRoot,
      { deps, print: () => {} },
    ),
    /no personal link found with that id\. run: atris pack share design-brain --list/,
  );
});

test('pack share argument parsing validates days and revoke combinations', () => {
  assert.deepEqual(
    parsePackShareArgs(['design-brain', '--for', 'Ada', '--days', '90']),
    {
      mode: 'mint',
      slug: 'design-brain',
      recipientLabel: 'Ada',
      expiresInDays: 90,
    },
  );
  assert.deepEqual(
    parsePackShareArgs(['design-brain', '--list']),
    { mode: 'list', slug: 'design-brain' },
  );
  assert.deepEqual(
    parsePackShareArgs(['design-brain', '--revoke']),
    { mode: 'revoke', slug: 'design-brain' },
  );
  assert.deepEqual(
    parsePackShareArgs(['design-brain', '--revoke', shareNonce]),
    { mode: 'revoke', slug: 'design-brain', nonce: shareNonce },
  );
  assert.throws(
    () => parsePackShareArgs(['design-brain', '--for', 'Ada', '--days', '0']),
    /whole number from 1 to 365/,
  );
  assert.throws(
    () => parsePackShareArgs(['design-brain', '--revoke', '--for', 'Ada']),
    /cannot be combined/,
  );
  assert.throws(
    () => parsePackShareArgs(['design-brain', '--days', '30']),
    /requires --for/,
  );
  assert.throws(
    () => parsePackShareArgs(['design-brain', '--revoke', 'too-short']),
    /22-character base64url/,
  );
  assert.throws(
    () => parsePackShareArgs(['design-brain', '--list', '--for', 'Ada']),
    /--list cannot be combined/,
  );
  assert.throws(
    () => parsePackShareArgs(['design-brain', '--list', '--days', '30']),
    /--list cannot be combined/,
  );
  assert.throws(
    () => parsePackShareArgs(['design-brain', '--list', '--revoke', shareNonce]),
    /--list cannot be combined/,
  );
});

test('pack share rejects a slug the web viewer cannot render', () => {
  assert.throws(
    () => parsePackShareArgs(['ab', '--for', 'Ada Lovelace']),
    /is not viewable on the web/,
  );
});

test('pack share needs a slug', () => {
  assert.throws(
    () => parsePackShareArgs(['--for', 'Ada Lovelace']),
    /pack share needs a slug/,
  );
});

test('legacy personalization sanitizer still mirrors the public page fallback', () => {
  assert.equal(sanitizePersonalizationName('Ada Lovelace'), 'Ada Lovelace');
  assert.equal(sanitizePersonalizationName('  Ada   Lovelace  '), 'Ada Lovelace');
  assert.equal(sanitizePersonalizationName("O'Brien-Smith Jr."), "O'Brien-Smith Jr.");
  assert.equal(sanitizePersonalizationName('Ada 3000'), 'Ada');
  assert.equal(sanitizePersonalizationName('A'.repeat(50)).length, 40);
  assert.equal(sanitizePersonalizationName('<b>Ada</b>'), null);
  assert.equal(sanitizePersonalizationName('Bob & Alice'), null);
  assert.equal(sanitizePersonalizationName('a\\b'), null);
  assert.equal(sanitizePersonalizationName('123'), null);
  assert.equal(sanitizePersonalizationName(''), null);
  assert.equal(sanitizePersonalizationName(undefined), null);
});

test('pack browse fetches the public registry and includes stars when supplied', async () => {
  const calls = [];
  const output = [];
  const deps = registryDeps(async (url, options) => {
    calls.push({ url, options });
    return jsonResponse(200, {
      packs: [
        { slug: 'alpha-pack', title: 'Alpha Pack', version: '1.2.0' },
        { slug: 'beta-pack', title: 'Beta Pack', version: '2.0.0' },
      ],
      stars: {
        'alpha-pack': { count: 4 },
      },
    });
  });

  const result = await browsePacks([], repoRoot, {
    deps,
    print: (line) => output.push(line),
  });

  assert.equal(result, 0);
  assert.equal(calls[0].url, 'https://packs.example.com/api/pack/registry');
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(calls[0].options.headers.Authorization, undefined);
  assert.match(output[0], /^slug\s+title\s+version\s+stars/m);
  assert.match(output[0], /alpha-pack\s+Alpha Pack\s+1\.2\.0\s+4/);
  assert.doesNotMatch(output[0], /visibility/);
  assert.equal(output[1], 'install with: atris pack install alpha-pack');
});

test('pack browse --mine sends auth and shows legacy visibility as public', async () => {
  const calls = [];
  const output = [];
  const deps = registryDeps(async (url, options) => {
    calls.push({ url, options });
    return jsonResponse(200, {
      packs: [
        { slug: 'private-pack', title: 'Private Pack', version: '1.0.0', visibility: 'private' },
        { slug: 'legacy-pack', title: 'Legacy Pack', version: '0.4.0' },
      ],
    });
  });

  await browsePacks(['--mine'], repoRoot, {
    deps,
    print: (line) => output.push(line),
  });

  assert.equal(calls[0].url, 'https://packs.example.com/api/pack/registry?scope=mine');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer test-token');
  assert.match(output[0], /^slug\s+title\s+version\s+visibility/m);
  assert.match(output[0], /private-pack\s+Private Pack\s+1\.0\.0\s+private/);
  assert.match(output[0], /legacy-pack\s+Legacy Pack\s+0\.4\.0\s+public/);
});

test('pack browse table caps output at 50 rows with no pagination', () => {
  const payload = {
    packs: Array.from({ length: 55 }, (_, index) => ({
      slug: `pack-${String(index).padStart(2, '0')}`,
      title: `Pack ${index}`,
      version: '1.0.0',
    })),
  };

  const table = formatPackBrowseTable(payload);
  const lines = table.split('\n');
  assert.equal(lines.length, 51);
  assert.match(lines[50], /pack-49/);
  assert.doesNotMatch(table, /pack-50/);
});

test('pack sales formats cents as compact dollar amounts', () => {
  assert.equal(formatSalesDollars(1200), '$12');
  assert.equal(formatSalesDollars(1250), '$12.50');
  assert.equal(formatSalesDollars(99), '$0.99');
  assert.equal(formatSalesDollars(1234567), '$12,345.67');
});

test('pack sales builds its backend URL without a doubled slash', () => {
  assert.equal(
    packSalesUrl('https://api.example.com/api/'),
    'https://api.example.com/api/pack/purchases/sales',
  );
});

test('pack sales table shows pack, masked buyer, dollar price, and short date', () => {
  const table = formatPackSalesTable([
    {
      slug: 'design-brain',
      buyer: 'a***@example.com',
      price_cents: 1200,
      granted_at: '2026-07-30T19:45:00Z',
    },
    {
      slug: 'sales-playbook',
      buyer: 'b***@example.com',
      price_cents: 250,
      granted_at: '2026-07-29T08:00:00Z',
    },
  ]);

  assert.match(table, /^pack\s+buyer\s+price\s+date/m);
  assert.match(table, /design-brain\s+a\*\*\*@example\.com\s+\$12\s+Jul 30/);
  assert.match(table, /sales-playbook\s+b\*\*\*@example\.com\s+\$2\.50\s+Jul 29/);
});

test('pack sales fetches with bearer auth and prints total before the table', async () => {
  const calls = [];
  const output = [];
  const deps = {
    getApiBaseUrl: () => 'https://api.example.com/api',
    loadCredentials: () => ({ token: 'seller-token' }),
    httpRequest: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse(200, [
        { slug: 'alpha-pack', buyer: 'a***@mail.com', price_cents: 500, granted_at: '2026-07-30T10:00:00Z' },
        { slug: 'beta-pack', buyer: 'b***@mail.com', price_cents: 650, granted_at: '2026-07-29T10:00:00Z' },
        { slug: 'tiny-pack', buyer: 'c***@mail.com', price_cents: 50, granted_at: '2026-07-28T10:00:00Z' },
      ]);
    },
  };

  const result = await showPackSales([], repoRoot, {
    deps,
    print: (line) => output.push(line),
  });

  assert.equal(result, 0);
  assert.equal(calls[0].url, 'https://api.example.com/api/pack/purchases/sales');
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer seller-token');
  assert.equal(output[0], '$12 earned across 3 sales.');
  assert.match(output[1], /^pack\s+buyer\s+price\s+date/m);
});

test('pack sales prints the exact zero state and pricing nudge', async () => {
  const output = [];
  const result = await showPackSales([], repoRoot, {
    deps: {
      getApiBaseUrl: () => 'https://api.example.com/api',
      loadCredentials: () => ({ token: 'seller-token' }),
      httpRequest: async () => jsonResponse(200, []),
    },
    print: (line) => output.push(line),
  });

  assert.equal(result, 0);
  assert.deepEqual(output, [
    'No sales yet.',
    'set priceCents in pack.json, then run: atris pack publish --visibility public --push',
  ]);
});

test('pack sales gives the same login nudge for missing auth and a 401', async () => {
  const expected = 'not logged in. run atris login first to view pack sales.';
  await assert.rejects(
    () => showPackSales([], repoRoot, {
      deps: { loadCredentials: () => null },
      print: () => {},
    }),
    (error) => error.message === expected,
  );
  await assert.rejects(
    () => showPackSales([], repoRoot, {
      deps: {
        getApiBaseUrl: () => 'https://api.example.com/api',
        loadCredentials: () => ({ token: 'expired-token' }),
        httpRequest: async () => jsonResponse(401, { error: 'expired' }),
      },
      print: () => {},
    }),
    (error) => error.message === expected,
  );
});

test('pack help lists sales with share and browse', () => {
  const result = spawnSync(process.execPath, [cliPath, 'pack', '--help'], {
    cwd: scratchCwd,
    encoding: 'utf8',
    timeout: 20000,
    env: {
      ...process.env,
      ATRIS_SKIP_UPDATE_CHECK: '1',
    },
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.match(result.stdout, /atris pack share/);
  assert.match(result.stdout, /atris pack browse/);
  assert.match(result.stdout, /atris pack sales/);
});
