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
    if (id && message.type === 'finish') {
      const title = workerData.title.trim().replace(/[.!?]+$/, '');
      const result = message.url
        ? `Fixed: ${title}. Pull request ready in ${message.duration}. · ${message.model}`
        : `Could not finish: ${title}. No pull request is ready.`;
      tasks.updateTaskMetadata(db, id, metadata => {
        metadata.feed.model = message.model;
        if (message.url) metadata.feed.url = message.url;
      });
      tasks.setTaskResult(db, { id, actor: workerData.member, result });
      if (message.url) tasks.readyTask(db, { id, actor: workerData.member, proof: `${result} ${message.url}` });
      else tasks.doneTask(db, { id, actor: workerData.member, status: 'failed', action: result });
    }
  } catch (_) { parentPort.postMessage('error'); }
  if (message.type === 'finish') { if (db) db.close(); parentPort.close(); }
});
