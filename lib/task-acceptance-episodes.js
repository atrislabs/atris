'use strict';

// Optional private extension. It records intended append bytes, not append success.
const crypto = require('node:crypto');
const MAX_EPISODE_BYTES = 1024 * 1024;
const TABLE = 'task_acceptance_episodes';
const definitions = [
  ['table', TABLE, `CREATE TABLE task_acceptance_episodes (event_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, workspace_root TEXT NOT NULL, episode_bytes BLOB NOT NULL, sha256 TEXT NOT NULL)`],
  ['trigger', `${TABLE}_no_delete`, `CREATE TRIGGER task_acceptance_episodes_no_delete BEFORE DELETE ON task_acceptance_episodes BEGIN SELECT RAISE(ABORT, 'acceptance episodes are immutable'); END`],
  ['trigger', `${TABLE}_no_replace`, `CREATE TRIGGER task_acceptance_episodes_no_replace BEFORE INSERT ON task_acceptance_episodes WHEN EXISTS (SELECT 1 FROM task_acceptance_episodes WHERE event_id = NEW.event_id) BEGIN SELECT RAISE(ABORT, 'acceptance episodes are immutable'); END`],
  ['trigger', `${TABLE}_no_update`, `CREATE TRIGGER task_acceptance_episodes_no_update BEFORE UPDATE ON task_acceptance_episodes BEGIN SELECT RAISE(ABORT, 'acceptance episodes are immutable'); END`],
];
const names = definitions.map(x => x[1]);
const normalize = sql => sql === null ? null : sql.replace(/\s+/g, ' ').trim();
function checkSchema(db, create) {
  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (![2, 3, 4].includes(version)) throw new Error('Unsupported acceptance episode schema version');
  const shadows = db.prepare("SELECT 1 FROM temp.sqlite_schema WHERE lower(name) IN ('tasks','task_events','task_acceptance_episodes') OR lower(tbl_name) IN ('tasks','task_events','task_acceptance_episodes') LIMIT 1").get();
  if (shadows) throw new Error('Unsupported temporary task schema');
  // Never materialize unbounded schema text or an unbounded number of objects.
  // Oversized values return NULL plus a false bounded flag and fail closed.
  const query = () => db.prepare(`SELECT
      CASE WHEN typeof(type)='text' AND length(CAST(type AS BLOB))<=256 THEN type END AS type,
      CASE WHEN typeof(name)='text' AND length(CAST(name AS BLOB))<=256 THEN name END AS name,
      CASE WHEN typeof(tbl_name)='text' AND length(CAST(tbl_name AS BLOB))<=256 THEN tbl_name END AS tbl_name,
      CASE WHEN sql IS NULL OR (typeof(sql)='text' AND length(CAST(sql AS BLOB))<=16384) THEN sql END AS sql,
      (typeof(type)='text' AND length(CAST(type AS BLOB))<=256 AND
       typeof(name)='text' AND length(CAST(name AS BLOB))<=256 AND
       typeof(tbl_name)='text' AND length(CAST(tbl_name AS BLOB))<=256 AND
       (sql IS NULL OR (typeof(sql)='text' AND length(CAST(sql AS BLOB))<=16384))) AS bounded
    FROM main.sqlite_schema WHERE tbl_name = ? OR name IN (${names.map(() => '?').join(',')})
    ORDER BY type, name LIMIT 6`).all(TABLE, ...names);
  let rows = query();
  if (!rows.length) {
    if (!create) return false;
    for (const [type, , sql] of definitions) db.exec(sql.replace(type === 'table' ? 'CREATE TABLE ' : 'CREATE TRIGGER ', type === 'table' ? 'CREATE TABLE main.' : 'CREATE TRIGGER main.'));
    rows = query();
  }
  const expected = [
    ['index', `sqlite_autoindex_${TABLE}_1`, TABLE, null],
    ...definitions.map(([type, name, sql]) => [type, name, TABLE, normalize(sql)]),
  ].sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0);
  if (rows.length !== expected.length || rows.some((row, i) =>
    row.bounded !== 1 || row.type !== expected[i][0] || row.name !== expected[i][1] || row.tbl_name !== expected[i][2] || normalize(row.sql) !== expected[i][3]))
    throw new Error('Unsupported acceptance episode schema');
  return true;
}
function serialize(episode) {
  const bytes = Buffer.from(JSON.stringify(episode) + '\n', 'utf8');
  if (bytes.length > MAX_EPISODE_BYTES) throw new Error('Acceptance episode exceeds size limit');
  return bytes;
}
function digest(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function validIdentity(value) {
  return typeof value === 'string' && value.length > 0 && !value.includes('\0') &&
    Buffer.byteLength(value, 'utf8') <= 16384 && Buffer.from(value, 'utf8').toString('utf8') === value;
}
function validateBytes(bytes, eventId, taskId, workspaceRoot, version) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_EPISODE_BYTES) throw new Error('Invalid saved acceptance episode');
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (!text.endsWith('\n') || text.slice(0, -1).includes('\n')) throw new Error('Invalid saved acceptance episode');
  const episode = JSON.parse(text);
  if (episode.schema !== 'atris.task_episode.v1' || episode.episode_id !== eventId || episode.task_id !== taskId || episode.workspace_root !== workspaceRoot ||
      episode.action?.event_type !== 'reviewed' || episode.action?.version !== version)
    throw new Error('Invalid saved acceptance episode');
}

