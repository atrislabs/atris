# lessons.md — What We Learned

> Append-only. One line per lesson. Harvested by validator after every feature.

---

- **[2026-02-09] validate-md-gap** — pass — The validate.md template existed but nothing in the system told agents to use it. Three places needed updating: README, CLI output, workflow docs. Always check that templates are wired into the actual workflow, not just sitting in _templates/.
- **[2026-02-09] wire-the-loop** — pass — Same pattern one level up: specs said the right things but CLI commands didn't pass the info through. When you add a new artifact (like lessons.md), grep every command that surfaces context files and add it there too. The wiring layer is always the gap.
- **[2026-02-10] map-line-drift** — fail — MAP.md line references drift silently when functions grow. Start lines drift by 2-4 (minor), but end lines drift by 30-200 (major) because new features get appended inside existing functions. After any feature that adds code to workflow.js, init.js, or brainstorm.js, re-verify the MAP.md end-line for that function.
- **[2026-02-10] auth-duplication** — Auth logic exists in two places: `utils/auth.js` (canonical) and `bin/atris.js:1501-1812` (inline copy). The inline copy lacks `chmod 0o600` on credential save and has no HTTP timeout. Changing auth behavior means patching both unless you refactor to a single source.
- **[2026-02-10] unguarded-token-usage** — `commands/workflow.js`, `commands/brainstorm.js`, `commands/integrations.js`, and `bin/atris.js` (agent/chat) all call `loadCredentials()` and use the raw token without `ensureValidCredentials()`. Only `log-sync.js` and `auth.js` use the full refresh guard. Expired tokens silently fail in agent mode, workflow --execute, and integrations.
- **[2026-02-10] oauth-is-code-exchange-not-redirect** — The CLI OAuth flow opens `{APP_URL}/auth/cli` in browser, user gets a one-time code (5-min expiry), pastes it in terminal, CLI exchanges via `POST /auth/cli/exchange`. No local HTTP server needed. This is simpler but requires user to copy/paste.
- **[2026-02-14] backend-first-then-skill** — When adding new CLI capabilities, check the backend first (`atrisos-backend/backend/routers/integrations/`). Gmail drafts, calendar, drive all already had full backend support — we just needed to write the SKILL.md to expose them. Don't build backend unless it's actually missing.
- **[2026-02-14] dead-code-in-auth-flow** — Backend `auth.py:635` has a CLI-specific code path (`normalized_path == "/auth/cli"`) that never fires because the frontend login route wraps `next` into `/auth/callback?next=...`. The flow still works — it just takes an extra redirect through the general exchange path. Not broken, but dead code.
