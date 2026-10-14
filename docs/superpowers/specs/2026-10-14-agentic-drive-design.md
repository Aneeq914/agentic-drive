# Agentic Drive — Design Spec

Date: 2026-10-14
Source: "Hackathon Problem Statement: Agentic Drive" (PDF, 3 pages)

## 1. Goal

A simple, working prototype of an "Advanced Google Drive" in which AI agents
organise, search, combine and act on uploaded files. It implements all four
capabilities from the problem statement, plus the required brainstorming
document.

**Success criteria**
- `npm install && npm start` serves the app at http://localhost:3000.
- With **no API key**, all four features work using offline (rule-based) agents.
- With `GEMINI_API_KEY` or `ANTHROPIC_API_KEY` in `.env`, the organizer, search
  and synthesizer use a real LLM. If the LLM call fails, they fall back to the
  offline result and the activity feed records the failure.
- "Load sample files" produces a demo in one click: files appear in folders,
  `expenses.csv` contains invoice rows, and an action-items file is created.
- `npm test` passes.

## 2. Constraints and decisions

| Decision | Choice | Why |
|---|---|---|
| Runtime | Node 22, Express | Machine has Node v22.23.1; user asked for "the npm run one" |
| Frontend | Plain HTML/CSS/JS in `public/`, served by Express | One command, no build step |
| Storage | Files on disk at `data/files/`, metadata in `data/db.json` | Survives restarts, no database install |
| Env | `node --env-file-if-exists=.env` | No dotenv dependency |
| Upload | `multer`, 10 MB per-file limit | Standard multipart handling |
| PDF text | `pdf-parse` (or `pdfjs-dist` if pdf-parse misbehaves) | Server-side extraction |
| File types | .txt .md .csv .pdf (anything else is rejected with a clear message) | User choice |
| AI | Optional; key stays server-side; model configurable via env | User choice: "works free, AI optional" |
| Tests | Node built-in `node:test` | No extra test dependency |

Out of scope (YAGNI): user accounts, sharing, real cloud, OCR for scanned
PDFs, a custom rule builder, vector database.

## 3. Architecture

```
Browser (public/app.js)
   │  fetch JSON
   ▼
server.js (Express routes)
   ├─ store.js        files on disk + db.json (single source of truth)
   ├─ extract.js      buffer + filename → plain text
   ├─ llm.js          complete(prompt) → text | null (null = no key / failed)
   └─ agents/
        organizer.js    text → {type, folder, tags, summary}
        search.js       question + docs → {answer, citations[]}
        synthesizer.js  docs + format → {title, content}
        automations.js  doc → side effects (new/updated files) + activity
```

Every agent exposes an async function that first tries the LLM (when
configured) and otherwise uses its offline logic. The offline logic is made of
pure functions that are unit-tested.

### Upload pipeline
1. `POST /api/upload` (multipart, field `files`, multiple files).
2. For each file: extract text → save it → **Organizer** sets type, folder, tags and summary → **Automations** run every enabled rule that matches → activity entries are written.
3. The response is the list of created file records.

## 4. Agents

### 4.1 Organizer (Proactive Organization)

**Offline**
- **Type detection:**
  - `invoice`: words like invoice, bill to, amount due, total due.
  - `meeting`: attendees, agenda, minutes, action items.
  - `data`: a .csv file.
  - `report`: anything else.
- **Topic/folder:** a keyword dictionary scores each topic, and the highest score wins. Topics are Finance, Marketing, Engineering, HR, Legal and Sales, with "General" as the fallback.
- **Invoices always go to Finance.**
- **Tags:** the top 5 non-stopword terms by frequency, plus type and topic.
- **Summary:** the first meaningful sentence, at most 160 characters.

**LLM:** asks for strict JSON `{type, folder, tags[], summary}`. Invalid JSON falls back to offline.

### 4.2 Search (Semantic Retrieval)
- Documents are split into passages (by paragraph, about 600 characters max).
- **Offline ranking:**
  - TF-IDF cosine similarity over lower-cased stemmed tokens.
  - The query is expanded with a small synonym map (budget↔spend/cost/allocation, meeting↔minutes/discussion, Q3↔third quarter, and so on).
  - Matches on filename, tag or folder add a small boost.
- **Offline answer:** the 1–3 best sentences from the top passages, each followed by `[n]`.
- **LLM answer:** gets the top 6 passages and must cite them as `[n]`.
- **Response:** `{answer, citations: [{n, fileId, fileName, snippet}]}`.
- **No match** (score below threshold) gives "I couldn't find that in your files."

