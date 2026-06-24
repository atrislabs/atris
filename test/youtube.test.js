const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DEFAULT_QUERY,
  parseYoutubeArgs,
  buildYoutubePayload,
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

test('youtubeCommand calls the process_youtube endpoint without curl', async () => {
  const calls = [];
  const output = [];

  const status = await youtubeCommand([
    'https://youtube.com/watch?v=abc123',
    '--query',
    'Extract lessons',
  ], {
    output: (line) => output.push(line),
    ensureValidCredentials: async () => ({ credentials: { token: 'token-123' } }),
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
  assert.match(output.join('\n'), /Video title/);
  assert.match(output.join('\n'), /Main insight/);
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
