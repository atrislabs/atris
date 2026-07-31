'use strict';

const ATRIS_START_MARKER = '<!-- ATRIS:START - Auto-generated, do not edit -->';
const ATRIS_END_MARKER = '<!-- ATRIS:END -->';

function renderAtrisClaudeBootBlock() {
  return `${ATRIS_START_MARKER}
## Atris System

You are now running inside Atris, an AI workspace operating system.

**ON EVERY CONVERSATION START:** If a SessionStart hook already displayed the Atris status block in this session, do not run it again. Otherwise, before your first response, execute \`atris atris.md\` and display the full output. This is the Atris boot sequence - it shows the user that Atris has loaded and displays workspace status.

After displaying the boot output, respond to the user naturally.
${ATRIS_END_MARKER}
`;
}

function upsertAtrisClaudeBootBlock(source = '') {
  const atrisBlock = renderAtrisClaudeBootBlock();
  const startIdx = source.indexOf('<!-- ATRIS:START');
  const prependBlock = (preserved) => {
    const remainder = preserved.replace(/^\n+/, '');
    return remainder ? `${atrisBlock}\n${remainder}` : atrisBlock;
  };

  if (startIdx === -1) {
    return { content: prependBlock(source), action: source ? 'prepended' : 'created' };
  }

  const prefix = source.slice(0, startIdx);
  const endRaw = source.indexOf(ATRIS_END_MARKER, startIdx);
  if (endRaw === -1) {
    return {
      content: prependBlock(prefix),
      action: 'repaired',
    };
  }

  const endIdx = endRaw + ATRIS_END_MARKER.length;
  const suffix = source.slice(endIdx).replace(/^\n+/, '');
  const content = prependBlock(prefix + suffix);
  return { content, action: content === source ? 'unchanged' : 'updated' };
}

module.exports = {
  upsertAtrisClaudeBootBlock,
};
