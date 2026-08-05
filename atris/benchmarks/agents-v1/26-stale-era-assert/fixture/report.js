'use strict';

// 0.2.0 contract: status lines use ': ' between name and state.
// See CHANGELOG.md. The old ' - ' separator is gone on purpose.
function statusLine(job) {
  return `${job.name}: ${job.state}`;
}

module.exports = { statusLine };
