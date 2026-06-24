# Deck specs

Build anti-slop Google Slides decks from JSON specs.

## Loop

```text
spec.json -> atris deck lint        (cheap pre-check)
         -> atris deck build --review (publish + thumbnail fetch)
         -> agent reads review.json + PNG thumbnails
         -> fix spec/engine if needed
         -> atris deck review confirm <id> (mark ready)
```

## Commands

```bash
# Pre-build lint
atris deck lint decks/atris-seed-pitch-v3.json

# Build + open visual review packet
atris deck build decks/atris-seed-pitch-v3.json --title "Atris Seed Pitch v3" --review

# Re-fetch thumbnails for an existing deck
atris deck review 139zTe9cPOGttzYbW04adRU26VJz0SqWRwaZmkoVibP8 --spec decks/atris-seed-pitch-v3.json

# After agent visually approves thumbnails
atris deck review 139zTe9cPOGttzYbW04adRU26VJz0SqWRwaZmkoVibP8 --confirm "slides 5+8 spacing fixed"
```

## Themes

| Theme | Vibe | When |
|-------|------|------|
| `paper` | warm light cream | default editorial |
| `terminal` | warm dark brown | wedge / antislop |
| `ink` | stark white + red accent | press / magazine |
| `noir` | cool dark + blue accent | podcast / interview |

Pick in spec: `"theme": "noir"` — or override at build: `atris deck build spec.json --theme ink`

List all: `atris deck themes`

## Quality bar

- `build --review` **blocks on lint errors** (e.g. "it is not X, it is Y" copy)
- Agent reads every thumbnail before `--confirm`
- Stack slides: clean cards, no side accent bars
- State claims directly; avoid contrast framing ("not taste, it's proof")
- Prefer narrative types (`interstitial`, `lede`, `prose`, `split`) when content is a story, not a dashboard
- Lint warns on **template fatigue** (4+ boxed slides: panel, receipt, versus, metricgrid, stack, chips)
- `review.json` — manifest for agents
- `slide-01.png` … `slide-N.png` — thumbnails to inspect

## Specs

| File | Purpose |
|------|---------|
| `atris-seed-pitch-v3.json` | Main investor pitch (10 slides, paper theme) |
| `atris-one-loop-pitch.json` | Outcome wedge deck (7 slides, terminal theme) |
| `yash-applied-compute-generalist.json` | Yash Patil / Own or Be Owned (ink, boxed template) |
| `yash-applied-compute-narrative.json` | Same story, typography-first (ink, no widgets) |
| `yash-applied-compute-detailed.json` | Full episode notes, 18 slides, bullets + cases |
| `mark-pincus-sourcery.json` | Mark Pincus / Life at the Speed of Play (noir theme) |
| `atris-single-shot-proof.json` | Review loop proof deck (6 slides, single-pass quality bar) |
| `atris-archetypes-v2.json` | New archetypes showcase (8 slides, paper theme) |
| `atris-antislop-pitch.json` | 3-slide antislop product pitch |
