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

test('runner-up is only suggested when it has some evidence', () => {
  // Plan code returned runnerUp 'invoice' (score 0) for this note, which would make the UI ask "Looks like an invoice?".
  assert.equal(k('Remember to water the plants on Friday.', 'note.txt').runnerUp, null);
  const r = k('# Q3 Customer Churn Report\n## Executive Summary\nChurn fell 2 points.\n## Key Findings\n- Onboarding drives retention', 'churn-report.md', '.md');
  assert.equal(r.kind, 'report');
  assert.ok(r.runnerUp === null || r.scores[r.runnerUp] > 0);
});

test('invoice labels only count at the start of a line, not mid-sentence', () => {
  assert.notEqual(k('We noted the total due was $40.00 and the bill to them was late.', 'n.txt').kind, 'invoice');
  assert.equal(k('Total due: $40.00\nBill to: Acme', 'n.txt').kind, 'invoice');
});

// ── Task 6 accuracy rules: each test uses a new short text, not a holdout file. ──

test('a Statement of Work with a signature block is a contract, even with deliverables', () => {
  const t = '# Statement of Work 3\nThis SOW is entered into between Lumen Co ("Client") and Pixelworks ("Vendor").\n## Services\nVendor will build two landing pages.\n## Deliverables\n- Landing pages\nSigned for Client: ________';
  assert.equal(k(t, 'work-order.md', '.md').kind, 'contract');
});

test('a cover letter is people', () => {
  const t = 'Dear Hiring Manager,\nI am excited to apply for the Junior Accountant position at Ferncliff.\nI have attached my resume and two references.\nBest wishes,\nLee Park';
  assert.equal(k(t, 'letter.txt').kind, 'people');
});

test('a job ad with role / candidate / benefits sections is people', () => {
  const t = 'Warehouse Lead\nAbout the role\nKeep the night shift on schedule.\nYou will\n- run the pick team\nYou have\n- 3 years in a warehouse\nWe offer a fair salary and private health insurance.';
  assert.equal(k(t, 'posting.txt').kind, 'people');
});

test('an incident review (what happened / root cause) is a report', () => {
  const t = '# Outage on 2 May\n## What happened\nThe login service returned errors for 20 minutes.\n## Root cause\nAn expired TLS certificate.\n## Follow-ups\n- Automate certificate renewal';
  assert.equal(k(t, 'may-outage.md', '.md').kind, 'report');
});

test('an RFC (status, alternatives considered, open questions) is a spec, not a proposal', () => {
  const t = 'Move image resizing to a worker queue\nStatus: Proposed\nBackground\nResizing blocks web requests.\nProposal\nPush resize jobs to a queue.\nAlternatives considered\nA bigger web server.\nOpen questions\nWho owns the queue?';
  assert.equal(k(t, 'image-queue.txt').kind, 'spec');
});

test('a project plan (status, milestone table with owners, risks) is a spec', () => {
  const t = '# Warehouse relocation\nStatus: In progress\n## Goals\n- Move without downtime\n| Milestone | Owner | Target date |\n|---|---|---|\n| Sign lease | Ana | Mar 1 |\n## Risks\n- Movers may be late';
  assert.equal(k(t, 'relocation.md', '.md').kind, 'spec');
});

test('an article with a byline and reading time is a report, even when it is about invoices', () => {
  const t = '# Why we stopped chasing invoices by hand\n*By Ravi Menon · 5 min read*\nEvery invoice we sent was paid 40 days late. Invoice reminders were manual and the payment due dates slipped.';
  const r = k(t, 'stop-chasing.md', '.md');
  assert.equal(r.kind, 'report');
  assert.notEqual(r.kind, 'invoice');
});

test('a byline far down the page does not make a report', () => {
  const t = `Remember to water the plants on Friday.\n${'x '.repeat(200)}\nBy Friday Morning we should be done.`;
  assert.equal(k(t, 'note.txt').scores.report, 0);
});

test('a pitch email with what is included and a budget is a proposal, not an invoice', () => {
  const t = "Subject: Summer menu launch idea\nHi Jo,\nHere is how we would run the launch.\nWhat's included:\n- 6 photos\n- a flyer\nBudget: about $4,000. Happy to send a formal quote.";
  const r = k(t, 'launch.txt');
  assert.equal(r.kind, 'proposal');
});

test('topic: a proposal prepared for a client is Sales; an internal proposal is scored by keywords', () => {
  const client = '# Proposal: Data dashboard\nPrepared for: Kim Lee, Ops Director, Rivet Co\n## What we propose\nA product analytics dashboard with UX research and design.';
  assert.equal(classifyTopic({ name: 'dashboard.md', ext: '.md', text: client }, 'proposal'), 'Sales');
  assert.equal(classifyTopic({ name: 'idea.md', ext: '.md', text: '# Proposal\nA product feature with UX research and design.' }, 'proposal'), 'Product');
  // "Prepared for:" only means "client quote" on a proposal, not on a report.
  assert.equal(classifyTopic({ name: 'r.md', ext: '.md', text: 'Prepared for: the board\ncampaign brand social ads' }, 'report'), 'Marketing');
});

test('topic: incident and hackathon vocabulary is Engineering; office moves are Operations', () => {
  assert.equal(classifyTopic({ name: 'postmortem.md', ext: '.md', text: 'The incident: a config change caused an outage; rollback on kubernetes; payment errors.' }, 'report'), 'Engineering');
  assert.equal(classifyTopic({ name: 'build-day.md', ext: '.md', text: 'Hackathon: build a prototype with any stack; an invoice demo is fine.' }, 'proposal'), 'Engineering');
  assert.equal(classifyTopic({ name: 'move.md', ext: '.md', text: 'Office relocation: furniture, movers, new premises, budget.' }, 'spec'), 'Operations');
});
