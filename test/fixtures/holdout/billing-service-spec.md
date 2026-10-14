Billing Service v2 — Technical Specification
Owner: Platform team, Nimbus Metrics | Status: Draft for review

Goal
Replace the nightly cron that generates customer invoices with an event-driven service, so invoices go out within minutes of a usage period closing.

Requirements
1. Generate one invoice per workspace per billing period, including line items for seats, overage and credits applied.
2. Totals must be computed in minor units (cents) and rounded once, at the invoice level.
3. Re-running generation for a period must be idempotent — the same invoice number, never a duplicate.
4. Emit invoice.finalized and invoice.voided events for the receipts emailer and the ledger.

Out of scope
Tax calculation (stays with the existing provider), dunning emails, refunds.

Open questions
- Do we backfill invoices for the 40 legacy annual-plan customers or leave them on the old path?
- Where should PDF rendering live?

Milestones: data model frozen Nov 3, shadow mode Nov 24, cutover Dec 8.
