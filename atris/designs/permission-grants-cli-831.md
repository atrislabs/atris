# CLI-831 permission grants — design brief (codex, 2026-07-05)

Read-only brief complete. No edits, no commits. `atris task show CLI-831` was attempted first but failed with `attempt to write a readonly database`, so I used `.atris/state/tasks.projection.json`; CLI-831 is open and unclaimed.

**Current Shape**
`ax` already has one-shot approvals: workspace artifacts in `atris/approvals/*.json` and pending remote approvals in `~/.atris/ax-approvals.json`. There is no durable “approved pattern” layer yet. `~/.atris` is the right local home for user-machine policy; `atris/.config` is project config and should not store permission grants.

```text
tool proposes command
  -> staged approval artifact
  -> persistent grant matcher
  -> existing /api/atris2/approvals/execute path
  -> execution ledger + audit
```

**1. Grant State**
Use backend DB as canonical for atrisos-web management, plus local execution cache:

`~/.atris/permission-grants.json`, mode `0600`, directory `0700`, atomic temp rename.

Schema: `atris.permission_grants.v1`

Grant record:

- `grant_id`
- `status`: `active | revoked | expired`
- `scope`: `{ kind: "workspace", workspace_root, business_id?, workspace_id? }`
- `principal`: `{ user_id, email?, created_via: "cli" | "atrisos-web" }`
- `action_type`: initially only `local_command`
- `pattern`: `{ type: "exact_argv" | "argv_prefix", argv, display, normalized_hash }`
- `constraints`: `{ expires_at, max_uses?, cwd_must_be_within_workspace: true, env_allowlist: [] }`
- `audit`: `{ created_at, reason?, last_used_at?, use_count }`
- `sync`: `{ remote_grant_id, remote_version, revoked_at?, revocation_epoch }`

Default scope should be workspace-only by canonical `realpath` root. Global grants should be disabled in the first build; they are too easy to over-broaden.

**2. Approval Flow**
Intercept in [ax](/Users/keshavrao/arena/atris-cli/ax), where local approval artifacts are already listed and approved. On a staged `local_command`, check active grants before showing the approval prompt. If matched, execute through the existing `approveWorkspaceApproval` / `/api/atris2/approvals/execute` path, not a new executor.

Grant creation should happen only after an explicit approval: CLI/web can offer “allow this exact command pattern in this workspace.” The write path updates `~/.atris/permission-grants.json` and syncs to backend.

Pattern matching must parse to argv, not use raw substring matching. Allowed patterns: exact argv first; fixed argv prefix only for narrow commands like `npm test -- <file>` after rejecting shell operators. Reject commands containing `;`, `&&`, `||`, `|`, redirects, newlines, backticks, `$()`, glob expansion, variable expansion, `sh -c`, `bash -c`, `sudo`, or interpreter eval like `node -e` / `python -c`.

Main injection risks: raw prefix grants allow `npm test && destructive-command`; shell expansion changes meaning after match; symlinked cwd can escape the workspace; PATH hijack can change the executable. Mitigations: canonical cwd, argv parser, no shell metacharacters, workspace realpath check, short expiry, and audit every auto-use.

**3. atrisos-web Surface**
Add backend-backed management exposed through atrisos-web BFF routes following the existing business/secrets proxy pattern.

Needed API:

- `GET /api/permission-grants?workspace_id=...`
- `POST /api/permission-grants`
- `PATCH /api/permission-grants/:grant_id` for revoke/expire
- `POST /api/permission-grants/sync` for CLI pull/push with `remote_version`
- optional `POST /api/permission-grants/check` for dry-run match diagnostics

Web files likely targeted: `app/api/permission-grants/route.ts`, `app/api/permission-grants/[grantId]/route.ts`, and a `PermissionGrantsPanel` reachable from the AI Computer workspace settings area near `WorkspaceSettingsModal.tsx`.

Revocation propagation: backend increments `revocation_epoch`; CLI fetches before auto-execution and writes local tombstones. If remote freshness is stale beyond a short TTL, fail closed and ask again. Server should also reject an execute request carrying a revoked `grant_id`.

**4. Never Grantable**
Never persist grants for external human/social/financial writes: Gmail send, Slack post/DM, iMessage send, calendar create/delete, payments, billing, sharing, OAuth/token changes, team/business permission changes, or secret/env edits.

Never grant dangerous local commands: `sudo`, `rm -rf`, `git push --force`, `git reset --hard`, `chmod/chown` on sensitive paths, shell eval, curl-pipe-shell, commands touching `~/.atris/credentials.json`, `~/.ssh`, `.env`, signing keys, `/`, `$HOME`, `Library`, or `Applications`.

Never grant Atris authority changes: `atris task accept`, autoland changes, permission-grant management commands, or commands requiring exact `--approved` payload confirmation.

**5. Bounded Build Plan**
1. Grant store and matcher  
   Files: [lib/permission-grants.js](/Users/keshavrao/arena/atris-cli/lib/permission-grants.js), `test/permission-grants.test.js`  
   Verify: `node --test test/permission-grants.test.js`

2. Wire `ax` approval interception  
   Files: [ax](/Users/keshavrao/arena/atris-cli/ax), [test/ax.test.js](/Users/keshavrao/arena/atris-cli/test/ax.test.js)  
   Verify: `node --test test/ax.test.js`

3. Backend grant CRUD and revocation  
   Files: `atrisos-backend/backend/routers/permission_grants.py`, migration, backend tests  
   Verify: `cd /Users/keshavrao/arena/atrisos-backend && python -m pytest backend/tests/test_permission_grants.py -q`

4. Web management panel  
   Files: `atrisos-web/app/api/permission-grants/*`, `app/dashboard/code/PermissionGrantsPanel.tsx`, settings integration  
   Verify: `cd /Users/keshavrao/arena/atrisos-web && npm test -- permission-grants`

5. End-to-end revocation regression  
   Files: [ax](/Users/keshavrao/arena/atris-cli/ax), [test/cli-smoke.test.js](/Users/keshavrao/arena/atris-cli/test/cli-smoke.test.js)  
   Verify: `node --test test/ax.test.js test/cli-smoke.test.js`

