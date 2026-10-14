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
