# Brightleaf Build Day 2026 — Problem Statement

**Event:** Brightleaf Build Day (internal hackathon)
**When:** Friday 2026-09-18, 09:00–19:00, Gulberg office
**Organisers:** Zara Sheikh (Product Manager) and Daniyal Qureshi (Engineering Lead)
**Teams:** 3 to 4 people, mixed across design, engineering and ops

## The problem
Our shared drive is a junk drawer. Proposals, contracts, meeting notes, receipts and CSV exports all land in one folder with names like "final-v3-REAL.pdf". When Omar needs every vendor bill for the quarter, or Sara needs the numbers from three campaign reviews, someone loses an afternoon opening files one by one.

**Challenge:** build a prototype of an *agentic drive*: a file store where AI agents read every upload, understand it and do the boring work for us.

## Example tasks your agent could handle
These are examples, not a checklist. Pick the ones that make the best demo.
1. **Auto-organise.** Work out what each file is (a contract, a meeting note, an invoice and so on) and file it without anyone dragging folders.
2. **Pull out invoice fields.** For every invoice, read the vendor, invoice number, date and total, then add them to a running expenses CSV.
3. **Answer questions.** "What did CloudNest charge us in Q3?" or "What did we decide about TikTok ads?", answered with links to the source files.
4. **Write across documents.** Combine the three Q3 marketing meetings into one summary with the totals and decisions.
5. **Follow up on actions.** Find the action items in meeting notes and list them by owner and due date.

## Rules
- Use only the sample files in the shared "build-day-samples" folder. Never use real client data, including anything from Acme Retail or Northwind Health.
- Any language or stack is fine. Using an LLM API is allowed, but the app must still work, in a basic way, without an API key.
- Demos are 5 minutes, live, and include one thing that went wrong.

## Judging (100 points)
| Criterion | Points |
|---|---|
| Usefulness to a real studio like ours | 35 |
| Does it actually work in the live demo? | 30 |
| Quality of the agent's reasoning (no confident nonsense) | 20 |
| Polish and UX | 15 |

## Prizes
First place gets PKR 50,000 and a day off. Every team gets dinner. The winning prototype may become a Q4 internal tool.

Questions go to Zara in #build-day.
