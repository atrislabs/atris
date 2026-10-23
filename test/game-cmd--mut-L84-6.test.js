'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { renderGameDashboard } = require('../commands/game');

test('dashboard destination respects an explicit narrow display width', () => {
  const columns = Object.getOwnPropertyDescriptor(process.stdout, 'columns');
  try {
    Object.defineProperty(process.stdout, 'columns', { configurable: true, value: 120 });
    const output = renderGameDashboard({
      storyline: {
        name: 'Launch',
        destination: 'Deliver useful progress to the team. '.repeat(6),
        chapters: [],
      },
      missions: { active: [] },
    }, { color: false, width: 60 });
    const destination = output.split('\n').find(line => line.startsWith('DESTINATION:'));
    assert.ok(destination.length <= 60, 'destination must fit the requested width');
  } finally {
    if (columns) Object.defineProperty(process.stdout, 'columns', columns);
    else delete process.stdout.columns;
  }
});
