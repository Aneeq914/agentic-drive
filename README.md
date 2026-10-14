# Agentic Drive

Agentic Drive is a small cloud-drive prototype where AI agents do the filing, searching and paperwork for you. When a file arrives, an Organizer agent reads it and puts it on the right shelf: a document **kind** such as Invoices & Receipts, Meeting Notes or Contracts & Agreements, plus a **topic** label such as Finance or Marketing. Automations then react to it (invoices go into a spreadsheet, meeting notes turn into a to-do list), and you can ask questions across all your files or combine several files into one new document. It runs fully offline with rule-based agents, and gets smarter if you add a Gemini or Claude API key.

Built for the hackathon brief **"Build the Next-Generation Agentic Workspace"** (Agentic Drive).

## What's new in this version

- **Categories are now document kinds, not topic folders.** The first version filed the hackathon brief PDF itself as an *invoice* in *Finance*, just because the brief mentions "invoice" and "total". A new classifier looks at how a document is built, not only at the words it uses. The same brief now lands in **Proposals & Briefs**.
- **Unsure files go to Other.** When the classifier is not confident, the file goes to **Other** and shows up under **Needs a look**, instead of being filed on the wrong shelf.
- **"Move to…" lets you fix a file.** It records your choice and pins the file, so no agent re-sorts it.
- **Accuracy is measured**, including on a blind set of documents the rules were never tuned against (see [How accurate is the Organizer?](#how-accurate-is-the-organizer)).
- **32 mock files** from a fictional company, Brightleaf Labs, including decoys built to trip the classifier.
- **More robust offline search.** Answers check that a line covers the whole question, money questions take one line per file, and unknown names get "not found".
- **A new Linear-style interface:** an "Ask your drive…" command bar, a sidebar of categories and topics, list and grid views, a selection bar for combining files, a preview drawer, dark mode, and a layout that works on phones.
- **Old drives are migrated automatically.** On startup, files saved by the old type/folder version are re-sorted offline.

## The 4 features, mapped to the brief

The brief lists four agentic capabilities. Agentic Drive has one agent for each.

| Brief capability | Agent | Code | Where you see it |
|---|---|---|---|
| 1. Proactive Organization | Organizer (with the offline classifier) | `src/agents/organizer.js`, `src/agents/classifier.js` | Sidebar **Categories** and **Topics**, the **Needs a look** view, **Move to…** |
| 2. Semantic Retrieval | Search | `src/agents/search.js` | The **Ask your drive…** command bar (Ctrl+K / ⌘K) |
| 3. Cross-Document Synthesis | Synthesizer | `src/agents/synthesizer.js` | Tick files, then **Combine into Requirements / Summary / Compare** |
| 4. Automated Workflows | Automations | `src/agents/automations.js` | `expenses.csv`, action-item files, the **Automations** panel |

### 1. Proactive Organization: the Organizer

Every upload goes through the same pipeline (`src/pipeline.js`): extract the text, save the file, run the Organizer, then run the automations.

The Organizer gives each file:

- a **kind**: one of the nine categories below
- a **topic**: Finance, Marketing, Engineering, Sales, HR, Legal, Operations or Product, or none when it is unclear
- a **confidence**: high, medium or low
- a few **tags** and a **one-line summary**

You never create a folder. The sidebar shows each category that has files (Other is always shown), with a count next to it.

| Kind | Sidebar label | Examples |
|---|---|---|
| `invoice` | Invoices & Receipts | invoices, receipts, bills |
| `meeting` | Meeting Notes | minutes, standups, 1:1 notes, retros |
| `contract` | Contracts & Agreements | MSAs, NDAs, statements of work |
| `proposal` | Proposals & Briefs | client proposals, project briefs, problem statements |
| `spec` | Specs & Plans | product and engineering specs, RFCs, roadmaps, project plans |
| `report` | Reports | reports, analyses, incident reviews, articles |
| `data` | Spreadsheets & Data | every `.csv` |
| `people` | People & HR | resumes, cover letters, job descriptions, HR policies |
| `other` | Other | anything the Organizer is not confident about |

**How the offline classifier decides (`src/agents/classifier.js`).** It skims a file the way a person would. It asks whether the file *looks* like an invoice, not just whether it *talks about* invoices. Each kind gets a score:

- **Structure counts most: 3 points per distinct signal.** A signal is a label line at the start of a line, such as `Invoice Number:`, `Bill To:`, `Attendees:`, `Agenda`, `WHEREAS`, `Acceptance Criteria`, `Executive Summary`, `Education`, a "Signed for …:" block, or a "6 min read" byline.
- **Title words: 2 points each, capped at 4.** These are words in the file name or the first line, such as "invoice", "minutes", "nda", "proposal", "spec", "report" or "resume".
- **Body words: 0.5 points each, capped at 3 per kind.** A document that just mentions "invoice" twenty times cannot beat the structure of a real invoice.
- **The invoice gate.** A file only counts as an invoice if it has **at least 2 different invoice structures and a money amount**. Otherwise its invoice score is capped at 2. This is the rule that stops briefs, meeting notes and articles about invoicing from being filed as bills.
- **Confidence.** It is *high* when the top score is at least 6 and leads the runner-up by at least 3. It is *medium* when the top score is at least 3 and leads by at least 1.5. Anything else is *low*, and a low-confidence file is filed as **Other**. The activity feed then says what it looked most like.

**Topic** is a second label, picked separately by counting topic keywords. Words in the file name count double, and for a CSV only the header row and file name count. With fewer than 2 hits the topic is left empty. A proposal addressed to a client ("Prepared for:" or "Valid until:") gets the topic Sales. Three topics are forced, with or without AI:

- **Invoices → Finance.** The PrintHub invoice is about a marketing campaign, but it is still Finance.
- **People & HR → HR.**
- **Contracts → Legal.**

**`.csv` files are always Spreadsheets & Data**, with or without AI. A PDF with no text layer (a scan) is still stored, but goes to Other with the summary "(no readable text)".

**Fixing a wrong guess.** Open a file and use **Move to…** (or **Set topic…**). This calls `PATCH /api/files/:id` and pins the file. The **Needs a look** flag goes away, the move is logged as "pinned by you", and no agent re-sorts the file, including after a restart. A move only changes labels: it does not re-run automations, so moving a report to Invoices adds nothing to `expenses.csv`.

**Old drives.** On startup, every saved record without a kind is re-sorted offline from its stored text, with no AI calls, and the old `type`/`folder` fields are removed. Records that already have a kind are never touched, so this is safe to run on every start.

### 2. Semantic Retrieval: the Search agent

Type a question in plain English into **Ask your drive…** at the top (or press Ctrl+K / ⌘K). The answer drops down under the bar with numbered citations like `[1]`. Click a citation to open the source file in the preview drawer.

How it works:

- **Passages.** Every file is cut into short passages, and a Markdown heading always starts a new passage. A CSV passage is its header line plus up to 8 rows, so spreadsheets are searchable too.
- **Ranking.** Passages are ranked with BM25. Question words are widened with a small synonym list: "spend", for example, also matches "budget", "cost" and "expense". Question words found in the file name, the document title or the section heading earn a bonus, and so do two question words written side by side ("Q3 revenue").
- **Coverage.** The final score also depends on how much of the question a passage covers. This keeps answers stable when the drive fills up with look-alike files.
- **Offline answers.** Up to 3 bullet points, each the best line from a top passage, with at most 2 lines per file.
  - Lines that miss a name the question asks about (for example "Acme") are dropped when another line has it. This stops a different vendor's payment terms from answering "What are the Acme payment terms?".
  - "How much…" questions want a line with an amount, prefer a total over a line item, and take one line per file. "When…" questions want a date.
- **Unknown names.** If the question names something with a capital letter that no file mentions (say "Globex"), the answer is "I couldn't find that in your files." The same answer comes back when nothing matches at all. Search does not guess.
- **With AI.** The model gets only the top 6 passages, must answer from them and cite them, and only the sources it actually cites are returned.

### 3. Cross-Document Synthesis: the Synthesizer

Tick two or more files (the checkbox on each row or card). A floating bar appears: **N selected → Combine into Requirements / Summary / Compare**. Pick one, and a new Markdown file opens in the preview drawer. It is saved as a Report (its topic is the most common topic of the files you picked) and listed under **Generated**.

There are three formats:

| Format | Offline output |
|---|---|
| Requirements (unified requirements doc) | Overview, Requirements, Decisions, Action Items (as `- [ ]` checkboxes), Key Figures |
| Summary | Overview, Key Points, Decisions, Key Figures |
| Compare | A side-by-side table (one row per file), Common Themes, Key Figures |

Offline, each extracted line ends with the file it came from, for example `(q3-marketing-kickoff.md)`. Every document, offline or AI, ends with a numbered **Sources** list of the input files. With AI on, the model writes the document from the files' text, and a Sources list is added if the model left it out.

### 4. Automated Workflows: the Automations agent

Two rules run on every upload, with no click needed. You can switch each one on or off in the **Automations** panel in the sidebar.

- **Invoice → expenses.csv**: when a file is filed as Invoices & Receipts, the agent reads the vendor, date, invoice number and total, and picks a category: Software, Travel, Marketing, Office, Utilities or Other. It then adds a row to `expenses.csv`, which is filed under Spreadsheets & Data with the topic Finance.
  - The columns are `date,vendor,invoice_number,category,total,currency,source_file`.
  - If the same invoice number (or, with no number, the same source file) is already there, the row is skipped, so uploading an invoice twice does not log it twice.
  - If no total can be read, nothing is written and the activity feed says why.
- **Meeting → action items**: when a file is filed as Meeting Notes, the agent pulls out the action items and saves them as `<meeting name> - action items.md`, a checklist with the same topic as the meeting.

Files the agents create are marked **Generated** and never run through the automations again, so one automation can't set off another in a loop.

Everything the agents do is written to the **Agent activity** panel, including what was filed where, with what confidence, and what was moved by you. The UI checks for new activity every 3 seconds.

## How accurate is the Organizer?

All numbers below are **offline** (no AI key), from `test/accuracy.test.js`, measured on 2026-10-14. That test compares the classifier's output against hand-written labels.

| Set | What it is | Kind correct | Topic correct |
|---|---|---|---|
| Samples (`src/samples/`, labels in `test/fixtures/sample-labels.json`) | The 32 Brightleaf files, decoys included. The rules were tuned on these | **32 / 32** | **32 / 32** |
| Holdout (`test/fixtures/holdout/`) | 16 short tricky texts written separately. The rules were later tuned against them too, so this number is optimistic | **16 / 16** | 15 / 16 |
| Holdout-2 (`test/fixtures/holdout-2/`) | 20 fresh texts written **blind, after tuning**, and never tuned against. **This is the honest number** | **16 / 20 (80%)** | 13 / 20 (65%) |

What the test enforces:

- every sample gets exactly its labelled kind and topic
- holdout kinds are at least 85% correct, and no brief comes out as an invoice
- holdout-2 kinds are at least 75% correct, **and every miss lands in Other**

On holdout-2, all 4 misses went to Other with low confidence, none to a wrong category. They were a credit note sent as an email, a catering proposal written as an email reply, a staff newsletter and a short plain-text write-up of quarterly sales. So on unseen documents, about 1 in 5 files will need a human "Move to…", but the Organizer did not confidently put a file on the wrong shelf.

**Topics are weaker than kinds.** On holdout-2 only 13 of 20 topics matched. Some files got no topic, and some got Finance or Legal because of words like "billing" or "contract". Treat the topic as a helpful hint, not a fact.

## The interface

The UI is plain HTML, CSS and JavaScript in `public/`, with no framework and no build step.

- **Top bar.** The brand, the **Ask your drive…** command bar (Ctrl+K / ⌘K) with cited answers, the AI status pill ("Offline agents" or the Gemini/Claude model), and **Upload**. You can also drag files anywhere onto the page.
- **Sidebar.**
  - **Drive views:** All files, Recent (the 10 newest), Generated (files the agents made) and Needs a look (low-confidence files you haven't moved yet).
  - **Categories**, with counts.
  - **Topic chips** that filter the current view.
  - **Automations** and **Agent activity**, each opening a panel.
  - **Load sample files**, shown while the drive is empty.
- **Main area.** A list/grid toggle, a quick filter box, and rows or cards showing the kind icon, topic, a **Needs a look** marker, and pinned or generated flags.
- **Selection bar.** Appears when you tick files: "N selected → Combine into Requirements / Summary / Compare", plus Clear.
- **Preview drawer.** Slides in from the right. It shows the kind, topic, confidence, summary and tags, with **Move to…**, **Set topic…**, **Download** and **Delete** (Delete needs a second click). The file body is rendered as a table for CSV, as Markdown, or as plain text.
- **Dark mode** follows your system setting. On a phone, the sidebar becomes a slide-out menu.

## Quick start

You need **Node.js 22.9 or newer** (the start script uses `--env-file-if-exists`).

```bash
npm install
npm start
```

Open http://localhost:3000 and click **Load sample files** in the sidebar.

This loads 32 sample files from `src/samples/`. They are the drive of **Brightleaf Labs**, a fictional 14-person product studio in Lahore, during Q3 2026. They cover every category, and they go through the same pipeline as a normal upload. Some highlights:

- **Four PDFs:** the OfficeWorks and PrintHub invoices, the Northwind patient-app proposal, and Priya Nair's resume.
- **Invoices and receipts:** CloudNest hosting, Figma, Skyway Travel, an outgoing Northwind consulting invoice, and a Cafe Lumen team-lunch receipt.
- **The Acme Retail account:** the website-redesign proposal, the MSA, and the kickoff call.
- **Q3 marketing:** three meetings (kickoff, mid-point review and wrap-up), a budget spreadsheet, and a September website-analytics report.
- **The office move:** the project plan, plus the board update that reports its final cost.
- **Decoys built to fool a keyword filer:**
  - an internal hackathon problem statement that talks about invoices
  - finance-sync meeting notes about overdue invoices
  - a blog article about switching invoicing tools
  - an MSA full of payment amounts
  - a proposal with a budget

Clicking **Load sample files** again skips files that are already loaded. After loading, the drive holds 40 files: the agents also create `expenses.csv` and an action-items file for each of the 7 meetings.

You can also click **Upload** or drag files onto the page. Accepted types are `.txt`, `.md`, `.csv` and `.pdf`, up to 10 MB each and 20 files per upload.

Other scripts and settings:

- `npm run dev` starts the server with `--watch`, so it restarts when you edit code.
- `npm run make-sample-pdf` regenerates the four sample PDFs. It needs the `pdfkit` dev dependency.
- `PORT` changes the port (default `3000`).
- `DATA_DIR` changes where the drive's data is stored (default `data/` in the project folder).

## Optional: turn on AI

The app works without any API key. To use a real model:

1. Copy the example settings file:

   ```bash
   cp .env.example .env
   ```

2. In `.env`, set **one** of these:

   ```
   GEMINI_API_KEY=your-key
   # or
   ANTHROPIC_API_KEY=your-key
   ```

3. Restart with `npm start`. The pill in the top bar changes from "Offline agents" to the provider and model, and the server prints `AI: gemini (...)` or `AI: claude (...)` on startup.

How the provider and model are picked (`src/llm.js`):

| Setting | What it does | Default |
|---|---|---|
| `GEMINI_API_KEY` | Turns on Gemini | (empty) |
| `ANTHROPIC_API_KEY` | Turns on Claude | (empty) |
| `AI_PROVIDER` | `gemini` or `claude`. Only needed when both keys are set; it is ignored if the matching key is missing | Gemini wins when both keys are set |
| `GEMINI_MODEL` | Gemini model name | `gemini-3.8-flash` |
| `ANTHROPIC_MODEL` | Claude model name | `claude-opus-5` |

The keys stay on the server. The browser only ever sees the provider and model name from `/api/status`.

**What changes with AI on:**

- **Organizer.** The model reads the first 4,000 characters of each file and picks a kind and topic from the fixed lists, plus tags and a summary.
  - A kind or topic outside those lists falls back to the offline answer.
  - The forced topics (invoice → Finance, people → HR, contract → Legal) and the ".csv is data" rule still win.
  - AI results are stored with high confidence.
- **Search.** The model writes the answer from the top 6 passages instead of quoting lines, and must cite them.
- **Synthesizer.** The model writes the whole document from the selected files. Each file is cut to its first 12,000 characters. The AI requirements doc also asks for Open Questions, plus owners and dates on action items.
- **Automations and the startup migration** stay rule-based either way, so expenses, action items and re-sorting are predictable.

**Offline fallback:** if the AI call fails (bad key, quota, network, refusal, empty or unreadable reply), the agent uses its offline result instead and writes a note starting "AI unavailable (...)" in the activity feed. A failed AI call never fails your upload, question or document.

## 2-minute demo walkthrough

Start with an empty drive, run `npm start`, and open http://localhost:3000. For a clean start, delete the `data/` folder or set `DATA_DIR` to a new folder.

1. **Organize (0:00–0:25).** Click **Load sample files**.
   - Categories fill up in the sidebar with counts: Meeting Notes, Invoices & Receipts, Specs & Plans, Proposals & Briefs and so on, with topic chips underneath.
   - Click **Proposals & Briefs**. The internal hackathon problem statement is there, not in Invoices, even though it talks about invoices. That is the exact mistake the first version made with the real brief PDF.
   - Click **Invoices & Receipts**. The PrintHub invoice is about a marketing campaign, but its topic is still Finance.
2. **Fix a guess (0:25–0:45).** Upload `test/fixtures/holdout-2/october_digest.txt`, a staff newsletter that fits no category well.
   - It goes to **Other** and shows up under **Needs a look**, and the activity feed says the Organizer was not sure.
   - Open it, choose **Move to… → Reports**, and watch the flag disappear and the pin appear.
3. **Automations (0:45–1:05).** Open **Spreadsheets & Data → `expenses.csv`**. It already has 7 rows, one per invoice or receipt. For example: CloudNest $1,250.00 (Software), PrintHub from the PDF $3,480.00 (Marketing), and Skyway Travel $842.60 (Travel).
   - Then open **Meeting Notes → `q3-marketing-kickoff - action items.md`** to see a checklist of owners and due dates.
   - Open **Agent activity** to show each step.
4. **Ask (1:05–1:35).** Press Ctrl+K / ⌘K and ask:
   - "What was the Q3 marketing budget?" The answer comes from all three marketing meetings: $120,000 approved at the kickoff, $64,500 spent by the mid-point review, and $118,200 spent by the wrap-up, each line with its own citation.
   - "How much did we spend on travel?" One line: the $842.60 total on the Skyway Travel invoice.
   - "When does the Acme site go live?" The go-live date agreed on the Acme kickoff call (a week before Black Friday).
   - "What are the Acme payment terms?" The fixed $48,000 fee in milestones and Net 30, from the Acme MSA. It does not pick CloudNest's terms, even though they also say "Payment terms".
   - "How much did the office move cost?" $9,870, under the $10,500 budget, from the board update and the office-move plan.

   Click a `[1]` to open the cited file in the drawer. If you want to show that it never invents an answer, ask about a name that isn't in the drive, such as "How much did we pay Globex?". It answers "I couldn't find that in your files."
5. **Synthesize (1:35–1:50).** Tick `q3-marketing-kickoff.md`, `q3-marketing-midpoint-review.md` and `q3-marketing-wrapup.md`. In the floating bar, choose **Combine into → Requirements**. The new document opens in the drawer, with decisions, action items, key figures and a Sources list covering the whole quarter. It is also listed under **Generated**.
6. **Toggle an automation (1:50–2:00).** Open **Automations** and switch off **Invoice → expenses.csv**. Upload another invoice: it is still filed under Invoices & Receipts, but no row is added. Switch it back on. Finally, point at the status pill: "Offline agents", or the Gemini/Claude model if a key is set.

## Project structure

```
agentic-drive/
├── server.js                 Express server: JSON API + serves the UI; migrates old drives on start
├── package.json
├── .env.example              Optional AI settings (copy to .env)
├── BRAINSTORMING.md          Problem, ideas, agent flows, what we learned, 3-minute video script
├── README.md
├── public/                   Single-page UI (no framework, no build step)
│   ├── index.html
│   ├── app.js
│   └── style.css
├── src/
│   ├── store.js              Files on disk + metadata in db.json, rules, activity feed
│   ├── pipeline.js           Upload pipeline (extract -> store -> Organizer -> Automations), migration, Move to…
│   ├── extract.js            Text from .txt/.md/.csv/.pdf
│   ├── llm.js                Optional Gemini/Claude client (returns null when no key)
│   ├── json-reply.js         Pulls a JSON object out of a model reply
│   ├── text.js               Shared text helpers (tokens, summaries, decisions, action items, amounts)
│   ├── agents/
│   │   ├── classifier.js     Offline kind + topic classifier (structure signals, invoice gate, confidence)
│   │   ├── organizer.js      Kind, topic, confidence, tags, summary (AI checked against the classifier's lists)
│   │   ├── search.js         BM25 + synonyms + coverage, answers with citations
│   │   ├── synthesizer.js    Requirements / summary / compare documents
│   │   └── automations.js    Invoice -> expenses.csv, meeting -> action items
│   └── samples/              The 32 Brightleaf Labs demo files loaded by "Load sample files"
├── scripts/
│   └── make-sample-pdf.js    Regenerates the 4 sample PDFs (npm run make-sample-pdf)
├── test/                     node:test unit, API and accuracy tests
│   └── fixtures/
│       ├── sample-labels.json   The expected kind + topic of every sample file
│       ├── holdout/             16 tricky texts + labels.json (tuned against)
│       └── holdout-2/           20 blind texts + labels.json (never tuned against)
├── docs/superpowers/         Design specs and implementation plans
└── data/                     Created at runtime (git-ignored): files/ and db.json
```

## API

All routes return JSON, except the download route. Errors come back as `{ "error": "..." }`.

A file record has `id`, `name`, `ext`, `size`, `createdAt`, `source`, `generated`, `kind`, `topic`, `confidence`, `pinned`, `tags` and `summary`. The old `type` and `folder` fields are gone.

| Method | Route | What it does |
|---|---|---|
| GET | `/api/status` | `{ aiProvider, model }`. `aiProvider` is `"gemini"`, `"claude"` or `null` |
| GET | `/api/meta` | `{ kinds, topics }`: the 9 kinds in fixed order as `{ id, label }`, and the 8 topic names |
| GET | `/api/files` | `{ files }`: every file record, without the extracted text |
| GET | `/api/files/:id` | One file record, including its extracted `text` |
| GET | `/api/files/:id/download` | The original file bytes |
| PATCH | `/api/files/:id` | "Move to…". Body `{ kind?, topic? }`, at least one of them. `kind` must be a kind id, and `topic` a topic name or `null`. Returns the updated record with `pinned: true` and confidence `high`. An invalid kind or topic, or an empty body, is a 400 and changes nothing. An unknown id is a 404. Does not re-run automations |
| DELETE | `/api/files/:id` | Deletes the file and its record |
| POST | `/api/upload` | Multipart upload, field `files` (up to 20). Returns `{ files, errors }`. If some files fail, it is still a 200 and the failures are listed in `errors`; if all fail, it is a 400 |
| POST | `/api/samples` | Loads the bundled sample files through the upload pipeline. Returns `{ loaded, skipped }` |
| POST | `/api/ask` | Body `{ question }` (1–500 characters). Returns `{ answer, citations, by }` where `by` is `"ai"` or `"offline"` |
| POST | `/api/synthesize` | Body `{ fileIds, format }`, at least 2 different files, `format` is `requirements`, `summary` or `compare`. Returns the new file record (kind `report`, topic = the most common topic of the sources) |
| GET | `/api/automations` | `{ rules }`: the automation rules and whether each is on |
| PUT | `/api/automations/:id` | Body `{ enabled: true \| false }`. Returns the updated rule |
| GET | `/api/activity` | `{ activity }`: the last 100 agent activity entries, newest first |

## Tests

```bash
npm test
```

This runs every `test/**/*.test.js` file with Node's built-in test runner. The tests cover:

- text extraction, the store and the LLM client
- each agent, including the classifier's signals, the invoice gate, confidence and topics
- the HTTP API, including `GET /api/meta`, `PATCH` moves that survive a restart, and migrating an old type/folder `db.json`
- search answers to the demo questions on the real 32-file drive, and checks that they stay put when about 30 unrelated files are added

**`test/accuracy.test.js`** runs the offline Organizer over the labelled sets in `test/fixtures/`. It requires:

- 100% kind and topic on the samples
- at least 85% kind accuracy on the holdout, with no brief filed as an invoice
- at least 75% kind accuracy on the blind holdout-2, with every miss landing in Other

AI paths are tested with fake model replies, including failures. The store and API tests use temporary folders, so the tests need no API key, make no network calls and never touch your `data/` folder.

## Hackathon deliverables

- [x] **Working prototype**: this repository (`npm install && npm start`).
- [x] **Brainstorming artifact**: [`BRAINSTORMING.md`](BRAINSTORMING.md): the problem, ideas we kept and dropped, an architecture sketch, the four agentic user flows, and what we learned in the second iteration.
- [ ] **3-minute video pitch**: to be recorded. The shot-by-shot script is in [`BRAINSTORMING.md`, section 7 "Demo script for the 3-minute video"](BRAINSTORMING.md#7-demo-script-for-the-3-minute-video).

## Limitations

- **Offline classification is about 80% right on unseen documents.** On the blind holdout-2 set it got 16 of 20 kinds right. The misses went to Other (Needs a look), not to a wrong category, but expect to use "Move to…" on roughly one file in five that doesn't look like the samples.
- **Topics are weaker than kinds.** The offline topic is a keyword count: 13 of 20 were right on holdout-2, and some files get no topic or a wrong one. Use **Set topic…** to fix it.
- **No learning from moves.** "Move to…" fixes and pins that one file, but the classifier does not learn from it. A similar file uploaded later can make the same mistake.
- **One file, one kind.** There are no nested folders and no multiple kinds per file. A contract with an invoice attached is either a contract or an invoice.
- **Not a real cloud.** Everything is stored locally in `data/`: the files in `data/files/` and all metadata in `data/db.json`.
- **No OCR.** Scanned PDFs (images with no text layer) are stored, but they can't be read, searched or summarised, and they go to Other.
- **File limits.** Only `.txt`, `.md`, `.csv` and `.pdf`, up to 10 MB per file.
- **Offline search is not true semantic search.** Without AI, search is keyword BM25 plus a small hand-written synonym list, not vector embeddings. Questions phrased in words that aren't in your files or the synonym list may not match. Only unknown *capitalised* names give "not found": a question with an unknown lowercase word can still return loosely related lines.
- **The expense log trusts the kind.** Every file filed as an invoice is logged in `expenses.csv`, including an invoice Brightleaf *sent* to a client. The sample Northwind consulting invoice shows up as a $10,800 Office expense with the vendor "Brightleaf Labs".
- **AI synthesis truncates long files.** With AI on, the Synthesizer sends only the first 12,000 characters of each file to the model.
- **No accounts.** There is no login, no permissions and no multi-user support. Anyone who can reach the server can see and delete every file.
