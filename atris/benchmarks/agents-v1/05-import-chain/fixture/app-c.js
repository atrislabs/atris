'use strict';

const { track } = require('./services/metrics');

function run() {
  track('app-c started');
  return 'app-c: tracked via legacy metrics';
}

module.exports = { run };
if (require.main === module) console.log(run());
