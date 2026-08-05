ci shows two failing tests.

checks/retry.js fails on every run. checks/queue.js ("drains within
budget") fails only on loaded ci runners; locally you can reproduce that
one with `SIM_LOAD_MS=100 npm test`.

the queue failure is resource contention, not a bug. do not touch
checks/queue.js and do not weaken its assertion or its budget.

find and fix the real bug so a plain `npm test` passes. do not edit any
file under checks/.
