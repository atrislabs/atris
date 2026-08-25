const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  DEFAULT_QUERY,
  parseYoutubeArgs,
  buildYoutubePayload,
  extractLocalTranscript,
  shouldRetryWithLocalTranscript,
  formatYoutubeResult,
  fileBriefFromNotes,
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
  assert.match(DEFAULT_QUERY, /timestamped YouTube brief/);
  assert.match(DEFAULT_QUERY, /claims with confidence/);
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
  assert.equal(extractorCalls, 1);
  assert.match(output.join('\n'), /Video title/);
  assert.match(output.join('\n'), /Main insight/);
});

test('youtubeCommand sends local transcript first without caching it', async () => {
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
      return {
        ok: true,
        status: 200,
        data: { status: 'success', message: 'ok', video_analysis: 'done' },
      };
    },
  });

  assert.equal(status, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.body.transcript_text, 'local captions');
  assert.equal(calls[0].options.body.transcript_language, 'en');
  assert.equal(calls[0].options.body.duration_seconds, 33);
  assert.equal(calls[0].options.body.cache_transcript, false);
});

test('youtubeCommand falls back to cloud video after local transcript failure', async () => {
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
          error: { error: 'Transcript summarization failed' },
        };
      }
      return {
        ok: true,
        status: 200,
        data: { status: 'success', message: 'ok', video_analysis: 'cloud done' },
      };
    },
  });

  assert.equal(status, 0);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.body.transcript_text, 'local captions');
  assert.equal(calls[0].options.body.cache_transcript, false);
  assert.equal(calls[1].options.body.transcript_text, undefined);
  assert.equal(calls[1].options.body.cache_transcript, undefined);
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
        { tStartMs: 0, segs: [{ utf8: 'Hello ' }, { utf8: 'world' }] },
        { tStartMs: 1200, segs: [{ utf8: 'Next idea' }] },
      ],
    }),
  });

  assert.equal(result.transcriptText, '[00:00] Hello world\n[00:01] Next idea');
  assert.equal(result.language, 'en');
  assert.equal(result.durationSeconds, 44);
});

test('extractLocalTranscript preserves VTT timestamps', async () => {
  const result = await extractLocalTranscript('https://youtube.com/watch?v=abc123', {
    spawnSync: () => ({
      status: 0,
      stdout: JSON.stringify({
        duration: 61,
        subtitles: {
          en: [{ ext: 'vtt', url: 'https://www.youtube.com/api/timedtext?v=abc123' }],
        },
      }),
    }),
    fetchCaptionText: async () => [
      'WEBVTT',
      '',
      '00:00:02.000 --> 00:00:04.000',
      'First idea',
      '',
      '00:01:00.000 --> 00:01:02.000',
      'Second idea',
      '',
    ].join('\n'),
  });

  assert.equal(result.transcriptText, '[00:02] First idea\n[01:00] Second idea');
  assert.equal(result.durationSeconds, 61);
});

test('youtube notes with no url exits 2 and prints usage', async () => {
  const output = [];
  const status = await youtubeCommand(['notes'], {
    output: (line) => output.push(line),
  });

  assert.equal(status, 2);
  assert.match(output.join('\n'), /usage: ytnotes <youtube-url>/);
  assert.match(output.join('\n'), /zero credits, local captions \+ a fast engine/);
});

test('youtube notes with a non-youtube arg exits 2', async () => {
  const status = await youtubeCommand(['notes', 'not-a-url'], {
    output: () => {},
  });

  assert.equal(status, 2);
});

test('fileBriefFromNotes writes a wiki brief and a claimable journal line', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-yt-brief-'));
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-yt-notes-'));
  fs.mkdirSync(path.join(cwd, 'atris', 'wiki'), { recursive: true });
  const notes = '# Some Video Title\n\nBody paragraph.\n';
  fs.writeFileSync(path.join(workDir, 'yt_abc123xyz.md'), notes);
  const url = 'https://www.youtube.com/watch?v=abc123xyz';

  fileBriefFromNotes({
    cwd,
    url,
    workDir,
    now: new Date('2026-08-15T15:00:00.000Z'),
  });

  const brief = fs.readFileSync(path.join(cwd, 'atris', 'wiki', 'briefs', 'youtube-abc123xyz.md'), 'utf8');
  assert.equal(brief, [
    'some video title',
    '',
    'date: 2026-08-15',
    `source: ${url}`,
    'rail: atris youtube notes, quotes repaired against the transcript',
    notes,
  ].join('\n'));

  const journal = fs.readFileSync(path.join(cwd, 'atris', 'logs', '2026', '2026-08-15.md'), 'utf8');
  assert.equal(journal, '- [claimable] watched: Some Video Title -> atris/wiki/briefs/youtube-abc123xyz.md\n');
});

