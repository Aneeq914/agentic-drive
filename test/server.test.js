import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp, sampleDate } from '../server.js';
import { createLlm } from '../src/llm.js';

const here = path.dirname(fileURLToPath(import.meta.url));
let server;
let base;
let dataDir;

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drive-srv-'));
  const app = createApp({ dataDir, llm: createLlm({}), samplesDir: path.join(here, '..', 'src', 'samples') });
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const json = async (p, opts = {}, at = base) => {
  const res = await fetch(at + p, { ...opts, headers: { 'content-type': 'application/json', ...(opts.headers || {}) } });
  return { status: res.status, body: await res.json() };
};
const upload = async (files, at = base) => {
  const fd = new FormData();
  for (const [name, content] of files) fd.append('files', new Blob([content]), name);
  const res = await fetch(`${at}/api/upload`, { method: 'POST', body: fd });
  return { status: res.status, body: await res.json() };
};
const byName = async (name, at = base) => (await json('/api/files', {}, at)).body.files.find((f) => f.name === name);
// A second, independent app (e.g. "after a restart" on the same dataDir).
async function startApp(dir) {
  const app = createApp({ dataDir: dir, llm: createLlm({}), samplesDir: path.join(here, '..', 'src', 'samples') });
  const srv = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  return { at: `http://127.0.0.1:${srv.address().port}`, close: () => srv.close() };
}

test('status is offline without keys', async () => {
  assert.deepEqual((await json('/api/status')).body, { aiProvider: null, model: null });
});

test('samples load and every agent result is visible', async () => {
  const r = await json('/api/samples', { method: 'POST' });
  assert.equal(r.status, 200);
  // Other samples may be added over time, so assert on known files, not on counts.
  const expected = {
    'q3-marketing-kickoff.md': ['meeting', 'Marketing'],
    'q3-marketing-midpoint-review.md': ['meeting', 'Marketing'],
    'q3-marketing-wrapup.md': ['meeting', 'Marketing'],
    'invoice-cloudnest-INV-1042.txt': ['invoice', 'Finance'],
    'invoice-skyway-travel-INV-2207.txt': ['invoice', 'Finance'],
    'invoice-printhub-INV-3310.pdf': ['invoice', 'Finance'],
    'q3-budget.csv': ['data', 'Finance'],
    'mobile-app-v2-spec.md': ['spec', 'Engineering'],
  };
  for (const name of Object.keys(expected)) assert.ok(r.body.loaded.includes(name), `${name} not loaded`);
  for (const [name, [kind, topic]] of Object.entries(expected)) {
    const f = await byName(name);
    assert.ok(f, `${name} missing`);
    assert.deepEqual([f.kind, f.topic], [kind, topic], name);
  }
  for (const f of (await json('/api/files')).body.files) {
    assert.equal('type' in f || 'folder' in f, false, `${f.name} still has type/folder`);
    assert.equal(typeof f.pinned, 'boolean', f.name);
    assert.ok(['high', 'medium', 'low'].includes(f.confidence), f.name);
  }
  const csv = await byName('expenses.csv');
  assert.deepEqual([csv.kind, csv.topic, csv.generated, csv.pinned], ['data', 'Finance', true, false]);
  const text = (await json(`/api/files/${csv.id}`)).body.text;
  assert.match(text, /INV-1042.*1250\.00/);
  assert.match(text, /INV-2207.*Travel,842\.60/);
  assert.match(text, /INV-3310.*Marketing,3480\.00/);
  const items = await byName('q3-marketing-kickoff - action items.md');
  assert.ok(items);
  assert.deepEqual([items.kind, items.topic, items.generated], ['meeting', 'Marketing', true]);
  const act = (await json('/api/activity')).body.activity;
  assert.ok(act.some((a) => a.agent === 'Organizer' && /^Filed "mobile-app-v2-spec\.md" under Specs & Plans \(topic: Engineering, confidence: (high|medium)\)\.$/.test(a.message)));
  const again = await json('/api/samples', { method: 'POST' });
  for (const name of r.body.loaded) assert.ok(again.body.skipped.includes(name), `${name} was loaded twice`);
});

