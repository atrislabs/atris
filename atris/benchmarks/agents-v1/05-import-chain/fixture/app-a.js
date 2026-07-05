'use strict';

function run() {
  return 'app-a: no event bus needed';
}

module.exports = { run };
if (require.main === module) console.log(run());
