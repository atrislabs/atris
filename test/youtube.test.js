const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DEFAULT_QUERY,
  parseYoutubeArgs,
  buildYoutubePayload,
  extractLocalTranscript,
  shouldRetryWithLocalTranscript,
  formatYoutubeResult,
  youtubeCommand,
} = require('../commands/youtube');

test('parseYoutubeArgs accepts process form with query, storage, json, and timeout', () => {
  const options = parseYoutubeArgs([
    'process',
    'https://youtu.be/abc123',
    '--query',
    'What changed?',
    '--agent',
    'agent-1',
    '--store',
    '--json',
    '--timeout',
    '12',
  ]);

  assert.equal(options.youtubeUrl, 'https://youtu.be/abc123');
  assert.equal(options.query, 'What changed?');
  assert.equal(options.agentId, 'agent-1');
  assert.equal(options.storeAsKnowledge, true);
  assert.equal(options.json, true);
  assert.equal(options.timeoutMs, 12000);
});

test('buildYoutubePayload defaults to the documented takeaway query', () => {
  const payload = buildYoutubePayload(parseYoutubeArgs(['https://youtube.com/watch?v=abc123']));
  assert.deepEqual(payload, {
    youtube_url: 'https://youtube.com/watch?v=abc123',
    query: DEFAULT_QUERY,
  });
});

test('buildYoutubePayload can include client transcript fields', () => {
  const options = parseYoutubeArgs(['https://youtube.com/watch?v=abc123']);
  options.localTranscript = {
    transcriptText: 'caption text',
    language: 'en',
    durationSeconds: 12,
  };

  assert.deepEqual(buildYoutubePayload(options), {
    youtube_url: 'https://youtube.com/watch?v=abc123',
    query: DEFAULT_QUERY,
    transcript_text: 'caption text',
    transcript_language: 'en',
    duration_seconds: 12,
  });
});

test('youtubeCommand calls the process_youtube endpoint without curl', async () => {
  const calls = [];
  const output = [];
  let extractorCalls = 0;

  const status = await youtubeCommand([
    'https://youtube.com/watch?v=abc123',
    '--query',
    'Extract lessons',
  ], {
    output: (line) => output.push(line),
    ensureValidCredentials: async () => ({ credentials: { token: 'token-123' } }),
    extractLocalTranscript: async () => {
      extractorCalls += 1;
      return null;
    },
    apiRequestJson: async (pathname, options) => {
      calls.push({ pathname, options });
      return {
        ok: true,
        status: 200,
        data: {
          status: 'success',
          message: 'YouTube video processed successfully',
          video_analysis: 'Main insight.',
          credits_used: 5,
          credits_remaining: 42,
          metadata: { title: 'Video title', channel: 'Channel name' },
        },
      };
    },
  });

  assert.equal(status, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].pathname, '/agent/process_youtube');
  assert.deepEqual(calls[0].options.body, {
    youtube_url: 'https://youtube.com/watch?v=abc123',
    query: 'Extract lessons',
  });
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.token, 'token-123');
  assert.equal(calls[0].options.timeoutMs, 300000);
  assert.equal(calls[0].options.retries, 0);
  assert.equal(extractorCalls, 0);
  assert.match(output.join('\n'), /Video title/);
  assert.match(output.join('\n'), /Main insight/);
});

test('youtubeCommand retries with local transcript after server transcript failure', async () => {
  const calls = [];

  const status = await youtubeCommand([
    'https://youtube.com/watch?v=abc123',
  ], {
    output: () => {},
    ensureValidCredentials: async () => ({ credentials: { token: 'token-123' } }),
    extractLocalTranscript: async () => ({
      transcriptText: 'local captions',
      language: 'en',
      durationSeconds: 33,
    }),
    apiRequestJson: async (pathname, options) => {
      calls.push({ pathname, options });
      if (calls.length === 1) {
        return {
          ok: false,
          status: 502,
          error: { error: 'Transcript and native video processing failed' },
        };
      }
      return {
        ok: true,
        status: 200,
        data: { status: 'success', message: 'ok', video_analysis: 'done' },
      };
    },
  });

  assert.equal(status, 0);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.body.transcript_text, undefined);
  assert.equal(calls[1].options.body.transcript_text, 'local captions');
  assert.equal(calls[1].options.body.transcript_language, 'en');
  assert.equal(calls[1].options.body.duration_seconds, 33);
});

test('shouldRetryWithLocalTranscript only retries YouTube extraction failures', () => {
  assert.equal(shouldRetryWithLocalTranscript({ ok: false, status: 502, error: 'failed' }), true);
  assert.equal(shouldRetryWithLocalTranscript({
    ok: false,
    status: 400,
    error: { error: 'YouTube video is not publicly accessible', reason: 'oEmbed blocked' },
  }), true);
  assert.equal(shouldRetryWithLocalTranscript({ ok: false, status: 400, error: 'Invalid YouTube URL' }), false);
  assert.equal(shouldRetryWithLocalTranscript({ ok: false, status: 402, error: 'Insufficient credits' }), false);
});

test('extractLocalTranscript parses yt-dlp json3 captions', async () => {
  const result = await extractLocalTranscript('https://youtube.com/watch?v=abc123', {
    spawnSync: () => ({
      status: 0,
      stdout: JSON.stringify({
        duration: 44,
        automatic_captions: {
          en: [{ ext: 'json3', url: 'https://www.youtube.com/api/timedtext?v=abc123' }],
        },
      }),
    }),
    fetchCaptionText: async () => JSON.stringify({
      events: [
        { segs: [{ utf8: 'Hello ' }, { utf8: 'world' }] },
        { segs: [{ utf8: 'Next idea' }] },
      ],
    }),
  });

  assert.equal(result.transcriptText, 'Hello world Next idea');
  assert.equal(result.language, 'en');
  assert.equal(result.durationSeconds, 44);
});

test('formatYoutubeResult includes metadata, credits, and analysis', () => {
  const text = formatYoutubeResult({
    message: 'done',
    video_analysis: 'Analysis text.',
    credits_used: 5,
    credits_remaining: 10,
    metadata: { title: 'T', channel: 'C' },
  });

  assert.match(text, /Title: T/);
  assert.match(text, /Channel: C/);
  assert.match(text, /Credits: 5 used, 10 remaining/);
  assert.match(text, /Analysis text/);
});
