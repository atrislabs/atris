# pack cli — sharing lane for atris context packs

*2026-07-09 · pack-cli slice*

## what packs are

Packs are folders with a `pack.json` manifest. Clone and pack are one format at two
temperatures: install unpacks a zip into a folder; bundle zips a folder for a friend.
Publish-to-registry is deferred to v3.

## verbs (this slice)

`atris pack install <source> [--dir <path>]`
- source: registry slug (`g-brain`), local `.zip`, or `https://` zip url
- slug download: `GET {ATRIS_APP_URL}/api/pack/registry/<slug>` (dev via `ATRIS_APP_URL`)
- unzip to `./<slug>-pack` or `--dir`; refuse non-empty targets
- validate `pack.json`; print title, version, description, boot line

`atris pack bundle [<dir>]`
- zip current or given pack folder to `<slug>-pack.zip` beside it
- requires `pack.json` in the folder

`atris pack list`
- list pack folders under cwd (directories containing `pack.json`)
- no network

## hard rules

- zip-slip guard on every extract (reject `..` and absolute paths)
- refuse overwrite of non-empty install dirs
- match `PackManifest` shape from atrisos-web registry

## v3 (not now)

`atris pack publish` to registry, stars, pull with upstream layers.
