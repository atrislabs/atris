const test = require('node:test');
const assert = require('node:assert/strict');

const {
  renderGameDashboard,
  isValidStorylineSlug,
  parseGameArgs,
} = require('../commands/game');

const fixture = {
  schema: 'atris.game_state.v1',
  storyline: {
    name: 'The Atris Awakening',
    destination: 'Turn every useful mission into visible, verified progress.',
    chapters: [
      { n: 1, title: 'Wake the system', state: 'complete' },
      { n: 2, title: 'Find the signal', state: 'complete' },
      { n: 3, title: 'Build the loop', state: 'current' },
      { n: 4, title: 'Prove the work', state: 'locked' },
      { n: 5, title: 'Recruit the party', state: 'locked' },
      { n: 6, title: 'Cross the frontier', state: 'locked' },
      { n: 7, title: 'Reach the destination', state: 'locked' },
    ],
    mission: {
      title: 'Ship the terminal game dashboard',
      status: 'active',
    },
    streak: {
      current: 4,
      target: 7,
      label: 'cold-open resume streak',
    },
  },
  missions: {
    active: [
      {
        id: 42,
        title: 'Open GM mode like a video game',
        owner: 'codex',
        state: 'active',
        next: 'Run the focused dashboard verifier.',
      },
    ],
    recent_complete: [
      { id: 41, title: 'Compile the public game state' },
    ],
  },
};

test('game dashboard renders the live mission briefing', () => {
  const output = renderGameDashboard(fixture, { color: false, width: 80 });

  assert.match(output, /The Atris Awakening/);
  assert.match(output, /YOU ARE HERE/);
  assert.match(output, /Ship the terminal game dashboard/);
  assert.match(output, /STREAK: 4 \/ 7/);
  assert.match(output, /NEXT MOVE: Run the focused dashboard verifier\./);
});

test('game dashboard tolerates a null storyline', () => {
  const payload = {
    schema: 'atris.game_state.v1',
    storyline: null,
    missions: { active: [], recent_complete: [] },
  };

  assert.doesNotThrow(() => renderGameDashboard(payload, { color: false, width: 60 }));
  assert.match(renderGameDashboard(payload, { color: false, width: 60 }), /No storyline loaded/);
});

test('storyline slug validation rejects unsafe names and accepts slugs', () => {
  assert.equal(isValidStorylineSlug('BAD_SLUG!'), false);
  assert.equal(isValidStorylineSlug('agentgrads'), true);
});

test('positional storyline maps to the publisher storyline flag', () => {
  assert.deepEqual(parseGameArgs(['agentgrads']), {
    storyline: 'agentgrads',
    publisherArgs: ['--json', '--storyline', 'agentgrads'],
  });
  assert.deepEqual(parseGameArgs(['--storyline', 'agentgrads']), {
    storyline: 'agentgrads',
    publisherArgs: ['--json', '--storyline', 'agentgrads'],
  });
});
