':' //; exec node "$0" "$@"
'use strict';

// Lesson policy-bounce-causes-routing: human bounces are routing/staleness
// problems (wrong_owner, superseded), not prose problems. Teach the do-phase
// to confirm routing before marking work ready.

const fs = require('node:fs');
const path = require('node:path');

const target = path.join(process.cwd(), 'commands', 'autopilot.js');
const anchor = 'Before reading the file list, state the business stake this task protects or unlocks in one sentence.';
const replacement = 'Before reading the file list, state the business stake this task protects or unlocks in one sentence.\nBefore marking work ready, confirm the task owner is still right and the work was not superseded.';

const source = fs.readFileSync(target, 'utf8');
const count = source.split(anchor).length - 1;
if (count !== 1) {
  console.error(`anchor not found exactly once in ${target}: ${count}`);
  process.exit(1);
}

fs.writeFileSync(target, source.replace(anchor, replacement), 'utf8');
