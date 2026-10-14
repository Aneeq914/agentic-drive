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

// Offline answers over the real bundled samples (the demo's example questions).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractText } from '../src/extract.js';

const samplesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'samples');
const loadSamples = async () => Promise.all(fs.readdirSync(samplesDir).map(async (name) => ({
  id: name, name, ext: path.extname(name), text: await extractText(fs.readFileSync(path.join(samplesDir, name)), name),
})));

test('money question answers with the invoice total and drops weak matches', async () => {
  const r = answerOffline('How much did we spend on travel?', await loadSamples());
  assert.match(r.answer.split('\n')[0], /Total: \$842\.60/);
  assert.deepEqual(r.citations.map((c) => c.fileName), ['invoice-skyway-travel-INV-2207.txt']);
});

test('csv rows are answered as readable "column: value" lines, never the header', async () => {
  const r = answerOffline('How much did hosting cost?', await loadSamples());
  assert.match(r.answer, /Cloud hosting — department: Engineering, q3_budget: 12000/);
  assert.doesNotMatch(r.answer, /line_item,department/);
});

test('headings are not used as answers when a real sentence matches', async () => {
  const r = answerOffline('What must the mobile app do offline?', await loadSamples());
  assert.equal(r.citations.length, 1);
  assert.doesNotMatch(r.answer, /Architecture/);
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
