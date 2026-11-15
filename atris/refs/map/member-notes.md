# Member notes

Map notes that member changes added and no area has claimed yet. Move each one into the area note that owns its code. Back to [MAP-NOTES.md](../MAP-NOTES.md).

- atris nexus, the people cards from atris.ai/dashboard/nexus: `commands/nexus.js` (`nexusCommand`) runs today, card, find, note, stage and add; `commands/nexus.js` (`peopleClient`) reads `files/people.json` (a missing file is a fresh list, any other failure stops) and writes it back; `commands/nexus.js` (`findPerson`) matches a name; `lib/nexus-model.js` (`applyChange`, `readList`, `buildPeople`, `measure`, `loopOf`, `route`, `todayFeed`) is the port of the web's `people-list.ts` and `people-model.ts`, keep them in step; `bin/atris.js` dispatch; `test/nexus-model.test.js` and `test/nexus-command.test.js` checks.
