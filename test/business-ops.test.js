const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const {
  normalizeOrdersPayload,
  parseBusinessStoreArgs,
  readStorefront,
  readWalletNet,
} = require('../commands/business');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');

function runCli(args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`CLI timed out\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, 15000);
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.on('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', status => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}

function writeCliState(home) {
  const atrisDir = path.join(home, '.atris');
  fs.mkdirSync(atrisDir, { recursive: true });
  fs.writeFileSync(path.join(atrisDir, 'credentials.json'), JSON.stringify({
    token: 'test-token',
    provider: 'test',
    saved_at: new Date().toISOString(),
  }));
  fs.writeFileSync(path.join(atrisDir, 'businesses.json'), JSON.stringify({
    acme: {
      business_id: 'biz-1',
      name: 'Acme Co',
      slug: 'acme',
    },
  }));
}

function startApi(requests) {
  const products = [{
    id: 'prod-1',
    name: 'Launch kit',
    desc: 'Everything needed to launch.',
    price_cents: 4900,
    currency: 'usd',
  }];
  const dashboard = {
    business: {
      id: 'biz-1',
      name: 'Acme Co',
      slug: 'acme',
      app_count: 2,
      apps: [{ id: 'app-1', name: 'Brief' }, { id: 'app-2', name: 'CRM' }],
      config: {
        wallet_balance: 4200,
        storefront: { enabled: false, products },
      },
    },
    roster: {
      members: [
        { user_id: 'owner-1', display_name: 'Ava', role: 'owner' },
        { user_id: 'agent-1', display_name: 'Scout', role: 'agent' },
      ],
    },
  };
  const orders = {
    orders: [{
      id: 'order-1',
      order_ref: 'A-100',
      product_name: 'Launch kit',
      quantity: 1,
      buyer_email: 'buyer@example.com',
      status: 'paid',
      created_at: '2026-08-03T10:00:00Z',
    }],
    summary: {
      revenue_cents: 4900,
      paid_orders: 1,
      pending_revenue_cents: 0,
    },
  };

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const rawBody = Buffer.concat(chunks).toString('utf8');
      requests.push({
        method: req.method,
        url: req.url,
        authorization: req.headers.authorization,
        body: rawBody ? JSON.parse(rawBody) : null,
      });
      res.setHeader('Content-Type', 'application/json');

      if (req.method === 'GET' && req.url === '/api/business/biz-1/dashboard') {
        res.end(JSON.stringify(dashboard));
        return;
      }
      if (req.method === 'GET' && /^\/api\/storefront\/biz-1\/orders\?limit=(5|50)$/.test(req.url)) {
        res.end(JSON.stringify(orders));
        return;
      }
      if (req.method === 'PUT' && req.url === '/api/storefront/biz-1/products') {
        res.end(JSON.stringify({ business_id: 'biz-1', name: 'Acme Co', products }));
        return;
      }

      res.statusCode = 404;
      res.end(JSON.stringify({ detail: `unexpected ${req.method} ${req.url}` }));
    });
  });

  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

test('business operation helpers preserve the web room data contract', () => {
  const normalized = normalizeOrdersPayload({
    data: {
      orders: [{
        order_number: 'A-9',
        product: { title: 'Research pack' },
        customer: { email: 'reader@example.com' },
        qty: '2',
        payment_status: 'pending',
        createdAt: '2026-08-04T09:00:00Z',
      }],
      summary: { revenue_cents: '12500', paid_orders: '3', pending_revenue_cents: 2500 },
    },
  });

  assert.equal(normalized.orders[0].reference, 'A-9');
  assert.equal(normalized.orders[0].product, 'Research pack');
  assert.equal(normalized.orders[0].buyer, 'reader@example.com');
  assert.equal(normalized.orders[0].quantity, 2);
  assert.equal(normalized.orders[0].isPreorder, true);
  assert.deepEqual(
    { revenueCents: normalized.revenueCents, paidOrders: normalized.paidOrders, pendingRevenueCents: normalized.pendingRevenueCents },
    { revenueCents: 12500, paidOrders: 3, pendingRevenueCents: 2500 },
  );
  assert.deepEqual(parseBusinessStoreArgs(['acme', 'on']), { action: 'on', slug: 'acme' });
  assert.deepEqual(parseBusinessStoreArgs(['status', 'acme']), { action: 'status', slug: 'acme' });
  assert.equal(readWalletNet({ config: { wallet_balance: 4200 } }), 4200);
  assert.deepEqual(readStorefront({ config: { storefront: { enabled: true, products: [{ id: 'p' }] } } }), {
    enabled: true,
    products: [{ id: 'p' }],
  });
});

test('business CLI reads the live room and enables the store through the web endpoints', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-business-ops-home-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-business-ops-work-'));
  const requests = [];
  const server = await startApi(requests);
  const address = server.address();
  writeCliState(home);
  const env = {
    ...process.env,
    HOME: home,
    ATRIS_API_URL: `http://127.0.0.1:${address.port}/api`,
    ATRIS_SKIP_UPDATE_CHECK: '1',
  };

  try {
    const room = await runCli(['business', 'room', 'acme'], { cwd, env });
    assert.equal(room.status, 0, room.stderr || room.stdout);
    assert.match(room.stdout, /business room: Acme Co/);
    assert.match(room.stdout, /wallet\/net: \$4,200/);
    assert.match(room.stdout, /members: 2/);
    assert.match(room.stdout, /apps: 2/);
    assert.match(room.stdout, /store: disabled, 1 products/);
    assert.match(room.stdout, /A-100: Launch kit x1, buyer@example\.com/);

    const productList = await runCli(['business', 'products', 'acme'], { cwd, env });
    assert.equal(productList.status, 0, productList.stderr || productList.stdout);
    assert.match(productList.stdout, /Launch kit \(prod-1\): \$49\.00/);

    const orderList = await runCli(['business', 'orders', 'acme'], { cwd, env });
    assert.equal(orderList.status, 0, orderList.stderr || orderList.stdout);
    assert.match(orderList.stdout, /orders: Acme Co \(1\)/);
    assert.match(orderList.stdout, /revenue: \$49\.00/);

    const store = await runCli(['business', 'store', 'on', 'acme'], { cwd, env });
    assert.equal(store.status, 0, store.stderr || store.stdout);
    assert.match(store.stdout, /store: enabled for Acme Co, 1 products/);

    assert.ok(requests.length >= 6);
    assert.ok(requests.every(request => request.authorization === 'Bearer test-token'));
    const update = requests.find(request => request.method === 'PUT');
    assert.deepEqual(update, {
      method: 'PUT',
      url: '/api/storefront/biz-1/products',
      authorization: 'Bearer test-token',
      body: {
        products: [{
          id: 'prod-1',
          name: 'Launch kit',
          desc: 'Everything needed to launch.',
          price_cents: 4900,
          currency: 'usd',
        }],
      },
    });
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
