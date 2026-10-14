import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as organizer from '../src/agents/organizer.js';

const { organizeOffline, organize, offlineSummary } = organizer;

const invoice = 'INVOICE\nFrom: CloudNest\nInvoice Number: INV-1042\nCloud hosting subscription $1,000.00\nTotal Due: $1,250.00';
const meeting = '# Q3 Marketing Kickoff\nAttendees: Sara\n## Agenda\nCampaign plan and social ads launch for the marketing team.';

test('the old type/folder API is gone', () => {
  for (const old of ['TYPES', 'TOPICS', 'detectType', 'detectFolder']) assert.equal(old in organizer, false, old);
});

test('organizeOffline: invoice gets kind invoice, forced topic Finance, tags + summary', () => {
  const r = organizeOffline({ name: 'inv.txt', ext: '.txt', text: invoice });
  assert.equal(r.kind, 'invoice');
  assert.equal(r.topic, 'Finance');
  assert.ok(['high', 'medium'].includes(r.confidence));
  assert.ok(r.tags.includes('invoice') && r.tags.includes('finance'));
  assert.ok(r.tags.length <= 7);
  assert.equal(new Set(r.tags).size, r.tags.length);
  assert.ok(r.summary.length > 0);
  assert.equal('type' in r || 'folder' in r, false);
});

test('organizeOffline: meeting notes -> meeting / Marketing; csv -> data with high confidence', () => {
  const m = organizeOffline({ name: 'kickoff.md', ext: '.md', text: meeting });
  assert.deepEqual([m.kind, m.topic], ['meeting', 'Marketing']);
  const c = organizeOffline({ name: 'q3-budget.csv', ext: '.csv', text: 'line_item,department,q3_budget,cost_center\nPaid social ads,Marketing,1,2\nInfluencer campaign,Marketing,3,4' });
  assert.deepEqual([c.kind, c.topic, c.confidence], ['data', 'Finance', 'high']);
});

test('a brief that talks about invoices is not filed as an invoice', () => {
  const brief = '# Hackathon Brief\n## Problem Statement\nTeams lose hours matching every invoice to a payment. Build an agent that reads an invoice, finds the amount due and total, and files it.\n## Deliverables\nA working demo.\n## Judging Criteria\nImpact and polish.';
  const r = organizeOffline({ name: 'brief.txt', ext: '.txt', text: brief });
  assert.notEqual(r.kind, 'invoice');
});

test('empty text goes to other / no topic / low, with the no-readable-text summary', () => {
  const r = organizeOffline({ name: 'scan.pdf', ext: '.pdf', text: '' });
  assert.deepEqual([r.kind, r.topic, r.confidence, r.summary], ['other', null, 'low', '(no readable text)']);
  assert.ok('runnerUp' in r);
});

test('organize uses AI JSON when valid, but keeps the invoice -> Finance rule', async () => {
  const llm = { enabled: () => true, complete: async () => '```json\n{"kind":"invoice","topic":"Legal","tags":["Cloud","hosting"],"summary":"CloudNest hosting bill."}\n```' };
  const r = await organize({ name: 'inv.txt', ext: '.txt', text: invoice }, { llm });
  assert.equal(r.by, 'ai');
  assert.equal(r.kind, 'invoice');
  assert.equal(r.topic, 'Finance');
  assert.equal(r.confidence, 'high');
  assert.deepEqual(r.tags.slice(0, 2), ['cloud', 'hosting']);
  assert.ok(r.tags.includes('invoice'));
  assert.equal(r.summary, 'CloudNest hosting bill.');
});

test('organize: AI kind/topic are validated against the fixed lists', async () => {
  const reply = (obj) => ({ enabled: () => true, complete: async () => JSON.stringify(obj) });
  // Unknown kind and unknown topic -> offline values.
  const bad = await organize({ name: 'kickoff.md', ext: '.md', text: meeting }, { llm: reply({ kind: 'memo', topic: 'Snacks', tags: [], summary: 's' }) });
  assert.deepEqual([bad.by, bad.kind, bad.topic], ['ai', 'meeting', 'Marketing']);
  // Valid kind + null topic are taken as-is.
  const ok = await organize({ name: 'kickoff.md', ext: '.md', text: meeting }, { llm: reply({ kind: 'report', topic: null, tags: [], summary: 's' }) });
  assert.deepEqual([ok.kind, ok.topic], ['report', null]);
  // AI cannot override csv -> data.
  const csv = await organize({ name: 'q3-budget.csv', ext: '.csv', text: 'line_item,q3_budget,cost_center\na,1,2' }, { llm: reply({ kind: 'report', topic: 'Finance', tags: [], summary: 's' }) });
  assert.deepEqual([csv.kind, csv.topic], ['data', 'Finance']);
  // Forced topics apply to an AI-chosen kind too (people -> HR, contract -> Legal).
  const people = await organize({ name: 'x.md', ext: '.md', text: meeting }, { llm: reply({ kind: 'people', topic: 'Marketing', tags: [], summary: 's' }) });
  assert.deepEqual([people.kind, people.topic], ['people', 'HR']);
  const contract = await organize({ name: 'x.md', ext: '.md', text: meeting }, { llm: reply({ kind: 'contract', topic: 'Sales', tags: [], summary: 's' }) });
  assert.deepEqual([contract.kind, contract.topic], ['contract', 'Legal']);
});

