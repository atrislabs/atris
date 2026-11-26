# Site publish

Upload a built static web folder to Atris hosted sites. The command walks every file, sends one publish request to the hosted-sites API and prints the live URL when the server confirms the site is up.

Your site is served at `https://{slug}.atris.ai/` on its own origin. Each publish replaces the entire page set. Always upload the full build output. You must be logged in (`atris login`); the CLI reads your bearer token from `~/.atris/credentials.json`.

## Usage

```bash
atris site publish <dir> --slug <slug> [--profile strict|app] [--spa] [--no-claim] [--build] [--json]
```

## Flags

| Flag | Default | Description |
|------|---------|-------------|
| `<dir>` | (required) | Folder to publish. Must contain `index.html` at the root. |
| `--slug <slug>` | (required) | Subdomain name. Lowercase letters, digits and hyphens only. No hyphen at either end. |
| `--profile strict\|app` | Server default (`strict`) | Content security policy profile. Omitted from the request when not set. |
| `--spa` | off | Tell the server to route unknown extensionless paths to `index.html` for client-side routers. |
| `--no-claim` | claim on | Skip subdomain registration. Use when `{slug}.atris.ai` already exists. |
| `--build` | off | Run `npm run build` in `<dir>`, then publish the first output folder found. |
| `--json` | off | Print the full JSON response instead of human-readable lines. |
| `--help`, `-h` | | Print usage and exit 0. |

## Build behavior

With `--build`, the CLI requires `package.json` with a non-empty `scripts.build` entry. It runs `npm run build` in `<dir>`, then looks for an output directory in this order: `dist`, `build`, `out`. The first directory that exists is published. If none exist after a successful build, the command fails.

Example:

```bash
atris site publish . --slug my-app --build --profile app
```

## Page check

After any build and before anything is uploaded, publish checks every html page it uploads with the same rules as `atris site check` ([site-check.md](site-check.md)). Built pages are also held to the look they were built in: a page edited after its build, a look the owner never picked or a linked style sheet missing from the folder each count as a fault. `atris site deploy` runs the same check before its upload and before `--dry-run` prints its plan.

The project picks what a failing page does in `.atris/slop.rules.json`. `atris site rules` prints the mode in force. Its `--json` carries it as `mode`. Run publish and deploy from the project root: the rules file, the look picks and the build are read from the folder the command runs in. A rules file in a parent folder is not read.

