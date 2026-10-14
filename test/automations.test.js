import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseInvoice, isOwnCompany, categorize, csvEscape, parseCsvLine, appendExpenseRow, runAutomations, DEFAULT_RULES, EXPENSES_HEADER } from '../src/agents/automations.js';

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
  const r = runAutomations({ record: { name: 'cloudnest.txt', kind: 'invoice', topic: 'Finance', generated: false }, text: cloudnest, rules: DEFAULT_RULES, getFileText: () => null });
  assert.equal(r.writes.length, 1);
  assert.deepEqual([r.writes[0].name, r.writes[0].kind, r.writes[0].topic], ['expenses.csv', 'data', 'Finance']);
  assert.equal('type' in r.writes[0] || 'folder' in r.writes[0], false);
  assert.match(r.logs[0], /INV-1042.*\$1,250\.00.*expenses\.csv/);
});

test('runAutomations: invoice without total logs and writes nothing', () => {
  const r = runAutomations({ record: { name: 'x.txt', kind: 'invoice', topic: 'Finance' }, text: 'INVOICE\nnothing', rules: DEFAULT_RULES, getFileText: () => null });
  assert.equal(r.writes.length, 0);
  assert.match(r.logs[0], /no total/i);
});

test('runAutomations: meeting -> action items file, kind meeting, topic copied from the meeting', () => {
  const text = '# Kickoff\nAttendees: Sara\n## Action Items\n- [ ] Sara will finalise the brief by July 8.';
  const r = runAutomations({ record: { name: 'q3-kickoff.md', kind: 'meeting', topic: 'Marketing' }, text, rules: DEFAULT_RULES, getFileText: () => null });
  assert.equal(r.writes[0].name, 'q3-kickoff - action items.md');
  assert.deepEqual([r.writes[0].kind, r.writes[0].topic], ['meeting', 'Marketing']);
  const noTopic = runAutomations({ record: { name: 'sync.md', kind: 'meeting', topic: null }, text, rules: DEFAULT_RULES, getFileText: () => null });
  assert.equal(noTopic.writes[0].topic, null);
  assert.match(r.writes[0].content, /- \[ \] Sara will finalise the brief by July 8\./);
});

test('runAutomations respects disabled rules and skips generated files', () => {
  const off = DEFAULT_RULES.map((r) => ({ ...r, enabled: false }));
  assert.deepEqual(runAutomations({ record: { name: 'a.txt', kind: 'invoice', topic: 'Finance' }, text: cloudnest, rules: off, getFileText: () => null }), { writes: [], logs: [] });
  assert.deepEqual(runAutomations({ record: { name: 'a.txt', kind: 'invoice', topic: 'Finance', generated: true }, text: cloudnest, rules: DEFAULT_RULES, getFileText: () => null }), { writes: [], logs: [] });
});

test('runAutomations keys off kind, not the old type field', () => {
  // An un-migrated record with only `type` must not trigger anything.
  assert.deepEqual(runAutomations({ record: { name: 'a.txt', type: 'invoice', folder: 'Finance' }, text: cloudnest, rules: DEFAULT_RULES, getFileText: () => null }), { writes: [], logs: [] });
  assert.equal(runAutomations({ record: { name: 'a.txt', kind: 'report', topic: 'Finance' }, text: cloudnest, rules: DEFAULT_RULES, getFileText: () => null }).writes.length, 0);
});

test('appendExpenseRow dedupes by source file when the invoice has no number', () => {
  const inv = { vendor: 'Someone', number: '', date: '', total: 5, currency: 'USD', category: 'Other' };
  const first = appendExpenseRow(null, inv, 'no-number.txt');
  assert.equal(first.added, true);
  assert.equal(appendExpenseRow(first.csv, inv, 'no-number.txt').added, false);
  assert.equal(appendExpenseRow(first.csv, inv, 'other.txt').added, true);
});

