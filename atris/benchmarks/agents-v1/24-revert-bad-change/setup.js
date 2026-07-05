'use strict';

const fs = require('node:fs');
const path = require('node:path');

function git(ctx, args) {
  const result = ctx.run('git', args);
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `git ${args.join(' ')} failed`);
  }
}

function commit(ctx, message) {
  git(ctx, ['add', '.']);
  git(ctx, [
    '-c',
    'user.email=bench@example.com',
    '-c',
    'user.name=bench',
    'commit',
    '-m',
    message,
  ]);
}

module.exports = async function setup(ctx) {
  git(ctx, ['init', '-b', 'main']);
  commit(ctx, 'good scale');

  fs.writeFileSync(path.join(ctx.workspace, 'scale.js'), `'use strict';

function scale(value, factor) {
  return value + factor;
}

module.exports = { scale };
`);
  commit(ctx, 'bad scale breaks tests');
};
