# Site publish

Upload a built static web folder to Atris hosted sites. The command walks every file, sends one publish request to the hosted-sites API, and prints the live URL when the server confirms the site is up.

Your site is served at `https://{slug}.atris.ai/` on its own origin. Each publish replaces the entire page set, so always upload the full build output. You must be logged in (`atris login`); the CLI reads your bearer token from `~/.atris/credentials.json`.

## Usage

```bash
atris site publish <dir> --slug <slug> [--profile strict|app] [--spa] [--no-claim] [--build] [--json]
```

## Flags

| Flag | Default | Description |
|------|---------|-------------|
| `<dir>` | (required) | Folder to publish. Must contain `index.html` at the root. |
| `--slug <slug>` | (required) | Subdomain name. Lowercase letters, digits, and hyphens only. No hyphen at either end. |
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

## File handling

The walker skips `node_modules` and `.git` directories, `.DS_Store`, any name starting with `.` (dotfiles and dotfolders), and symbolic links. Paths are normalized to use forward slashes and never start with `/`.

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

**Strict** is the server default and suits static sites: HTML, CSS, images, and fonts from the same origin, Google Fonts, and API calls to `https://api.atris.ai`. Inline scripts and styles are allowed. External script CDNs, `unsafe-eval`, and broad `connect-src` are blocked. Pick strict for marketing pages, docs, and simple static exports that do not need third-party JavaScript.

**App** loosens the policy for interactive frontends: CDN script hosts (esm.sh, jsdelivr, unpkg, skypack, cdnjs, jspm), `unsafe-eval`, blob workers, `connect-src` and `wss:` to any HTTPS origin, and classic script tags from CDNs. Pick app for React or Vite SPAs, Next.js static exports with client hydration, or any site that fetches external APIs, uses `localStorage`, or loads modules from a CDN.

## Output

On success (without `--json`), the CLI prints five lines:

```text
pages uploaded: <count>
verified: yes
site url: https://<slug>.atris.ai/
preview url: <preview url>
publish id: <publish id>
```

With `--json`, it prints the full API response object (including `publish_id`, `previous_publish_id`, `slug`, `pages`, `verified`, and `urls`).

When `verified` is not `true`, the human output still shows `verified: no`, and the CLI also writes `site is not live: verified no` to stderr.

## Exit codes

| Code | When |
|------|------|
| 0 | Publish succeeded and `verified` is `true`. |
| 1 | Not logged in, network failure, server returned an error, or `verified` is not `true`. |
| 2 | Missing or invalid arguments, directory errors, missing `index.html`, build failure, file limit exceeded, or unknown flags. |

## Recipes

### Plain static folder

Build or copy your site so `index.html` sits at the folder root, then publish:

```bash
atris site publish ./my-site --slug my-site
```

Strict profile is fine for hand-written HTML, CSS, and local assets.

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

The hosted-sites lane serves files only. These Next.js features are not supported: server-side rendering, API routes, server actions, middleware, and the image optimizer. For server-side apps, a site's `proxy_target` can point at a Render host, but that path is not yet automated by this command.

## Troubleshooting

| Error | HTTP | Meaning | What to do |
|-------|------|---------|------------|
| `slug_taken` | 409 | Another account owns this slug. | Pick a different `--slug`. |
| `invalid_csp_profile` | 400 | Profile name is not `strict` or `app`. | Fix `--profile strict` or `--profile app`. |
| `subdomain_grant_unavailable` | 503 | Server cannot register the subdomain (missing Render credentials). | Retry with `--no-claim` if the subdomain already exists, or wait for ops to restore credentials. |
| `subdomain_grant_failed:<status>` | 502 | Render rejected the subdomain request. | Check the status code; retry later or use `--no-claim` if the subdomain is already live. |
| `site is not live: verified no` | 200 | Publish accepted but the site did not pass live checks. | Open the preview URL, fix broken assets or routing, and publish again. |
| `not logged in. run atris login first.` | | No bearer token in credentials. | Run `atris login`. |
| `site home page is missing: index.html` | | No `index.html` in the published folder. | Add `index.html` or point at the correct build output. |
| `site files exceed upload limits:` | | A file exceeds 2 MB or the folder has more than 200 pages. | Shrink or split assets; reduce page count. |

## Verification tip

After publishing, check mobile layout with Playwright device emulation (for example iPhone or Pixel presets). Do not rely on headless Chrome with `--window-size` for phone checks; it floors viewport width at 500px and will miss real mobile breakpoints. WebKit emulation is a good stand-in for iOS Safari.
