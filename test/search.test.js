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

test('answerOffline strips list and checkbox markers from answer lines', () => {
  const notes = [{ id: 'n', name: 'notes.md', ext: '.md', text: '## Action Items\n- [ ] Sara will finalise the campaign brief by July 8.\n- Bilal owns the newsletter.' }];
  const r = answerOffline('Who will finalise the campaign brief?', notes);
  assert.equal(r.answer, '• Sara will finalise the campaign brief by July 8. [1]');
});

// ── A small office drive written inline: invoices, meetings, a contract, an NDA, a spec, a CSV,
// a job ad, a report and a PDF resume. Several files are decoys for each question (other
// amounts, other "terms", "spent" lines, the same names), so these tests check ranking, not lookup. ──
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractText } from '../src/extract.js';
import { makePdf, RESUME } from './helpers/pdf.js';

const DRIVE_TEXTS = {
  'invoice-skyway-travel-INV-2207.txt': `SKYWAY TRAVEL AGENCY
Invoice

Vendor: Skyway Travel Agency
Invoice #: INV-2207
Date: 2026-08-02
Bill To: Agentic Drive Team

Return flight Karachi - Dubai (trade show), 1 traveller    $612.40
Hotel, 2 nights                                            $230.20
Total: $842.60`,
  'invoice-cloudnest-INV-1042.txt': `INVOICE

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

Payment terms: Net 15. Thank you for your business.`,
  'q3-budget.csv': `line_item,department,q3_budget,spent_to_date,remaining,cost_center
Paid social ads,Marketing,60000,41200,18800,MKT-01
Content and influencers,Marketing,35000,23300,11700,MKT-02
Events,Marketing,25000,0,25000,MKT-03
Cloud hosting,Engineering,12000,11250,750,ENG-01
Recruiting fees,HR,8000,6500,1500,HR-01
Legal review,Legal,5000,2000,3000,LEG-01`,
  'mobile-app-v2-spec.md': `# Mobile App v2 — Engineering Spec

Owner: Engineering team
Status: Draft

## Goal
Rebuild the mobile app so files sync faster and work offline.

## Requirements
- The app must sync a 10 MB file in under 5 seconds on 4G.
- Users must be able to open recent files without an internet connection.
- The backend API should return search results in under 300 ms.
- We need to support both Android and iOS from one codebase.

## Architecture
The frontend will use React Native. The backend API will run on Node.js with a PostgreSQL database. Files are stored in object storage and cached on the device.

## Release plan
Beta release to internal testers in sprint 14; public release in sprint 16.`,
  'q3-marketing-kickoff.md': `# Q3 Marketing Kickoff — Meeting Minutes

Date: 2026-07-02
Attendees: Sara Khan (Marketing Lead), Bilal Ahmed (Content), Hina Raza (Paid Media), Omar Siddiqui (Finance)

## Discussion
The team reviewed the Q3 marketing goals: grow newsletter sign-ups by 25% and launch the "Summer Switch" campaign across social channels.
The total Q3 marketing budget was approved at $120,000.
The budget is split into $60,000 for paid social ads, $35,000 for content and influencer marketing, and $25,000 for events.

## Action Items
- [ ] Sara will finalise the campaign brief by July 8.
- [ ] Hina will set up the paid social ad accounts by July 10.`,
  'q3-marketing-midpoint-review.md': `# Q3 Marketing Mid-Point Review — Meeting Minutes

Date: 2026-08-14

## Discussion
So far we have spent $64,500 of the $120,000 Q3 marketing budget.
TikTok ads cost less per sign-up than Instagram ads, so paid social spend should move toward TikTok.
Events spending is behind plan because one trade show was cancelled.

## Decisions
- We agreed to move $10,000 from the events budget to TikTok ads.`,
  'q3-board-update-meeting.md': `# Q3 2026 Board Update — Meeting Minutes

Date: 2026-09-24
Present: Ayesha Malik (CEO, chair), Omar Siddiqui (Finance), Tariq Mehmood (Board member)

## Agenda
1. Q3 financial results
2. Clients, pipeline and churn
3. Headcount, hiring and the office move

## Discussion
**1. Financials.** Q3 revenue is forecast at $182,400 against a plan of $170,000 (+7.3%). Retainers brought in $107,350 and project work $75,050. Gross margin is 46%. The cash balance on Sep 23 was $78,900 after Acme Retail paid the overdue INV-0861 ($7,200) and the redesign deposit INV-0897 ($14,400). Two invoices are still open: INV-0912 to Northwind Health ($10,800, due Oct 15) and the Acme design milestone INV-0921 ($19,200, due Oct 21).

**2. Clients.** Two retainer clients left in Q3, Saffron Foods and Pixelport Games, taking $5,100 of monthly recurring revenue with them. Tariq asked for the root causes, and Ayesha pointed to the Q3 customer churn report.

**3. People and office.** We are 14 people today. We plan to hire a Senior Backend Engineer and a second Product Designer. The move to the Gulberg office finished on Aug 29 at a cost of $9,870, under the $10,500 budget.

## Decisions
- The board approved both new hires, with a combined salary budget of up to $5,200 per month.
- The Q4 marketing budget of $90,000 was approved in principle.`,
  'q3-customer-churn-report.md': `# Q3 2026 Customer Churn Report — Retainer Clients

Prepared by: Saad Mirza (Account Manager)
Date: 2026-10-02

## Summary
Two of our nine retainer clients left in Q3. Logo churn was 22.2% and gross revenue churn was 13.3%, the worst quarter since we started retainers in 2024. Project revenue (Acme Retail, Northwind Health) made up for the loss in total revenue. Retainers, though, are our steadiest income, and the warning signs for both losses were visible weeks in advance.

## Key numbers
| Metric | Start of Q3 | End of Q3 | Change |
|---|---|---|---|
| Retainer clients | 9 | 7 | −2 |
| Monthly recurring revenue (MRR) | $38,400 | $33,300 | −$5,100 |

Retainer revenue recognised in Q3 was $107,350, against $115,200 if no client had left.`,
  'website-analytics-september.md': `# Website Analytics — September 2026

Prepared by: Bilal Ahmed (Content)
Date: 2026-10-03

## Headline numbers
| Metric | August | September | Change |
|---|---|---|---|
| Sessions | 16,446 | 18,420 | +12.0% |
| Users | 11,905 | 12,870 | +8.1% |
| Newsletter sign-ups (from the site) | 702 | 640 | −8.8% |

58% of sessions were on mobile, up from 55% in August.

## Traffic sources (September)
| Channel | Sessions | Share |
|---|---|---|
| Organic search | 7,552 | 41% |
| Direct | 4,052 | 22% |`,
  'nda-northwind-health.txt': `MUTUAL NON-DISCLOSURE AGREEMENT

Reference: BL-NDA-2026-012
Effective Date: 2026-07-14

PARTIES
(1) Brightleaf Labs (Pvt.) Ltd., Office 3, Level 2, DHA Phase 5, Lahore, Pakistan ("Brightleaf"); and
(2) Northwind Health (Pvt.) Ltd., 9 Jail Road, Lahore, Pakistan ("Northwind").

PURPOSE
The parties want to discuss a possible project in which Brightleaf designs and builds a patient-facing mobile app for Northwind's clinics (the "Purpose").

5. TERM
This Agreement lasts two (2) years from the Effective Date. Each party's confidentiality obligations continue for three (3) years after any disclosure.

6. RETURN OF MATERIALS
When asked, the receiving party will return or destroy all Confidential Information within 14 days and confirm this in writing.`,
  'office-move-project-plan.md': `# Office Move — Project Plan

Owner: Usman Tariq (Ops & HR)
Status: Complete (closed 2026-09-04)

## Goals
- Move with no more than one lost working day.
- Keep the total budget at or under $10,500.

## Budget
| Item | Budget | Actual |
|---|---|---|
| Furniture: 14 ergonomic chairs and 2 standing desks | $3,800 | $3,664.50 |
| Movers and packing | $600 | $450.00 |
| **Total** | **$10,500** | **$9,870.00** |

## Lessons learned
- Order internet first. The second ISP took 26 days.
- Total spend came in $630 under budget, mostly because the movers and the networking cost less than quoted.`,
  'job-description-senior-backend-engineer.md': `# Job Description: Senior Backend Engineer

**Company:** Brightleaf Labs, a 14-person product studio
**Location:** Lahore, Gulberg III (hybrid: Tuesday to Thursday in the office)
**Reports to:** Daniyal Qureshi, Engineering Lead
**Salary range:** PKR 650,000 – 850,000 per month, plus an annual bonus of up to 10%
**Posted:** 2026-09-08 · **Apply by:** 2026-10-09

## The role
You will be the third backend engineer on a team of six. In your first six months you will lead the backend of a patient-facing mobile app for a healthcare client.

## Benefits
- 24 days of paid leave plus public holidays
- An annual learning budget of PKR 150,000`,
  'acme-retail-kickoff-call.md': `# Acme Retail Website Redesign — Kickoff Call Notes

Date: 2026-08-11 (Tuesday, 15:00–16:15, video call)
Notes by: Zara Sheikh

## Discussion
Laura opened by saying the redesign is Acme's top digital priority for the year and has to be live before Black Friday.

Kamran shared numbers from the current site: 62% of traffic is on mobile, but mobile converts at 1.4% compared with 2.9% on desktop.

## Decisions
- Go-live date: 2026-11-20, one week before Black Friday.
- Success metric: mobile conversion of 2.2% or more by the end of Q1 2027.
- Design sign-off: Sep 18. Content freeze: Nov 6.`,
  'internal-hackathon-brief.md': `# Brightleaf Build Day 2026 — Problem Statement

**Event:** Brightleaf Build Day (internal hackathon)
**When:** Friday 2026-09-18, 09:00–19:00, Gulberg office

## The problem
Our shared drive is a junk drawer. Proposals, contracts, meeting notes, receipts and CSV exports all land in one folder.

**Challenge:** build a prototype of an *agentic drive*: a file store where AI agents read every upload.

## Judging (100 points)
| Criterion | Points |
|---|---|
| Usefulness to a real studio like ours | 35 |
| Does it actually work in the live demo? | 30 |

## Prizes
First place gets PKR 50,000 and a day off. Every team gets dinner. The winning prototype may become a Q4 internal tool.`,
  'acme-retail-msa.md': `# Master Services Agreement

**Agreement No.:** BL-MSA-2026-007
**Effective Date:** 2026-08-04

This Master Services Agreement (the "Agreement") is between **Brightleaf Labs (Pvt.) Ltd.** ("Brightleaf"), and **Acme Retail Ltd.** ("Client").

## 2. Fees and Payment Terms
2.1 Fees for SOW-01 are fixed at **$48,000** (forty-eight thousand US dollars) and are invoiced in milestones.
2.2 Brightleaf invoices each milestone when it is reached. Payment is due **thirty (30) days** after the invoice date (Net 30), by bank transfer to the account stated on the invoice.
2.3 Overdue amounts carry a late fee of **1.5% per month**.

## 4. Confidentiality
Each Party will keep the other's confidential information secret during this Agreement and for three (3) years after it ends.`,
};

