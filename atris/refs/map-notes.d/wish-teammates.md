## Wish teammate names

DV2-134: `commands/wish.js` delegates its name checks to `lib/wish-audit.js`.
`lib/wish-audit.js:593` reuses `commands/member.js:4393` (`findAllMembers`),
the team roster's reader, to recognize display names before member ids and
file/folder slugs, ignoring case. Unknown names still ask.
Route: member files -> exact name match -> capture or question.
`test/wish-teammates.test.js:26` files real wishes for directory and flat members;
`test/wish-teammates.test.js:39` proves an unknown name still asks.
Proof: `node --test test/wish-teammates.test.js`, exit 0, tests 2, pass 2, fail 0.
Proof: `node --test test/wish*.test.js`, exit 0, tests 97, pass 97, fail 0.
Task lookup and claim could not write the shared database in this sandbox;
this note holds the objective and proof instead. No acceptance or push is authorized.
