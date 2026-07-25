/**
 * atris gift — buy a gift card from the command line.
 *
 * Talks to the Agentic Commerce Protocol endpoints on the Atris backend. This
 * file is an HTTP client and nothing more: the endpoints are the product, so
 * no logic that decides anything about a purchase lives here.
 *
 *   atris gift rails
 *   atris gift catalog
 *   atris gift airbnb --to a@b.com --amount 100 --name "Saurav & Sailee" \
 *                     --message "congratulations" --from Keshav
 *
 * The purchase flow follows ACP exactly: open a session, patch it until it is
 * ready for payment, present a scoped authorization as a shared payment token,
 * complete. The authorization is minted by a human-authenticated call, so the
 * CLI can never move money on its own.
 */

const API_BASE = (process.env.ATRIS_API_BASE || 'https://api.atris.ai').replace(/\/+$/, '');

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
};

function authHeaders() {
  const token = process.env.ATRIS_API_KEY;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function api(method, path, body, extraHeaders = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(),
      ...extraHeaders,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  let json = {};
  try {
    json = await res.json();
  } catch {
    // Non-JSON error bodies still carry a useful status code.
  }
  return { status: res.status, json };
}

function parseFlags(args) {
  const flags = {};
  for (let i = 0; i < args.length; i += 1) {
    if (!args[i].startsWith('--')) continue;
    const key = args[i].slice(2);
    const next = args[i + 1];
    if (next === undefined || next.startsWith('--')) {
      flags[key] = true;
    } else {
      flags[key] = next;
      i += 1;
    }
  }
  return flags;
}

/** Explains what each rail verdict means, in words a person can act on. */
const RAIL_MEANING = {
  available: 'ready',
  geo_blocked: 'refuses this location',
  fraud_beacon_required: 'needs a tracker that blockers block',
  no_agent_api: 'no way in for software',
  not_configured: 'not set up',
  insufficient_funds: 'out of money',
  unreachable: 'not responding',
};

async function showRails() {
  const { status, json } = await api('GET', '/api/agentic-commerce/rails');
  if (status !== 200) {
    console.log(c.red(`Could not reach ${API_BASE} (HTTP ${status}).`));
    return 1;
  }
  console.log(`\n${c.bold('Fulfillment rails')} ${c.dim(API_BASE)}\n`);
  for (const rail of json.rails || []) {
    const mark = rail.usable ? c.green('●') : c.red('●');
    const meaning = RAIL_MEANING[rail.status] || rail.status;
    console.log(`  ${mark} ${c.bold(rail.rail_id.padEnd(24))} ${meaning}`);
    console.log(`    ${c.dim(rail.detail)}`);
    if (rail.evidence && Object.keys(rail.evidence).length) {
      console.log(`    ${c.dim(JSON.stringify(rail.evidence))}`);
    }
    console.log('');
  }
  return 0;
}

async function showCatalog() {
  const { status, json } = await api('GET', '/api/agentic-commerce/catalog');
  if (status !== 200) {
    console.log(c.red(`Could not reach ${API_BASE} (HTTP ${status}).`));
    return 1;
  }
  console.log(`\n${c.bold('Gift card designs')} ${c.dim(`ACP ${json.protocol_version}`)}\n`);
  for (const d of json.designs || []) {
    console.log(`  ${c.bold(d.design_id.padEnd(10))} ${d.name}`);
    console.log(`  ${' '.repeat(10)} ${c.dim(d.denominations_usd.map((v) => `$${v}`).join(' · '))}`);
    console.log('');
  }
  return 0;
}

function fail(message, hint) {
  console.log(`\n${c.red('✗')} ${message}`);
  if (hint) console.log(`  ${c.dim(hint)}`);
  console.log('');
  return 1;
}

async function buyAirbnb(args) {
  const flags = parseFlags(args);
  const amount = parseInt(flags.amount, 10);
  const to = flags.to;
  const name = flags.name || flags.to;

  if (!to || !amount) {
    return fail(
      'Need at least --to and --amount.',
      'atris gift airbnb --to a@b.com --amount 100 --name "Saurav & Sailee"'
    );
  }
  if (!process.env.ATRIS_API_KEY) {
    return fail(
      'ATRIS_API_KEY is not set.',
      'Payment authorization is human-authenticated, so the CLI cannot mint one without it.'
    );
  }

  // 1. Open the session.
  const created = await api('POST', '/acp/checkout_sessions', {
    item: { design_id: flags.design || 'wedding', amount_usd: amount },
    recipient_name: name,
    recipient_email: to,
    message: flags.message || '',
    sender_name: flags.from || '',
    send_date: flags.send || null,
  });

  if (created.status !== 200) {
    return fail(created.json.message || `Could not open a session (HTTP ${created.status}).`);
  }

  let session = created.json;
  console.log(`\n${c.dim('session')}  ${session.id}`);

  const total = (session.totals || []).find((t) => t.type === 'total');
  console.log(`${c.dim('total')}    $${((total?.amount || 0) / 100).toFixed(2)}`);

  if (session.status !== 'ready_for_payment') {
    const why = (session.messages || []).map((m) => m.content).join(' ');
    return fail(`Session is ${session.status}.`, why);
  }

  // 2. Mint a scoped, single-use authorization. This is the human interlock:
  //    it is bounded by amount and expiry and cannot be reused.
  const auth = await api('POST', '/api/agentic-commerce/authorizations', {
    max_amount_usd: amount,
    issued_via: `atris gift cli, ${new Date().toISOString()}`,
  });

  if (auth.status === 401) {
    return fail('Not authorized.', 'ATRIS_API_KEY was rejected by the backend.');
  }
  if (auth.status !== 200) {
    return fail(auth.json.message || `Could not authorize (HTTP ${auth.status}).`);
  }
  console.log(`${c.dim('grant')}    ${auth.json.grant_id} ${c.dim(`(max $${auth.json.max_amount_minor / 100})`)}`);

  // 3. Settle. Idempotency-Key means a retried command cannot double-charge.
  console.log(`\n${c.dim('settling…')}`);
  const done = await api(
    'POST',
    `/acp/checkout_sessions/${session.id}/complete`,
    { payment_data: auth.json.payment_data_example },
    { 'Idempotency-Key': `${session.id}-complete` }
  );

  if (done.status !== 200) {
    return fail(done.json.message || `Completion failed (HTTP ${done.status}).`);
  }

  session = done.json;

  if (session.status === 'completed') {
    console.log(`\n${c.green('✓')} ${c.bold('Purchased.')}`);
    console.log(`  order   ${session.order.id}`);
    console.log(`  total   $${(session.order.total / 100).toFixed(2)}`);
    console.log(`  to      ${to}`);
    console.log(`\n  ${c.dim(`receipt: atris gift receipt ${session.id}`)}\n`);
    return 0;
  }

  // Every rail refused. Print why, per rail, because that is the useful part.
  console.log(`\n${c.yellow('!')} ${c.bold('No rail could complete this.')}\n`);
  for (const m of session.messages || []) {
    console.log(`  ${c.dim('·')} ${m.content}`);
  }
  console.log('');
  return 1;
}

async function showReceipt(args) {
  const sessionId = args[0];
  if (!sessionId) return fail('Need a session id.', 'atris gift receipt cs_...');

  const { status, json } = await api(
    'GET',
    `/api/agentic-commerce/sessions/${sessionId}/receipt`
  );
  if (status === 401) return fail('Not authorized.', 'Set ATRIS_API_KEY.');
  if (status !== 200) return fail(`No receipt (HTTP ${status}).`);

  console.log(`\n${c.bold('Receipt')} ${c.dim(sessionId)}`);
  console.log(
    `${c.dim('signatures')} ${json.all_signatures_valid ? c.green('all valid') : c.red('INVALID')}\n`
  );
  for (const e of json.entries || []) {
    console.log(`  ${String(e.sequence).padStart(2)}. ${c.bold(e.step.padEnd(20))} ${c.dim(`→ ${e.status_after}`)}`);
  }
  console.log('');
  return 0;
}

function showHelp() {
  console.log(`
${c.bold('atris gift')} — buy a gift card from the command line

  ${c.bold('atris gift rails')}                 which fulfillment rails work right now
  ${c.bold('atris gift catalog')}               designs and denominations
  ${c.bold('atris gift airbnb')} [flags]        buy and send an Airbnb gift card
  ${c.bold('atris gift receipt')} <session>     signed receipt for a session

  Flags for ${c.bold('airbnb')}:
    --to        recipient email            ${c.dim('(required)')}
    --amount    whole US dollars           ${c.dim('(required)')}
    --name      recipient name
    --message   note to include
    --from      sender name
    --design    ${c.dim('wedding | beach | cabin')}

  ${c.dim(`API: ${API_BASE}`)}
  ${c.dim('ATRIS_API_KEY is required to authorize payment.')}
`);
  return 0;
}

async function giftCommand(args = []) {
  const sub = args[0];
  const rest = args.slice(1);

  switch (sub) {
    case 'rails':
      return showRails();
    case 'catalog':
      return showCatalog();
    case 'airbnb':
      return buyAirbnb(rest);
    case 'receipt':
      return showReceipt(rest);
    default:
      return showHelp();
  }
}

module.exports = { giftCommand };
