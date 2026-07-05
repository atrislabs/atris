':' //; exec node "$0" "$@"
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const target = path.join(process.cwd(), 'commands', 'mission.js');
const anchor = "    `- Pick the smallest concrete action that moves the mission forward.`,\n";
const replacement = `${anchor}    \`- Before acting, state your single next move in one sentence.\`,\n`;

const source = fs.readFileSync(target, 'utf8');
const count = source.split(anchor).length - 1;
if (count !== 1) {
  console.error(`anchor not found exactly once in ${target}: ${count}`);
  process.exit(1);
}

fs.writeFileSync(target, source.replace(anchor, replacement), 'utf8');
