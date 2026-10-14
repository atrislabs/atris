# Landing status shows runs closed after their parent died

The landing status readout now prints how many engine runs were closed because the process that started them died, and names the newest one with its engine, task, and time. It counts from the resource log, so runs closed by a manual sweep and by the hourly pass both show. With none, the line stays out.

- test first: the new test failed because the readout had no such line; the quiet case already held
- verifier: `node --test test/engine-resource.test.js test/engine-dispatch.test.js`, 81 pass, 0 fail, exit 0
- one older test pinned the exact empty history shape; it now includes the two new fields
- real run in a scratch project: a parent got SIGKILL after its start line, the landing pass step closed it, then the real `atris autoland status` printed "engine runs closed after their parent died: 1, newest cursor on LOST at 2026-10-14 13:32 UTC", exit 0

next_push: count only the last day of closed lost runs in the status line, so an old close does not read as current.
