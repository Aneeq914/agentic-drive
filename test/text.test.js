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
