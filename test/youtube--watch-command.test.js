const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { watchCommand } = require('../commands/youtube');

const FIXED_NOW = '2026-08-15T19:00:00.000Z';

// Every temp folder this file makes, removed once all tests finish.
const scratch = [];
function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-yt-watch-cmd-'));
  scratch.push(dir);
  return dir;
}
test.after(() => {
  for (const dir of scratch) fs.rmSync(dir, { recursive: true, force: true });
});

// Run watchCommand against a throwaway folder; never touches the real cwd or network.
function run(args, cwd, extra = {}) {
  const lines = [];
  const promise = watchCommand(args, {
    cwd,
    now: FIXED_NOW,
    workDir: path.join(cwd, 'ytnotes'),
    output: (line = '') => lines.push(String(line)),
    ...extra,
  });
  return promise.then((code) => ({ code, lines, text: lines.join('\n') }));
}

function readState(cwd) {
  return JSON.parse(fs.readFileSync(path.join(cwd, '.atris', 'state', 'youtube_watch.json'), 'utf8'));
}

test('no subcommand prints the help and returns 2', async () => {
  const cwd = tempDir();
  const result = await run([], cwd);
  assert.equal(result.code, 2);
  assert.ok(result.lines.includes('       atris youtube watch tick'));
  assert.match(result.text, /^\s*Usage: atris youtube search/m);
});

test('help flags print help with the custom command name and return 0', async () => {
  const cwd = tempDir();
  for (const flag of ['help', '--help', '-h']) {
    const result = await run([flag], cwd, { commandName: 'atris yt' });
    assert.equal(result.code, 0, `${flag} should exit 0`);
    assert.ok(result.lines.includes('       atris yt watch add <channel-url-or-@handle>'));
    assert.ok(!result.text.includes('atris youtube watch'));
  }
  assert.equal(fs.existsSync(path.join(cwd, '.atris')), false, 'help must not write state');
});

test('unknown subcommand reports it and returns 2 without writing state', async () => {
  const cwd = tempDir();
  const result = await run(['frobnicate'], cwd);
  assert.equal(result.code, 2);
  assert.deepEqual(result.lines, ['unknown watch command: frobnicate']);
  assert.equal(fs.existsSync(path.join(cwd, '.atris')), false);
});

test('add normalizes a handle, saves it with the fixed timestamp, and points at tick', async () => {
  const cwd = tempDir();
  const result = await run(['add', '@veritasium'], cwd);
  assert.equal(result.code, 0);
  assert.deepEqual(result.lines, [
    'watching https://www.youtube.com/@veritasium',
    'next: atris youtube watch tick',
  ]);
  const state = readState(cwd);
  assert.deepEqual(state.channels, [
    { channel: 'https://www.youtube.com/@veritasium', added: FIXED_NOW },
  ]);
  assert.deepEqual(state.seen, {});
  assert.deepEqual(state.seeded, {});
});

test('add treats a /videos url and a bare handle as the same channel (no duplicate)', async () => {
  const cwd = tempDir();
  await run(['add', 'https://www.youtube.com/@mkbhd/videos?view=0#top'], cwd);
  const again = await run(['add', 'mkbhd'], cwd);
  assert.equal(again.code, 0);
  assert.deepEqual(again.lines, [
    'already watching https://www.youtube.com/@mkbhd',
    'next: atris youtube watch tick',
  ]);
  assert.equal(readState(cwd).channels.length, 1);
});

test('add with no channel or an invalid one returns 2 and saves nothing', async () => {
  const cwd = tempDir();

  const missing = await run(['add'], cwd);
  assert.equal(missing.code, 2);
  assert.deepEqual(missing.lines, ['usage: atris youtube watch add <channel-url-or-@handle>']);

  const invalid = await run(['add', 'not a channel!'], cwd);
  assert.equal(invalid.code, 2);
  assert.deepEqual(invalid.lines, ['Invalid channel: not a channel!']);

  assert.equal(fs.existsSync(path.join(cwd, '.atris')), false);
});

test('list on an empty folder says nothing is watched, then numbers channels with seen counts', async () => {
  const cwd = tempDir();
  const empty = await run(['list'], cwd);
  assert.equal(empty.code, 0);
  assert.deepEqual(empty.lines, [
    'no channels watched',
    'next: atris youtube watch add <channel-url-or-@handle>',
  ]);

  await run(['add', '@alpha'], cwd);
  await run(['add', '@beta'], cwd);
  const listed = await run(['list'], cwd);
  assert.equal(listed.code, 0);
  assert.deepEqual(listed.lines, [
    '1. https://www.youtube.com/@alpha (0 seen)',
    '2. https://www.youtube.com/@beta (0 seen)',
    'next: atris youtube watch tick',
  ]);
});

