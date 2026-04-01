const fs = require('fs');
const path = require('path');
const { loadCredentials } = require('../utils/auth');
const { apiRequestJson } = require('../utils/api');

function resolveSlug() {
  let slug = process.argv[3];
  if (!slug || slug.startsWith('-')) {
    const bizFile = path.join(process.cwd(), '.atris', 'business.json');
    if (fs.existsSync(bizFile)) {
      try {
        const biz = JSON.parse(fs.readFileSync(bizFile, 'utf8'));
        slug = biz.slug || biz.name;
      } catch {}
    }
    if (!slug || slug.startsWith('-')) slug = null;
  }
  return slug;
}

async function sleepAtris() {
  const slug = resolveSlug();

  if (!slug || slug === '--help') {
    console.log('Usage: atris sleep [business]');
    console.log('');
    console.log('  Pause a workspace to save compute. Storage only.');
    process.exit(0);
  }

  const creds = loadCredentials();
  if (!creds || !creds.token) { console.error('Not logged in. Run: atris login'); process.exit(1); }

  const result = await apiRequestJson(`/workspace/${slug}/sleep`, {
    method: 'POST',
    token: creds.token,
  });

  if (!result.ok) {
    console.error(`Failed to sleep workspace: ${result.error || result.status}`);
    process.exit(1);
  }

  console.log(`Workspace '${slug}' is now sleeping. Context saved. Wake it with: atris wake ${slug}`);
  console.log('Compute paused. Storage only — pennies/day.');
}

async function wakeAtris() {
  const slug = resolveSlug();

  if (!slug || slug === '--help') {
    console.log('Usage: atris wake [business]');
    console.log('');
    console.log('  Wake a sleeping workspace. Agents resume automatically.');
    process.exit(0);
  }

  const creds = loadCredentials();
  if (!creds || !creds.token) { console.error('Not logged in. Run: atris login'); process.exit(1); }

  const result = await apiRequestJson(`/workspace/${slug}/wake`, {
    method: 'POST',
    token: creds.token,
  });

  if (!result.ok) {
    console.error(`Failed to wake workspace: ${result.error || result.status}`);
    process.exit(1);
  }

  console.log(`Waking '${slug}'...`);

  const maxWait = 30000;
  const interval = 2000;
  const start = Date.now();

  while (Date.now() - start < maxWait) {
    await new Promise(r => setTimeout(r, interval));

    const status = await apiRequestJson(`/workspace/${slug}/status`, {
      method: 'GET',
      token: creds.token,
    });

    if (status.ok && status.data && status.data.status === 'running') {
      console.log(`Workspace '${slug}' is alive. Agents resuming.`);
      return;
    }
  }

  console.log('Still starting up. Check with: atris status');
}

module.exports = { sleepAtris, wakeAtris };