let drivePromise;
const loadDrive = () => (drivePromise ??= (async () => {
  const docs = Object.entries(DRIVE_TEXTS).map(([name, text]) => ({ id: name, name, ext: path.extname(name), text }));
  const resume = 'resume-priya-nair-product-designer.pdf';
  docs.push({ id: resume, name: resume, ext: '.pdf', text: await extractText(await makePdf(RESUME), resume) });
  return docs;
})());

test('money question answers with the invoice total and drops weak matches', async () => {
  const r = answerOffline('How much did we spend on travel?', await loadDrive());
  assert.match(r.answer.split('\n')[0], /Total: \$842\.60/);
  assert.deepEqual(r.citations.map((c) => c.fileName), ['invoice-skyway-travel-INV-2207.txt']);
});

test('csv rows are answered as readable "column: value" lines, never the header', async () => {
  const r = answerOffline('How much did hosting cost?', await loadDrive());
  assert.match(r.answer, /Cloud hosting — department: Engineering, q3_budget: 12000/);
  assert.doesNotMatch(r.answer, /line_item,department/);
});

test('headings are not used as answers when a real sentence matches', async () => {
  const r = answerOffline('What must the mobile app do offline?', await loadDrive());
  assert.match(r.answer.split('\n')[0], /^• Rebuild the mobile app so files sync faster and work offline\. \[1\]$/);
  assert.ok(r.citations.every((c) => c.fileName === 'mobile-app-v2-spec.md'));
  // No answer line is a bare section heading ("## Goal", "## Architecture"…).
  assert.doesNotMatch(r.answer, /^• (Goal|Requirements|Architecture|Release plan)\b/m);
});

