'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const { memoryLiveCommand } = require('../commands/memory-live');
const { isPlainQuestion, mixHits, rankLocal } = require('../lib/memory-local-rank');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-local-rank-'));
}

function writeIndex(dir, {
  format = 'calibrated-multiview-maxsim-v2',
  model = 'fake-embed:1',
  dim = 4,
  items = [],
  vectors = [],
  bias = [],
  bm25 = undefined,
} = {}) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ format, model, dim, items }));
  const vArr = new Float32Array(vectors);
  fs.writeFileSync(path.join(dir, 'vectors.f32'), Buffer.from(vArr.buffer));
  const bArr = new Float32Array(bias);
  fs.writeFileSync(path.join(dir, 'bias.f32'), Buffer.from(bArr.buffer));
  if (bm25 !== undefined) {
    fs.writeFileSync(path.join(dir, 'bm25.json'), JSON.stringify(bm25));
  }
}

function fakeGrepServer(response, { fail = null } = {}) {
  const calls = [];
  const request = async (pathname, options = {}) => {
    calls.push({ pathname, options });
    if (fail) return fail;
    return { ok: true, status: 200, data: structuredClone(response) };
  };
  return { calls, request };
}

function runSearch(args, server, extra = {}) {
  const out = [];
  const errs = [];
  return memoryLiveCommand(['search', ...args], {
    log: (line) => out.push(line),
    err: (line) => errs.push(line),
    apiRequestJson: server && server.request,
    getAuth: async () => ({ token: 'tok-1', scoped: false }),
    env: {},
    ...extra,
  }).then((code) => ({ code, text: out.join('\n'), errs: errs.join('\n') }));
}

function startFakeOllama(handler) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;
      seen.push({ method: req.method, url: req.url, body });
      handler(req, res, body);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        seen,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

