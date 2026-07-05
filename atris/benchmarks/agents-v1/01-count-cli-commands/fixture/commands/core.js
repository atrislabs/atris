'use strict';

const { register } = require('../registry');

register('init', () => 'initialized');
register('build', () => 'built');
register('status', () => 'ok');

// register('legacy-init', () => 'legacy'); // retired command, do not re-enable