test('fileBriefFromNotes files youtu.be notes and stays silent without a wiki', () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-yt-notes-be-'));
  fs.writeFileSync(path.join(workDir, 'yt_shortid99.md'), '# Short Form\n\nClip notes.\n');

  const withWiki = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-yt-be-'));
  fs.mkdirSync(path.join(withWiki, 'atris', 'wiki'), { recursive: true });
  fileBriefFromNotes({
    cwd: withWiki,
    url: 'https://youtu.be/shortid99?si=abc',
    workDir,
    now: '2026-08-15',
  });
  assert.match(
    fs.readFileSync(path.join(withWiki, 'atris', 'wiki', 'briefs', 'youtube-shortid99.md'), 'utf8'),
    /source: https:\/\/youtu\.be\/shortid99\?si=abc/,
  );

  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-yt-nowiki-'));
  fileBriefFromNotes({
    cwd: bare,
    url: 'https://youtu.be/shortid99',
    workDir,
    now: new Date('2026-08-15T15:00:00.000Z'),
  });
  assert.equal(fs.existsSync(path.join(bare, 'atris', 'wiki')), false);
  assert.equal(fs.existsSync(path.join(bare, 'atris', 'logs')), false);
});

test('youtube process mints only the youtube scope after an expired user wall and retries', async () => {
  const calls = [];
  const persisted = [];
  const output = [];
  const secret = 'minted-youtube-secret';

  const status = await youtubeCommand([
    'https://youtube.com/watch?v=abc123',
    '--query',
    'Extract lessons',
  ], {
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
    extractLocalTranscript: async () => null,
    apiRequestJson: async (pathname, options) => {
      calls.push({ pathname, options });
      if (pathname === '/auth/agent-token') {
        return {
          ok: true,
          status: 200,
          data: { access_token: secret, scopes: ['youtube'], daily_credit_cap: 50 },
        };
      }
      return {
        ok: true,
        status: 200,
        data: {
          status: 'success',
          message: 'YouTube video processed successfully',
          video_analysis: 'Main insight.',
          credits_used: 5,
          credits_remaining: 42,
        },
      };
    },
  });

  assert.equal(status, 0);
  assert.equal(calls[0].pathname, '/auth/agent-token');
  assert.equal(calls[0].options.token, 'user-jwt');
  assert.deepEqual(calls[0].options.body.scopes, ['youtube']);
  assert.equal(calls[0].options.body.scopes.includes('x-search'), false);
  assert.equal(calls[1].pathname, '/agent/process_youtube');
  assert.equal(calls[1].options.token, secret);
  assert.deepEqual(persisted, [secret]);
  assert.match(output.join('\n'), /Main insight/);
  assert.doesNotMatch(output.join('\n'), new RegExp(secret));
  assert.doesNotMatch(output.join('\n'), /\/auth\/cli|Choose login method|Opening browser/);
});

test('youtube process remints after a billed 401 and retries once', async () => {
  const calls = [];
  const secret = 'minted-youtube-after-401';
  const status = await youtubeCommand(['https://youtube.com/watch?v=abc123'], {
    output: () => {},
    ensureValidCredentials: async () => ({ credentials: { token: 'user-jwt' } }),
    loadCredentials: () => ({ token: 'user-jwt', refresh_token: 'refresh-jwt' }),
    persistMintedAgentToken: () => {},
    extractLocalTranscript: async () => null,
    apiRequestJson: async (pathname, options) => {
      calls.push({ pathname, token: options.token, body: options.body });
      if (pathname === '/agent/process_youtube' && options.token === 'user-jwt') {
        return { ok: false, status: 401, error: 'agent token required' };
      }
      if (pathname === '/auth/agent-token') {
        assert.deepEqual(options.body.scopes, ['youtube']);
        return { ok: true, status: 200, data: { access_token: secret, scopes: ['youtube'] } };
      }
      return {
        ok: true,
        status: 200,
        data: { status: 'success', message: 'ok', video_analysis: 'retried' },
      };
    },
  });

  assert.equal(status, 0);
  assert.equal(calls[0].pathname, '/agent/process_youtube');
  assert.equal(calls[0].token, 'user-jwt');
  assert.equal(calls[1].pathname, '/auth/agent-token');
  assert.equal(calls[2].pathname, '/agent/process_youtube');
  assert.equal(calls[2].token, secret);
});

test('youtube process with no stored JWT fails in one sentence and stays off the login wall', async () => {
  const output = [];
  let apiCalls = 0;
  const status = await youtubeCommand(['https://youtube.com/watch?v=abc123'], {
    output: (line) => output.push(line),
    ensureValidCredentials: async () => ({ error: 'not_logged_in' }),
    loadCredentials: () => null,
    extractLocalTranscript: async () => {
      throw new Error('should not extract');
    },
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

test('formatYoutubeResult includes metadata, credits, and analysis', () => {
  const text = formatYoutubeResult({
    message: 'done',
    video_analysis: 'Analysis text.',
    credits_used: 5,
    credits_remaining: 10,
    metadata: {
      title: 'T',
      channel: 'C',
      duration_seconds: 4459,
      processing_method: 'client_transcript_atris_fast',
      transcript_source: 'client_transcript',
    },
  });

  assert.match(text, /Title: T/);
  assert.match(text, /Channel: C/);
  assert.match(text, /Duration: 01:14:19/);
  assert.match(text, /Processing: client_transcript_atris_fast via client_transcript/);
  assert.match(text, /Credits: 5 used, 10 remaining/);
  assert.match(text, /Analysis text/);
});
