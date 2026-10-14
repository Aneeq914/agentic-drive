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

// Added beyond the plan: backs the header's claims that AI cannot change a CSV's type,
// over-long AI folder names are rejected, and a single keyword hit stays in General.
test('AI cannot override csv->data, long AI folders fall back, one keyword hit is General', async () => {
  const llm = { enabled: () => true, complete: async () => '{"type":"report","folder":"' + 'x'.repeat(31) + '","tags":[],"summary":"s"}' };
  const r = await organize({ name: 'q3-budget.csv', ext: '.csv', text: 'line_item,q3_budget,cost_center\na,1,2' }, { llm });
  assert.equal(r.by, 'ai');
  assert.equal(r.type, 'data');
  assert.equal(r.folder, 'Finance');
  assert.equal(detectFolder('notes.txt', '.txt', 'The app is nice.'), 'General');
});
