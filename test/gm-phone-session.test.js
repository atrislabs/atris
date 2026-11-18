'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const trace = require('../scripts/gm-phone-trace');
const health = require('../scripts/gm-phone-health');

const CHROME = trace.findChrome();

test('browser: 100 cards in a row through every kind of move, and nothing on the page grows: listeners, nodes, timers, intervals, frames, canvases, and the heap hold', { skip: !CHROME && 'no chrome on this machine', timeout: 480000 }, async () => {
  const out = await health.sessionTrace({ chromePath: CHROME, cards: 100 });
  const show = JSON.stringify({ grew: out.grew_after_first_round, first: out.samples[0], last: out.samples[out.samples.length - 1], console: out.console });
  assert.ok(out.cards >= 100, show);
  for (const k of ['listeners', 'dom_nodes', 'documents', 'intervals', 'timeouts', 'frames', 'canvases_made', 'canvases', 'nodes', 'copies']) assert.equal(out.grew_after_first_round[k], 0, `${k} ${show}`);
  assert.ok(out.grew_after_first_round.heap_kb < 1024, show);
  // at rest after each round: the one footer look (a timer the page sets again after
  // each look, so it can ask less often while the Mac is away), no motion waiting, the one sphere
  const last = out.samples[out.samples.length - 1];
  assert.deepEqual([last.intervals, last.timeouts], [0, 1], show);
  assert.equal(last.frames, 0, show);
  assert.equal(last.canvases, 1, show);
  assert.deepEqual(out.console, [], show);
  // no card ever lands with a shift: none the browser counts, and next to none right after a tap
  assert.equal(out.layout_shift, 0, JSON.stringify(out.shifts));
  assert.ok(out.layout_shift_after_taps < 0.005, JSON.stringify(out.shifts));
});
