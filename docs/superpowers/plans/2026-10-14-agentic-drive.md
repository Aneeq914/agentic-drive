# Agentic Drive Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Node/Express "Agentic Drive" in which four agents (Organizer, Search, Synthesizer, Automations) organise, search, combine and act on uploaded .txt/.md/.csv/.pdf files. It works offline, and a Gemini/Claude key is optional.

**Architecture:**
- **Express server:** `server.js` exposes a JSON API and serves a plain HTML/CSS/JS UI from `public/`.
- **Storage:** files live on disk in `data/files/`, and their metadata, extracted text, rules and activity live in `data/db.json`.
- **Agents:** each agent is a module with pure offline functions (unit-tested) plus an async wrapper. The wrapper tries the injected LLM first and falls back to offline on any failure.

**Tech Stack:**
- Node 22 (ESM), Express 5.3, multer 2.4, pdf-parse 2.4.5
- @anthropic-ai/sdk 0.133, @google/genai 2.29
- pdfkit 0.20 (dev only, to generate the sample PDF)
- node:test

**Spec:** `docs/superpowers/specs/2026-10-14-agentic-drive-design.md`

## Global Constraints

- **Project root:** `/home/aneeq914/Desktop/uni/agentic-drive/`. Every path below is relative to it.
- **Module format:** ESM everywhere (`"type": "module"`). Use `import`/`export` and no `require`. Get the current directory from `import.meta.url` (`__dirname` is undefined in ESM).
- **Node:** the machine has v22.23.1. Run with `node --env-file-if-exists=.env`. There is no dotenv package.
- **Commands:** `npm start` serves http://localhost:3000 (overridable with `PORT`). `npm test` runs `node --test "test/**/*.test.js"`.
- **Supported uploads:** `.txt .md .csv .pdf` only, 10 MB per file, 20 files per request.
- **AI env vars:**
  - `GEMINI_API_KEY`, `ANTHROPIC_API_KEY`, `AI_PROVIDER` (`gemini` | `claude`), `GEMINI_MODEL`, `ANTHROPIC_MODEL`
  - Default models: `gemini-3.8-flash` and `claude-opus-5`
  - With no key, everything runs offline.
- **API keys never reach the browser.**
- **Errors:** every API error is JSON `{error: string}` with status 400, 404 or 500.
- **Escaping:** the UI must HTML-escape every file name and file text before inserting it into the DOM.
- **Module headers:** every non-trivial module starts with the 4-section header doc-block, in this order: IN SIMPLE WORDS / BUSINESS RULES / WHY IT'S BUILT THIS WAY (change at your peril) / DO NOT. Only claim what tests verify. Small utility files do not need it.
- **Commits:** subagents running in parallel must **not** run git. The coordinator commits after each wave, ending each commit message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Same invoice uploaded twice:** expected — `expenses.csv` keeps exactly one row for that invoice number. Tests: Task 6 `appendExpenseRow` dedupe, and Task 8 server double upload.
2. **Unsupported file (.docx, .png) or a corrupt PDF:** expected — a 400 with a readable message and nothing stored. Tests: Task 2 extract, and Task 8 server.
3. **A file with no readable text** (an empty .txt, or a scanned PDF): expected — it is stored in General as `report` with summary "(no readable text)" and nothing crashes. Tests: Task 4 organizer, and Task 8 server.
4. **The AI key is set but the AI throws or returns junk JSON:** expected — the offline result is used and the activity feed says so. Tests: fake-LLM cases in Tasks 4, 5 and 7.
5. **A file name or content containing HTML such as `<img src=x onerror=alert(1)>`:** expected — it is shown as text and never executed. Tests: Task 8 server round-trips the name unchanged, Task 10 checks the UI escapes it, and Task 11 confirms with a headless DOM dump.

## Execution waves (for the coordinator)

| Wave | Tasks (run in parallel inside a wave) | Depends on |
|---|---|---|
| A | Task 1 (scaffold + text utils) | — |
| B | Tasks 2, 3, 4, 5, 6, 7, 9 | A |
| C | Task 8 (pipeline + server + API tests) and Task 10 (UI), in parallel against the API contract in Task 8 | B |
| D | Task 11 (verification) — coordinator | C |

---

### Task 1: Scaffold, package.json, shared text utilities

**Files:**
- Create: `package.json`, `.gitignore`, `.env.example`, `src/text.js`
- Test: `test/text.test.js`

**Interfaces:**
- Produces (`src/text.js`):
  - `STOPWORDS: Set<string>`
  - `stem(word: string): string`
  - `tokenize(text: string): string[]` — lowercase, `[a-z0-9]+`, stopwords removed, stemmed
  - `splitSentences(text: string): string[]`
  - `topTerms(text: string, n: number): string[]` — the most frequent raw words (≥4 letters, alphabetic, not stopwords), ties broken alphabetically
  - `summarize(text: string, max = 160): string`
  - `extractDecisions(text): string[]`, `extractRequirements(text): string[]`, `extractActionItems(text): string[]`, `extractAmounts(text): string[]`

- [ ] **Step 1: Create the project files**

`package.json`:
```json
{
  "name": "agentic-drive",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "description": "A cloud drive run by AI agents: auto-organising, semantic search, cross-document synthesis and automated workflows.",
  "engines": { "node": ">=22.9" },
  "scripts": {
    "start": "node --env-file-if-exists=.env server.js",
    "dev": "node --watch --env-file-if-exists=.env server.js",
    "test": "node --test \"test/**/*.test.js\"",
    "make-sample-pdf": "node scripts/make-sample-pdf.js"
  },
  "dependencies": {
    "@anthropic-ai/sdk": "^0.133.0",
    "@google/genai": "^2.29.1",
    "express": "^5.3.0",
    "multer": "^2.4.0",
    "pdf-parse": "^2.4.5"
  },
  "devDependencies": {
    "pdfkit": "^0.20.2"
  }
}
```

`.gitignore`:
```
node_modules/
data/
.env
```

`.env.example`:
```
# Optional. Leave both keys empty to run with offline (rule-based) agents.
# If both are set, Gemini is used unless AI_PROVIDER=claude.
GEMINI_API_KEY=
ANTHROPIC_API_KEY=
# AI_PROVIDER=gemini
# GEMINI_MODEL=gemini-3.8-flash
# ANTHROPIC_MODEL=claude-opus-5
# PORT=3000
```

Run: `cd /home/aneeq914/Desktop/uni/agentic-drive && git init && npm install`
Expected: the install succeeds and `node_modules/` exists.

- [ ] **Step 2: Write the failing test** `test/text.test.js`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  stem, tokenize, splitSentences, topTerms, summarize,
  extractDecisions, extractRequirements, extractActionItems, extractAmounts,
} from '../src/text.js';

test('stem handles common suffixes', () => {
  assert.equal(stem('meetings'), 'meeting');
  assert.equal(stem('budgets'), 'budget');
  assert.equal(stem('companies'), 'company');
  assert.equal(stem('marketing'), 'market');
  assert.equal(stem('approved'), 'approv');
  assert.equal(stem('class'), 'class');
});

test('tokenize lowercases, drops stopwords, stems', () => {
  assert.deepEqual(tokenize('What was the Q3 Marketing budget?'), ['q3', 'market', 'budget']);
});

test('splitSentences splits on punctuation and newlines', () => {
  assert.deepEqual(splitSentences('One here. Two there!\nThree'), ['One here.', 'Two there!', 'Three']);
});

test('topTerms returns frequent raw words', () => {
  assert.deepEqual(topTerms('campaign campaign budget budget budget social', 2), ['budget', 'campaign']);
});

test('summarize skips headings and short lines, truncates', () => {
  const text = '# Title\n\nDate: 2026\nThe team reviewed the goals for the quarter and agreed a plan.';
  assert.equal(summarize(text), 'The team reviewed the goals for the quarter and agreed a plan.');
  assert.equal(summarize(''), '(no readable text)');
  assert.ok(summarize('word '.repeat(100)).length <= 160);
});

