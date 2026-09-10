# Engineering Principles

Tools are replaceable. The standard is not.

Atris engineering follows one discipline:

> Make it better, faster, and stronger with the least unnecessary cost and
> complexity.

These qualities are not slogans. Every meaningful technical choice should state
what improves, how it will be measured, and what tradeoff is being accepted.

## Better

Better begins with the person's life, not the elegance of the stack.

A change is better when it produces a useful capability, removes friction,
improves judgment, or makes the system easier to trust. Novelty, abstraction,
and technical sophistication are not improvements by themselves.

Define the outcome before selecting the technology.

## Faster

Speed has several forms:

- time until the person receives value
- response time of the running product
- time required to build and revise
- time required to learn whether an idea works

Name which speed matters. A faster response that takes months to build may be
the wrong trade. A quickly shipped feature that slows every future change is
not fast.

Prefer the shortest path to trustworthy evidence.

## Stronger

Stronger means the system continues to deserve trust as use grows and
conditions change.

Judge strength through reliability, security, privacy, recoverability,
observability, scalability, and cost efficiency. Do not claim strength from an
architecture diagram. Demonstrate it under the conditions that matter.

Strength includes the ability to stop, repair, migrate, and replace.

## Simpler

Use the fewest moving parts that can meet the present need without blocking the
next credible step.

Do not add a service because it might become useful. Do not preserve a service
because choosing it once has become an identity. New infrastructure must earn
its operational cost.

Prefer:

1. an existing capability over a new dependency
2. a direct path over an abstraction without two real uses
3. one source of truth over synchronized copies
4. reversible choices while evidence is weak
5. boring infrastructure where novelty creates no user value

Simplicity is not refusing scale. It is refusing imaginary scale.

## Cheaper

Cost includes money, latency, maintenance, attention, migration risk, and the
number of ways a system can fail.

Choose the lowest total cost that still satisfies the required quality,
performance, and safety. The cheapest component can produce the most expensive
system if it creates manual work or unreliable behavior.

Spend complexity only where it creates a durable advantage.

## Architecture follows responsibility

Every component should have one clear responsibility and one clear source of
truth.

For the current Atris architecture:

- a computer executes work and enforces local permissions
- structured state belongs in the primary relational database
- large artifacts belong in object storage
- the Meta examines process and proposes memories, triggers, or corrections
- Genesis constrains what the system may optimize or authorize

These are responsibilities, not permanent vendor commitments. Supabase, S3,
models, and runtimes may change when evidence shows a better choice.

## Decisions leave receipts

Record consequential engineering decisions in a short, testable form:

```text
decision:
person and outcome:
better:
faster:
stronger:
simpler:
total cost:
tradeoff accepted:
evidence:
revisit when:
```

A decision record exists to make correction easier. It should not become a
ceremony that delays reversible work.

## The choice rule

When comparing options:

1. State the person's desired outcome.
2. Set the Genesis limits that cannot be traded away.
3. Define the minimum evidence required.
4. Compare total cost, not vendor price alone.
5. Prefer the simplest reversible option that meets the need.
6. Test it against the real workflow.
7. Keep, revise, or replace it based on what happened.

No tool wins by reputation. No architecture wins by fashion. The best choice is
the one that produces the strongest verified improvement for the person while
preserving the freedom to change.
