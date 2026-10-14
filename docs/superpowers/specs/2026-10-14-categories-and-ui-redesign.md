# Categories, Mock Data & UI Redesign — Design Spec

Date: 2026-10-14
Builds on: `2026-10-14-agentic-drive-design.md`

## 1. Problem

The Organizer filed the hackathon brief PDF as an **invoice in Finance**. The cause is that it uses simple rules:
- **Type:** any text containing "invoice" + "total" is an invoice.
- **Folder:** picked by counting topic keywords.

As a result, documents that *talk about* a thing get filed as that thing.

**Decisions taken with the user:**
- Group files by **document kind**.
- Add about **30 mock files** from one fictional company.
- Redesign the UI in a **polished, Linear-like** style, iterated in Chrome via Claude-in-Chrome.

## 2. Success criteria

1. Every bundled sample file is classified to its labelled kind (100%).
2. On a separate **holdout** set of tricky texts, written blind to the classifier rules, at least 85% are classified to the labelled kind. A brief/problem-statement document lands in Proposals & Briefs, never in Invoices.
3. A wrong guess is fixable: "Move to…" pins a file and agents never re-sort it.
4. Existing drives keep working: on startup, records without a `kind` are re-sorted offline.
5. The UI matches §6 and is checked in a real Chrome window at desktop and mobile widths.
6. `npm test` passes, including the accuracy tests in criteria 1–2.

## 3. Kinds (sidebar categories)

| id | Label | Examples |
|---|---|---|
| `invoice` | Invoices & Receipts | invoices, receipts, bills |
| `meeting` | Meeting Notes | minutes, standups, 1:1 notes |
| `contract` | Contracts & Agreements | MSAs, NDAs, SOWs, leases |
| `proposal` | Proposals & Briefs | proposals, project briefs, problem statements, RFPs |
| `spec` | Specs & Plans | product/engineering specs, PRDs, roadmaps, project plans |
| `report` | Reports | reports, analyses, reviews, research, blog posts / articles |
| `data` | Spreadsheets & Data | every .csv |
| `people` | People & HR | resumes/CVs, job descriptions, HR policies, offer letters |
| `other` | Other | anything the agent is not confident about |

- **One file, one kind.** Every file has exactly one kind.
- **Generated view:** agent-made files also carry a kind (`expenses.csv` → data, action items → meeting, synthesized docs → report). In addition, a separate **Generated** sidebar view lists every file with `generated: true`.
- **Topic** is a second label, shown as a chip and filterable. It is one of Finance, Marketing, Engineering, Sales, HR, Legal, Operations, Product, or `null` when it is unclear.

## 4. Classifier (offline)

`src/agents/classifier.js` (pure functions, unit tested) exports:
- `KINDS` and `TOPICS`
- `classifyKind({name, ext, text}) → {kind, confidence: 'high'|'medium'|'low', scores}`
- `classifyTopic({name, ext, text}) → string|null`

**Scoring rules:**
- **`.csv` files** are always kind `data`, with high confidence.
- **Strong structural signals (weight 3):** label lines at the start of a line. Examples:
  - invoice: `Invoice Number:`/`Invoice #`, `Bill To:`, `Total Due:`/`Amount Due:`/`Balance Due:`, `Receipt`
  - meeting: `Attendees:`, `Agenda`, `Action Items`, `Minutes`
  - contract: `This Agreement`, `WHEREAS`, `Term and Termination`, `Signature`, `Parties`
  - people: `Experience`, `Education`, `Skills` headings, `Job Title:`, `Responsibilities`
  - spec: `Requirements`, `Acceptance Criteria`, `Architecture`, `Milestones`
  - proposal: `Problem Statement`, `Proposal`, `Objectives`, `Deliverables`, `Scope`, `Judging Criteria`
  - report: `Executive Summary`, `Findings`, `Conclusion`, `Key Metrics`
- **Title signals (weight 2):** kind words in the file name or the first heading or line.
- **Body words (weight 0.5 each, capped at 3 per kind):** a document that merely *mentions* "invoice" many times cannot outscore the structure of a real document.
- **Invoice gate:** to be an invoice, a file needs **at least 2 distinct invoice structure signals** AND a money amount.
- **Confidence:**
  - `high` when the top score is ≥ 6 and leads the runner-up by ≥ 3.
  - `medium` when the top score is ≥ 3 and leads by ≥ 1.5.
  - Otherwise `low`. A `low` result is filed as `other`. Its runner-up kind is kept in `scores` so the UI can say "Looks like a Report?".
- **Topic:**
  - **Scoring:** keyword hits per topic, normalised by text length. File-name and title words count ×2. For CSV files, only the header row and the file name count.
  - **Minimum:** below 2 hits, the topic is `null`.
- **With AI:** the model picks from the fixed kind ids and topic names (strict JSON). An invalid value falls back to the offline result. `.csv` is always `data`.