test('the same sentence found in two files is answered once', () => {
  const dupDocs = [
    { id: 'a', name: 'kickoff.md', ext: '.md', text: 'Sara will finalise the campaign brief by July 8.' },
    { id: 'b', name: 'kickoff - action items.md', ext: '.md', text: '- [ ] Sara will finalise the campaign brief by July 8.' },
  ];
  const r = answerOffline('Who owns the campaign brief?', [...docs, ...dupDocs]);
  assert.equal(r.answer.split('\n').length, 1);
  assert.equal(r.citations.length, 1);
});

test('a passage matching only a synonym of one question word is not relevant', () => {
  const small = [
    { id: 'chairs', name: 'chairs.md', ext: '.md', text: 'The new chairs cost $500.' },
    { id: 'trip', name: 'trip.md', ext: '.md', text: 'Travel to Dubai for the trade show: $842.60.' },
  ];
  // "cost" is only a synonym of "spend", and nothing else in chairs.md matches.
  assert.deepEqual(rankPassages('How much did we spend on travel?', [...docs, ...small]).map((r) => r.passage.fileId), ['trip']);
});

test('answers about another named thing are dropped ("Acme" terms, not any invoice\'s terms)', () => {
  const small = [
    { id: 'msa', name: 'acme-msa.md', ext: '.md', text: '## Fees\nPayment is due 30 days after the invoice date (Net 30).' },
    { id: 'inv', name: 'cloudnest-invoice.txt', ext: '.txt', text: 'Total Due: $1,250.00\nPayment terms: Net 15.' },
  ];
  const r = answerOffline('What are the Acme payment terms?', [...docs, ...small]);
  assert.match(r.answer, /Net 30/);
  assert.deepEqual(r.citations.map((c) => c.fileId), ['msa']);
});

