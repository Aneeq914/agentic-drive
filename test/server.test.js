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