// Called only inside the acceptance transaction.
function save(db, event, workspaceRoot, bytes) {
  if (!event || event.event_type !== 'reviewed' || ![event.event_id, event.task_id, workspaceRoot].every(validIdentity) || event.workspace_root !== workspaceRoot)
    throw new Error('Invalid acceptance episode');
  validateBytes(bytes, event.event_id, event.task_id, workspaceRoot, event.version);
  checkSchema(db, true);
  db.prepare('INSERT INTO main.task_acceptance_episodes (event_id, task_id, workspace_root, episode_bytes, sha256) VALUES (?, ?, ?, ?, ?)').run(event.event_id, event.task_id, workspaceRoot, bytes, digest(bytes));
}
// Exact IDs and workspace are mandatory. Missing is unavailable, never evidence
// of a failed or successful file append. This function performs no replay.
function inspect(db, { eventId, taskId, workspaceRoot } = {}) {
  if (![eventId, taskId, workspaceRoot].every(validIdentity)) throw new Error('Exact acceptance episode identity required');
  db.exec('BEGIN');
  try {
    if (!checkSchema(db, false)) { db.exec('COMMIT'); return null; }
    const rows = db.prepare(`SELECT typeof(s.episode_bytes) AS bytes_type, length(s.episode_bytes) AS bytes_length,
      substr(s.episode_bytes, 1, ?) AS episode_bytes, substr(s.sha256, 1, 65) AS sha256,
      typeof(s.sha256) AS digest_type, length(s.sha256) AS digest_length,
      (typeof(e.event_type)='text' AND CAST(e.event_type AS BLOB)=CAST('reviewed' AS BLOB)) AS event_type_ok,
      e.version AS event_version,
      (typeof(e.event_id)='text' AND CAST(e.event_id AS BLOB)=CAST(? AS BLOB)) AS event_id_ok,
      (typeof(t.id)='text' AND CAST(t.id AS BLOB)=CAST(? AS BLOB)) AS task_id_ok,
      (typeof(e.task_id)='text' AND CAST(e.task_id AS BLOB)=CAST(? AS BLOB)) AS event_task_ok,
      (typeof(e.workspace_root)='text' AND CAST(e.workspace_root AS BLOB)=CAST(? AS BLOB)) AS event_workspace_ok,
      (typeof(t.workspace_root)='text' AND CAST(t.workspace_root AS BLOB)=CAST(? AS BLOB)) AS task_workspace_ok
      FROM main.task_acceptance_episodes s LEFT JOIN main.task_events e ON e.event_id=s.event_id
      LEFT JOIN main.tasks t ON t.id=s.task_id WHERE s.event_id=? AND s.task_id=? AND s.workspace_root=?
      AND typeof(s.event_id)='text' AND CAST(s.event_id AS BLOB)=CAST(? AS BLOB)
      AND typeof(s.task_id)='text' AND CAST(s.task_id AS BLOB)=CAST(? AS BLOB)
      AND typeof(s.workspace_root)='text' AND CAST(s.workspace_root AS BLOB)=CAST(? AS BLOB) LIMIT 2`).all(
      MAX_EPISODE_BYTES + 1, eventId, taskId, taskId, workspaceRoot, workspaceRoot,
      eventId, taskId, workspaceRoot, eventId, taskId, workspaceRoot);
    if (!rows.length) { db.exec('COMMIT'); return null; }
    if (rows.length !== 1) throw new Error('Invalid saved acceptance episode');
    const row = rows[0];
    const bytes = Buffer.from(row.episode_bytes || []);
    if (!Buffer.isBuffer(row.episode_bytes) && !(row.episode_bytes instanceof Uint8Array)) throw new Error('Invalid saved acceptance episode');
    if (row.bytes_type !== 'blob' || row.bytes_length !== bytes.length || !bytes.length || bytes.length > MAX_EPISODE_BYTES || row.digest_type !== 'text' || row.digest_length !== 64 || !/^[a-f0-9]{64}$/.test(row.sha256) || digest(bytes) !== row.sha256 ||
        row.event_type_ok !== 1 || row.event_id_ok !== 1 || row.task_id_ok !== 1 || row.event_task_ok !== 1 || row.event_workspace_ok !== 1 || row.task_workspace_ok !== 1)
      throw new Error('Invalid saved acceptance episode');
    validateBytes(bytes, eventId, taskId, workspaceRoot, row.event_version);
    db.exec('COMMIT');
    return bytes;
  } catch (error) { try { db.exec('ROLLBACK'); } catch (_) {} throw error; }
}
module.exports = { serialize, save, inspect, MAX_EPISODE_BYTES };
