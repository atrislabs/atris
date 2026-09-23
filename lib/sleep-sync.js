'use strict';

// Block the current thread for ms milliseconds without burning a core.
// Atomics.wait parks the thread; a Date.now() loop keeps it at full CPU.
function sleepSync(ms) {
  const duration = Math.max(0, Number(ms) || 0);
  if (!duration) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, duration);
}

module.exports = { sleepSync };
