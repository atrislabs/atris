'use strict';

const { notify } = require('./services/notifier');

function run() {
  notify('app-b started');
  return 'app-b: notified via bus';
}

module.exports = { run };
if (require.main === module) console.log(run());
