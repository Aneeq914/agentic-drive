# Weekly Engineering Standup — 2026-09-07

Date: 2026-09-07 (Monday, 10:00–10:20)
Facilitator: Daniyal Qureshi (Engineering Lead)
Attendees: Zara Sheikh (Product Manager), Fatima Noor (Backend), Rabia Anwar (Backend), Hamza Iqbal (Frontend), Mehwish Javed (Product Designer), Ali Hassan (QA)

## Updates

**Fatima** — Last week: loaded all 18,000 Acme Retail SKUs into the search v2 staging index. This week: faceted filters (size, colour, price band) behind the feature flag.

**Rabia** — Last week: first pass of the synonym list ("trainers" = "sneakers", "kurta" = "kurti" and others). This week: typo tolerance and the zero-results logging endpoint.

**Hamza** — Last week: homepage hero and product card components in Storybook. This week: product detail page (PDP) layout, mobile first.

**Mehwish** — Last week: Acme homepage, category and PDP designs v2 are in review with Hira Saleem from Acme's brand team. This week: final changes before design sign-off on Sep 18.

**Zara** — Northwind discovery: 8 of 12 patient interviews done, the last 4 are booked for Wed–Thu. The clickable prototype is due on Sep 11. Discovery wraps up on Sep 14, so Finance can invoice it the next day.

**Ali** — Wrote the search v2 test plan (relevance set of 120 real queries from Acme's logs). Started the device matrix for the Acme mobile QA.

## Blockers
- We still don't have admin access to Acme's staging CMS. Kamran Aziz promised it last Thursday.
- Search latency on staging is p95 = 410 ms, but the spec target is 250 ms. Fatima thinks the price-band facet is the cause.
- The backend team is stretched. The Senior Backend Engineer job description goes live tomorrow (Sep 8).

## Decisions
- We agreed to ship search v2 without the "recently viewed" boost and add it after launch.
- Design sign-off stays on Sep 18. Any late Acme feedback goes into a change request.

## Action Items
- [ ] Daniyal will chase Kamran for the CMS credentials today.
- [ ] Fatima will profile the price-band facet query and report back on Wednesday.
- [ ] Zara will send the Northwind prototype link to Dr. Nadia Hussain by Sep 11.
- [ ] Ali will share the device test matrix in #acme-redesign by Sep 9.
