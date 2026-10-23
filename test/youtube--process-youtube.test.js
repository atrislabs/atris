const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { processYoutube, PROCESS_APPLY_MESSAGE } = require('../commands/youtube');

const scratch = [];
const tempDir = (prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  scratch.push(dir);
  return dir;
};
test.after(() => {
  for (const dir of scratch) fs.rmSync(dir, { recursive: true, force: true });
});

const VIDEO_URL = 'https://www.youtube.com/watch?v=abc123XYZ';
const FIXED_NOW = '2026-01-15';

async function capture(fn) {
  try {
    await fn();
    return null;
  } catch (err) {
    return err;
  }
}

function baseOptions(overrides = {}) {
  return {
    youtubeUrl: VIDEO_URL,
    query: 'Summarize this video',
    agentId: null,
    storeAsKnowledge: false,
    timeoutMs: 5000,
    json: true,
    ...overrides,
  };
}

function baseDeps(overrides = {}) {
  const calls = { api: [], auth: [] };
  const deps = {
    cwd: tempDir('atris-yt-process-'),
    now: FIXED_NOW,
    output: () => {},
    ensureProcessApply: () => 0,
    ensureBilledCommandAuth: async (_command, d) => {
      calls.auth.push(d);
      return { ok: true, token: 'token-1' };
    },
    extractLocalTranscript: async () => null,
    apiRequestJson: async (_path, req) => {
      calls.api.push(req);
      return { ok: true, data: { video_analysis: 'a brief' } };
    },
    ...overrides,
  };
  return { deps, calls };
}

test('returns server data and ships the local transcript payload', async () => {
  const { deps, calls } = baseDeps({
    extractLocalTranscript: async () => ({
      transcriptText: 'hello from the captions',
      language: 'en',
      durationSeconds: 120,
    }),
  });

  const data = await processYoutube(baseOptions(), deps);

  assert.deepEqual(data, { video_analysis: 'a brief' });
  assert.equal(calls.api.length, 1);
  const body = calls.api[0].body;
  assert.equal(body.youtube_url, VIDEO_URL);
  assert.equal(body.query, 'Summarize this video');
  assert.equal(body.transcript_text, 'hello from the captions');
  assert.equal(body.transcript_language, 'en');
  assert.equal(body.duration_seconds, 120);
  assert.equal(body.cache_transcript, false);
  assert.equal(calls.api[0].token, 'token-1');
});

test('falls back to the plain cloud payload when no local transcript exists', async () => {
  const { deps, calls } = baseDeps({ extractLocalTranscript: async () => null });

  const data = await processYoutube(baseOptions(), deps);

  assert.deepEqual(data, { video_analysis: 'a brief' });
  assert.equal(calls.api.length, 1);
  const body = calls.api[0].body;
  assert.equal(body.youtube_url, VIDEO_URL);
  assert.equal('transcript_text' in body, false);
  assert.equal('cache_transcript' in body, false);
});

test('retries in the cloud when the transcript attempt is refused with 502', async () => {
  const seen = [];
  const { deps } = baseDeps({
    extractLocalTranscript: async () => ({ transcriptText: 'captions', language: 'en' }),
    apiRequestJson: async (_path, req) => {
      seen.push(req.body);
      return seen.length === 1
        ? { ok: false, status: 502, error: 'upstream down' }
        : { ok: true, data: { video_analysis: 'cloud brief' } };
    },
  });

  const data = await processYoutube(baseOptions(), deps);

  assert.deepEqual(data, { video_analysis: 'cloud brief' });
  assert.equal(seen.length, 2);
  assert.equal(seen[0].transcript_text, 'captions');
  assert.equal('transcript_text' in seen[1], false);
});

test('throws the apply message and never bills when the apply gate blocks', async () => {
  let authCalled = false;
  let apiCalled = false;
  const { deps } = baseDeps({
    ensureProcessApply: () => 1,
    ensureBilledCommandAuth: async () => {
      authCalled = true;
      return { ok: true, token: 'token-1' };
    },
    apiRequestJson: async () => {
      apiCalled = true;
      return { ok: true, data: {} };
    },
  });

  const err = await capture(() => processYoutube(baseOptions(), deps));

  assert.ok(err);
  assert.equal(err.message, PROCESS_APPLY_MESSAGE);
  assert.equal(err.applyRequired, true);
  assert.equal(err.exitCode, 1);
  assert.equal(authCalled, false);
  assert.equal(apiCalled, false);
});

test('throws the auth error when sign-in fails', async () => {
  const { deps, calls } = baseDeps({
    ensureBilledCommandAuth: async () => ({ ok: false, error: 'session expired' }),
  });

  const err = await capture(() => processYoutube(baseOptions(), deps));

  assert.ok(err);
  assert.equal(err.message, 'session expired');
  assert.equal(calls.api.length, 0);
});

test('remints once and retries after a 401', async () => {
  const tokens = [];
  let authCalls = 0;
  const { deps } = baseDeps({
    ensureBilledCommandAuth: async (_command, d) => {
      authCalls += 1;
      return authCalls === 1
        ? { ok: true, token: 'stale', minted: false }
        : { ok: true, token: 'fresh', minted: true, forced: d.forceMint === true };
    },
    apiRequestJson: async (_path, req) => {
      tokens.push(req.token);
      return req.token === 'stale'
        ? { ok: false, status: 401, error: 'expired token' }
        : { ok: true, data: { video_analysis: 'retried brief' } };
    },
  });

  const data = await processYoutube(baseOptions(), deps);

  assert.deepEqual(data, { video_analysis: 'retried brief' });
  assert.deepEqual(tokens, ['stale', 'fresh']);
  assert.equal(authCalls, 2);
});

test('throws a status-named error with refund note when the API fails', async () => {
  const { deps } = baseDeps({
    apiRequestJson: async () => ({
      ok: false,
      status: 502,
      error: 'boom',
      data: { credits_refunded: true },
    }),
  });

  const err = await capture(() => processYoutube(baseOptions(), deps));

  assert.ok(err);
  assert.match(err.message, /YouTube processing failed \(502\): boom/);
  assert.match(err.message, /credits refunded/);
  assert.equal(err.applyRequired, undefined);
});