test('a file the classifier cannot place goes to Other with a "not sure" note', async () => {
  const r = await upload([['plant.txt', 'Water the fern on Tuesdays.']]);
  const f = r.body.files[0];
  assert.deepEqual([f.kind, f.topic, f.confidence, f.pinned], ['other', null, 'low', false]);
  const act = (await json('/api/activity')).body.activity;
  const line = act.find((a) => a.message.startsWith('Filed "plant.txt"'));
  assert.match(line.message, /^Filed "plant\.txt" under Other \(topic: none, confidence: low\) — not sure/);
  assert.match(line.message, /Use "Move to…" if it's wrong\.$/);
});

test('GET /api/meta lists the 9 kinds in order and the 8 topics', async () => {
  const r = await json('/api/meta');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.kinds.map((k) => k.id), ['invoice', 'meeting', 'contract', 'proposal', 'spec', 'report', 'data', 'people', 'other']);
  assert.deepEqual(r.body.kinds[0], { id: 'invoice', label: 'Invoices & Receipts' });
  assert.equal(r.body.kinds[8].label, 'Other');
  assert.deepEqual(r.body.topics, ['Finance', 'Marketing', 'Engineering', 'Sales', 'HR', 'Legal', 'Operations', 'Product']);
});

test('ask answers the Q3 budget with a citation', async () => {
  const r = await json('/api/ask', { method: 'POST', body: JSON.stringify({ question: 'What was the Q3 marketing budget?' }) });
  assert.equal(r.status, 200);
  assert.match(r.body.answer, /\$120,000/);
  assert.ok(r.body.citations.some((c) => c.fileName === 'q3-marketing-kickoff.md'));
  assert.equal((await json('/api/ask', { method: 'POST', body: JSON.stringify({ question: '' }) })).status, 400);
});

test('synthesize creates a generated report with the sources\' most common topic', async () => {
  const ids = await Promise.all(['q3-marketing-kickoff.md', 'q3-marketing-midpoint-review.md', 'q3-marketing-wrapup.md'].map(async (n) => (await byName(n)).id));
  const r = await json('/api/synthesize', { method: 'POST', body: JSON.stringify({ fileIds: ids, format: 'requirements' }) });
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.kind, r.body.topic, r.body.generated, r.body.pinned, r.body.confidence], ['report', 'Marketing', true, false, 'high']);
  assert.equal('folder' in r.body || 'type' in r.body, false);
  // A useful summary, not the "Generated by the Synthesizer agent…" boilerplate line.
  assert.match(r.body.summary, /^Unified requirements from kickoff, midpoint review and wrapup \(3 files\): \d+ requirements?, \d+ decisions?, \d+ action items?\.$/);
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

