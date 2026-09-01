const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  normalizeWatchChannel,
  channelVideosUrl,
  parseFlatPlaylist,
  loadWatchState,
  youtubeCommand,
} = require('../commands/youtube');

function tempCwd() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-yt-watch-'));
}

function statePathFor(cwd) {
  return path.join(cwd, '.atris', 'state', 'youtube_watch.json');
}

function collect() {
  const lines = [];
  return {
    lines,
    output: (line = '') => lines.push(String(line)),
    text: () => lines.join('\n'),
  };
}

test('normalizeWatchChannel turns @handle and /videos urls into a channel key', () => {
  assert.equal(normalizeWatchChannel('@veritasium'), 'https://www.youtube.com/@veritasium');
  assert.equal(
    normalizeWatchChannel('https://www.youtube.com/@mkbhd/videos'),
    'https://www.youtube.com/@mkbhd',
  );
  assert.equal(
    channelVideosUrl('https://www.youtube.com/@veritasium'),
    'https://www.youtube.com/@veritasium/videos',
  );
});

test('parseFlatPlaylist reads id|title rows and skips junk', () => {
  const videos = parseFlatPlaylist([
    'aaa|Newest video',
    '',
    'NA|skip',
    'bbb|Older video',
  ].join('\n'));
  assert.deepEqual(videos, [
    { id: 'aaa', title: 'Newest video' },
    { id: 'bbb', title: 'Older video' },
  ]);
});

test('watch add/list/remove round-trip', async () => {
  const cwd = tempCwd();
  const added = collect();
  const now = '2026-08-15T19:00:00.000Z';

  const addStatus = await youtubeCommand(['watch', 'add', '@veritasium'], {
    cwd,
    now,
    output: added.output,
  });
  assert.equal(addStatus, 0);

  const urlStatus = await youtubeCommand(['watch', 'add', 'https://www.youtube.com/@mkbhd/videos'], {
    cwd,
    now,
    output: () => {},
  });
  assert.equal(urlStatus, 0);

  const state = JSON.parse(fs.readFileSync(statePathFor(cwd), 'utf8'));
  assert.deepEqual(state.channels, [
    { channel: 'https://www.youtube.com/@veritasium', added: now },
    { channel: 'https://www.youtube.com/@mkbhd', added: now },
  ]);
  assert.match(added.text(), /watching https:\/\/www\.youtube\.com\/@veritasium/);

  const listed = collect();
  const listStatus = await youtubeCommand(['watch', 'list'], { cwd, output: listed.output });
  assert.equal(listStatus, 0);
  assert.match(listed.text(), /1\. https:\/\/www\.youtube\.com\/@veritasium \(0 seen\)/);
  assert.match(listed.text(), /2\. https:\/\/www\.youtube\.com\/@mkbhd \(0 seen\)/);

  const removed = collect();
  const removeStatus = await youtubeCommand(['watch', 'remove', '1'], {
    cwd,
    output: removed.output,
  });
  assert.equal(removeStatus, 0);
  assert.match(removed.text(), /removed https:\/\/www\.youtube\.com\/@veritasium/);

  const after = loadWatchState(statePathFor(cwd));
  assert.equal(after.channels.length, 1);
  assert.equal(after.channels[0].channel, 'https://www.youtube.com/@mkbhd');
});

test('tick briefs only unseen videos', async () => {
  const cwd = tempCwd();
  const now = '2026-08-15T19:10:00.000Z';
  await youtubeCommand(['watch', 'add', '@veritasium'], { cwd, now, output: () => {} });

  const ran = [];
  const briefed = [];
  const first = collect();
  const firstStatus = await youtubeCommand(['watch', 'tick'], {
    cwd,
    now,
    output: first.output,
    fetcher: () => [
      { id: 'new1', title: 'Newest' },
      { id: 'old1', title: 'Older' },
      { id: 'old2', title: 'Oldest' },
    ],
    runner: (url) => {
      ran.push(url);
      return { status: 0 };
    },
    briefFiler: ({ url }) => briefed.push(url),
  });
  assert.equal(firstStatus, 0);
  assert.deepEqual(ran, ['https://www.youtube.com/watch?v=new1']);
  assert.deepEqual(
    first.text().split('\n').filter((line) => line.startsWith('next: atris youtube teach')),
    ['next: atris youtube teach "https://www.youtube.com/watch?v=new1"'],
  );

  ran.length = 0;
  briefed.length = 0;
  const second = collect();
  const secondStatus = await youtubeCommand(['watch', 'tick'], {
    cwd,
    now,
    output: second.output,
    fetcher: () => [
      { id: 'new2', title: 'Brand new' },
      { id: 'new1', title: 'Newest' },
      { id: 'old1', title: 'Older' },
    ],
    runner: (url) => {
      ran.push(url);
      return { status: 0 };
    },
    briefFiler: ({ url }) => briefed.push(url),
  });
  assert.equal(secondStatus, 0);
  assert.deepEqual(ran, ['https://www.youtube.com/watch?v=new2']);
  assert.deepEqual(briefed, ['https://www.youtube.com/watch?v=new2']);
  assert.match(second.text(), /channel https:\/\/www\.youtube\.com\/@veritasium: 1 new, 1 briefed/);
  assert.match(second.text(), /total: 1 new, 1 briefed/);
  assert.deepEqual(
    second.text().split('\n').filter((line) => line.startsWith('next: atris youtube teach')),
    ['next: atris youtube teach "https://www.youtube.com/watch?v=new2"'],
  );

  const state = loadWatchState(statePathFor(cwd));
  assert.equal(state.seen.new1, now);
  assert.equal(state.seen.new2, now);
  assert.equal(state.seen.old1, now);
  assert.equal(state.seen.old2, now);
});

