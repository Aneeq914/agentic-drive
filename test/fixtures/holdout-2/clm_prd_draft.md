# PRD: Clause Library & Contract Intake (internal)

Owner: Product team, Pemberton Vale LLP · Status: Draft 0.3 · Last edit 5 Oct 2026

## Background
Associates currently draft NDAs, engagement letters and supplier agreements from old Word files saved on the shared drive. The result is inconsistent indemnity and limitation-of-liability clauses and a lot of time spent hunting for "the good version".

## Goals
1. One approved clause library that drafting tools pull from.
2. A structured intake form so a new contract request captures counterparty, governing law, term and value before drafting starts.
3. Reduce average time-to-first-draft for standard NDAs from 2 days to 4 hours.

## Non-goals
- E-signature (we keep the current provider)
- Negotiation redlining — phase 2

## User stories
- As an associate, I can search clauses by type and jurisdiction and insert one into a draft.
- As a knowledge lawyer, I can mark a clause as deprecated and see every live template using it.
- As a partner, I get notified when a request's value exceeds £250k.

## Requirements
| ID   | Requirement                                              | Priority |
|------|----------------------------------------------------------|----------|
| R-01 | Clause records have type, jurisdiction, version, owner   | Must     |
| R-02 | Full-text search across clauses, < 1s for 5k clauses     | Must     |
| R-03 | Intake form with required fields, saved to matter record | Must     |
| R-04 | Audit log of clause edits                                | Should   |
| R-05 | Export template to .docx with clause references          | Could    |

## Success metrics
Time-to-first-draft, % of new contracts using library clauses, associate satisfaction survey.

## Open questions
- Do we migrate the 1,900 legacy templates or start fresh?
