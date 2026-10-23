// Campaign store: append-only events behind one small interface, with a
// SQLite adapter (one file per workspace) and an in-memory adapter for tests.
//
// Built so Campaign does not inherit the mission ledger's problems
// (atris/features/campaign/build.md Phase -1): every append is one
// transaction, events carry a unique id plus a per-origin sequence, writers
// can demand an expected version, and a corrupt row fails closed.

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
// task-db installs the narrow node:sqlite warning filter and owns the shared
// busy retry; load it before node:sqlite so the filter is in place.
const { withBusyRetry } = require('./task-db');
const { DatabaseSync } = require('node:sqlite');
const { mainCheckoutRoot } = require('./engine-registry');
const { validateEvent } = require('./campaign-schema');
const { fold } = require('./campaign-core');

// Any event naming a mission ties that mission to its campaign.
function missionIdOf(event) {
  return event.data && typeof event.data.mission_id === 'string' && event.data.mission_id ? event.data.mission_id : null;
}

function storeError(code, message) {
  const error = new Error(message || code);
  error.code = code;
  return error;
}

// The checkout holding root, so a call from a subfolder finds the same store.
function checkoutRoot(root) {
  let dir = path.resolve(root);
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(root);
    dir = parent;
  }
}

function campaignDbPath(root = process.cwd()) {
  if (process.env.ATRIS_CAMPAIGN_DB) return process.env.ATRIS_CAMPAIGN_DB;
  const checkout = checkoutRoot(root);
  const home = mainCheckoutRoot(checkout) || checkout;
  return path.join(home, '.atris', 'state', 'atris.db');
}

// Files a campaign owns (like a copied judge script) live beside the store.
function campaignFolder(campaignId, root = process.cwd()) {
  return path.join(path.dirname(campaignDbPath(root)), 'campaigns', campaignId);
}

function newCampaignId(title = '') {
  const slug = String(title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24).replace(/-+$/, '');
  const suffix = crypto.randomBytes(2).toString('hex');
  return slug ? `cmp-${slug}-${suffix}` : `cmp-${suffix}`;
}

function newOrigin() {
  return `c-${crypto.randomBytes(4).toString('hex')}`;
}