test('runAutomations: the action-items write carries its own summary; expenses.csv does not', () => {
  const text = '# Kickoff\n## Action Items\n- [ ] Sara will finalise the campaign brief by July 8.\n- [ ] Hina will set up the ad accounts by July 10.\n- [ ] Bilal will draft the newsletter by July 12.';
  const r = runAutomations({ record: { name: 'q3-marketing-kickoff.md', kind: 'meeting', topic: 'Marketing' }, text, rules: DEFAULT_RULES, getFileText: () => null });
  assert.equal(r.writes[0].summary, '3 action items from q3-marketing-kickoff.md — Sara will finalise the campaign brief by July 8.');
  const one = runAutomations({ record: { name: 'sync.md', kind: 'meeting', topic: null }, text: '## Action Items\n- [ ] Omar will send the report.', rules: DEFAULT_RULES, getFileText: () => null });
  assert.equal(one.writes[0].summary, '1 action item from sync.md — Omar will send the report.');
  const long = runAutomations({ record: { name: 'x.md', kind: 'meeting', topic: null }, text: `## Action Items\n- [ ] ${'word '.repeat(80)}`, rules: DEFAULT_RULES, getFileText: () => null });
  assert.ok(long.writes[0].summary.length <= 160);
  const inv = runAutomations({ record: { name: 'cloudnest.txt', kind: 'invoice', topic: 'Finance' }, text: cloudnest, rules: DEFAULT_RULES, getFileText: () => null });
  assert.equal('summary' in inv.writes[0], false);
});

test('isOwnCompany matches the company name ignoring case and legal suffixes', () => {
  assert.equal(isOwnCompany('Brightleaf Labs (Pvt.) Ltd.', 'Brightleaf Labs'), true);
  assert.equal(isOwnCompany('BRIGHTLEAF LABS', 'Brightleaf Labs'), true);
  assert.equal(isOwnCompany('Brightleaf Labs Private Limited', 'brightleaf labs'), true);
  assert.equal(isOwnCompany('Brightleaf Labs Inc.', 'Brightleaf Labs (Pvt.) Ltd.'), true);
  assert.equal(isOwnCompany('Brightleaf Lab Supplies Ltd.', 'Brightleaf Labs'), false);
  assert.equal(isOwnCompany('CloudNest Hosting Ltd.', 'Brightleaf Labs'), false);
  assert.equal(isOwnCompany('Brightleaf Labs', ''), false);
  assert.equal(isOwnCompany('', 'Brightleaf Labs'), false);
});

test('runAutomations: an invoice the company sent is not logged as an expense', () => {
  const sent = 'INVOICE\nFrom: Brightleaf Labs (Pvt.) Ltd.\nBill To: Northwind Health\nInvoice Number: INV-0912\nDiscovery workshops\nTotal Due: $10,800.00';
  const r = runAutomations({ record: { name: 'inv-0912.md', kind: 'invoice', topic: 'Finance' }, text: sent, rules: DEFAULT_RULES, getFileText: () => null, ownCompany: 'Brightleaf Labs' });
  assert.deepEqual(r.writes, []);
  assert.deepEqual(r.logs, ['INV-0912 is an invoice you sent (from Brightleaf Labs), so it was not logged as an expense.']);
  // Without an own company set, it is logged as before.
  const legacy = runAutomations({ record: { name: 'inv-0912.md', kind: 'invoice', topic: 'Finance' }, text: sent, rules: DEFAULT_RULES, getFileText: () => null });
  assert.equal(legacy.writes.length, 1);
  // A supplier's invoice is still logged when the own company is set.
  const bought = runAutomations({ record: { name: 'cloudnest.txt', kind: 'invoice', topic: 'Finance' }, text: cloudnest, rules: DEFAULT_RULES, getFileText: () => null, ownCompany: 'Brightleaf Labs' });
  assert.equal(bought.writes[0].name, 'expenses.csv');
});