test('markdown table rows are read back as "row — column: value" lines', () => {
  const small = [{ id: 'w', name: 'analytics.md', ext: '.md', text: '## Headline numbers\n| Metric | August | September |\n|---|---|---|\n| Sessions | 16,446 | 18,420 |\n| Users | 11,905 | 12,870 |' }];
  const r = answerOffline('How many sessions did the website get in September?', [...docs, ...small]);
  assert.equal(r.answer, '• Sessions — August: 16,446, September: 18,420 [1]');
});

test('office drive: each question gets its fact first, from the right file', async () => {
  const drive = await loadDrive();
  const cases = [
    ['What was Q3 revenue?', /\$182,400/, 'q3-board-update-meeting.md'],
    ['How many sessions did the website get in September?', /September: 18,420/, 'website-analytics-september.md'],
    ['How long does the Northwind NDA last?', /two \(2\) years/, 'nda-northwind-health.txt'],
    ['How much did the office move cost?', /\$9,870/, 'q3-board-update-meeting.md'],
    ['What is the salary range for the senior backend engineer?', /^• Salary range: PKR 650,000 – 850,000 per month/, 'job-description-senior-backend-engineer.md'],
    ['When does the Acme site go live?', /2026-11-20/, 'acme-retail-kickoff-call.md'],
    ['What is the Build Day prize?', /First place gets PKR 50,000/, 'internal-hackathon-brief.md'],
  ];
  for (const [q, fact, file] of cases) {
    const r = answerOffline(q, drive);
    assert.match(r.answer.split('\n')[0], fact, q);
    assert.equal(r.citations[0].fileName, file, q);
  }
});

test('office drive: no noise citations for single-source facts', async () => {
  const drive = await loadDrive();
  for (const [q, file] of [
    ['How long does the Northwind NDA last?', 'nda-northwind-health.txt'],
    ['How much was the CloudNest invoice?', 'invoice-cloudnest-INV-1042.txt'],
  ]) assert.deepEqual(answerOffline(q, drive).citations.map((c) => c.fileName), [file], q);
  const terms = answerOffline('What are the Acme payment terms?', drive);
  assert.match(terms.answer, /Net 30/);
  assert.ok(terms.citations.every((c) => c.fileName === 'acme-retail-msa.md'), terms.answer);
});

