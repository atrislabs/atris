# inspiration

Keshav's dump-anytime doc. Agents work this all day, every day.

## the contract (every entry ripens through four fields)

- **idea**: one line, what it is
- **why**: one sentence, the business reason
- **how to do it right**: the specific way, with real files to look at (verified
  paths only; if unverified, say "paths unverified, explore first")
- **validate**: how we SEE a result. Must observe the thing working, never lazy,
  never a claim without a receipt

Rules for agents sweeping this doc:
- an entry with all four fields is dispatchable: turn it into a task
  (`atris task delegate`) or a wish, link the entry to the task id, move on
- an entry missing fields is NOT buildable: sharpen it by asking Keshav or by
  proposing the missing fields in place (mark proposals `[proposed]`)
- ripened entries get pruned once shipped; git history is the archive
- the alpha judge treats this doc as a candidate source on every pass

---

## entry 1: postgres input and output (2026-07-09)

- **idea**: atris can read from and write to a postgres database as a first-class
  input/output, so organs can work real business data.
- **why**: every real business keeps its truth in a database, and an organ that
  cannot touch the customer's actual data can only ever verify in toy currency.
- **how to do it right**: zero-dependency policy holds (Node built-ins only, see
  package.json), so do NOT add a pg client. Two honest routes: shell out to
  `psql` when present (same pattern as Chrome detection in the card/reel
  pipeline), or route through atrisos-backend for hosted connections. Follow the
  det-scripts pattern (scripts/det/) for deterministic query runners: cheap
  models run tools, not SQL-by-vibes. Read access ships first; writes are a
  protected lane (real customer data) and need explicit scope per table.
  [paths beyond scripts/det and package.json unverified, explore first]
- **validate**: a live round trip observed end to end: seed a local postgres,
  `atris <verb> "top 10 customers by revenue"` returns the actual rows, and the
  result lands as a blocks doc artifact a human can open. No mocked driver
  passes as proof.

## entry 2: replicate databricks as the data organ (2026-07-09, 3:01am energy)

- **idea**: the data platform organ of business-in-a-box: databricks' surface
  area, rebuilt on the atris substrate, sold to businesses that will never hire
  a data engineer.
- **why**: databricks proved companies pay enormous money for "all your data,
  governed, queryable, with notebooks and jobs on top," and no small business
  can afford the real thing or the staff to run it.
- **how to do it right (the specific UI mapping, on atrisos-web)**:
  - their **notebook** = our **blocks doc with runnable cells**: markdown +
    query cells backed by entry 1's postgres runner; results render as the
    existing chart/table/metric blocks (the obelisk editor already renders
    these; the new part is a cell that executes and pins its result + timestamp)
  - their **catalog / lakehouse browser** = our **folder**: atris/ + .atris/state
    rendered as a browsable tree with MAP.md as the semantic index; every
    dataset page shows lineage as receipts (which mission produced it, when,
    verified by what)
  - their **sql editor + results grid** = one web surface: query box, results
    grid, "save as block" button; nothing more in v1
  - their **jobs & runs page** = our **missions + stream**: already exists as
    atris stream/receipts; the replication is rendering scheduled queries as
    missions with tick receipts
  - their **governance** = our **receipts + security-review**: access receipts
    per query, the security organ watching the till
  - explicitly NOT replicated in v1: spark, autoscaling clusters, multi-cloud,
    delta lake. Small businesses have gigabytes, not petabytes; postgres + files
    is the whole lakehouse at this scale. That constraint is the selling point,
    not a weakness.
- **validate**: one non-technical operator connects a postgres, asks one
  question in plain english, watches the notebook cell run, and gets a chart
  block they can share. Observed live, screen recording as the receipt.

## entry 3: business-in-a-box suite doctrine (2026-07-09, pinned from journal)

- **idea**: own every core business function under one umbrella: rainmaker
  (gtm), popshare (marketing), aeo (search + agentic awareness), security
  (self-improving protection swarm), data (entry 2). One sub, credits included,
  buy more credits.
- **why**: the moat is the shared substrate (folder, wish loop, receipts,
  self-improvement): every organ is born with distribution and compounding
  lessons, which point-SaaS cannot copy without rebuilding the organism.
