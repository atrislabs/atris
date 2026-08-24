'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseSearchArgs,
  parseSearchStdout,
  formatSearchResults,
  youtubeCommand,
} = require('../commands/youtube');

test('parseSearchArgs accepts query with limit and json', () => {
  const options = parseSearchArgs([
    'MCP agents',
    '--limit',
    '10',
    '--json',
  ]);
  assert.equal(options.query, 'MCP agents');
  assert.equal(options.limit, 10);
  assert.equal(options.json, true);
  assert.equal(options.help, false);
});

test('parseSearchArgs defaults limit to 5 and supports --help', () => {
  assert.equal(parseSearchArgs(['MCP agents']).limit, 5);
  assert.equal(parseSearchArgs(['--help']).help, true);
  assert.throws(() => parseSearchArgs(['--limit', '0']), /positive integer/);
  assert.throws(() => parseSearchArgs(['--limit', '3']), /Missing query/);
});

test('parseSearchStdout reads five-field and six-field pipe lines', () => {
  const rows = parseSearchStdout([
    'Alpha Talk | Channel A | 12:34 | 1000 | https://youtu.be/aaa111',
    'Beta Show | Channel B | 1:02:03 | 9999 | 20260801 | https://youtu.be/bbb222',
    'noise without pipes',
    'too | few',
  ].join('\n'));

  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], {
    title: 'Alpha Talk',
    channel: 'Channel A',
    duration: '12:34',
    views: '1000',
    url: 'https://youtu.be/aaa111',
  });
  assert.deepEqual(rows[1], {
    title: 'Beta Show',
    channel: 'Channel B',
    duration: '1:02:03',
    views: '9999',
    upload_date: '20260801',
    url: 'https://youtu.be/bbb222',
  });
  assert.match(formatSearchResults(rows), /https:\/\/youtu\.be\/aaa111/);
  assert.match(formatSearchResults(rows), /20260801 \| https:\/\/youtu\.be\/bbb222/);
});

test('youtube search --help prints usage without calling the runner', async () => {
  const output = [];
  let runnerCalls = 0;
  const status = await youtubeCommand(['search', '--help'], {
    output: (line) => output.push(line),
    runner: () => {
      runnerCalls += 1;
      return { status: 0, stdout: '' };
    },
  });

  assert.equal(status, 0);
  assert.equal(runnerCalls, 0);
  assert.match(output.join('\n'), /Usage: atris youtube search/);
  assert.match(output.join('\n'), /--limit/);
  assert.match(output.join('\n'), /zero credits|Does not bill credits/i);
});

test('youtube search prints youtu.be links from mocked runner', async () => {
  const output = [];
  const calls = [];
  const status = await youtubeCommand(['search', 'MCP agents 2026', '--limit', '5'], {
    output: (line) => output.push(line),
    runner: (query, limit) => {
      calls.push({ query, limit });
      return {
        status: 0,
        stdout: [
          'MCP Agents in 2026 | Dev Channel | 18:22 | 42000 | 20260820 | https://youtu.be/mcp2026a',
          'Agent Stack Tour | Build Lab | 9:01 | 1200 | 20260701 | https://youtu.be/mcp2026b',
        ].join('\n'),
      };
    },
  });

  assert.equal(status, 0);
  assert.deepEqual(calls, [{ query: 'MCP agents 2026', limit: 5 }]);
  const text = output.join('\n');
  assert.match(text, /https:\/\/youtu\.be\/mcp2026a/);
  assert.match(text, /https:\/\/youtu\.be\/mcp2026b/);
  assert.match(text, /MCP Agents in 2026/);
  assert.match(text, /Dev Channel/);
});

test('youtube search --json prints parsed rows', async () => {
  const output = [];
  const status = await youtubeCommand(['search', 'agents', '--json'], {
    output: (line) => output.push(line),
    runner: () => ({
      status: 0,
      stdout: 'Title One | Chan | 1:00 | 10 | 20260101 | https://youtu.be/one123\n',
    }),
  });

  assert.equal(status, 0);
  const parsed = JSON.parse(output.join('\n'));
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].url, 'https://youtu.be/one123');
  assert.equal(parsed[0].upload_date, '20260101');
});

test('youtube search missing query exits 2 with usage', async () => {
  const output = [];
  const status = await youtubeCommand(['search', '--limit', '3'], {
    output: (line) => output.push(line),
    runner: () => ({ status: 0, stdout: '' }),
  });
  assert.equal(status, 2);
  assert.match(output.join('\n'), /Missing query/);
});

test('youtube search empty results exits 2', async () => {
  const output = [];
  const status = await youtubeCommand(['search', 'nothing here'], {
    output: (line) => output.push(line),
    runner: () => ({ status: 0, stdout: '\n' }),
  });
  assert.equal(status, 2);
  assert.match(output.join('\n'), /no videos found/);
});

test('youtube search runner failure surfaces stderr', async () => {
  const output = [];
  const status = await youtubeCommand(['search', 'fail case'], {
    output: (line) => output.push(line),
    runner: () => ({ status: 1, stdout: '', stderr: 'yt-dlp exploded' }),
  });
  assert.equal(status, 1);
  assert.match(output.join('\n'), /yt-dlp exploded/);
});
