import { test } from 'node:test';
import assert from 'node:assert/strict';
import { synthesizeOffline, synthesize, FORMATS } from '../src/agents/synthesizer.js';

const docs = [
  { id: 'a', name: 'kickoff.md', text: 'Attendees: Sara\nThe Q3 marketing budget was approved at $120,000.\nThe landing page must load in 2 seconds.\n## Action Items\n- [ ] Sara will finalise the campaign brief by July 8.' },
  { id: 'b', name: 'review.md', text: 'We have spent $64,500 so far.\nWe agreed to move $10,000 to TikTok ads.\n## Action Items\n- [ ] Hina will shift budget by August 20.' },
];

for (const format of Object.keys(FORMATS)) {
  test(`offline ${format} has title, sources and figures`, () => {
    const r = synthesizeOffline(docs, format);
    assert.equal(r.title, FORMATS[format]);
    assert.match(r.content, /^# /);
    assert.match(r.content, /## Sources\n1\. kickoff\.md\n2\. review\.md/);
    assert.match(r.content, /\$120,000/);
  });
}

test('requirements format collects requirements, decisions, action items', () => {
  const c = synthesizeOffline(docs, 'requirements').content;
  assert.match(c, /## Requirements[\s\S]*must load in 2 seconds[\s\S]*\(kickoff\.md\)/);
  assert.match(c, /## Decisions[\s\S]*agreed to move \$10,000/);
  assert.match(c, /- \[ \] Sara will finalise the campaign brief by July 8\. \(kickoff\.md\)/);
  assert.match(c, /- \[ \] Hina will shift budget by August 20\. \(review\.md\)/);
});

test('compare format has a table row per file', () => {
  const c = synthesizeOffline(docs, 'compare').content;
  assert.match(c, /\| kickoff\.md \|/);
  assert.match(c, /\| review\.md \|/);
});

test('synthesize uses AI text, appends Sources if missing, falls back on error', async () => {
  const ok = await synthesize(docs, 'summary', { llm: { enabled: () => true, complete: async () => '# Summary\n\nAll good.' } });
  assert.equal(ok.by, 'ai');
  assert.match(ok.content, /## Sources\n1\. kickoff\.md/);
  const logs = [];
  const bad = await synthesize(docs, 'summary', { llm: { enabled: () => true, complete: async () => { throw new Error('down'); } }, log: (a, m) => logs.push(m) });
  assert.equal(bad.by, 'offline');
  assert.equal(logs.length, 1);
});

test('requirements format does not repeat action items under Decisions', () => {
  const c = synthesizeOffline(docs, 'requirements').content;
  const decisions = c.split('## Decisions')[1].split('## Action Items')[0];
  assert.doesNotMatch(decisions, /Sara will finalise/);
  assert.match(decisions, /agreed to move \$10,000/);
});
