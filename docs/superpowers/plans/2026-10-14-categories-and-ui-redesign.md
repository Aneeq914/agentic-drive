# Categories, Mock Data & UI Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace naive type/topic-folder sorting with a confidence-scored **document-kind** classifier (with topic as a second label and manual "Move to…"). Add about 30 Brightleaf Labs mock files plus a blind holdout set, measure accuracy in tests, and redesign the UI in a Linear-like style.

**Architecture:**
- **Classifier:** a new pure `src/agents/classifier.js` scores kinds from structure, title and body signals.
- **Organizer:** `organizer.js` uses the classifier (with AI as an optional override).
- **Records:** carry `kind/topic/confidence/pinned` instead of `type/folder`.
- **Migration:** old records are re-sorted at startup.
- **UI:** `public/` is rewritten against the API contract below.

**Tech Stack:** Node 22 ESM, Express 5, node:test, plain HTML/CSS/JS.

**Spec:** `docs/superpowers/specs/2026-10-14-categories-and-ui-redesign.md`

## Global Constraints

- **Project root:** `/home/aneeq914/Desktop/uni/agentic-drive/`. ESM only.
- **Subagents** never run git; the coordinator commits.
- **Kind ids:** `invoice, meeting, contract, proposal, spec, report, data, people, other`.
- **Kind labels:**
  - Invoices & Receipts
  - Meeting Notes
  - Contracts & Agreements
  - Proposals & Briefs
  - Specs & Plans
  - Reports
  - Spreadsheets & Data
  - People & HR
  - Other
- **Topics:** `Finance, Marketing, Engineering, Sales, HR, Legal, Operations, Product`, or `null`.
- **Forced topics:** kind `invoice` → topic `Finance`; `people` → `HR`; `contract` → `Legal`.
- **Forced kind:** `.csv` → kind `data`, confidence `high`.
- **Accuracy targets:** sample files 100%; holdout ≥ 85%; a brief-like text is never `invoice`.
- **Module headers:** every non-trivial module keeps or gets the 4-section header (IN SIMPLE WORDS / BUSINESS RULES / WHY IT'S BUILT THIS WAY (change at your peril) / DO NOT). Only claim what tests verify.
- **UI:** no frameworks or CDNs; escape every interpolated string; no `alert`/`confirm`/`prompt`.

## Review Focus

1. **A document that mentions invoices but isn't one** (the brief, meeting notes about unpaid bills, an article on invoicing software): it must not become `invoice`. Tests: Task 1 unit tests and Task 2/3 decoys.
2. **A file the classifier can't decide** (a short note, a random text): it goes to `other` with confidence `low`, not to a confident wrong kind. Test: Task 1.
3. **Moving a file:** it stays where the user put it after a restart and is never re-sorted. Test: Task 4 server test (PATCH, then a new `createApp` on the same dataDir).
4. **Old `db.json` records with `type`/`folder`:** they are migrated to `kind`/`topic` at startup, and the invoice automation still works afterwards. Test: Task 4.
5. **Invalid PATCH input** (an unknown kind or topic, a non-object body): 400, nothing changed. Test: Task 4.

## Execution waves

| Wave | Tasks (parallel) |
|---|---|
| 1 | Task 1 (classifier), Task 2 (mock data + labels), Task 3 (blind holdout), Task 5 (UI) |
| 2 | Task 4 (integration: organizer/automations/pipeline/store/server + migration + API) |
| 3 | Task 6 (accuracy tuning against Tasks 2 + 3), then Task 7 (Chrome UI iteration + verification + docs; coordinator) |

## API contract (Task 4 implements, Task 5 consumes)

- **File record:**
  ```
  {id, name, ext, size, kind, topic, confidence, pinned, tags[], summary,
   createdAt, generated, source}
  ```
  It has no `type` and no `folder`.
- `GET /api/meta` → `{kinds: [{id, label}], topics: string[]}`. The kinds come in the order listed in Global Constraints.
- `PATCH /api/files/:id`
  - **Body:** `{kind?: kindId, topic?: string|null}`, with at least one of the two.
  - **Success:** 200 with the updated record, now `pinned: true`.
  - **Errors:** 400 `{error}` for an invalid kind, an invalid topic or an empty body; 404 for an unknown id.
- **Every other route** is unchanged from `docs/superpowers/plans/2026-10-14-agentic-drive.md` Task 8:
  - `/api/status`, `/api/files`, `/api/files/:id`, `/download`, `DELETE`
  - `/api/upload`, `/api/samples`, `/api/ask`, `/api/synthesize`
  - `/api/automations` (GET and PUT), `/api/activity`
- **Synthesize** returns a record with `kind: 'report'` and `generated: true`.
- **Automation outputs:**
  - `expenses.csv`: `kind: 'data'`, `topic: 'Finance'`
  - action items: `kind: 'meeting'`, with the topic copied from the meeting

---

### Task 1: Classifier (`src/agents/classifier.js`)

**Files:**
- Create: `src/agents/classifier.js`
- Test: `test/classifier.test.js`

**Interfaces — Produces:**
- `KINDS: {id, label}[]`
- `KIND_IDS: string[]`
- `TOPICS: string[]`
- `FORCED_TOPIC: {invoice: 'Finance', people: 'HR', contract: 'Legal'}`
- `classifyKind({name, ext, text}) → {kind, confidence, scores: {[kindId]: number}, runnerUp: kindId|null}`
- `classifyTopic({name, ext, text}, kind) → string|null`
- `kindLabel(id) → string`

- [ ] **Step 1: Write the failing test** `test/classifier.test.js`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyKind, classifyTopic, KINDS, KIND_IDS, TOPICS, kindLabel } from '../src/agents/classifier.js';