// Fill the fields the store owns, then validate the whole event.
function completeEvent(input, origin, seq, now) {
  const event = {
    id: input.id || `evt-${crypto.randomUUID()}`,
    campaign_id: input.campaign_id,
    type: input.type,
    at: input.at || now(),
    origin,
    seq,
    actor: input.actor,
    data: input.data || {},
  };
  const check = validateEvent(event);
  if (!check.ok) throw storeError('invalid_event', `invalid ${input.type || 'event'}: ${check.errors.join(', ')}`);
  return event;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS campaigns (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  origin TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  pos INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  campaign_id TEXT NOT NULL,
  origin TEXT NOT NULL,
  seq INTEGER NOT NULL,
  type TEXT NOT NULL,
  at TEXT NOT NULL,
  actor TEXT NOT NULL,
  data TEXT NOT NULL,
  UNIQUE (origin, seq)
);
CREATE INDEX IF NOT EXISTS events_by_campaign ON events (campaign_id, pos);
CREATE TABLE IF NOT EXISTS missions (
  mission_id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL
);
`;

function createSqliteStore(dbPath, options = {}) {
  const now = options.now || (() => new Date().toISOString());
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  let readOnly = false;
  let db;
  try {
    fs.accessSync(fs.existsSync(dbPath) ? dbPath : path.dirname(dbPath), fs.constants.W_OK);
    db = new DatabaseSync(dbPath);
    withBusyRetry(() => db.exec('PRAGMA journal_mode = WAL'));
    db.exec('PRAGMA busy_timeout = 30000');
    withBusyRetry(() => db.exec(SCHEMA));
    withBusyRetry(() => db.exec('PRAGMA user_version = 1'));
  } catch (error) {
    // A store someone can only read still shows its campaigns; writes say why they cannot.
    if (!fs.existsSync(dbPath)) throw error;
    if (db) try { db.close(); } catch {}
    db = new DatabaseSync(dbPath, { readOnly: true });
    readOnly = true;
  }

  const tx = (fn) => {
    if (readOnly) throw storeError('read_only', `the campaign store at ${dbPath} is read-only`);
    withBusyRetry(() => db.exec('BEGIN IMMEDIATE'));
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch {}
      throw error;
    }
  };

  const origin = readOnly ? ((db.prepare("SELECT value FROM meta WHERE key = 'origin'").get() || {}).value || 'read-only') : tx(() => {
    const row = db.prepare("SELECT value FROM meta WHERE key = 'origin'").get();
    if (row) return row.value;
    const value = options.origin || newOrigin();
    db.prepare("INSERT INTO meta (key, value) VALUES ('origin', ?)").run(value);
    return value;
  });

  const linkMission = (event) => {
    const missionId = missionIdOf(event);
    if (!missionId) return;
    const row = db.prepare('SELECT campaign_id FROM missions WHERE mission_id = ?').get(missionId);
    if (row && row.campaign_id !== event.campaign_id) {
      throw storeError('mission_in_other_campaign', `mission ${missionId} already belongs to ${row.campaign_id}`);
    }
    if (!row) db.prepare('INSERT INTO missions (mission_id, campaign_id) VALUES (?, ?)').run(missionId, event.campaign_id);
  };

  const insert = (event) => {
    db.prepare('INSERT INTO events (id, campaign_id, origin, seq, type, at, actor, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(event.id, event.campaign_id, event.origin, event.seq, event.type, event.at, event.actor, JSON.stringify(event.data));
  };

  const count = (campaignId) => db.prepare('SELECT COUNT(*) AS n FROM events WHERE campaign_id = ?').get(campaignId).n;

  const readEvents = (campaignId) => db.prepare('SELECT * FROM events WHERE campaign_id = ? ORDER BY pos').all(campaignId).map((row) => {
    let data;
    try {
      data = JSON.parse(row.data);
    } catch {
      throw storeError('corrupt_event', `event ${row.id} in ${campaignId} has unreadable data`);
    }
    return {
      id: row.id, campaign_id: row.campaign_id, type: row.type, at: row.at,
      origin: row.origin, seq: row.seq, actor: row.actor, data,
    };
  });

  return {
    kind: 'sqlite',
    path: dbPath,
    origin,
    readOnly,

    // Write a new event from this computer. options.expectedVersion is the
    // event count the writer last read; a mismatch refuses the write.
    append(input, appendOptions = {}) {
      return tx(() => {
        const campaignId = input.campaign_id;
        if (appendOptions.expectedVersion !== undefined && count(campaignId) !== appendOptions.expectedVersion) {
          throw storeError('version_conflict', `campaign ${campaignId} changed since version ${appendOptions.expectedVersion}`);
        }
        const exists = db.prepare('SELECT 1 FROM campaigns WHERE id = ?').get(campaignId);
        if (input.type === 'campaign_started' && exists) throw storeError('campaign_exists', `campaign ${campaignId} already started`);
        if (input.type !== 'campaign_started' && !exists) throw storeError('unknown_campaign', `no campaign ${campaignId}`);
        // A check that must see the campaign as it is at the moment of the
        // write, such as a budget reservation, runs inside this transaction.
        if (appendOptions.check) appendOptions.check(fold(readEvents(campaignId)));
        const last = db.prepare('SELECT MAX(seq) AS seq FROM events WHERE origin = ?').get(origin).seq || 0;
        const event = completeEvent(input, origin, last + 1, now);
        if (input.type === 'campaign_started') {
          db.prepare('INSERT INTO campaigns (id, created_at, origin) VALUES (?, ?, ?)').run(campaignId, event.at, origin);
        }
        linkMission(event);
        insert(event);
        return event;
      });
    },

    // Take an event written elsewhere (sync). Returns false for one already
    // held; a different event claiming the same origin and seq is refused.
    ingest(event) {
      const check = validateEvent(event);
      if (!check.ok) throw storeError('invalid_event', `invalid ${event && event.type}: ${check.errors.join(', ')}`);
      return tx(() => {
        if (db.prepare('SELECT 1 FROM events WHERE id = ?').get(event.id)) return false;
        const clash = db.prepare('SELECT id FROM events WHERE origin = ? AND seq = ?').get(event.origin, event.seq);
        if (clash) throw storeError('seq_conflict', `origin ${event.origin} seq ${event.seq} is already ${clash.id}`);
        if (event.type === 'campaign_started') {
          db.prepare('INSERT OR IGNORE INTO campaigns (id, created_at, origin) VALUES (?, ?, ?)').run(event.campaign_id, event.at, event.origin);
        }
        linkMission(event);
        insert(event);
        return true;
      });
    },

    read: readEvents,

    version: count,

    campaignIds() {
      return db.prepare('SELECT id FROM campaigns ORDER BY created_at, id').all().map((row) => row.id);
    },

    campaignForMission(missionId) {
      const row = db.prepare('SELECT campaign_id FROM missions WHERE mission_id = ?').get(missionId);
      return row ? row.campaign_id : null;
    },

    // Small notes the store keeps beside the events, such as a campaign's
    // cloud link and the last cloud seq pulled (lib/campaign-sync.js).
    getMeta(key) {
      const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
      return row ? row.value : null;
    },

    setMeta(key, value) {
      tx(() => db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value)));
    },

    close() {
      db.close();
    },
  };
}

function createMemoryStore(options = {}) {
  const now = options.now || (() => new Date().toISOString());
  const origin = options.origin || newOrigin();
  const events = [];
  const campaigns = new Map();
  const missions = new Map();
  const seqByOrigin = new Map();
  const meta = new Map();
  const eventIds = new Set();
  const firstByOriginSeq = new Map();
  let lookupIndexed = true;
  const { isProxy } = require('node:util').types;
  const indexable = (event) => {
    // Reflection must not add caller Proxy traps or evaluate any getters.
    if (isProxy(event) || event === null || typeof event !== 'object' || Object.getPrototypeOf(event) !== Object.prototype) return false;
    const id = Object.getOwnPropertyDescriptor(event, 'id');
    const origin = Object.getOwnPropertyDescriptor(event, 'origin');
    const seq = Object.getOwnPropertyDescriptor(event, 'seq');
    return id && Object.hasOwn(id, 'value') && typeof id.value === 'string'
      && origin && Object.hasOwn(origin, 'value') && typeof origin.value === 'string'
      && seq && Object.hasOwn(seq, 'value') && Number.isInteger(seq.value) && seq.value >= 1;
  };

  const clone = (value) => JSON.parse(JSON.stringify(value));
  const count = (campaignId) => events.filter((e) => e.campaign_id === campaignId).length;
  const checkMission = (event) => {
    const missionId = missionIdOf(event);
    if (!missionId) return;
    const owner = missions.get(missionId);
    if (owner && owner !== event.campaign_id) {
      throw storeError('mission_in_other_campaign', `mission ${missionId} already belongs to ${owner}`);
    }
  };
  const commit = (event) => {
    const missionId = missionIdOf(event);
    if (missionId && !missions.has(missionId)) missions.set(missionId, event.campaign_id);
    seqByOrigin.set(event.origin, Math.max(seqByOrigin.get(event.origin) || 0, event.seq));
    events.push(clone(event));
    if (lookupIndexed) {
      // Index the row actually stored, after any reentrant toJSON commits.
      const stored = events[events.length - 1];
      if (!indexable(stored)) {
        lookupIndexed = false;
      } else {
        eventIds.add(stored.id);
        let sequences = firstByOriginSeq.get(stored.origin);
        if (!sequences) firstByOriginSeq.set(stored.origin, sequences = new Map());
        if (!sequences.has(stored.seq)) sequences.set(stored.seq, stored);
      }
    }
  };

  return {
    kind: 'memory',
    path: null,
    origin,
    append(input, appendOptions = {}) {
      const campaignId = input.campaign_id;
      if (appendOptions.expectedVersion !== undefined && count(campaignId) !== appendOptions.expectedVersion) {
        throw storeError('version_conflict', `campaign ${campaignId} changed since version ${appendOptions.expectedVersion}`);
      }
      if (input.type === 'campaign_started' && campaigns.has(campaignId)) throw storeError('campaign_exists', `campaign ${campaignId} already started`);
      if (input.type !== 'campaign_started' && !campaigns.has(campaignId)) throw storeError('unknown_campaign', `no campaign ${campaignId}`);
      if (appendOptions.check) appendOptions.check(fold(events.filter((e) => e.campaign_id === campaignId)));
      const event = completeEvent(input, origin, (seqByOrigin.get(origin) || 0) + 1, now);
      checkMission(event);
      if (input.type === 'campaign_started') campaigns.set(campaignId, event.at);
      commit(event);
      return clone(event);
    },
    ingest(event) {
      const check = validateEvent(event);
      if (!check.ok) throw storeError('invalid_event', `invalid ${event && event.type}: ${check.errors.join(', ')}`);
      let clash;
      if (lookupIndexed && indexable(event)) {
        if (eventIds.has(event.id)) return false;
        clash = firstByOriginSeq.get(event.origin)?.get(event.seq);
      } else {
        if (events.some((e) => e.id === event.id)) return false;
        clash = events.find((e) => e.origin === event.origin && e.seq === event.seq);
      }
      if (clash) throw storeError('seq_conflict', `origin ${event.origin} seq ${event.seq} is already ${clash.id}`);
      checkMission(event);
      if (event.type === 'campaign_started' && !campaigns.has(event.campaign_id)) campaigns.set(event.campaign_id, event.at);
      commit(event);
      return true;
    },
    read(campaignId) {
      return events.filter((e) => e.campaign_id === campaignId).map(clone);
    },
    version: count,
    campaignIds() {
      return [...campaigns.entries()].sort((a, b) => (a[1] === b[1] ? (a[0] < b[0] ? -1 : 1) : (a[1] < b[1] ? -1 : 1))).map(([id]) => id);
    },
    campaignForMission(missionId) {
      return missions.get(missionId) || null;
    },
    getMeta(key) {
      return meta.has(key) ? meta.get(key) : null;
    },
    setMeta(key, value) {
      meta.set(key, String(value));
    },
    close() {},
  };
}

const openStores = new Map();

function openCampaignStore(root = process.cwd()) {
  const dbPath = campaignDbPath(root);
  if (!openStores.has(dbPath)) openStores.set(dbPath, createSqliteStore(dbPath));
  return openStores.get(dbPath);
}

function closeCampaignStores() {
  for (const store of openStores.values()) store.close();
  openStores.clear();
}

function getCampaign(storeOrRoot, campaignId) {
  const store = typeof storeOrRoot === 'string' ? openCampaignStore(storeOrRoot) : storeOrRoot;
  const events = store.read(campaignId);
  if (events.length === 0) return null;
  return fold(events);
}

// One unreadable campaign never hides the others: it comes back as { id, error }.
function listCampaigns(storeOrRoot) {
  const store = typeof storeOrRoot === 'string' ? openCampaignStore(storeOrRoot) : storeOrRoot;
  return store.campaignIds().map((id) => {
    try {
      const view = fold(store.read(id));
      return view.error ? { id, error: view.error } : view;
    } catch (error) {
      return { id, error: error.code || error.message };
    }
  });
}

module.exports = {
  campaignDbPath,
  campaignFolder,
  closeCampaignStores,
  createMemoryStore,
  createSqliteStore,
  getCampaign,
  listCampaigns,
  newCampaignId,
  openCampaignStore,
};
