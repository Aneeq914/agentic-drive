import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  stem, tokenize, splitSentences, topTerms, summarize,
  extractDecisions, extractRequirements, extractActionItems, extractAmounts,
} from '../src/text.js';

test('stem handles common suffixes', () => {
  assert.equal(stem('meetings'), 'meeting');
  assert.equal(stem('budgets'), 'budget');
  assert.equal(stem('companies'), 'company');
  assert.equal(stem('marketing'), 'market');
  assert.equal(stem('approved'), 'approv');
  assert.equal(stem('class'), 'class');
});

test('tokenize lowercases, drops stopwords, stems', () => {
  assert.deepEqual(tokenize('What was the Q3 Marketing budget?'), ['q3', 'market', 'budget']);
});

test('splitSentences splits on punctuation and newlines', () => {
  assert.deepEqual(splitSentences('One here. Two there!\nThree'), ['One here.', 'Two there!', 'Three']);
});

test('topTerms returns frequent raw words', () => {
  assert.deepEqual(topTerms('campaign campaign budget budget budget social', 2), ['budget', 'campaign']);
});

test('summarize skips headings and short lines, truncates', () => {
  const text = '# Title\n\nDate: 2026\nThe team reviewed the goals for the quarter and agreed a plan.';
  assert.equal(summarize(text), 'The team reviewed the goals for the quarter and agreed a plan.');
  assert.equal(summarize(''), '(no readable text)');
  assert.ok(summarize('word '.repeat(100)).length <= 160);
});

test('extractors find decisions, requirements, action items, amounts', () => {
  const t = [
    '# Notes',
    'The budget was approved at $120,000.',
    'The app must work offline.',
    '## Action Items',
    '- [ ] Sara will finalise the brief by July 8.',
    '- Action: Omar to send the report.',
    '',
    '- Bilal will draft the newsletter.',
    '## Other',
    '- Not an action',
  ].join('\n');
  assert.deepEqual(extractDecisions(t), ['The budget was approved at $120,000.', 'Sara will finalise the brief by July 8.', 'Bilal will draft the newsletter.']);
  assert.deepEqual(extractRequirements(t), ['The app must work offline.']);
  assert.deepEqual(extractActionItems(t), [
    'Sara will finalise the brief by July 8.',
    'Omar to send the report.',
    'Bilal will draft the newsletter.',
  ]);
  assert.deepEqual(extractAmounts('Paid $1,250.00 and 300 USD and €40'), ['$1,250.00', '300 USD', '€40']);
});

test('summarize skips "Label: value" metadata lines when a real sentence exists', () => {
  const t = '# Kickoff\nDate: 2026-07-02\nAttendees: Sara Khan, Bilal Ahmed, Hina Raza, Omar Siddiqui\n## Discussion\nThe team reviewed the Q3 marketing goals: grow sign-ups by 25%.';
  assert.equal(summarize(t), 'The team reviewed the Q3 marketing goals: grow sign-ups by 25%.');
  assert.equal(summarize('Owner: Engineering team and friends of the team'), 'Owner: Engineering team and friends of the team');
});

test('topTerms ignores filler words, months and meeting boilerplate', () => {
  assert.deepEqual(topTerms('will will will action items items July July August campaign', 3), ['campaign']);
});

test('summarize never picks a markdown table row or separator line', () => {
  const t = [
    '# Website Analytics — September 2026',
    'Prepared by: Bilal Ahmed',
    '## Headline numbers',
    '| Metric | August | September | Change |',
    '|---|---|---|---|',
    '| Average engagement time | 1m 38s | 1m 52s | +14s |',
    '| Newsletter sign-ups (from the site) | 702 | 640 | −8.8% |',
    '',
    '58% of sessions were on mobile, up from 55% in August.',
  ].join('\n');
  assert.equal(summarize(t), '58% of sessions were on mobile, up from 55% in August.');
  // A file that is only a table still never reads back a raw row or separator.
  const only = '| Metric | August | September |\n|---|---|---|\n| Average engagement time | 1m 38s | 1m 52s |';
  assert.equal(summarize(only), 'Table with columns: Metric, August, September.');
});

