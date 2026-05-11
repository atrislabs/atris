# Customer Skill Zones

> **Status:** partially shipped / private publish parked
> **Created:** 2026-02-16
> **Last Updated:** 2026-05-10

## 2026-05-10 Reality Check

The narrow scaffold path is shipped: `atris skill create <customer>/<skill-name>` writes `atris/customers/<customer>/skills/<skill-name>/SKILL.md`.

The larger private plugin workflow is not shipped. `atris plugin build` and `atris plugin publish` still package/publish the universal `atris/skills` workspace only; `--customer` is parked until a live customer deployment needs it.

---

## Problem Statement

Atris has universal skills (email, calendar, drive) that work for everyone, but the real value — the $100K contract — is the custom skills an FDE builds with a customer in a 30-minute session. Right now there's no separation between universal and custom, no way to scaffold a customer skill quickly, and no way to package and deploy customer-specific skills as a private plugin.

---

## Solution Design

Two-layer skill architecture. Universal skills ship publicly through the `atris-plugins` marketplace. Custom skills live in per-customer directories, get scaffolded with `atris skill create`, and deploy as private plugins through per-customer marketplace repos.

The FDE (Justin) sits with a customer, runs `atris skill create example-co/email-outreach`, fills in the workflow, and runs `atris plugin publish --customer example-co`. The customer installs two plugins: the public `atris-workspace` (universal) and their private `example-co-workspace` (custom). Done.

---

## ASCII Visualization

```
                        SKILL ARCHITECTURE

  ┌─────────────────────────────────────────────────────┐
  │              UNIVERSAL SKILLS                        │
  │              atris/skills/                            │
  │                                                      │
  │  email  calendar  drive  slack  notion  slides       │
  │  copy-editor  design  backend  meta  autopilot       │
  │                                                      │
  │  Public: atrislabs/atris-plugins                     │
  │  Free with signup                                    │
  └──────────────────────┬──────────────────────────────┘
                         │
            ┌────────────┼────────────┐
            │            │            │
  ┌─────────▼──┐  ┌──────▼─────┐  ┌──▼──────────┐
  │ EXAMPLECO  │  │  MERCURY   │  │  PARAFORM   │
  │            │  │            │  │             │
  │  customers/│  │  customers/│  │  customers/ │
  │ example-co/│  │  mercury/  │  │  paraform/  │
  │  skills/   │  │  skills/   │  │  skills/    │
  │            │  │            │  │             │
  │  email-    │  │  deal-     │  │  candidate- │
  │  outreach  │  │  tracker   │  │  scorer     │
  │  bol-proc  │  │  pipeline  │  │  outreach   │
  │  chorus-fu │  │  alerts    │  │  matching   │
  │            │  │            │  │             │
  │  Private:  │  │  Private:  │  │  Private:   │
  │  atrislabs/│  │  atrislabs/│  │  atrislabs/ │
  │ example-co-│  │  mercury-  │  │  paraform-  │
  │  plugins   │  │  plugins   │  │  plugins    │
  └────────────┘  └────────────┘  └─────────────┘

  FDE WORKFLOW:
  ━━━━━━━━━━━━
  atris skill create example-co/email-outreach
    → scaffolds atris/customers/example-co/skills/email-outreach/SKILL.md

  atris plugin build --customer example-co
    → packages into example-co-workspace.plugin

  atris plugin publish --customer example-co
    → pushes to atrislabs/example-co-plugins (private repo)

  CUSTOMER INSTALLS:
  ━━━━━━━━━━━━━━━━━
  1. atrislabs/atris-plugins     → universal skills (free)
  2. atrislabs/example-co-plugins    → custom skills ($100K/yr)
```

---

## Success Criteria

- [ ] `atris/customers/` directory structure works — each customer gets their own skills folder
- [ ] `atris skill create <customer>/<skill-name>` scaffolds a SKILL.md with bootstrap, API, workflow sections pre-filled
- [ ] `atris plugin build --customer <name>` packages only that customer's skills into a .plugin file
- [ ] `atris plugin publish --customer <name>` creates/updates a private GitHub marketplace repo and pushes
- [ ] Customer can install both universal and private plugins side by side in Cowork
- [ ] FDE can go from "sit down with customer" to "deployed private plugin" in under 30 minutes

---

## User Impact

**For FDEs (Justin):** Three commands to go from customer conversation to deployed plugin. No guessing at file structure, no manual GitHub repo setup, no copying boilerplate. Sit down, build, ship.

**For customers (Sushanth):** Two plugins in Cowork — universal tools that work for everyone, plus custom skills built specifically for their workflows. The custom skills are the lock-in. They can't get "example-co-email-outreach" anywhere else.

**For the business:** Every customer engagement produces deployable artifacts (skills) that justify the $100K platform fee. The custom skills ARE the product. The universal skills are the hook.

---

## Technical Notes

**Scaffold template should include:**
- Bootstrap section (pre-filled with auth check + token extraction)
- API reference section (blank, FDE fills based on customer's tools)
- Workflow sections (placeholders for 3-4 common workflows)
- Approval gate reminder (never auto-send, always confirm)
- Error handling table (standard AtrisOS errors pre-filled)

**Private marketplace repos:**
- Naming: `atrislabs/<customer>-plugins`
- Created automatically on first `publish --customer`
- Private by default (GitHub private repo)
- Customer gets read access, Atris team gets write access

**Skill naming convention:**
- Universal: `atris/skills/<skill-name>/SKILL.md`
- Custom: `atris/customers/<customer>/skills/<skill-name>/SKILL.md`
- No collision possible — different directories

**What the FDE fills in during the session:**
1. Skill name and description (frontmatter)
2. Which APIs to call (customer's tools — HubSpot, Chorus, etc.)
3. Workflow steps (the customer's actual process)
4. Approval gates (what needs human confirmation)
5. Auto-archive/auto-action rules (what's safe to automate)