- **Watch** is the default. The check writes what would fail to stderr under `page check in watch mode: these lines do not stop the upload. in block mode each page marked would refuse stops it.` The upload goes on as before.
- **Block** is on with `"pages": "block"`. A failing page stops the upload: the check prints `refused <file>` with one line per fault, then `page check in block mode: nothing was uploaded.` and the command exits 1. `atris init` turns block mode on for a new project.
- A note for the reviewer never stops an upload in either mode. The notes on passing pages and each page the check could not read in full (`<file>: not checked: <what>`) print on stderr in every mode, beside any failing page. See [site-check.md](site-check.md#notes-for-the-reviewer).

To switch one page rule off, list its id under `off`, like `{ "pages": "block", "off": ["page-glow"] }`. The content page grammar cannot be switched off. A passing upload still names every rule that is switched off, since a page may pass only because one is off:

```
page check in block mode: switched off in .atris/slop.rules.json: page-glow
```

A rules file that is there and cannot be read stops the upload in either mode, since the owner's choice of mode is then unknown. Publish, deploy and `deploy --dry-run` print one line and exit 1:

```
.atris/slop.rules.json could not be read: <why>. nothing was uploaded: fix the file or remove it
```

After an upload `atris site publish --json` carries the check in `page_check`: `mode` (`watch` or `block`), `ok`, `off` (the switched-off rules), `files` (each failing page with its findings and the same words in `text`) and `not_checked` (each page the check could not read in full, as `file` and `lines`). `ok` says only that no rule failed. Read it with `not_checked`. A refused upload prints no `page_check`. Its refusal goes to stderr, or with `--json` to stdout as `{ "files": [...] }`. A rules file that cannot be read prints one line on stderr and nothing on stdout.

## File handling

The walker skips `node_modules` and `.git` directories, `.DS_Store`, any name starting with `.` (dotfiles and dotfolders) and symbolic links. Paths are normalized to use forward slashes and never start with `/`.

**Text files** (read as UTF-8, `is_base64: false`):

| Extension | Content type |
|-----------|--------------|
| `.html` | `text/html; charset=utf-8` |
| `.css` | `text/css; charset=utf-8` |
| `.js`, `.mjs` | `text/javascript; charset=utf-8` |
| `.json`, `.map` | `application/json` |
| `.txt` | `text/plain; charset=utf-8` |
| `.xml` | `application/xml` |
| `.svg` | `image/svg+xml` |
| `.webmanifest` | `application/manifest+json` |
| `.md` | `text/markdown; charset=utf-8` |

**Binary files** (read as base64, `is_base64: true`):

| Extension | Content type |
|-----------|--------------|
| `.png` | `image/png` |
| `.jpg`, `.jpeg` | `image/jpeg` |
| `.gif` | `image/gif` |
| `.webp` | `image/webp` |
| `.ico` | `image/x-icon` |
| `.woff` | `font/woff` |
| `.woff2` | `font/woff2` |
| `.ttf` | `font/ttf` |
| `.otf` | `font/otf` |
| `.mp3` | `audio/mpeg` |
| `.mp4` | `video/mp4` |
| `.wasm` | `application/wasm` |
| `.pdf` | `application/pdf` |

Any other extension is sent as `application/octet-stream` with base64 encoding.

## Limits

- **2 MB per page.** Files over this size are rejected before upload. The error lists every oversized path.
- **200 pages per site.** Sites with more than 200 files are rejected. The error lists paths beyond the limit.

The server enforces the same caps. Extensionless URLs on the live site resolve to `path.html` or `path/index.html`. With `--spa`, unknown extensionless paths fall back to `index.html`. The `/_atris/*` namespace is reserved on every hosted name.

## Content security profiles

**Strict** is the server default and suits static sites: HTML, CSS, images and fonts from the same origin, Google Fonts and API calls to `https://api.atris.ai`. Inline scripts and styles are allowed. External script CDNs, `unsafe-eval` and broad `connect-src` are blocked. Pick strict for marketing pages, docs and simple static exports that do not need third-party JavaScript.

**App** loosens the policy for interactive frontends: CDN script hosts (esm.sh, jsdelivr, unpkg, skypack, cdnjs, jspm), `unsafe-eval`, blob workers, `connect-src` and `wss:` to any HTTPS origin and classic script tags from CDNs. Pick app for React or Vite SPAs, Next.js static exports with client hydration, or any site that fetches external APIs, uses `localStorage` or loads modules from a CDN.

## Output

On success (without `--json`), the CLI prints five lines:

```text
pages uploaded: <count>
verified: yes
site url: https://<slug>.atris.ai/
preview url: <preview url>
publish id: <publish id>
```

With `--json`, it prints the full API response object (including `publish_id`, `previous_publish_id`, `slug`, `pages`, `verified` and `urls`) plus a `page_check` field: `{ "mode": "watch" | "block", "ok": true | false, "off": [...], "files": [...], "not_checked": [...] }`, where each failing file has `file`, `findings` and the report lines in `text` and each page not read in full has `file` and `lines`. When block mode refuses a page, nothing is uploaded and `--json` prints the check report (`{ "files": [...] }`) instead.

When `verified` is not `true`, the human output still shows `verified: no`. The CLI also writes `site is not live: verified no` to stderr.

## Exit codes

| Code | When |
|------|------|
| 0 | Publish succeeded and `verified` is `true`. |
| 1 | A page failed the page check in block mode, not logged in, network failure, server returned an error, or `verified` is not `true`. |
| 2 | Missing or invalid arguments, directory errors, missing `index.html`, build failure, file limit exceeded, or unknown flags. |

## Recipes

### Plain static folder

Build or copy your site so `index.html` sits at the folder root, then publish:

```bash
atris site publish ./my-site --slug my-site
```

Strict profile is fine for hand-written HTML, CSS and local assets.

### Vite React app

Build the app, then publish with the app profile and SPA routing:

```bash
npm run build
atris site publish dist --slug my-vite-app --profile app --spa
```

Or build and publish in one step from the project root:

```bash
atris site publish . --slug my-vite-app --profile app --spa --build
```

`--spa` is required because Vite client routers serve one `index.html` for all routes.

### Next.js static export

Configure static export in `next.config.js`:

```javascript
/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'export',
  images: { unoptimized: true },
};
module.exports = nextConfig;
```

Build and publish the `out` folder. No `--spa` is needed because export writes real HTML files (for example `about.html`):

```bash
npm run build
atris site publish out --slug my-next-app --profile app
```

Or from the project root:

```bash
atris site publish . --slug my-next-app --profile app --build
```

The hosted-sites lane serves files only. These Next.js features are not supported: server-side rendering, API routes, server actions, middleware and the image optimizer. For server-side apps a site's `proxy_target` can point at a Render host. That path is not yet automated by this command.

## Troubleshooting

| Error | HTTP | Meaning | What to do |
|-------|------|---------|------------|
| `slug_taken` | 409 | Another account owns this slug. | Pick a different `--slug`. |
| `invalid_csp_profile` | 400 | Profile name is not `strict` or `app`. | Fix `--profile strict` or `--profile app`. |
| `subdomain_grant_unavailable` | 503 | Server cannot register the subdomain (missing Render credentials). | Retry with `--no-claim` if the subdomain already exists, or wait for ops to restore credentials. |
| `subdomain_grant_failed:<status>` | 502 | Render rejected the subdomain request. | Check the status code; retry later or use `--no-claim` if the subdomain is already live. |
| `site is not live: verified no` | 200 | Publish accepted but the site did not pass live checks. | Open the preview URL, fix broken assets or routing and publish again. |
| `not logged in. run atris login first.` | | No bearer token in credentials. | Run `atris login`. |
| `site home page is missing: index.html` | | No `index.html` in the published folder. | Add `index.html` or point at the correct build output. |
| `site files exceed upload limits:` | | A file exceeds 2 MB or the folder has more than 200 pages. | Shrink or split assets; reduce page count. |
| `page check in block mode: nothing was uploaded.` | | A page broke a page rule and the project is in block mode. | Fix each named line, check again with `atris site check <dir>`, then publish. |
| `.atris/slop.rules.json could not be read: ...` | | The rules file in the folder the command runs in is not valid json, is not a json object, or holds a `pages` or `off` value that cannot be used. | Fix the file or remove it, then publish again. |

## Verification tip

Before publishing, run `atris site check <dir> --render`. It opens each page at 390 and 1280 pixels wide and catches sideways scrolling, cut off text and buttons too small to tap. Headless Chrome will not open a window narrower than 500 pixels. The check runs the page in a frame of the asked width. For iOS Safari itself, WebKit emulation in Playwright is a good stand-in.
