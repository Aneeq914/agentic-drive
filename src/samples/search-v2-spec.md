# Search v2 — Engineering Spec (Acme Retail storefront)

Owner: Daniyal Qureshi (Engineering Lead)
Contributors: Fatima Noor, Rabia Anwar (Backend); Hamza Iqbal (Frontend); Ali Hassan (QA)
Product: Zara Sheikh
Status: Approved (v1.2, 2026-08-21)
Related: SOW-01 under MSA BL-MSA-2026-007, kickoff notes from 2026-08-11

## Problem
About 18% of searches on acmeretail.example return zero results. Most failures are typos ("snekers"), local names ("kurti" vs "kurta") and plurals. The current search is a SQL `LIKE` query on product titles, so it has no ranking at all.

## Goals
- Zero-result searches below 5% within 30 days of launch.
- Results on screen in p95 < 250 ms at 50 queries/second.
- Shoppers can narrow results by category, size, colour, price band and stock status.

## Non-goals
- Personalised ranking and "recently viewed" boosts (moved to after launch).
- Searching blog or editorial content.

## Requirements
1. Index all ~18,000 SKUs from Acme's inventory system. Full re-index nightly, plus stock changes within 5 minutes.
2. Typo tolerance: 1 typo for words of 5–8 letters, 2 for longer words.
3. A synonym list that Acme's team can edit in the CMS without a deploy.
4. Faceted filters with counts. A selected filter must never show a count of 0.
5. Every zero-result query is logged with a timestamp so Acme can add synonyms.
6. Autocomplete after 2 characters, returning up to 6 products and 3 categories.

## Architecture
- **Engine:** self-hosted OpenSearch (2 nodes) on CloudNest Hosting, in the same region as the storefront.
- **Indexer:** a Node.js worker reads the inventory API and pushes bulk updates. Stock changes arrive through a webhook queue.
- **API:** `GET /api/search?q=&filters=&page=` in the storefront's Node.js backend. Responses are cached at the edge for 60 seconds.
- **Frontend:** a React search overlay with debounced input (150 ms) and keyboard navigation.

## Testing
- A relevance set of 120 real queries from Acme's search logs, each with expected top-3 results. The target is 90% hit@3.
- k6 load test at 50 queries/second for 10 minutes on staging.

## Milestones
- Sep 4: staging index with all SKUs
- Sep 25: filters and synonyms complete
- Oct 23: relevance target met, load test passed
- Nov 20: live with the redesigned site