The Organizer keeps its role (tags, summary, AI-then-offline). It now uses the classifier and returns `{kind, topic, confidence, tags, summary, by}`.

## 5. Data model & API changes

- **File record:** `type` and `folder` are replaced by `kind`, `topic`, `confidence` and `pinned` (bool). Everything else is unchanged.
- **Migration:** on startup, every record without `kind` (and not pinned) is re-classified offline from its stored text, without AI calls. Old `type`/`folder` fields are dropped.
- **Automations:**
  - `invoice-to-csv` runs when `kind === 'invoice'`.
  - `meeting-action-items` runs when `kind === 'meeting'`.
  - Outputs carry a kind (`data` / `meeting`), and the topic is copied from the source file.
  - They never run on generated or pinned-moved files after the first ingest. Moving a file does not re-run automations.
- **New and changed routes:**
  - `GET /api/meta` → `{kinds: [{id, label}], topics: string[]}`
  - `PATCH /api/files/:id` with `{kind?, topic?}` → the updated record, with `pinned: true`. An invalid kind or topic → 400; unknown id → 404. The activity entry reads "Moved X to <Label> (pinned by you)".
  - Every other route keeps its path and shape, except that records now use the new fields.

## 6. Mock data (src/samples/, about 30 files)

- **The company:** fictional "Brightleaf Labs" (a small product studio), with documents dated Q3 2026.
- **Kept:** the existing 8 samples. Their facts are used by tests.
- **New files** (about 22), spread across every kind:
  - at least 3 invoices or receipts (≥1 PDF)
  - 2 contracts (MSA, NDA)
  - 2 proposals or briefs
  - 2 specs or plans
  - 3 reports
  - 2–3 CSVs (sales pipeline, headcount)
  - 2–3 people/HR files (a resume PDF, a job description, a policy)
  - more meeting notes
- **Decoys:**
  - meeting notes that discuss unpaid invoices
  - a contract with payment amounts
  - an article-style report about invoicing software
  - a proposal containing a budget table
  - a hackathon-style problem statement
- **Labels:** `test/fixtures/sample-labels.json` maps every sample file to `{kind, topic}`.
- **Holdout set:** `test/fixtures/holdout/` holds about 15 short tricky texts, plus `labels.json`. They are written by someone who has not seen the classifier code.

## 7. UI redesign (public/, no frameworks/CDNs)

**Style:**
- Linear-like: crisp and minimal, soft neutral greys, one accent colour, tight typography, subtle borders and shadows.
- Light theme, with automatic dark mode via `prefers-color-scheme`.

**Top bar:**
- The brand.
- A command-bar **"Ask your drive…"** input. ⌘K / Ctrl+K focuses it. Answers drop down beneath it, with `[n]` citations that open files.
- The AI status pill.
- The Upload button.

**Sidebar:**
- All files, Recent.
- **Categories:** each kind with an icon and a count; empty kinds are hidden except Other.
- **Topics:** chips.
- Generated.
- Automations, which opens a panel with toggles.
- The sample-loader button, shown when the drive is empty.

**Main area:**
- A list/grid toggle.
- List columns: name (with kind icon), topic, updated, size.
- A sortable header.
- Row checkboxes. Selecting files shows a floating **selection bar**: "N selected → Combine into Requirements / Summary / Compare", plus Clear.
- Low-confidence files show a subtle "Needs a look" marker.

**Preview drawer (right, slide-in):**
- The name, kind, topic, confidence, summary and tags.
- A **"Move to…"** menu that calls PATCH.
- Download and Delete.
- The file body (CSV table / safe Markdown / text).

**Activity:** a collapsible "Agent activity" timeline: a bottom-right panel on desktop, a sheet on mobile.

**Behaviour:** everything the current UI already guarantees still holds:
- every interpolated string is escaped
- no `alert`/`confirm` dialogs
- 3-second polling
- drag-and-drop upload
- no horizontal scroll at 390px
- `:focus-visible` rings
- `prefers-reduced-motion` respected

**Iteration:** the redesign is reviewed in the user's Chrome via Claude-in-Chrome screenshots at desktop and mobile widths, and fixed until it looks right.

## 8. Testing

- **Unit tests** for the classifier: signals, the invoice gate, confidence, CSV, topics.
- **Accuracy tests:**
  - every sample matches its label exactly
  - the holdout scores ≥ 85%
  - a brief-like text never comes out as `invoice`
- **Store/server tests:**
  - the migration of old records
  - `PATCH` (pin, 400 on invalid input, 404 on unknown id)
  - `GET /api/meta`
  - existing flows updated to the new fields
- **UI checks:** `node --check`, plus Chrome screenshots of all states.

## 9. Out of scope

- Learning from user moves.
- Nested folders.
- Multiple kinds per file.
- Embeddings.
