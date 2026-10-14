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

// ── Answer quality over the real 32-file drive (decoys included) ──

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

test('real drive: each demo question gets its fact first, from the right file', async () => {
  const samples = await loadSamples();
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
    const r = answerOffline(q, samples);
    assert.match(r.answer.split('\n')[0], fact, q);
    assert.equal(r.citations[0].fileName, file, q);
  }
});

test('real drive: no noise citations for single-source facts', async () => {
  const samples = await loadSamples();
  for (const [q, file] of [
    ['How long does the Northwind NDA last?', 'nda-northwind-health.txt'],
    ['How much was the CloudNest invoice?', 'invoice-cloudnest-INV-1042.txt'],
  ]) assert.deepEqual(answerOffline(q, samples).citations.map((c) => c.fileName), [file], q);
  const terms = answerOffline('What are the Acme payment terms?', samples);
  assert.match(terms.answer, /Net 30/);
  assert.ok(terms.citations.every((c) => c.fileName === 'acme-retail-msa.md'), terms.answer);
});

test('a name that no file mentions is NOT_FOUND, not another vendor\'s amount', async () => {
  assert.deepEqual(answerOffline('How much did we pay Stripe?', await loadSamples()), { answer: NOT_FOUND, citations: [] });
});

test('answers stay put when ~30 unrelated files are added to the drive', async () => {
  const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
  const extra = await Promise.all(['holdout', 'holdout-2'].flatMap((dir) => fs.readdirSync(path.join(fixtures, dir))
    .filter((name) => /\.(md|txt)$/.test(name))
    .map(async (name) => ({ id: `${dir}/${name}`, name, ext: path.extname(name), text: await extractText(fs.readFileSync(path.join(fixtures, dir, name)), name) }))));
  const drive = [...await loadSamples(), ...extra];
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

test('real drive: a name heading picked as the answer reads on into the line below it', async () => {
  const r = answerOffline('Who is Priya Nair?', await loadSamples());
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