test('fresh-channel seeding briefs only newest', async () => {
  const cwd = tempCwd();
  const now = '2026-08-15T19:20:00.000Z';
  await youtubeCommand(['watch', 'add', 'https://www.youtube.com/@mkbhd'], {
    cwd,
    now,
    output: () => {},
  });

  const fetched = [];
  const ran = [];
  const briefed = [];
  const out = collect();
  const status = await youtubeCommand(['watch', 'tick'], {
    cwd,
    now,
    output: out.output,
    fetcher: (url) => {
      fetched.push(url);
      return [
        { id: 'aaa', title: 'Newest' },
        { id: 'bbb', title: 'Middle' },
        { id: 'ccc', title: 'Oldest' },
      ];
    },
    runner: (url) => {
      ran.push(url);
      return { status: 0 };
    },
    briefFiler: ({ url }) => briefed.push(url),
  });

  assert.equal(status, 0);
  assert.deepEqual(fetched, ['https://www.youtube.com/@mkbhd/videos']);
  assert.deepEqual(ran, ['https://www.youtube.com/watch?v=aaa']);
  assert.deepEqual(briefed, ['https://www.youtube.com/watch?v=aaa']);
  assert.match(out.text(), /channel https:\/\/www\.youtube\.com\/@mkbhd: 1 new, 1 briefed/);

  const state = loadWatchState(statePathFor(cwd));
  assert.equal(state.seen.aaa, now);
  assert.equal(state.seen.bbb, now);
  assert.equal(state.seen.ccc, now);
  assert.equal(state.seeded['https://www.youtube.com/@mkbhd'], true);

  const listed = collect();
  await youtubeCommand(['watch', 'list'], { cwd, output: listed.output });
  assert.match(listed.text(), /1\. https:\/\/www\.youtube\.com\/@mkbhd \(3 seen\)/);
});

test('failed fetch skips channel and continues', async () => {
  const cwd = tempCwd();
  const now = '2026-08-15T19:30:00.000Z';
  await youtubeCommand(['watch', 'add', '@broken'], { cwd, now, output: () => {} });
  await youtubeCommand(['watch', 'add', '@ok'], { cwd, now, output: () => {} });

  const ran = [];
  const out = collect();
  const status = await youtubeCommand(['watch', 'tick'], {
    cwd,
    now,
    output: out.output,
    fetcher: (url) => {
      if (url.includes('@broken')) throw new Error('network down');
      return [{ id: 'ok1', title: 'Fine' }];
    },
    runner: (url) => {
      ran.push(url);
      return { status: 0 };
    },
    briefFiler: () => {},
  });

  assert.equal(status, 0);
  assert.match(out.text(), /warning: channel https:\/\/www\.youtube\.com\/@broken fetch failed/);
  assert.match(out.text(), /channel https:\/\/www\.youtube\.com\/@ok: 1 new, 1 briefed/);
  assert.match(out.text(), /total: 1 new, 1 briefed/);
  assert.deepEqual(ran, ['https://www.youtube.com/watch?v=ok1']);
  assert.deepEqual(
    out.text().split('\n').filter((line) => line.startsWith('next: atris youtube teach')),
    ['next: atris youtube teach "https://www.youtube.com/watch?v=ok1"'],
  );

  const state = loadWatchState(statePathFor(cwd));
  assert.equal(state.seeded['https://www.youtube.com/@broken'], undefined);
  assert.equal(state.seen.ok1, now);
});

test('zero-briefed tick prints no teach next-step', async () => {
  const cwd = tempCwd();
  const now = '2026-08-15T19:40:00.000Z';

  const empty = collect();
  const emptyStatus = await youtubeCommand(['watch', 'tick'], {
    cwd,
    now,
    output: empty.output,
    fetcher: () => {
      throw new Error('empty watch list should not fetch');
    },
    runner: () => {
      throw new Error('empty watch list should not run notes');
    },
    briefFiler: () => {
      throw new Error('empty watch list should not file a brief');
    },
  });
  assert.equal(emptyStatus, 0);
  assert.match(empty.text(), /total: 0 new, 0 briefed/);
  assert.equal(empty.text().includes('next: atris youtube teach'), false);

  await youtubeCommand(['watch', 'add', '@broken'], { cwd, now, output: () => {} });
  const failed = collect();
  const failStatus = await youtubeCommand(['watch', 'tick'], {
    cwd,
    now,
    output: failed.output,
    fetcher: () => {
      throw new Error('network down');
    },
    runner: () => {
      throw new Error('fetch-fail should not run notes');
    },
    briefFiler: () => {
      throw new Error('fetch-fail should not file a brief');
    },
  });
  assert.equal(failStatus, 0);
  assert.match(failed.text(), /warning: channel https:\/\/www\.youtube\.com\/@broken fetch failed/);
  assert.match(failed.text(), /total: 0 new, 0 briefed/);
  assert.equal(failed.text().includes('next: atris youtube teach'), false);
});

test('watch help says tick hands off to teach when it briefed', async () => {
  const out = collect();
  const status = await youtubeCommand(['watch', 'help'], { output: out.output });
  assert.equal(status, 0);
  assert.match(out.text(), /tick hands off to teach when it briefed/);
});
