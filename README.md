# Agentic Drive

Agentic Drive is a small cloud-drive prototype where AI agents do the filing, searching and paperwork for you. When a file arrives, an Organizer agent reads it and files it, automations react to it (invoices go into a spreadsheet, meeting notes turn into a to-do list), and you can ask questions across all your files or combine several files into one new document. It runs fully offline with rule-based agents, and gets smarter if you add a Gemini or Claude API key.

Built for the hackathon brief **"Build the Next-Generation Agentic Workspace"** (Agentic Drive).

## The 4 features, mapped to the brief

The brief lists four agentic capabilities. Agentic Drive has one agent for each.

| Brief capability | Agent | Code |
|---|---|---|
| 1. Proactive Organization | Organizer | `src/agents/organizer.js` |
| 2. Semantic Retrieval | Search | `src/agents/search.js` |
| 3. Cross-Document Synthesis | Synthesizer | `src/agents/synthesizer.js` |
| 4. Automated Workflows | Automations | `src/agents/automations.js` |

### 1. Proactive Organization: the Organizer

Every upload goes through the same pipeline (`src/pipeline.js`): extract the text, save the file, run the Organizer, then run the automations.

The Organizer gives each file:

- a **type**: `invoice`, `meeting`, `data` or `report`
- a **folder**: a topic such as Finance, Marketing, Engineering, HR, Legal or Sales, or `General` when nothing fits well
- a few **tags** and a **one-line summary**

You never create a folder. The folder list on the left is built from whatever the Organizer decided.

Offline, it uses keyword rules. A file that mentions "invoice" plus a total is an invoice, and one that mentions attendees, agenda, minutes or action items is a meeting. The folder is the topic whose keywords appear most often, and words in the file name count double. Two rules always apply, with or without AI:

- **Invoices always go to Finance.** The PrintHub invoice is about a marketing campaign, but it still lands in Finance.
- **`.csv` files are always type `data`.** Only the CSV's header row and file name decide its folder, so a budget sheet whose rows mention "Marketing" is still filed by what its columns are about.

A PDF with no text layer (a scan) is still stored. It goes to `General` with the summary "(no readable text)".

### 2. Semantic Retrieval: the Search agent

You ask a question in plain English in the **Ask** tab and get a direct answer with numbered citations like `[1]`. Click a citation and the source file opens in the viewer.

How it works:

- Every file is cut into short passages. A CSV passage is its header line plus up to 8 rows, so spreadsheets are searchable too.
- The passages are ranked with BM25. Question words are widened with a small synonym list (for example "spend" also matches "budget", "cost" and "expense"), and a match in the file name counts extra.
- **Offline**, the answer is up to 3 bullet points, each holding the best sentence from a top passage. "How much..." questions prefer the line with an amount, and a total beats a line item.
- **With AI**, the model gets only the top 6 passages and is told to answer from them and cite them. Only the sources it actually cites are returned.
- If nothing matches, it says "I couldn't find that in your files." and does not guess.

### 3. Cross-Document Synthesis: the Synthesizer

Tick two or more files in the list, open the **Synthesize** tab, pick a format and click **Generate document**. A new Markdown file appears in the **Generated** folder.

There are three formats:

| Format | Offline output |
|---|---|
| Unified requirements doc | Overview, Requirements, Decisions, Action Items (as `- [ ]` checkboxes), Key Figures |
| Summary | Overview, Key Points, Decisions, Key Figures |
| Compare | A side-by-side table (one row per file), Common Themes, Key Figures |

Offline, each extracted line ends with the file it came from, for example `(q3-marketing-kickoff.md)`. Every document, offline or AI, ends with a numbered **Sources** list of the input files. With AI on, the model writes the document from the files' text, and a Sources list is added if the model left it out.

### 4. Automated Workflows: the Automations agent

Two rules run on every upload, with no click needed. You can switch each one on or off in the **Automations** tab.

- **Invoice → expenses.csv**: when a file is filed as an invoice, the agent reads the vendor, date, invoice number and total, picks a category (Software, Travel, Marketing, Office, Utilities or Other), and adds a row to `expenses.csv` in the Finance folder. The columns are `date,vendor,invoice_number,category,total,currency,source_file`. If the same invoice number is already there, the row is skipped, so uploading an invoice twice does not log it twice. If no total can be read, nothing is written and the activity feed says why.
- **Meeting → action items**: when a file is filed as meeting notes, the agent pulls out the action items and saves them as `<meeting name> - action items.md`, a checklist in the same folder as the meeting.

