'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseNotesArgs,
  isPlaylistUrl,
  expandNotesTargets,
  runYoutubeNotesBatch,
  youtubeCommand,
} = require('../commands/youtube');

function collect() {
  const lines = [];
  return {
    lines,
    output: (line = '') => lines.push(String(line)),
    text: () => lines.join('\n'),
  };
}

function briefFor(url) {
  const id = String(url).match(/[?&]v=([^&]+)/)?.[1] || String(url).match(/youtu\.be\/([^?&/]+)/)?.[1];
  return `atris/wiki/briefs/youtube-${id}.md`;
}

test('parseNotesArgs keeps the engine as the one non-url trailing word', () => {
  assert.deepEqual(
    parseNotesArgs([
      'https://www.youtube.com/watch?v=aaa',
      'https://youtu.be/bbb',
      'haiku',
    ]),
    {
      urls: [
        'https://www.youtube.com/watch?v=aaa',
        'https://youtu.be/bbb',
      ],
      engine: 'haiku',
      help: false,
    },
  );
  assert.equal(isPlaylistUrl('https://www.youtube.com/playlist?list=PLxx'), true);
  assert.equal(isPlaylistUrl('https://www.youtube.com/watch?v=aaa&list=PLxx'), true);
  assert.equal(isPlaylistUrl('https://www.youtube.com/watch?v=aaa'), false);
});

test('single-url notes still run the existing path with an optional engine', async () => {
  const calls = [];
  const briefs = [];
  let expanded = 0;
  const status = await youtubeCommand([
    'notes',
    'https://www.youtube.com/watch?v=abc123',
    'grok',
  ], {
    output: () => {},
    runner: (url, engine) => {
      calls.push({ url, engine });
      return { status: 0 };
    },
    briefFiler: ({ url }) => {
      briefs.push(url);
      return briefFor(url);
    },
    expander: () => {
      expanded += 1;
      return [];
    },
  });

  assert.equal(status, 0);
  assert.deepEqual(calls, [{
    url: 'https://www.youtube.com/watch?v=abc123',
    engine: 'grok',
  }]);
  assert.deepEqual(briefs, ['https://www.youtube.com/watch?v=abc123']);
  assert.equal(expanded, 0);
});

test('multi-url notes run sequentially and keep the shared engine', async () => {
  const calls = [];
  const log = collect();
  const status = await youtubeCommand([
    'notes',
    'https://www.youtube.com/watch?v=aaa111',
    'https://youtu.be/bbb222',
    'haiku',
  ], {
    output: log.output,
    runner: (url, engine) => {
      calls.push({ url, engine });
      return { status: 0 };
    },
    briefFiler: ({ url }) => briefFor(url),
    nowMs: (() => {
      let n = 0;
      return () => {
        n += 1000;
        return n;
      };
    })(),
  });

  assert.equal(status, 0);
  assert.deepEqual(calls, [
    { url: 'https://www.youtube.com/watch?v=aaa111', engine: 'haiku' },
    { url: 'https://youtu.be/bbb222', engine: 'haiku' },
  ]);
  assert.match(log.text(), /aaa111  1s  atris\/wiki\/briefs\/youtube-aaa111.md/);
  assert.match(log.text(), /bbb222  1s  atris\/wiki\/briefs\/youtube-bbb222.md/);
  assert.match(log.text(), /url or id  seconds  result/);
});

test('playlist expansion caps at 10 and prints a cap note', async () => {
  const playlist = 'https://www.youtube.com/playlist?list=PLbatch';
  const videos = Array.from({ length: 12 }, (_, i) => ({
    id: `vid${String(i + 1).padStart(2, '0')}`,
    title: `Video ${i + 1}`,
  }));
  const calls = [];
  const log = collect();
  let expandCalls = 0;

  const status = runYoutubeNotesBatch({ urls: [playlist], engine: null }, {
    output: log.output,
    expander: (url) => {
      expandCalls += 1;
      assert.equal(url, playlist);
      return videos;
    },
    runner: (url) => {
      calls.push(url);
      return { status: 0 };
    },
    briefFiler: ({ url }) => briefFor(url),
  });

  assert.equal(status, 0);
  assert.equal(expandCalls, 1);
  assert.equal(calls.length, 10);
  assert.deepEqual(calls, videos.slice(0, 10).map((video) => `https://www.youtube.com/watch?v=${video.id}`));
  assert.match(log.text(), /playlist capped at 10 videos \(12 found\)/);
  assert.doesNotMatch(log.text(), /vid11/);
  assert.doesNotMatch(log.text(), /vid12/);
});

test('one failed video records FAILED and the batch continues', async () => {
  const log = collect();
  const calls = [];
  const status = await youtubeCommand([
    'notes',
    'https://www.youtube.com/watch?v=fail01',
    'https://www.youtube.com/watch?v=pass02',
  ], {
    output: log.output,
    runner: (url) => {
      calls.push(url);
      return { status: url.includes('fail01') ? 2 : 0 };
    },
    briefFiler: ({ url }) => briefFor(url),
  });

  assert.equal(status, 0);
  assert.deepEqual(calls, [
    'https://www.youtube.com/watch?v=fail01',
    'https://www.youtube.com/watch?v=pass02',
  ]);
  assert.match(log.text(), /fail01  \d+s  FAILED/);
  assert.match(log.text(), /pass02  \d+s  atris\/wiki\/briefs\/youtube-pass02.md/);
});

test('all-fail notes batch exits 2', async () => {
  const log = collect();
  const status = runYoutubeNotesBatch({
    urls: [
      'https://www.youtube.com/watch?v=bad01',
      'https://www.youtube.com/watch?v=bad02',
    ],
  }, {
    output: log.output,
    runner: () => ({ status: 1 }),
    briefFiler: () => {
      throw new Error('brief should not file on failure');
    },
  });

  assert.equal(status, 2);
  assert.match(log.text(), /bad01  \d+s  FAILED/);
  assert.match(log.text(), /bad02  \d+s  FAILED/);
  assert.match(log.text(), /url or id  seconds  result/);
});

test('expandNotesTargets leaves a plain watch url untouched', () => {
  const items = expandNotesTargets(['https://www.youtube.com/watch?v=plain1'], {
    expander: () => {
      throw new Error('expander should not run for a watch url');
    },
  });
  assert.deepEqual(items, [
    { url: 'https://www.youtube.com/watch?v=plain1', id: 'plain1' },
  ]);
});
