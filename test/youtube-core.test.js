const test = require('node:test');
const assert = require('node:assert/strict');

const youtubeCore = require('../lib/youtube-core');
const youtubeCmd = require('../commands/youtube');

test('youtube-core exports shared youtube helpers and re-exports match commands/youtube', () => {
  assert.equal(typeof youtubeCore.videoIdFromUrl, 'function');
  assert.equal(typeof youtubeCore.looksLikeYoutubeUrl, 'function');
  assert.equal(typeof youtubeCore.parseNotesArgs, 'function');
  assert.equal(typeof youtubeCore.parseTeachArgs, 'function');
  assert.equal(typeof youtubeCore.parseSearchArgs, 'function');
  assert.equal(typeof youtubeCore.extractTeachNumbers, 'function');
  assert.equal(typeof youtubeCore.extractTeachMechanisms, 'function');
  assert.equal(typeof youtubeCore.fileTeachExperiment, 'function');
  assert.equal(youtubeCmd.parseNotesArgs, youtubeCore.parseNotesArgs);
  assert.equal(youtubeCmd.parseTeachArgs, youtubeCore.parseTeachArgs);
  assert.equal(youtubeCmd.parseSearchArgs, youtubeCore.parseSearchArgs);
});

test('youtube-core videoIdFromUrl and looksLikeYoutubeUrl handle standard and embed URLs', () => {
  assert.equal(youtubeCore.videoIdFromUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ#t=10s'), 'dQw4w9WgXcQ');
  assert.equal(youtubeCore.videoIdFromUrl('https://youtu.be/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.equal(youtubeCore.videoIdFromUrl('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.equal(youtubeCore.looksLikeYoutubeUrl('https://youtu.be/dQw4w9WgXcQ'), true);
  assert.equal(youtubeCore.looksLikeYoutubeUrl('claude'), false);
});

test('youtube-core parseNotesArgs and parseSearchArgs normalize flags cleanly', () => {
  const notes = youtubeCore.parseNotesArgs(['https://youtu.be/dQw4w9WgXcQ', '--save', '--json']);
  assert.equal(notes.save, true);
  assert.equal(notes.json, true);
  assert.deepEqual(notes.urls, ['https://youtu.be/dQw4w9WgXcQ']);

  const search = youtubeCore.parseSearchArgs(['context window', '--limit', '3', '--paid']);
  assert.equal(search.query, 'context window');
  assert.equal(search.limit, 3);
  assert.equal(search.paid, true);
});