Files the agents create are never run through the automations again, so one automation can't set off another in a loop.

Everything the agents do is written to the **Agent activity** feed on the right. The UI refreshes it every 3 seconds.

## Quick start

You need **Node.js 22.9 or newer** (the start script uses `--env-file-if-exists`).

```bash
npm install
npm start
```

Open http://localhost:3000 and click **Load sample files**.

This loads 8 sample files from `src/samples/`: three Q3 marketing meeting notes, three invoices (two `.txt` and one `.pdf`), a budget spreadsheet and an engineering spec. They go through the same pipeline as a normal upload. Clicking the button again skips files that are already loaded.

You can also click **Upload** or drag files onto the page. Accepted types are `.txt`, `.md`, `.csv` and `.pdf`, up to 10 MB each and 20 files per upload.

Other scripts and settings:

- `npm run dev` starts the server with `--watch`, so it restarts when you edit code.
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

- **Organizer**: the model reads the first 4,000 characters of each file and suggests the type, folder, tags and summary. The "invoices go to Finance" and "CSV is data" rules still win, and any field the model gets wrong or leaves out falls back to the offline result.
- **Search**: the model writes the answer from the top 6 passages instead of quoting sentences, and must cite them.
- **Synthesizer**: the model writes the whole document from the selected files. Each file is cut to its first 12,000 characters. The AI requirements doc also asks for Open Questions and owners and dates on action items.
- **Automations** stay rule-based either way, so expenses and action items are predictable.

**Offline fallback:** if the AI call fails (bad key, quota, network, refusal, empty or unreadable reply), the agent uses its offline result instead and writes a note starting "AI unavailable (...)" in the activity feed. A failed AI call never fails your upload, question or document.

## 2-minute demo walkthrough

Start with an empty drive (delete the `data/` folder if you want a clean start), run `npm start`, open http://localhost:3000.

1. **Organize (0:00–0:20).** Click **Load sample files**. Watch the Finance, Marketing and Engineering folders appear on the left, with type badges, tags and summaries on each file. Point out that the PrintHub invoice landed in Finance even though it is about a marketing campaign.
2. **Automations (0:20–0:50).** Open the **Finance** folder and click `expenses.csv`. It already has three rows: CloudNest ($1,250.00, Software), PrintHub from the PDF ($3,480.00, Marketing) and Skyway Travel ($842.60, Travel). Then open **Marketing** and click `q3-marketing-kickoff - action items.md`: a checklist such as "Sara will finalise the campaign brief by July 8." Scroll the **Agent activity** feed to show each step.
3. **Ask (0:50–1:20).** In the **Ask** tab, click the example questions:
   - "What was the Q3 marketing budget?" pulls the $120,000 budget from all three meetings (approved at kickoff, $64,500 spent at the midpoint, $118,200 spent at wrap-up), each with a citation.
   - "Who owns the campaign brief?" answers "Sara will finalise the campaign brief by July 8."
   - "How much did we spend on travel?" finds the $842.60 total on the Skyway Travel invoice.

   Click a `[1]` to open the cited file.
4. **Synthesize (1:20–1:45).** Tick `q3-marketing-kickoff.md`, `q3-marketing-midpoint-review.md` and `q3-marketing-wrapup.md`. In the **Synthesize** tab choose **Unified requirements doc** and click **Generate document**. A new file opens from the **Generated** folder, with decisions, action items with owners, key figures and a Sources list covering the whole quarter.
5. **Toggle an automation (1:45–2:00).** In the **Automations** tab, switch off **Invoice → expenses.csv**. Upload another invoice: it is still filed into Finance, but no row is added to `expenses.csv`. Switch it back on. Finally, point at the status pill: "Offline agents", or the Gemini/Claude model if a key is set.

## Project structure

