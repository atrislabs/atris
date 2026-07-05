':' //; exec node "$0" "$@"
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const target = path.join(process.cwd(), 'commands', 'mission.js');
const anchor = "    `When done, output a short receipt: (1) the exact files edited / commands run / artifacts produced \u2014 name them, (2) the metric of progress, (3) what the next tick should pick up. End the receipt with one line naming the layer this tick touched: \\`layer: identity|beliefs|capabilities|behaviors|environment\\` (final line \u2014 the harness parses it).`,\n";
const replacement = "    `When done, output a short receipt. The summary's first line must name what changed and how it was verified. Then include: (1) the exact files edited / commands run / artifacts produced \u2014 name them, (2) the metric of progress, (3) what the next tick should pick up. End the receipt with one line naming the layer this tick touched: \\`layer: identity|beliefs|capabilities|behaviors|environment\\` (final line \u2014 the harness parses it).`,\n";

const source = fs.readFileSync(target, 'utf8');
const count = source.split(anchor).length - 1;
if (count !== 1) {
  console.error(`anchor not found exactly once in ${target}: ${count}`);
  process.exit(1);
}

fs.writeFileSync(target, source.replace(anchor, replacement), 'utf8');
