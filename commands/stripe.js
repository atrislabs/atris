const { createOfficialCliCommand } = require('../lib/official-cli-integration');

const stripeCommand = createOfficialCliCommand({
  name: 'stripe',
  binary: 'stripe',
  versionArgs: ['--version'],
  authArgs: ['config', '--list'],
  installHint: 'https://docs.stripe.com/stripe-cli',
  loginHint: 'stripe login',
  commands: [
    {
      usage: 'listen',
      match: ['listen'],
      forward: ['listen'],
      description: 'listen for webhook events',
    },
    {
      usage: 'trigger',
      match: ['trigger'],
      forward: ['trigger'],
      description: 'trigger test webhook events',
    },
    {
      usage: 'products list',
      match: ['products', 'list'],
      forward: ['products', 'list'],
      description: 'list products',
    },
    {
      usage: 'products create',
      match: ['products', 'create'],
      forward: ['products', 'create'],
      description: 'create a product',
    },
  ],
});

module.exports = { stripeCommand };
