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