test('remove drops the numbered channel, and rejects bad numbers', async () => {
  const cwd = tempDir();
  await run(['add', '@alpha'], cwd);
  await run(['add', '@beta'], cwd);

  for (const bad of [undefined, '0', '3', '-1', '1.5', 'abc']) {
    const result = await run(['remove', bad], cwd);
    assert.equal(result.code, 2, `remove ${bad} should fail`);
    assert.deepEqual(result.lines, ['usage: atris youtube watch remove <number>']);
  }
  assert.equal(readState(cwd).channels.length, 2, 'bad numbers must not remove anything');

  const first = await run(['remove', '1'], cwd);
  assert.equal(first.code, 0);
  assert.deepEqual(first.lines, [
    'removed https://www.youtube.com/@alpha',
    'next: atris youtube watch tick',
  ]);
  assert.deepEqual(readState(cwd).channels.map((row) => row.channel), ['https://www.youtube.com/@beta']);

  const last = await run(['remove', '1'], cwd);
  assert.equal(last.code, 0);
  assert.deepEqual(last.lines, [
    'removed https://www.youtube.com/@beta',
    'next: atris youtube watch add <channel-url-or-@handle>',
  ]);
  assert.deepEqual(readState(cwd).channels, []);
});

test('tick with no channels reports zero and points at add, without calling the fetcher', async () => {
  const cwd = tempDir();
  let fetched = 0;
  const result = await run(['tick'], cwd, {
    fetcher: () => {
      fetched += 1;
      return [];
    },
  });
  assert.equal(result.code, 0);
  assert.equal(fetched, 0);
  assert.deepEqual(result.lines, [
    'total: 0 new, 0 briefed',
    'next: atris youtube watch add <channel-url-or-@handle>',
  ]);
});

test('tick warns and carries on when a channel fetch throws or returns junk', async () => {
  const cwd = tempDir();
  await run(['add', '@broken'], cwd);
  await run(['add', '@junk'], cwd);
  await run(['add', '@empty'], cwd);

  const seenUrls = [];
  const result = await run(['tick'], cwd, {
    fetcher: (videosUrl) => {
      seenUrls.push(videosUrl);
      if (videosUrl.includes('@broken')) throw new Error('boom');
      if (videosUrl.includes('@junk')) return 'not an array';
      return [];
    },
    runner: () => assert.fail('runner must not run when nothing was fetched'),
    briefFiler: () => assert.fail('briefFiler must not run when nothing was fetched'),
  });

  assert.equal(result.code, 0);
  assert.deepEqual(seenUrls, [
    'https://www.youtube.com/@broken/videos',
    'https://www.youtube.com/@junk/videos',
    'https://www.youtube.com/@empty/videos',
  ]);
  assert.deepEqual(result.lines, [
    'warning: channel https://www.youtube.com/@broken fetch failed',
    'warning: channel https://www.youtube.com/@junk fetch failed',
    'channel https://www.youtube.com/@empty: 0 new, 0 briefed',
    'total: 0 new, 0 briefed',
    'next: atris youtube search " "',
  ]);

  const state = readState(cwd);
  assert.deepEqual(state.seeded, { 'https://www.youtube.com/@empty': true });
  assert.deepEqual(state.seen, {});
});

test('tick on an already-seeded channel with nothing new briefs nothing and keeps state', async () => {
  const cwd = tempDir();
  await run(['add', '@alpha'], cwd);
  const channel = 'https://www.youtube.com/@alpha';

  // Seed once with an empty feed, then mark one video as seen by hand.
  await run(['tick'], cwd, { fetcher: () => [] });
  const statePath = path.join(cwd, '.atris', 'state', 'youtube_watch.json');
  const state = readState(cwd);
  state.seen.vid1 = FIXED_NOW;
  state.seenByChannel[channel] = { vid1: FIXED_NOW };
  fs.writeFileSync(statePath, JSON.stringify(state));

  const result = await run(['tick'], cwd, {
    fetcher: () => [{ id: 'vid1', title: 'Already seen' }],
    runner: () => assert.fail('runner must not run for a seen video'),
    briefFiler: () => assert.fail('briefFiler must not run for a seen video'),
  });
  assert.equal(result.code, 0);
  assert.deepEqual(result.lines, [
    `channel ${channel}: 0 new, 0 briefed`,
    'total: 0 new, 0 briefed',
    'next: atris youtube search " "',
  ]);

  const listed = await run(['list'], cwd);
  assert.equal(listed.lines[0], `1. ${channel} (1 seen)`);
});
