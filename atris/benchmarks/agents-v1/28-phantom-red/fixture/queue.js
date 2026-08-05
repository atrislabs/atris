'use strict';

function drainMs(jobs) {
  return jobs.length * 2;
}

module.exports = { drainMs };