test('extractors find decisions, requirements, action items, amounts', () => {
  const t = [
    '# Notes',
    'The budget was approved at $120,000.',
    'The app must work offline.',
    '## Action Items',
    '- [ ] Sara will finalise the brief by July 8.',
    '- Action: Omar to send the report.',
    '',
    '- Bilal will draft the newsletter.',
    '## Other',
    '- Not an action',
  ].join('\n');
  assert.deepEqual(extractDecisions(t), ['The budget was approved at $120,000.', 'Sara will finalise the brief by July 8.', 'Bilal will draft the newsletter.']);
  assert.deepEqual(extractRequirements(t), ['The app must work offline.']);
  assert.deepEqual(extractActionItems(t), [
    'Sara will finalise the brief by July 8.',
    'Omar to send the report.',
    'Bilal will draft the newsletter.',
  ]);
  assert.deepEqual(extractAmounts('Paid $1,250.00 and 300 USD and €40'), ['$1,250.00', '300 USD', '€40']);
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npm test`
Expected: FAIL with `Cannot find module '../src/text.js'`.

- [ ] **Step 4: Implement `src/text.js`**

```js
// Shared text helpers used by every agent. Small and pure, so no 4-section header.

export const STOPWORDS = new Set(`a an and are as at be been but by for from has have he her his i if in into is it its
me my no not of on or our she so than that the their them then there these they this to was we were what when where which
who with you your about also can could did do does just more most would all any each how only other some such up out over
very per via am being here our ours us`.split(/\s+/).filter(Boolean));

export function stem(w) {
  if (w.length <= 3) return w;
  if (w.endsWith('ies') && w.length > 4) return w.slice(0, -3) + 'y';
  if (w.endsWith('ing') && w.length > 5) return w.slice(0, -3);
  if (w.endsWith('ed') && w.length > 4) return w.slice(0, -2);
  if (/(sh|ch|x|ss)es$/.test(w)) return w.slice(0, -2);
  if (w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

export function tokenize(text) {
  return (String(text).toLowerCase().match(/[a-z0-9]+/g) || [])
    .filter((w) => !STOPWORDS.has(w))
    .map(stem);
}

export function splitSentences(text) {
  return String(text)
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function topTerms(text, n) {
  const counts = new Map();
  for (const w of String(text).toLowerCase().match(/[a-z]+/g) || []) {
    if (w.length < 4 || STOPWORDS.has(w)) continue;
    counts.set(w, (counts.get(w) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, n)
    .map(([w]) => w);
}

// Strips markdown list/heading/table markers so sentences read cleanly.
function plainLines(text) {
  return String(text)
    .split(/\r?\n/)
    .filter((l) => !/^\s*#/.test(l))
    .map((l) => l.replace(/^\s*(?:(?:[-*>|]|\d+[.)]|\[[ x]\])\s*)+/i, '').replace(/[|*_`]/g, ' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

export function summarize(text, max = 160) {
  if (!String(text).trim()) return '(no readable text)';
  const sentences = splitSentences(plainLines(text).join('\n'));
  const pick = sentences.find((s) => s.split(/\s+/).length >= 6) || sentences[0] || String(text).trim();
  return pick.length > max ? pick.slice(0, max - 1).trimEnd() + '…' : pick;
}

const DECISION_RE = /\b(decided|agreed|approved|will|decision)\b/i;
const REQUIREMENT_RE = /\b(must|should|need to|needs to|required|requirement)\b/i;

export function extractDecisions(text) {
  return [...new Set(splitSentences(plainLines(text).join('\n')).filter((s) => DECISION_RE.test(s)))];
}

export function extractRequirements(text) {
  return [...new Set(splitSentences(plainLines(text).join('\n')).filter((s) => REQUIREMENT_RE.test(s)))];
}

export function extractActionItems(text) {
  const out = [];
  let inSection = false;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (/^#*\s*action items?:?\s*$/i.test(line)) { inSection = true; continue; }
    if (line.startsWith('#')) { inSection = false; continue; }
    if (!line) continue;
    let m = line.match(/^[-*]\s*\[[ x]\]\s*(.+)/i) || line.match(/^(?:[-*]\s*)?(?:action|todo)\s*:\s*(.+)/i);
    if (!m && inSection) m = line.match(/^(?:[-*]|\d+[.)])\s*(.+)/);
    if (m) out.push(m[1].trim());
  }
  return [...new Set(out)];
}

const AMOUNT_RE = /[$€£]\s?\d[\d,]*(?:\.\d{1,2})?|\b\d[\d,]*(?:\.\d{1,2})?\s?(?:USD|EUR|GBP|PKR)\b/g;

export function extractAmounts(text) {
  return [...new Set(String(text).match(AMOUNT_RE) || [])];
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test`
Expected: all `text.test.js` tests PASS. If the `extractDecisions` expectation differs only because of how `plainLines` strips the `- [ ]` prefix, fix the **code** so the test's expected sentences are produced. Do not change the test.

- [ ] **Step 6: Commit (coordinator)**

`git add -A && git commit -m "chore: scaffold agentic-drive and shared text utilities"`

---

### Task 2: Text extraction (`src/extract.js`)

**Files:**
- Create: `src/extract.js`
- Test: `test/extract.test.js`

**Interfaces:**
- Produces:
  - `SUPPORTED_EXTS = ['.txt', '.md', '.csv', '.pdf']`
  - `class UnsupportedFileError extends Error`
  - `class ExtractError extends Error`
  - `async extractText(buffer: Buffer, filename: string): Promise<string>`

- [ ] **Step 1: Write the failing test** `test/extract.test.js`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import PDFDocument from 'pdfkit';
import { extractText, UnsupportedFileError, ExtractError } from '../src/extract.js';

function makePdf(lines) {
  return new Promise((resolve) => {
    const doc = new PDFDocument();
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    for (const l of lines) doc.text(l);
    doc.end();
  });
}

test('reads plain text, strips BOM and CRLF', async () => {
  assert.equal(await extractText(Buffer.from('﻿a\r\nb'), 'x.md'), 'a\nb');
});

test('reads csv as text', async () => {
  assert.equal(await extractText(Buffer.from('a,b\n1,2'), 'x.CSV'), 'a,b\n1,2');
});

test('reads pdf text without page markers', async () => {
  const text = await extractText(await makePdf(['INVOICE INV-3310', 'Total Due: $3,480.00']), 'inv.pdf');
  assert.match(text, /INV-3310/);
  assert.match(text, /Total Due: \$3,480\.00/);
  assert.doesNotMatch(text, /-- 1 of 1 --/);
});

test('pdf with no text returns empty string', async () => {
  assert.equal(await extractText(await makePdf([]), 'blank.pdf'), '');
});

test('rejects unsupported extensions', async () => {
  await assert.rejects(() => extractText(Buffer.from('x'), 'photo.png'), UnsupportedFileError);
});

test('corrupt pdf throws ExtractError', async () => {
  await assert.rejects(() => extractText(Buffer.from('not a pdf'), 'bad.pdf'), ExtractError);
});
```

- [ ] **Step 2: Run** `node --test test/extract.test.js`. Expected: FAIL (module not found).

- [ ] **Step 3: Implement `src/extract.js`**

```js
import path from 'node:path';
import { PDFParse } from 'pdf-parse';

export const SUPPORTED_EXTS = ['.txt', '.md', '.csv', '.pdf'];

export class UnsupportedFileError extends Error {}
export class ExtractError extends Error {}

export async function extractText(buffer, filename) {
  const ext = path.extname(filename).toLowerCase();
  if (!SUPPORTED_EXTS.includes(ext)) {
    throw new UnsupportedFileError(`"${filename}" is not supported. Upload .txt, .md, .csv or .pdf files.`);
  }
  if (ext !== '.pdf') {
    return buffer.toString('utf8').replace(/^﻿/, '').replace(/\r\n/g, '\n');
  }
  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getText();
    // pdf-parse v2 appends "-- 1 of 1 --" page markers; they are noise for every agent.
    return result.text.replace(/^-- \d+ of \d+ --$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
  } catch (err) {
    throw new ExtractError(`Couldn't read text from "${filename}": ${err.message}`);
  } finally {
    await parser.destroy().catch(() => {});
  }
}
```

Add the 4-section header doc-block at the top. Its main points:
- **IN SIMPLE WORDS:** turns an uploaded file into plain text for the agents.
- **BUSINESS RULES:** only .txt/.md/.csv/.pdf (spec §2).
- **WHY IT'S BUILT THIS WAY:** page markers are stripped because they pollute summaries and search.
- **DO NOT:** treat image-only PDFs as errors (they return `''`).

- [ ] **Step 4: Run** `node --test test/extract.test.js`. Expected: PASS. If the blank PDF or corrupt PDF behaves differently in pdf-parse 2.4.5, change the code (for example, also wrap the `new PDFParse` call in the try) until the tests pass as written.

---

### Task 3: Store (`src/store.js`)

**Files:**
- Create: `src/store.js`
- Test: `test/store.test.js`

**Interfaces:**
- Produces `createStore(dataDir: string, { defaultRules = [] } = {})`, which returns:
  - `list(): Record[]` — records **without** `text`, in insertion order
  - `get(id): (Record & {text}) | null`
  - `findByName(name): (Record & {text}) | null` — the first record with that exact name
  - `allWithText(): (Record & {text})[]`
  - `add({ name, buffer, text, source = 'upload', generated = false }): Record`
    - defaults: `type: 'report'`, `folder: 'General'`, `tags: []`, `summary: ''`
  - `update(id, patch): Record | null` — `id`, `ext` and `text` cannot be patched
  - `replaceContent(id, buffer, text): Record | null`
  - `remove(id): boolean`
  - `filePath(id): string | null`
  - `getRules(): Rule[]`
  - `setRuleEnabled(id, enabled: boolean): Rule | null`
  - `addActivity(agent: string, message: string): Activity`
  - `getActivity(limit = 100): Activity[]` — newest first; at most 200 are kept
- `Record = {id, name, ext, size, type, folder, tags, summary, createdAt, generated, source}`
- `Rule = {id, name, description, enabled}`
- `Activity = {id, at, agent, message}`

- [ ] **Step 1: Write the failing test** `test/store.test.js`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../src/store.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'drive-'));
const RULES = [{ id: 'r1', name: 'Rule', description: 'd', enabled: true }];

test('add, get, list (no text), update, persist across instances', () => {
  const dir = tmp();
  const s = createStore(dir, { defaultRules: RULES });
  const rec = s.add({ name: 'a.md', buffer: Buffer.from('hello'), text: 'hello' });
  assert.equal(rec.ext, '.md');
  assert.equal(rec.size, 5);
  assert.equal(rec.folder, 'General');
  assert.equal('text' in s.list()[0], false);
  assert.equal(s.get(rec.id).text, 'hello');
  s.update(rec.id, { folder: 'Finance', text: 'HACK', id: 'x' });
  const again = createStore(dir, { defaultRules: RULES });
  assert.equal(again.get(rec.id).folder, 'Finance');
  assert.equal(again.get(rec.id).text, 'hello');
  assert.equal(fs.readFileSync(again.filePath(rec.id), 'utf8'), 'hello');
});

test('replaceContent, findByName, remove', () => {
  const s = createStore(tmp());
  const rec = s.add({ name: 'expenses.csv', buffer: Buffer.from('a'), text: 'a' });
  s.replaceContent(rec.id, Buffer.from('a\nb'), 'a\nb');
  assert.equal(s.findByName('expenses.csv').text, 'a\nb');
  assert.equal(s.get(rec.id).size, 3);
  const p = s.filePath(rec.id);
  assert.equal(s.remove(rec.id), true);
  assert.equal(fs.existsSync(p), false);
  assert.equal(s.get(rec.id), null);
  assert.equal(s.remove('nope'), false);
});

test('rules seeded once, toggle persists, unknown rule returns null', () => {
  const dir = tmp();
  const s = createStore(dir, { defaultRules: RULES });
  assert.equal(s.setRuleEnabled('r1', false).enabled, false);
  const again = createStore(dir, { defaultRules: RULES });
  assert.equal(again.getRules().length, 1);
  assert.equal(again.getRules()[0].enabled, false);
  assert.equal(again.setRuleEnabled('missing', true), null);
});

test('activity newest first and capped at 200', () => {
  const s = createStore(tmp());
  for (let i = 0; i < 205; i++) s.addActivity('Organizer', `m${i}`);
  assert.equal(s.getActivity(1000).length, 200);
  assert.equal(s.getActivity(1)[0].message, 'm204');
});
```

- [ ] **Step 2: Run** `node --test test/store.test.js`. Expected: FAIL.

- [ ] **Step 3: Implement `src/store.js`**

```js
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const MAX_ACTIVITY = 200;
const LOCKED_FIELDS = ['id', 'ext', 'text'];

export function createStore(dataDir, { defaultRules = [] } = {}) {
  const filesDir = path.join(dataDir, 'files');
  const dbPath = path.join(dataDir, 'db.json');
  fs.mkdirSync(filesDir, { recursive: true });

  const db = fs.existsSync(dbPath)
    ? JSON.parse(fs.readFileSync(dbPath, 'utf8'))
    : { files: [], rules: [], activity: [] };
  for (const rule of defaultRules) {
    if (!db.rules.some((r) => r.id === rule.id)) db.rules.push({ ...rule });
  }
  save();

  function save() {
    const tmp = `${dbPath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
    fs.renameSync(tmp, dbPath);
  }
  const strip = ({ text, ...rest }) => ({ ...rest, tags: [...rest.tags] });
  const find = (id) => db.files.find((f) => f.id === id);
  const diskPath = (rec) => path.join(filesDir, rec.id + rec.ext);

  return {
    list: () => db.files.map(strip),
    get: (id) => { const f = find(id); return f ? { ...f, tags: [...f.tags] } : null; },
    findByName: (name) => { const f = db.files.find((x) => x.name === name); return f ? { ...f, tags: [...f.tags] } : null; },
    allWithText: () => db.files.map((f) => ({ ...f, tags: [...f.tags] })),
    add({ name, buffer, text, source = 'upload', generated = false }) {
      const rec = {
        id: crypto.randomUUID(), name, ext: path.extname(name).toLowerCase(), size: buffer.length,
        type: 'report', folder: 'General', tags: [], summary: '',
        createdAt: new Date().toISOString(), generated, source, text,
      };
      fs.writeFileSync(diskPath(rec), buffer);
      db.files.push(rec);
      save();
      return strip(rec);
    },
    update(id, patch) {
      const rec = find(id);
      if (!rec) return null;
      for (const [k, v] of Object.entries(patch)) if (!LOCKED_FIELDS.includes(k)) rec[k] = v;
      save();
      return strip(rec);
    },
    replaceContent(id, buffer, text) {
      const rec = find(id);
      if (!rec) return null;
      fs.writeFileSync(diskPath(rec), buffer);
      rec.size = buffer.length;
      rec.text = text;
      save();
      return strip(rec);
    },
    remove(id) {
      const i = db.files.findIndex((f) => f.id === id);
      if (i < 0) return false;
      fs.rmSync(diskPath(db.files[i]), { force: true });
      db.files.splice(i, 1);
      save();
      return true;
    },
    filePath: (id) => { const f = find(id); return f ? diskPath(f) : null; },
    getRules: () => db.rules.map((r) => ({ ...r })),
    setRuleEnabled(id, enabled) {
      const rule = db.rules.find((r) => r.id === id);
      if (!rule) return null;
      rule.enabled = Boolean(enabled);
      save();
      return { ...rule };
    },
    addActivity(agent, message) {
      const entry = { id: crypto.randomUUID(), at: new Date().toISOString(), agent, message };
      db.activity.unshift(entry);
      db.activity.length = Math.min(db.activity.length, MAX_ACTIVITY);
      save();
      return entry;
    },
    getActivity: (limit = 100) => db.activity.slice(0, limit),
  };
}
```

Add the 4-section header:
- **WHY IT'S BUILT THIS WAY:** files on disk are named by id rather than user name, which prevents path traversal and name clashes. Writes are synchronous with an atomic rename, which prevents a half-written db.json on a crash and avoids lost updates from concurrent async writes.
- **DO NOT:** use the user's file name as a disk path, or return `text` from `list()` (the payload would get huge).

- [ ] **Step 4: Run** `node --test test/store.test.js`. Expected: PASS.

---

### Task 4: Organizer agent (`src/agents/organizer.js`)

**Files:**
- Create: `src/agents/organizer.js`
- Test: `test/organizer.test.js`

**Interfaces:**
- Consumes: `tokenize`, `topTerms`, `summarize` from `src/text.js`; and an `llm` object `{ enabled(): boolean, complete(prompt, {system, effort}): Promise<string|null> }` (made in Task 7; tests use fakes).
- Produces:
  - `TYPES = ['invoice', 'meeting', 'data', 'report']`
  - `TOPICS` (folder → keywords)
  - `detectType(name, ext, text): string`
  - `detectFolder(name, ext, text): string`
  - `organizeOffline({name, ext, text}): {type, folder, tags, summary}`
  - `async organize({name, ext, text}, {llm, log}): {type, folder, tags, summary, by: 'ai' | 'offline'}` — `log(agent, message)` is optional

**Rules:**
- Invoices always go to `Finance`, and `.csv` files are always type `data`. Both apply in AI and offline mode.
- Folder scoring:
  - The folder is the topic with the highest score among stemmed keyword hits.
  - File-name tokens count ×2.
  - **For a CSV, only the header row and the file name are scored**, because the values are data and the columns describe what the file is.
  - The minimum score is 2. Below that, or with no text, the folder is `General`.
  - Ties go to the earlier topic in `TOPICS` order.

- [ ] **Step 1: Write the failing test** `test/organizer.test.js`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectType, detectFolder, organizeOffline, organize } from '../src/agents/organizer.js';

const invoice = 'INVOICE\nFrom: CloudNest\nInvoice Number: INV-1042\nCloud hosting subscription $1,000.00\nTotal Due: $1,250.00';
const meeting = '# Q3 Marketing Kickoff\nAttendees: Sara\n## Agenda\nCampaign plan and social ads launch for the marketing team.';

test('detectType', () => {
  assert.equal(detectType('x.txt', '.txt', invoice), 'invoice');
  assert.equal(detectType('x.md', '.md', meeting), 'meeting');
  assert.equal(detectType('x.csv', '.csv', 'invoice,total\n1,2'), 'data');
  assert.equal(detectType('x.md', '.md', 'The app must sync files.'), 'report');
});

test('detectFolder scores topics, csv uses header + name only', () => {
  assert.equal(detectFolder('notes.md', '.md', meeting), 'Marketing');
  assert.equal(detectFolder('spec.md', '.md', 'The mobile app backend API and database deploy in the next sprint release.'), 'Engineering');
  assert.equal(detectFolder('q3-budget.csv', '.csv', 'line_item,department,q3_budget,cost_center\nPaid social ads,Marketing,1,2\nInfluencer campaign,Marketing,3,4'), 'Finance');
  assert.equal(detectFolder('random.txt', '.txt', 'hello there friend'), 'General');
});

test('organizeOffline forces invoices into Finance and builds tags + summary', () => {
  const r = organizeOffline({ name: 'inv.txt', ext: '.txt', text: invoice });
  assert.equal(r.type, 'invoice');
  assert.equal(r.folder, 'Finance');
  assert.ok(r.tags.includes('invoice') && r.tags.includes('finance'));
  assert.ok(r.tags.length <= 7);
  assert.ok(r.summary.length > 0);
});

test('empty text goes to General with no-readable-text summary', () => {
  const r = organizeOffline({ name: 'scan.pdf', ext: '.pdf', text: '' });
  assert.deepEqual([r.type, r.folder, r.summary], ['report', 'General', '(no readable text)']);
});

test('organize uses AI JSON when valid, but keeps the invoice->Finance rule', async () => {
  const llm = { enabled: () => true, complete: async () => '```json\n{"type":"invoice","folder":"Bills","tags":["Cloud","hosting"],"summary":"CloudNest hosting bill."}\n```' };
  const r = await organize({ name: 'inv.txt', ext: '.txt', text: invoice }, { llm });
  assert.equal(r.by, 'ai');
  assert.equal(r.folder, 'Finance');
  assert.deepEqual(r.tags.slice(0, 2), ['cloud', 'hosting']);
  assert.equal(r.summary, 'CloudNest hosting bill.');
});

test('organize falls back to offline on junk or error, and logs it', async () => {
  const logs = [];
  const log = (agent, m) => logs.push(`${agent}: ${m}`);
  const junk = { enabled: () => true, complete: async () => 'sorry, no JSON' };
  const boom = { enabled: () => true, complete: async () => { throw new Error('rate limited'); } };
  assert.equal((await organize({ name: 'm.md', ext: '.md', text: meeting }, { llm: junk, log })).by, 'offline');
  assert.equal((await organize({ name: 'm.md', ext: '.md', text: meeting }, { llm: boom, log })).by, 'offline');
  assert.equal(logs.length, 2);
  assert.match(logs[1], /rate limited/);
});

test('organize skips AI when disabled or text empty', async () => {
  let called = false;
  const llm = { enabled: () => true, complete: async () => { called = true; return '{}'; } };
  await organize({ name: 'e.txt', ext: '.txt', text: '' }, { llm });
  assert.equal(called, false);
  const off = await organize({ name: 'm.md', ext: '.md', text: meeting }, { llm: { enabled: () => false } });
  assert.equal(off.by, 'offline');
});
```

- [ ] **Step 2: Run** `node --test test/organizer.test.js`. Expected: FAIL.

- [ ] **Step 3: Implement `src/agents/organizer.js`**

```js
import { tokenize, topTerms, summarize, stem } from '../text.js';

export const TYPES = ['invoice', 'meeting', 'data', 'report'];

export const TOPICS = {
  Finance: ['invoice', 'payment', 'budget', 'expense', 'cost', 'revenue', 'tax', 'billing', 'amount', 'total', 'spend', 'finance', 'accounting', 'payable', 'price'],
  Marketing: ['marketing', 'campaign', 'brand', 'social', 'ads', 'advertising', 'seo', 'audience', 'launch', 'content', 'influencer', 'newsletter'],
  Engineering: ['api', 'code', 'database', 'server', 'deploy', 'bug', 'feature', 'architecture', 'mobile', 'app', 'backend', 'frontend', 'release', 'sprint', 'engineering'],
  HR: ['hiring', 'candidate', 'interview', 'employee', 'onboarding', 'salary', 'leave', 'benefits', 'recruit', 'recruiting', 'hr', 'policy'],
  Legal: ['contract', 'agreement', 'clause', 'liability', 'compliance', 'legal', 'nda', 'terms', 'gdpr', 'license'],
  Sales: ['sales', 'customer', 'deal', 'pipeline', 'lead', 'prospect', 'quota', 'crm', 'client', 'pricing'],
};
const TOPIC_STEMS = Object.fromEntries(Object.entries(TOPICS).map(([k, words]) => [k, new Set(words.map(stem))]));
const MIN_TOPIC_SCORE = 2;

export function detectType(name, ext, text) {
  if (ext === '.csv') return 'data';
  const t = String(text).toLowerCase();
  if (/\binvoice\b/.test(t) && /\b(total|amount due|balance due)\b/.test(t)) return 'invoice';
  if (/\b(attendees|agenda|minutes|action items?)\b/.test(t)) return 'meeting';
  return 'report';
}

export function detectFolder(name, ext, text) {
  if (!String(text).trim()) return 'General';
  const body = ext === '.csv' ? String(text).split(/\r?\n/)[0] : text;
  const tokens = [...tokenize(body), ...tokenize(name.replace(/\.[^.]+$/, '')).flatMap((t) => [t, t])];
  let best = 'General';
  let bestScore = MIN_TOPIC_SCORE - 1;
  for (const [topic, stems] of Object.entries(TOPIC_STEMS)) {
    const score = tokens.filter((t) => stems.has(t)).length;
    if (score > bestScore) { best = topic; bestScore = score; }
  }
  return best;
}

export function organizeOffline({ name, ext, text }) {
  const type = detectType(name, ext, text);
  const folder = type === 'invoice' ? 'Finance' : detectFolder(name, ext, text);
  const tags = [...new Set([type, folder.toLowerCase(), ...topTerms(text, 5)])].slice(0, 7);
  return { type, folder, tags, summary: summarize(text) };
}

const SYSTEM = 'You organise files in a cloud drive. Reply with JSON only.';

function buildPrompt(name, text) {
  return `File name: ${name}

Content (first 4000 characters):
"""
${text.slice(0, 4000)}
"""

Return ONLY a JSON object:
{"type": one of "invoice" | "meeting" | "data" | "report",
 "folder": a short topic folder name of 1-2 words, preferring Finance, Marketing, Engineering, HR, Legal, Sales or General,
 "tags": up to 6 short lowercase tags,
 "summary": one plain sentence under 160 characters}`;
}

export async function organize(doc, { llm, log = () => {} } = {}) {
  const offline = organizeOffline(doc);
  if (!llm?.enabled() || !String(doc.text).trim()) return { ...offline, by: 'offline' };
  try {
    const reply = parseJsonReply(await llm.complete(buildPrompt(doc.name, doc.text), { system: SYSTEM, effort: 'low' }));
    if (!reply) throw new Error('AI reply was not valid JSON');
    const type = doc.ext === '.csv' ? 'data' : TYPES.includes(reply.type) ? reply.type : offline.type;
    const aiFolder = typeof reply.folder === 'string' && reply.folder.trim().length > 0 && reply.folder.trim().length <= 30
      ? reply.folder.trim().replace(/^\w/, (c) => c.toUpperCase())
      : offline.folder;
    const folder = type === 'invoice' ? 'Finance' : aiFolder;
    const aiTags = Array.isArray(reply.tags) ? reply.tags.filter((t) => typeof t === 'string').map((t) => t.toLowerCase().trim()).filter(Boolean) : [];
    const tags = [...new Set([...aiTags.slice(0, 6), type])].slice(0, 7);
    const summary = typeof reply.summary === 'string' && reply.summary.trim() ? reply.summary.trim().slice(0, 160) : offline.summary;
    return { type, folder, tags, summary, by: 'ai' };
  } catch (err) {
    log('Organizer', `AI unavailable for "${doc.name}" (${err.message}); used offline rules instead.`);
    return { ...offline, by: 'offline' };
  }
}
```

`parseJsonReply` is imported from `../llm.js` (Task 7). **Coordination:** Task 7 runs in the same wave, so to avoid a cross-task import, put a copy of `parseJsonReply` (code below) in `src/json-reply.js`. Organizer, search and synthesizer import from `src/json-reply.js`, and `src/llm.js` re-exports it. Task 4 owns creating `src/json-reply.js`:

```js
// Pulls the first {...} JSON object out of an LLM reply (handles ```json fences and chatter). Returns null if none parses.
export function parseJsonReply(text) {
  if (!text) return null;
  const fenced = String(text).match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : String(text);
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end < start) return null;
  try { return JSON.parse(body.slice(start, end + 1)); } catch { return null; }
}
```

So the organizer import line is `import { parseJsonReply } from '../json-reply.js';`. Add the 4-section header:
- **BUSINESS RULES:** invoices go to Finance (spec §4.1), CSV files are `data`, the CSV header decides its folder.
- **DO NOT:** let an AI reply override the invoice→Finance rule, because the invoice automation relies on it.

- [ ] **Step 4: Run** `node --test test/organizer.test.js`. Expected: PASS.

---

### Task 5: Search agent (`src/agents/search.js`) and Synthesizer agent (`src/agents/synthesizer.js`)

(These are in one task because they share passage/sentence helpers and are tested together. One subagent writes both.)

**Files:**
- Create: `src/agents/search.js`, `src/agents/synthesizer.js`
- Test: `test/search.test.js`, `test/synthesizer.test.js`

**Interfaces:**
- Consumes: `src/text.js` and `src/json-reply.js` (Task 4 creates it; if it doesn't exist yet when you start, create it with exactly the code shown in Task 4).
- Produces (search):
  - `NOT_FOUND = "I couldn't find that in your files."`
  - `buildPassages(docs): {fileId, fileName, text}[]`, where `docs = {id, name, ext, text}[]`
  - `rankPassages(question, docs): {passage, score}[]` — sorted by score descending, scores > 0 only
  - `answerOffline(question, docs): {answer, citations}`
  - `async ask(question, docs, {llm, log}): {answer, citations, by}`
  - `citation = {n, fileId, fileName, snippet}`
- Produces (synthesizer):
  - `FORMATS = {requirements: 'Unified Requirements', summary: 'Summary', compare: 'Comparison'}`
  - `synthesizeOffline(docs, format): {title, content}`
  - `async synthesize(docs, format, {llm, log}): {title, content, by}`

**Search rules:**
- **Passages:** split on blank lines and merge consecutive paragraphs up to 600 characters. A paragraph over 600 characters is split by sentences. For CSV, each passage is the header line plus up to 8 rows.
- **Ranking:** BM25 with k1 = 1.2 and b = 0.75 over `tokenize()` tokens.
  - Query tokens are expanded with `SYNONYMS` at weight 0.5.
  - A passage whose file name contains a query token gets +0.5 × idf for each such token.
  - The offline answer threshold is `MIN_SCORE = 1.0`.
- **Offline answer:**
  - Use the top 3 passages with score ≥ MIN_SCORE.
  - From each, pick the sentence with the highest sum of idf over matched query tokens.
  - Each answer line is `• <sentence> [n]`, where n = 1..3 matches the citation.
- **AI answer:**
  - Use the top 6 passages with score > 0, numbered [1]..[6].
  - Keep only the citations whose `[n]` appears in the answer. If the answer cites none, return all six.
  - If no passage has score > 0, return NOT_FOUND without calling the AI.

- [ ] **Step 1: Write the failing tests**

`test/search.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPassages, rankPassages, answerOffline, ask, NOT_FOUND } from '../src/agents/search.js';

const docs = [
  { id: 'k', name: 'q3-marketing-kickoff.md', ext: '.md', text: '# Kickoff\n\nAttendees: Sara\n\nThe team reviewed goals.\nThe total Q3 marketing budget was approved at $120,000.\n\n## Decisions\n- Launch on July 15.' },
  { id: 'e', name: 'mobile-spec.md', ext: '.md', text: '# Spec\n\nThe app must sync a 10 MB file in under 5 seconds.\n\nThe backend API should be fast.' },
  { id: 'c', name: 'q3-budget.csv', ext: '.csv', text: 'line_item,department,q3_budget\n' + Array.from({ length: 10 }, (_, i) => `Item ${i},Dept,${i}`).join('\n') },
];

test('buildPassages chunks paragraphs and csv rows', () => {
  const p = buildPassages(docs);
  const csv = p.filter((x) => x.fileId === 'c');
  assert.equal(csv.length, 2);
  assert.ok(csv.every((x) => x.text.startsWith('line_item,department,q3_budget')));
  assert.ok(p.every((x) => x.text.length <= 700));
});

test('rankPassages puts the budget passage first, synonyms count', () => {
  assert.equal(rankPassages('What was the Q3 marketing budget?', docs)[0].passage.fileId, 'k');
  assert.equal(rankPassages('how much marketing spend was approved', docs)[0].passage.fileId, 'k');
});

test('answerOffline answers with a cited sentence', () => {
  const r = answerOffline('What was the Q3 marketing budget?', docs);
  assert.match(r.answer, /\$120,000\. \[1\]/);
  assert.equal(r.citations[0].fileName, 'q3-marketing-kickoff.md');
  assert.equal(r.citations[0].n, 1);
});

test('no match / no docs returns NOT_FOUND', () => {
  assert.deepEqual(answerOffline('zebra giraffe safari', docs), { answer: NOT_FOUND, citations: [] });
  assert.deepEqual(answerOffline('budget', []), { answer: NOT_FOUND, citations: [] });
});

test('ask uses AI and keeps only cited sources', async () => {
  let prompt = '';
  const llm = { enabled: () => true, complete: async (p) => { prompt = p; return 'The budget was $120,000 [1].'; } };
  const r = await ask('What was the Q3 marketing budget?', docs, { llm });
  assert.equal(r.by, 'ai');
  assert.match(prompt, /\[1\]/);
  assert.equal(r.citations.length, 1);
  assert.equal(r.citations[0].fileId, 'k');
});

test('ask falls back offline when AI throws', async () => {
  const logs = [];
  const llm = { enabled: () => true, complete: async () => { throw new Error('quota'); } };
  const r = await ask('Q3 marketing budget', docs, { llm, log: (a, m) => logs.push(m) });
  assert.equal(r.by, 'offline');
  assert.match(r.answer, /\$120,000/);
  assert.match(logs[0], /quota/);
});
```

`test/synthesizer.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { synthesizeOffline, synthesize, FORMATS } from '../src/agents/synthesizer.js';

const docs = [
  { id: 'a', name: 'kickoff.md', text: 'Attendees: Sara\nThe Q3 marketing budget was approved at $120,000.\nThe landing page must load in 2 seconds.\n## Action Items\n- [ ] Sara will finalise the campaign brief by July 8.' },
  { id: 'b', name: 'review.md', text: 'We have spent $64,500 so far.\nWe agreed to move $10,000 to TikTok ads.\n## Action Items\n- [ ] Hina will shift budget by August 20.' },
];

for (const format of Object.keys(FORMATS)) {
  test(`offline ${format} has title, sources and figures`, () => {
    const r = synthesizeOffline(docs, format);
    assert.equal(r.title, FORMATS[format]);
    assert.match(r.content, /^# /);
    assert.match(r.content, /## Sources\n1\. kickoff\.md\n2\. review\.md/);
    assert.match(r.content, /\$120,000/);
  });
}

test('requirements format collects requirements, decisions, action items', () => {
  const c = synthesizeOffline(docs, 'requirements').content;
  assert.match(c, /## Requirements[\s\S]*must load in 2 seconds[\s\S]*\(kickoff\.md\)/);
  assert.match(c, /## Decisions[\s\S]*agreed to move \$10,000/);
  assert.match(c, /- \[ \] Sara will finalise the campaign brief by July 8\. \(kickoff\.md\)/);
  assert.match(c, /- \[ \] Hina will shift budget by August 20\. \(review\.md\)/);
});

test('compare format has a table row per file', () => {
  const c = synthesizeOffline(docs, 'compare').content;
  assert.match(c, /\| kickoff\.md \|/);
  assert.match(c, /\| review\.md \|/);
});

test('synthesize uses AI text, appends Sources if missing, falls back on error', async () => {
  const ok = await synthesize(docs, 'summary', { llm: { enabled: () => true, complete: async () => '# Summary\n\nAll good.' } });
  assert.equal(ok.by, 'ai');
  assert.match(ok.content, /## Sources\n1\. kickoff\.md/);
  const logs = [];
  const bad = await synthesize(docs, 'summary', { llm: { enabled: () => true, complete: async () => { throw new Error('down'); } }, log: (a, m) => logs.push(m) });
  assert.equal(bad.by, 'offline');
  assert.equal(logs.length, 1);
});
```

- [ ] **Step 2: Run** `node --test test/search.test.js test/synthesizer.test.js`. Expected: FAIL.

- [ ] **Step 3: Implement `src/agents/search.js`**

```js
import { tokenize, splitSentences } from '../text.js';

export const NOT_FOUND = "I couldn't find that in your files.";
const MAX_PASSAGE = 600;
const CSV_ROWS = 8;
const MIN_SCORE = 1.0;
const K1 = 1.2;
const B = 0.75;

// Keys and values are run through tokenize() at load, so write plain words.
const SYNONYM_WORDS = {
  budget: ['spend', 'cost', 'allocation', 'funding'],
  spend: ['budget', 'cost', 'expense', 'spent'],
  cost: ['price', 'expense', 'spend'],
  meeting: ['minutes', 'discussion', 'call', 'sync'],
  q3: ['third', 'quarter'],
  deadline: ['due', 'date', 'timeline', 'by'],
  owner: ['responsible', 'assigned'],
  decide: ['agreed', 'approved', 'decision'],
  revenue: ['sales', 'income'],
  customer: ['client'],
  employee: ['staff', 'team'],
  invoice: ['bill', 'payment'],
};
const SYNONYMS = new Map(Object.entries(SYNONYM_WORDS).map(([k, vs]) => [tokenize(k)[0], vs.flatMap(tokenize)]));

export function buildPassages(docs) {
  const out = [];
  for (const d of docs) {
    if (!d.text?.trim()) continue;
    const push = (text) => out.push({ fileId: d.id, fileName: d.name, text: text.trim() });
    if (d.ext === '.csv') {
      const [header, ...rows] = d.text.split(/\r?\n/).filter((l) => l.trim());
      if (rows.length === 0) push(header);
      for (let i = 0; i < rows.length; i += CSV_ROWS) push([header, ...rows.slice(i, i + CSV_ROWS)].join('\n'));
      continue;
    }
    let buf = '';
    for (const para of d.text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean)) {
      const pieces = para.length <= MAX_PASSAGE ? [para] : chunkSentences(para);
      for (const piece of pieces) {
        if (buf && buf.length + piece.length + 2 > MAX_PASSAGE) { push(buf); buf = ''; }
        buf = buf ? `${buf}\n\n${piece}` : piece;
      }
    }
    if (buf) push(buf);
  }
  return out;
}

function chunkSentences(para) {
  const chunks = [];
  let cur = '';
  for (const s of splitSentences(para)) {
    const sentence = s.slice(0, MAX_PASSAGE);
    if (cur && cur.length + sentence.length + 1 > MAX_PASSAGE) { chunks.push(cur); cur = ''; }
    cur = cur ? `${cur} ${sentence}` : sentence;
  }
  if (cur) chunks.push(cur);
  return chunks;
}

function queryWeights(question) {
  const weights = new Map();
  for (const t of tokenize(question)) {
    weights.set(t, 1);
    for (const syn of SYNONYMS.get(t) || []) if (!weights.has(syn)) weights.set(syn, 0.5);
  }
  return weights;
}

function scoreAll(question, docs) {
  const passages = buildPassages(docs);
  const tokenLists = passages.map((p) => tokenize(p.text));
  const avgLen = tokenLists.reduce((s, t) => s + t.length, 0) / (tokenLists.length || 1);
  const df = new Map();
  for (const toks of tokenLists) for (const t of new Set(toks)) df.set(t, (df.get(t) || 0) + 1);
  const N = passages.length;
  const idf = (t) => Math.log(1 + (N - (df.get(t) || 0) + 0.5) / ((df.get(t) || 0) + 0.5));
  const weights = queryWeights(question);
  const ranked = passages.map((passage, i) => {
    const toks = tokenLists[i];
    const tf = new Map();
    for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1);
    const nameToks = new Set(tokenize(passage.fileName.replace(/\.[^.]+$/, '')));
    let score = 0;
    for (const [t, w] of weights) {
      const f = tf.get(t) || 0;
      if (f) score += w * idf(t) * ((f * (K1 + 1)) / (f + K1 * (1 - B + (B * toks.length) / (avgLen || 1))));
      if (w === 1 && nameToks.has(t)) score += 0.5 * idf(t);
    }
    return { passage, score };
  });
  return { ranked: ranked.filter((r) => r.score > 0).sort((a, b) => b.score - a.score), idf, weights };
}

export function rankPassages(question, docs) {
  return scoreAll(question, docs).ranked;
}

const toCitation = (p, n) => ({ n, fileId: p.fileId, fileName: p.fileName, snippet: p.text.length > 240 ? `${p.text.slice(0, 239)}…` : p.text });

export function answerOffline(question, docs) {
  const { ranked, idf, weights } = scoreAll(question, docs);
  const top = ranked.filter((r) => r.score >= MIN_SCORE).slice(0, 3);
  if (top.length === 0) return { answer: NOT_FOUND, citations: [] };
  const lines = top.map(({ passage }, i) => {
    let best = '';
    let bestScore = -1;
    for (const s of splitSentences(passage.text.replace(/^#+\s*/gm, ''))) {
      const sc = [...new Set(tokenize(s))].reduce((sum, t) => sum + (weights.has(t) ? weights.get(t) * idf(t) : 0), 0);
      if (sc > bestScore) { best = s; bestScore = sc; }
    }
    return `• ${best} [${i + 1}]`;
  });
  return { answer: lines.join('\n'), citations: top.map((r, i) => toCitation(r.passage, i + 1)) };
}

const SYSTEM = 'You answer questions about the user\'s files using only the sources given. Cite every fact with its source number like [1].';

export async function ask(question, docs, { llm, log = () => {} } = {}) {
  if (!llm?.enabled()) return { ...answerOffline(question, docs), by: 'offline' };
  const top = rankPassages(question, docs).slice(0, 6);
  if (top.length === 0) return { answer: NOT_FOUND, citations: [], by: 'ai' };
  const sources = top.map((r, i) => `[${i + 1}] (${r.passage.fileName})\n${r.passage.text}`).join('\n\n');
  const prompt = `Question: ${question}\n\nSources:\n${sources}\n\nAnswer in under 120 words using ONLY these sources and cite them like [1]. If they don't contain the answer, reply exactly: ${NOT_FOUND}`;
  try {
    const answer = (await llm.complete(prompt, { system: SYSTEM, effort: 'medium' }))?.trim();
    if (!answer) throw new Error('AI returned an empty answer');
    const all = top.map((r, i) => toCitation(r.passage, i + 1));
    const used = new Set([...answer.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])));
    const citations = used.size ? all.filter((c) => used.has(c.n)) : all;
    return { answer, citations: answer === NOT_FOUND ? [] : citations, by: 'ai' };
  } catch (err) {
    log('Search', `AI unavailable (${err.message}); answered with offline search instead.`);
    return { ...answerOffline(question, docs), by: 'offline' };
  }
}
```

- [ ] **Step 4: Implement `src/agents/synthesizer.js`**

```js
import { summarize, splitSentences, tokenize, extractDecisions, extractRequirements, extractActionItems, extractAmounts, topTerms } from '../text.js';

export const FORMATS = { requirements: 'Unified Requirements', summary: 'Summary', compare: 'Comparison' };
const MAX_CHARS_PER_DOC = 12000;

const bullets = (items) => (items.length ? items.map((i) => `- ${i}`).join('\n') : '- None found.');
const sourcesSection = (docs) => `## Sources\n${docs.map((d, i) => `${i + 1}. ${d.name}`).join('\n')}`;
const tagged = (docs, fn) => docs.flatMap((d) => fn(d.text).map((x) => `${x} (${d.name})`));
const today = () => new Date().toISOString().slice(0, 10);

function keySentences(text, n) {
  const freq = new Map();
  for (const t of tokenize(text)) freq.set(t, (freq.get(t) || 0) + 1);
  return splitSentences(text.replace(/^#+.*$/gm, ''))
    .filter((s) => s.split(/\s+/).length >= 6)
    .map((s, i) => ({ s, i, score: tokenize(s).reduce((a, t) => a + (freq.get(t) || 0), 0) / Math.sqrt(tokenize(s).length || 1) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, n)
    .sort((a, b) => a.i - b.i)
    .map((x) => x.s.replace(/^[-*]\s*(\[[ x]\]\s*)?/i, ''));
}

export function synthesizeOffline(docs, format) {
  const title = FORMATS[format];
  const header = `# ${title}\n\n_Generated by the Synthesizer agent from ${docs.length} files on ${today()} (offline mode)._`;
  const overview = `## Overview\n${docs.map((d) => `- **${d.name}**: ${summarize(d.text)}`).join('\n')}`;
  const figures = `## Key Figures\n${bullets(tagged(docs, extractAmounts))}`;
  const decisions = `## Decisions\n${bullets(tagged(docs, extractDecisions))}`;
  let body;
  if (format === 'requirements') {
    const actions = tagged(docs, extractActionItems);
    body = [overview, `## Requirements\n${bullets(tagged(docs, extractRequirements))}`, decisions,
      `## Action Items\n${actions.length ? actions.map((a) => `- [ ] ${a}`).join('\n') : '- None found.'}`, figures];
  } else if (format === 'summary') {
    body = [overview, `## Key Points\n${bullets(docs.flatMap((d) => keySentences(d.text, 2).map((s) => `${s} (${d.name})`)))}`, decisions, figures];
  } else {
    const termSets = docs.map((d) => new Set(topTerms(d.text, 15)));
    const common = [...termSets[0]].filter((t) => termSets.every((s) => s.has(t)));
    const rows = docs.map((d, i) => `| ${d.name} | ${summarize(d.text, 90).replace(/\|/g, '/')} | ${extractAmounts(d.text).slice(0, 3).join(', ') || '-'} | ${extractDecisions(d.text).length} | ${[...termSets[i]].filter((t) => !common.includes(t)).slice(0, 4).join(', ') || '-'} |`);
    body = [`## Side by Side\n| File | Summary | Key figures | Decisions | Unique topics |\n| --- | --- | --- | --- | --- |\n${rows.join('\n')}`,
      `## Common Themes\n${bullets(common.slice(0, 8))}`, figures];
  }
  return { title, content: [header, ...body, sourcesSection(docs)].join('\n\n') + '\n' };
}

const INSTRUCTIONS = {
  requirements: 'Write a unified project requirements document: Overview, Requirements, Decisions, Open Questions, Action Items (as "- [ ]" checkboxes with owners and dates).',
  summary: 'Write a concise combined summary: Overview, Key Points, Decisions, Key Figures.',
  compare: 'Compare the files: a Markdown table (one row per file), then Common Themes, Differences and Conflicts.',
};

export async function synthesize(docs, format, { llm, log = () => {} } = {}) {
  if (!llm?.enabled()) return { ...synthesizeOffline(docs, format), by: 'offline' };
  const files = docs.map((d) => {
    const cut = d.text.length > MAX_CHARS_PER_DOC;
    return `=== File: ${d.name}${cut ? ' (truncated)' : ''} ===\n${d.text.slice(0, MAX_CHARS_PER_DOC)}`;
  }).join('\n\n');
  const prompt = `${INSTRUCTIONS[format]}\nUse only facts from the files. Write Markdown starting with "# ${FORMATS[format]}". Mention which file each fact comes from.\n\n${files}`;
  try {
    let content = (await llm.complete(prompt, { system: 'You combine documents into clear, accurate new documents.' }))?.trim();
    if (!content) throw new Error('AI returned an empty document');
    if (!/## Sources/.test(content)) content += `\n\n${sourcesSection(docs)}`;
    return { title: FORMATS[format], content: `${content}\n`, by: 'ai' };
  } catch (err) {
    log('Synthesizer', `AI unavailable (${err.message}); built the document with offline rules instead.`);
    return { ...synthesizeOffline(docs, format), by: 'offline' };
  }
}
```

Add the 4-section header to both files:
- search, **WHY IT'S BUILT THIS WAY:** BM25 plus synonyms gives "meaning-ish" search without a vector DB, and AI answers only see the top passages so prompts stay small.
- search, **DO NOT:** return citations the answer doesn't use.
- synthesizer, **DO NOT:** drop the Sources section, because the judges' "with citations" requirement relies on it.

- [ ] **Step 5: Run** `node --test test/search.test.js test/synthesizer.test.js`. Expected: PASS. If a ranking assertion fails, tune `SYNONYM_WORDS` or the name boost in the code, not the test.

---

### Task 6: Automations agent (`src/agents/automations.js`)

**Files:**
- Create: `src/agents/automations.js`
- Test: `test/automations.test.js`

**Interfaces:**
- Consumes: `extractActionItems` from `src/text.js`
- Produces:
  - `DEFAULT_RULES: Rule[]` (ids `invoice-to-csv`, `meeting-action-items`)
  - `EXPENSES_FILE = 'expenses.csv'`
  - `EXPENSES_HEADER = 'date,vendor,invoice_number,category,total,currency,source_file'`
  - `parseInvoice(text): {vendor, number, date, total: number, currency, category} | null` — null when no total is found
  - `categorize(text): 'Software' | 'Travel' | 'Marketing' | 'Office' | 'Utilities' | 'Other'`
  - `csvEscape(value): string`
  - `parseCsvLine(line): string[]`
  - `appendExpenseRow(existingCsv: string | null, invoice, sourceFile): {csv, added: boolean}`
  - `runAutomations({record, text, rules, getFileText}): {writes: {name, folder, content, type}[], logs: string[]}`
    - `getFileText(name) → string | null`
    - It does **no IO**; the caller (Task 8 pipeline) applies the writes.

- [ ] **Step 1: Write the failing test** `test/automations.test.js`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseInvoice, categorize, csvEscape, parseCsvLine, appendExpenseRow, runAutomations, DEFAULT_RULES, EXPENSES_HEADER } from '../src/agents/automations.js';

const cloudnest = `INVOICE

From: CloudNest Hosting Ltd.
Invoice Number: INV-1042
Invoice Date: 2026-07-05
Bill To: Agentic Drive Team

Cloud hosting subscription (July)   $1,000.00
Subtotal                            $1,150.00
Tax                                  $100.00
Total Due: $1,250.00`;

const printhub = `PrintHub Studio
INVOICE
Invoice Number: INV-3310
Invoice Date: 2026-07-20
Summer Switch campaign flyers (5,000)      $1,980.00
Event banners (4)                          $1,500.00
Total Due: $3,480.00`;

test('parseInvoice reads vendor, number, date, total, category', () => {
  assert.deepEqual(parseInvoice(cloudnest), { vendor: 'CloudNest Hosting Ltd.', number: 'INV-1042', date: '2026-07-05', total: 1250, currency: 'USD', category: 'Software' });
  const p = parseInvoice(printhub);
  assert.equal(p.vendor, 'PrintHub Studio');
  assert.equal(p.total, 3480);
  assert.equal(p.category, 'Marketing');
});

test('parseInvoice prefers Total over Subtotal and handles € / codes', () => {
  assert.equal(parseInvoice('Invoice\nSubtotal: $10.00\nTotal: €12.50').total, 12.5);
  assert.equal(parseInvoice('Invoice\nSubtotal: $10.00\nTotal: €12.50').currency, 'EUR');
  assert.equal(parseInvoice('Invoice X\nAmount due: 4,000 PKR').currency, 'PKR');
});

test('parseInvoice returns null without a total', () => {
  assert.equal(parseInvoice('INVOICE\nFrom: Someone\nThanks!'), null);
});

test('categorize', () => {
  assert.equal(categorize('Return flight and hotel'), 'Travel');
  assert.equal(categorize('Desk chairs and stationery for the office'), 'Office');
  assert.equal(categorize('Consulting'), 'Other');
});

test('csv escaping round-trips through parseCsvLine', () => {
  const v = 'Acme, "Best" Ltd';
  assert.equal(csvEscape(v), '"Acme, ""Best"" Ltd"');
  assert.deepEqual(parseCsvLine(`a,${csvEscape(v)},c`), ['a', v, 'c']);
});

test('appendExpenseRow creates header, appends, and dedupes by invoice number', () => {
  const inv = parseInvoice(cloudnest);
  const first = appendExpenseRow(null, inv, 'cloudnest.txt');
  assert.equal(first.added, true);
  assert.equal(first.csv, `${EXPENSES_HEADER}\n2026-07-05,CloudNest Hosting Ltd.,INV-1042,Software,1250.00,USD,cloudnest.txt\n`);
  const dup = appendExpenseRow(first.csv, inv, 'copy.txt');
  assert.equal(dup.added, false);
  assert.equal(dup.csv, first.csv);
  const second = appendExpenseRow(first.csv, parseInvoice(printhub), 'printhub.pdf');
  assert.equal(second.csv.trim().split('\n').length, 3);
});

test('runAutomations: invoice -> expenses.csv write + log', () => {
  const r = runAutomations({ record: { name: 'cloudnest.txt', type: 'invoice', folder: 'Finance', generated: false }, text: cloudnest, rules: DEFAULT_RULES, getFileText: () => null });
  assert.equal(r.writes.length, 1);
  assert.deepEqual([r.writes[0].name, r.writes[0].folder, r.writes[0].type], ['expenses.csv', 'Finance', 'data']);
  assert.match(r.logs[0], /INV-1042.*\$1,250\.00.*expenses\.csv/);
});

test('runAutomations: invoice without total logs and writes nothing', () => {
  const r = runAutomations({ record: { name: 'x.txt', type: 'invoice', folder: 'Finance' }, text: 'INVOICE\nnothing', rules: DEFAULT_RULES, getFileText: () => null });
  assert.equal(r.writes.length, 0);
  assert.match(r.logs[0], /no total/i);
});

test('runAutomations: meeting -> action items file in same folder', () => {
  const text = '# Kickoff\nAttendees: Sara\n## Action Items\n- [ ] Sara will finalise the brief by July 8.';
  const r = runAutomations({ record: { name: 'q3-kickoff.md', type: 'meeting', folder: 'Marketing' }, text, rules: DEFAULT_RULES, getFileText: () => null });
  assert.equal(r.writes[0].name, 'q3-kickoff - action items.md');
  assert.equal(r.writes[0].folder, 'Marketing');
  assert.match(r.writes[0].content, /- \[ \] Sara will finalise the brief by July 8\./);
});

test('runAutomations respects disabled rules and skips generated files', () => {
  const off = DEFAULT_RULES.map((r) => ({ ...r, enabled: false }));
  assert.deepEqual(runAutomations({ record: { name: 'a.txt', type: 'invoice', folder: 'Finance' }, text: cloudnest, rules: off, getFileText: () => null }), { writes: [], logs: [] });
  assert.deepEqual(runAutomations({ record: { name: 'a.txt', type: 'invoice', folder: 'Finance', generated: true }, text: cloudnest, rules: DEFAULT_RULES, getFileText: () => null }), { writes: [], logs: [] });
});
```

- [ ] **Step 2: Run** `node --test test/automations.test.js`. Expected: FAIL.

- [ ] **Step 3: Implement `src/agents/automations.js`**

```js
import { extractActionItems } from '../text.js';

export const EXPENSES_FILE = 'expenses.csv';
export const EXPENSES_HEADER = 'date,vendor,invoice_number,category,total,currency,source_file';

export const DEFAULT_RULES = [
  { id: 'invoice-to-csv', name: 'Invoice → expenses.csv', description: 'When an invoice is uploaded, extract the vendor, date and total, pick a category, and add a row to expenses.csv in Finance.', enabled: true },
  { id: 'meeting-action-items', name: 'Meeting → action items', description: 'When meeting notes are uploaded, pull the action items into a checklist file next to the meeting.', enabled: true },
];

const CATEGORIES = {
  Software: ['software', 'subscription', 'saas', 'license', 'cloud', 'hosting', 'database'],
  Travel: ['flight', 'hotel', 'travel', 'airfare', 'taxi', 'uber', 'train'],
  Marketing: ['print', 'flyer', 'banner', 'advertising', 'ads', 'campaign', 'brochure', 'promo'],
  Office: ['office', 'stationery', 'furniture', 'chair', 'desk', 'supplies', 'printer'],
  Utilities: ['electricity', 'internet', 'water', 'utility', 'utilities', 'phone'],
};
const SYMBOLS = { $: 'USD', '€': 'EUR', '£': 'GBP' };
const MONEY_RE = /([$€£])?\s?(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)\s?(USD|EUR|GBP|PKR)?/g;
const TOTAL_PATTERNS = [/\bgrand total\b/i, /\b(total due|amount due|balance due)\b/i, /\btotal\b/i];

export function categorize(text) {
  const t = String(text).toLowerCase();
  let best = 'Other';
  let bestScore = 0;
  for (const [cat, words] of Object.entries(CATEGORIES)) {
    const score = words.reduce((s, w) => s + (t.match(new RegExp(`\\b${w}`, 'g')) || []).length, 0);
    if (score > bestScore) { best = cat; bestScore = score; }
  }
  return best;
}

export function parseInvoice(text) {
  const lines = String(text).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  let totalLine = null;
  for (const re of TOTAL_PATTERNS) {
    const hits = lines.filter((l) => re.test(l) && [...l.matchAll(MONEY_RE)].some((m) => m[1] || m[3] || /[.,]/.test(m[2])));
    if (hits.length) { totalLine = hits[hits.length - 1]; break; }
  }
  if (!totalLine) return null;
  const amounts = [...totalLine.matchAll(MONEY_RE)].filter((m) => m[1] || m[3] || /[.,]/.test(m[2]));
  const last = amounts[amounts.length - 1];
  const total = Number(last[2].replace(/,/g, ''));
  const currency = last[3] || SYMBOLS[last[1]] || 'USD';
  const number = (text.match(/\b(INV[-\s]?\d+)\b/i)?.[1] ?? text.match(/invoice\s*(?:number|no\.?|#)\s*[:#]?\s*([A-Z0-9][A-Z0-9-]+)/i)?.[1] ?? '').toUpperCase();
  const date = text.match(/(?:invoice date|date)\s*[:-]?\s*(\d{4}-\d{2}-\d{2}|[A-Za-z]+ \d{1,2},? \d{4}|\d{1,2}\/\d{1,2}\/\d{4})/i)?.[1] ?? '';
  const vendorLine = lines.map((l) => l.match(/^(?:from|vendor|seller|billed by)\s*[:-]\s*(.+)/i)).find(Boolean);
  const vendor = vendorLine ? vendorLine[1].trim() : lines.find((l) => !/^invoice\b/i.test(l)) ?? '';
  return { vendor, number, date, total, currency, category: categorize(text) };
}

export function csvEscape(value) {
  const s = String(value ?? '');
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

export function appendExpenseRow(existingCsv, inv, sourceFile) {
  const base = existingCsv && existingCsv.trim() ? existingCsv.replace(/\s*$/, '\n') : `${EXPENSES_HEADER}\n`;
  const rows = base.trim().split('\n').slice(1).map(parseCsvLine);
  const duplicate = inv.number ? rows.some((r) => r[2] === inv.number) : rows.some((r) => r[6] === sourceFile);
  if (duplicate) return { csv: existingCsv, added: false };
  const row = [inv.date, inv.vendor, inv.number, inv.category, inv.total.toFixed(2), inv.currency, sourceFile].map(csvEscape).join(',');
  return { csv: `${base}${row}\n`, added: true };
}

const money = (n, cur) => (cur === 'USD' ? `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : `${n.toFixed(2)} ${cur}`);

export function runAutomations({ record, text, rules, getFileText }) {
  const writes = [];
  const logs = [];
  if (record.generated) return { writes, logs };
  const on = (id) => rules.some((r) => r.id === id && r.enabled);

  if (record.type === 'invoice' && on('invoice-to-csv')) {
    const inv = parseInvoice(text);
    if (!inv) {
      logs.push(`"${record.name}" looks like an invoice but has no total I could read, so nothing was logged.`);
    } else {
      const { csv, added } = appendExpenseRow(getFileText(EXPENSES_FILE), inv, record.name);
      const label = inv.number || record.name;
      if (added) {
        writes.push({ name: EXPENSES_FILE, folder: 'Finance', content: csv, type: 'data' });
        logs.push(`Logged ${label} (${money(inv.total, inv.currency)}) from ${inv.vendor || 'unknown vendor'} to ${EXPENSES_FILE} as ${inv.category}.`);
      } else {
        logs.push(`${label} is already in ${EXPENSES_FILE}, so the duplicate was skipped.`);
      }
    }
  }

  if (record.type === 'meeting' && on('meeting-action-items')) {
    const items = extractActionItems(text);
    if (items.length === 0) {
      logs.push(`No action items found in "${record.name}".`);
    } else {
      const name = `${record.name.replace(/\.[^.]+$/, '')} - action items.md`;
      const content = `# Action items: ${record.name}\n\n_Created automatically by the Meeting → action items automation._\n\n${items.map((i) => `- [ ] ${i}`).join('\n')}\n`;
      writes.push({ name, folder: record.folder, content, type: 'report' });
      logs.push(`Found ${items.length} action items in "${record.name}" and created "${name}".`);
    }
  }
  return { writes, logs };
}
```

The 4-section header must state these points:
- **BUSINESS RULES:** invoice → expenses.csv (spec §4.4, PDF capability 4); duplicates are detected by invoice number, falling back to source file name.
- **WHY IT'S BUILT THIS WAY:** it returns writes instead of doing IO, so it's testable and cannot recurse. Generated files are skipped, which prevents an automation-triggers-automation loop.
- **DO NOT:** run automations on agent-generated files.

- [ ] **Step 4: Run** `node --test test/automations.test.js`. Expected: PASS.

---

### Task 7: LLM client (`src/llm.js`)

**Files:**
- Create: `src/llm.js`
- Test: `test/llm.test.js`

**Interfaces:**
- Produces:
  - `DEFAULT_MODELS = {gemini: 'gemini-3.8-flash', claude: 'claude-opus-5'}`
  - `pickProvider(env): 'gemini' | 'claude' | null`
  - `createLlm(env = process.env)`, returning:
    - `enabled(): boolean`
    - `status(): {aiProvider, model}`
    - `complete(prompt, {system?, effort?}): Promise<string | null>` — null when no provider is set; **throws** on API failure, refusal or empty text
  - re-exports `parseJsonReply` from `./json-reply.js`

**Verified SDK facts (checked against the installed typings on 2026-10-14):**
- Gemini: `new GoogleGenAI({ apiKey })`, then `ai.models.generateContent({ model, contents, config: { systemInstruction } })`, then `response.text` (a getter that can be `undefined`).
- Claude: `new Anthropic({ apiKey })`.
  - For `claude-opus-5` / `claude-fable-5-1`, use `client.beta.messages.create({ ..., betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' })` (`BetaFallbacksParam = Array | 'default'`). Other models use `client.messages.create`.
  - Effort goes in `output_config: { effort }`. Use `max_tokens: 16000`.
  - Check `stop_reason === 'refusal'`, then join the `text` blocks.

- [ ] **Step 1: Write the failing test** `test/llm.test.js`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickProvider, createLlm, parseJsonReply, DEFAULT_MODELS } from '../src/llm.js';

test('pickProvider', () => {
  assert.equal(pickProvider({}), null);
  assert.equal(pickProvider({ GEMINI_API_KEY: 'g' }), 'gemini');
  assert.equal(pickProvider({ ANTHROPIC_API_KEY: 'a' }), 'claude');
  assert.equal(pickProvider({ GEMINI_API_KEY: 'g', ANTHROPIC_API_KEY: 'a' }), 'gemini');
  assert.equal(pickProvider({ GEMINI_API_KEY: 'g', ANTHROPIC_API_KEY: 'a', AI_PROVIDER: 'claude' }), 'claude');
  assert.equal(pickProvider({ AI_PROVIDER: 'claude' }), null);
});

test('createLlm without keys is disabled and returns null', async () => {
  const llm = createLlm({});
  assert.equal(llm.enabled(), false);
  assert.deepEqual(llm.status(), { aiProvider: null, model: null });
  assert.equal(await llm.complete('hi'), null);
});

test('status reports model defaults and overrides', () => {
  assert.deepEqual(createLlm({ GEMINI_API_KEY: 'g' }).status(), { aiProvider: 'gemini', model: DEFAULT_MODELS.gemini });
  assert.deepEqual(createLlm({ ANTHROPIC_API_KEY: 'a', ANTHROPIC_MODEL: 'claude-sonnet-5' }).status(), { aiProvider: 'claude', model: 'claude-sonnet-5' });
});

test('parseJsonReply handles fences, chatter, junk', () => {
  assert.deepEqual(parseJsonReply('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseJsonReply('Sure! {"a":2} hope that helps'), { a: 2 });
  assert.equal(parseJsonReply('no json'), null);
  assert.equal(parseJsonReply('{bad'), null);
  assert.equal(parseJsonReply(null), null);
});
```

- [ ] **Step 2: Run** `node --test test/llm.test.js`. Expected: FAIL.

- [ ] **Step 3: Implement `src/llm.js`**

```js
import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenAI } from '@google/genai';

export { parseJsonReply } from './json-reply.js';

export const DEFAULT_MODELS = { gemini: 'gemini-3.8-flash', claude: 'claude-opus-5' };
const FALLBACK_MODELS = new Set(['claude-opus-5', 'claude-fable-5-1']);

export function pickProvider(env) {
  const wanted = (env.AI_PROVIDER || '').toLowerCase();
  if (wanted === 'gemini' && env.GEMINI_API_KEY) return 'gemini';
  if (wanted === 'claude' && env.ANTHROPIC_API_KEY) return 'claude';
  if (env.GEMINI_API_KEY) return 'gemini';
  if (env.ANTHROPIC_API_KEY) return 'claude';
  return null;
}

export function createLlm(env = process.env) {
  const provider = pickProvider(env);
  const model = provider === 'gemini' ? env.GEMINI_MODEL || DEFAULT_MODELS.gemini
    : provider === 'claude' ? env.ANTHROPIC_MODEL || DEFAULT_MODELS.claude : null;
  let gemini;
  let claude;

  async function completeGemini(prompt, { system }) {
    gemini ??= new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
    const res = await gemini.models.generateContent({ model, contents: prompt, config: system ? { systemInstruction: system } : {} });
    if (!res.text) throw new Error('Gemini returned no text');
    return res.text;
  }

  async function completeClaude(prompt, { system, effort }) {
    claude ??= new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
    const params = { model, max_tokens: 16000, messages: [{ role: 'user', content: prompt }] };
    if (system) params.system = system;
    if (effort) params.output_config = { effort };
    const res = FALLBACK_MODELS.has(model)
      ? await claude.beta.messages.create({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' })
      : await claude.messages.create(params);
    if (res.stop_reason === 'refusal') throw new Error('Claude declined this request');
    const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    if (!text) throw new Error('Claude returned no text');
    return text;
  }

  return {
    enabled: () => provider !== null,
    status: () => ({ aiProvider: provider, model }),
    async complete(prompt, opts = {}) {
      if (!provider) return null;
      return provider === 'gemini' ? completeGemini(prompt, opts) : completeClaude(prompt, opts);
    },
  };
}
```

If `src/json-reply.js` does not exist yet (Task 4 runs in parallel), create it with exactly the code in Task 4. The 4-section header must state these points:
- **BUSINESS RULES:** the AI is optional (spec §2); the key stays on the server.
- **WHY IT'S BUILT THIS WAY:** `complete` throws instead of returning null on failure, so each agent can log the failure and fall back. Server-side fallbacks are enabled on Opus 5 so a safety refusal gets retried.
- **DO NOT:** log or return the API key; send keys to the browser.

- [ ] **Step 4: Run** `node --test test/llm.test.js`. Expected: PASS (no network calls are made).

---

### Task 8: Pipeline + Express server + API tests

**Files:**
- Create: `src/pipeline.js`, `server.js`
- Test: `test/server.test.js`

**Interfaces:**
- Consumes: everything above, plus `src/samples/` (Task 9).
- Produces `createPipeline({store, llm})`, which returns:
  - `ingest({name, buffer, source}): Promise<Record>`
  - `saveGenerated({name, folder, content, type}): Record` — updates the file in place if a record with that name exists
- `createApp({dataDir, llm, samplesDir}): express.Application`. `server.js` listens only when it is run directly.

**API contract (the UI in Task 10 is built against this exact contract):**

| Method & path | Request | 200 response |
|---|---|---|
| GET `/api/status` | — | `{aiProvider: 'gemini'\|'claude'\|null, model: string\|null}` |
| GET `/api/files` | — | `{files: Record[]}` |
| GET `/api/files/:id` | — | `Record & {text}` (404 if unknown) |
| GET `/api/files/:id/download` | — | the original bytes, as an attachment |
| DELETE `/api/files/:id` | — | `{ok: true}` (404 if unknown) |
| POST `/api/upload` | multipart field `files` (1–20) | `{files: Record[], errors: {name, error}[]}`; 400 `{error, errors}` if **every** file failed |
| POST `/api/samples` | — | `{loaded: string[], skipped: string[]}` |
| POST `/api/ask` | `{question}` (1–500 chars) | `{answer, citations: {n, fileId, fileName, snippet}[], by}` |
| POST `/api/synthesize` | `{fileIds: string[] (≥2), format: 'requirements'\|'summary'\|'compare'}` | `Record` of the new file (folder `Generated`) |
| GET `/api/automations` | — | `{rules: Rule[]}` |
| PUT `/api/automations/:id` | `{enabled: boolean}` | `Rule` (404 if unknown) |
| GET `/api/activity` | — | `{activity: Activity[]}` (newest first, max 100) |

- [ ] **Step 1: Write the failing test** `test/server.test.js`

```js
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server.js';
import { createLlm } from '../src/llm.js';

const here = path.dirname(fileURLToPath(import.meta.url));
let server;
let base;

before(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drive-srv-'));
  const app = createApp({ dataDir, llm: createLlm({}), samplesDir: path.join(here, '..', 'src', 'samples') });
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const json = async (p, opts = {}) => {
  const res = await fetch(base + p, { ...opts, headers: { 'content-type': 'application/json', ...(opts.headers || {}) } });
  return { status: res.status, body: await res.json() };
};
const upload = async (files) => {
  const fd = new FormData();
  for (const [name, content] of files) fd.append('files', new Blob([content]), name);
  const res = await fetch(`${base}/api/upload`, { method: 'POST', body: fd });
  return { status: res.status, body: await res.json() };
};
const byName = async (name) => (await json('/api/files')).body.files.find((f) => f.name === name);

test('status is offline without keys', async () => {
  assert.deepEqual((await json('/api/status')).body, { aiProvider: null, model: null });
});

test('samples load and every agent result is visible', async () => {
  const r = await json('/api/samples', { method: 'POST' });
  assert.equal(r.status, 200);
  assert.equal(r.body.loaded.length, 8);
  const expected = {
    'q3-marketing-kickoff.md': ['meeting', 'Marketing'],
    'q3-marketing-midpoint-review.md': ['meeting', 'Marketing'],
    'q3-marketing-wrapup.md': ['meeting', 'Marketing'],
    'invoice-cloudnest-INV-1042.txt': ['invoice', 'Finance'],
    'invoice-skyway-travel-INV-2207.txt': ['invoice', 'Finance'],
    'invoice-printhub-INV-3310.pdf': ['invoice', 'Finance'],
    'q3-budget.csv': ['data', 'Finance'],
    'mobile-app-v2-spec.md': ['report', 'Engineering'],
  };
  for (const [name, [type, folder]] of Object.entries(expected)) {
    const f = await byName(name);
    assert.ok(f, `${name} missing`);
    assert.deepEqual([f.type, f.folder], [type, folder], name);
  }
  const csv = await byName('expenses.csv');
  const text = (await json(`/api/files/${csv.id}`)).body.text;
  assert.equal(text.trim().split('\n').length, 4, text);
  assert.match(text, /INV-1042.*1250\.00/);
  assert.match(text, /INV-2207.*Travel,842\.60/);
  assert.match(text, /INV-3310.*Marketing,3480\.00/);
  assert.ok(await byName('q3-marketing-kickoff - action items.md'));
  const again = await json('/api/samples', { method: 'POST' });
  assert.equal(again.body.loaded.length, 0);
  assert.equal(again.body.skipped.length, 8);
});

test('ask answers the Q3 budget with a citation', async () => {
  const r = await json('/api/ask', { method: 'POST', body: JSON.stringify({ question: 'What was the Q3 marketing budget?' }) });
  assert.equal(r.status, 200);
  assert.match(r.body.answer, /\$120,000/);
  assert.ok(r.body.citations.some((c) => c.fileName === 'q3-marketing-kickoff.md'));
  assert.equal((await json('/api/ask', { method: 'POST', body: JSON.stringify({ question: '' }) })).status, 400);
});

test('synthesize creates a file in Generated', async () => {
  const ids = await Promise.all(['q3-marketing-kickoff.md', 'q3-marketing-midpoint-review.md', 'q3-marketing-wrapup.md'].map(async (n) => (await byName(n)).id));
  const r = await json('/api/synthesize', { method: 'POST', body: JSON.stringify({ fileIds: ids, format: 'requirements' }) });
  assert.equal(r.status, 200);
  assert.equal(r.body.folder, 'Generated');
  const doc = (await json(`/api/files/${r.body.id}`)).body.text;
  assert.match(doc, /## Sources/);
  assert.match(doc, /Sara will finalise the campaign brief by July 8\./);
  assert.equal((await json('/api/synthesize', { method: 'POST', body: JSON.stringify({ fileIds: [ids[0]], format: 'requirements' }) })).status, 400);
  assert.equal((await json('/api/synthesize', { method: 'POST', body: JSON.stringify({ fileIds: [ids[0], 'nope'], format: 'summary' }) })).status, 404);
  assert.equal((await json('/api/synthesize', { method: 'POST', body: JSON.stringify({ fileIds: ids, format: 'poem' }) })).status, 400);
});

test('same invoice uploaded twice keeps one CSV row', async () => {
  const inv = 'INVOICE\nFrom: Acme, "Best" Ltd\nInvoice Number: INV-9001\nDate: 2026-09-01\nOffice chairs\nTotal: $500.00';
  await upload([['acme.txt', inv]]);
  await upload([['acme-copy.txt', inv]]);
  const csv = (await json(`/api/files/${(await byName('expenses.csv')).id}`)).body.text;
  assert.equal(csv.split('\n').filter((l) => l.includes('INV-9001')).length, 1);
  assert.match(csv, /"Acme, ""Best"" Ltd"/);
});

test('unsupported and corrupt files are rejected; empty text is stored', async () => {
  const bad = await upload([['photo.png', 'x']]);
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /not supported/);
  assert.equal((await upload([['broken.pdf', 'not a pdf']])).status, 400);
  const mixed = await upload([['empty.txt', ''], ['x.docx', 'y']]);
  assert.equal(mixed.status, 200);
  assert.equal(mixed.body.files[0].summary, '(no readable text)');
  assert.equal(mixed.body.errors.length, 1);
});

test('html in names is stored verbatim (UI escapes it)', async () => {
  const name = '<img src=x onerror=alert(1)>.txt';
  const r = await upload([[name, 'hello world from a tricky file']]);
  assert.equal(r.body.files[0].name, name);
});

test('automations toggle, activity feed, delete, download, 404s', async () => {
  const rules = (await json('/api/automations')).body.rules;
  assert.equal(rules.length, 2);
  const off = await json('/api/automations/invoice-to-csv', { method: 'PUT', body: JSON.stringify({ enabled: false }) });
  assert.equal(off.body.enabled, false);
  assert.equal((await json('/api/automations/nope', { method: 'PUT', body: JSON.stringify({ enabled: true }) })).status, 404);
  const act = (await json('/api/activity')).body.activity;
  assert.ok(act.some((a) => a.agent === 'Organizer'));
  assert.ok(act.some((a) => a.agent === 'Automations'));
  const f = await byName('q3-budget.csv');
  const dl = await fetch(`${base}/api/files/${f.id}/download`);
  assert.equal(dl.status, 200);
  assert.match(await dl.text(), /line_item/);
  assert.deepEqual((await json(`/api/files/${f.id}`, { method: 'DELETE' })).body, { ok: true });
  assert.equal((await json(`/api/files/${f.id}`)).status, 404);
});
```

- [ ] **Step 2: Run** `node --test test/server.test.js`. Expected: FAIL (`server.js` missing).

- [ ] **Step 3: Implement `src/pipeline.js`**

```js
import { extractText } from './extract.js';
import { organize } from './agents/organizer.js';
import { runAutomations } from './agents/automations.js';
import { summarize, topTerms } from './text.js';

export function createPipeline({ store, llm }) {
  const log = (agent, message) => store.addActivity(agent, message);

  function saveGenerated({ name, folder, content, type }) {
    const buffer = Buffer.from(content, 'utf8');
    const existing = store.findByName(name);
    if (existing) {
      store.replaceContent(existing.id, buffer, content);
      return store.update(existing.id, { summary: summarize(content) });
    }
    const rec = store.add({ name, buffer, text: content, source: 'agent', generated: true });
    return store.update(rec.id, {
      type: type ?? (name.endsWith('.csv') ? 'data' : 'report'),
      folder,
      tags: [...new Set(['generated', folder.toLowerCase(), ...topTerms(content, 4)])],
      summary: summarize(content),
    });
  }

  async function ingest({ name, buffer, source = 'upload' }) {
    const text = await extractText(buffer, name);
    const added = store.add({ name, buffer, text, source });
    const org = await organize({ name, ext: added.ext, text }, { llm, log });
    const record = store.update(added.id, { type: org.type, folder: org.folder, tags: org.tags, summary: org.summary });
    log('Organizer', `Filed "${name}" into ${org.folder} as ${org.type}${org.by === 'ai' ? ' (AI)' : ''}. Tags: ${org.tags.join(', ')}.`);
    const { writes, logs } = runAutomations({
      record, text, rules: store.getRules(), getFileText: (n) => store.findByName(n)?.text ?? null,
    });
    for (const w of writes) saveGenerated(w);
    for (const m of logs) log('Automations', m);
    return record;
  }

  return { ingest, saveGenerated };
}
```

- [ ] **Step 4: Implement `server.js`**

```js
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import express from 'express';
import multer from 'multer';
import { createStore } from './src/store.js';
import { createLlm } from './src/llm.js';
import { createPipeline } from './src/pipeline.js';
import { UnsupportedFileError, ExtractError } from './src/extract.js';
import { DEFAULT_RULES } from './src/agents/automations.js';
import { ask } from './src/agents/search.js';
import { synthesize, FORMATS } from './src/agents/synthesizer.js';

const here = path.dirname(fileURLToPath(import.meta.url));

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export function createApp({ dataDir, llm, samplesDir = path.join(here, 'src', 'samples') }) {
  const store = createStore(dataDir, { defaultRules: DEFAULT_RULES });
  const pipeline = createPipeline({ store, llm });
  const app = express();
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 20 } });
  const mustGet = (id) => { const f = store.get(id); if (!f) throw new HttpError(404, 'File not found.'); return f; };

  app.use(express.json({ limit: '1mb' }));
  app.use(express.static(path.join(here, 'public')));

  app.get('/api/status', (req, res) => res.json(llm.status()));
  app.get('/api/files', (req, res) => res.json({ files: store.list() }));
  app.get('/api/files/:id', (req, res) => res.json(mustGet(req.params.id)));
  app.get('/api/files/:id/download', (req, res) => {
    const f = mustGet(req.params.id);
    res.download(store.filePath(f.id), f.name);
  });
  app.delete('/api/files/:id', (req, res) => {
    const f = mustGet(req.params.id);
    store.remove(f.id);
    store.addActivity('Drive', `Deleted "${f.name}".`);
    res.json({ ok: true });
  });

  app.post('/api/upload', upload.array('files', 20), async (req, res) => {
    const files = [];
    const errors = [];
    for (const f of req.files || []) {
      // multer gives latin1 names; browsers send UTF-8.
      const name = Buffer.from(f.originalname, 'latin1').toString('utf8');
      try {
        files.push(await pipeline.ingest({ name, buffer: f.buffer, source: 'upload' }));
      } catch (err) {
        if (!(err instanceof UnsupportedFileError || err instanceof ExtractError)) throw err;
        errors.push({ name, error: err.message });
      }
    }
    if (files.length === 0) {
      return res.status(400).json({ error: errors[0]?.error ?? 'No files were uploaded.', errors });
    }
    res.json({ files, errors });
  });

  app.post('/api/samples', async (req, res) => {
    const loaded = [];
    const skipped = [];
    for (const name of fs.readdirSync(samplesDir).sort()) {
      if (store.findByName(name)) { skipped.push(name); continue; }
      await pipeline.ingest({ name, buffer: fs.readFileSync(path.join(samplesDir, name)), source: 'sample' });
      loaded.push(name);
    }
    res.json({ loaded, skipped });
  });

  app.post('/api/ask', async (req, res) => {
    const question = typeof req.body?.question === 'string' ? req.body.question.trim() : '';
    if (!question || question.length > 500) throw new HttpError(400, 'Ask a question between 1 and 500 characters.');
    const docs = store.allWithText().filter((f) => f.text);
    const result = await ask(question, docs, { llm, log: (a, m) => store.addActivity(a, m) });
    store.addActivity('Search', `Answered "${question}" using ${result.citations.length} source(s)${result.by === 'ai' ? ' (AI)' : ''}.`);
    res.json(result);
  });

  app.post('/api/synthesize', async (req, res) => {
    const { fileIds, format } = req.body ?? {};
    if (!Array.isArray(fileIds) || new Set(fileIds).size < 2) throw new HttpError(400, 'Select at least 2 files.');
    if (!Object.hasOwn(FORMATS, format)) throw new HttpError(400, `Format must be one of: ${Object.keys(FORMATS).join(', ')}.`);
    const docs = [...new Set(fileIds)].map(mustGet);
    const result = await synthesize(docs, format, { llm, log: (a, m) => store.addActivity(a, m) });
    const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ').replace(':', '-');
    const record = pipeline.saveGenerated({ name: `${result.title} - ${stamp}.md`, folder: 'Generated', content: result.content, type: 'report' });
    store.addActivity('Synthesizer', `Created "${record.name}" from ${docs.length} files${result.by === 'ai' ? ' (AI)' : ''}.`);
    res.json(record);
  });

  app.get('/api/automations', (req, res) => res.json({ rules: store.getRules() }));
  app.put('/api/automations/:id', (req, res) => {
    if (typeof req.body?.enabled !== 'boolean') throw new HttpError(400, '"enabled" must be true or false.');
    const rule = store.setRuleEnabled(req.params.id, req.body.enabled);
    if (!rule) throw new HttpError(404, 'Automation not found.');
    store.addActivity('Automations', `${rule.enabled ? 'Enabled' : 'Disabled'} "${rule.name}".`);
    res.json(rule);
  });
  app.get('/api/activity', (req, res) => res.json({ activity: store.getActivity(100) }));

  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof multer.MulterError) {
      const msg = err.code === 'LIMIT_FILE_SIZE' ? 'Each file must be 10 MB or smaller.' : err.code === 'LIMIT_FILE_COUNT' ? 'Upload at most 20 files at a time.' : err.message;
      return res.status(400).json({ error: msg });
    }
    if (err instanceof UnsupportedFileError || err instanceof ExtractError) return res.status(400).json({ error: err.message });
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Request body must be valid JSON.' });
    console.error(err);
    res.status(500).json({ error: 'Something went wrong on the server.' });
  });
  return app;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const llm = createLlm();
  const port = Number(process.env.PORT) || 3000;
  const app = createApp({ dataDir: process.env.DATA_DIR || path.join(here, 'data'), llm });
  app.listen(port, () => {
    const { aiProvider, model } = llm.status();
    console.log(`Agentic Drive running at http://localhost:${port}`);
    console.log(aiProvider ? `AI: ${aiProvider} (${model})` : 'AI: off (no API key) - using offline agents');
  });
}
```

Express 5 forwards rejected promises from async handlers to the error middleware, so no wrapper is needed. Add the 4-section header to `server.js` and `src/pipeline.js`. Pipeline **DO NOT:** run the organizer or automations on generated files, and do not create a second `expenses.csv` (always update it by name).

- [ ] **Step 5: Run** `npm test`. Expected: every test in every file PASSES. If a sample lands in the wrong folder or type, fix the **sample text** (Task 9 owns it) only when the text is unrealistic. Otherwise fix the agent rule and add a unit test for that case.

- [ ] **Step 6: Commit (coordinator):** `git add -A && git commit -m "feat: pipeline, Express API and integration tests"`

---

### Task 9: Sample files, sample-PDF generator, BRAINSTORMING.md

**Files:**
- Create the eight samples in `src/samples/` (contents below)
- Create `scripts/make-sample-pdf.js`, which writes `src/samples/invoice-printhub-INV-3310.pdf`
- Create `BRAINSTORMING.md`

**Interfaces:**
- Produces exactly these 8 files in `src/samples/` (Task 8's test depends on these names and facts):
  - `q3-marketing-kickoff.md`
  - `q3-marketing-midpoint-review.md`
  - `q3-marketing-wrapup.md`
  - `invoice-cloudnest-INV-1042.txt`
  - `invoice-skyway-travel-INV-2207.txt`
  - `invoice-printhub-INV-3310.pdf`
  - `q3-budget.csv`
  - `mobile-app-v2-spec.md`

- [ ] **Step 1: Write the text samples exactly as below**

`src/samples/q3-marketing-kickoff.md`:
```markdown
# Q3 Marketing Kickoff — Meeting Minutes

Date: 2026-07-02
Attendees: Sara Khan (Marketing Lead), Bilal Ahmed (Content), Hina Raza (Paid Media), Omar Siddiqui (Finance)

## Agenda
1. Q3 marketing goals
2. Campaign plan
3. Budget

## Discussion
The team reviewed the Q3 marketing goals: grow newsletter sign-ups by 25% and launch the "Summer Switch" campaign across social channels.
The total Q3 marketing budget was approved at $120,000.
The budget is split into $60,000 for paid social ads, $35,000 for content and influencer marketing, and $25,000 for events.
Hina said paid social ads on Instagram and TikTok gave the best results last quarter.

## Decisions
- We agreed to launch the Summer Switch campaign on July 15.
- The team decided to run all campaign creatives past the brand team before publishing.

## Action Items
- [ ] Sara will finalise the campaign brief by July 8.
- [ ] Hina will set up the paid social ad accounts by July 10.
- [ ] Bilal will draft the first four newsletter issues by July 12.
```

`src/samples/q3-marketing-midpoint-review.md`:
```markdown
# Q3 Marketing Mid-Point Review — Meeting Minutes

Date: 2026-08-14
Attendees: Sara Khan, Hina Raza, Bilal Ahmed

## Discussion
So far we have spent $64,500 of the $120,000 Q3 marketing budget.
The Summer Switch campaign brought 4,200 new newsletter sign-ups, ahead of the 3,000 target.
TikTok ads cost less per sign-up than Instagram ads, so paid social spend should move toward TikTok.
Events spending is behind plan because one trade show was cancelled.

## Decisions
- We agreed to move $10,000 from the events budget to TikTok ads.
- The team decided to pause the lowest-performing Instagram ad set.

## Action Items
- [ ] Hina will shift $10,000 of budget to TikTok ads by August 20.
- [ ] Bilal will publish two customer story videos by August 30.
- Action: Sara to update the campaign dashboard every Friday.
```

`src/samples/q3-marketing-wrapup.md`:
```markdown
# Q3 Marketing Wrap-Up — Meeting Minutes

Date: 2026-09-29
Attendees: Sara Khan, Hina Raza, Bilal Ahmed, Omar Siddiqui

## Results
The Q3 marketing campaign finished with total spend of $118,200 against the $120,000 budget.
Newsletter sign-ups grew by 31%, beating the 25% goal.
The Summer Switch campaign reached 1.2 million people on social media.

## Decisions
- We agreed to keep TikTok as the main paid social channel in Q4.
- The remaining $1,800 will roll over to the Q4 marketing budget.

## Action Items
- [ ] Omar will close the Q3 marketing books by October 5.
- [ ] Sara will present the Q3 results to leadership on October 7.
```

`src/samples/invoice-cloudnest-INV-1042.txt`:
```
INVOICE

From: CloudNest Hosting Ltd.
Invoice Number: INV-1042
Invoice Date: 2026-07-05
Bill To: Agentic Drive Team

Description                          Amount
Cloud hosting subscription (July)    $1,000.00
Managed database add-on                $150.00
Subtotal                             $1,150.00
Tax                                    $100.00
Total Due: $1,250.00

Payment terms: Net 15. Thank you for your business.
```

`src/samples/invoice-skyway-travel-INV-2207.txt`:
```
SKYWAY TRAVEL AGENCY
Invoice

Vendor: Skyway Travel Agency
Invoice #: INV-2207
Date: 2026-08-02
Bill To: Agentic Drive Team

Return flight Karachi - Dubai (trade show), 1 traveller    $612.40
Hotel, 2 nights                                            $230.20
Total: $842.60
```

`src/samples/q3-budget.csv`:
```
line_item,department,q3_budget,spent_to_date,remaining,cost_center
Paid social ads,Marketing,60000,41200,18800,MKT-01
Content and influencers,Marketing,35000,23300,11700,MKT-02
Events,Marketing,25000,0,25000,MKT-03
Cloud hosting,Engineering,12000,11250,750,ENG-01
Recruiting fees,HR,8000,6500,1500,HR-01
Legal review,Legal,5000,2000,3000,LEG-01
```

`src/samples/mobile-app-v2-spec.md`:
```markdown
# Mobile App v2 — Engineering Spec

Owner: Engineering team
Status: Draft

## Goal
Rebuild the mobile app so files sync faster and work offline.

## Requirements
- The app must sync a 10 MB file in under 5 seconds on 4G.
- Users must be able to open recent files without an internet connection.
- The backend API should return search results in under 300 ms.
- We need to support both Android and iOS from one codebase.
- Push notifications are required when an agent finishes a task.

## Architecture
The frontend will use React Native. The backend API will run on Node.js with a PostgreSQL database. Files are stored in object storage and cached on the device.

## Release plan
Beta release to internal testers in sprint 14; public release in sprint 16.
```

- [ ] **Step 2: Write `scripts/make-sample-pdf.js` and run it**

```js
// Generates the bundled sample invoice PDF (dev only: needs the pdfkit devDependency).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import PDFDocument from 'pdfkit';

const out = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'samples', 'invoice-printhub-INV-3310.pdf');
const doc = new PDFDocument({ margin: 56 });
doc.pipe(fs.createWriteStream(out));
doc.fontSize(20).text('PrintHub Studio');
doc.fontSize(14).text('INVOICE');
doc.moveDown();
doc.fontSize(11);
for (const line of [
  'Invoice Number: INV-3310',
  'Invoice Date: 2026-07-20',
  'Bill To: Agentic Drive Team, Marketing Department',
  '',
  'Summer Switch campaign flyers (5,000)      $1,980.00',
  'Event banners (4)                          $1,500.00',
  'Total Due: $3,480.00',
  '',
  'Thank you for printing with PrintHub Studio.',
]) doc.text(line);
doc.end();
console.log(`Wrote ${out}`);
```

Run: `npm run make-sample-pdf`
Then: `node -e "import('./src/extract.js').then(async m=>console.log(await m.extractText(require('fs').readFileSync('src/samples/invoice-printhub-INV-3310.pdf'),'x.pdf')))"`. This needs `--input-type=module`; if the inline form fails, use a 3-line `.mjs` file in /tmp.
Expected: the output contains `PrintHub Studio`, `INV-3310` and `Total Due: $3,480.00`.

- [ ] **Step 3: Write `BRAINSTORMING.md`** (this is a hackathon deliverable, "Brainstorming Artifacts")

Required sections. Write real content of about 120–200 lines in plain English:
1. **The problem:** Drive and Dropbox are passive filing cabinets; quote the brief's framing in our own words.
2. **The shift:** passive storage becomes an active workspace. Include a before/after table covering search, organising, combining and admin work.
3. **Ideas we considered:** at least 10 ideas, each marked Built / Later / Dropped with a reason. Examples:
   - auto-folders (Built)
   - Q&A with citations (Built)
   - multi-file synthesis (Built)
   - invoice → CSV (Built)
   - meeting → action items (Built)
   - duplicate/version detection (Later)
   - deadline reminders from contracts (Later)
   - "explain this spreadsheet" (Later)
   - voice notes transcription (Dropped: scope)
   - auto-sharing with teammates (Dropped: privacy)
4. **Architecture sketch:** a Mermaid flowchart `User → Agent layer (Organizer, Search, Synthesizer, Automations) → Drive (files + db.json)`, plus the optional LLM box with offline fallback.
5. **The four agentic user flows:** one per PDF capability, each as numbered steps with the "aha!" moment called out. Use the sample files, e.g. "Upload 3 invoices → expenses.csv fills itself".
6. **Design principles:** works without AI, every answer is cited, agents explain what they did (activity feed), and nothing destructive happens automatically.
7. **Demo script for the 3-minute video:** a timed outline, e.g. 0:00–0:20 problem, 0:20–0:50 load samples, and so on.
8. **What we'd build next.**

---

### Task 10: Frontend UI (`public/`)

**Files:**
- Create: `public/index.html`, `public/style.css`, `public/app.js`

**Interfaces:**
- Consumes the API contract table in Task 8, exactly as written.
- Produces a single-page UI. There are no automated tests; it is verified in Task 11.

**Requirements (all mandatory):**

- **Layout (desktop, ≥ 1000px):**
  - A topbar.
  - Three columns:
    - left: folders, 220px
    - centre: file list + viewer, flexible
    - right: agent panel, 380px
  - Below 1000px the columns stack (folders become a horizontal scroll of chips) with no horizontal page scroll.
- **Topbar:**
  - Brand "Agentic Drive", with subtitle "Your files, organised by AI agents".
  - `#ai-status` pill: "Offline agents" (grey) or "Gemini · gemini-3.8-flash" / "Claude · claude-opus-5" (green), from `/api/status`.
  - `#btn-upload` button, which opens a hidden `#file-input` (`multiple`, `accept=".txt,.md,.csv,.pdf"`).
  - `#btn-samples` "Load sample files" button.
- **Drag and drop:** dragging files anywhere over the window shows `#drop-overlay` ("Drop files to upload"), and dropping uploads them.
- **Upload feedback:** a busy state on the button. Then a toast ("Uploaded 3 files" or the error message). Per-file `errors` are listed in the toast.
- **Folders (`#folder-list`):**
  - "All files" first.
  - Then each distinct folder, sorted alphabetically with "Generated" last, each with a count.
  - Clicking one filters the list. The active folder is highlighted.
- **File list (`#file-list`):**
  - Sorted newest first.
  - Each row shows:
    - a checkbox (selection for synthesis)
    - the name
    - a type badge (invoice / meeting / data / report, each with a distinct colour)
    - a "generated" badge when `generated`
    - up to 4 tags
    - the summary in one line
    - a delete button (deletes immediately — no `confirm()` dialog — then a toast with the name)
  - Clicking the row opens the viewer.
  - Empty state: "Your drive is empty. Upload files or load the samples to see the agents work."
  - `#filter` text input filters by name, tags and summary.
- **Viewer (`#viewer`):**
  - Shows the name, type, folder, size, summary, tags, and a download link (`/api/files/:id/download`).
  - Body:
    - CSV renders as a `<table>` (write a CSV parser that handles quotes).
    - `.md` renders with a tiny safe Markdown renderer covering `#`/`##`/`###` headings, `- [ ]` checkboxes (disabled), `-`/`*` bullets, `1.` lists, `| table |` rows, `**bold**`, and paragraphs. **Escape first, then format.**
    - Everything else renders as `<pre>` with wrapping.
  - It has a close button.
- **Agent panel tabs** (`role="tablist"`, arrow-key navigation not required):
  - **Ask** (`#ask-form`, `#ask-input`, `#ask-answer`):
    - Submit posts `/api/ask` and shows a "Searching your files…" state.
    - Render the answer with `[n]` turned into `<button class="cite" data-file-id>` that opens that file.
    - List the citations below, as file name + snippet, clickable.
    - Three clickable example questions: "What was the Q3 marketing budget?", "Who owns the campaign brief?", "How much did we spend on travel?".
  - **Synthesize:**
    - `#synth-count` shows "N files selected (pick at least 2)".
    - `#synth-format` is a select with Unified requirements doc / Summary / Compare.
    - `#btn-synth` is disabled until 2 or more files are selected.
    - The result opens in the viewer and the list refreshes.
  - **Automations** (`#rule-list`): each rule shows its name, description and a toggle switch (an `input type=checkbox role=switch`) that calls PUT.
- **Activity feed (`#activity-list`)** under the panel:
  - Polls `/api/activity` every 3 s.
  - Each entry shows its time (HH:MM:SS), an agent chip with a colour per agent, and the message.
  - When the newest activity id changes, also re-fetch `/api/files` so agent-made files appear without reload.
  - `aria-live="polite"`.
- **Security:** a single `escapeHtml()` helper is used for **every** interpolated string. Never put user text into `innerHTML` unescaped.
- **Look:**
  - Clean, modern, light theme.
  - CSS variables on `:root`.
  - System font stack.
  - 8px spacing scale, rounded cards, subtle borders.
  - Visible `:focus-visible` rings.
  - Buttons have hover/active states.
  - Respect `prefers-reduced-motion`.
  - No external CSS/JS libraries and no CDN, so it works offline.
- **Code structure:**
  - `app.js` is plain browser JS (no modules needed; one IIFE or top-level functions).
  - Sections: `api()` fetch helper (throws with the JSON `error`), `state`, `render*` functions, event wiring, polling.
  - Header comment: a short "IN SIMPLE WORDS" plus "DO NOT: insert unescaped text".

- [ ] **Step 1:** Write the three files to meet every requirement above.
- [ ] **Step 2:** `node --check public/app.js`. Expected: no output (valid syntax).
- [ ] **Step 3:** Grep self-check: `grep -n "innerHTML" public/app.js` — every hit must build its string through `escapeHtml(...)` or from constants. Report the count in your summary.

---

### Task 11: Verification (coordinator)

- [ ] **Step 1:** `npm test`. Expected: 0 failures. Record the pass count.
- [ ] **Step 2:** Start the server on a temp data dir: `DATA_DIR=$(mktemp -d) PORT=3123 node server.js &`, then use curl:
  - `GET /api/status`
  - `POST /api/samples`
  - `POST /api/ask` with the Q3 budget question
  - `GET /api/activity`
  - Expected: JSON matching the contract, the answer contains `$120,000`, and the activity shows the Organizer and Automations entries.
- [ ] **Step 3:** Use headless Chrome to screenshot `http://localhost:3123/` after samples load, then `--dump-dom` and confirm all of these:
  - folder names (Finance, Marketing, Engineering)
  - `expenses.csv` is listed
  - the activity entries render
  - no raw `<img src=x` element exists after uploading the HTML-named file (it must appear only as escaped text)
- [ ] **Step 4:** Read the screenshot and check the layout visually. Fix any UI issues found.
- [ ] **Step 5:** Write `README.md`:
  - what it is
  - the 4 features mapped to the PDF
  - setup: `npm install`, `npm start`, optional `.env`
  - how to demo
  - project structure
  - API table
  - tests
  - limitations: local storage, no OCR, AI optional, synth truncates each file at 12k chars when using AI
- [ ] **Step 6:** Commit: `git add -A && git commit -m "feat: agentic drive UI, samples, docs"`. Then stop the server.
