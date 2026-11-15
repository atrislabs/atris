# How to check if ChatGPT recommends your business

How to see what ChatGPT, Perplexity, Claude and Gemini say when buyers ask
about your kind of business, and which tools do it for you. Updated November
8, 2026.

There are two separate checks. One: can answer engines read your site at all.
Two: when a buyer asks a question, are you named. Most sites fail the first
without knowing it, and the second is what brings customers.

## Check one: can answer engines read your site

Free, no login, from your terminal:

```bash
npx -y atris aeo scan yoursite.com
```

You get a score out of 100 and each gap with its fix. The agent access part
checks five things:

| Check | Why it matters |
|---|---|
| Plain text on request | Agents ask for `Accept: text/markdown` or a `.md` link and read it faster than HTML |
| Crawlers allowed | A robots.txt that blocks `OAI-SearchBot` or `PerplexityBot` keeps you out of their answers |
| Words without scripts | Many fetchers do not run JavaScript, so a page that renders in the browser can look empty to them |
| Structured data | Schema.org JSON-LD tells them who you are, where, and what you sell |
| Sitemap | Lets them find every page, not just the homepage |

Add `--vs competitor.com` to see both sites side by side.

## Check two: are you named when buyers ask

By hand: ask ChatGPT and Perplexity the five questions your customers ask most,
in their words ("best accountant for a small restaurant in Austin"). Write down
who gets named. Ask each question a few times, because answers change between
runs.

Free and automatic: [atris.ai/aeo/check](https://atris.ai/aeo/check) asks the
questions for you, counts how often you are named, and shows who is named
instead.

## Tools that check it for you

Prices were read from each company's pricing page on November 4, 2026.

| Tool | Lowest paid price | What the lowest plan covers | Fixes it for you? |
|---|---|---|---|
| Atris | $700/mo | 20 customer questions on ChatGPT, Perplexity, Claude, Grok and Gemini, every month | Yes. Writes and publishes an answer page about your business |
| Otterly.AI | $29/mo | 15 prompts on 4 engines | No. Tracking and advice |
| Peec AI | $95/mo | 50 prompts, 3 engines, daily | No. Tracking and suggested actions |
| Semrush AI Visibility | $99/mo | 25 prompts on Google AI Mode and ChatGPT | No. Tracking and recommendations |
| The Prompting Company | $99/mo | 25 prompts on 3 engines | Articles from $299/mo; managed service $3,000/mo |
| AthenaHQ | $295/mo | 3,600 answers across 11 models | Partly. Content help |
| Scrunch | $300/mo | 350 prompts, marketing teams | No. Tracking and guidance |
| Profound | Custom | Enterprise, up to 9 engines | Yes. Rewrites and stages pages |

Short version:

- **Small business that wants it done:** Atris. Free check first.
- **Cheapest tracking:** Otterly.AI.
- **Marketing team with dashboards:** Peec AI.
- **Already on Semrush:** Semrush AI Visibility.
- **Large enterprise:** Profound.

Full write-up with each tool:
[atris.ai/blog/best-tools-to-check-if-chatgpt-recommends-your-business](https://atris.ai/blog/best-tools-to-check-if-chatgpt-recommends-your-business)

## What actually gets you named

Research on why answer engines cite one page over another (Chen and Koudas,
[arXiv 2610.15033](https://arxiv.org/abs/2610.15033)) found that ranking in
search results for the questions the engine searches explains far more than
anything on the page itself. So in order:

1. Get indexed by the search engines the answer engines use (Bing for ChatGPT).
2. Be on the lists and comparison pages that already rank for your category.
3. Publish a page that answers the buyer's exact question in its title and
   first sentence, with prices and location.
4. Make that page readable without scripts, with structured data.

## Questions

**How do I check if ChatGPT recommends my business?**
Ask ChatGPT the questions your customers ask, several times each, and count
how often you are named. Or run the free check at atris.ai/aeo/check, which
does it for you and shows who is named instead.

**How do I check if ChatGPT can read my website?**
Run `npx -y atris aeo scan yoursite.com`. It checks robots.txt, plain-text
versions, words visible without scripts, structured data and sitemap, and
gives each gap a fix.

**What is the cheapest answer engine tracking tool?**
Otterly.AI, from $29 a month for 15 prompts on 4 engines, as of November 4,
2026.

**What is the difference between a tracker and a service?**
A tracker shows where you appear and leaves the fix to you. A service, like
Atris, also writes and publishes the page that gets you named.
