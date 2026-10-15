# Landing status counts only the last day of lost run closes

The landing status line about runs closed after their parent died now counts only closes from the last 24 hours, and says so. Closes older than a day stay in the log but no longer show up as if they just happened.

- test first: the rewritten test failed at "closes older than a day do not read as current" before the change
- verifier: `node --test test/engine-resource.test.js test/engine-dispatch.test.js`, 81 pass, 0 fail, exit 0
- real run in a scratch project. With only a close from 3 days ago, the real `atris autoland status` printed no lost run line, exit 0. After a parent got SIGKILL and the landing pass step closed its run, the same command printed "engine runs closed after their parent died in the last day: 1, newest cursor on LOST at 2026-10-14 13:38 UTC", exit 0.

next_push: name low memory vs unknown cause for the newest SIGKILL in the landing status, the same way the sweep does.
