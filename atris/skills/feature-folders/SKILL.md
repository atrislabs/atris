---
name: feature-folders
description: Break a giant source file into feature folders, each with a named owner from the team. Prove nothing changed without running the app. Move code with a tool that parses the file, never by hand. Use when one file has grown too big for agents to read or edit safely. Triggers on split a big file, decompose, file too big, modularize, monolith, feature folders, main.js too big, organize code by feature.
version: 1.0.0
tags:
  - refactor
  - architecture
  - ownership
  - proof
---

# Feature folders

A file with tens of thousands of lines has no owner. Every agent edits it, nobody can read it whole and every change risks a neighbour. Splitting it by feature gives each part a home and a person who answers for it.

The split must change nothing. The proof is a text rebuild, not a feeling.

## The real run

On 2026-11-16 the desktop app's `main.js` went from 37,560 lines to 8,529. About 29,000 lines moved into 17 folders under `src/features/` (browser, engines, voice, payments, team, core, smoke and others). Each folder got a README naming its owner. It landed as one pull request after a script did every move and a rebuild showed the old file came back exactly, apart from blank lines.

What made it work: one tool did all the moving, the rules for what may move were strict and the proof was mechanical.

## The short version

1. One script parses the file and does every move.
2. Move only functions and inline request handlers that do not run at load time.
3. Give each piece a feature folder and each folder an owner.
4. Rebuild the old file from the new ones and diff. Only blank lines may differ.
5. Run the related checks on your branch and on the published code. Only new failures count.

## Before you start

- Work in a short-lived copy (`atris worktree start`), never the main checkout.
- Freeze the original file. Copy it somewhere read-only. Every proof compares against this copy.
- Read `atris/team/` so you know who can own what.

## 1. Move with a tool

Never move code by hand. Never let several agents edit the big file at once. Hand moves drop a line. Parallel edits collide.

Write one script that parses the file. The TypeScript compiler API parses plain JS fine. For every top-level statement, record:

- the names it declares
- the top-level names it reads
- the top-level names it assigns

This table drives every later step.

## 2. Decide what may move

Safe to move:

- function declarations
- request handler registrations whose callback is written inline, like `ipcMain.handle('app:save', async () => {...})`

Keep in place:

- anything reachable from code that runs while the file is still loading
- anything that reads a top-level variable reassigned later (a moved copy would hold a stale value)
- anything that assigns a top-level name

Callbacks handed to an event, ready or timer host run later, not during load. They do not pin code in place.

## 3. Assign each piece to a feature

In this order:

- Handlers go by their request name (`app:browser-navigate` goes to browser).
- Functions go to the feature whose handlers reach them.
- Still unplaced, go by name.
- Pieces many features share go to `core`.
- The app's own self-tests go to `smoke`.

Look at the result before writing anything. A folder of 40 unrelated functions means the rules need another pass.

## 4. Write each piece byte for byte

Copy the statement text exactly. Then wire it:

- **Borrowed names.** Each new file declares the names it borrows and receives them through one function, `bindMain(deps)`. The main file calls every `bindMain` as its very last startup step.
- **Handlers.** Each new file exports `registerIpc(ipcMain)`. The main file calls it where the first moved handler used to sit. Registration order stays the same.
- **Direct requires.** A folder requires another folder directly only when the two do not depend on each other in a loop. Loops go through `bindMain`.
- **Path globals.** `__dirname` means a different folder now. Replace it with a named value the main file sets, like `MAIN_DIR`.
- **Relative requires.** Rewrite `require('./src/lib/x.cjs')` so it still points at the same file from the new folder.

A tiny example of the top of a moved file:

```js
let apiJson, isTrustedSender;
function bindMain(deps) { ({ apiJson, isTrustedSender } = deps); }
function registerIpc(ipcMain) {
  // moved handlers, unchanged
}
module.exports = { bindMain, registerIpc };
```

## 5. Name the owners

- Each folder gets a README: what it is, its owner (a member from `atris/team/`), its requests, its functions and which folders it uses.
- One index README lists every folder with its owner.
- Each owner's MEMBER.md points at its folder.
- Shared `core` code has no single owner. Its README says a change needs a look from the owners of the folders that use it.
- Lower the big file's line limit in its size check so it cannot grow back. In the real run the limit went to 9,500.

## 6. Prove nothing changed, without running the app

All of these must pass:

- **Rebuild.** Keep an order file listing every statement key in its original position. Put the moved pieces back between their old neighbours, undo the renames (`MAIN_DIR` back to `__dirname`, requires back to their old paths) and diff against the frozen original. Only blank lines may differ.
- **Syntax.** Every file passes `node --check`.
- **Loads.** Every new file loads and exports what the main file asks of it.
- **Unresolved names.** Count names used but never defined, before and after. The count must match. A rise means a borrowed name is missing from some `bindMain` list.

Then hand a fresh reviewer a read-only frozen copy of the result. Never the live work copy: in the real run a reviewer ran a tool that overwrote the file it was reading.

## 7. Keep text-reading checks working

Many checks read the big file as text and cut "from this function to the next one". After the split those cuts would land in the wrong place or find nothing.

- Give those checks one shared reader that returns the rebuilt text in the original order. In the real run it is `scripts/lib/main-source.mjs`, which every such check now calls.
- Checks that make a temp copy of the app must copy the new folders too.
- Packaging must include the new folders. Check the build file list.

## 8. Run the related checks on both sides

Run every check that touches the moved code, once on your branch and once on the published code. Compare. Only failures new on your branch count. Old failures stay old.

The project's normal landing step may cap how many checks it runs. Run the full related set yourself first.

## 9. Land and clean up

- Land through the project's normal path.
- Confirm the change is on the published branch.
- Remove the work copy.

## Mistakes to avoid

- Moving one function by hand "because it is quick". The rebuild then fails and you hunt for the line.
- Moving code that runs at load time. It works in every check and fails on first launch.
- Letting a reviewer work in the live copy.
- Fixing bugs you find on the way. Write them down for later. The split must change nothing. The real run found a name used in 6 places and never defined. It was already broken before the split. It went in the notes, not the diff.
