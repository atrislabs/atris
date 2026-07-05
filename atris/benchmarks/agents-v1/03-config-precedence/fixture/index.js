'use strict';

const { resolveMaxRequests } = require('./limiter');

console.log(`rate limit: ${resolveMaxRequests()} req/window`);
