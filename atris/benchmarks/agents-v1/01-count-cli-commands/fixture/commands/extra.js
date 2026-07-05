'use strict';

const { register } = require('../registry');

function listHandler() {
  return 'listing';
}

register('deploy', () => 'deployed');
register('rollback', () => 'rolled back');
register('ls', listHandler);
register('list', listHandler);

if (false) {
  // disabled pending a rewrite, never reaches the registry
  register('debug-dump', () => 'dumped');
}