test('organize falls back to offline on junk or error, and logs it', async () => {
  const logs = [];
  const log = (agent, m) => logs.push(`${agent}: ${m}`);
  const junk = { enabled: () => true, complete: async () => 'sorry, no JSON' };
  const boom = { enabled: () => true, complete: async () => { throw new Error('rate limited'); } };
  const a = await organize({ name: 'm.md', ext: '.md', text: meeting }, { llm: junk, log });
  assert.deepEqual([a.by, a.kind, a.topic], ['offline', 'meeting', 'Marketing']);
  assert.equal((await organize({ name: 'm.md', ext: '.md', text: meeting }, { llm: boom, log })).by, 'offline');
  assert.equal(logs.length, 2);
  assert.match(logs[1], /rate limited/);
});

test('organize skips AI when disabled or text empty', async () => {
  let called = false;
  const llm = { enabled: () => true, complete: async () => { called = true; return '{}'; } };
  const empty = await organize({ name: 'e.txt', ext: '.txt', text: '' }, { llm });
  assert.equal(called, false);
  assert.deepEqual([empty.by, empty.kind], ['offline', 'other']);
  const off = await organize({ name: 'm.md', ext: '.md', text: meeting }, { llm: { enabled: () => false } });
  assert.equal(off.by, 'offline');
});

test('offline summaries: invoices describe the bill, CSVs describe the table', () => {
  const inv = organizeOffline({ name: 'inv.txt', ext: '.txt', text: invoice });
  assert.equal(inv.summary, 'Invoice INV-1042 from CloudNest for $1,250.00 (Software).');
  assert.equal(offlineSummary('invoice', '.txt', invoice), inv.summary);
  // Not an invoice kind -> no invoice summary, even if the text parses as one.
  assert.doesNotMatch(offlineSummary('report', '.txt', invoice), /^Invoice INV-1042 from/);
  const csv = organizeOffline({ name: 'b.csv', ext: '.csv', text: 'line_item,department,q3_budget\nA,B,1\nC,D,2\n' });
  assert.equal(csv.summary, 'Spreadsheet with 2 rows. Columns: line_item, department, q3_budget.');
});

test('offline summaries: a receipt says "Receipt", ALL-CAPS vendors are title-cased, "(Other)" is left out', () => {
  const receipt = 'CAFE LUMEN\nCoffee - Kitchen - Bakery\nTel: +92 42 3578 1190\n\nSALES RECEIPT\nReceipt No: R-20488\nDate: 2026-09-04\nGrilled chicken bowl   $45.60\nSubtotal   $197.30\nTotal: $207.17';
  assert.equal(offlineSummary('invoice', '.txt', receipt), 'Receipt from Cafe Lumen for $207.17.');
  const caps = 'INVOICE\nFrom: SKYWAY TRAVEL AGENCY\nInvoice Number: INV-2207\nReturn flight Lahore to Dubai\nTotal: $842.60';
  assert.equal(offlineSummary('invoice', '.txt', caps), 'Invoice INV-2207 from Skyway Travel Agency for $842.60 (Travel).');
  const other = 'INVOICE\nFrom: Northwind Consulting\nInvoice Number: INV-0077\nAdvisory services\nTotal: $500.00';
  assert.equal(offlineSummary('invoice', '.txt', other), 'Invoice INV-0077 from Northwind Consulting for $500.00.');
  // An invoice number wins over a stray "receipt" mention: it is still an invoice.
  const numbered = 'INVOICE\nFrom: CloudNest\nInvoice Number: INV-1042\nPlease keep this receipt for your records.\nCloud hosting\nTotal: $1,250.00';
  assert.match(offlineSummary('invoice', '.txt', numbered), /^Invoice INV-1042 from CloudNest for \$1,250\.00/);
});

test('offline summaries: a resume reads "<Name> — <title>", other people files use a real sentence', async () => {
  const resume = 'Priya Nair\nProduct Designer\nDubai, UAE (open to relocating to Lahore) | priya.nair@example.com | +971 50 000 4821 |\nSummary\nProduct designer with 7 years of experience in e-commerce and healthcare apps.';
  assert.equal(offlineSummary('people', '.pdf', resume), 'Priya Nair — Product Designer');
  // The bundled resume PDF, through the real extractor.
  const { extractText } = await import('../src/extract.js');
  const fs = await import('node:fs');
  const name = 'resume-priya-nair-product-designer.pdf';
  const pdfText = await extractText(fs.readFileSync(new URL(`../src/samples/${name}`, import.meta.url)), name);
  assert.equal(organizeOffline({ name, ext: '.pdf', text: pdfText }).summary, 'Priya Nair — Product Designer');
  // A policy or job description is not a name + title.
  const policy = '# Remote and Hybrid Work Policy\n**Policy owner:** Usman Tariq\n\n## 1. Why this policy exists\nSince we moved to the Gulberg office, we have a space built for working together.';
  assert.equal(offlineSummary('people', '.md', policy), 'Since we moved to the Gulberg office, we have a space built for working together.');
  const jd = '# Job Description: Senior Backend Engineer\n**Company:** Brightleaf Labs\n\n## About us\nBrightleaf Labs designs and builds websites and apps for retailers.';
  assert.equal(offlineSummary('people', '.md', jd), 'Brightleaf Labs designs and builds websites and apps for retailers.');
  // Name + title shape only counts for people files.
  assert.notEqual(offlineSummary('report', '.pdf', resume), 'Priya Nair — Product Designer');
});
