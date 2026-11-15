// Keep task database work off the command's streaming path.
const { parentPort, workerData } = require('node:worker_threads');
if (!parentPort) return; // loaded outside its worker thread (a load check): nothing to do
const tasks = require('./task-db');
let db, id;
try {
  db = tasks.open(undefined, { shortWait: true });
  ({ id } = tasks.addTask(db, {
    title: workerData.title.slice(0, 80), workspaceRoot: tasks.workspaceRoot(workerData.root),
    status: 'claimed', claimedBy: workerData.member,
    metadata: { assigned_to: workerData.member, feed: { source: 'codeops', repo: workerData.repo, progress: [] } },
  }));
} catch (_) { parentPort.postMessage('error'); }
parentPort.on('message', (message) => {
  try {
    if (id && message.type === 'progress') {
      tasks.updateTaskMetadata(db, id, metadata => {
        metadata.feed.progress = [...metadata.feed.progress, { at: message.at, text: message.text, by: workerData.member }].slice(-20);
      });
    } else if (id && message.type === 'finish') {
      const result = message.url ? `Pull request ${message.url} · ${message.duration} · ${message.model}` : message.reason;
      tasks.setTaskResult(db, { id, actor: workerData.member, result });
      if (message.url) tasks.readyTask(db, { id, actor: workerData.member, proof: result });
      else tasks.doneTask(db, { id, actor: workerData.member, status: 'failed', action: result });
    }
  } catch (_) { parentPort.postMessage('error'); }
  if (message.type === 'finish') { if (db) db.close(); parentPort.close(); }
});