### 4.3 Synthesizer (Cross-Document Synthesis)
- **Input:** 2 or more file ids and a format, one of `requirements`, `summary` or `compare`.
- **Offline:**
  - Pulls out decision sentences (decided, agreed, will, approved).
  - Pulls out requirement sentences (must, should, need to, required).
  - Pulls out action items (lines starting with "- [ ]", "Action:", "TODO", or "Name: will …").
  - Pulls out numbers with currency.
  - Assembles a Markdown document with a "Sources" section.
- **LLM:** writes the document from the full texts (each truncated to a safe length).
- **Output:** saved as a new `.md` file in the **Generated** folder and returned.

### 4.4 Automations (Automated Workflows)
Rules are stored in db.json. Each one has `{id, name, description, enabled}`, and the user can toggle it on or off.
- **`invoice-to-csv`**
  - **When:** type = invoice.
  - **What it reads (regex):**
    - vendor: the "From"/"Vendor" line, or the first line
    - invoice number and date
    - total: the "Total"/"Amount Due" line, taking the last currency amount on it
  - **Category:** keyword map (software, travel, office, marketing, utilities, other).
  - **Result:** appends a row to `expenses.csv` (created with a header if it's missing) in the Finance folder.
  - **No duplicates:** an invoice number that is already in `expenses.csv` is not added again.
- **`meeting-action-items`**
  - **When:** type = meeting.
  - **Result:** creates `<name> - action items.md` in the same folder as the meeting, containing the extracted action items.
  - If there are none, it creates nothing and logs that.
- Each run writes activity entries such as "Automations: logged Invoice INV-104 ($1,250.00) to expenses.csv".

## 5. API

| Method | Path | Body / result |
|---|---|---|
| GET | `/api/status` | `{aiProvider: "gemini" \| "claude" \| null, model}` |
| GET | `/api/files` | list of file records (no full text) |
| GET | `/api/files/:id` | record + text |
| GET | `/api/files/:id/download` | the original bytes |
| DELETE | `/api/files/:id` | removes the file and its record |
| POST | `/api/upload` | multipart `files` → created records |
| POST | `/api/samples` | loads the bundled demo files through the upload pipeline (skips any already loaded) |
| POST | `/api/ask` | `{question}` → `{answer, citations}` |
| POST | `/api/synthesize` | `{fileIds, format}` → new file record |
| GET | `/api/automations` | list of rules |
| PUT | `/api/automations/:id` | `{enabled}` → updated rule |
| GET | `/api/activity` | last 100 activity entries, newest first |

**File record:** `{id, name, ext, size, type, folder, tags[], summary, createdAt, generated: bool, source: "upload" | "sample" | "agent"}`.

**Errors:** JSON `{error}` with status 400 (bad input, unsupported type), 404 (unknown id) or 500.

## 6. UI (public/)

**Top bar:** title, an AI status pill ("Offline agents" or "Gemini · model"), an Upload button, drag-and-drop over the whole page, and "Load sample files".

**Left:** the folder list with counts, plus "All files". Folders are not created by hand; they come from the Organizer.

**Middle:**
- A file list with name, type badge, tags, a checkbox for synthesis, and delete.
- Clicking a file opens a viewer showing the summary, tags and full text (CSV is shown as a table).

**Right — Agent panel, three tabs:**
- **Ask:** a question box and an answer with clickable `[n]` citations that open the cited file.
- **Synthesize:** the number of ticked files, a format selector and a Generate button. The result opens in the viewer.
- **Automations:** rules with on/off toggles.

**Below the tabs:** the activity feed, polled every 3 seconds.

**States:** empty drive ("Upload files or load samples"), loading spinners on agent actions, and visible error messages.

## 7. Bundled samples (src/samples/)
About 8 files that exercise every feature:
- 3 Q3 marketing meeting notes, which mention budget figures and action items
- 2 invoices (.txt) and 1 invoice (.pdf) to show PDF extraction
- `q3-budget.csv`
- an engineering spec

## 8. Testing
- **`npm test`** (node:test) checks:
  - organizer type/folder detection
  - search returns the right file at citation 1 for "What was the Q3 marketing budget?"
  - invoice parsing (vendor, number, total) and CSV append without duplicates
  - action-item extraction
  - synthesizer output contains the Sources section and the extracted decisions
  - PDF text extraction of the sample invoice
- **Manual/E2E:**
  - start the server, call each API with curl
  - load the UI in headless Chrome and screenshot it

## 9. Deliverables
- The app
- `README.md` (setup, run, features, limitations)
- `BRAINSTORMING.md`: the problem, the passive → active shift, ideas considered, the 4 agent user flows, and future ideas
- `.env.example`