- **how to do it right**: suite is the map, not the build order. No new organ
  starts until the previous one has a stranger's receipt. Sequence: till (verify
  money) -> rainmaker (the organ that feeds the others) -> next organ by
  receipt-proven demand. Sell custody, not outcomes: the interview is the sales
  call (`atris meet`), the promise is a named metric with a floor in the
  niche's own currency, and honest receipts are the differentiator.
- **validate**: one founder, sourced from linkedin, through meet -> mission ->
  weekly receipt, paying. That single paid receipt validates the doctrine;
  nothing else does.

## entry 4: the paper-cut tap (2026-07-09, keshav priority)

- **idea**: keshav reports friction at any random moment, in any words ("the
  wish label shortens my phrasing"), and the system converts it into a precise
  repro, a bounded fix task, and a regression test, at 100% capture rate.
- **why**: keshav's taste is the scarcest resource in the company, and today it
  evaporates unless he stops to file it properly; the last mile to a respectable
  product is a thousand paper cuts only he can feel.
- **how to do it right**: front door must be zero-friction from anywhere: a one
  liner (`atris ow "<what happened>"` or similar) plus imessage capture (the
  imessage skill already reads local messages). Each capture becomes: exact
  live-surface repro FIRST (run the real command, see the real output, per the
  verify-real-not-mock lesson), then a task with the repro attached, then the
  fix, then a regression test named after the capture. The linguist owns
  wording cuts; executor owns behavior cuts. Never closed without keshav seeing
  the before/after.
- **validate**: keshav fires 10 random captures over a day; 10 become repros
  within the hour, and the before/after of each fix is shown back to him. The
  metric IS the capture rate: anything dropped is a system failure.

## entry 5: every organ gets a page (2026-07-09)

- **idea**: atris.ai/rainmaker, atris.ai/agentgrads, atris.ai/aeo, one page per
  organ: what it does, the medicine for its niche, live receipts, one button
  (start the interview).
- **why**: a linkedin opener with nowhere to send people closes zero loops;
  the page is where a stranger's curiosity becomes an interview.
- **how to do it right**: atrisos-web owns the pages; atris site machinery +
  theme system already generate beautiful on-brand static surfaces from
  markdown, so each organ page is a markdown doc the organ's own loop keeps
  fresh (receipts section updates from real data). Page contract: the promise
  with a named metric, proof (live receipts, not testimonials), the interview
  button. No pricing tables in v1, one sub + credits, stated in one sentence.
- **validate**: a stranger lands on atris.ai/rainmaker, clicks once, and is in
  the meet interview. Observed via a real outsider, not us.

## entry 6: any repo on a cloud computer, and it just works (2026-07-09)

- **idea**: take any repo (sfhq, a code project), put it on a cloud computer
  with env keys, drop atris/ in, and the self-improvement loop runs there
  around the clock: an atris project built on top, living in a computer.
- **why**: the loop currently improves what sits on keshav's laptop; victory
  needs the organism to run anywhere a business's code actually lives.
- **how to do it right**: this is roadmap stage 4 (durable foundation) pulled
  forward and married to the real --cloud epic already in ROADMAP.md big jobs.
  Spine: same mission runtime, remote checkout, env vars provisioned once,
  receipts stream back to the operator surfaces. Golden path test is the
  definition: fresh cloud box, git clone, atris init, keys in, mission start,
  and a landed verified change within the first hour, zero babysitting.
  [implementation paths live in atrisos-backend, unverified, explore first]
- **validate**: sfhq (or one real non-cli repo) runs a full unattended day on a
  cloud computer and lands 3+ verified changes with receipts keshav can read
  from his phone.

## entry 7: rainmaker closes loops, not sends (2026-07-09, from zero-response reality)

- **idea**: outreach is a mission with a verifier (reply, then booked call),
  never a send. Every email/dm has a follow-up cadence, a personalization
  source, and a page to land on (entry 5); no response after the cadence = a
  typed lesson about the niche or the pitch, fed back into the next batch.
- **why**: every email so far got zero responses because a send without a
  closed loop is spray; the system that treats silence as data will find the
  pitch that works, the one that treats sends as done never will.
- **how to do it right**: personalize from the target's public exhaust (the
  closure-scan pattern: find the loop THEY have open that we close). Batch
  small (10), verify replies via the email integration, escalate booked calls
  to keshav's calendar. The wish "1k subscribers" decomposes into: pages ->
  openers -> cadences -> interviews -> tills.
- **validate**: one batch of 10 with full loop instrumentation produces either
  a reply or a typed lesson per target: zero silent drops.