```
agentic-drive/
├── server.js                 Express server: JSON API + serves the UI
├── package.json
├── .env.example              Optional AI settings (copy to .env)
├── BRAINSTORMING.md          Problem, ideas, agent flows, 3-minute video script
├── README.md
├── public/                   Single-page UI (no build step)
│   ├── index.html
│   ├── app.js
│   └── style.css
├── src/
│   ├── store.js              Files on disk + metadata in db.json, rules, activity feed
│   ├── pipeline.js           Upload pipeline: extract -> store -> Organizer -> Automations
│   ├── extract.js            Text from .txt/.md/.csv/.pdf
│   ├── llm.js                Optional Gemini/Claude client (returns null when no key)
│   ├── json-reply.js         Pulls a JSON object out of a model reply
│   ├── text.js               Shared text helpers (tokens, summaries, decisions, action items, amounts)
│   ├── agents/
│   │   ├── organizer.js      Type, folder, tags, summary
│   │   ├── search.js         BM25 + synonyms, answers with citations
│   │   ├── synthesizer.js    Requirements / summary / compare documents
│   │   └── automations.js    Invoice -> expenses.csv, meeting -> action items
│   └── samples/              The 8 demo files loaded by "Load sample files"
├── scripts/
│   └── make-sample-pdf.js    Regenerates the sample PDF invoice (npm run make-sample-pdf)
├── test/                     node:test unit and API tests
├── docs/superpowers/         Design spec and implementation plan
└── data/                     Created at runtime (git-ignored): files/ and db.json
```

## API

All routes return JSON, except the download route. Errors come back as `{ "error": "..." }`.

| Method | Route | What it does |
|---|---|---|
| GET | `/api/status` | `{ aiProvider, model }`. `aiProvider` is `"gemini"`, `"claude"` or `null` |
| GET | `/api/files` | `{ files }`: every file record, without the extracted text |
| GET | `/api/files/:id` | One file record, including its extracted `text` |
| GET | `/api/files/:id/download` | The original file bytes |
| DELETE | `/api/files/:id` | Deletes the file and its record |
| POST | `/api/upload` | Multipart upload, field `files` (up to 20). Returns `{ files, errors }`. If some files fail, it is still a 200 and the failures are listed in `errors`; if all fail, it is a 400 |
| POST | `/api/samples` | Loads the bundled sample files through the upload pipeline. Returns `{ loaded, skipped }` |
| POST | `/api/ask` | Body `{ question }` (1–500 characters). Returns `{ answer, citations, by }` where `by` is `"ai"` or `"offline"` |
| POST | `/api/synthesize` | Body `{ fileIds, format }`, at least 2 different files, `format` is `requirements`, `summary` or `compare`. Returns the new file record |
| GET | `/api/automations` | `{ rules }`: the automation rules and whether each is on |
| PUT | `/api/automations/:id` | Body `{ enabled: true \| false }`. Returns the updated rule |
| GET | `/api/activity` | `{ activity }`: the last 100 agent activity entries, newest first |

## Tests

```bash
npm test
```

This runs every `test/**/*.test.js` file with Node's built-in test runner. The tests cover text extraction, the store, the LLM client, each agent and the HTTP API. AI paths are tested with fake model replies (including failures), and the store and API tests use temporary folders, so the tests need no API key, make no network calls and never touch your `data/` folder.

## Hackathon deliverables

- [x] **Working prototype**: this repository (`npm install && npm start`).
- [x] **Brainstorming artifact**: [`BRAINSTORMING.md`](BRAINSTORMING.md): the problem, ideas we kept and dropped, an architecture sketch and the four agentic user flows.
- [ ] **3-minute video pitch**: to be recorded. The shot-by-shot script is in [`BRAINSTORMING.md`, section 7 "Demo script for the 3-minute video"](BRAINSTORMING.md#7-demo-script-for-the-3-minute-video).

## Limitations

- **Not a real cloud.** Everything is stored locally in `data/`: the files in `data/files/` and all metadata in `data/db.json`.
- **No OCR.** Scanned PDFs (images with no text layer) are stored but can't be read, searched or summarised.
- **File limits.** Only `.txt`, `.md`, `.csv` and `.pdf`, up to 10 MB per file.
- **Offline search is not true semantic search.** Without AI, search is keyword BM25 plus a small hand-written synonym list, not vector embeddings. Questions phrased in words that aren't in your files or the synonym list may not match.
- **AI synthesis truncates long files.** With AI on, the Synthesizer sends only the first 12,000 characters of each file to the model.
- **No accounts.** There is no login, no permissions and no multi-user support. Anyone who can reach the server can see and delete every file.
