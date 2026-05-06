---
type: brief
slug: atrisos-generative-ui-product-surface
title: AtrisOS generative UI product surface
created: 2026-04-29
updated: 2026-04-29
tags: [product, design, generative-ui, blocks, imagegen]
---

# AtrisOS Generative UI Product Surface

## Decision

The AtrisOS coffee/amber product-surface style is the default visual language
for product updates, generated images, block previews, and future generative UI.

Use it when the artifact should feel like Atris, not generic AI launch art.

## Visual Standard

```text
canvas      #141110  warm near-black
card        #1E1915  warm dark brown
surface     #2C2520  raised surface
border      #3D332D  thin warm border
text        #EAE3D9  warm off-white
secondary   #A39B92  muted warm text
accent      #f59e0b  amber
accent-2    #d97706  deep amber
highlight   #fbbf24  soft amber
radius      6-8px    product panels
type        TWK Lausanne feeling, clean premium sans
```

Avoid cyan, purple, blue gradients, bokeh, glossy 3D, cartoon icons, huge cloud
icons, fake dashboards, and generic neon developer-tool imagery.

## Reusable Image Prompt

```text
Create a square 1:1 AtrisOS product-surface graphic.

Use the AtrisOS web theme: warm coffee dark UI, background #141110, card
#1E1915, surface #2C2520, border #3D332D, text #EAE3D9, secondary text #A39B92,
amber accent #f59e0b, deeper amber #d97706, soft amber #fbbf24. Typography
should feel like TWK Lausanne: premium clean sans, not generic.

Make it feel like a real product surface: thin borders, 6-8px radii, calm
spacing, subtle amber active states, minimal labels, no clutter.

Subject: <topic>
Main text: <headline>
Subtitle: <subtitle>

Show the concept as modular AtrisOS UI panels, not a marketing illustration.
Use amber connector lines, checks, receipts, or active states only when they
explain the system.

Avoid purple, cyan, blue gradients, bokeh, glowing orbs, glossy 3D, cartoon
icons, cluttered dashboards, fake stock imagery, watermarks, extra logos, and
misspelled text.
```

## Product Idea

Generative UI can become an Atris block system: the user asks for a thing, and
Atris composes blocks on the spot.

```text
intent
  -> app block       schedules, CRM, reports, inbox, workflows
  -> code block      scripts, queries, transforms, tests, automations
  -> image block     launch graphics, thumbnails, assets, diagrams
  -> receipt block   proof, logs, validation, shareable output
  -> result surface  a living mini-app generated in context
```

The product is not "generate a page." The product is "generate the right
working surface for the job, with code and media as first-class blocks."

## First Prototype

Build a block canvas that can render four block types:

- `app`: a configured workflow or integration action.
- `code`: executable code with inputs, stdout, artifacts, and status.
- `image`: generated visual output with prompt, variants, and selected asset.
- `receipt`: validation output tied to the task or workflow.

The first demo should blend code and image generation in one flow:

```text
User asks for a launch update
  -> Atris reads release context
  -> code block extracts shipped changes
  -> image block creates AtrisOS-theme graphic
  -> app block drafts social post
  -> receipt block records files, prompt, checks, and final asset
```

## Product Bet

Blocks make generative UI useful because they preserve structure.

A chat answer disappears. A generated block can be inspected, rerun, edited,
validated, shared, and composed into an app.

## Dynamic Deck

Flipbook-style model pixels prove the appetite: people want interfaces that
appear as fast as thought.

Atris should take the structured path.

```text
Flipbook: model -> pixels -> interactive regions
Atris: brain -> blocks -> app/code/image/deck surfaces -> receipts
```

The dynamic deck is the first spectacle surface.

Each slide is a block-backed scene. It can show a generated visual, execute a
code block, reveal an APP.md manifest, open a receipt, or transform into a live
mini-app while the presenter is talking.

The pitch is not a deck about Atris. The pitch is Atris performing the deck.