const k = (text, name = 'file.txt', ext = '.txt') => classifyKind({ name, ext, text });

test('kinds and topics are the fixed lists', () => {
  assert.deepEqual(KIND_IDS, ['invoice', 'meeting', 'contract', 'proposal', 'spec', 'report', 'data', 'people', 'other']);
  assert.equal(KINDS.length, 9);
  assert.equal(kindLabel('invoice'), 'Invoices & Receipts');
  assert.deepEqual(TOPICS, ['Finance', 'Marketing', 'Engineering', 'Sales', 'HR', 'Legal', 'Operations', 'Product']);
});

test('a real invoice is an invoice with high confidence', () => {
  const r = k('INVOICE\nFrom: CloudNest\nInvoice Number: INV-1042\nBill To: Brightleaf Labs\nHosting $1,000.00\nTotal Due: $1,250.00');
  assert.equal(r.kind, 'invoice');
  assert.equal(r.confidence, 'high');
});

test('a receipt is an invoice', () => {
  assert.equal(k('Receipt\nCafe Lumen\n2 x Latte $9.00\nTotal: $9.00\nPaid by card').kind, 'invoice');
});

test('a brief that talks about invoices is NOT an invoice', () => {
  const brief = `Hackathon Problem Statement
Challenge: Build the Next-Generation Agentic Workspace
The Core Problem
Traditional cloud storage platforms are passive.
Automated Workflows: when an invoice PDF is uploaded, an agent extracts the total and logs it into a CSV.
Logistics & Rules
• Deliverables: You must submit a working prototype and a 3-minute video.
Judging Criteria
Innovation, Technical Execution, User Experience.`;
  const r = k(brief, 'Hackathon Problem Statement.pdf', '.pdf');
  assert.notEqual(r.kind, 'invoice');
  assert.equal(r.kind, 'proposal');
});

test('meeting notes discussing an unpaid invoice are meeting notes', () => {
  const t = '# Finance sync\nAttendees: Omar, Sara\n## Agenda\n- Overdue invoice INV-2207 total $842.60\n## Action Items\n- [ ] Omar will chase the payment.';
  assert.equal(k(t, 'finance-sync.md', '.md').kind, 'meeting');
});

test('contracts, resumes, specs, reports, proposals', () => {
  assert.equal(k('MASTER SERVICES AGREEMENT\nThis Agreement is made between Brightleaf Labs and Acme.\nWHEREAS the parties agree...\n1. Term and Termination\n2. Confidentiality\nPayment Terms: $12,000 per month\nSignature: ____').kind, 'contract');
  assert.equal(k('Priya Nair\nSenior Designer\n## Experience\nLead designer at Studio X 2021-2026\n## Education\nBA Design\n## Skills\nFigma, research', 'priya-nair-resume.md', '.md').kind, 'people');
  assert.equal(k('# Search v2 Spec\nStatus: Draft\n## Requirements\n- Results must load in 300 ms\n## Acceptance Criteria\n- p95 under 300 ms\n## Architecture\nNode API', 'search-v2-spec.md', '.md').kind, 'spec');
  assert.equal(k('# Q3 Customer Churn Report\n## Executive Summary\nChurn fell 2 points.\n## Key Findings\n- Onboarding drives retention\n## Recommendations\n- Expand onboarding', 'churn-report.md', '.md').kind, 'report');
  assert.equal(k('# Proposal: Website Redesign for Acme\n## Objectives\nIncrease sign-ups.\n## Deliverables\nNew site, CMS.\n## Pricing\n$24,000', 'acme-proposal.md', '.md').kind, 'proposal');
});

test('csv is always data with high confidence', () => {
  assert.deepEqual([k('a,b\n1,2', 'x.csv', '.csv').kind, k('a,b\n1,2', 'x.csv', '.csv').confidence], ['data', 'high']);
});

test('unclear text goes to other with low confidence', () => {
  const r = k('Remember to water the plants on Friday.', 'note.txt');
  assert.equal(r.kind, 'other');
  assert.equal(r.confidence, 'low');
  assert.equal(k('', 'scan.pdf', '.pdf').kind, 'other');
});