test('PATCH moves and pins a file; it survives a restart; bad input is a 400 and changes nothing', async () => {
  const spec = await byName('mobile-app-v2-spec.md');
  const patch = (id, body) => json(`/api/files/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
  const moved = await patch(spec.id, { kind: 'report' });
  assert.equal(moved.status, 200);
  assert.deepEqual([moved.body.kind, moved.body.topic, moved.body.pinned, moved.body.confidence], ['report', 'Engineering', true, 'high']);
  const act = (await json('/api/activity')).body.activity;
  assert.ok(act.some((a) => a.agent === 'Drive' && a.message === 'Moved "mobile-app-v2-spec.md" to Reports (pinned by you).'));
  const retopic = await patch(spec.id, { topic: null });
  assert.deepEqual([retopic.status, retopic.body.kind, retopic.body.topic], [200, 'report', null]);

  for (const body of [{ kind: 'memo' }, { topic: 'Snacks' }, { kind: 'report', topic: 'Snacks' }, {}, [], { pinned: false }]) {
    const bad = await patch(spec.id, body);
    assert.equal(bad.status, 400, JSON.stringify(body));
    assert.ok(bad.body.error);
  }
  assert.equal((await json(`/api/files/${spec.id}`, { method: 'PATCH', body: 'null' })).status, 400);
  assert.equal((await patch('nope', { kind: 'report' })).status, 404);
  const still = await byName('mobile-app-v2-spec.md');
  assert.deepEqual([still.kind, still.topic, still.pinned], ['report', null, true]);

  const restarted = await startApp(dataDir);
  try {
    const after = await byName('mobile-app-v2-spec.md', restarted.at);
    assert.deepEqual([after.kind, after.topic, after.pinned], ['report', null, true]);
  } finally {
    restarted.close();
  }
});

test('old type/folder records are migrated at startup and the invoice automation still works', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drive-migrate-'));
  fs.mkdirSync(path.join(dir, 'files'));
  const invoiceText = 'INVOICE\nFrom: CloudNest Hosting Ltd.\nInvoice Number: INV-1042\nInvoice Date: 2026-07-05\nBill To: Agentic Drive Team\nCloud hosting subscription $1,000.00\nTotal Due: $1,250.00';
  const csvText = 'date,vendor,invoice_number,category,total,currency,source_file\n2026-07-05,CloudNest Hosting Ltd.,INV-1042,Software,1250.00,USD,old-invoice.txt\n';
  const old = (id, name, text, type, folder, generated) => {
    fs.writeFileSync(path.join(dir, 'files', id + path.extname(name)), text);
    return { id, name, ext: path.extname(name), size: Buffer.byteLength(text), type, folder, tags: [type], summary: '', createdAt: '2026-07-06T10:00:00.000Z', generated, source: generated ? 'agent' : 'upload', text };
  };
  const files = [
    old('old-1', 'old-invoice.txt', invoiceText, 'invoice', 'Finance', false),
    old('old-2', 'expenses.csv', csvText, 'data', 'Finance', true),
    old('old-3', 'kickoff - action items.md', '# Action items: kickoff.md\n\n- [ ] Sara will send the brief.\n', 'report', 'Marketing', true),
    old('old-4', 'Requirements - 2026-07-06 10-00.md', '# Requirements\n\nThe app must sync files.\n', 'report', 'Generated', true),
  ];
  fs.writeFileSync(path.join(dir, 'db.json'), JSON.stringify({ files, rules: [], activity: [] }));

  const app = await startApp(dir);
  try {
    const list = (await json('/api/files', {}, app.at)).body.files;
    for (const f of list) assert.equal('type' in f || 'folder' in f, false, `${f.name} kept type/folder`);
    const got = Object.fromEntries(list.map((f) => [f.name, [f.kind, f.topic, f.pinned]]));
    assert.deepEqual(got['old-invoice.txt'], ['invoice', 'Finance', false]);
    assert.deepEqual(got['expenses.csv'], ['data', 'Finance', false]);
    assert.deepEqual(got['kickoff - action items.md'], ['meeting', 'Marketing', false]);
    assert.deepEqual(got['Requirements - 2026-07-06 10-00.md'], ['report', null, false]);
    const raw = JSON.parse(fs.readFileSync(path.join(dir, 'db.json'), 'utf8'));
    assert.ok(raw.files.every((f) => !('type' in f) && !('folder' in f) && f.kind));
    const act = (await json('/api/activity', {}, app.at)).body.activity;
    assert.ok(act.some((a) => a.message === 'Re-sorted 4 files with the new categories.'));

    // The invoice automation still appends to the migrated expenses.csv (no second ledger).
    await upload([['new-invoice.txt', invoiceText.replace('INV-1042', 'INV-7777').replace('CloudNest Hosting Ltd.', 'Figma')]], app.at);
    const after = (await json('/api/files', {}, app.at)).body.files;
    assert.equal(after.filter((f) => f.name === 'expenses.csv').length, 1);
    const csv = (await json(`/api/files/${after.find((f) => f.name === 'expenses.csv').id}`, {}, app.at)).body.text;
    assert.match(csv, /INV-1042/);
    assert.match(csv, /INV-7777/);
  } finally {
    app.close();
  }
  // A second start has nothing left to migrate.
  const again = await startApp(dir);
  try {
    const act = (await json('/api/activity', {}, again.at)).body.activity;
    assert.equal(act.filter((a) => a.message.startsWith('Re-sorted')).length, 1);
  } finally {
    again.close();
  }
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

test('generated expenses.csv gets a descriptive summary', async () => {
  const csv = await byName('expenses.csv');
  assert.match(csv.summary, /^Spreadsheet with \d+ rows\. Columns: date, vendor, invoice_number/);
});

test('samples are dated from the first ISO date in their text; uploads and generated files keep "now"', async () => {
  const recent = (iso) => Math.abs(Date.now() - Date.parse(iso)) < 10 * 60 * 1000;
  assert.equal((await byName('q3-marketing-kickoff.md')).createdAt, '2026-07-02T09:00:00.000Z');
  assert.equal((await byName('finance-sync-2026-08-21.md')).createdAt, '2026-08-21T09:00:00.000Z');
  // No ISO date in the text -> left as the load time.
  assert.ok(recent((await byName('mobile-app-v2-spec.md')).createdAt));
  // Files the automations wrote while loading samples are not samples.
  assert.ok(recent((await byName('q3-marketing-kickoff - action items.md')).createdAt));
  assert.ok(recent((await byName('expenses.csv')).createdAt));
  // A real upload keeps its upload time even when its text has a date.
  await upload([['dated-note.md', 'Date: 2020-01-15\nA note about the 2020 planning offsite and its outcomes.']]);
  assert.ok(recent((await byName('dated-note.md')).createdAt));
});

test('action-items files get a summary naming the count, source and first item, also when updated', async () => {
  const kick = await byName('q3-marketing-kickoff - action items.md');
  assert.equal(kick.summary, '3 action items from q3-marketing-kickoff.md — Sara will finalise the campaign brief by July 8.');
  await upload([['retro.md', '# Retro\nAttendees: Sara\n## Action Items\n- [ ] Sara will book the retro room.']]);
  assert.equal((await byName('retro - action items.md')).summary, '1 action item from retro.md — Sara will book the retro room.');
  await upload([['retro.md', '# Retro\nAttendees: Sara\n## Action Items\n- [ ] Omar will send the notes.\n- [ ] Hina will fix the ads.']]);
  const files = (await json('/api/files')).body.files.filter((f) => f.name === 'retro - action items.md');
  assert.equal(files.length, 1);
  assert.equal(files[0].summary, '2 action items from retro.md — Omar will send the notes.');
});

test('invoices the drive\'s own company sent are not expenses; the company name is configurable', async () => {
  const csv = (await json(`/api/files/${(await byName('expenses.csv')).id}`)).body.text;
  assert.doesNotMatch(csv, /INV-0912/);
  assert.match(csv, /INV-1042/);
  const act = (await json('/api/activity')).body.activity;
  assert.ok(act.some((a) => a.agent === 'Automations' && a.message === 'INV-0912 is an invoice you sent (from Brightleaf Labs), so it was not logged as an expense.'));
  // ownCompany passed to createApp wins over the default: here CloudNest is "us".
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drive-own-'));
  const app = createApp({ dataDir: dir, llm: createLlm({}), samplesDir: path.join(here, '..', 'src', 'samples'), ownCompany: 'CloudNest Hosting' });
  const srv = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const at = `http://127.0.0.1:${srv.address().port}`;
  try {
    await upload([['cn.txt', 'INVOICE\nFrom: CloudNest Hosting Ltd.\nInvoice Number: INV-1042\nHosting\nTotal Due: $1,250.00']], at);
    await upload([['bl.txt', 'INVOICE\nFrom: Brightleaf Labs (Pvt.) Ltd.\nInvoice Number: INV-0912\nDiscovery\nTotal Due: $10,800.00']], at);
    const own = (await json('/api/files', {}, at)).body.files.find((f) => f.name === 'expenses.csv');
    const ledger = (await json(`/api/files/${own.id}`, {}, at)).body.text;
    assert.doesNotMatch(ledger, /INV-1042/);
    assert.match(ledger, /INV-0912/);
  } finally {
    srv.close();
  }
});

test('sampleDate takes the first valid ISO date at 09:00 UTC', () => {
  assert.equal(sampleDate('Ref BL-NDA-2026-012, signed 2026-07-14, renewed 2027-01-01'), '2026-07-14T09:00:00.000Z');
  assert.equal(sampleDate('Bad 2026-13-40 then 2026-02-03'), '2026-02-03T09:00:00.000Z');
  assert.equal(sampleDate('no dates here'), null);
  assert.equal(sampleDate(undefined), null);
});