test('mixing order matches hand-worked RRF (k=10), keeps server keys, tags local-only hits, and applies BM25 + rule dedup', async () => {
  const dir = tmpDir();
  try {
    // Question vector after unit normalization will be [1, 0, 0, 0].
    // Hand-worked local scores = vec . q + bias + 0.35 * bm25:
    //   0: wiki/tea.md:1       (line)  dot=0.90, bias=0.20, bm25=0 -> 1.10  -> local #1 (RRF 1/11)
    //   1: wiki/bike.md:4      (line)  dot=0.50, bias=0.00, bm25>0 -> ~0.95 -> local #2 (RRF 1/12)
    //   2: wiki/garden.md:2    (line)  dot=0.40, bias=0.00, bm25=0 -> 0.40  (loses to rule at same loc)
    //   3: wiki/garden.md:2    (rule)  dot=0.70, bias=0.10, bm25=0 -> 0.80  -> local #3 (RRF 1/13)
    //   4: files/ledger.json:1 (line)  dot=5.00, bias=1.00, bm25=0 -> 6.00  (raw data: skipped unless --all-files)
    const items = [
      { path: 'wiki/tea.md', n: 1, text: 'prefers oolong in the morning', kind: 'line' },
      { path: 'wiki/bike.md', n: 4, text: 'chain oil sits on the shelf', kind: 'line' },
      { path: 'wiki/garden.md', n: 2, text: 'water tomatoes at dusk', kind: 'line' },
      { path: 'wiki/garden.md', n: 2, text: 'always water tomatoes at dusk', kind: 'rule' },
      { path: 'files/ledger.json', n: 1, text: '{"item":"teapot","price":40}', kind: 'line' },
    ];
    const vectors = [
      0.9, 0, 0, 0,
      0.5, 0, 0, 0,
      0.4, 0, 0, 0,
      0.7, 0, 0, 0,
      5.0, 0, 0, 0,
    ];
    const bias = [0.2, 0.0, 0.0, 0.1, 1.0];
    // Give "chain" (stemmed from "chains") high IDF on item 1 so BM25 lifts bike above garden rule (0.80).
    const bm25 = {
      k1: 1.2,
      b: 0.75,
      avgdl: 4,
      dl: [4, 4, 4, 4, 4],
      idf: { chain: 2.0 },
      postings: { chain: [1, 1] },
    };
    writeIndex(dir, { items, vectors, bias, bm25 });

    // Server hits:
    //   #1 wiki/notes.md:7 (server only -> RRF 1/11 = 0.0909)
    //   #2 wiki/shelf.md:3 (server only -> RRF 1/12 = 0.0833)
    //   #3 wiki/bike.md:4  (server #3 + local #2 -> 1/13 + 1/12 = 0.1603 -> MUST BE #1!)
    const server = fakeGrepServer({
      hits: [
        { path: 'wiki/notes.md', n: 7, text: 'spare keys by the door', match: 'word', by: 'alice' },
        { path: 'wiki/shelf.md', n: 3, text: 'garage shelf needs paint', match: 'word' },
        { path: 'wiki/bike.md', n: 4, text: 'chain oil sits on the shelf', match: 'word', by: 'bob' },
      ],
      files: 12,
      truncated: false,
      total: 3,
      shown: 3,
      note: 'server note kept',
    });

    const ollama = await startFakeOllama((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ embeddings: [[2, 0, 0, 0]] }));
    });
    try {
      const r = await runSearch(['where are my bicycle chains', '--json'], server, {
        env: { ATRIS_MEMORY_INDEX: dir, OLLAMA_HOST: ollama.url },
      });
      assert.equal(r.code, 0, r.errs);
      assert.equal(r.errs, '');
      assert.equal(ollama.seen.length, 1);
      assert.equal(ollama.seen[0].body.model, 'fake-embed:1');
      assert.equal(ollama.seen[0].body.keep_alive, '30m');
      assert.match(ollama.seen[0].body.input[0], /^Instruct: Given a message.*\nQuery: where are my bicycle chains$/);

      const j = JSON.parse(r.text);
      assert.equal(j.ok, true);
      assert.equal(j.mixed, true);
      assert.equal(j.files, 12);
      assert.equal(j.note, 'server note kept');
      assert.equal(j.shown, j.hits.length);

      // Expected order:
      // 1. wiki/bike.md:4   (1/13 + 1/12 = 0.1603)
      // 2. wiki/notes.md:7  (1/11 = 0.0909, server tie-break wins over local #1)
      // 3. wiki/tea.md:1    (1/11 = 0.0909, local only)
      // 4. wiki/shelf.md:3  (1/12 = 0.0833, server only)
      // 5. wiki/garden.md:2 (1/13 = 0.0769, local rule won over line at same loc)
      assert.deepEqual(
        j.hits.map((h) => `${h.path}:${h.n}`),
        ['wiki/bike.md:4', 'wiki/notes.md:7', 'wiki/tea.md:1', 'wiki/shelf.md:3', 'wiki/garden.md:2'],
      );
      assert.equal(j.hits[0].by, 'bob', 'server hit retains every server key');
      assert.equal(j.hits[0].local, undefined, 'shared hit is not marked local-only');
      assert.equal(j.hits[2].local, true, 'local-only hit carries local: true');
      assert.equal(j.hits[2].match, 'meaning', 'local-only hit carries server hit keys');
      assert.equal(j.hits[4].text, 'always water tomatoes at dusk', 'rule card wins per (path, n)');

      // --all-files includes the raw data item from the local index.
      const all = await runSearch(['where are my bicycle chains', '--all-files', '--json'], server, {
        env: { ATRIS_MEMORY_INDEX: dir, OLLAMA_HOST: ollama.url },
      });
      const ja = JSON.parse(all.text);
      assert.ok(ja.hits.some((h) => h.path === 'files/ledger.json' && h.local === true));
    } finally {
      await ollama.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('hit count never grows beyond max(server count, 10)', () => {
  const mk = (prefix, count) => Array.from({ length: count }, (_, i) => ({
    path: `wiki/${prefix}-${i}.md`, n: i + 1, text: `${prefix} ${i}`,
  }));

  const small = mixHits(mk('s', 2), mk('l', 20));
  assert.equal(small.mixed, true);
  assert.equal(small.hits.length, 10, 'server count < 10 caps at 10');

  const large = mixHits(mk('s', 14), mk('l', 20));
  assert.equal(large.mixed, true);
  assert.equal(large.hits.length, 14, 'server count > 10 caps at server count');
});

test('pattern queries and short queries stay pure word search', async () => {
  assert.equal(isPlainQuestion('where is my bike'), true);
  assert.equal(isPlainQuestion('two words'), false);
  for (const q of [
    'rent|lease',
    'one|two|three words',
    'path\\to some file',
    '^start of line',
    'price is $10 now',
    'match foo* bar baz',
    'list [all] items now',
    'check (this) right now',
  ]) {
    assert.equal(isPlainQuestion(q), false, q);
  }

  const dir = tmpDir();
  try {
    writeIndex(dir, {
      items: [{ path: 'wiki/a.md', n: 1, text: 'hello world note', kind: 'line' }],
      vectors: [1, 0, 0, 0],
      bias: [0],
    });
    let embedCalls = 0;
    const server = fakeGrepServer({
      hits: [{ path: 'wiki/lease.md', n: 2, text: 'landlord is Pat' }],
      files: 1,
      truncated: false,
    });
    const r = await runSearch(['rent|lease', '--json'], server, {
      env: { ATRIS_MEMORY_INDEX: dir },
      embedLocal: async () => { embedCalls += 1; return [1, 0, 0, 0]; },
    });
    assert.equal(r.code, 0);
    assert.equal(embedCalls, 0, 'pattern query never calls embedder');
    const j = JSON.parse(r.text);
    assert.equal(j.mixed, undefined);
    assert.deepEqual(j.hits, [{ path: 'wiki/lease.md', n: 2, text: 'landlord is Pat' }]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('missing or broken index changes nothing silently; missing bm25.json still ranks by vectors', async () => {
  const base = tmpDir();
  try {
    const server = fakeGrepServer({
      hits: [{ path: 'wiki/s.md', n: 1, text: 'server line' }],
      files: 1,
      truncated: false,
    });
    const embedLocal = async () => [1, 0, 0, 0];

    // Missing directory
    const missing = await runSearch(['where is my spare key', '--json'], server, {
      env: { ATRIS_MEMORY_INDEX: path.join(base, 'does-not-exist') },
      embedLocal,
    });
    assert.equal(missing.code, 0);
    assert.equal(missing.errs, '');
    assert.equal(JSON.parse(missing.text).mixed, undefined);

    // Wrong format
    const badFmt = path.join(base, 'bad-fmt');
    writeIndex(badFmt, {
      format: 'old-v1',
      items: [{ path: 'wiki/a.md', n: 1, text: 'note', kind: 'line' }],
      vectors: [1, 0, 0, 0],
      bias: [0],
    });
    const rFmt = await runSearch(['where is my spare key', '--json'], server, {
      env: { ATRIS_MEMORY_INDEX: badFmt },
      embedLocal,
    });
    assert.equal(rFmt.code, 0);
    assert.equal(rFmt.errs, '');
    assert.equal(JSON.parse(rFmt.text).mixed, undefined);

    // Wrong vector / bias byte sizes
    const badSize = path.join(base, 'bad-size');
    writeIndex(badSize, {
      items: [{ path: 'wiki/a.md', n: 1, text: 'note', kind: 'line' }],
      vectors: [1, 0],
      bias: [0],
    });
    const rSize = await runSearch(['where is my spare key', '--json'], server, {
      env: { ATRIS_MEMORY_INDEX: badSize },
      embedLocal,
    });
    assert.equal(rSize.code, 0);
    assert.equal(rSize.errs, '');
    assert.equal(JSON.parse(rSize.text).mixed, undefined);

    // Corrupt meta.json
    const corrupt = path.join(base, 'corrupt');
    fs.mkdirSync(corrupt, { recursive: true });
    fs.writeFileSync(path.join(corrupt, 'meta.json'), '{not json');
    const rCorrupt = await runSearch(['where is my spare key', '--json'], server, {
      env: { ATRIS_MEMORY_INDEX: corrupt },
      embedLocal,
    });
    assert.equal(rCorrupt.code, 0);
    assert.equal(rCorrupt.errs, '');
    assert.equal(JSON.parse(rCorrupt.text).mixed, undefined);

    // Valid vectors + bias without bm25.json still works
    const noBm25 = path.join(base, 'no-bm25');
    writeIndex(noBm25, {
      items: [{ path: 'wiki/keys.md', n: 5, text: 'spare key under blue pot', kind: 'line' }],
      vectors: [1, 0, 0, 0],
      bias: [0.5],
    });
    const rVecOnly = await runSearch(['where is my spare key', '--json'], server, {
      env: { ATRIS_MEMORY_INDEX: noBm25 },
      embedLocal,
    });
    const jVec = JSON.parse(rVecOnly.text);
    assert.equal(jVec.mixed, true);
    assert.ok(jVec.hits.some((h) => h.path === 'wiki/keys.md' && h.local === true));
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('slow embedder changes nothing and returns within the time limit', async () => {
  const dir = tmpDir();
  const pending = [];
  const slowOllama = await startFakeOllama((_req, res) => {
    const t = setTimeout(() => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ embeddings: [[1, 0, 0, 0]] }));
    }, 4000);
    pending.push({ t, res });
  });
  try {
    writeIndex(dir, {
      items: [{ path: 'wiki/a.md', n: 1, text: 'local note', kind: 'line' }],
      vectors: [1, 0, 0, 0],
      bias: [0],
    });
    const server = fakeGrepServer({
      hits: [{ path: 'wiki/s.md', n: 1, text: 'server hit' }],
      files: 1,
      truncated: false,
    });
    const started = Date.now();
    const r = await runSearch(['where is my winter coat', '--json'], server, {
      env: { ATRIS_MEMORY_INDEX: dir, OLLAMA_HOST: slowOllama.url },
      localTimeoutMs: 120,
    });
    const elapsed = Date.now() - started;
    assert.equal(r.code, 0);
    assert.equal(r.errs, '');
    assert.ok(elapsed < 1000, `timed out slowly: ${elapsed} ms`);
    const j = JSON.parse(r.text);
    assert.equal(j.mixed, undefined);
    assert.deepEqual(j.hits, [{ path: 'wiki/s.md', n: 1, text: 'server hit' }]);
  } finally {
    for (const p of pending) { clearTimeout(p.t); p.res.destroy(); }
    await slowOllama.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('--words-only, ATRIS_MEMORY_LOCAL=0, help text, and server error handling', async () => {
  const dir = tmpDir();
  try {
    writeIndex(dir, {
      items: [{ path: 'wiki/a.md', n: 1, text: 'local note', kind: 'line' }],
      vectors: [1, 0, 0, 0],
      bias: [0.5],
    });
    const server = fakeGrepServer({
      hits: [{ path: 'wiki/s.md', n: 1, text: 'server hit' }],
      files: 1,
      truncated: false,
    });
    let embedCalls = 0;
    const embedLocal = async () => { embedCalls += 1; return [1, 0, 0, 0]; };

    // Sanity: enabled call actually mixes
    const mixed = await runSearch(['where is my winter coat', '--json'], server, {
      env: { ATRIS_MEMORY_INDEX: dir },
      embedLocal,
    });
    assert.equal(JSON.parse(mixed.text).mixed, true);
    assert.equal(embedCalls, 1);

    // --words-only disables local rank
    const wordsOnly = await runSearch(['where is my winter coat', '--words-only', '--json'], server, {
      env: { ATRIS_MEMORY_INDEX: dir },
      embedLocal,
    });
    assert.equal(wordsOnly.code, 0);
    assert.equal(JSON.parse(wordsOnly.text).mixed, undefined);
    assert.equal(embedCalls, 1, '--words-only skips embedder');

    // ATRIS_MEMORY_LOCAL=0 disables local rank
    const envOff = await runSearch(['where is my winter coat', '--json'], server, {
      env: { ATRIS_MEMORY_INDEX: dir, ATRIS_MEMORY_LOCAL: '0' },
      embedLocal,
    });
    assert.equal(envOff.code, 0);
    assert.equal(JSON.parse(envOff.text).mixed, undefined);
    assert.equal(embedCalls, 1, 'ATRIS_MEMORY_LOCAL=0 skips embedder');

    // Help text documents --words-only
    const help = await runSearch(['--help'], server);
    assert.equal(help.code, 0);
    assert.match(help.text, /--words-only/);

    // Server failure behaves as today and never returns local-only results
    const broken = fakeGrepServer(null, { fail: { ok: false, status: 500, data: null, error: 'boom' } });
    const failed = await runSearch(['where is my winter coat', '--json'], broken, {
      env: { ATRIS_MEMORY_INDEX: dir },
      embedLocal,
    });
    assert.equal(failed.code, 1);
    const jf = JSON.parse(failed.text);
    assert.equal(jf.ok, false);
    assert.equal(jf.hits, undefined);
    assert.match(jf.error, /HTTP 500/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('--in filters local results to the named folder only', async () => {
  const dir = tmpDir();
  try {
    writeIndex(dir, {
      items: [
        { path: 'wiki/garden.md', n: 1, text: 'tomatoes grow in summer', kind: 'line' },
        { path: 'wiki/people/sam.md', n: 2, text: 'sam rides a red bike', kind: 'line' },
        { path: 'wiki/people-archive/old.md', n: 3, text: 'old bike note', kind: 'line' },
      ],
      vectors: [
        1.0, 0, 0, 0,
        0.5, 0, 0, 0,
        0.9, 0, 0, 0,
      ],
      bias: [0.5, 0.1, 0.5],
    });

    const filtered = await rankLocal('who rides a red bike', {
      folder: 'wiki/people',
      env: { ATRIS_MEMORY_INDEX: dir },
      embed: async () => [1, 0, 0, 0],
    });
    assert.deepEqual(filtered, [{ path: 'wiki/people/sam.md', n: 2, text: 'sam rides a red bike' }]);

    const server = fakeGrepServer({ hits: [], files: 2, truncated: false });
    const r = await runSearch(['who rides a red bike', '--in', 'wiki/people', '--json'], server, {
      env: { ATRIS_MEMORY_INDEX: dir },
      embedLocal: async () => [1, 0, 0, 0],
    });
    const j = JSON.parse(r.text);
    assert.equal(j.mixed, true);
    assert.deepEqual(j.hits, [{ path: 'wiki/people/sam.md', n: 2, text: 'sam rides a red bike', local: true }]);

    // Folder with zero local hits does not set mixed
    const none = await runSearch(['who rides a red bike', '--in', 'wiki/empty', '--json'], server, {
      env: { ATRIS_MEMORY_INDEX: dir },
      embedLocal: async () => [1, 0, 0, 0],
    });
    assert.equal(JSON.parse(none.text).mixed, undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a question holding a word like "constructor" still ranks: the word tables are read by own entries only', async () => {
  const dir = tmpDir();
  try {
    writeIndex(dir, {
      items: [
        { path: 'wiki/shed.md', n: 3, text: 'the shed door sticks in winter', kind: 'line' },
        { path: 'wiki/bike.md', n: 4, text: 'oil the chain every month', kind: 'line' },
      ],
      vectors: [0.2, 0, 0, 0, 0.9, 0, 0, 0],
      bias: [0, 0],
      bm25: { k1: 1.2, b: 0.75, avgdl: 4, dl: [4, 4], idf: { chain: 2.0 }, postings: { chain: [1, 1] } },
    });
    const hits = await rankLocal('which constructor oils the chain toString', {
      env: { ATRIS_MEMORY_INDEX: dir },
      embed: async () => [1, 0, 0, 0],
    });
    assert.deepEqual(hits.map((h) => `${h.path}:${h.n}`), ['wiki/bike.md:4', 'wiki/shed.md:3']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
