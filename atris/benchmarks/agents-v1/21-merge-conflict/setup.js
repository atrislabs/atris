'use strict';

const fs = require('node:fs');
const path = require('node:path');

const featureMath = `'use strict';

function add(a, b) {
  return Number(a) + Number(b);
}

module.exports = { add };
`;

const mainMath = `'use strict';

function add(a, b) {
  return Number.parseFloat(a) + Number.parseFloat(b);
}

module.exports = { add };
`;

const featureMessage = `'use strict';

function greeting(name) {
  return \`hello \${String(name).trim().toUpperCase()}\`;
}

module.exports = { greeting };
`;

const mainMessage = `'use strict';

function greeting(name) {
  return \`hello \${String(name).trim().toLowerCase()}\`;
}

module.exports = { greeting };
`;

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
  commit(ctx, 'base');

  git(ctx, ['checkout', '-b', 'feature']);
  fs.writeFileSync(path.join(ctx.workspace, 'math.js'), featureMath);
  fs.writeFileSync(path.join(ctx.workspace, 'message.js'), featureMessage);
  commit(ctx, 'feature updates');

  git(ctx, ['checkout', 'main']);
  fs.writeFileSync(path.join(ctx.workspace, 'math.js'), mainMath);
  fs.writeFileSync(path.join(ctx.workspace, 'message.js'), mainMessage);
  commit(ctx, 'main updates');

  const merge = ctx.run('git', ['merge', 'feature']);
  if (merge.status === 0) {
    throw new Error('expected merge conflict');
  }
  for (const file of ['math.js', 'message.js']) {
    const text = fs.readFileSync(path.join(ctx.workspace, file), 'utf8');
    if (!text.includes('<<<<<<<')) throw new Error(`${file} did not conflict`);
  }
};
