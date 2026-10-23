'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { renderLoopHome } = require('../commands/loop-front');

test('an empty moves array renders home without an empty ranked section', () => {
  const expected = [
    '',
    'atris loop: the self-improvement loop',
    '',
    '  one loop: plan, do, review, verify, commit. it ships one small',
    '  verifiable change at a time, then goes again. it reads ROADMAP.md',
    '  for what to pursue.',
    '',
    '  feed it',
    '    atris loop add "<task>"        put a bounded task into the queue',
    '',
    '  start it',
    '    atris loop start              run it now, here (local)',
    '    atris loop start --once       one cycle, then stop',
    '    atris loop start --overnight  install the durable heartbeat (~15m)',
    '    atris loop start --overnight --hours 6',
    '',
    '  watch it',
    '    atris loop status             liveness, last tick, reward',
    '    atris loop report             what the loop has handled and what is next',
    '    atris run logs                read each phase (local runs)',
    '',
    '  stop it',
    '    atris loop stop               remove the durable heartbeat',
    '',
    '  act on it',
    '    atris loop create-next       create + claim the suggested task',
    '',
    '  wiki upkeep is at: atris loop wiki',
    '',
  ].join('\n');

  assert.equal(renderLoopHome({ action: 'home' }, []), expected);
});
