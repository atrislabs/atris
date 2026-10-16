# Hand-written defaults refused

Agents can no longer close a campaign question by hand and pass it off as the default answer. The manual event command now refuses it, just as it refuses hand-written answers.

proof:
- `atris campaign event cmp-g ask_defaulted --data '{"ask_id":"a-x","answer":"Citewise"}' --as builder` -> "ask_defaulted cannot be written by hand; use atris campaign ask --default, which closes on its own once the wait is up", exit 2. Campaign screen still lists "Which name?" as open.
- `cd /tmp/cli-a && node --test test/campaign-ask-wait.test.js test/campaign-command.test.js` -> pass 26, fail 0, exit 0 (was 25 pass, 1 fail before).

next_push: have the campaign loop record a real default event, as the system actor, when due questions should take their defaults.
