# Campaign ships across Atris

Run by hand until the store and CLI verbs land (build.md Phase 0.5). Missions for this campaign carry `campaign:cmp-ships-across-atris` in their objective.

```yaml
campaign:
  title: "Campaign ships across Atris"
  judge: "npm run validate:campaign"   # atris-cli; exit 0 only when all five surfaces agree on the golden files
  budget: 500                          # proposed by engine-manager, waiting on Keshav
  owner: mission-lead
  bet: "Computers fold, screens decode. Wrong if any screen has to compute campaign state itself."
  seats:
    cli:      [engine-manager, navigator, validator]                 # atris-cli
    backend:  [backend-feature-owner, backend-independent-validator] # atrisos-backend
    desktop:  [interface-dev, frontend-dev]                          # atris-desktop-v2
    web:      [atris-frontend, validator]                            # atrisos-web
    ios:      [ios-engineer, ios-quality-engineer, api-contract]     # terrace
```

## Judge readings

| When | cli | backend | desktop | web | terrace | Result |
|---|---|---|---|---|---|---|
| 2026-10-15, before any runner | pass 20/20, 14/14 | not built | not built | not built | not built | fails, as a new judge must |
| 2026-10-15, all five branches | pass 20/20, 14/14 | pass 20/20, 14/14 | pass 17/17 (atris-desktop-v2#418) | pass 17/17 (atrisos-web#430) | pass 17/17 (terrace#240) | passes on branches; passes on main checkouts once all five merge |

## Missions

- CLI core: schema, pure fold and decide, SQLite store, golden files, judge. engine-manager, task CLI-189.
- Golden files written blind from the contract. navigator.
- Python fold. backend-feature-owner.
- View models: desktop (interface-dev), web (atris-frontend), terrace (ios-engineer).