test('topics: forced for invoice/people/contract, scored otherwise, null when unclear', () => {
  assert.equal(classifyTopic({ name: 'x.txt', ext: '.txt', text: 'campaign brand social' }, 'invoice'), 'Finance');
  assert.equal(classifyTopic({ name: 'x.md', ext: '.md', text: 'anything' }, 'people'), 'HR');
  assert.equal(classifyTopic({ name: 'x.md', ext: '.md', text: 'anything' }, 'contract'), 'Legal');
  assert.equal(classifyTopic({ name: 'q3-marketing-kickoff.md', ext: '.md', text: 'campaign social ads newsletter budget' }, 'meeting'), 'Marketing');
  assert.equal(classifyTopic({ name: 'search-spec.md', ext: '.md', text: 'api database latency backend deploy' }, 'spec'), 'Engineering');
  assert.equal(classifyTopic({ name: 'pipeline.csv', ext: '.csv', text: 'deal,customer,stage,amount\nAcme campaign,Marketing,1,2' }, 'data'), 'Sales');
  assert.equal(classifyTopic({ name: 'note.txt', ext: '.txt', text: 'water the plants' }, 'other'), null);
});
```

- [ ] **Step 2: Run the test.** `node --test test/classifier.test.js` → FAIL (module missing).

- [ ] **Step 3: Implement `src/agents/classifier.js`**

```js
import { tokenize, stem } from '../text.js';

export const KINDS = [
  { id: 'invoice', label: 'Invoices & Receipts' },
  { id: 'meeting', label: 'Meeting Notes' },
  { id: 'contract', label: 'Contracts & Agreements' },
  { id: 'proposal', label: 'Proposals & Briefs' },
  { id: 'spec', label: 'Specs & Plans' },
  { id: 'report', label: 'Reports' },
  { id: 'data', label: 'Spreadsheets & Data' },
  { id: 'people', label: 'People & HR' },
  { id: 'other', label: 'Other' },
];
export const KIND_IDS = KINDS.map((k) => k.id);
export const kindLabel = (id) => KINDS.find((k) => k.id === id)?.label ?? 'Other';
export const TOPICS = ['Finance', 'Marketing', 'Engineering', 'Sales', 'HR', 'Legal', 'Operations', 'Product'];
export const FORCED_TOPIC = { invoice: 'Finance', people: 'HR', contract: 'Legal' };

// A line that starts (after optional markdown/bullet/number markers) with `pattern`.
const L = (pattern) => new RegExp(`^[ \\t]*(?:[#*•>\\-]+[ \\t]*)?(?:\\d+[.)][ \\t]*)?(?:${pattern})`, 'im');

// Structural signals: each distinct match is worth 3 points. Structure beats mentions.
const STRUCTURE = {
  invoice: [L('invoice\\s*(?:number|no\\.?|#)'), L('bill(?:ed)?\\s+to\\b'), L('(?:total\\s+due|amount\\s+due|balance\\s+due|grand\\s+total)\\b'),
    L('(?:receipt|tax\\s+invoice|invoice)[ \\t]*$'), L('total\\s*:?\\s*[$€£]?\\s*\\d'), L('(?:subtotal|tax|vat)\\b.*\\d'), L('(?:payment\\s+terms|due\\s+date)\\s*:')],
  meeting: [L('(?:attendees|participants|present)\\s*:'), L('agenda\\b'), L('action\\s+items?\\b'), /\bmeeting\s+minutes\b/i, L('(?:discussion|decisions|next\\s+steps)[ \\t]*$')],
  contract: [/\bthis\s+(?:agreement|contract)\b/i, L('whereas\\b'), L('term(?:\\s+and\\s+termination)?[ \\t]*$'), L('(?:confidentiality|governing\\s+law|indemnification|limitation\\s+of\\s+liability)\\b'), L('(?:signature|signed|by)\\s*:'), /\bthe\s+parties\b/i],
  proposal: [L('(?:the\\s+core\\s+)?problem(?:\\s+statement)?\\b'), L('(?:proposal|proposed\\s+solution|our\\s+approach)\\b'), L('(?:objectives|goals)[ \\t]*$'), L('deliverables\\b'), L('(?:judging|evaluation)\\s+criteria\\b'), L('(?:pricing|investment|fees)[ \\t]*$')],
  spec: [L('(?:functional\\s+|non-functional\\s+)?requirements[ \\t]*$'), L('acceptance\\s+criteria\\b'), L('architecture\\b'), L('(?:milestones|release\\s+plan|roadmap)\\b'), L('(?:user\\s+stories|out\\s+of\\s+scope)\\b'), L('status\\s*:\\s*(?:draft|in\\s+review|approved)')],
  report: [L('executive\\s+summary\\b'), L('(?:key\\s+)?findings\\b'), L('(?:conclusion|recommendations)\\b'), L('(?:key\\s+metrics|results|methodology)[ \\t]*$')],
  people: [L('(?:work\\s+)?experience[ \\t]*$'), L('education[ \\t]*$'), L('skills[ \\t]*$'), L('(?:job\\s+title|position|reports\\s+to)\\s*:'), L('(?:responsibilities|qualifications)\\b'), /\b(?:curriculum\s+vitae|offer\s+letter|employee\s+handbook)\b/i],
};

