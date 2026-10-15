# Leak audit of the mission tests

The two mission test files leave no ssh-agent and no orphaned Node behind, and the real landing status already names the startup line and the repair command.

Files: this receipt, atris/team/executor/logs/2026-10-15.md.

Method: listed every process before and after `node --test test/engine-resource.test.js test/engine-dispatch.test.js`, then repeated the run while listing only ssh-agent processes.

Result: both runs exited 0 with 168 passing and 0 failing. The second run added 0 ssh-agents. In the first run, the only new processes with no parent were two ssh-agents whose sockets sit in the real home folder and system indexing workers; the test shells use a temporary home, so those agents came from other sessions.

Real surface: `node bin/atris.js autoland status` exited 0 and printed 2332 leaked ssh-agents, up from 1524 at 2026-10-14 23:09 UTC, about 85 more an hour. It named ~/.zshrc line 1 as the likely source and printed the checkout command for the startup repair.

Out of scope: two orphaned Node processes started 2026-10-14 17:40 match fixtures in test/member-board.test.js. They were left running.

Open: the startup repair edits the real ~/.zshrc, so it waits for a person to run it.

next_push: Make the leaked agent count in the landing status also say how many the startup repair would prevent each hour, from the last hour of readings.

layer: behaviors
