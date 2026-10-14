# RFC-042: Idempotent monthly billing run

- **Author:** Femi Adeyemi (Platform)
- **Org:** Coastline Water Co-op
- **Status:** In review
- **Reviewers:** billing squad, finance systems

## Summary
Rewrite the monthly job that generates customer invoices so that it can be safely re-run after a crash without producing duplicate invoices or double-charging direct debits.

## Motivation
In August the batch died at 61% after a DB failover. Re-running it created 3,412 duplicate invoices and we had to issue credit notes by hand. Finance spent four days reconciling.

## Proposed design
1. Each run gets a `run_id`. For every account we compute a deterministic key `(account_id, billing_period)`.
2. Invoice creation becomes an upsert on that key; a unique constraint on `(account_id, billing_period)` stops duplicates at the DB layer.
3. Direct-debit requests are only queued after the invoice row commits, using an outbox table.
4. The job processes accounts in chunks of 500 and checkpoints after each chunk so a restart resumes rather than starting over.

## Alternatives considered
- Distributed lock around the whole run: doesn't help with partial completion.
- Manual dedupe script after the fact: what we do now; error-prone.

## Rollout
Shadow-run alongside the current job for October, compare outputs, switch in November.

## Risks / open questions
- Mid-month tariff changes: do they need a separate period key?
- Outbox worker throughput at month-end peak (~180k accounts).