// Title signals (file name + first line): 2 points per matched word, capped at 4.
const TITLE_WORDS = {
  invoice: ['invoice', 'receipt', 'bill'],
  meeting: ['meeting', 'minutes', 'standup', 'sync', 'retro', 'kickoff', 'retrospective', 'one-on-one', '1-1'],
  contract: ['agreement', 'contract', 'nda', 'msa', 'sow', 'lease', 'terms'],
  proposal: ['proposal', 'brief', 'rfp', 'pitch', 'problem', 'challenge', 'hackathon'],
  spec: ['spec', 'specification', 'prd', 'requirements', 'roadmap', 'plan', 'rfc', 'design'],
  report: ['report', 'analysis', 'review', 'research', 'survey', 'postmortem', 'insights', 'article', 'study'],
  people: ['resume', 'cv', 'job', 'description', 'offer', 'policy', 'handbook', 'onboarding', 'hiring'],
};

// Body words: 0.5 per occurrence, capped at 3 per kind, so mentions alone can't win.
const BODY_WORDS = {
  invoice: ['invoice', 'payment', 'paid', 'amount', 'due', 'receipt'],
  meeting: ['discussed', 'agreed', 'attendees', 'meeting', 'follow-up', 'decided'],
  contract: ['shall', 'party', 'parties', 'hereby', 'obligations', 'termination', 'liability', 'clause'],
  proposal: ['propose', 'proposal', 'objective', 'deliverable', 'challenge', 'participants', 'submission'],
  spec: ['must', 'requirement', 'api', 'endpoint', 'latency', 'implement'],
  report: ['analysis', 'findings', 'trend', 'percent', 'growth', 'compared', 'data'],
  people: ['experience', 'candidate', 'employee', 'salary', 'hiring', 'skills', 'role'],
};

const stems = (words) => new Set(words.flatMap((w) => tokenize(w)));
const TITLE_STEMS = Object.fromEntries(Object.entries(TITLE_WORDS).map(([k, w]) => [k, stems(w)]));
const BODY_STEMS = Object.fromEntries(Object.entries(BODY_WORDS).map(([k, w]) => [k, stems(w)]));
const MONEY = /[$€£]\s?\d|\b\d[\d,]*\.\d{2}\b|\b\d[\d,]*\s?(?:USD|EUR|GBP|PKR)\b/;

function titleTokens(name, text) {
  const firstLine = String(text).split(/\r?\n/).find((l) => l.trim()) ?? '';
  return tokenize(`${name.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' ')} ${firstLine}`);
}

export function classifyKind({ name, ext, text }) {
  const empty = Object.fromEntries(KIND_IDS.map((id) => [id, 0]));
  if (ext === '.csv') return { kind: 'data', confidence: 'high', scores: { ...empty, data: 10 }, runnerUp: null };
  if (!String(text).trim()) return { kind: 'other', confidence: 'low', scores: empty, runnerUp: null };
  const title = titleTokens(name, text);
  const body = tokenize(text);
  const scores = { ...empty };
  const invoiceSignals = STRUCTURE.invoice.filter((re) => re.test(text)).length;
  for (const kind of Object.keys(STRUCTURE)) {
    const structure = STRUCTURE[kind].filter((re) => re.test(text)).length * 3;
    const titleScore = Math.min(4, title.filter((t) => TITLE_STEMS[kind].has(t)).length * 2);
    const bodyScore = Math.min(3, body.filter((t) => BODY_STEMS[kind].has(t)).length * 0.5);
    scores[kind] = structure + titleScore + bodyScore;
  }
  // Invoice gate: it must LOOK like an invoice (2+ distinct invoice structures and money), not just mention one.
  if (invoiceSignals < 2 || !MONEY.test(text)) scores.invoice = Math.min(scores.invoice, 2);
  const ranked = Object.entries(scores).filter(([id]) => id !== 'data' && id !== 'other').sort((a, b) => b[1] - a[1]);
  const [[top, topScore], [second, secondScore]] = ranked;
  const lead = topScore - secondScore;
  const confidence = topScore >= 6 && lead >= 3 ? 'high' : topScore >= 3 && lead >= 1.5 ? 'medium' : 'low';
  return { kind: confidence === 'low' ? 'other' : top, confidence, scores, runnerUp: confidence === 'low' ? top : second };
}

const TOPIC_WORDS = {
  Finance: ['budget', 'invoice', 'payment', 'expense', 'cost', 'revenue', 'tax', 'accounting', 'cash', 'profit', 'forecast', 'spend', 'finance', 'billing', 'price'],
  Marketing: ['marketing', 'campaign', 'brand', 'social', 'ads', 'advertising', 'seo', 'audience', 'newsletter', 'influencer', 'content'],
  Engineering: ['api', 'code', 'database', 'server', 'deploy', 'bug', 'architecture', 'backend', 'frontend', 'infrastructure', 'latency', 'engineering', 'mobile', 'sprint'],
  Sales: ['sales', 'customer', 'deal', 'pipeline', 'lead', 'prospect', 'quota', 'crm', 'client', 'renewal', 'upsell', 'stage'],
  HR: ['hiring', 'candidate', 'interview', 'employee', 'onboarding', 'salary', 'benefits', 'recruit', 'leave', 'hr', 'resume', 'headcount', 'payroll'],
  Legal: ['contract', 'agreement', 'clause', 'liability', 'compliance', 'legal', 'nda', 'confidentiality', 'gdpr', 'indemnification'],
  Operations: ['operations', 'vendor', 'logistics', 'supply', 'office', 'facilities', 'travel', 'procurement', 'process', 'equipment'],
  Product: ['product', 'roadmap', 'feature', 'users', 'ux', 'design', 'prd', 'persona', 'usability', 'research'],
};
const TOPIC_STEMS = Object.fromEntries(Object.entries(TOPIC_WORDS).map(([t, w]) => [t, stems(w)]));
const MIN_TOPIC_HITS = 2;

