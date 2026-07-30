const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  browsePacks,
  formatPackBrowseTable,
  formatShareExpiry,
  parsePackShareArgs,
  sanitizePersonalizationName,
  sharePack,
} = require('../commands/pack');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');

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
    cwd: repoRoot,
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
  assert.match(output[1], /public link with no expiry/);
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
    'every outstanding link is now dead. sharing again mints fresh links.',
  ]);
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
