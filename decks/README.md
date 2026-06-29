# Deck specs

Build anti-slop Google Slides decks from JSON specs.

## Loop

```text
notes.md / video  -> atris deck compose   (analysis -> spec, picks layouts)
spec.json         -> atris deck lint       (cheap pre-check: shape + taste)
                  -> atris deck build --review (publish + thumbnail fetch)
                  -> agent reads review.json + PNG thumbnails (or --review-auto)
                  -> fix spec/engine if needed
                  -> atris deck review confirm <id> (mark ready + emit receipt)
```

One-shot: `atris deck video <youtube-url> --review` runs compose -> lint -> build -> review.

## Commands

```bash
# Compose a spec from a markdown outline (offline) or a video (cloud)
atris deck compose --md notes.md --out decks/my.json --style narrative
atris deck compose --url https://youtu.be/VIDEO --out decks/my.json --theme ink

# Pre-build lint (schema shape + taste/clip)
atris deck lint decks/atris-seed-pitch-v3.json

# Build + open visual review packet (--review-auto also flags blank thumbnails)
atris deck build decks/atris-seed-pitch-v3.json --title "Atris Seed Pitch v3" --review

# Rebuild an existing deck in place (URL/id stay stable)
atris deck build decks/atris-seed-pitch-v3.json --update 139zTe9cPOGttzYbW04adRU26VJz0SqWRwaZmkoVibP8

# Batch-build several specs
atris deck build decks/atris-seed-pitch-v3.json decks/mark-pincus-narrative.json

# One command: video -> reviewed deck
atris deck video https://youtu.be/VIDEO --theme noir --review

# Re-fetch thumbnails for an existing deck
atris deck review 139zTe9cPOGttzYbW04adRU26VJz0SqWRwaZmkoVibP8 --spec decks/atris-seed-pitch-v3.json

# After thumbnails pass review (emits a receipt for the action queue)
atris deck review 139zTe9cPOGttzYbW04adRU26VJz0SqWRwaZmkoVibP8 --confirm "slides 5+8 spacing fixed"

# Builds recorded for a spec
atris deck history decks/atris-seed-pitch-v3.json
```

## Themes

| Theme | Vibe | When |
|-------|------|------|
| `paper` | warm light cream | default editorial |
| `terminal` | warm dark brown | wedge / antislop |
| `ink` | stark white + red accent | press / magazine |
| `noir` | cool dark + blue accent | podcast / interview |

Pick in spec: `"theme": "noir"`, or override at build: `atris deck build spec.json --theme ink`

List all: `atris deck themes`

## Quality bar

- `build` and `lint` **block on errors**: bad shape (unknown type, missing field), "it is not X, it is Y" copy, or `content-truncated` (more list items than the engine renders)
- Agent reads every thumbnail before `--confirm` (or `--review-auto` flags blank/failed renders)
- Stack slides: clean cards, no side accent bars
- State claims directly; avoid contrast framing ("not taste, it's proof")
- Prefer narrative types (`interstitial`, `lede`, `prose`, `split`, `bullets`) when content is a story, not a dashboard
- Lint warns on **template fatigue** (4+ boxed slides: panel, receipt, versus, metricgrid, stack, chips)
- Dense statement/columns/prose/lede/quote/split text auto-shrinks to stay on-slide
- `review.json` is the manifest for agents; `receipt.json` is emitted on confirm
- `slide-01.png` ... `slide-N.png` are the thumbnails to inspect

## Specs

| File | Purpose |
|------|---------|
| `atris-seed-pitch-v3.json` | Main investor pitch (10 slides, paper theme) |
| `atris-one-loop-pitch.json` | Outcome wedge deck (7 slides, terminal theme) |
| `yash-applied-compute-generalist.json` | Yash Patil / Own or Be Owned (ink, boxed template) |
| `yash-applied-compute-narrative.json` | Same story, typography-first (ink, no widgets) |
| `yash-applied-compute-detailed.json` | Full episode notes, 18 slides, bullets + cases |
| `mark-pincus-sourcery.json` | Mark Pincus / Life at the Speed of Play (noir, boxed) |
| `mark-pincus-narrative.json` | Same story, box-free narrative (12 slides, noir) |
| `atris-single-shot-proof.json` | Review loop proof deck (6 slides, single-pass quality bar) |
| `atris-archetypes-v2.json` | New archetypes showcase (8 slides, paper theme) |
| `atris-antislop-pitch.json` | 3-slide antislop product pitch |
| `archetype-catalog.json` | Every slide type once (19 slides, paper theme), design reference for writers |