export function classifyTopic({ name, ext, text }, kind) {
  if (FORCED_TOPIC[kind]) return FORCED_TOPIC[kind];
  const body = ext === '.csv' ? String(text).split(/\r?\n/)[0] ?? '' : String(text);
  const tokens = [...tokenize(body), ...tokenize(name.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' ')).flatMap((t) => [t, t])];
  let best = null;
  let bestScore = MIN_TOPIC_HITS - 1;
  for (const topic of TOPICS) {
    const score = tokens.filter((t) => TOPIC_STEMS[topic].has(t)).length;
    if (score > bestScore) { best = topic; bestScore = score; }
  }
  return best;
}
```

`stem` is imported for parity with organizer.js. If it is unused, remove the import. Add the 4-section header:
- **BUSINESS RULES:** spec §3–4: kinds, forced topics, the invoice gate, the confidence thresholds.
- **WHY IT'S BUILT THIS WAY:** structure weighs ×3 and body words are capped, which stops the "brief filed as invoice" bug. A low-confidence result goes to Other instead of a wrong folder.
- **DO NOT:** remove the invoice gate; let body-word counts grow uncapped.

- [ ] **Step 4: Run.** `node --test test/classifier.test.js` → PASS. Tune the weights or patterns, not the tests. Any change to a test needs a stated reason.

---

### Task 2: Mock data + labels (Brightleaf Labs)

**Files:**
- Create about 22 new files in `src/samples/`.
- Extend `scripts/make-sample-pdf.js` so it also generates the new PDFs. Keep the existing PrintHub PDF identical.
- Create `test/fixtures/sample-labels.json`.

**Do not change** the existing 8 sample files. Tests rely on their exact text.

- **Company:** "Brightleaf Labs", a 14-person product studio in Lahore. Documents are dated Q3 2026 (July–September).
- **Cast** (use consistently):
  - Sara Khan (Marketing Lead)
  - Omar Siddiqui (Finance)
  - Hina Raza (Paid Media)
  - Bilal Ahmed (Content)
  - Ayesha Malik (CEO)
  - Daniyal Qureshi (Engineering Lead)
  - Zara Sheikh (Product Manager)
  - Usman Tariq (Ops & HR)
- **Clients:** Acme Retail, Northwind Health.
- **Vendors:** CloudNest Hosting, Skyway Travel Agency, PrintHub Studio (already used), plus new vendors.
- **Required new files** (names are suggestions; keep them kebab-case):
  - **Invoices / receipts (4):**
    - `invoice-figma-INV-5521.txt` (software)
    - `receipt-cafe-lumen-team-lunch.txt`: a receipt with "Total:"
    - `invoice-officeworks-INV-7781.pdf`: office chairs, a PDF
    - `invoice-northwind-consulting-INV-0912.md`: Brightleaf billing a client; the "From:" line is Brightleaf
  - **Meetings (4):**
    - `finance-sync-2026-08-21.md`: a **decoy** that discusses overdue invoices, with figures
    - `weekly-standup-2026-09-07.md`
    - `acme-retail-kickoff-call.md`
    - `q3-board-update-meeting.md`
  - **Contracts (2):**
    - `acme-retail-msa.md`: a **decoy** with payment amounts and payment terms
    - `nda-northwind-health.txt`
  - **Proposals / briefs (3):**
    - `acme-website-redesign-proposal.md`: has a pricing/budget table
    - `northwind-patient-app-proposal.pdf`: a PDF
    - `internal-hackathon-brief.md`: a hackathon-style **problem statement decoy** that mentions invoices, totals and CSVs as example tasks
  - **Specs / plans (3):**
    - `search-v2-spec.md`
    - `q4-product-roadmap.md`
    - `office-move-project-plan.md`
  - **Reports (3):**
    - `q3-customer-churn-report.md`
    - `website-analytics-september.md`
    - `why-small-studios-switch-invoicing-tools.md`: an **article decoy** that is all about invoices
  - **Data (2):**
    - `sales-pipeline-q3.csv`
    - `headcount-2026.csv`
  - **People & HR (3):**
    - `resume-priya-nair-product-designer.pdf`: a PDF
    - `job-description-senior-backend-engineer.md`
    - `remote-work-policy.md`
- **Realism:** every file is realistic (15–60 lines) and cross-references the others where natural (the same people, clients and amounts).
- **Labels:** `test/fixtures/sample-labels.json` maps **every** file in `src/samples/` (the old 8 plus the new ones) to `{"kind": ..., "topic": ...}`:
  - Use the definitions in the spec §3.
  - Apply the forced topics (invoice → Finance, people → HR, contract → Legal).
  - `.csv` files are `data`, and their topic comes from the column headers.
  - Labels describe what a reasonable person would say the file is.
- **Old 8 labels:**
  - the three `q3-marketing-*.md`: meeting / Marketing
  - the three invoices: invoice / Finance
  - `q3-budget.csv`: data / Finance
  - `mobile-app-v2-spec.md`: spec / Engineering
- **PDF check:** run `npm run make-sample-pdf`, then check that each PDF's text extracts with `src/extract.js` (a throwaway script in the scratchpad).
- **Facts:** report a fact sheet listing who, amounts and dates per file, for the docs.

---

### Task 3: Blind holdout set

**Files:**
- `test/fixtures/holdout/*.txt|.md` (about 15)
- `test/fixtures/holdout/labels.json`

**The author must NOT read `src/agents/classifier.js` or `src/agents/organizer.js`.** They only get the kind definitions (spec §3), the topic list and the forced-topic rule.

Write about 15 short (5–30 lines), varied, *tricky* documents from **different** fictional organisations (not Brightleaf):
- different formatting styles (plain text, markdown, all-caps headings, bullet styles)
- at least 3 decoys that mention another kind's keywords
- one problem statement / challenge brief
- one receipt
- one cover letter (→ people)
- one SOW (→ contract)
- one postmortem (→ report)
- one RFC (→ spec)
- one sprint retro (→ meeting)
- one genuinely ambiguous note (→ `other`)

`labels.json` maps each file name to `{"kind", "topic"}` (topic may be `null`).

---

### Task 4: Integrate the classifier (organizer, automations, pipeline, store, server) + migration + new API

**Files:**
- Modify: `src/agents/organizer.js`, `src/agents/automations.js`, `src/pipeline.js`, `src/store.js`, `server.js`
- Tests: update `test/organizer.test.js`, `test/automations.test.js`, `test/server.test.js`; create `test/accuracy.test.js`

**Interfaces:**
- Consumes: Task 1 exports.
- Produces: the API contract above.
- Organizer:
  - `organizeOffline({name, ext, text}) → {kind, topic, confidence, runnerUp, tags, summary}`
  - `organize(doc, {llm, log}) → same + by`
  - `offlineSummary(kind, ext, text)` — an invoice summary when `kind === 'invoice'`
- Pipeline: `createPipeline({store, llm})` returns:
  - `ingest`
  - `saveGenerated({name, kind, topic, content})`
  - `migrate(): number` — returns how many records were migrated
  - `moveFile(id, {kind, topic}) → record|null`
- Store: `add()` defaults become `kind: 'other', topic: null, confidence: 'low', pinned: false`. It has no `type` or `folder`.

**Organizer changes:**
- `organizeOffline`:
  - `const c = classifyKind(doc); const topic = classifyTopic(doc, c.kind);`
  - `tags = unique([c.kind, topic?.toLowerCase(), ...topTerms(text, 5)].filter(Boolean)).slice(0, 7)`
  - `summary = offlineSummary(c.kind, ext, text)`
- **AI prompt:** ask for `{"kind": one of <KIND_IDS joined>, "topic": one of <TOPICS> or null, "tags": [...], "summary": "..."}`.
  - A kind not in `KIND_IDS` → use the offline kind.
  - `.csv` → `data`.
  - Then apply `FORCED_TOPIC`.
  - A topic not in `TOPICS` (and not null) → use the offline topic.
  - AI results get `confidence: 'high'`.
- **Remove** `TYPES`, `TOPICS` (the folder map), `detectType` and `detectFolder`, and their tests. Rewrite `test/organizer.test.js` around kind/topic. Keep the AI-fallback, junk-JSON, empty-text and invoice-summary tests, adapted to the new fields.

**Automations changes:**
- `record.type === 'invoice'` → `record.kind === 'invoice'`; `'meeting'` → `record.kind === 'meeting'`.
- **Writes:**
  - `{name: 'expenses.csv', kind: 'data', topic: 'Finance', content}`
  - action items: `{name, kind: 'meeting', topic: record.topic, content}`
- Update `test/automations.test.js` records to use `kind`/`topic`.

**Pipeline changes:**
- `saveGenerated({name, kind, topic, content})`:
  - On create: `generated: true`, `confidence: 'high'`, `pinned: false`, tags `['generated', kind, ...topTerms(content, 4)]`, `summary = offlineSummary(kind, ext, content)`.
  - On update (the file exists by name): only replace the content and summary.
- `ingest`:
  - Store `{kind, topic, confidence, tags, summary}`.
  - **Log:** `Filed "<name>" under <kindLabel> (topic: <topic or none>, confidence: <c>)`, with `(AI)` appended when the AI did it.
  - When `confidence === 'low'`, append: ` — not sure; looks most like <runnerUp label>. Use "Move to…" if it's wrong.`
- `migrate()`: for each record in `store.allWithText()` without a `kind`:
  - **Generated files:** `.csv` → data/Finance; a name containing "action items" → meeting with the topic from the old folder if it is in TOPICS, else null; otherwise report.
  - **Everything else:** `organizeOffline`.
  - Then `store.update(id, {kind, topic, confidence, tags, summary, type: undefined, folder: undefined})`. JSON drops `undefined`.
  - Returns the count. When the count is above 0, log an activity entry: `Re-sorted N files with the new categories`.
- `moveFile(id, {kind, topic})`:
  - Validate kind ∈ KIND_IDS and topic ∈ TOPICS or null; otherwise throw an `Error` with `.status = 400`.
  - Update with `pinned: true`, `confidence: 'high'`, plus the given fields.
  - Log `Moved "<name>" to <label> (pinned by you)`.
  - Unknown id → null.

**Server changes:**
- Call `pipeline.migrate()` once in `createApp`.
- `GET /api/meta`.
- `PATCH /api/files/:id`:
  - The body must be an object with at least one of `kind` or `topic`, else 400.
  - Map thrown `.status` 400 errors to 400.
  - Null from `moveFile` → 404.
- `synthesize`:
  - `saveGenerated({name, kind: 'report', topic: <most common non-null topic among the sources, or null>, content})`.
  - The activity text is unchanged.

**Tests to add** (in `test/server.test.js`, plus updates to the existing expectations):
- After samples load, each original sample has the expected kind and topic:
  - the three `q3-marketing-*.md`: meeting / Marketing
  - the three invoices: invoice / Finance
  - `q3-budget.csv`: data / Finance
  - `mobile-app-v2-spec.md`: spec / Engineering
- `expenses.csv` exists with kind data / Finance and holds the 3 invoice rows. **If Task 2 adds more invoices, assert that the rows include INV-1042, INV-2207 and INV-3310 instead of counting rows.**
- `GET /api/meta` returns 9 kinds and 8 topics.
- **PATCH:**
  - moving `mobile-app-v2-spec.md` to `report` returns `pinned: true`
  - a fresh `createApp` on the same `dataDir` still shows it as `report`
  - an invalid kind → 400; an invalid topic → 400; `{}` → 400; an unknown id → 404
- **Migration test:**
  - Write a `db.json` by hand with an old-style record (`type: 'invoice', folder: 'Finance'`, no `kind`, with invoice `text`) and its file on disk.
  - `createApp` on it.
  - Expect `GET /api/files` to show `kind: 'invoice'` with no `type`/`folder` keys.

**`test/accuracy.test.js`:**
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractText } from '../src/extract.js';
import { organizeOffline } from '../src/agents/organizer.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
async function run(dir, labelsPath) {
  const labels = JSON.parse(fs.readFileSync(labelsPath, 'utf8'));
  const rows = [];
  for (const [name, want] of Object.entries(labels)) {
    const text = await extractText(fs.readFileSync(path.join(dir, name)), name);
    const got = organizeOffline({ name, ext: path.extname(name).toLowerCase(), text });
    rows.push({ name, want, got: { kind: got.kind, topic: got.topic } });
  }
  return rows;
}

test('every bundled sample gets its labelled kind and topic', async () => {
  const rows = await run(path.join(root, 'src/samples'), path.join(root, 'test/fixtures/sample-labels.json'));
  const files = fs.readdirSync(path.join(root, 'src/samples'));
  assert.deepEqual(rows.map((r) => r.name).sort(), files.sort(), 'every sample must be labelled');
  const wrong = rows.filter((r) => r.want.kind !== r.got.kind || r.want.topic !== r.got.topic);
  assert.deepEqual(wrong, []);
});

test('holdout: at least 85% of kinds correct, and no brief is an invoice', async () => {
  const dir = path.join(root, 'test/fixtures/holdout');
  const rows = await run(dir, path.join(dir, 'labels.json'));
  const correct = rows.filter((r) => r.want.kind === r.got.kind).length;
  const accuracy = correct / rows.length;
  const misses = rows.filter((r) => r.want.kind !== r.got.kind).map((r) => `${r.name}: want ${r.want.kind}, got ${r.got.kind}`);
  assert.ok(accuracy >= 0.85, `holdout kind accuracy ${(accuracy * 100).toFixed(0)}%\n${misses.join('\n')}`);
  assert.ok(rows.filter((r) => r.want.kind === 'proposal').every((r) => r.got.kind !== 'invoice'));
});
```

**Run:** `npm test`. Everything passes except possibly `accuracy.test.js`, which is Task 6's job. Report its misses.

---

### Task 5: UI redesign (`public/`)

Rewrite `public/index.html`, `public/style.css` and `public/app.js` against the **API contract** above, to the spec §7 design. Requirements beyond the spec:

- **Look:**
  - Linear-like.
  - Base text 14px.
  - System font stack (`Inter` if installed, else `-apple-system, Segoe UI, Roboto, …`).
  - Neutral greys (`#fafafa` bg, `#fff` surfaces, `#e8e8ec` borders, `#1c1c1f` text, `#6b6b76` muted) and one indigo accent (`#5e6ad2`).
  - 6px radius, 1px borders, very soft shadows, 8px spacing grid, 150–200ms ease-out transitions.
  - Dark mode via `prefers-color-scheme: dark` using the same CSS variables.
- **Icons:** inline SVG line icons (1.5px stroke, 16px) — one per kind, plus ask, upload, grid, list, close, more, download, trash, move, sparkle, activity and settings.
- **Command bar:**
  - Clicking it or pressing ⌘K/Ctrl+K focuses it. Enter asks. Esc closes.
  - The answer panel drops down under the bar: the question, the answer with `[n]` chips that open the cited file, a sources list, and an "AI" or "Offline" label.
  - Under the empty input, three example questions are shown:
    - "What was the Q3 marketing budget?"
    - "Who owns the campaign brief?"
    - "How much did we spend on travel?"
- **Sidebar sections:**
  - **Drive:** All files, Recent (the last 10 by createdAt), Generated, Needs a look (confidence `low`).
  - **Categories:** the kinds from `/api/meta` with icon and count; hide zero-count kinds except Other.
  - **Topics:** clickable chips with counts. A topic acts as an AND filter with the current view, with a clear state.
  - **Automations:** opens a modal-free panel/popover with toggles.
- **Main area:**
  - **Header:** a breadcrumb title, the count, a filter input, a list/grid toggle (remember the choice in `localStorage` inside a try/catch).
  - **List view:** columns are checkbox, name (with kind icon and a small "generated" sparkle), topic chip, kind label (muted), updated (relative, e.g. "2m ago"), size. Rows are 40px high. Hovering shows a "more" button that opens a menu with Open, Move to… (a submenu of kinds), Download and Delete.
  - **Grid view:** cards with a kind icon tile, name, topic chip and the summary in 2 lines.
  - **Empty state:** an illustration made of SVG shapes, the text "Your drive is empty", and **Load sample files** + **Upload** buttons.
- **Selection bar:**
  - With 1 or more selected, a floating pill appears at the bottom centre: "N selected · Combine into [Requirements] [Summary] [Compare] · Clear".
  - Combine buttons are disabled below 2 selected, with a tooltip.
  - After a combine, the new file opens in the drawer.
- **Preview drawer:**
  - A right slide-in panel, 480px wide (full screen below 760px), closed with Esc or ✕.
  - **Header:** kind icon + name.
  - **Meta row:** kind, topic chip, confidence (shown only when not high, as "Needs a look · looks like X?" when `runnerUp` is known — the API does not return runnerUp, so just "Needs a look"), size, date.
  - **Actions:** **Move to…** (kind dropdown → PATCH, which updates the list and the sidebar counts), a topic dropdown (PATCH), Download, Delete.
  - **Body:** summary card, tags, file body (CSV table, safe Markdown with h1–h3, lists, checkboxes, tables, bold/italic/code, or text).
- **Activity:**
  - A small "Agent activity" button at the bottom-left of the sidebar, with a live dot and an unread count. It opens a panel with the timeline: time, a coloured agent chip, the message.
  - Poll `/api/activity` every 3 s. Refresh files when the newest id changes.
- **Upload:**
  - The Upload button, plus drag-and-drop over the whole window with an overlay.
  - Toasts appear bottom-left: "Uploaded 3 files", plus the per-file errors.
- **Responsive:**
  - Below 1000px the sidebar collapses behind a menu button (an off-canvas drawer).
  - Below 640px the list view hides the size and updated columns.
  - No horizontal scroll at 390px.
- **Accessibility:** buttons are real `<button>`s, menus use `role="menu"`, `aria-live` on toasts and on the answer, `:focus-visible` rings, `prefers-reduced-motion` respected.
- **Security:** one `escapeHtml()` is used for every interpolated value. Markdown and CSV rendering escape first. There is no `alert`/`confirm`/`prompt`.
- **Header comment:** keep "IN SIMPLE WORDS" and "DO NOT: insert unescaped text" in `app.js`.

**Verify with a throwaway mock server** in the scratchpad (resolve express from the project's `node_modules`) that serves `public/` and returns contract-shaped JSON. Use realistic Brightleaf data across all 9 kinds. Then:
- take headless screenshots at 1440×900 and 390×844 of:
  - the list view, the grid view and the empty state
  - the drawer open, the selection bar, the command bar answer
  - dark mode (`--force-dark-mode` or emulate)
- look at every screenshot and iterate until it looks polished
- run `node --check public/app.js`
- grep `innerHTML` and confirm every use is escaped

---

### Task 6: Accuracy tuning (after Tasks 1–4)

- **Tune** until all of these hold, by adjusting `src/agents/classifier.js` (patterns, words, weights, thresholds):
  - `node --test test/accuracy.test.js` passes
  - `npm test` stays green
- **Don't overfit.** Never add a file-specific name or phrase. Each change must be a rule a person would agree with, and gets a unit test in `test/classifier.test.js`.
- **Never edit** labels or holdout files to make tests pass. If a label is clearly wrong, report it to the coordinator instead.

### Task 7: Chrome iteration + verification + docs (coordinator)

1. **Start the real server** on a fresh data dir and load the samples. Review the UI with Claude-in-Chrome:
   - widths 1440, 1024 and 390
   - light and dark
   - every interaction: ask, combine, move, topic filter, activity, upload
   - fix what looks off
2. **Verify:**
   - `npm test` is green
   - run the real `data/` migration check by restarting the user's server
3. **Update** README and BRAINSTORMING for the new categories, the mock data and the UI.
4. **Commit.**
