# real backend routes

`atris perf routes [--top 10]` fetches real request timings from the backend.
Set `ATRIS_INTERNAL_SECRET` in your shell environment before running it. The
value is read only from the environment and sent as a bearer authorization
header. Never put the secret in the targets file or a command argument.

The targets list also accepts one route source, seeded as:

```json
{"name":"routes","type":"routes","url":"https://atrisos.onrender.com/internal/perf/routes"}
```

Edit that entry to use a different backend endpoint. Existing targets lists
without a route entry use this production source by default. URL checks ignore
the route source entry; add, list and remove preserve the rest of the list.
Names must be unique across URL targets and the route source. The name `routes`
is reserved for the route source. Multiple route sources fail route collection
with one message; the default flow still completes its URL checks and report.
Only http/https source URLs without credentials, query strings or fragments are
accepted. Redirects are not followed, so the bearer token is never forwarded.

Bare `atris perf` runs URL checks then fetches routes and reports both. Without
the secret it prints one setup line and still completes URL checks. `perf run`
alone remains URL-only. A 401 means the secret is wrong; a 404 means the backend
endpoint is not deployed yet. Other failures are reported without response
bodies or credentials and do not stop the default URL report.
Explicit `atris perf routes` failures exit with status 1, including missing
credentials and history write failures. Successful collection exits with 0.

Routes rank by `p95 × count`, recomputed locally rather than trusting a supplied
score. The top ten show method, template, lifetime count, p50/p95/p99 in
milliseconds, error rate and score. Use `--top N` to change the display limit,
including on `perf report`. The full snapshot is saved regardless of this limit.
Empty snapshots are valid. Counts are per worker since the displayed `since`
time and reset on deploy; latency percentiles cover the backend's recent ring
of samples, not a fixed weekly window.

Successful snapshots append to `atris/perf/routes.jsonl`, ignored automatically
in git projects. `atris perf report --html` includes the latest saved snapshot
as a routes table with its collection and since times. It does not fetch fresh
data or need the secret. URL run history and `report --json` retain their existing
format. Request failures never replace the last successful snapshot.

# endpoint speed checks

Run `atris perf` for ten sequential samples per endpoint and a ranked text report.
Use `atris perf report --html` to write `atris/perf/report.html`, then open it in
your browser. `atris perf report --html /path/report.html` writes elsewhere.
`atris perf report --json` prints machine-readable results and history.

Manage endpoints with `atris perf add <name> <url> --weight 2`, `atris perf list`
and `atris perf remove <name>`. Edit `atris/perf/targets.json` for a method or
headers, for example `"headers": {"apikey": "$SUPABASE_ANON_KEY"}`. Missing
environment variables stop the run rather than sending an empty credential.
Expanded headers are never saved. Avoid secrets in URLs and names.

If targets are absent, the command seeds atris.ai, evals.atris.ai and the
atrisos.onrender.com health endpoint. These public endpoints returned 200 when
checked with curl. The frontend repository documents atris.ai and the backend
repository's cli/replay_run.py documents the Render host. Supabase REST was
checked but requires authentication, so it is not a default target.

`atris perf run --samples 20 --target backend --timeout 15000` controls the run.
Every sample uses a new agent without keepalive. Redirects are measured as
responses, not followed. DNS, TCP, TLS, time to first byte and total are measured
from this machine. Download bytes are encoded bytes on the wire. DNS may be
zero for IP literals. First-sample versus later-sample timing is a cold-start
heuristic, not proof that a provider spun an instance down.

Ranking score = p95 time to first byte in milliseconds × traffic weight.
Weights default to 1. Percentiles use nearest rank; ten samples make p95 and
p99 equal to the maximum. Failures stay in statistics and timeouts use elapsed
time as time to first byte when no headers arrive. Inspect error rate alongside
the score. Run history is appended to atris/perf/runs.jsonl, one record per
target with raw samples. Reports compare the last two stored runs per name.
Keep names stable only when they refer to the same endpoint.

Findings cover text without compression above 1 kb, public cacheable GET
misses or missing cache policy, payloads above 500 kb, p95 above 800 ms,
first-sample timing above twice the warm median, median TCP above 150 ms or
TLS above 200 ms, errors and p99/p50 above 3. Cache advice excludes requests
with authorization/cookie headers and private/no-store responses. Review
whether a response is truly public before caching it.

The dashboard embeds styles and SVG charts with no external assets. Its phase
bars separate DNS, TCP, TLS, server wait and download so connection setup is
not counted twice. Runs and generated reports are local files, not committed.
