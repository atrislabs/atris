'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { renderVoiceCardBlock } = require('../lib/voice-card');

test('wraps a voice card with the heading and exact comment markers', () => {
  assert.strictEqual(
    renderVoiceCardBlock('Start with the answer.'),
    '<!-- ATRIS_VOICE_CARD:START -->\n## Voice card\n\nStart with the answer.\n<!-- ATRIS_VOICE_CARD:END -->',
  );
});

test('preserves multiline Markdown and surrounding whitespace verbatim', () => {
  assert.strictEqual(
    renderVoiceCardBlock('  Speak plainly.\r\n\r\n- Keep `details`.\n  '),
    '<!-- ATRIS_VOICE_CARD:START -->\n## Voice card\n\n  Speak plainly.\r\n\r\n- Keep `details`.\n  \n<!-- ATRIS_VOICE_CARD:END -->',
  );
});

test('renders an explicitly empty card without substituting the default', () => {
  assert.strictEqual(
    renderVoiceCardBlock(''),
    '<!-- ATRIS_VOICE_CARD:START -->\n## Voice card\n\n\n<!-- ATRIS_VOICE_CARD:END -->',
  );
});