test('summarize skips bylines and contact lines in favour of a real sentence', () => {
  const blog = '# Why Small Studios Are Switching Invoicing Tools\n\n*By Omar Siddiqui, Finance at Brightleaf Labs · Brightleaf blog · 2026-09-10 · 6 min read*\n\nEvery studio I know started invoicing the same way: a Word template, a spreadsheet to track who has paid, and a reminder in someone\'s head.';
  assert.match(summarize(blog), /^Every studio I know started invoicing the same way/);
  const resume = 'Priya Nair\nProduct Designer\nDubai, UAE (open to relocating to Lahore) priya.nair@example.com +971 50 000 4821\nSummary\nProduct designer with 7 years of experience in e-commerce and healthcare apps.';
  assert.equal(summarize(resume), 'Product designer with 7 years of experience in e-commerce and healthcare apps.');
  const contact = 'Omar Siddiqui and the whole finance team at Brightleaf\nLahore, Pakistan · +92 300 1234567\nWe chase every overdue invoice within three days of its due date.';
  assert.equal(summarize(contact), 'We chase every overdue invoice within three days of its due date.');
  // "by" + lower-case words is an ordinary sentence, not a byline.
  assert.equal(summarize('by the end of the week we will ship the new search page.'), 'by the end of the week we will ship the new search page.');
});

test('summarize skips address-only party lines but keeps a sentence that contains an address', () => {
  const nda = 'MUTUAL NON-DISCLOSURE AGREEMENT\n\nPARTIES\n(1) Brightleaf Labs (Pvt.) Ltd., Office 3, Level 2, The Hive Coworking, DHA Phase 5, Lahore, Pakistan ("Brightleaf"); and\n(2) Northwind Health (Pvt.) Ltd., 9 Jail Road, Lahore, Pakistan ("Northwind").\n\nPURPOSE\nThe parties want to discuss a possible project in which Brightleaf builds a patient app.';
  assert.equal(summarize(nda), 'The parties want to discuss a possible project in which Brightleaf builds a patient app.');
  const msa = 'This agreement is between Brightleaf Labs, Office 3, Level 2, Lahore and Acme Retail Ltd.';
  assert.equal(summarize(msa), msa);
});

test('summarize prefers prose over agenda list items and label fragments', () => {
  const t = '# Kickoff Call Notes\nDate: 2026-08-11\n## Agenda\n1. Introductions and project goals\n2. Where the current site falls short\n3. Scope, timeline and ways of working\n## Discussion\nLaura opened by saying the redesign is the top digital priority for the year.\n## Decisions\n- We agreed to launch the new homepage before Black Friday.';
  assert.equal(summarize(t), 'Laura opened by saying the redesign is the top digital priority for the year.');
  // A notice line is not what the file is about either.
  assert.equal(summarize('Confidential under mutual NDA BL-NDA-2026-012 (signed 2026-07-14).\nNorthwind Health runs 6 clinics in Lahore.'), 'Northwind Health runs 6 clinics in Lahore.');
  // A numbered item that holds a full sentence is prose, and beats a later paragraph.
  assert.equal(summarize('# Q4 Roadmap\nOwner: Zara\n## Themes\n1. **Ship Acme on time.** The launch on Nov 20 matters more than anything else.\n## Reviews\nProgress is reviewed at the monthly leadership meeting.'), 'The launch on Nov 20 matters more than anything else.');
  // A prose fragment beats an agenda item even without a full stop.
  assert.equal(summarize('## Agenda\n1. Where the current site falls short\n## Notes\nLaura wants the redesign live before Black Friday'), 'Laura wants the redesign live before Black Friday');
  // With no prose at all, a list item is still better than nothing.
  assert.equal(summarize('## Todo\n- Book the meeting room for the Friday demo\n- Buy snacks'), 'Book the meeting room for the Friday demo');
});