test('a name that no file mentions is NOT_FOUND, not another vendor\'s amount', async () => {
  assert.deepEqual(answerOffline('How much did we pay Stripe?', await loadDrive()), { answer: NOT_FOUND, citations: [] });
});

test('answers stay put when ~35 unrelated holdout files are added to the drive', async () => {
  const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
  const extra = await Promise.all(['holdout', 'holdout-2'].flatMap((dir) => fs.readdirSync(path.join(fixtures, dir))
    .filter((name) => /\.(md|txt)$/.test(name))
    .map(async (name) => ({ id: `${dir}/${name}`, name, ext: path.extname(name), text: await extractText(fs.readFileSync(path.join(fixtures, dir, name)), name) }))));
  const drive = [...await loadDrive(), ...extra];
  const travel = answerOffline('How much did we spend on travel?', drive);
  assert.match(travel.answer.split('\n')[0], /Total: \$842\.60/);
  assert.deepEqual(travel.citations.map((c) => c.fileName), ['invoice-skyway-travel-INV-2207.txt']);
  assert.match(answerOffline('What was Q3 revenue?', drive).answer.split('\n')[0], /\$182,400/);
  assert.match(answerOffline('What was the Q3 marketing budget?', drive).answer.split('\n')[0], /\$120,000/);
});

test('a long paragraph is split at line breaks, never glued into one line', () => {
  const lines = Array.from({ length: 40 }, (_, i) => `Line ${i} has a few words`);
  const p = buildPassages([{ id: 'r', name: 'resume.pdf', ext: '.pdf', text: lines.join('\n') }]);
  assert.ok(p.length > 1);
  assert.deepEqual(p.flatMap((x) => x.text.split('\n')), lines);
});

test('office drive: a name heading picked as the answer reads on into the line below it', async () => {
  const r = answerOffline('Who is Priya Nair?', await loadDrive());
  assert.match(r.answer.split('\n')[0], /^• Priya Nair — Product Designer/);
  assert.ok(r.citations.every((c) => c.fileName === 'resume-priya-nair-product-designer.pdf'));
});

test('citation snippets read as plain text: no heading, bullet, checkbox, table or bold/code marks', () => {
  const md = [{ id: 'm', name: 'kickoff.md', ext: '.md', text: '## Discussion\nThe team reviewed the **Q3** launch goals and the `budget` plan.\n- [ ] Sara will finalise the launch brief.\n* Hina owns the *launch* ads.\n| Item | Cost |\n|---|---|\n| Launch ads | $5,000 |' }];
  const r = answerOffline('What did the team review for the launch?', md);
  assert.equal(r.citations.length, 1);
  const s = r.citations[0].snippet;
  assert.doesNotMatch(s, /#|\||\*|`|\[ \]|---|^- /);
  assert.match(s, /^Discussion — The team reviewed the Q3 launch goals and the budget plan\. Sara will finalise the launch brief\. Hina owns the launch ads\./);
  // Rows and unpunctuated bullets are kept apart with "; " instead of running together.
  assert.match(s, /Item · Cost; Launch ads · \$5,000/);
  const figures = answerOffline('What are the launch figures?', [{ id: 'f', name: 'figures.md', ext: '.md', text: '## Launch figures\n- $120,000 launch budget (kickoff.md)\n- $60,000 launch ads (kickoff.md)\n\n**5. Launch.** Ayesha presented the launch figures.' }]);
  assert.match(figures.citations[0].snippet, /^Launch figures — \$120,000 launch budget \(kickoff\.md\); \$60,000 launch ads \(kickoff\.md\); Launch\. Ayesha presented/);
  // The answer text itself is unchanged by snippet cleaning.
  assert.match(r.answer, /The team reviewed the Q3 launch goals and the budget plan\./);
  // CSV snippets are left as they are.
  const csv = answerOffline('What was the Q3 budget for item 3?', docs.filter((d) => d.ext === '.csv')).citations[0];
  assert.match(csv.snippet, /^line_item,department,q3_budget\nItem 0,Dept,0/);
});
