'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { renderGameDashboard } = require('../commands/game');

test('dashboard ignores a function supplied as the storyline', () => {
  // Functions have a name but are not storyline objects. A truthiness-only
  // guard would incorrectly render this function's name as the dashboard title.
  function InvalidStoryline() {}

  const output = renderGameDashboard(
    { storyline: InvalidStoryline },
    { color: false, width: 80 },
  );

  assert.equal(output.split('\n')[0], 'No storyline loaded');
});
